import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { signRequestHuawei } from './sign.js'
import type { CodeArtsCredential } from './types.js'

/**
 * opengw 网关配置端点 — 返回 benefit（免费额度）模型列表（glm-5.3-flash 等）。
 * 逆向自 CodeArts Agent IDE mitmproxy 抓包（2026-08）。
 */
export const OPENGW_GATEWAY_CONFIG_URL = 'https://opengw.developer.huaweicloud.com/api/v1/gateway/config'

/**
 * snap-access 内置模型列表端点 — 返回常规模型（GLM-5.2、openpangu、glm-5.2-sft-harmony 等）。
 * 响应结构：{ count, builtinModels: [{ model_id, model_name, ... }] }。
 * 用 AK/SK 签名 + Agent-Type: PromptCenter header。
 * 替代旧 SNAP_STATISTICS_URL（statistics/plugin 已不再返回 model_metrics）。
 */
export const SNAP_MODEL_BUILTIN_URL = 'https://snap-access.cn-north-4.myhuaweicloud.com/v1/model/builtin'

/** 远端动态模型列表缓存文件名（~/.cache/deveco/codearts_models.json）。 */
const CODEARTS_MODELS_CACHE_FILENAME = 'codearts_models.json'

/**
 * benefit（免费额度）模型 id 集合的缓存文件名
 * （~/.cache/deveco/codearts_benefit_models.json）。
 *
 * 与模型列表分开缓存：判定 `maas_type` 只关心 id 集合，且 chat 请求在每次
 * 签名前都要查它，独立文件可避免解析整份模型元数据。
 */
const CODEARTS_BENEFIT_CACHE_FILENAME = 'codearts_benefit_models.json'

/**
 * 远端不可用时的 benefit 模型兜底集合。
 *
 * **为什么需要它**：benefit 模型调用必须带 `maas_type: benefit`（参与
 * SDK-HMAC-SHA256 签名），否则后端返回
 * `InferHub.002002009.404 The model is not registered`。该集合的权威来源是
 * `opengw gateway/config` 的 `result.models`（见 {@link fetchCodeArtsRemoteModels}），
 * 但首次启动、未登录或远端拉取失败时拿不到，故保留一份兜底。
 *
 * 实证（2026-09-23，对齐 deveco-code-rust fb1b4a2）：
 * 1. IDE kernel 日志的 `inferhub-provider [header-debug] full headers` 显示
 *    `deepseek-v4.1-flash` 的实际出站请求带 `"maas_type":"benefit"`；
 * 2. 逐个对照两个端点的模型：`gateway/config` 的模型（glm-5.3-flash、
 *    deepseek-v4.1-flash 等）不带该头一律 404 not registered、带上即成功；
 *    而 `/v1/model/builtin` 的模型（GLM-5.2 等）带上反而 `unsupported model`。
 *
 * ⚠️ `deepseek-v4-flash` / `deepseek-v4-pro`（无日期后缀）**不在**此集合：
 * 它们是后端另外注册的非 benefit 模型，带上 maas_type 会报 unsupported model。
 * 尤其注意 gateway/config 返回的是它们的**带日期后缀**形态
 * （`deepseek-v4-flash-0731`），归一化后落到这两个 id —— 绝不能连带标成 benefit。
 */
export const CODEARTS_BENEFIT_FALLBACK: readonly string[] = ['glm-5.3-flash', 'deepseek-v4.1-flash']

/** 动态模型拉取超时（ms）。 */
const FETCH_TIMEOUT_MS = 10_000

/** 定时刷新远端模型列表的间隔（2 小时）。 */
export const MODEL_REFRESH_INTERVAL_MS = 2 * 3_600_000

export interface RemoteModel {
  id: string
  name: string
  /**
   * 消耗倍率的**仓内口径展示串**（`x0.18`）；取不到时为 `undefined`。
   *
   * ## 为什么存「展示串」而不是数值（2026-10-28 移植来源 `22eb09d`）
   *
   * 上游 `/v1/model/builtin` 的 `credit[]` 同时给了两个数 —— `ratio`（`0.05`）
   * 与 `ratio_display`（`0.7x`），而**主界面显示的是后者**，两者**不是同一个
   * 量纲**（实测：`GLM-5.2` ratio=0.05 却显示 0.7x；`deepseek-v4.1-flash`
   * 同样 ratio=0.05 却显示 0.18x）。
   * ⇒ 存数值再去拼 `x{n}` 会**编造出一个上游从未显示过的倍率**。
   * 故数值逐字取自上游 `ratio_display`，只做形态转换（见 {@link codeartsRateSuffix}）。
   *
   * ⚠️⚠️ **本字段是「拉取那一刻」的档位，会被磁盘快照固化**。倍率随时间变
   * （错峰 21:00–次日 7:59 是另一档），而快照 TTL 是 6 小时 —— 直接用本字段
   * 会在跨过 21:00 后显示错档。⇒ 消费方必须用 {@link freshRateLabel}
   * 按「现在」重算，本字段只作兜底（老快照没有 `rateSlots` 时）。
   */
  rateLabel?: string
  /**
   * 倍率的**原料**：上游的 `credit[]` 与 `time_slots` 原样保留。
   *
   * 有了它，"当前该显示哪一档"可以在**每次读取时**重算（见 {@link freshRateLabel}），
   * 而不必在拉取时定死。⚠️ 它们随快照落盘，故只保留**必要字段**（`ratio_display` /
   * `time_slot_id` 与整份 `time_slots`）而不是整条上游条目。
   */
  rateSlots?: RateSlots
}

