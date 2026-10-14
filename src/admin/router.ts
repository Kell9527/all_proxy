/**
 * 管理 API 路由。
 *
 * ## 与对外 API 的分工
 *
 * | 前缀 | 鉴权 | 用途 |
 * |---|---|---|
 * | `/v1/*` | 普通 API Key | 给客户端调用模型 |
 * | `/api/*` | **管理口令** | 管理端读写配置 |
 *
 * 两者**互不通用**：API Key 访问 `/api/*` 一律 403，管理口令访问 `/v1/*`
 * 也无效。这是规格 `access-control` 的硬要求 —— 否则任何拿到 API Key 的
 * 客户端都能改开关、导出凭据。
 *
 * ## 为什么不用框架
 *
 * 端点数量可控（十余个），且路由表本身就是一份可读的权限清单：
 * 哪个端点写盘、哪个需要管理口令，一眼可见。引入框架会把这层可见性藏进
 * 装饰器或中间件顺序里。
 *
 * ## 留痕
 *
 * **所有写操作**（`POST` / `PATCH` / `DELETE`）都会记一条
 * {@link AdminAuditEntry}：时间 + 操作名 + 目标 + 成败，**不含凭据明文**。
 */

import { randomBytes } from 'node:crypto'
import { join } from 'node:path'
import { mkdirSync, writeFileSync } from 'node:fs'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { AccountPool } from '../pool/account-pool.js'
import type { CredentialStore, ProviderAccountEntry } from '../pool/types.js'
import type { RefreshCoordinator } from '../pool/refresh-coordinator.js'
import type { ProviderRegistry } from '../providers/registry.js'
import type { Logger } from '../pool/store.js'
import { sensenovaNicknameFromKey } from '../providers/sensenova.js'
import { AdminAuth, extractAdminSecret } from './auth.js'
import { ApiKeyStore } from '../auth/api-keys.js'
import type { UsageStore } from '../usage/store.js'
import { DEFAULT_RETENTION, type RetentionPolicy, type UsageQuery } from '../usage/store.js'
import type { LoginOrchestrator } from '../login/orchestrator.js'
import { listAllModelsForAdmin } from '../gateway/model-resolver.js'
import { retestAccount, retestAllAccounts, type ProbePool } from '../providers/account-probe.js'
import { exportBackup, importBackup, type BackupPool as BackupPoolLike, type BackupCredentials as BackupCredentialsLike } from '../providers/backup.js'
import { claimAll as claimAllCredits, claimOnboarding, fetchBalances, keepAliveDailyPoints } from './credits-endpoint.js'
import { maskCredentialPath, parseCredentialRef, validateFileRefInput } from '../pool/credential-ref-kind.js'

/** 管理 API 的依赖。 */
export interface AdminOptions {
  registry: ProviderRegistry
  pool: AccountPool
  credentials: CredentialStore
  apiKeys: ApiKeyStore
  auth: AdminAuth
  logger: Logger
  /** 用量存储；省略则用量端点返回 503。 */
  usage?: UsageStore
  /** 登录编排器；省略则登录端点返回 503。 */
  login?: LoginOrchestrator
  /** 备份导入前自动备份的存放目录。 */
  backupDir?: string
  /**
   * 单飞刷新协调器（raccoon 积分/保活端点的「按需续期」用）。
   *
   * ⚠️ 必须与 `index.ts` 里定时任务、适配器请求路径**同一个实例**：
   * raccoon 的 `refresh_token` 一次性轮换，两个协调器等于没单飞。
   * 省略时积分端点不自动续期（凭据过期就由上游 401 如实回报）。
   */
  refreshCoordinator?: RefreshCoordinator
  /** 注入的 fetch（积分查询/签到用；测试替身注入点）。 */
  fetcher?: typeof fetch
}

/** 默认保留策略（用量端点可覆盖）。 */
export interface AdminUsageOptions {
  retention?: RetentionPolicy
}

/**
 * 管理请求处理器。
 *
 * @returns 已处理返回 `true`；路径不匹配返回 `false`（由调用方继续路由）。
 */
export type AdminHandler = (req: IncomingMessage, res: ServerResponse, url: URL) => Promise<boolean>

/** 请求体上限（管理端不需要大 body）。 */
const MAX_ADMIN_BODY_BYTES = 8 * 1024 * 1024

/**
 * 把 {@link AccountPool} 适配为探测模块的最小池接口。
 *
 * 仅凭据类型不同（池返回 `unknown`）：探测模块内部按 provider 断言，
 * 这里透传即可。
 */
function asProbePool(p: AccountPool): ProbePool {
  return {
    findAccount: id => p.findAccount(id),
    listAccountsByProvider: provider => p.listAccountsByProvider(provider),
    resolveCredentialForAccount: async id =>
      (await p.resolveCredentialForAccount(id)) as Awaited<ReturnType<ProbePool['resolveCredentialForAccount']>>,
    clearModelRateLimits: (id, modelIds) => p.clearModelRateLimits(id, modelIds),
    updateModelRateLimit: (id, modelId, resetAtMs) => p.updateModelRateLimit(id, modelId, resetAtMs),
  }
}

/**
 * 把 {@link AccountPool} 适配为备份模块的最小池接口。
 *
 * 备份模块的 `replaceAll` 是「逐参数」签名，池本身是「整体状态」签名，
 * 在这里换算。
 */
function asBackupPool(p: AccountPool): BackupPoolLike & { getStateSnapshot(): ReturnType<AccountPool['getStateSnapshot']> } {
  return {
    getStateSnapshot: () => p.getStateSnapshot(),
    replaceAll: (accounts, disabledModels, loomyPermanentLocked) =>
      p.replaceAll({ accounts: [...accounts], disabledModels: { ...disabledModels }, loomyPermanentLocked: loomyPermanentLocked === true } as Parameters<AccountPool['replaceAll']>[0]),
  }
}

