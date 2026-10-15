/**
 * 装配层：把 11 个 provider 的适配器接进注册表。
 *
 * ## 为什么单独一层
 *
 * 移植过来的适配器构造参数是**注入回调**（`resolveCredential` / `refresh` /
 * `fetchRemoteModels` / `readImage` / `accountPool`）。这一层负责把这些回调接到
 * 本项目的账号池与凭据存储上 —— 于是适配器文件**完全不需要改动**。
 *
 * ## 凭据解析的职责划分
 *
 * 适配器只声明「我要一份凭据」，不关心从哪个账号来。本层的解析器负责：
 * 1. 从账号池按「provider + 模型」取一个可用账号（含顺序优先级与限流豁免）；
 * 2. 解析其凭据 JSON 并返回；
 * 3. 记录**实际选中的账号 id**（供适配器标注限流、供用量日志记录真实账号）。
 */

import type { AccountPool } from '../pool/account-pool.js'
import type { CredentialStore } from '../pool/types.js'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Logger } from '../pool/store.js'
import type { BuddyCredential } from './types.js'
import type { LobsteraiCredential } from './lobsterai.js'
import { ProviderRegistry, type ProviderDescriptor } from './registry.js'
import { fetchModels as fetchBuddyModels } from './buddy-oauth.js'
import {
  TRAE_BATCH_MODELS_PATH,
  TRAE_REQUEST_TIMEOUT_MS,
  parseTraeBatchModelList,
  traeSOLOHeaders,
  type TraeCredential,
} from './trae.js'
import {
  LOBSTERAI_REQUEST_TIMEOUT_MS,
  LobsteraiClientVersionResolver,
  lobsteraiModelsHeaders,
} from './lobsterai.js'
import { buildLobsteraiModelsUrl } from './lobsterai-adapter.js'
import { parseLobsteraiModels } from './lobsterai-adapter.js'
import { LoomyBalanceSelector } from './loomy-balance-selector.js'
import type { LoomyCredential } from './loomy.js'
import { OfficeAceExpirySelector } from './officeace-expiry-selector.js'
import type { OfficeAceCredential } from './officeace-auth.js'
import { currentAccountIdFor, recordCurrentAccount } from './current-account.js'

/** LobsterAI 客户端版本号解析器（进程内缓存，Buddy 侧 /v3/config 无此概念）。 */
const lobsteraiVersionResolver = new LobsteraiClientVersionResolver()

/**
 * 远端目录快照：内存缓存 + `data/catalogs/<provider>.json` 磁盘快照。
 *
 * ## 为什么需要（用户报障「模型列表非常慢」）
 *
 * 远端目录是真实 HTTP：四个 provider 成功拉取要 3~5 秒；而**失败路径不缓存**
 * （凭据失效/无账号时每次打开页面都重试），叠加「每个模型一次 resolveModel」，
 * 管理端一次列表要 5 秒起步。正确解法来自用户诉求：**拉一次就存到本项目**，
 * 之后读本地文件。
 *
 * 三级策略：
 * 1. 进程内缓存（TTL 内零 IO）；
 * 2. 网络拉取失败/冷却期内 → 读磁盘快照（哪怕过期也优先于兜底表：快照有倍率）；
 * 3. 都没有 → 抛错让 adapter 回退内置兜底表。
 *
 * 失败冷却：同一 provider 10 分钟内不重复发网络请求——凭据失效时重试一百次
 * 也不会变好，只会每次打开页面都把用户卡住。
 */
const catalogMemory = new Map<string, { at: number; models: unknown[] }>()
const catalogFailedAt = new Map<string, number>()
let catalogDir: string | undefined
let catalogLogger: ((message: string) => void) | undefined

/** 目录缓存有效期（内存与磁盘快照共同的「觉得还新鲜」的上限）。 */
const CATALOG_TTL_MS = 6 * 60 * 60 * 1000
/** 拉取失败后的冷却时长。 */
const CATALOG_FAIL_COOLDOWN_MS = 10 * 60 * 1000