/** 倍率重算所需的原料（见 {@link RemoteModel.rateSlots}）。 */
export interface RateSlots {
  /** 上游 `credit[]` 的**精简副本**（只留 `ratio_display` 与 `time_slot_id`）。 */
  credit: Array<{ ratio_display: string; time_slot_id: string | null }>
  /** 上游 `time_slots` 原样（`schedule` / `duration` / `timeunit`）。 */
  slots: unknown
}

/**
 * 一次远端目录拉取的**完整性**结果。
 *
 * ## 为什么需要它
 *
 * CodeArts 的目录来自**两个独立端点**（`opengw gateway/config` 给 benefit 模型、
 * `snap-access /v1/model/builtin` 给常规模型），而两处的失败路径都是
 * `fetchSignedGet` **静默返回 `undefined`**。于是「一个成功、一个失败」时
 * 调用方看到 `models.length > 0` ⇒ 判成「已拿到目录」⇒ **永久缓存残缺目录**，
 * 只有重启才能恢复。
 *
 * ⚠️ 本机实测（2026-10-28）：`gateway/config` 恒回
 * `{"error_code":"4000","error_msg":"invalid channel, group not found"}` ⇒
 * 两个来源**永远只有一个成功**，残缺是常态而不是例外。
 * ⇒ 取数函数必须**显式**回报每个来源的成败。
 */
export interface RemoteCatalogOutcome {
  /** 各来源的成败（`gateway` / `builtin`）。 */
  gatewayOk: boolean
  builtinOk: boolean
}

/** 两个来源是否**都**取到了。 */
export function isRemoteCatalogComplete(outcome: RemoteCatalogOutcome): boolean {
  return outcome.gatewayOk && outcome.builtinOk
}

/** 模块级内存缓存：远端拉取或磁盘加载后填充；availableCodeArtsModels 优先读取。 */
let memoryCache: RemoteModel[] | undefined

/** benefit 模型 id 集合的内存缓存：远端拉取或磁盘加载后填充。 */
let benefitMemoryCache: string[] | undefined

/**
 * 去掉模型 id 末尾的日期版本后缀：deepseek-v4-flash-0731 → deepseek-v4-flash。
 * 仅匹配末尾 -NNNN（4 位数字），避免误去 glm-5.3-flash 等无后缀 id。
 *
 * ⚠️⚠️ **本函数不再是「暴露给用户的那个 id」的裁剪刀**（2026-10-28 移植来源
 * `3f0f48c` / IKQY27）。实测 `/v1/model/builtin` **同时**下发两个**独立**条目：
 *
 * ```
 * {"model_id":"deepseek-v4.1-flash",      "model_name":"DeepSeek-V4.1-Flash"}
 * {"model_id":"deepseek-v4.1-flash-1017", "model_name":"DeepSeek-V4.1-Flash-1017"}
 * ```
 *
 * 两者是上游并存的旧版与新版。修前 `parseModelInfo` 拿本函数的**产物**做
 * `seen` 去重键 ⇒ 带版本号的那条被静默吞掉（本机实测：上游 10 条、本项目只
 * 出 8 条）。⇒ 现在 `parseModelInfo` 用**原始 `model_id`** 做去重键与对外 id，
 * 本函数只保留两处**内部**用途：
 * 1. gateway 分支判断「该 id 是否带日期后缀」（决定是否记为 benefit）；
 * 2. `model_name` 缺失时给一个不含版本号的兜底 id。
 *
 * ⚠️ 若将来发现某个带后缀的 id 在 chat 端点**不可用**，处置方式是在
 * `parseModelInfo` 里**显式跳过**那一条（并登记实测），**不要**退回「统一裁剪」
 * —— 那会把上游有意并存的版本再次合并掉。
 */