/**
 * 读取凭据里的手机号，用作账号卡片的展示名。
 *
 * ## 为什么要这个
 *
 * 内置凭据的 ref 名是 `LOOMY_ACCOUNT_A1BAA706` 这类**机器生成**的标识，用户
 * 看不出「这条凭据是哪部手机的」。而 Loomy 只能靠手机号验证码重新登录，过期
 * 时用户必须对照手机号才知道该登哪个号 —— 故在卡片「凭据」一栏直接展示手机号。
 *
 * ## 为什么不做掩码
 *
 * 用户的用途是**照着重新登录**，掩码号（`138****8000`）没法直接输入，等于没
 * 显示。这里是本地管理端（默认仅监听 127.0.0.1），且凭据文件里本来就明文存着
 * 同一个手机号，展示明文**不新增任何泄露面**。
 *
 * ## 读不到就回退
 *
 * 无 `phone` 字段 / JSON 损坏 / 凭据缺失 / provider 不用手机号登录 —— 一律返回
 * `undefined`，调用方回退到 ref 名，行为与改动前完全一致。
 */
async function displayPhoneOf(credentials: CredentialStore, ref: string): Promise<string | undefined> {
  // 凭据读取失败不是错误：账号可能刚被删、或共享文件还没被官方客户端写出来。
  const resolved = await credentials.resolve(ref).catch(() => undefined)
  if (resolved === undefined) return undefined
  try {
    const parsed: unknown = JSON.parse(resolved.value)
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return undefined
    const phone = (parsed as Record<string, unknown>)['phone']
    return typeof phone === 'string' && phone.trim().length > 0 ? phone.trim() : undefined
  } catch {
    // 凭据值不保证是 JSON（各 provider 形态不一），解析失败即视为「无手机号」。
    return undefined
  }
}

/**
 * 支持「粘贴静态 API Key 建号」的 provider 集合。
 *
 * ⚠️ **刻意是白名单而非「所有 provider」**：其余 10 个 provider 的凭据是
 * 登录态 token（形如 `{access_token, refresh_token, expires_at}`），手填一把
 * key 会造出无法续期、字段缺失的坏账号。只有 SenseNova 的凭据本身就是
 * 一把静态 key。
 *
 * 新增静态 key provider 时在此登记（并在前端 PROVIDERS 里加对应按钮）。
 */
const STATIC_KEY_PROVIDERS: ReadonlySet<string> = new Set(['sensenova'])

/**
 * 用一把静态 API Key 建号：写凭据 → 落账号索引。
 *
 * ⚠️ **先写凭据、再写索引**（与 `LoginOrchestrator.settle` 同约定）：索引里
 * 出现账号的前提是凭据已经落盘，否则会留下「选号器看得见却用不了」的账号。
 *
 * 凭据字段为 `access_token`（见 `/api/accounts` 端点注释）。
 * `refreshable: false` —— 静态 key 无续期端点。
 */
async function createStaticKeyAccount(
  pool: AccountPool,
  credentials: CredentialStore,
  provider: string,
  apiKey: string,
  nickname: string,
): Promise<{ id: string; provider: string; nickname: string }> {
  const ref = `${provider.toUpperCase()}_ACCOUNT_${randomBytes(4).toString('hex').toUpperCase()}`
  await credentials.set(ref, JSON.stringify({ access_token: apiKey }))
  const entry: ProviderAccountEntry = {
    id: `${provider}-${randomBytes(4).toString('hex')}`,
    provider,
    // 昵称：用户显式指定优先，否则用脱敏后的 key（便于多把 key 的区分）。
    nickname: nickname.length > 0 ? nickname : sensenovaNicknameFromKey(apiKey),
    enabled: true,
    credentialRef: ref,
    createdAt: Date.now(),
    refreshable: false,
  }
  await pool.addAccount(entry)
  return { id: entry.id, provider: entry.provider, nickname: entry.nickname }
}