function loadCatalogSnapshot(provider: string): unknown[] | undefined {
  if (catalogDir === undefined) return undefined
  try {
    const parsed = JSON.parse(readFileSync(join(catalogDir, `${provider}.json`), 'utf-8')) as { models?: unknown }
    if (Array.isArray(parsed.models)) return parsed.models
  } catch {
    // 没有快照或快照损坏：都当作没有。
  }
  return undefined
}

function saveCatalogSnapshot(provider: string, models: unknown[]): void {
  if (catalogDir === undefined) return
  try {
    mkdirSync(catalogDir, { recursive: true })
    writeFileSync(join(catalogDir, `${provider}.json`), JSON.stringify({ fetchedAt: Date.now(), models }), 'utf-8')
  } catch (error) {
    catalogLogger?.(`[catalog] ${provider} 快照写盘失败: ${error instanceof Error ? error.message : String(error)}`)
  }
}

/**
 * 取远端目录：内存缓存 → 网络/冷却 → 磁盘快照 → 抛错（回退兜底表）。
 *
 * ⚠️ `action` 内部包含「从账号池取凭据」，失败也走同一冷却——没有账号时
 * 不必每次重试取号。
 */
async function fetchRemoteCatalog<T>(
  provider: string,
  action: () => Promise<T[]>,
): Promise<T[]> {
  const now = Date.now()
  // 1) 进程内缓存（本次运行已拉过）。
  const cached = catalogMemory.get(provider)
  if (cached !== undefined && now - cached.at < CATALOG_TTL_MS) {
    return cached.models as T[]
  }

  // 2) 磁盘快照仍然新鲜 → **直接返回，一个字节的网络都不发**
  //    （用户诉求：拉一次存到本项目，之后读本地）。
  const disk = loadCatalogSnapshot(provider)
  if (disk !== undefined) {
    const fetchedAt = diskFetchedAt(provider)
    if (fetchedAt !== undefined && now - fetchedAt < CATALOG_TTL_MS) {
      catalogMemory.set(provider, { at: fetchedAt, models: disk })
      return disk as T[]
    }
  }

  // 3) 网络拉取（带失败冷却：凭据失效时重试一百次也不会变好）。
  const failedAt = catalogFailedAt.get(provider)
  const inCooldown = failedAt !== undefined && now - failedAt < CATALOG_FAIL_COOLDOWN_MS
  if (!inCooldown) {
    try {
      const models = await action()
      if (models.length === 0) throw new Error(`${provider} 远端目录为空或凭据失效，使用快照/内置目录`)
      catalogMemory.set(provider, { at: now, models })
      saveCatalogSnapshot(provider, models)
      return models
    } catch (error) {
      catalogFailedAt.set(provider, Date.now())
      // 失败不致命：磁盘快照（哪怕过期也有倍率）优先于内置兜底表（无倍率）。
      if (disk !== undefined) {
        catalogMemory.set(provider, { at: Date.now(), models: disk })
        catalogLogger?.(`[catalog] ${provider} 远端拉取失败，改用本地快照`)
        return disk as T[]
      }
      // 快照也没有：抛错让 adapter 回退内置兜底表（旧行为）。
      throw error
    }
  }

  // 4) 冷却期内不发网络：有快照（哪怕过期）就用；没有才抛错回退兜底表。
  if (disk !== undefined) return disk as T[]
  throw new Error(`${provider} 目录拉取失败（冷却期内且无本地快照），回退内置目录`)
}

/** 读磁盘快照的 fetchedAt（用于判断新鲜度）。 */
function diskFetchedAt(provider: string): number | undefined {
  if (catalogDir === undefined) return undefined
  try {
    const parsed = JSON.parse(readFileSync(join(catalogDir, `${provider}.json`), 'utf-8')) as { fetchedAt?: unknown }
    return typeof parsed.fetchedAt === 'number' ? parsed.fetchedAt : undefined
  } catch {
    return undefined
  }
}

