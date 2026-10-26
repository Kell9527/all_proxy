/**
 * all_proxy 入口。
 *
 * 用法：
 *   node dist/index.js --version     打印版本
 *   node dist/index.js --help        打印帮助
 *   node dist/index.js serve         启动网关（默认）
 *
 * ## 启动时的资产自检
 *
 * `tsc` **不会**复制 `.wasm`，而 Qoder 的加密推理按 `import.meta.url` 相对自身
 * 目录解析 `qoder-auth-wasm.wasm`。若产物里缺它，Qoder 会在**第一次请求时**才
 * ENOENT —— 那时错误现场离根因很远。故启动时先自检并给出明确指引。
 */

import { existsSync, readFileSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { AccountPool } from './pool/account-pool.js'
import { FileCredentialStore } from './pool/store.js'
import type { CredentialStore, ProviderAccountEntry } from './pool/types.js'
import type { Logger } from './pool/store.js'
import { ProviderRegistry } from './providers/registry.js'
import { SENSENOVA } from './providers/sensenova-product.js'
import { sensenovaNicknameFromKey } from './providers/sensenova.js'
import { currentAccountIdFor, recordCurrentAccount, registerAllProviders } from './providers/wiring.js'
import { ApiKeyStore } from './auth/api-keys.js'
import { createApiKeyAuthenticator } from './auth/authenticate.js'
import {
  AdminAuth,
  assertAdminSafety,
  isLoopbackHost,
  MIN_ADMIN_SECRET_LENGTH,
  MIN_LOOPBACK_ADMIN_SECRET_LENGTH,
} from './admin/auth.js'
import { createAdminHandler } from './admin/router.js'
import { createGatewayServer } from './gateway/server.js'
import { UsageStore } from './usage/store.js'
import { createUsageRecorder } from './usage/recorder.js'
import { RotatingLogger, loggerAdapter } from './usage/logger.js'
import { LoginOrchestrator } from './login/orchestrator.js'
import { findExistingOfficeAceAccount } from './login/officeace-dedupe.js'
import { RefreshCoordinator } from './pool/refresh-coordinator.js'
import { refreshAccountOnce } from './refresh/refresh-account.js'
import { claimOfficeAceDailyBonuses, refreshDueAccounts } from './refresh/runtime-helpers.js'

/** 当前模块所在目录（源码态与产物态都能用）。 */
const HERE = dirname(fileURLToPath(import.meta.url))

/** 包版本；读取自身 package.json（构建后位于 dist/ 的上一级）。 */
export function readVersion(): string {
  // 兼容两种布局：dist/index.js（构建后）与 src/index.ts（开发态）。
  for (const candidate of [join(HERE, '..', 'package.json'), join(HERE, '..', '..', 'package.json')]) {
    try {
      const parsed = JSON.parse(readFileSync(candidate, 'utf8')) as { name?: unknown; version?: unknown }
      if (parsed.name === 'all-proxy' && typeof parsed.version === 'string') return parsed.version
    } catch {
      // 继续尝试下一个候选路径。
    }
  }
  return 'unknown'
}

/**
 * 自检运行时资产。
 *
 * @returns 缺失资产的说明列表（空数组表示齐全）。
 */
export function missingAssets(): string[] {
  const missing: string[] = []
  // Qoder WASM：与 qoder-wasm.js 同目录（构建后是 dist/providers/）。
  const wasm = join(HERE, 'providers', 'qoder-auth-wasm.wasm')
  if (!existsSync(wasm)) {
    missing.push(
      `${wasm}\n    Qoder 的加密推理依赖它。构建后请执行: node scripts/copy-assets.mjs`,
    )
  }
  return missing
}

const HELP = `all_proxy — 聚合 13 个 AI 平台账号的 OpenAI / Anthropic 兼容网关

用法:
  all-proxy [命令] [选项]

命令:
  serve           启动网关（默认）
  import-dsh      从 DSH 导入账号与模型开关（只读，不写回 DSH）

选项:
  --version, -v   打印版本后退出
  --help, -h      打印本帮助后退出

环境变量:
  ALL_PROXY_DATA_DIR       数据目录（账号、凭据、API Key、用量库），默认 <仓库>/data
  ALL_PROXY_PORT           监听端口，默认 3877
  ALL_PROXY_HOST           监听地址，默认 127.0.0.1
  ALL_PROXY_ADMIN_SECRET   管理口令（对外监听时**必须**设置，至少 12 字符）
  SENSENOVA_API_KEYS       SenseNova（商汤）静态 API Key，逗号分隔；
                           仅在**尚无 sensenova 账号**时用于首次初始化
`

/** CLI 主函数；返回进程退出码。 */
export function main(argv: readonly string[] = process.argv.slice(2)): number {
  if (argv.includes('--version') || argv.includes('-v')) {
    process.stdout.write(`${readVersion()}\n`)
    return 0
  }
  if (argv.includes('--help') || argv.includes('-h')) {
    process.stdout.write(HELP)
    return 0
  }

  // 资产自检：缺 WASM 时明确报错，而不是等到第一次 Qoder 请求。
  const missing = missingAssets()
  if (missing.length > 0) {
    process.stderr.write(`all_proxy: 缺少运行时资产：\n  ${missing.join('\n  ')}\n`)
    return 1
  }

  const command = argv[0] === 'import-dsh' ? 'import-dsh' : 'serve'
  if (command === 'import-dsh') {
    process.stderr.write('all_proxy: import-dsh 请通过管理端「备份导入」或管理 API 完成（见 README）\n')
    return 2
  }
  return serveCommand()
}

// ───────────────────────── serve 组装 ─────────────────────────

/** 数据目录的解析（优先环境变量，回退仓库内 data/）。 */
function resolveDataDir(): string {
  const fromEnv = process.env['ALL_PROXY_DATA_DIR']?.trim()
  if (fromEnv !== undefined && fromEnv.length > 0) return fromEnv
  // dist/index.js → 仓库根是 dist/..；src/index.ts → 仓库根是 src/..。
  for (const root of [join(HERE, '..'), join(HERE, '..', '..')]) {
    if (existsSync(join(root, 'package.json'))) return join(root, 'data')
  }
  return join(process.cwd(), 'data')
}

/** 管理端构建产物目录（存在才托管；开发态可由 Vite dev server 代理）。 */
function resolveStaticRoot(): string | undefined {
  for (const root of [join(HERE, '..', 'web', 'dist'), join(HERE, '..', '..', 'web', 'dist')]) {
    if (existsSync(join(root, 'index.html'))) return root
  }
  return undefined
}

/**
 * 用 `SENSENOVA_API_KEYS`（逗号分隔）首次引导 SenseNova 账号。
 *
 * ## 三条硬约束
 *
 * 1. **只在尚无 sensenova 账号时执行**：已有账号说明用户已（通过管理端或
 *    上次引导）配置过，此时**绝不追加**——否则用户在管理端删掉的 key 会被
 *    环境变量每次启动塞回来，删除动作形同虚设。
 * 2. **先写凭据、再写索引**（与登录流程同约定），避免留下无凭据的账号。
 * 3. 单把 key 失败只跳过该把，不让整个启动失败（引导是便利路径，不是必需）。
 *
 * 凭据字段写 `access_token`（值是 key），与 `findAccountIdByCredential` 的既有
 * 约定一致 —— 改字段名会让账号永远登记不上。
 */
async function bootstrapSensenovaKeys(
  pool: AccountPool,
  credentials: CredentialStore,
  logger: Logger,
): Promise<void> {
  const raw = process.env[SENSENOVA.envVar]?.trim()
  if (raw === undefined || raw.length === 0) return
  // 已有账号 → 不干预（见约束 1）。
  if (pool.listAccountsByProvider(SENSENOVA.id).length > 0) return

  const keys = raw.split(',').map((key) => key.trim()).filter((key) => key.length > 0)
  if (keys.length === 0) return

  let created = 0
  for (const key of keys) {
    try {
      const ref = `SENSENOVA_ACCOUNT_${randomBytes(4).toString('hex').toUpperCase()}`
      await credentials.set(ref, JSON.stringify({ access_token: key }))
      const entry: ProviderAccountEntry = {
        id: `${SENSENOVA.id}-${randomBytes(4).toString('hex')}`,
        provider: SENSENOVA.id,
        nickname: sensenovaNicknameFromKey(key),
        enabled: true,
        credentialRef: ref,
        createdAt: Date.now(),
        refreshable: false,
      }
      await pool.addAccount(entry)
      created++
    } catch (error) {
      logger.warn(`[sensenova] 引导 ${SENSENOVA.envVar} 中的一把 key 失败，已跳过：${String(error)}`)
    }
  }
  if (created > 0) {
    logger.info(`[sensenova] 已从 ${SENSENOVA.envVar} 引导 ${created} 个账号（顺序即轮询优先级）`)
  }
}

/** serve 命令：组装全部组件并启动；进程被信号终止时优雅退出。 */
function serveCommand(): number {
  void startServe()
    .then(({ port, host, adminBootstrapSecret }) => {
      if (adminBootstrapSecret !== undefined) {
        process.stderr.write(`all_proxy: 管理口令（仅本次启动打印，请立即保存）：${adminBootstrapSecret}\n`)
      }
      process.stderr.write(`all_proxy: 已监听 http://${host}:${port}（管理端同源，OpenAI /v1 与 Anthropic /v1/messages）\n`)
    })
    .catch((error: unknown) => {
      process.stderr.write(`all_proxy: 启动失败：${error instanceof Error ? error.message : String(error)}\n`)
      process.exitCode = 1
    })
  // 启动是异步的；主函数立即返回 0（真正的失败通过 exitCode 上报）。
  return 0
}

/** 组装并启动服务的全部组件。 */
async function startServe(): Promise<{ port: number; host: string; adminBootstrapSecret?: string }> {
  const dataDir = resolveDataDir()
  const port = Number(process.env['ALL_PROXY_PORT'] ?? '3877')
  const host = process.env['ALL_PROXY_HOST'] ?? '127.0.0.1'


  const credentials = new FileCredentialStore(dataDir)
  const pool = new AccountPool({ credentials, dataDir })
  const registry = new ProviderRegistry()

  const rotating = new RotatingLogger({ path: join(dataDir, 'logs', 'app.log'), mirrorToConsole: true })
  const logger = loggerAdapter(rotating)

  // ── SenseNova 静态 key 的首次引导（可选）──
  // 只在「该 provider 尚无账号」时用 SENSENOVA_API_KEYS 建号，**绝不覆盖**
  // 已有账号（否则用户删掉的 key 会被环境变量每次启动塞回来）。
  // 静态 key 无需登录，故这是一条「零文件启动」路径；也可事后在管理端粘贴。
  await bootstrapSensenovaKeys(pool, credentials, logger)

  // ── 凭据解析与刷新（适配器的两个外部依赖）──
  // ⚠️ 单飞协调器必须是**单例**，且与定时任务（refreshDueAccounts）共用：
  // 请求路径与定时任务会在同一时刻刷同一个账号，各自单飞等于没单飞
  // （一次性 refresh_token 会被消耗两次）。
  const refreshCoordinator = new RefreshCoordinator()

  /**
   * 刷新**当前正在使用的那个账号**的凭据。
   *
   * ⚠️ 这里刻意优先用 {@link currentAccountIdFor} 而不是「provider 的首个可用
   * 账号」：适配器的时序是「先 resolveCredential（内部记录选中账号）→ 发现
   * 过期才调 refresh」，故此刻已知用的是谁。早前用 `getAvailableAccount(provider,'')`
   * 会让多账号场景刷新**别的账号** —— 真正在用的那个依旧过期，请求继续失败，
   * 而一个无关账号被白白轮换了 refresh_token。
   *
   * 退化路径（无记录，例如定时任务或首个账号缺凭据）：取当前可用账号，
   * 保持既有行为。
   */
  const wiringRefresh = async (provider: string): Promise<void> => {
    const targetId = currentAccountIdFor(provider)
    const entry = targetId === undefined
      ? (await pool.getAvailableAccount(provider, ''))?.entry
      : pool.findAccount(targetId)
    if (entry === undefined) throw new Error(`${provider} 没有可续期的账号`)
    await refreshAccountOnce({ credentials, pool, coordinator: refreshCoordinator, logger }, entry)
  }

  registerAllProviders(registry, {
    pool,
    credentials,
    dataDir,
    logger,
    resolveCredential: async (provider, model, exclude) => {
      const found = await pool.getAvailableAccount(provider, model ?? '', exclude)
      if (found === null) {
        throw new Error(`${provider} 当前没有可用账号（已启用账号均缺失凭据或被限流）`)
      }
      // 记录实际选中的账号：限流标注与用量记录都指向它。
      recordCurrentAccount(provider, found.entry.id)
      return found.credential
    },
    refresh: wiringRefresh,
    readImage: async () => { throw new Error('本项目暂无附件服务') },
  })

  // ── 鉴权 / 用量 / 登录 / 管理 ──
  const apiKeys = new ApiKeyStore(dataDir)
  const usage = new UsageStore(dataDir, logger)
  const recorder = createUsageRecorder({ store: usage, apiKeys, logger })
  const admin = new AdminAuth(dataDir, logger)
  // 对外监听时强制要求管理口令（本机监听也允许环境变量预设）。
  assertAdminSafety(host, admin, logger)
  // 口令长度分级：仅本机监听（默认）允许 4 位；对外监听保持 12 位硬约束
  // （管理端能导出全部账号凭据，暴露到网络时短口令等于没有保护）。
  const adminBootstrapSecret = admin.ensure(undefined, {
    minSecretLength: isLoopbackHost(host) ? MIN_LOOPBACK_ADMIN_SECRET_LENGTH : MIN_ADMIN_SECRET_LENGTH,
  })

  const login = new LoginOrchestrator({
    pool,
    credentials,
    logger,
    // OfficeAce 判重：SSO 静默授权会让用户不小心把同一账号授权多次，
    // 不判重就会在池里堆出多条指向同一账号的条目（用户报障「重复登录多次」）。
    dedupe: async (provider, credentialJson) => (
      provider === 'officeace' ? findExistingOfficeAceAccount(pool, credentialJson) : undefined
    ),
  })

  const server = createGatewayServer({
    registry,
    pool,
    port,
    host,
    authenticate: createApiKeyAuthenticator(apiKeys, logger),
    admin: createAdminHandler({
      registry,
      pool,
      credentials,
      apiKeys,
      auth: admin,
      logger,
      usage,
      login,
      backupDir: join(dataDir, 'backups'),
      // ⚠️ 与定时任务、适配器请求路径共用**同一个**单飞协调器：
      // raccoon 的 refresh_token 一次性轮换，两个协调器等于没单飞
      // （一次性 token 被消费两次，后那次必然失败）。
      refreshCoordinator,
    }),
    onRequest: recorder,
    requestLog: rotating,
    staticRoot: resolveStaticRoot(),
    logger,
  })

  // ── 周期任务：静默续期 + 用量保留策略 + OfficeAce 每日福利 ──
  //
  // ⚠️ OfficeAce 的福利按 **UTC+8 自然日**作废（上游 `expired_time` 折合北京时间
  // 当日 23:59:59），当轮不领就永久失去。它原本**只**在「用户打开积分面板」时
  // 被领取（`fetchOfficeAceBalanceDetailed` 的副作用），服务自跑、没人开面板时
  // 当天额度直接作废。用户报障的原话是「刚刚我在客户端打开了，然后登录领了
  // 100 分」—— 是**打开面板那个动作**领的，不是服务自己领的。
  // 去重按自然日（`officeAceDayKey`），故每小时跑一次是安全的。
  const tick = (): void => {
    void refreshDueAccounts({ pool, credentials, logger, coordinator: refreshCoordinator })
    void claimOfficeAceDailyBonuses({ pool, credentials, logger, coordinator: refreshCoordinator })
      .catch((error: unknown) => {
        logger.warn(`[officeace] 领取当日福利任务异常: ${error instanceof Error ? error.message : String(error)}`)
      })
    usage.applyRetention()
  }
  const timer = setInterval(tick, 60 * 60 * 1000)
  timer.unref?.()
  tick()

  await new Promise<void>((resolve) => { server.listen(port, host, resolve) })
  const address = server.address()
  const actualPort = typeof address === 'object' && address !== null ? address.port : port

  const shutdown = (): void => {
    clearInterval(timer)
    usage.close()
    server.close(() => process.exit(0))
    // 兜底：2 秒后强退（长连接不阻塞退出）。
    setTimeout(() => process.exit(0), 2000).unref?.()
  }
  process.once('SIGINT', shutdown)
  process.once('SIGTERM', shutdown)

  return { port: actualPort, host, ...(adminBootstrapSecret !== undefined ? { adminBootstrapSecret } : {}) }
}

// 仅在作为程序直接运行时执行，被 import 时不触发。
// ⚠️ 必须用 `pathToFileURL` 比较：Windows 下 `process.argv[1]` 是 `D:\...`
// 形式，手拼 `file://` 字符串永远不相等（会让 CLI 静默不执行）。
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = main()
}