export function normalizeModelId(id: string): string {
  if (id.length > 5) {
    const suffix = id.slice(-5)
    if (suffix.startsWith('-') && /^\d{4}$/.test(suffix.slice(1))) {
      return id.slice(0, -5)
    }
  }
  return id
}

/**
 * 把上游 `ratio_display` 原串转成**仓内倍率口径**（`x0.7`）。
 *
 * ## 为什么必须转
 *
 * 上游 `ratio_display` 是 `0.7x`（**x 在数字后**），而全仓其余各家的展示名是
 * ` · x{n}`（**x 在数字前**）：buddy（`x0.29`）、loomy（`x0.1`）、trae（`x0.08`）、
 * accio（`x0.013`）、lobsterai（`x1.08`）。形态不一致会让「倍率」在两处口径间
 * 漂移（来源项目正是因此让聚合渠道永远挑不到 codearts）。
 *
 * ## 转换的边界（红线：绝不臆造）
 *
 * - **只改形态，不改数值** —— 数值仍逐字取自上游 `ratio_display`；
 * - **认不出就返回 `undefined`**（调用方据此不显示倍率，不用占位值冒充）。
 *   上游若改形态，这里认不出 ⇒ 少显示倍率（保守方向）。
 *
 * @returns 形如 `x0.7`；认不出返回 `undefined`。
 */
export function codeartsRateSuffix(rateLabel: string | undefined): string | undefined {
  if (typeof rateLabel !== 'string') return undefined
  const match = /^(\d+(?:\.\d+)?)x$/i.exec(rateLabel.trim())
  return match === null ? undefined : `x${match[1]}`
}

/**
 * 解析一条目录条目。
 *
 * ⚠️ 三条**不裁版本后缀**的判据（见 {@link normalizeModelId} 的长注释）：
 * 对外 id、`seen` 去重键、展示名。展示名尤其不能裁 ——
 * `DeepSeek-V4.1-Flash-1017` 里的 `1017` 正是用户要看的版本信息。
 */
function parseModelInfo(
  m: Record<string, unknown>,
  seen: Set<string>,
  /** 取倍率时用的「现在」（单测注入；缺省 `Date.now()`）。 */
  nowMs?: number,
): RemoteModel | undefined {
  const rawId = m['model_id']
  if (typeof rawId !== 'string' || rawId.length === 0) return undefined
  const id = rawId
  // 过滤视觉（VL）多模态模型
  // id 含 -VL- 或以 -VL 结尾（如 Qwen3-VL-235B），上下文小、不支持工具调用，
  // 不适合当 agent 主模型，从列表隐藏。
  // ⚠️ 判据只认**大写** `-VL`：上游 `kimi-k2.6-vl` 是小写、会漏过来。这是
  // 与来源逐字一致的**既有行为**，改动它会改变目录内容，故本次不动。
  if (id.includes('-VL-') || id.endsWith('-VL')) return undefined
  const rawName = m['model_name']
  const name = typeof rawName === 'string' && rawName.length > 0
    ? rawName
    : normalizeModelId(id)
  if (seen.has(id)) return undefined
  seen.add(id)
  return { id, name, ...readRateLabel(m, nowMs) }
}

/**
 * 从 `/v1/model/builtin` 的单条模型里读**展示用倍率串**。
 *
 * ## 字段实况（2026-10-28 本机实测）
 *
 * ```json
 * "credit": [{ "ratio":"0.05", "ratio_display":"0.18x", "time_slot_id":"default" },
 *            { "ratio":"0.05", "ratio_display":"0.09x", "time_slot_id":"off_peak" }]
 * ```
 *
 * 6 个常规模型有 `credit[]`；两个 VL 模型整个数组为空（它们上面已被
 * `parseModelInfo` 滤掉，这里只是顺带记下）。
 *
 * ⚠️ **只取 `ratio_display`，不取 `ratio`**：两者不同量纲（见
 * {@link RemoteModel.rateLabel}）。任何一步取不到就返回空对象（**不落键**）。
 */
function readRateLabel(m: Record<string, unknown>, nowMs: number = Date.now()): {
  rateLabel?: string
  rateSlots?: RateSlots
} {
  const credit = m['credit']
  if (!Array.isArray(credit) || credit.length === 0) return {}
  // ⚠️ **按时段选档**，不是无脑取 `credit[0]`（来源实测缺陷）：
  //    `deepseek-v4.1-flash` 的 `credit[0]` 是 `default`（0.18x），而错峰时段
  //    生效的是第二档 `off_peak`（0.09x）。取 `credit[0]` 会在整个错峰时段
  //    显示过高的倍率。
  const slot = pickActiveCredit(credit, m['time_slots'], nowMs)
  const rateSlots = toRateSlots(credit, m['time_slots'])
  if (slot === undefined) return rateSlots === undefined ? {} : { rateSlots }
  const display = slot['ratio_display']
  if (typeof display !== 'string' || display.length === 0) {
    return rateSlots === undefined ? {} : { rateSlots }
  }
  const suffix = codeartsRateSuffix(display)
  return {
    ...suffix === undefined ? {} : { rateLabel: suffix },
    ...rateSlots === undefined ? {} : { rateSlots },
  }
}