/** {@link fetchRemoteCatalog} 间接引用的账号池（registerAllProviders 时设置）。 */
let currentPool: AccountPool | undefined
import { CodeArtsAdapter } from './llm-adapter.js'
import { BuddyAdapter } from './buddy-adapter.js'
import { LobsteraiAdapter } from './lobsterai-adapter.js'
import { QoderAdapter } from './qoder-adapter.js'
import { TraeAdapter } from './trae-adapter.js'
import { ClineAdapter } from './cline-adapter.js'
import { LoomyAdapter } from './loomy-adapter.js'
import { RaccoonAdapter } from './raccoon-adapter.js'
import { OfficeAceAdapter } from './officeace-adapter.js'
import { AccioAdapter } from './accio-adapter.js'
import { SensenovaAdapter, fetchSensenovaRemoteModels } from './sensenova-adapter.js'
import { CODEBUDDY, WORKBUDDY } from './product.js'
import { LOBSTERAI } from './lobsterai-product.js'
import { QODER, QODER_CN } from './qoder-product.js'
import { TRAE } from './trae-product.js'
import { CLINE } from './cline-product.js'
import { LOOMY } from './loomy-product.js'
import { RACCOON } from './raccoon-product.js'
import { OFFICEACE } from './officeace-product.js'
import { ACCIO } from './accio-product.js'
import { fetchAccioRemoteModels, parseAccioCredential } from './accio-auth.js'
import type { AccioCredential } from './accio.js'
import { SENSENOVA } from './sensenova-product.js'

/** 装配上下文：适配器需要的全部外部依赖。 */
export interface WiringContext {
  pool: AccountPool
  credentials: CredentialStore
  logger: Logger
  /** 注入的 fetch（远端模型目录用；默认真实 fetch）。 */
  fetcher?: typeof fetch
  /** 数据目录；远端目录快照落在其 `catalogs/` 子目录（省略则不落盘）。 */
  dataDir?: string
  /**
   * 解析某个 provider 当前应使用的凭据。
   *
   * @param provider - provider id。
   * @param model - 目标模型（参与限流过滤；空串表示不按模型过滤）。
   * @param exclude - 需要跳过的账号 id（请求级轮换用）。
   */
  resolveCredential: (
    provider: string,
    model?: string,
    exclude?: ReadonlySet<string>,
  ) => Promise<unknown>
  /** 刷新某个 provider 当前账号的凭据。 */
  refresh: (provider: string) => Promise<void>
  /**
   * 读取附件字节（图片输入用）。
   *
   * ⚠️ 返回类型**不含 `undefined`**：`buddy-adapter` 的 `readImage` 签名是
   * `Promise<{data, mediaType}>`（来源如此，不给可选返回）。本项目目前**没有
   * 附件服务**，故实现直接抛错 —— 比返回 undefined 更诚实：图片输入若被请求，
   * 应当明确失败而不是静默产出 `[image unavailable]` 占位符。
   */
  readImage: (attachment: unknown) => Promise<{ data: Uint8Array; mediaType: string }>
}

// 「当前选中账号」的登记处已抽到独立模块（换号重试后适配器也要登记，
// 放 wiring 会成模块循环依赖）；这里 re-export 保持既有引用路径不变。
export { currentAccountIdFor, recordCurrentAccount } from './current-account.js'

/** 每个 provider 的静态描述（供健康检查与模型列表分组）。 */
function descriptorFor(
  id: string,
  displayName: string,
  apiBase: string,
  extra: Partial<ProviderDescriptor> = {},
): ProviderDescriptor {
  return {
    id,
    displayName,
    apiBase,
    chatPath: '/chat/completions',
    authKind: 'bearer',
    catalogSource: 'remote-first',
    supportsImages: true,
    rotatesAccounts: true,
    ...extra,
  }
}