/** 创建管理 API 处理器。 */
export function createAdminHandler(options: AdminOptions): AdminHandler {
  const { auth, apiKeys, pool, registry, logger, credentials } = options

  return async function handleAdmin(req, res, url): Promise<boolean> {
    if (!url.pathname.startsWith('/api/')) return false

    // ── 鉴权（除健康探针外一律要求管理口令）──
    const secret = extractAdminSecret(req, url)
    if (!auth.verify(secret)) {
      // ⚠️ 消息刻意不区分「口令错误」与「未提供口令」：对外监听时，
      // 区分会让攻击者确认「这里确实有个管理端，只是口令不对」。
      sendJson(res, 401, {
        error: {
          code: 'admin_unauthorized',
          message: '需要管理口令（Authorization: Bearer <口令> 或 x-admin-secret 头）',
        },
      })
      return true
    }

    const method = req.method ?? 'GET'
    const path = url.pathname
    const write = method !== 'GET' && method !== 'HEAD'

    /**
     * 写操作包装：统一留痕 + 统一异常兜底。
     *
     * ⚠️ 异常信息原样返回给本机管理端是**有意**的：使用者就是管理员本人，
     * 报错细节（如「账号列表已变化，请刷新后重试」）是修好问题的必要信息。
     */
    const runWrite = async (action: string, target: string, fn: () => Promise<unknown> | unknown): Promise<void> => {
      try {
        const result = await fn()
        auth.record(action, target, true)
        sendJson(res, 200, result ?? { ok: true })
      } catch (error) {
        auth.record(action, target, false)
        const message = error instanceof Error ? error.message : String(error)
        logger.warn(`[admin] ${action} 失败（${target}）: ${message}`)
        sendJson(res, 400, { error: { code: 'admin_operation_failed', message } })
      }
    }

    // ═══════════════ API Key 管理 ═══════════════

    if (path === '/api/keys' && method === 'GET') {
      sendJson(res, 200, { data: apiKeys.list() })
      return true
    }

    if (path === '/api/keys' && method === 'POST') {
      const body = await readBody(req)
      if (!body.ok) { sendJson(res, 400, { error: { code: 'invalid_request_error', message: body.message } }); return true }
      await runWrite('create-key', String(body.value['name'] ?? ''), () => {
        const created = apiKeys.create({
          name: typeof body.value['name'] === 'string' ? body.value['name'] : '',
          ...normalizeScope(body.value),
        })
        // ⚠️ 明文**只在此处**出现在响应里，且不落盘、不写日志。
        return { key: created.plaintext, data: created.summary }
      })
      return true
    }

    const keyMatch = /^\/api\/keys\/([^/]+)$/.exec(path)
    if (keyMatch !== null) {
      const id = decodeURIComponent(keyMatch[1]!)
      if (method === 'PATCH') {
        const body = await readBody(req)
        if (!body.ok) { sendJson(res, 400, { error: { code: 'invalid_request_error', message: body.message } }); return true }
        await runWrite('update-key', id, () => ({ data: apiKeys.update(id, patchFrom(body.value)) }))
        return true
      }
      if (method === 'DELETE') {
        await runWrite('delete-key', id, () => ({ deleted: apiKeys.remove(id) }))
        return true
      }
    }

    const resetMatch = /^\/api\/keys\/([^/]+)\/reset-usage$/.exec(path)
    if (resetMatch !== null && method === 'POST') {
      const id = decodeURIComponent(resetMatch[1]!)
      await runWrite('reset-key-usage', id, () => ({ data: apiKeys.resetUsage(id) }))
      return true
    }

    // ═══════════════ 登录编排 ═══════════════

    if (path === '/api/login/start' && method === 'POST') {
      if (options.login === undefined) {
        sendJson(res, 503, { error: { code: 'login_unavailable', message: '登录编排未启用' } })
        return true
      }
      const body = await readBody(req)
      if (!body.ok) { sendJson(res, 400, { error: { code: 'invalid_request_error', message: body.message } }); return true }
      const provider = typeof body.value['provider'] === 'string' ? body.value['provider'].trim() : ''
      if (provider.length === 0) {
        sendJson(res, 400, { error: { code: 'invalid_request_error', message: '缺少 provider' } })
        return true
      }
      // start **立即返回** loginUrl（两步式契约）：授权完成与否由 poll 收割，
      // 这里绝不阻塞等待 —— 否则前端拿不到 URL，弹窗会被浏览器拦截。
      // method 目前只对 loomy 有意义：默认手机号验证码（主路径），
      // 'wechat' 走扫码（可选）。其余 provider 忽略该字段。
      const method = typeof body.value['method'] === 'string' ? body.value['method'].trim() : undefined
      // region 目前只对 accio 有意义：登录区域（cn/global）。其余 provider 忽略。
      const region = typeof body.value['region'] === 'string' ? body.value['region'].trim() : undefined
      await runWrite('login-start', provider, () => options.login!.start(provider, method, region === undefined ? undefined : { region }))
      return true
    }

    if (path === '/api/login/poll' && method === 'POST') {
      if (options.login === undefined) {
        sendJson(res, 503, { error: { code: 'login_unavailable', message: '登录编排未启用' } })
        return true
      }
      const body = await readBody(req)
      if (!body.ok) { sendJson(res, 400, { error: { code: 'invalid_request_error', message: body.message } }); return true }
      const sessionId = typeof body.value['sessionId'] === 'string' ? body.value['sessionId'].trim() : ''
      if (sessionId.length === 0) {
        sendJson(res, 400, { error: { code: 'invalid_request_error', message: '缺少 sessionId' } })
        return true
      }
      // poll 是只读收割（幂等），不算写操作，但失败也要给可读错误。
      try {
        sendJson(res, 200, await options.login.poll(sessionId))
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        sendJson(res, 404, { error: { code: 'login_session_not_found', message } })
      }
      return true
    }

    if (path === '/api/login/cancel' && method === 'POST') {
      if (options.login === undefined) {
        sendJson(res, 503, { error: { code: 'login_unavailable', message: '登录编排未启用' } })
        return true
      }
      const body = await readBody(req)
      if (!body.ok) { sendJson(res, 400, { error: { code: 'invalid_request_error', message: body.message } }); return true }
      const sessionId = typeof body.value['sessionId'] === 'string' ? body.value['sessionId'].trim() : ''
      await runWrite('login-cancel', sessionId, async () => {
        await options.login!.cancel(sessionId)
        return { ok: true }
      })
      return true
    }

    if (path === '/api/login/sms/send' && method === 'POST') {
      if (options.login === undefined) {
        sendJson(res, 503, { error: { code: 'login_unavailable', message: '登录编排未启用' } })
        return true
      }
      const body = await readBody(req)
      if (!body.ok) { sendJson(res, 400, { error: { code: 'invalid_request_error', message: body.message } }); return true }
      const provider = typeof body.value['provider'] === 'string' ? body.value['provider'].trim() : ''
      const phone = typeof body.value['phone'] === 'string' ? body.value['phone'].trim() : ''
      const captchaParam = typeof body.value['captchaParam'] === 'string' ? body.value['captchaParam'] : ''
      if (provider.length === 0 || phone.length === 0) {
        sendJson(res, 400, { error: { code: 'invalid_request_error', message: '缺少 provider 或 phone' } })
        return true
      }
      await runWrite('login-sms-send', provider, () => options.login!.sendSmsCode(provider, phone, captchaParam))
      return true
    }

    if (path === '/api/login/sms/complete' && method === 'POST') {
      if (options.login === undefined) {
        sendJson(res, 503, { error: { code: 'login_unavailable', message: '登录编排未启用' } })
        return true
      }
      const body = await readBody(req)
      if (!body.ok) { sendJson(res, 400, { error: { code: 'invalid_request_error', message: body.message } }); return true }
      const provider = typeof body.value['provider'] === 'string' ? body.value['provider'].trim() : ''
      const phone = typeof body.value['phone'] === 'string' ? body.value['phone'].trim() : ''
      const code = typeof body.value['code'] === 'string' ? body.value['code'].trim() : ''
      const ticket = typeof body.value['ticket'] === 'string' ? body.value['ticket'] : ''
      if (provider.length === 0 || phone.length === 0 || code.length === 0) {
        sendJson(res, 400, { error: { code: 'invalid_request_error', message: '缺少 provider、phone 或 code' } })
        return true
      }
      await runWrite('login-sms-complete', provider, () => options.login!.completeSmsLogin(provider, phone, code, ticket))
      return true
    }

    if (path === '/api/login/password/complete' && method === 'POST') {
      if (options.login === undefined) {
        sendJson(res, 503, { error: { code: 'login_unavailable', message: '登录编排未启用' } })
        return true
      }
      const body = await readBody(req)
      if (!body.ok) { sendJson(res, 400, { error: { code: 'invalid_request_error', message: body.message } }); return true }
      const provider = typeof body.value['provider'] === 'string' ? body.value['provider'].trim() : ''
      const phone = typeof body.value['phone'] === 'string' ? body.value['phone'].trim() : ''
      const password = typeof body.value['password'] === 'string' ? body.value['password'] : ''
      if (provider.length === 0 || phone.length === 0 || password.length === 0) {
        sendJson(res, 400, { error: { code: 'invalid_request_error', message: '缺少 provider、phone 或 password' } })
        return true
      }
      await runWrite('login-password-complete', provider, () => options.login!.completePasswordLogin(provider, phone, password))
      return true
    }

    // ═══════════════ 只读诊断 ═══════════════

    if (path === '/api/admin/audit' && method === 'GET') {
      // 留痕与开关审计一起给：排查「配置怎么变成这样」时两者都需要。
      sendJson(res, 200, {
        data: {
          operations: auth.entries(),
          switches: pool.switchAudit(),
        },
      })
      return true
    }

    if (path === '/api/providers' && method === 'GET') {
      sendJson(res, 200, {
        data: registry.list().map(({ descriptor }) => ({
          ...descriptor,
          enabled: pool.providerEnabled(descriptor.id),
          accountCount: pool.accountsOf(descriptor.id).length,
          enabledAccountCount: pool.accountsOf(descriptor.id).filter(a => a.enabled).length,
        })),
      })
      return true
    }

    // ═══════════════ 用量查询 ═══════════════

    if (path === '/api/usage' && method === 'GET') {
      if (options.usage === undefined) {
        sendJson(res, 503, { error: { code: 'usage_unavailable', message: '用量存储未启用' } })
        return true
      }
      sendJson(res, 200, options.usage.query(usageQueryFromUrl(url)))
      return true
    }

    if (path === '/api/usage/keys' && method === 'GET') {
      if (options.usage === undefined) {
        sendJson(res, 503, { error: { code: 'usage_unavailable', message: '用量存储未启用' } })
        return true
      }
      sendJson(res, 200, { data: options.usage.keyUsage() })
      return true
    }

    // ═══════════════ 账号管理 ═══════════════

    if (path === '/api/accounts' && method === 'GET') {
      const provider = url.searchParams.get('provider') ?? ''
      if (provider.length === 0) {
        sendJson(res, 200, { data: await pool.listAllAccounts() })
        return true
      }
      // 带状态版本：含凭据状态、可用性与当前会被优先选用的账号标注。
      const listed = await pool.listAccounts(provider)
      // 凭据引用的**展示形态**：文件引用给出脱敏路径（绝对路径会泄露本机
      // 用户名等，管理端可能被截图或投屏）。原始 ref 仍照常返回，供绑定界面
      // 回填与备份对账。
      //
      // 内置凭据额外读一次凭据：能取到手机号就显示手机号（见 `displayPhoneOf`），
      // 取不到仍显示 ref 名。逐条 `catch` 保证单个凭据读失败（共享文件尚未被
      // 官方客户端写出等）不会让整个列表 500。
      const data = await Promise.all(listed.map(async (status) => {
        const parsed = parseCredentialRef(status.credentialRef)
        if (parsed.kind === 'file') {
          return { ...status, credentialKind: 'file', credentialDisplay: maskCredentialPath(parsed.path) }
        }
        const phone = await displayPhoneOf(credentials, status.credentialRef)
        return {
          ...status,
          credentialKind: 'inline',
          credentialDisplay: phone ?? status.credentialRef,
        }
      }))
      sendJson(res, 200, { data })
      return true
    }

    /**
     * 手动新增账号（粘贴静态 API Key）—— 目前仅 SenseNova 适用。
     *
     * ## 为什么需要它
     *
     * 其余 10 个 provider 的账号都来自**登录流程**（扫码 / OAuth / 短信 /
     * 密码），凭据是登录态 token。SenseNova 是第一个**静态 API Key**
     * provider：用户手里就是一把 `sk-...`，没有任何登录可走。此前不存在
     * 「不经过登录就能建号」的路径，故补此端点。
     *
     * ## 约定
     *
     * - `provider` 必须是**已注册且支持静态 key** 的 provider（当前只有
     *   `sensenova`）；其余一律拒绝，避免把登录态 provider 变成「凭据可手填」
     *   而破坏其凭据形状。
     * - `apiKey` 明文只在**本次请求**里出现，落盘进凭据存储（与登录流程同处），
     *   **不回显、不写日志**（留痕只记 provider）。
     * - 凭据字段写成 `access_token`（值是 key）—— 这是 `findAccountIdByCredential`
     *   的既有约定，改字段名会让该账号永远登记不上。
     */
    if (path === '/api/accounts' && method === 'POST') {
      const body = await readBody(req)
      if (!body.ok) { sendJson(res, 400, { error: { code: 'invalid_request_error', message: body.message } }); return true }
      const provider = typeof body.value['provider'] === 'string' ? body.value['provider'].trim() : ''
      const apiKey = typeof body.value['apiKey'] === 'string' ? body.value['apiKey'].trim() : ''
      const rawNickname = typeof body.value['nickname'] === 'string' ? body.value['nickname'].trim() : ''
      await runWrite('account-create', provider, async () => {
        if (!STATIC_KEY_PROVIDERS.has(provider)) {
          throw new Error(`provider "${provider}" 不支持粘贴 API Key 建号（当前仅支持: ${[...STATIC_KEY_PROVIDERS].join(', ')}）`)
        }
        if (registry.get(provider) === undefined) throw new Error(`未知 provider "${provider}"`)
        if (apiKey.length === 0) throw new Error('缺少 apiKey')
        const entry = await createStaticKeyAccount(pool, credentials, provider, apiKey, rawNickname)
        // ⚠️ 只回昵称与 id，**绝不回显 key**（明文 key 只在请求体里出现过）。
        return { ok: true, account: { id: entry.id, provider: entry.provider, nickname: entry.nickname } }
      })
      return true
    }

    if (path === '/api/accounts/reorder' && method === 'POST') {
      const body = await readBody(req)
      if (!body.ok) { sendJson(res, 400, { error: { code: 'invalid_request_error', message: body.message } }); return true }
      const provider = typeof body.value['provider'] === 'string' ? body.value['provider'] : ''
      const orderedIds = Array.isArray(body.value['orderedIds'])
        ? (body.value['orderedIds'] as unknown[]).filter((v): v is string => typeof v === 'string')
        : []
      await runWrite('account-reorder', provider, () => pool.reorderAccounts(provider, orderedIds))
      return true
    }

    if (path === '/api/accounts/retest-all' && method === 'POST') {
      const body = await readBody(req)
      if (!body.ok) { sendJson(res, 400, { error: { code: 'invalid_request_error', message: body.message } }); return true }
      const provider = typeof body.value['provider'] === 'string' ? body.value['provider'] : ''
      await runWrite('account-retest-all', provider, () => retestAllAccounts(asProbePool(pool), provider))
      return true
    }

    const accountMatch = /^\/api\/accounts\/([^/]+)$/.exec(path)
    if (accountMatch !== null) {
      const id = decodeURIComponent(accountMatch[1]!)
      if (method === 'PATCH') {
        const body = await readBody(req)
        if (!body.ok) { sendJson(res, 400, { error: { code: 'invalid_request_error', message: body.message } }); return true }
        await runWrite('account-update', id, async () => {
          const patch: Parameters<AccountPool['updateAccount']>[1] = {}
          if (typeof body.value['nickname'] === 'string') patch.nickname = body.value['nickname']
          if (typeof body.value['enabled'] === 'boolean') patch.enabled = body.value['enabled']
          await pool.updateAccount(id, patch)
          return { ok: true }
        })
        return true
      }
      if (method === 'DELETE') {
        await runWrite('account-delete', id, async () => {
          await pool.removeAccount(id)
          return { ok: true }
        })
        return true
      }
    }

    /**
     * 绑定 / 换绑 / 解绑凭据文件。
     *
     * body：
     * - `{ filePath: "D:\\...\\auth-a.json" }` → 绑到该文件（`FILE:` ref）
     * - `{ filePath: "" }` → 解绑，凭据转存为内置 ref，账号不再依赖外部文件
     *
     * 之所以提供这个端点：某些 provider 的 `refresh_token` 一次性轮换，多消费者
     * 各存副本会互相作废；指向同一个文件后，谁刷新都写到同一处（见
     * `pool/credential-ref-kind.ts` 的说明）。
     */
    if (path === '/api/accounts/credential-file' && method === 'POST') {
      const body = await readBody(req)
      if (!body.ok) { sendJson(res, 400, { error: { code: 'invalid_request_error', message: body.message } }); return true }
      const accountId = typeof body.value['accountId'] === 'string' ? body.value['accountId'] : ''
      if (accountId.length === 0) { sendJson(res, 400, { error: { code: 'invalid_request_error', message: '缺少 accountId' } }); return true }
      const rawPath = typeof body.value['filePath'] === 'string' ? body.value['filePath'] : ''
      await runWrite('account-credential-file', accountId, async () => {
        const entry = pool.findAccount(accountId)
        if (entry === undefined) throw new Error(`账号不存在：${accountId}`)
        if (rawPath.trim().length === 0) {
          // 解绑：生成一个内置 ref，凭据内容迁过去，账号继续可用。
          const inlineRef = `${entry.provider.toUpperCase()}_ACCOUNT_${randomBytes(4).toString('hex').toUpperCase()}`
          const result = await pool.rebindCredential(accountId, inlineRef)
          return { ok: true, bound: false, credentialRef: inlineRef, migrated: result.migrated }
        }
        const validated = validateFileRefInput(rawPath)
        if (!validated.ok) throw new Error(validated.message)
        const result = await pool.rebindCredential(accountId, validated.ref)
        // 提示是否读到了凭据：文件不存在时账号会表现为「凭据缺失」，
        // 明说比让用户对着空目录猜要好。
        const probe = await credentials.resolve(validated.ref).catch(() => undefined)
        return {
          ok: true,
          bound: true,
          credentialRef: validated.ref,
          displayPath: maskCredentialPath(validated.path),
          migrated: result.migrated,
          readable: probe !== undefined,
        }
      })
      return true
    }

    const accountActionMatch = /^\/api\/accounts\/([^/]+)\/(reset|retest)$/.exec(path)
    if (accountActionMatch !== null && method === 'POST') {
      const id = decodeURIComponent(accountActionMatch[1]!)
      const action = accountActionMatch[2]!
      if (action === 'reset') {
        await runWrite('account-reset', id, async () => {
          const cleared = await pool.clearModelRateLimits(id)
          return { cleared }
        })
        return true
      }
      // 重测真实消耗上游额度（对受限模型发最小请求），由池接口直接执行。
      await runWrite('account-retest', id, () => retestAccount(asProbePool(pool), id))
      return true
    }

    // ═══════════════ 模型开关 ═══════════════

    if (path === '/api/models' && method === 'GET') {
      // **含被关闭的模型**：否则用户无法重新开启（规格 admin-console）。
      sendJson(res, 200, { data: await listAllModelsForAdmin(registry, pool) })
      return true
    }

    if (path === '/api/models' && method === 'PATCH') {
      const body = await readBody(req)
      if (!body.ok) { sendJson(res, 400, { error: { code: 'invalid_request_error', message: body.message } }); return true }
      await runWrite('model-set', String(body.value['provider'] ?? ''), async () => {
        if (typeof body.value['globalEnabled'] === 'boolean') {
          await pool.setGlobalModelsEnabled(body.value['globalEnabled'])
          return { ok: true }
        }
        const provider = typeof body.value['provider'] === 'string' ? body.value['provider'] : ''
        if (provider.length === 0) throw new Error('缺少 provider')
        // ⚠️ provider 开关必须是**已注册的 id**：`disabledProviders` 是自由
        // Record，拼错一个字母就会留下一个永不生效的死键（界面上看不见、
        // 排查时对不上），且它还会让「全部开启」的清理逻辑多扫一项。
        if (typeof body.value['enabled'] === 'boolean') {
          if (!registry.has(provider)) throw new Error(`未知的 provider: ${provider}`)
          await pool.setProviderEnabled(provider, body.value['enabled'])
          return { ok: true }
        }
        if (typeof body.value['modelId'] !== 'string' || typeof body.value['disabled'] !== 'boolean') {
          throw new Error('缺少 modelId 或 disabled')
        }
        await pool.setModelDisabled(provider, body.value['modelId'], body.value['disabled'])
        return { ok: true }
      })
      return true
    }

    if (path === '/api/models/bulk' && method === 'POST') {
      const body = await readBody(req)
      if (!body.ok) { sendJson(res, 400, { error: { code: 'invalid_request_error', message: body.message } }); return true }
      await runWrite('model-bulk', String(body.value['provider'] ?? ''), async () => {
        const provider = typeof body.value['provider'] === 'string' ? body.value['provider'] : ''
        if (provider.length === 0) throw new Error('缺少 provider')
        if (body.value['clear'] === true) {
          // 「全部开启」= 清空该 provider 的单模型黑名单（并恢复 provider 开关）。
          await pool.clearDisabledModels(provider)
          await pool.setProviderEnabled(provider, true)
          return { ok: true }
        }
        const modelIds = Array.isArray(body.value['modelIds'])
          ? (body.value['modelIds'] as unknown[]).filter((v): v is string => typeof v === 'string')
          : []
        if (modelIds.length === 0) throw new Error('缺少 modelIds')
        await pool.setModelsDisabled(provider, modelIds)
        return { ok: true }
      })
      return true
    }

    // ═══════════════ 永久积分锁（Loomy / OfficeAce 等，按 provider）═══════════════

    // 兼容旧前端：Loomy 专用端点（新前端走下面的 /api/permanent-lock，带 provider）。
    if (path === '/api/loomy-lock' && method === 'PATCH') {
      const body = await readBody(req)
      if (!body.ok) { sendJson(res, 400, { error: { code: 'invalid_request_error', message: body.message } }); return true }
      await runWrite('loomy-permanent-lock', 'loomy', async () => {
        await pool.setPermanentLocked('loomy', body.value['locked'] === true)
        return { provider: 'loomy', locked: pool.permanentLocked('loomy') }
      })
      return true
    }

    // 通用端点：`{ provider, locked }`；`locked` 省略时为**只读**查询。
    if (path === '/api/permanent-lock' && (method === 'PATCH' || method === 'GET')) {
      if (method === 'GET') {
        const provider = (url.searchParams.get('provider') ?? '').trim()
        if (provider.length === 0) {
          sendJson(res, 400, { error: { code: 'invalid_request_error', message: '缺少 provider' } })
          return true
        }
        sendJson(res, 200, { provider, locked: pool.permanentLocked(provider) })
        return true
      }
      const body = await readBody(req)
      if (!body.ok) { sendJson(res, 400, { error: { code: 'invalid_request_error', message: body.message } }); return true }
      const provider = typeof body.value['provider'] === 'string' ? body.value['provider'].trim() : ''
      if (provider.length === 0) {
        sendJson(res, 400, { error: { code: 'invalid_request_error', message: '缺少 provider' } })
        return true
      }
      // locked 缺席 = 只读（与来源 `credits.permanentLock` 的语义一致）。
      if (body.value['locked'] === undefined) {
        sendJson(res, 200, { provider, locked: pool.permanentLocked(provider) })
        return true
      }
      await runWrite('permanent-lock', provider, async () => {
        await pool.setPermanentLocked(provider, body.value['locked'] === true)
        return { provider, locked: pool.permanentLocked(provider) }
      })
      return true
    }

    // ═══════════════ 积分（余额 / 签到 / 新手任务）═══════════════

    if (path === '/api/credits/balances' && method === 'POST') {
      const body = await readBody(req)
      if (!body.ok) { sendJson(res, 400, { error: { code: 'invalid_request_error', message: body.message } }); return true }
      const provider = typeof body.value['provider'] === 'string' ? body.value['provider'] : ''
      if (provider.length === 0) {
        sendJson(res, 400, { error: { code: 'invalid_request_error', message: '缺少 provider' } })
        return true
      }
      // 余额查询是只读性质（不写数据），但会向上游发请求；失败给出可读原因
      // （前端把 error 显示在账号卡片上，而不是笼统的「查询失败」）。
      try {
        const result = await fetchBalances(provider, { pool, credentials, fetcher: options.fetcher, warn: (m) => logger.warn(m), ...(options.refreshCoordinator === undefined ? {} : { coordinator: options.refreshCoordinator }) })
        sendJson(res, 200, result)
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        sendJson(res, 400, { error: { code: 'credits_unsupported', message } })
      }
      return true
    }

    if (path === '/api/credits/claim-all' && method === 'POST') {
      const body = await readBody(req)
      if (!body.ok) { sendJson(res, 400, { error: { code: 'invalid_request_error', message: body.message } }); return true }
      const provider = typeof body.value['provider'] === 'string' ? body.value['provider'] : ''
      await runWrite('credits-claim-all', provider, () =>
        claimAllCredits(provider, { pool, credentials, fetcher: options.fetcher, warn: (m) => logger.warn(m), ...(options.refreshCoordinator === undefined ? {} : { coordinator: options.refreshCoordinator }) }))
      return true
    }

    if (path === '/api/credits/onboarding' && method === 'POST') {
      const body = await readBody(req)
      if (!body.ok) { sendJson(res, 400, { error: { code: 'invalid_request_error', message: body.message } }); return true }
      const provider = typeof body.value['provider'] === 'string' ? body.value['provider'] : ''
      const accountId = typeof body.value['accountId'] === 'string' ? body.value['accountId'] : ''
      await runWrite('credits-onboarding', `${provider}/${accountId}`, () =>
        claimOnboarding(provider, accountId, { pool, credentials, fetcher: options.fetcher, warn: (m) => logger.warn(m), ...(options.refreshCoordinator === undefined ? {} : { coordinator: options.refreshCoordinator }) }))
      return true
    }

    // 每日积分保活（仅 raccoon）：模拟「当日登录」，把当天到账的每日积分
    // 有效期从「当天 24:00」延长到 7 天。
    //
    // ⚠️ 这是**写操作**（会改变服务端账期状态），故走 runWrite 留痕；
    // 但它幂等 —— 当天已延长时直接返回 `already-extended`，不发触发请求。
    if (path === '/api/credits/daily-keepalive' && method === 'POST') {
      const body = await readBody(req)
      if (!body.ok) { sendJson(res, 400, { error: { code: 'invalid_request_error', message: body.message } }); return true }
      const provider = typeof body.value['provider'] === 'string' ? body.value['provider'] : ''
      await runWrite('credits-daily-keepalive', provider, () =>
        keepAliveDailyPoints(provider, { pool, credentials, fetcher: options.fetcher, warn: (m) => logger.warn(m), ...(options.refreshCoordinator === undefined ? {} : { coordinator: options.refreshCoordinator }) }))
      return true
    }

    // ═══════════════ 备份导入导出 ═══════════════

    if (path === '/api/backup/export' && method === 'POST') {
      // 标准备份格式（providers/backup.ts，Jet Hub 前端原生兼容）：
      // 账号 + 凭据 + 模型开关。⚠️ 凭据明文**只出现在这份响应里**
      // （前端保存为下载文件或经口令加密），不写日志、不进留痕。
      const result = await exportBackup(asBackupPool(pool), credentials)
      auth.record('backup-export', `${result.payload.accounts.length}-accounts`, true)
      sendJson(res, 200, { payload: result.payload, warnings: result.warnings })
      return true
    }

    if (path === '/api/backup/import' && method === 'POST') {
      const body = await readBody(req)
      if (!body.ok) { sendJson(res, 400, { error: { code: 'invalid_request_error', message: body.message } }); return true }
      await runWrite('backup-import', 'pool+credentials', async () => {
        const raw = body.value['payload']
        if (raw === undefined) throw new Error('备份内容缺失（payload 字段）')
        // 1. 先把现有数据备份成同格式文件（导入失败可回退的依据）。
        const current = await exportBackup(asBackupPool(pool), credentials)
        const backupPath = writeImportBackup(options.backupDir ?? join(process.cwd(), 'data', 'backups'), current.payload)
        // 2. 导入（先写凭据、再整体替换池；坏格式在校验阶段即被拒绝，
        //    不会留下「导入了一半」的状态）。
        const result = await importBackup(credentials, asBackupPool(pool), raw)
        return { ...result, backupPath }
      })
      return true
    }

    if (path === '/api/backup/status' && method === 'GET') {
      // 前端导入确认页用它提示「将被覆盖的数据规模」；失败不阻断导入。
      sendJson(res, 200, {
        accounts: (await pool.listAllAccounts()).length,
        providers: registry.ids().length,
      })
      return true
    }

    // 路径以 /api/ 开头但未匹配任何端点：明确 404 而不是落到对外 API 的
    // 未知端点分支（那会给出「未知端点 GET /api/xxx」这种对外语义的错误）。
    if (write) auth.record(`${method} ${path}`, '', false)
    sendJson(res, 404, { error: { code: 'admin_not_found', message: `未知管理端点 ${method} ${path}` } })
    return true
  }
}

