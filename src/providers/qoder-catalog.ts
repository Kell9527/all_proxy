/**
 * Qoder **远端模型目录**（`/api/v2/model/list?Encode=1`）。
 *
 * ## 为什么需要它（真实缺陷，2026-10-20 用户报障）
 *
 * 本项目此前**恒用编译期兜底表**（`QoderProduct.fallbackModels`，快照日期
 * 国际版 2026-09-21 / 中国版 2026-09-27），一次远端请求都不发。而上游改价、
 * 改免费额度、上/下架模型都不会通知任何人 ⇒ 纯静态快照必然腐坏：
 *
 * | 现象（2026-10-20 真机对账） | 兜底表 | 上游实际 |
 * |---|---|---|
 * | `dfmodel`（DeepSeek-Flash） | `price_factor = 0.1` | **`0` + `is_free` + 原价 0.1**（IDE 显示 `0.1×`划掉`0×`） |
 * | `mmodel` | `MiniMax-M2.7` / 0.2 | **`MiniMax-M3.1-Flash` / 0.1** |
 * | `fast` | 无此条 | 有（`price_factor 0.8`，受客户端版本闸门控制） |
 *
 * ⇒ 模型列表**必须以远端为准**，兜底表只作「拉不到时别把菜单变空」的回退。
 *
 * ## 协议（取自官方 IDE 产物 + 真机实测）
 *
 * 端点与请求形状来自客户端 `qoder-worker-runtime` 的 `listModelsFromRemote`：
 *
 * ```js
 * let s = "/api/v2/model/list?Encode=1"
 * let A = JqA(g, s, this.authManager)          // ← WASM 签名（prepareRequest）
 * let E = rb(await B.text())                   // ← rb = decrypt_server_response（失败即明文）
 * let u = JSON.parse(E)                        // { 场景: [模型…] }
 * ```
 *
 * 四条**实测边界**（2026-10-20，真实凭据，两个产品各验一遍）：
 *
 * 1. **host = `encryptedInferBase`**（CN `gateway.qoder.com.cn` / 国际 `api2.qoder.sh`），
 *    WASM 会在路径前补 `/algo` ⇒ 实发 `…/algo/api/v2/model/list?Encode=1`。
 * 2. **只发 GET、不带 body**，鉴权是 WASM 生成的 `Bearer COSY.<载荷>.<签名>`
 *    —— 用普通 `Bearer <token>` 会被拒。
 * 3. **`Encode=1` 不保证响应加密**：实测两个产品都回**明文 JSON**
 *    （`decrypt_server_response` 失败 ⇒ 走「失败即明文」回退，与官方 `rb()` 逐字同形）。
 * 4. **响应是 `{场景: [模型]}`**，顶层实际键含
 *    `chat / developer / assistant / inline / quest / ...`。本项目取
 *    {@link QODER_CATALOG_SCENE}（`chat`）—— 与兜底表的采集口径一致，
 *    也是加密推理端点实际走的那一类会话。
 *
 * ## ⚠️ 版本闸门：`fast` 为什么我们拿不到（而 IDE 拿得到）
 *
 * 模型条目可带 `minimal_version: {app, cli, qoder_wake, vsc}`，服务端按
 * **请求方自称的客户端类型**选对应的命名空间比较。实测闸门是
 * `{app: 1.1.66, cli: 1.1.70}`，而 IDE 是 **app 身份 + 1.1.69**；本项目用
 * **cli 身份 + `COSY_VERSION = 1.1.49`** ⇒ 天然拿不到 `fast`。
 *
 * 这是**刻意保留**的：抬 `COSY_VERSION` 会连带改变**推理**请求的签名身份，
 * 属未经实测的改动 ⇒ 不动。其余模型不受影响。
 */

import type { QoderCredential } from './qoder.js'
import type { QoderFallbackModel, QoderModelPromotion, QoderProduct } from './qoder-product.js'
import { QoderEncryptedInfer, decryptServerResponseOrRaw, describeWasmFailure } from './qoder-wasm.js'