/** 把上游 `credit[]` / `time_slots` 精简成可落盘的原料（取不到返回 `undefined`）。 */
function toRateSlots(credit: unknown[], slots: unknown): RateSlots | undefined {
  const slim: RateSlots['credit'] = []
  for (const item of credit) {
    if (typeof item !== 'object' || item === null) continue
    const record = item as Record<string, unknown>
    const display = record['ratio_display']
    if (typeof display !== 'string' || display.length === 0) continue
    const slotId = record['time_slot_id']
    slim.push({ ratio_display: display, time_slot_id: typeof slotId === 'string' ? slotId : null })
  }
  if (slim.length === 0) return undefined
  return { credit: slim, slots: slots ?? undefined }
}

/**
 * 按**现在**重算某条目录条目的倍率展示串。
 *
 * ## 为什么不能直接用 `model.rateLabel`
 *
 * 远端目录有**磁盘快照**（`data/catalogs/codearts.json`，TTL 6 小时）。倍率随时段变
 * （`deepseek-v4.1-flash` 错峰 21:00–次日 7:59 是 `x0.09`、其余 `x0.18`），
 * 而 6 小时的快照必然跨过 21:00 这个边界 ⇒ 直接用拉取时算出的值，会在错峰开始后
 * 继续显示白天档（来源实测过同一缺陷的另一种形态：错峰期显示过高的 0.18x）。
 *
 * ⇒ 有 `rateSlots` 就**重算**，否则退回快照里那份 `rateLabel`（老快照兼容）。
 */
export function freshRateLabel(model: RemoteModel, nowMs: number = Date.now()): string | undefined {
  const slots = model.rateSlots
  if (slots === undefined) return model.rateLabel
  const picked = pickActiveCredit(slots.credit, slots.slots, nowMs)
  const display = picked?.['ratio_display']
  if (typeof display !== 'string') return model.rateLabel
  return codeartsRateSuffix(display) ?? model.rateLabel
}

/**
 * 从 `credit[]` 里挑出**当前时段生效**的那一档。
 *
 * ## 实况（2026-10-28 本机实测 `deepseek-v4.1-flash-1017`）
 *
 * ```json
 * "time_slots": {
 *   "off_peak": { "timezone":"Asia/Shanghai", "schedule":"0 0 21 * * *",
 *                 "duration":11, "timeunit":"hour" },
 *   "default":  { "schedule":null, "duration":null }
 * }
 * ```
 *
 * ⇒ `schedule` 是 **6 段 cron（秒 分 时 日 月 周）**，`duration`+`timeunit` 给窗口长度。
 *
 * ⚠️ **不做通用 cron 解析器**（红线：不为一种上游形态臆造一套通用实现）。
 * 只认已实测的这一种：固定的「时分 + 小时时长」窗口；解析不出就退回
 * `credit[0]`（与上游「无时段」时同形）。
 */
export function pickActiveCredit(
  credit: unknown[],
  slots: unknown,
  nowMs: number,
): Record<string, unknown> | undefined {
  const entries = credit.filter(
    (c): c is Record<string, unknown> => typeof c === 'object' && c !== null,
  )
  if (entries.length === 0) return undefined
  if (typeof slots !== 'object' || slots === null) return entries[0]

  for (const entry of entries) {
    const slotId = entry['time_slot_id']
    if (typeof slotId !== 'string') continue
    const slot = (slots as Record<string, unknown>)[slotId]
    if (typeof slot !== 'object' || slot === null) continue
    if (isTimeSlotActive(slot as Record<string, unknown>, nowMs)) return entry
  }
  return entries[0]
}

/**
 * 判断一个 `time_slot` 此刻是否生效。
 *
 * ⚠️ 时区**硬取 UTC+8（Asia/Shanghai）**，与仓内既有口径一致（
 * `nextUtc8DayStartMs` / `officeAceDayKey` 都用算术平移而非本机时区）：
 * 用户出差或改系统时区时，倍率显示的档位不该变。
 * 上游 `timezone` 字段实测恒为 `Asia/Shanghai`，故不引入通用时区解析。
 */