/** 读取并解析 JSON body。 */
async function readBody(req: IncomingMessage): Promise<{ ok: true; value: Record<string, unknown> } | { ok: false; message: string }> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    const buf = chunk as Buffer
    size += buf.length
    if (size > MAX_ADMIN_BODY_BYTES) return { ok: false, message: '请求体过大' }
    chunks.push(buf)
  }
  const text = Buffer.concat(chunks).toString('utf-8')
  // 空 body 视为 `{}`：`POST /api/keys/x/reset-usage` 之类不需要参数。
  if (text.trim().length === 0) return { ok: true, value: {} }
  try {
    const parsed = JSON.parse(text) as unknown
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      return { ok: false, message: '请求体必须是 JSON 对象' }
    }
    return { ok: true, value: parsed as Record<string, unknown> }
  } catch {
    return { ok: false, message: '请求体不是合法 JSON' }
  }
}

/** 从请求体里取授权范围（仅创建时用）。 */
function normalizeScope(body: Record<string, unknown>): {
  providers?: string[]
  models?: string[]
  rateLimitPerMinute?: number
  quotaTokens?: number
} {
  const out: {
    providers?: string[]
    models?: string[]
    rateLimitPerMinute?: number
    quotaTokens?: number
  } = {}
  const providers = stringArray(body['providers'])
  if (providers !== undefined) out.providers = providers
  const models = stringArray(body['models'])
  if (models !== undefined) out.models = models
  const rate = positiveInt(body['rateLimitPerMinute'])
  if (rate !== undefined) out.rateLimitPerMinute = rate
  const quota = positiveInt(body['quotaTokens'])
  if (quota !== undefined) out.quotaTokens = quota
  return out
}