/**
 * 目录端点（挂 `encryptedInferBase`）。
 *
 * ⚠️ **不要**写成 `/algo/api/v2/model/list`：`/algo` 前缀由 WASM 的
 * `prepareRequest` 自己补，手写会变成 `/algo/algo/…` 而 404。
 */
export const QODER_MODEL_LIST_PATH = '/api/v2/model/list?Encode=1'

/** 目录响应的**场景键**。 */
export const QODER_CATALOG_SCENE = 'chat'

/**
 * 单次目录请求预算（毫秒）。
 *
 * 官方客户端的目录请求超时是 120s，但那是**后台目录同步**的预算；本服务在
 * `listModels` 的请求路径上 await，拖满两分钟会让模型列表卡死。
 * 取 15s（与 `qoder-credits.ts` 的超时同值同因），超时即回退兜底表。
 */
export const QODER_CATALOG_TIMEOUT_MS = 15_000

/**
 * 思考档位白名单（官方产物常量 `k3`）。
 *
 * ⚠️ **必须过滤**：不在白名单里的键会被官方客户端静默丢弃，而我们若把它
 * 声明进 `efforts`，档位选择器就会渲染出上游不认的值
 * （`trae-adapter.ts` 记着这条教训：给不存在的档位会抛
 * `UNSUPPORTED_REASONING_EFFORT`）。
 *
 * ⚠️⚠️ **只有 6 个值、没有 `minimal`**（2026-10-20 从官方产物逐字复核：
 * `k3 = ["none","low","medium","high","xhigh","max"]`）。
 * 中文名表保留 `minimal`（i18n 里确有它的显示名），但**线上白名单以本常量为准**。
 */
const EFFORT_WHITELIST: ReadonlySet<string> = new Set([
  'none', 'low', 'medium', 'high', 'xhigh', 'max',
])

/** 档位别名（官方常量 `xhc`）。 */
const EFFORT_ALIASES: ReadonlyMap<string, string> = new Map([
  ['disabled', 'none'],
  ['off', 'none'],
])

/** 读非空字符串字段。 */
function readString(source: unknown, key: string): string | undefined {
  if (typeof source !== 'object' || source === null) return undefined
  const value = (source as Record<string, unknown>)[key]
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

/** 把任意值收窄成记录（数组与非对象都返回 undefined，与官方 `JsA()` 同口径）。 */
function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

/** 读有限数字字段（容忍数字字符串）。 */
function readNumber(source: unknown, key: string): number | undefined {
  if (typeof source !== 'object' || source === null) return undefined
  const value = (source as Record<string, unknown>)[key]
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim().length > 0) {
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : undefined
  }
  return undefined
}

/** 把目录里的档位名归一化到白名单取值；不在白名单内返回 undefined。 */
function normalizeEffort(raw: string): string | undefined {
  const key = raw.trim().toLowerCase()
  const aliased = EFFORT_ALIASES.get(key) ?? key
  return EFFORT_WHITELIST.has(aliased) ? aliased : undefined
}

/**
 * 从 `efforts` 字段取档位 —— **三种形态都认**，与官方 `sgi()` 逐格对齐：
 * 数组 / 逗号或空格分隔的字符串 / 对象。
 *
 * ⚠️ **只认对象是第一版**（真机两站实测都是对象），对抗审计把「数组/字符串」
 * 两种形态验成零覆盖 —— 上游一改形状，档位选择器会**静默消失**。
 *
 * ⚠️ **不要排序**：对象形态的键序**就是**官方 IDE 的渲染序
 * （客户端用 `Object.entries` 遍历），排序会让我们与 IDE 的档位条不一致。
 */