export function isTimeSlotActive(slot: Record<string, unknown>, nowMs: number): boolean {
  const schedule = slot['schedule']
  if (typeof schedule !== 'string' || schedule.length === 0) return false
  // 6 段 cron：秒 分 时 日 月 周（实测形态 `0 0 21 * * *`）
  const parts = schedule.trim().split(/\s+/)
  if (parts.length < 3) return false
  const hour = Number(parts[2])
  const minute = Number(parts[1])
  if (!Number.isFinite(hour) || !Number.isFinite(minute)) return false
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return false

  const duration = Number(slot['duration'])
  const unit = slot['timeunit']
  if (!Number.isFinite(duration) || duration <= 0) return false
  // 只认小时（实测唯一形态）；其他单位不臆造换算。
  if (unit !== 'hour') return false

  // 算术平移到 UTC+8 后取「当天已过分钟数」。
  const utc8Ms = nowMs + 8 * 3600_000
  const dayMinutes = Math.floor(utc8Ms / 60_000) % (24 * 60)
  const startMinutes = hour * 60 + minute
  const windowMinutes = duration * 60
  // ⚠️ 窗口可以**跨日界**（21:00 + 11h → 次日 7:59）：取模处理。
  const offset = (dayMinutes - startMinutes + 24 * 60) % (24 * 60)
  return offset < windowMinutes
}

/** 从 JSON 响应中沿路径指针取数组。 */
function extractJsonArray(text: string, path: string[]): unknown[] | undefined {
  try {
    let value: unknown = JSON.parse(text)
    for (const key of path) {
      if (typeof value !== 'object' || value === null) return undefined
      value = (value as Record<string, unknown>)[key]
    }
    return Array.isArray(value) ? value : undefined
  } catch {
    return undefined
  }
}

/**
 * 签名 GET 请求远端端点并读取文本；网络失败或非 200 时返回 undefined
 * （不阻断调用方）。
 */
async function fetchSignedGet(
  fetcher: typeof fetch,
  url: string,
  ak: string,
  sk: string,
  st: string,
  /** 签名后追加的头（不参与 SDK-HMAC-SHA256 签名计算）。 */
  extraUnsignedHeaders?: Readonly<Record<string, string>>,
): Promise<string | undefined> {
  const signed = await signRequestHuawei(ak, sk, st, 'GET', url, new Uint8Array())
  const headers = new Headers()
  signed.forEach((v, k) => {
    if (k !== 'host') headers.set(k, v)
  })
  if (extraUnsignedHeaders !== undefined) {
    for (const [k, v] of Object.entries(extraUnsignedHeaders)) headers.set(k, v)
  }
  try {
    const response = await fetcher(url, {
      method: 'GET',
      headers,
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    })
    if (!response.ok) return undefined
    return await response.text()
  } catch {
    return undefined
  }
}

/**
 * 从两个远端端点拉取模型列表并合并去重：
 * 1. opengw gateway/config → result.models（benefit 模型）
 * 2. snap-access /v1/model/builtin → builtinModels（常规模型）
 * 失败或空凭据时返回空数组（不阻断）。
 *
 * ## 两个必须记住的行为
 *
 * 1. **对外 id 一律是上游原始 `model_id`**（含 `-1017` 这类版本后缀）——
 *    见 {@link normalizeModelId}；
 * 2. **每条带 `rateLabel`**（仓内口径 `x0.18`，按 `time_slots` 选**当前生效**档）
 *    —— 见 {@link readRateLabel}。
 *
 * 同时把 gateway/config 下发的 benefit 模型 id 集合写入独立缓存
 * （见 {@link saveBenefitCache}），供 chat 请求判定是否带 `maas_type: benefit`。
 *
 * @param outcome - 可选出参：各来源成败（供上层决定「只展示」还是「也永久缓存」）。
 * @param nowMs - 「现在」（只为倍率选时段；缺省 `Date.now()`）。
 */