/**
 * 从请求体里取「修改」补丁。
 *
 * ⚠️ 与创建的关键差别：这里必须能表达**清除限制**（把 `providers` 设回
 * 「不限制」）。约定是「字段存在且为 `null`」= 清除，「字段不存在」= 不改。
 * 若把两者混为一谈，用户就无法把一把受限 key 恢复成不限范围。
 */
function patchFrom(body: Record<string, unknown>): Parameters<ApiKeyStore['update']>[1] {
  const patch: Parameters<ApiKeyStore['update']>[1] = {}
  if (typeof body['name'] === 'string') patch.name = body['name']
  if (typeof body['disabled'] === 'boolean') patch.disabled = body['disabled']
  for (const key of ['providers', 'models'] as const) {
    if (!Object.prototype.hasOwnProperty.call(body, key)) continue
    if (body[key] === null) patch[key] = undefined
    else {
      const value = stringArray(body[key])
      if (value !== undefined) patch[key] = value
    }
  }
  for (const key of ['rateLimitPerMinute', 'quotaTokens'] as const) {
    if (!Object.prototype.hasOwnProperty.call(body, key)) continue
    if (body[key] === null) patch[key] = undefined
    else {
      const value = positiveInt(body[key])
      if (value !== undefined) patch[key] = value
    }
  }
  return patch
}