function parseEfforts(value: unknown): { efforts: string[]; defaultEffort?: string } {
  const dedupe = (raw: readonly unknown[]): string[] => {
    const out: string[] = []
    const seen = new Set<string>()
    for (const item of raw) {
      if (typeof item !== 'string') continue
      const key = normalizeEffort(item)
      if (key === undefined || seen.has(key)) continue
      seen.add(key)
      out.push(key)
    }
    return out
  }

  if (Array.isArray(value)) return { efforts: dedupe(value) }
  if (typeof value === 'string') return { efforts: dedupe(value.split(/[,\s]+/)) }

  const record = asRecord(value)
  if (record === undefined) return { efforts: [] }
  const efforts: string[] = []
  const seen = new Set<string>()
  let defaultEffort: string | undefined
  for (const [rawKey, rawValue] of Object.entries(record)) {
    const key = normalizeEffort(rawKey)
    if (key === undefined || seen.has(key)) continue
    seen.add(key)
    efforts.push(key)
    // 官方 `vhc()`：蛇形与驼峰**都认**。
    const flag = asRecord(rawValue)
    if (flag?.is_default === true || flag?.isDefault === true) defaultEffort = key
  }
  return defaultEffort === undefined ? { efforts } : { efforts, defaultEffort }
}

/** 该条目的思考档位与「能否关闭思考」。 */
interface QoderThinking {
  efforts: string[]
  defaultEffort?: string
  supportsDisable: boolean
}

/**
 * 复刻官方 `R3()`：从**条目**上按固定顺序找档位。
 *
 * ⚠️ `ogi`（`thinking_config` / `thinkingConfig`）与 `Rhc`
 * （`enabled` / `enabledConfig`）这两个命名空间列表是官方原样，**不要顺手扩**。
 */
function effortsFromEntry(entry: Record<string, unknown>): { efforts: string[]; defaultEffort?: string } {
  const top = parseEfforts(entry.efforts)
  if (top.efforts.length > 0) return top
  for (const blockKey of ['thinking_config', 'thinkingConfig']) {
    const block = asRecord(entry[blockKey])
    if (block === undefined) continue
    const direct = parseEfforts(block.efforts)
    if (direct.efforts.length > 0) return direct
    for (const enabledKey of ['enabled', 'enabledConfig']) {
      const enabled = asRecord(block[enabledKey])
      if (enabled === undefined) continue
      const nested = parseEfforts(enabled.efforts)
      if (nested.efforts.length > 0) return nested
    }
  }
  return { efforts: [] }
}

/** `thinking_config` 块里是否存在 `disabled` 分支（官方 `Mhc()`）。 */
function hasDisabledBranch(block: Record<string, unknown> | undefined): boolean {
  if (block === undefined) return false
  return block.disabled !== undefined && block.disabled !== null && block.disabled !== false
}

/**
 * 该条目的思考档位与「能否关闭思考」。
 *
 * 四条口径**逐条对齐官方客户端**：
 *
 * 1. 档位优先取 `thinking_config.enabled.efforts`，其次 `thinking_config.efforts`、
 *    条目顶层的 `efforts`；
 * 2. **`available_reasoning_effort` 是「一个 `thinking_config` 对象」**，
 *    不是档位表本身 —— 必须包一层再解析；
 * 3. `defaultEffort`：先取档位对象里的 `is_default`/`isDefault`，
 *    都没有时才用顶层 `default_effort`/`defaultEffort`；
 * 4. `supportsDisable` = `thinking_config.disabled` 存在 **或**顶层
 *    `supports_disabled`/`supportsDisabled` 为真。
 *
 * ⚠️ 3 与 4 **相互独立**：实测 `gfmodel` 有档位但不能关闭，而
 * `qmodel` / `qmodel_latest` 没有档位但能关闭。
 */