export async function fetchCodeArtsRemoteModels(
  credential: CodeArtsCredential,
  fetcher: typeof fetch = fetch,
  /**
   * 各来源成败的**出参**（见 {@link RemoteCatalogOutcome}）。
   *
   * ⚠️ 用出参而非改返回值：既有调用方与单测都按「返回数组」用，改形状会波及
   * 它们；而完整性只对**适配器/目录缓存层**有意义（它决定要不要永久缓存）。
   * 不传即不关心完整性，行为逐字节不变。
   */
  outcome?: RemoteCatalogOutcome,
  /**
   * 「现在」的时刻（毫秒）—— **只为倍率选时段**用。
   *
   * ⚠️ 加它是因为倍率**随时间变**（`deepseek-v4.1-flash` 错峰档 21:00–次日 7:59
   * 显示 0.09x，其余时段 0.18x）。单测必须能注入时刻，否则「是否落在错峰窗口」
   * 这条逻辑无法被确定性覆盖。缺省 `Date.now()` ⇒ 生产行为不变。
   */
  nowMs: number = Date.now(),
): Promise<RemoteModel[]> {
  const { access_key_id: ak, secret_access_key: sk, security_token: st } = credential
  if (!ak || !sk) {
    // 无凭据时**两个来源都没取到** —— 不能默认成 true（否则残缺被判成完整）。
    if (outcome !== undefined) {
      outcome.gatewayOk = false
      outcome.builtinOk = false
    }
    return []
  }

  const models: RemoteModel[] = []
  const seen = new Set<string>()
  // 来自 gateway/config 的 benefit 模型 id —— 调用时必须带 maas_type: benefit。
  //
  // ⚠️ 只记录**未被去掉日期后缀**的 id（即 chat 请求真正发出的那个 id）。
  // 原因：normalizeModelId 会把 gateway 的 `deepseek-v4-flash-0731` 改写成
  // `deepseek-v4-flash`，而两者在后端是**不同模型**、benefit 属性相反
  // （实测：`-0731` 不带 maas_type → 404；无后缀的不带 → 成功、带上 →
  // `unsupported model`）。记录被改写过的 id 会把无后缀模型错误标记为
  // benefit，导致它反而调用失败。既然该 id 我们根本不发送，它也就无从
  // 决定我们发送的 id 的 benefit 属性。
  const benefitIds: string[] = []

  // 1. opengw gateway/config — benefit 模型（glm-5.3-flash 等）
  //
  // ⚠️ 成功判据是「**请求成功且形状可识别**」，不是「解析出非空列表」：
  // 上游把 benefit 模型全部下架时 `result.models: []` 是**合法**状态。
  const gatewayText = await fetchSignedGet(fetcher, OPENGW_GATEWAY_CONFIG_URL, ak, sk, st)
  const gatewayArr = gatewayText === undefined
    ? undefined
    : extractJsonArray(gatewayText, ['result', 'models'])
  if (outcome !== undefined) outcome.gatewayOk = gatewayArr !== undefined
  if (gatewayArr !== undefined) {
    for (const item of gatewayArr) {
      if (typeof item === 'object' && item !== null) {
        const entry = item as Record<string, unknown>
        const rawId = typeof entry['model_id'] === 'string' ? entry['model_id'] : ''
        const mi = parseModelInfo(entry, seen, nowMs)
        if (mi) {
          // 仅当归一化未改写 id 时才记为 benefit（见上方说明）
          if (rawId.length > 0 && normalizeModelId(rawId) === rawId) benefitIds.push(mi.id)
          models.push(mi)
        }
      }
    }
  }

  // 2. snap-access /v1/model/builtin — 常规模型（GLM-5.2、openpangu、glm-5.2-sft-harmony 等）
  //    Agent-Type: PromptCenter + X-Language: zh-cn（不参与签名）。
  //    替代旧 statistics/plugin（已不再返回 model_metrics）。
  const snapText = await fetchSignedGet(fetcher, SNAP_MODEL_BUILTIN_URL, ak, sk, st, {
    'Content-Type': 'application/json',
    'Agent-Type': 'PromptCenter',
    'X-Language': 'zh-cn',
  })
  const snapArr = snapText === undefined
    ? undefined
    : extractJsonArray(snapText, ['builtinModels'])
  if (outcome !== undefined) outcome.builtinOk = snapArr !== undefined
  if (snapArr !== undefined) {
    for (const item of snapArr) {
      if (typeof item === 'object' && item !== null) {
        const mi = parseModelInfo(item as Record<string, unknown>, seen, nowMs)
        if (mi) models.push(mi)
      }
    }
  }

  /**
   * 持久化 benefit 集合：chat 请求签名时据此决定是否带 `maas_type`。
   *
   * ⚠️⚠️ **判据是「gateway 形状可识别」，不是「解析出非空列表」**（2026-10-28
   * 移植来源 `3f0f48c` 的审计 P1 修）。
   *
   * 修前是 `if (benefitIds.length > 0)` —— 注释理由是「避免把空集合覆盖掉可用
   * 缓存」。那条理由**只对了一半**：`result.models: []` 是**合法**状态（上游把
   * benefit 模型全部下架 / 该账号无 benefit 通道时就是这样），而修前的写法让
   * 这个合法状态**无法落到磁盘** ⇒ 陈旧集合**只增不减**、跨重启存活。
   *
   * ⇒ 区分两件事：
   * - **gateway 请求失败 / 形状认不出** ⇒ 不覆盖（保留旧值，宁可陈旧也不清空）；
   * - **gateway 成功且形状可识别（含 `[]`）** ⇒ **覆盖**（`[]` 表示「确认无」）。
   *
   * ⚠️ 配套：`loadBenefitCache` 必须能把「文件里是 `[]`」与「文件不存在 /
   * 解析失败」区分开，否则本节写下的 `[]` 在下次启动时又会被当成「未确认」。
   * ⚠️ 判据用**局部变量 `gatewayArr`** 而不是 `outcome?.gatewayOk`：`outcome`
   * 是可选参数，调用方可能根本不传 ⇒ 用它会**静默失效**。
   */
  if (gatewayArr !== undefined || benefitIds.length > 0) {
    setBenefitMemoryCache(benefitIds)
    saveBenefitCache(benefitIds)
  }

  return models
}