/**
 * 构造全部 11 个 provider 的适配器并注册。
 *
 * ⚠️ `loomy` 与 `raccoon` 的 `rotatesAccounts` 起初为 false：来源里它们
 * **没有**轮换逻辑。2026-09-29 应用户要求为两者补上了**请求级换号**
 * （额度耗尽 / 限流 / 认证失败时换下一个账号，见各自适配器的 stream 注释）
 * —— 换号带 `tried` 排除集，不会反复重试同一个账号，故如实改登记为 true。
 *
 * ⚠️ `sensenova` 是本项目第 11 个 provider，也是**第一个用静态 API Key**
 * 的（其余 10 个都是登录态凭据）。它同样有请求级换号（429 换下一把 key）。
 */
export function registerAllProviders(registry: ProviderRegistry, ctx: WiringContext): void {
  currentPool = ctx.pool
  catalogDir = ctx.dataDir === undefined ? undefined : join(ctx.dataDir, 'catalogs')
  catalogLogger = (message) => ctx.logger.warn(message)
  const fetcher = ctx.fetcher ?? fetch
  // ── CodeArts（华为云）：HMAC 签名；不支持图片输入 ──
  registry.register(
    descriptorFor('codearts', 'CodeArts (华为云)', 'https://snap-access.cn-north-4.myhuaweicloud.com/api/v2', {
      authKind: 'huawei-signature',
      supportsImages: false,
    }),
    new CodeArtsAdapter({
      credentialRef: 'CODEARTS_ACCESS_TOKEN' as never,
      resolveCredential: () => ctx.resolveCredential('codearts') as never,
      refresh: () => ctx.refresh('codearts'),
      accountPool: ctx.pool,
    }),
  )

  // ── CodeBuddy 系：同源、共用适配器，差异全在产品配置 ──
  registry.register(
    descriptorFor('buddy', CODEBUDDY.displayName, CODEBUDDY.endpoint),
    new BuddyAdapter({
      credentialRef: 'BUDDY_ACCESS_TOKEN' as never,
      resolveCredential: () => ctx.resolveCredential('buddy') as never,
      refresh: () => ctx.refresh('buddy'),
      accountPool: ctx.pool,
      product: CODEBUDDY,
      readImage: ctx.readImage,
      // 远端目录：/v3/config 的企业模型端点（带 creditsRate 促销倍率）。
      fetchRemoteModels: () => fetchRemoteCatalog('buddy', async () =>
        fetchBuddyModels((await ctx.pool.getAvailableAccount('buddy', ''))!.credential as BuddyCredential, fetcher, undefined, CODEBUDDY)),
    }),
  )
  registry.register(
    descriptorFor('workbuddy', WORKBUDDY.displayName, WORKBUDDY.endpoint),
    new BuddyAdapter({
      credentialRef: 'WORKBUDDY_ACCESS_TOKEN' as never,
      resolveCredential: () => ctx.resolveCredential('workbuddy') as never,
      refresh: () => ctx.refresh('workbuddy'),
      accountPool: ctx.pool,
      product: WORKBUDDY,
      readImage: ctx.readImage,
      fetchRemoteModels: () => fetchRemoteCatalog('workbuddy', async () =>
        fetchBuddyModels((await ctx.pool.getAvailableAccount('workbuddy', ''))!.credential as BuddyCredential, fetcher, undefined, WORKBUDDY)),
    }),
  )

  // ── LobsterAI ──
  registry.register(
    descriptorFor('lobsterai', LOBSTERAI.displayName, LOBSTERAI.apiBase),
    new LobsteraiAdapter({
      credentialRef: 'LOBSTERAI_ACCESS_TOKEN' as never,
      resolveCredential: () => ctx.resolveCredential('lobsterai') as never,
      refresh: () => ctx.refresh('lobsterai'),
      accountPool: ctx.pool,
      product: LOBSTERAI,
      readImage: ctx.readImage,
      fetchRemoteModels: () => fetchRemoteCatalog('lobsterai', async () => {
        const credential = (await ctx.pool.getAvailableAccount('lobsterai', ''))!.credential as LobsteraiCredential
        if (credential.access_token.length === 0) return []
        const { version } = await lobsteraiVersionResolver.resolve(LOBSTERAI)
        const response = await fetcher(
          buildLobsteraiModelsUrl(LOBSTERAI, credential, version),
          {
            method: 'GET',
            headers: lobsteraiModelsHeaders(credential, LOBSTERAI, version),
            signal: AbortSignal.timeout(LOBSTERAI_REQUEST_TIMEOUT_MS),
          },
        )
        if (!response.ok) throw new Error(`lobsterai 远端目录 HTTP ${response.status}`)
        return parseLobsteraiModels(await response.json() as unknown)
      }),
    }),
  )

  // ── Qoder 系：同源、共用适配器与同一份 WASM，差异全在产品配置 ──
  for (const product of [QODER, QODER_CN]) {
    registry.register(
      descriptorFor(product.id, product.displayName, product.encryptedInferBase, {
        authKind: 'qoder-wasm',
        // 目录需要 WASM 签名，故只用内置静态表（不发网络请求）。
        catalogSource: 'static-only',
      }),
      new QoderAdapter({
        credentialRef: `${product.id.toUpperCase()}_ACCESS_TOKEN` as never,
        resolveCredential: () => ctx.resolveCredential(product.id) as never,
        refresh: () => ctx.refresh(product.id),
        accountPool: ctx.pool,
        product,
        currentAccountId: () => currentAccountIdFor(product.id),
        readImage: ctx.readImage,
      }),
    )
  }

  // ── TRAE：SOLO 协议转换 ──
  registry.register(
    descriptorFor('trae', TRAE.displayName, TRAE.agentHost),
    new TraeAdapter({
      credentialRef: 'TRAE_ACCESS_TOKEN' as never,
      // ⚠️ 必须透传 modelId：空串会让模型级限流过滤整体短路，换号形同虚设
      //（见 TraeAdapterOptions.resolveCredential 的说明）。
      resolveCredential: (modelId?: string) => ctx.resolveCredential('trae', modelId) as never,
      refresh: () => ctx.refresh('trae'),
      accountPool: ctx.pool,
      product: TRAE,
      readImage: ctx.readImage,
      // 远端目录：batch_get_detail_param 一次拉全 22 个 function 的模型目录
      // （含 creditsRate 倍率，displayName 会拼成「模型名 · x1.5」）。
      fetchRemoteModels: () => fetchRemoteCatalog('trae', async () => {
        const credential = (await ctx.pool.getAvailableAccount('trae', ''))!.credential as TraeCredential
        if (credential.access_token.length === 0) return []
        // ⚠️ 与单通道 get_detail_param 不同：真实 IDE 传全部 22 个 function，
        // 只传聊天通道会让条目错位/被解析器跳过（照抄 TraeAuth.fetchModelsUncached）。
        const response = await fetcher(`${TRAE.agentHost}${TRAE_BATCH_MODELS_PATH}`, {
          method: 'POST',
          headers: traeSOLOHeaders(credential, TRAE, false),
          body: JSON.stringify({
            functions: [
              'ui_builder_v2', 'solo_coder', 'chat_v3', 'solo_builder',
              'builder_v3', 'builder', 'chat', 'inline_chat', 'git_ai',
              'custom_agent_generation', 'utils', 'code_reviewer',
              'code_review_summary', 'solo_agent', 'solo_agent_remote',
              'solo_work_remote', 'solo_agent_lite', 'solo_work_lite',
              'solo_design_lite', 'solo_design_remote', 'multimodal',
              'system_diagnosis',
            ],
            agent_type: '',
            current_config_info: { config_name: '', is_custom_model: false },
            mode_type: 0,
            access_type: 0,
            ab_force_vids: '',
            ab_autotest_advanced_mode: 0,
            show_custom_model: true,
          }),
          signal: AbortSignal.timeout(TRAE_REQUEST_TIMEOUT_MS),
        })
        if (!response.ok) throw new Error(`trae 远端目录 HTTP ${response.status}`)
        return parseTraeBatchModelList(await response.json() as unknown)
      }),
    }),
  )

  // ── Cline ──
  registry.register(
    descriptorFor('cline', CLINE.displayName, CLINE.apiBase),
    new ClineAdapter({
      credentialRef: 'CLINE_ACCESS_TOKEN' as never,
      resolveCredential: () => ctx.resolveCredential('cline') as never,
      refresh: () => ctx.refresh('cline'),
      accountPool: ctx.pool,
      product: CLINE,
      readImage: ctx.readImage,
    }),
  )

  // ── Loomy：余额选号 + 请求级换号（无续期端点，token 过期只能重新登录） ──
  //
  // ⚠️ **Loomy 必须按余额选号**（移植来源 `src/index.ts` 的既有接线）：Loomy
  // 的今日赠送额度耗尽后服务端继续扣永久积分且不报错（静默降级），通用选号
  // 「按手动顺序取第一个」会让 0 积分账号每次都被选中（用户报障）。选号器
  // 按「有今日额度 → 只剩永久 → 无余额/查不到」分档，档内保持手动顺序。
  const loomyBalanceSelector = new LoomyBalanceSelector({
    product: LOOMY,
    resolveCredential: async (credentialRef) => {
      // 查余额用：按 ref 实时读凭据（共享凭据文件不可缓存 —— AGENTS.md 约定 11）。
      const resolved = await ctx.pool.resolveCredentialByRef(credentialRef)
      return resolved as LoomyCredential | undefined
    },
    // 注入装配层的 fetch（测试替身用；生产为 undefined 时选号器用全局 fetch）。
    ...(ctx.fetcher === undefined ? {} : { fetcher: ctx.fetcher }),
  })
  registry.register(
    descriptorFor('loomy', LOOMY.displayName, LOOMY.apiBase, { rotatesAccounts: true }),
    new LoomyAdapter({
      credentialRef: 'LOOMY_ACCESS_TOKEN' as never,
      resolveCredential: async (modelId?: string) => {
        const pool = ctx.pool
        // 先按「未停用 + 该模型未受限」筛出候选，**再**按余额分档选号。
        // ⚠️ `modelId` 由适配器传入（见 LoomyAdapterOptions.resolveCredential
        // 的签名说明）—— 必须参与筛选，否则模型级限流过滤失效。
        const candidates = pool.listAccountsByProvider(LOOMY.id)
          .filter(a => a.enabled)
          .filter((a) => {
            const key = modelId ?? ''
            if (key.length === 0) return true
            if (!a.modelRateLimits) return true
            const resetAt = a.modelRateLimits[key]
            return resetAt === undefined || resetAt === 0 || Date.now() >= resetAt
          })
          .map(a => ({ id: a.id, credentialRef: a.credentialRef }))
        const allowPermanent = !pool.loomyPermanentLocked()
        if (candidates.length > 0) {
          const picked = await loomyBalanceSelector.select(candidates, { allowPermanent })
          if (picked !== undefined) {
            const credential = await pool.resolveCredentialByRef(picked.account.credentialRef) as LoomyCredential | undefined
            if (credential !== undefined && typeof credential.access_token === 'string' && credential.access_token.length > 0) {
              // 登记实际选中的账号：定向续期（wiringRefresh）与用量记录都以它为准。
              recordCurrentAccount(LOOMY.id, picked.account.id)
              return credential
            }
          } else if (!allowPermanent) {
            // ⚠️ 锁定永久积分时绝不可落到下面的通用兜底 —— 那会绕过锁定、
            // 照样消耗永久积分，锁定形同虚设。直接抛明确错误（来源的既有语义）。
            throw new Error(
              'Loomy：没有可用账号。已锁定永久积分，而所有账号的今日赠送额度都已用尽'
              + '（或余额查询失败）。请在管理端解锁永久积分，或等待明日额度刷新。',
            )
          }
        }
        // 兜底：无候选或选出的凭据不可解析时，退回通用池选号（会抛「没有可用账号」）。
        return await ctx.resolveCredential(LOOMY.id, modelId) as LoomyCredential
      },
      refresh: () => ctx.refresh('loomy'),
      accountPool: ctx.pool,
      product: LOOMY,
      readImage: ctx.readImage,
    }),
  )

  // ── Raccoon：请求级换号（积分耗尽 / 限流 / 认证失败时切下一个账号） ──
  registry.register(
    descriptorFor('raccoon', RACCOON.displayName, RACCOON.apiBase, { rotatesAccounts: true }),
    new RaccoonAdapter({
      resolveCredential: () => ctx.resolveCredential('raccoon') as never,
      refresh: () => ctx.refresh('raccoon'),
      accountPool: ctx.pool,
      product: RACCOON,
      readImage: ctx.readImage,
    }),
  )

  // ── OfficeAce（华为 ModelArts MaaS）：Basic 鉴权 + 按账号下发 baseUrl ──
  //
  // ⚠️ 与其余 provider 的差异：**推理 baseUrl 由凭据按账号下发**（`maasBaseUrl`），
  // 硬编码默认域会对同账号回 401 `APIG.1009`（见 officeace-adapter 的
  // `maasBaseUrlOf`）。目录是**静态表 + 探测门控**（`/v2/models` 只返回 id、
  // 不返回能力元数据，故 `catalogSource: 'static-only'`）。
  //
  // 不写 `modelRateLimits`（无请求级换号），故 `rotatesAccounts: false`。
  //
  // **选号按积分到期分档**（2026-10-15 用户指定：先临期、再长期、最后永久）：
  // OfficeAce 的积分是「一组带到期时间的包」，按账号数组顺序取第一个会把
  // 排第一账号里的永久积分先烧掉，而别的账号里的临期积分到期作废。故这里
  // 与 Loomy 同构地先查各账号分桶再选号（档内仍保持用户手动顺序）。
  //
  // ⚠️ 查询走 `fetchOfficeAceCloudSubscription`（**只读**）：推理路径上不该
  //    触发「自动领当日福利」的写操作，那件事由管理端拉余额时做。
  const officeaceExpirySelector = new OfficeAceExpirySelector({
    resolveCredential: (credentialRef) => ctx.pool.resolveCredentialByRef(credentialRef),
    fetcher,
    logger: (message) => ctx.logger.info(message),
  })
  registry.register(
    descriptorFor('officeace', OFFICEACE.displayName, OFFICEACE.defaultBaseUrl, {
      authKind: 'custom',
      catalogSource: 'static-only',
      supportsImages: true,
      rotatesAccounts: false,
    }),
    new OfficeAceAdapter({
      resolveCredential: async () => {
        const allowPermanent = !ctx.pool.permanentLocked(OFFICEACE.id)
        const candidates = ctx.pool.listAccountsByProvider(OFFICEACE.id)
          .filter(a => a.enabled)
          .map(a => ({ id: a.id, credentialRef: a.credentialRef }))
        if (candidates.length > 0) {
          const picked = await officeaceExpirySelector.select(candidates, { allowPermanent })
          if (picked !== undefined) {
            const credential = await ctx.pool.resolveCredentialByRef(picked.account.credentialRef) as OfficeAceCredential | undefined
            // 推理凭据是 modelAppKey/modelAppSecret（缺了它请求必然 401）——
            // 选号选中但凭据不完整时落到下面的通用兜底，让池去报明确错误。
            if (credential !== undefined && typeof credential.modelAppKey === 'string' && credential.modelAppKey.length > 0) {
              // 登记实际选中的账号：定向续期（wiringRefresh）与用量记录都以它为准。
              recordCurrentAccount(OFFICEACE.id, picked.account.id)
              return credential
            }
          } else if (!allowPermanent) {
            // ⚠️ 锁定永久积分时绝不可落到下面的通用兜底 —— 那会绕过锁定、
            // 照样消耗永久积分，锁定形同虚设。直接抛明确错误（与 Loomy 同语义）。
            throw new Error(
              'OfficeAce：没有可用账号。已锁定永久积分，而所有账号都只剩永久积分桶'
              + '（或积分查询失败）。请在管理端解锁永久积分，或等待临期/长期积分到账。',
            )
          }
        }
        // 兜底：无候选或选出的凭据不可解析时，退回通用池选号（会抛「没有可用账号」）。
        return await ctx.resolveCredential(OFFICEACE.id) as OfficeAceCredential
      },
      refresh: () => ctx.refresh('officeace'),
      readImage: ctx.readImage,
    }),
  )

  // ── Accio（阿里 Accio Work）：标准 OAuth + PKCE，Gemini 族协议 ──
  //
  // ⚠️ 与其余 provider 的差异：**token 必须在请求 body**（放 Authorization 头恒
  // 流内 402），且**对外 id 是「人话」slug、上行须反查上游 `modelCode`**（见
  // accio-adapter）。目录**动态拉取**（`POST /api/llm/config/v2`，token 在 body），
  // 失败回退兜底表 ⇒ `catalogSource: 'remote-first'`。
  //
  // 不写 `modelRateLimits`（无请求级换号），故 `rotatesAccounts: false`。
  registry.register(
    descriptorFor('accio', ACCIO.displayName, ACCIO.gatewayBaseUrl, {
      authKind: 'custom',
      catalogSource: 'remote-first',
      supportsImages: false,
      rotatesAccounts: false,
    }),
    new AccioAdapter({
      // ⚠️ 透传 modelId：选号器按它过滤限流账号（空串会让过滤整体短路）。
      resolveCredential: (modelId?: string) => ctx.resolveCredential('accio', modelId) as never,
      refresh: () => ctx.refresh('accio'),
      accountPool: ctx.pool,
      fetchRemoteModels: () => fetchRemoteCatalog('accio', async () => {
        const account = await ctx.pool.getAvailableAccount('accio', '')
        const credential = parseAccioCredential(JSON.stringify(account?.credential ?? {}))
        if (credential === undefined) return []
        return fetchAccioRemoteModels(credential as AccioCredential, fetcher)
      }),
    }),
  )

  // ── SenseNova（商汤开放平台）：**静态 API Key**，请求级换号 ── ⚠️ 本 provider 与其余 10 个不同类：凭据就是一把静态 `sk-...`（无登录、
  // 无 refresh）。账号来源是「管理端粘贴 key」（见 admin 的 POST /api/accounts），
  // 故这里注入 `resolveCredential`（取号）与 no-op 的 refresh（静态 key 无
  // 续期端点，适配器也不会调用它）。
  //
  // 换号语义：正常情况钉住手动顺序的第一个 key；命中 429（tpm/rpm 限流）
  // 就换下一把重试 —— 用户明确要求（K3 模型容易 429）。
  registry.register(
    descriptorFor('sensenova', SENSENOVA.displayName, SENSENOVA.apiBase, { rotatesAccounts: true }),
    new SensenovaAdapter({
      resolveCredential: () => ctx.resolveCredential('sensenova') as never,
      refresh: async () => {},
      accountPool: ctx.pool,
      product: SENSENOVA,
      readImage: ctx.readImage,
      fetchRemoteModels: () => fetchRemoteCatalog('sensenova', async () =>
        fetchSensenovaRemoteModels(ctx.pool, SENSENOVA, fetcher)),
    }),
  )
}

/**
 * 全部 provider 的 id（顺序与 `registerAllProviders` 的注册顺序一致）。
 *
 * ⚠️ 与注册顺序**必须保持同步**：测试用它断言「11 个都在」，
 * 漏一个就说明装配有缺口。
 */
export const ALL_PROVIDER_IDS = [
  'codearts',
  'buddy',
  'workbuddy',
  'lobsterai',
  'qoder',
  'qodercn',
  'trae',
  'cline',
  'loomy',
  'raccoon',
  'officeace',
  'accio',
  'sensenova',
] as const