function parseThinking(entry: Record<string, unknown>): QoderThinking {
  let ownDisabled = false
  for (const blockKey of ['thinking_config', 'thinkingConfig']) {
    if (hasDisabledBranch(asRecord(entry[blockKey]))) ownDisabled = true
  }

  let parsed = effortsFromEntry(entry)
  let sourceDisabled = ownDisabled
  /**
   * ⚠️ **只有「条目自身既无档位、也无 `disabled`」时才看 `available_reasoning_effort`**
   * —— 官方 `a = R3(e) ?? R3({thinking_config: e.available_reasoning_effort})`
   * 的**短路语义**：`R3(e)` 在「有 disabled 但无档位」时也返回非 undefined。
   */
  if (parsed.efforts.length === 0 && !ownDisabled) {
    const alt = asRecord(entry.available_reasoning_effort ?? entry.availableReasoningEffort)
    if (alt !== undefined) {
      // ⚠️ 官方原样：该字段是 **thinking_config 形状的对象**，故包一层再解析；
      //    直接当档位表解析只会拿到 `enabled`/`disabled` 两个键（全被白名单丢掉）
      //    ⇒ 档位选择器静默消失。
      parsed = effortsFromEntry({ thinking_config: alt })
      if (hasDisabledBranch(alt)) sourceDisabled = true
    }
  }

  let supportsDisable = sourceDisabled
  if (entry.supports_disabled === true || entry.supportsDisabled === true) supportsDisable = true

  if (parsed.defaultEffort === undefined) {
    // 官方 `c = ci(e.default_effort ?? e.defaultEffort)`。
    const top = entry.default_effort ?? entry.defaultEffort
    if (typeof top === 'string') parsed = { ...parsed, defaultEffort: normalizeEffort(top) }
  }
  return { ...parsed, supportsDisable }
}

/**
 * 上下文窗口：取**档位表的最大档**。
 *
 * ⚠️ **不取 `max_input_tokens`** —— 两者经常自相矛盾（CN `dmodel`：
 * `max_input_tokens` 96000、档位表却到 1M），而官方客户端只认档位表。
 * 都取不到时返回 **0**（= 不声明），由消费方丢掉该字段 —— 编造一个窗口会让
 * 调用方在错误的点上触发压缩。
 */
function parseContextWindow(entry: Record<string, unknown>): number {
  const maxOf = (values: readonly unknown[]): number => {
    let max = 0
    for (const value of values) {
      const token = typeof value === 'object' && value !== null
        ? readNumber(value, 'token_count')
        : typeof value === 'number' ? value : undefined
      if (token !== undefined && token > max) max = token
    }
    return max
  }
  const config = entry.context_config
  if (typeof config === 'object' && config !== null && !Array.isArray(config)) {
    const max = maxOf(Object.values(config as Record<string, unknown>))
    if (max > 0) return max
  }
  const windows = entry.available_context_windows ?? entry.availableContextWindows
  if (Array.isArray(windows)) {
    const max = maxOf(windows)
    if (max > 0) return max
  }
  return 0
}

/**
 * 错峰折扣（目录 `promotion`）。
 *
 * ⚠️ `active` 是**目录下发那一刻**的快照，长期运行的会话里会过期 ——
 * 展示时按 `windowStart`/`windowEnd` 本地推算。故这里原样保留它，
 * 让「窗口字段缺失」时仍有回退判据。
 */
function parsePromotion(raw: unknown): QoderModelPromotion | undefined {
  const record = asRecord(raw)
  if (record === undefined) return undefined
  const discountFactor = readNumber(record, 'discount_factor')
  const beforePromotionPriceFactor = readNumber(record, 'before_promotion_price_factor')
  const windowStart = readString(record, 'window_start')
  const windowEnd = readString(record, 'window_end')
  if (discountFactor === undefined && beforePromotionPriceFactor === undefined
    && windowStart === undefined && windowEnd === undefined) {
    return undefined
  }
  const badgeZh = readString(record.badge, 'zh')
  return {
    active: record.active === true,
    ...discountFactor === undefined ? {} : { discountFactor },
    ...beforePromotionPriceFactor === undefined ? {} : { beforePromotionPriceFactor },
    ...windowStart === undefined ? {} : { windowStart },
    ...windowEnd === undefined ? {} : { windowEnd },
    ...badgeZh === undefined ? {} : { badgeZh },
  }
}