/**
 * 缓存目录：默认 `~/.cache/deveco`，可用 `DSH_CODEARTS_CACHE_DIR` 覆盖
 * （单测借此隔离，避免污染真实用户缓存）。
 */
function cacheDir(): string | undefined {
  const override = process.env.DSH_CODEARTS_CACHE_DIR
  if (override !== undefined && override.length > 0) return override
  const home = process.env.USERPROFILE ?? process.env.HOME
  if (!home) return undefined
  /**
   * ⚠️⚠️ **测试环境拒写真实用户目录**（移植来源的同款防线）。
   *
   * 有 spec 会走真读真写路径（未注入 `DSH_CODEARTS_CACHE_DIR` 时），把测试造的
   * 空目录/错值写进 `~/.cache/deveco` ⇒ **污染用户的下一轮真实运行**：模型列表
   * 被顶掉、benefit 集合被错值顶掉（每轮带错头）。
   *
   * ⇒ 判据：`NODE_ENV === 'test'` **且**最终解析到真实 `~/.cache/deveco`
   *   ⇒ 返回 `undefined`（＝「没有缓存目录」）⇒ 读走「未确认」、写静默跳过。
   *   ⚠️ 显式设了其他目录（单测自己的临时目录）不受影响；生产完全不受影响。
   */
  if (process.env.NODE_ENV === 'test') return undefined
  return `${home}/.cache/deveco`
}

/** 动态模型列表缓存路径：~/.cache/deveco/codearts_models.json。 */
function modelsCachePath(): string | undefined {
  const dir = cacheDir()
  return dir === undefined ? undefined : `${dir}/${CODEARTS_MODELS_CACHE_FILENAME}`
}

/** benefit 模型集合缓存路径：~/.cache/deveco/codearts_benefit_models.json。 */
function benefitCachePath(): string | undefined {
  const dir = cacheDir()
  return dir === undefined ? undefined : `${dir}/${CODEARTS_BENEFIT_CACHE_FILENAME}`
}

/**
 * 保存动态模型列表到缓存文件（原子写入 tmp+rename）。
 *
 * ⚠️ 必须用**顶层静态导入**的 `node:fs`（见文件头），**不能**用
 * `require('node:fs')`：本包是 ESM（package.json `"type": "module"`），
 * `require` 在 ESM 下未定义，调用会抛 ReferenceError —— 被下面的 catch
 * 静默吞掉，表现为「写入/读取永远无效」。真实缺陷（2026-09-23）：磁盘缓存
 * 的读取路径曾因 `require` 恒返回 undefined，于是模型列表与 benefit 集合
 * 每次都要回退静态兜底。
 */
export function saveModelsCache(models: RemoteModel[]): void {
  const path = modelsCachePath()
  if (!path) return
  const dir = path.slice(0, path.lastIndexOf('/'))
  try {
    mkdirSync(dir, { recursive: true })
    const tmp = path + '.tmp'
    writeFileSync(tmp, JSON.stringify(models), 'utf-8')
    renameSync(tmp, path)
  } catch {
    // 写入失败静默忽略
  }
}

/** 加载缓存文件中的动态模型列表; 文件不存在或解析失败时返回 undefined。 */
export function loadModelsCache(): RemoteModel[] | undefined {
  const path = modelsCachePath()
  if (!path) return undefined
  try {
    if (!existsSync(path)) return undefined
    const text = readFileSync(path, 'utf-8')
    const models: RemoteModel[] = JSON.parse(text)
    return Array.isArray(models) && models.length > 0 ? models : undefined
  } catch {
    return undefined
  }
}

/**
 * 取出可用模型列表，优先级：内存缓存 → 磁盘缓存 → 空。
 * 由 adapter 的 listModels 调用；无远端模型时仍回退到 adapter 的静态默认列表。
 */