/** 取字符串数组；非数组返回 `undefined`。 */
function stringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined
  return value.filter((v): v is string => typeof v === 'string' && v.trim().length > 0).map(v => v.trim())
}

/**
 * 从 URL 查询参数构造用量查询条件。
 *
 * 时间支持 ISO 字符串与毫秒时间戳两种写法（前端日期选择器给 ISO，
 * curl 调试给时间戳）；非法值**忽略**而不是报错 —— 查询是只读操作，
 * 让用户为一个写错的参数收到 500 不值得，忽略等价于「该筛选不生效」。
 */
function usageQueryFromUrl(url: URL): UsageQuery {
  const query: UsageQuery = {}
  const from = url.searchParams.get('from')
  if (from !== null && from.trim().length > 0) query.from = from.trim()
  const to = url.searchParams.get('to')
  if (to !== null && to.trim().length > 0) query.to = to.trim()
  const keyId = url.searchParams.get('keyId')
  if (keyId !== null && keyId.trim().length > 0) query.keyId = keyId.trim()
  const provider = url.searchParams.get('provider')
  if (provider !== null && provider.trim().length > 0) query.provider = provider.trim()
  const model = url.searchParams.get('model')
  if (model !== null && model.trim().length > 0) query.model = model.trim()
  const outcome = url.searchParams.get('outcome')
  if (outcome === 'success' || outcome === 'failure') query.outcome = outcome
  const limit = positiveInt(Number(url.searchParams.get('limit') ?? NaN))
  if (limit !== undefined) query.limit = limit
  const offsetRaw = url.searchParams.get('offset')
  if (offsetRaw !== null && /^\d+$/.test(offsetRaw.trim())) query.offset = Math.floor(Number(offsetRaw))
  return query
}

/** 取正整数；非法返回 `undefined`。 */
function positiveInt(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return undefined
  return Math.floor(value)
}

/**
 * 写一份「导入前」的备份文件（备份导入用，可回退的依据）。
 *
 * @returns 备份文件路径（返回给前端，让用户知道回退文件在哪）。
 */
function writeImportBackup(
  dir: string,
  payload: unknown,
): Promise<string> {
  mkdirSync(dir, { recursive: true })
  const path = join(dir, `pre-import-${new Date().toISOString().replace(/[:.]/g, '-')}.json`)
  writeFileSync(path, JSON.stringify({ kind: 'pre-import', ...payload as Record<string, unknown> }, null, 2), 'utf-8')
  return Promise.resolve(path)
}

/** 写 JSON 响应。 */
function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload)
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' })
  res.end(body)
}