/**
 * 把一个远端模型条目转成兜底表同形（`QoderFallbackModel`）。
 *
 * ⚠️ **刻意复用兜底表的结构**：下游的 `qoderDisplayName`（倍率拼名）、
 * 档位、能力判据全都按该形状实现，转换放这里 ⇒ 远端与兜底表**走完全同一条
 * 展示/能力链路**，不会出现「远端条目少了某个字段于是倍率不显示」这类分叉。
 *
 * 形状不符（缺 key / 缺 display_name）或 `enable === false` 的条目返回 undefined
 * —— 后者是上游的「已停用」标记，客户端也把它滤掉。
 */
export function qoderRemoteModelToFallback(raw: unknown): QoderFallbackModel | undefined {
  const entry = asRecord(raw)
  if (entry === undefined) return undefined
  if (entry.enable === false) return undefined
  const id = readString(entry, 'key') ?? readString(entry, 'model_key')
  const name = readString(entry, 'display_name')
  // `name` 必须是**非空字符串**：空名会让模型列表整条不可渲染，故两者缺一即丢弃
  // 而不是填占位符。
  if (id === undefined || name === undefined) return undefined

  const priceFactor = readNumber(entry, 'price_factor')
  const originalPriceFactor = readNumber(entry, 'original_price_factor')
  const promotion = parsePromotion(entry.promotion)
  const thinking = parseThinking(entry)
  return {
    id,
    name,
    contextWindow: parseContextWindow(entry),
    supportsImage: entry.is_vl === true,
    // ⚠️ 这是**请求体 `model_config.is_reasoning` 的透传值**，不是「支持思考」的开关
    //    —— CN `dfmodel` 实测 `is_reasoning=false` 但思考与档位都正常（档位来自
    //    `thinking_config`）。完整论证见 `QoderFallbackModel.supportsThinking`。
    supportsThinking: entry.is_reasoning === true,
    ...entry.is_free === true ? { isFree: true } : {},
    ...priceFactor === undefined ? {} : { priceFactor },
    ...originalPriceFactor === undefined ? {} : { originalPriceFactor },
    ...promotion === undefined ? {} : { promotion },
    ...thinking.efforts.length === 0 ? {} : { efforts: thinking.efforts },
    ...thinking.defaultEffort === undefined ? {} : { defaultEffort: thinking.defaultEffort },
    ...thinking.supportsDisable ? { supportsDisable: true } : {},
  }
}

/**
 * 解析 `/api/v2/model/list` 的响应体。
 *
 * @param body - 已解密的 JSON。
 * @param scene - 场景键；缺省 {@link QODER_CATALOG_SCENE}。
 * @returns 该场景的模型列表；**响应形状不符时返回 `undefined`**（与「空列表」
 *   严格区分：前者是协议变了，后者是上游真的没给模型，两者对调用方的含义不同）。
 */
export function parseQoderRemoteModels(
  body: unknown,
  scene: string = QODER_CATALOG_SCENE,
): QoderFallbackModel[] | undefined {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return undefined
  const list = (body as Record<string, unknown>)[scene]
  if (!Array.isArray(list)) return undefined
  const models: QoderFallbackModel[] = []
  const seen = new Set<string>()
  for (const raw of list) {
    const model = qoderRemoteModelToFallback(raw)
    // ⚠️ 去重：重复 id 会让下游的目录校验直接判非法（整个 provider 消失），
    // 而上游按场景合并时可能给出重复 key。
    if (model === undefined || seen.has(model.id)) continue
    seen.add(model.id)
    models.push(model)
  }
  return models
}

/** {@link fetchQoderRemoteModels} 的可注入依赖（测试用）。 */
export interface QoderRemoteCatalogOptions {
  /** 注入的 fetch；缺省用全局。 */
  fetcher?: typeof fetch
  /** 单次请求预算（毫秒）；缺省 {@link QODER_CATALOG_TIMEOUT_MS}。 */
  timeoutMs?: number
}