export function availableCodeArtsModels(): RemoteModel[] | undefined {
  if (memoryCache !== undefined) return memoryCache
  const disk = loadModelsCache()
  if (disk !== undefined) {
    memoryCache = disk
    return disk
  }
  return undefined
}

/** 设置内存缓存（由 service 拉取成功后调用）。 */
export function setMemoryCache(models: RemoteModel[] | undefined): void {
  memoryCache = models
}

/**
 * 保存 benefit 模型 id 集合到缓存文件（原子写入 tmp+rename）。
 * 文件不存在或写入失败时静默忽略 —— 判定会回退到静态兜底集合。
 *
 * 同步写入（与 {@link loadBenefitCache} 一致）：chat 请求签名前要读它，
 * 异步写入会让「刚拉取完就发消息」的窗口期内读到旧值/空值。
 */
export function saveBenefitCache(ids: readonly string[]): void {
  const path = benefitCachePath()
  if (!path) return
  const dir = path.slice(0, path.lastIndexOf('/'))
  try {
    mkdirSync(dir, { recursive: true })
    const tmp = path + '.tmp'
    writeFileSync(tmp, JSON.stringify(ids), 'utf-8')
    renameSync(tmp, path)
  } catch {
    // 写入失败静默忽略
  }
}

/**
 * 加载缓存文件中的 benefit 模型 id 集合。
 *
 * ## 三种状态必须可分
 *
 * | 磁盘状态 | 返回 | 含义 | ⇒ 是否带 `maas_type` |
 * |---|---|---|---|
 * | 文件不存在 / 解析失败 | `undefined` | **未确认** | 不带（靠静态兜底表） |
 * | 文件是 `[]` | `[]` | **确认无** benefit 模型 | 不带 |
 * | 文件是 `["glm-5.3-flash"]` | 数组 | 确认有这些 | 命中才带 |
 *
 * ⚠️⚠️ 修前把「空数组」与「读不到」**都**返回 `undefined` ⇒ `saveBenefitCache([])`
 * 写下的「确认无」在下次启动时又退化成「未确认」，于是 `fetchCodeArtsRemoteModels`
 * 那侧修好的「空集合可落盘」被这里**抵消**（配套改动，缺一不可）。
 */
export function loadBenefitCache(): string[] | undefined {
  const path = benefitCachePath()
  if (!path) return undefined
  try {
    if (!existsSync(path)) return undefined
    const text = readFileSync(path, 'utf-8')
    const ids: unknown = JSON.parse(text)
    // ⚠️ 合法空数组 = 「确认无」（区别于文件缺失/解析失败的「未确认」）。
    if (!Array.isArray(ids)) return undefined
    if (ids.length === 0) return []
    return ids.filter((id): id is string => typeof id === 'string')
  } catch {
    return undefined
  }
}

/** 设置 benefit 集合内存缓存（由远端拉取成功后调用；undefined 表示清除）。 */
export function setBenefitMemoryCache(ids: string[] | undefined): void {
  benefitMemoryCache = ids
}

/**
 * 判断某模型是否为 benefit（免费额度）模型 —— 决定 chat 请求是否必须带
 * `maas_type: benefit`。
 *
 * 优先级：内存缓存 → 磁盘缓存（远端拉取所得）→ 静态兜底集合。
 * 远端集合优先，使后端新增 benefit 模型时**无需改代码**即可自动识别。
 *
 * ⚠️ 判定**不是**「名字里带 flash」这类猜测：`deepseek-v4-flash`（无后缀）
 * 与 `glm-5.3-flash` 名字形态相同，benefit 属性却相反。
 *
 * ⚠️⚠️ **静态兜底表仍然保留**（与移植来源的分叉点）。来源已在 `3f0f48c` 里
 * 删掉它、改为「远端唯一权威 + 请求级双向自愈」（404 补头 / `4004.200` 去头），
 * 本项目**还没有那套自愈**，故这里不能跟着删：本机 `gateway/config` 恒回
 * `4000 invalid channel, group not found`（2026-10-28 实测），远端集合是
 * **取不到**的常态 ⇒ 删表等于把 benefit 判定整条变成 `false`。
 * ⇒ 已知取舍：静态表过时会让首条消息多一次失败（来源实测过 `4004.200`）。
 * 等做「benefit 双向自愈」那一批时，这里与表一起去掉。
 */
export function isCodeArtsBenefitModel(model: string): boolean {
  if (benefitMemoryCache === undefined) benefitMemoryCache = loadBenefitCache()
  if (benefitMemoryCache !== undefined && benefitMemoryCache.includes(model)) return true
  return CODEARTS_BENEFIT_FALLBACK.includes(model)
}