/**
 * 拉取远端模型目录（WASM 签名 → GET → 解密 → 解析）。
 *
 * ⚠️ **失败一律抛错**，由调用方回退兜底表：这里吃掉的失败会让「目录挂了」
 * 表现为「模型变少了」，而回退兜底表至少保住菜单。
 *
 * ⚠️ **凭据的 `uid` 与 `machine_id` 是必需项**：前者参与
 * `generate_runtime_auth_fields`（缺了会产出**签名无效**的请求），后者进
 * `QoderContext`。缺任一项直接抛，不发一次注定失败的请求。
 */
export async function fetchQoderRemoteModels(
  credential: QoderCredential,
  product: QoderProduct,
  options: QoderRemoteCatalogOptions = {},
): Promise<QoderFallbackModel[]> {
  const fetcher = options.fetcher ?? fetch
  const uid = credential.uid
  if (uid === undefined || uid.length === 0 || credential.machine_id.length === 0) {
    throw new Error('凭据缺 uid / machine_id，无法签名模型目录请求（请重新登录该账号）')
  }

  // 🔴 `QoderEncryptedInfer` 持有 wasm `QoderContext`，**用完必须释放**：
  // 进程级共享的 wasm 堆只增不减，长会话最终以裸 `RuntimeError: unreachable`
  // 暴毙。目录请求是**周期性**的（N 个账号 × 每轮刷新），漏释放会让这条泄漏
  // 比推理路径更快累积。
  let client: QoderEncryptedInfer | undefined
  try {
    client = await QoderEncryptedInfer.create({
      user: { uid, securityOauthToken: credential.security_oauth_token ?? credential.access_token },
      machineId: credential.machine_id,
      metadata: { ...product.clientMetadata },
      host: product.encryptedInferBase,
    })
    const request = client.prepareRequest(
      product.encryptedInferBase, QODER_MODEL_LIST_PATH, 'GET', 'auth',
    )
    const response = await fetcher(request.url, {
      method: 'GET',
      headers: request.headers,
      signal: AbortSignal.timeout(options.timeoutMs ?? QODER_CATALOG_TIMEOUT_MS),
    })
    if (!response.ok) {
      // ⚠️ **必须带上响应体片段**：本家目录端点的失败形态里，`401`/`403`
      // 既可能是「token 过期」也可能是「签名无效」—— 只看状态码分不开，
      // 而两者对用户的出路完全不同（重新登录 vs 协议回归）。
      const snippet = await response.text().catch(() => '')
      throw new Error(
        `模型目录请求失败（HTTP ${response.status}）${snippet.length === 0 ? '' : `：${snippet.trim().slice(0, 200)}`}`,
      )
    }
    // ⚠️ 「解密失败即明文」是**协议的一部分**（官方 `rb()` 就是这么写的），
    //    故不能把解密失败当错误 —— 实测两个产品都回明文。
    const plain = await decryptServerResponseOrRaw(await response.text())
    const models = parseQoderRemoteModels(JSON.parse(plain) as unknown)
    if (models === undefined) throw new Error('模型目录响应形状非法（无 chat 场景数组）')
    if (models.length === 0) throw new Error('模型目录响应为空')
    return models
  } catch (error) {
    // wasm trap（裸 `unreachable`）在 glue 层已被改写，这里再兜一次，
    // 保证调用方的日志里是可读成因而不是一个词。
    throw describeWasmFailure(error)
  } finally {
    // ⚠️ **释放失败绝不能顶替 `try` 里的原始错误**（`finally` 里 `throw` 会
    // 无条件覆盖 `try` 的 `throw`，而 `freePointer` 在堆耗尽时**确实会抛**）
    // ⇒ 清理动作失败不改结论。
    try {
      client?.dispose()
    } catch {
      // 刻意吞掉：目录读取的结论已定，释放失败只影响后续。
    }
  }
}
