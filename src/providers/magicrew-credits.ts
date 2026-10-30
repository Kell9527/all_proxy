/**
 * Magicrew 的积分余额与**聚合临期折算**。
 *
 * ## 报文（实测 2026-10-28）
 *
 * ```json
 * GET /api/v1/quota/points/total → { code: 1000, data: {
 *   total_points: 1093,
 *   expiring_quota_details: [{ quota_id, expires_at: "2026-11-27 13:47:42", remaining_points: 93 }]
 * }}
 * ```
 *
 * ## ⚠️ `expires_at` **无时区** ⇒ 按 UTC+8 解释
 *
 * 上游给的是 `2026-11-27 13:47:42`（不带偏移）。按北京时间解析的依据：
 * magpie 侧用的就是 UTC+8（`beijingDay`），且其「每日积分北京时间 23:59 到期」
 * 已实跑吻合。⚠️ 若上游将来改按 UTC 存，折算会**差 8 小时**（早或晚到期）。
 *
 * ## ⚠️ 倍率口径：`input_points ÷ 2000`
 *
 * 逐个核对：`deepseek-v4.1-flash` 0.10×2000=**200** ↔ 实测 200；
 * `qwen3.5-flash` 0.01×2000=**20**；`qwen3.8-max` 0.60×2000=**1200**。
 */

import {
  MAGICREW,
  MAGICREW_LOGIN_GIFT_PATH,
  MAGICREW_MODEL_POINTS_PATH,
  MAGICREW_POINTS_PATH,
  type MagicrewProduct,
} from './magicrew-product.js'
import type { CreditBalance, CreditPackage } from './credits.js'

/**
 * 折算哨兵（本项目**没有** `aggregate` provider，故在这里就地定义）。
 *
 * ⚠️ 取值必须与来源的 `aggregate-core.ts` 逐字一致：
 * `NEVER = Number.POSITIVE_INFINITY`（长期积分：排最后但**不剔除**）、
 * `UNUSABLE = -1`（余额为 0 / 取数失败：**剔除**）。
 * 改这两个数字会改变「谁先被选中」的排序语义。
 */
const NEVER = Number.POSITIVE_INFINITY
const UNUSABLE = -1

const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
  + '(KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36'

/** 每「1×」倍率对应多少积分（magpie 侧实测口径）。 */
const MAGICREW_RATE_BASE = 2000

/** 北京时间相对 UTC 的偏移（毫秒）。 */
const BEIJING_OFFSET_MS = 8 * 60 * 60 * 1000

function headersOf(params: {
  jwt: string
  organizationCode: string
  product: MagicrewProduct
}): Record<string, string> {
  const headers: Record<string, string> = {
    authorization: `Bearer ${params.jwt}`,
    'content-type': 'application/json',
    accept: 'application/json',
    'user-agent': USER_AGENT,
    origin: params.product.webOrigin,
  }
  if (params.organizationCode.length > 0) headers['organization-code'] = params.organizationCode
  return headers
}

/**
 * 解析 `2026-11-27 13:47:42`（**无时区**）为毫秒时间戳，按 UTC+8 解释。
 *
 * 解析不出来返回 `undefined`（**不编造**）。
 */
export function magicrewParseExpiresAt(text: string): number | undefined {
  const match = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})$/.exec(text.trim())
  if (match === null) return undefined
  const [, year, month, day, hour, minute, second] = match
  const utcMs = Date.UTC(
    Number(year), Number(month) - 1, Number(day),
    Number(hour), Number(minute), Number(second),
  )
  if (!Number.isFinite(utcMs)) return undefined
  return utcMs - BEIJING_OFFSET_MS
}

export async function fetchMagicrewBalance(params: {
  jwt: string
  organizationCode: string
  product?: MagicrewProduct
  fetchImpl?: typeof fetch
}): Promise<CreditBalance | undefined> {
  const product = params.product ?? MAGICREW
  const fetchImpl = params.fetchImpl ?? fetch
  const response = await fetchImpl(`${product.host}${MAGICREW_POINTS_PATH}`, {
    // ⚠️ 超时（2026-10-29 最终审查 I5）：其余每家 `*-credits.ts` 都有；零超时会让积分面板
    //    转圈到 undici 默认 ~300s（本家 `requestTimeoutMs` 是业务 API 口径）。
    signal: AbortSignal.timeout(product.requestTimeoutMs),
    headers: headersOf({ jwt: params.jwt, organizationCode: params.organizationCode, product }),
  })
  const text = await response.text()
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return undefined
  }
  // ⚠️ `JSON.parse('null') === null` ⇒ **信封本身**可能是 `null`，直接读 `.code`
  //    会抛 `TypeError: Cannot read properties of null`（2026-10-29 实测）。
  //    契约是「取数失败 ⇒ `undefined`」（调用方 `magicrewExpiry` 据它判 `UNUSABLE`），
  //    抛出去会变成「折算整轮 reject」，与「取数失败」不同形。
  //    同型守卫见 `src/credits.ts:526-529`。
  if (typeof parsed !== 'object' || parsed === null) return undefined
  const envelope = parsed as { code?: unknown, data?: Record<string, unknown> }
  if (typeof envelope.code === 'number' && envelope.code !== 1000) return undefined
  const data = envelope.data ?? {}
  const total = typeof data.total_points === 'number' ? data.total_points : Number.NaN
  if (!Number.isFinite(total)) return undefined
  const rawBatches = Array.isArray(data.expiring_quota_details) ? data.expiring_quota_details : []
  const packages: CreditPackage[] = []
  for (const raw of rawBatches) {
    if (typeof raw !== 'object' || raw === null) continue
    const batch = raw as Record<string, unknown>
    const remaining = typeof batch.remaining_points === 'number' ? batch.remaining_points : 0
    if (remaining <= 0) continue
    const expiresAt = typeof batch.expires_at === 'string'
      ? magicrewParseExpiresAt(batch.expires_at)
      : undefined
    packages.push({
      name: '限时积分',
      unit: '积分',
      remaining,
      total: remaining,
      used: 0,
      // ⚠️ 上游是否只回「还没过期」的批次**未取证**；有效性与否由 `magicrewExpiry`
      //    按 `expiresAt > now` 判（本字段只是展示用的快照，不是判据）。
      active: true,
      cycleStartTime: '',
      cycleEndTime: '',
      // ⚠️ 到期时刻放 `expiredTime`（ISO 串）—— 本项目 `CreditPackage` 的
      //    统一口径，**没有** `deductionEndTime` 字段（那是来源的形状）。
      //    解析不出来的时刻留空串（**不编造**），由 `magicrewExpiry` 按
      //    「无到期时间 ⇒ 长期积分」处理。
      expiredTime: expiresAt === undefined ? '' : new Date(expiresAt).toISOString(),
    })
  }
  /**
   * ⚠️ **合成「长期积分」包**（I3，2026-10-29）。
   *
   * 上游只下发**临期批次**（`expiring_quota_details`），而 `total_points` 是
   * **全部积分**（含长期那部分）。实测样例：`total=1093` / 临期批次和 `=93`
   * ⇒ 长期 1000 分**没有任何条目**。
   *
   * 不合成的话：账号卡片的 hover 列包会只列 93，而合计是 1093 ⇒ 用户以为
   * 丢了 1000 分。合成后 `sum(remaining) === total`，hover 读起来才对得上。
   *
   * ⚠️ **刻意把 `expiredTime` 留空串**：长期积分没有到期时刻 ⇒
   * `magicrewExpiry` 的 `expiresAt === undefined ⇒ 跳过` 那条腿会跳过它，
   * 于是「只有长期积分」的账号仍然得 `NEVER`（排最后但不剔除）—— 与 5a 的口径一致。
   */
  const listedRemaining = packages.reduce((sum, item) => sum + item.remaining, 0)
  const longLived = total - listedRemaining
  if (longLived > 0) {
    packages.push({
      name: '长期积分',
      unit: '积分',
      remaining: longLived,
      total: longLived,
      used: 0,
      active: true,
      cycleStartTime: '',
      cycleEndTime: '',
      expiredTime: '',
    })
  }
  // ⚠️ `expiredTotal` = 0：上游**不下发**失效额度（既无 frozen 字段、也不回已失效桶），
  //    如实为 0 并在此注明「**不是**算出来的 0」（口径同 `src/astudio-credits.ts:166-167`）。
  return { total, packages, expiredTotal: 0 }
}

/**
 * `input_points` 的「**已知**」判据 —— 倍率与免费标记**共用这一处**（不写第二份）。
 *
 * ⚠️ 入参是 `unknown`，强转有洞：`Number([]) === 0`、`Number(true) === 1`、
 * `Number(null) === 0` ⇒ 原本会把 `[]` 判成「0 积分 = 免费」、把 `true` 判成
 * 0.0005 倍率。故只放行 **`number`** 与 **非空数字字符串**，其余一律「未知」。
 */
function magicrewPointsOf(entry: { input_points?: unknown }): number | undefined {
  const raw = entry.input_points
  if (typeof raw === 'number') return Number.isFinite(raw) ? raw : undefined
  if (typeof raw !== 'string') return undefined
  const trimmed = raw.trim()
  if (trimmed === '') return undefined
  const points = Number(trimmed)
  return Number.isFinite(points) ? points : undefined
}

/** 从计费条目算倍率；缺价格返回 `undefined`（**不猜**）。 */
export function magicrewRateOf(entry: { input_points?: unknown }): number | undefined {
  const points = magicrewPointsOf(entry)
  return points === undefined ? undefined : points / MAGICREW_RATE_BASE
}

/**
 * 该模型是否**免费**：厂商**已知**声明 `input_points === 0`。
 *
 * ⚠️ 不得用 `magicrewRateOf(entry) === 0` 反推：那是「值恰好为 0」，而这里要的是
 * 「**已知且**为 0」。一旦哪天有人把「未知」压成 0（或上游补了个 0 占位），
 * `rate === 0` 就会把**没有价格的模型全判成免费**。故判据与倍率共用
 * {@link magicrewPointsOf}（同一套「已知」），先判已知、再判值。
 */
export function magicrewIsFree(entry: { input_points?: unknown }): boolean {
  return magicrewPointsOf(entry) === 0
}

/**
 * 拉每个模型的计费（用于「免费 / 倍率」标记）。失败返回空对象（不挡列表）。
 *
 * ## ⚠️ 以下形状**未取证**
 *
 * `POST { model_ids: [...] }` 在本仓**只此一处**，没有任何材料取证过这个请求体
 * 与它换回的响应；设计规格 §1.7 的**唯一实发报文是单对象**：
 *
 * ```json
 * { "model_id": "deepseek-v4.1-flash", "billing_type": "TextTokens",
 *   "input_points": 200, "output_points": 800 }
 * ```
 *
 * ⇒ 故这里同时兼容**对象与数组**两种（数组 = 既有假设，对象 = §1.7 实测形状）。
 * 若上游确认为其一，请收紧并补真机取证。
 */
export async function fetchMagicrewModelPoints(params: {
  jwt: string
  organizationCode: string
  modelIds: readonly string[]
  product?: MagicrewProduct
  fetchImpl?: typeof fetch
}): Promise<Record<string, { inputPoints?: number, outputPoints?: number }>> {
  const product = params.product ?? MAGICREW
  const fetchImpl = params.fetchImpl ?? fetch
  const response = await fetchImpl(`${product.host}${MAGICREW_MODEL_POINTS_PATH}`, {
    // ⚠️ 超时（I5）：同上一处。
    signal: AbortSignal.timeout(product.requestTimeoutMs),
    method: 'POST',
    headers: headersOf({ jwt: params.jwt, organizationCode: params.organizationCode, product }),
    body: JSON.stringify({ model_ids: [...params.modelIds] }),
  })
  const text = await response.text()
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return {}
  }
  // ⚠️ 同 `fetchMagicrewBalance`：`JSON.parse('null') === null` ⇒ 直接读 `.code`
  //    会抛 `TypeError`。本函数的失败语义是「返回空对象（不挡列表）」，故这里 `{}`。
  if (typeof parsed !== 'object' || parsed === null) return {}
  const envelope = parsed as { code?: unknown, data?: unknown }
  if (typeof envelope.code === 'number' && envelope.code !== 1000) return {}
  // ⚠️ 两种形状都认（见函数注释）：数组照遍历；**单个对象**当「一个元素的数组」。
  const rows: unknown[] = Array.isArray(envelope.data)
    ? envelope.data
    : typeof envelope.data === 'object' && envelope.data !== null
      ? [envelope.data]
      : []
  // ⚠️ 先按 `model_id` 分组、再**每组选一行**：`billing_type === 'TextTokens'` 优先，
  //    没有 `TextTokens` 就保留**首行**。
  //    不能 last-wins：同一模型可能同时下发 `TextTokens` 与图片类（如 `ImageCount`）
  //    两行 ⇒ last-wins 会按响应顺序拿到**错的那一行**（倍率与 free 跟着错）。
  const chosen = new Map<string, Record<string, unknown>>()
  for (const raw of rows) {
    if (typeof raw !== 'object' || raw === null) continue
    const row = raw as Record<string, unknown>
    const id = typeof row.model_id === 'string' ? row.model_id : ''
    if (id.length === 0) continue
    const previous = chosen.get(id)
    if (previous === undefined) {
      chosen.set(id, row)
      continue
    }
    // 只在「新行是 TextTokens 而旧行不是」时覆盖；其余（首发即 TextTokens、
    // 两行都不是 TextTokens）一律保留首行 ⇒ 不随响应顺序乱跳。
    if (row.billing_type === 'TextTokens' && previous.billing_type !== 'TextTokens') {
      chosen.set(id, row)
    }
  }
  const out: Record<string, { inputPoints?: number, outputPoints?: number }> = {}
  for (const [id, row] of chosen) {
    out[id] = {
      ...(typeof row.input_points === 'number' ? { inputPoints: row.input_points } : {}),
      ...(typeof row.output_points === 'number' ? { outputPoints: row.output_points } : {}),
    }
  }
  return out
}

/**
 * 聚合折算原语：该账号的积分**最早作废时刻**。
 *
 * ## ⚠️⚠️ 必须**自己取数**（`src/provider-runtime.ts:218-231` 的契约）
 *
 * `cachedBalance` 只是**共享读数入口**（`src/balance-cache.ts`），不是唯一来源：
 * 它缺席、返回 `null`（查询失败）、或返回 `undefined`（本次没有共享读数）时，
 * **必须回落到自己发请求**（{@link fetchMagicrewBalance}）。
 *
 * 折算的可用性**不得**依赖那份缓存 —— 否则「未接线」会变成「该渠道折算恒
 * {@link UNUSABLE}」⇒ 该渠道在聚合候选表里**静默消失**（本仓库复发过三次的形态）。
 *
 * - 有余额 + 有到期批次 ⇒ 最早那个批次的时刻（`rankCandidates` 据此排先后）
 * - 有余额但无到期批次 ⇒ {@link NEVER}（**长期积分**：排最后但**不剔除**）
 * - 余额为 0 / 取数失败（`fetchMagicrewBalance` 返回 `undefined`） ⇒ {@link UNUSABLE}（**剔除**）
 *
 * ⚠️ 「有余额但无到期时间」必须是 `NEVER` 而**不是** `UNUSABLE`：
 * 后者会把一个真能用的渠道从聚合轮换里剔掉。
 * ⚠️ 反之「余额为 0」必须 `UNUSABLE`：否则余额耗尽的账号仍会被选中、请求随即失败。
 */
// ───────────────────── 每日登录积分（签到）─────────────────────

/**
 * `POST {host}/api/v1/login-gift` 的响应 `data`（**实测 2026-10-30，三个真实账号**）。
 *
 * ```json
 * // ① 首领（本仓未取证到 granted:true 的报文，见下）
 * { "granted": true/false, "point_amount": 200, "expire_type": 1, "message": "..." }
 * // ② 今天已领（账号 36F3213A / 5C4C7E3A 实测）
 * { "granted": false, "point_amount": 0, "expire_type": 1, "message": "今日已领取登录积分" }
 * // ③ 不具备活动资格（账号 3615D785 实测）
 * { "granted": false, "point_amount": 0, "expire_type": 1, "message": "当前账号暂不符合活动参与条件" }
 * ```
 *
 * ## ⚠️ 成功判据是 `data.granted`，**不是** HTTP 状态、也不是 `code`
 *
 * 三种情形全是 **HTTP 200 + `code:1000`(ok)**。「今天已领」与「没资格」在
 * 协议层都是**成功的请求**，只是没发分。拿 `res.ok` 或 `code===1000` 当
 * 「领到了」会每天给出一条假的「+200 分」日志与面板提示。
 *
 * ## ⚠️ `expire_type: 1` = 当日到期（`expires_at` 实测为当天 23:59:59）
 *
 * 前端枚举 `PointsValidity = { daily:'daily', monthly:'monthly', permanent:'permanent' }`
 * 与文案 `pointsValiditys.daily = "当天有效"` 一致；每日登录奖励弹窗的说明句是
 * 「奖励的积分在今日内有效，明天登录还能领取新的积分哦！」。
 * ⇒ **签到分不会累计**，当天没领就作废，第二天重新领。
 * 这是本家与 OfficeAce（100 分/天，同样当日作废）同型、但比 Loomy 更紧迫的性质。
 *
 * ## ⚠️ 幂等性已实测：重复 POST **不报错、不重复发分**
 *
 * 同一账号连续两次 POST 得到同一个 `granted:false` + `point_amount:0`，
 * 余额零变化。故本函数**可以**放心重试 —— 不需要「先查状态再领」的预检，
 * 也就没有 OfficeAce 那种「预检与领取之间状态被改」的竞态。
 *
 * ## ⚠️ 未取证：`granted:true` 的真实报文
 *
 * 实测三个账号当天**都已领过**（其中两个余额里正好有 200/195 的临期批次，
 * 到期时刻都是当天 23:59:59），所以没能观测到首领那一次的响应体。
 * ⇒ 解析按「`granted === true` 且 `point_amount` 是正数」双条件（见
 * {@link parseMagicrewClaim}），**任一不满足就当作没领到**，绝不用
 * 「HTTP 200 就算加 200 分」兜底。
 */
export interface MagicrewClaimResult {
  /** 本次**真的**发分了（`data.granted === true` 且 `point_amount` 为正）。 */
  readonly kind: 'claimed' | 'already-claimed' | 'ineligible' | 'failed'
  /** 本次新领到的积分（仅 `kind==='claimed'` 时 > 0）。 */
  readonly points: number
  /** 上游原文（`failed` 时是错误描述），供面板/日志显示真实原因。 */
  readonly message?: string
}

/** 把 `/api/v1/login-gift` 的响应体解析成 {@link MagicrewClaimResult}。 */
export function parseMagicrewClaim(body: unknown): MagicrewClaimResult {
  if (typeof body !== 'object' || body === null) {
    return { kind: 'failed', points: 0, message: '响应不是 JSON 对象' }
  }
  const envelope = body as { code?: unknown, message?: unknown, data?: unknown }
  // 业务码非 1000 ⇒ 上游明确报错（未登录 / token 无效等）。
  if (typeof envelope.code === 'number' && envelope.code !== 1000) {
    const label = typeof envelope.message === 'string' ? envelope.message : ''
    return { kind: 'failed', points: 0, message: label.length > 0 ? label : `上游业务码 ${envelope.code}` }
  }
  const data = typeof envelope.data === 'object' && envelope.data !== null
    ? envelope.data as { granted?: unknown, point_amount?: unknown, message?: unknown }
    : undefined
  if (data === undefined) {
    return { kind: 'failed', points: 0, message: '响应缺少 data' }
  }
  const label = typeof data.message === 'string' && data.message.length > 0 ? data.message : undefined
  const amount = typeof data.point_amount === 'number' && Number.isFinite(data.point_amount)
    ? data.point_amount
    : 0
  // ⚠️ 双条件：只有 granted 为 true **且**真的有分才算领到。
  //    单看 granted 会被「以后上游改成先置 granted 再异步发分」骗到；
  //    单看 amount>0 则在 granted:false 的异常报文里凭空加分。
  if (data.granted === true && amount > 0) {
    return { kind: 'claimed', points: amount, ...(label === undefined ? {} : { message: label }) }
  }
  // 没发分：区分「今天已领」与「没资格」——两者的处理完全不同。
  // 「已领」当天不必再试；「没资格」重试也没用，但可能日后开通活动，
  // 故两者都**记录当日已决**，只在文案上区分（见 maybeClaimMagicrewDaily）。
  const text = label ?? ''
  if (text.includes('已领取') || text.includes('已签到')) {
    return { kind: 'already-claimed', points: 0, message: text }
  }
  if (text.includes('不符合') || text.includes('无资格') || text.includes('暂未开通')) {
    return { kind: 'ineligible', points: 0, message: text }
  }
  // 兜底：`granted:false` 但文案不认识 ⇒ 当作已领（**不发分就是不发分**），
  // 但保留原文让人能看出上游换了措辞。
  return { kind: 'already-claimed', points: 0, message: text.length > 0 ? text : '未发分（上游未说明原因）' }
}

/**
 * 领取当日登录积分（`POST {host}/api/v1/login-gift`，**无请求体**）。
 *
 * ## 实测要点（2026-10-30）
 *
 * - `GET` 同一路径回 **405 `Allow: POST`** ⇒ 端点存在且只认 POST。
 * - POST 的 body 必须是**空**：前端调用是 `e.post('/api/v1/login-gift', void 0, ...)`。
 *   传 `{}` 与不传在实测中都是 200，但按前端逐字形态发 `undefined` body 最稳。
 * - 需要 `authorization` + `organization-code` 两个头（缺后者在部分组织下 500）。
 *
 * ## 失败语义
 *
 * 网络/解析失败 ⇒ `kind:'failed'`（**不抛错**）：一个账号的抖动不该让定时任务
 * 的整轮 sweep 中断，也不该让面板的「补领」按钮变成一片红。
 */
export async function claimMagicrewDailyCheckin(params: {
  jwt: string
  organizationCode: string
  product?: MagicrewProduct
  fetchImpl?: typeof fetch
}): Promise<MagicrewClaimResult> {
  const product = params.product ?? MAGICREW
  const fetchImpl = params.fetchImpl ?? fetch
  let response: Response
  try {
    response = await fetchImpl(`${product.host}${MAGICREW_LOGIN_GIFT_PATH}`, {
      // ⚠️ 同 `fetchMagicrewBalance`：必须带超时，否则积分路径会挂到 undici 默认 ~300s。
      signal: AbortSignal.timeout(product.requestTimeoutMs),
      method: 'POST',
      headers: headersOf({ jwt: params.jwt, organizationCode: params.organizationCode, product }),
    })
  } catch (error) {
    return { kind: 'failed', points: 0, message: error instanceof Error ? error.message : String(error) }
  }
  const text = await response.text().catch(() => '')
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    // ⚠️ 非 JSON 时带上 HTTP 状态：405/404 说明路径变了，401 说明凭据失效 ——
    //    这两种都不该被当成「今天已领」而静默跳过。
    return { kind: 'failed', points: 0, message: `HTTP ${response.status}：响应不是 JSON` }
  }
  const result = parseMagicrewClaim(parsed)
  if (result.kind === 'failed' && !response.ok) {
    return { ...result, message: `HTTP ${response.status}：${result.message ?? ''}`.trim() }
  }
  return result
}

/**
 * 「今天领过就别再领」的去重表（按凭据 ref，进程内 Map、不落盘）。
 *
 * ⚠️ 语义与 `officeace-credits.ts` 的同名表**逐条一致**（那边踩过的坑这里不重踩）：
 * - **按 ref 而非全局**：多账号各自要领，共用一把锁会让第二个账号永远领不到。
 * - **有结论才记日期**：`claimed` / `already-claimed` / `ineligible` 三种都算
 *   「今天已有结论」；`failed` **不记**，只记尝试时刻用于短冷却 —— 早期实现
 *   「先标记再请求」曾把一次网络抖动记成「已领」，该账号整天不再重试。
 * - **按 UTC+8 自然日**：额度当日 23:59:59 作废，同日重复领取毫无收益。
 *
 * ⚠️ 上游对重复领取幂等（实测），故这张表只是**省一次请求**，不是正确性依赖。
 */
interface MagicrewClaimState {
  /** 已有结论（领到 / 今天已领 / 无资格）的 UTC+8 日期键。失败时不写。 */
  settledDay?: string
  /** 最近一次尝试的时刻（毫秒，含失败）。 */
  lastAttemptAt: number
  /** 最近一次结论（面板「今天是什么状态」用）。 */
  lastKind?: MagicrewClaimResult['kind']
}

const MAGICREW_CLAIM_STATE = new Map<string, MagicrewClaimState>()

/** 失败后的重试冷却（与 OfficeAce 同值：定时任务与面板会同时打这一枪）。 */
const MAGICREW_CLAIM_RETRY_COOLDOWN_MS = 10 * 60 * 1000

/** UTC+8 自然日键（`YYYY-MM-DD`）。**不取本机时区** —— 上游按 UTC+8 结算。 */
export function magicrewDayKey(now: Date = new Date()): string {
  return new Date(now.getTime() + BEIJING_OFFSET_MS).toISOString().slice(0, 10)
}

/**
 * 带闸门的领取：今天已有结论则不重复打上游。
 *
 * @returns `undefined` 表示被闸门挡下（**没有**发出请求）；否则是上游的真实结论。
 */
export async function maybeClaimMagicrewDaily(params: {
  jwt: string
  organizationCode: string
  ref: string
  product?: MagicrewProduct
  fetchImpl?: typeof fetch
  now?: () => number
  /** 手动补领：跳过去重闸门（用户点按钮就是「现在就试一次」）。 */
  force?: boolean
}): Promise<MagicrewClaimResult | undefined> {
  const at = (params.now ?? Date.now)()
  const dayKey = magicrewDayKey(new Date(at))
  const state = MAGICREW_CLAIM_STATE.get(params.ref)
  if (params.force !== true && state !== undefined) {
    if (state.settledDay === dayKey) return undefined
    if (at - state.lastAttemptAt < MAGICREW_CLAIM_RETRY_COOLDOWN_MS) return undefined
  }
  MAGICREW_CLAIM_STATE.set(params.ref, { ...state, lastAttemptAt: at })
  const result = await claimMagicrewDailyCheckin({
    jwt: params.jwt,
    organizationCode: params.organizationCode,
    ...(params.product === undefined ? {} : { product: params.product }),
    ...(params.fetchImpl === undefined ? {} : { fetchImpl: params.fetchImpl }),
  })
  if (result.kind !== 'failed') {
    MAGICREW_CLAIM_STATE.set(params.ref, { settledDay: dayKey, lastAttemptAt: at, lastKind: result.kind })
  }
  return result
}

/** 测试辅助：清空领取去重表（避免跨用例串日期键）。 */
export function resetMagicrewClaimThrottle(): void {
  MAGICREW_CLAIM_STATE.clear()
}

export async function magicrewExpiry(params: {
  jwt: string
  organizationCode: string
  /**
   * 共享读数；**缺席、返回 null 或 undefined 时都必须自己发请求取**
   * （`src/provider-runtime.ts:218-231` 的契约：折算可用性不得依赖缓存）。
   */
  cachedBalance?: () => Promise<CreditBalance | null | undefined>
  product?: MagicrewProduct
  fetchImpl?: typeof fetch
  /** 判 `expiresAt > now` 用的时钟（可注入，单测不必等真时间）。 */
  now?: number
}): Promise<number> {
  const cached = await params.cachedBalance?.()
  // ⚠️ `null` 与 `undefined` 都是「没有读数」⇒ 两种都必须回落自取。
  //    （`null` = 查询失败，**不是** UNUSABLE、更不许让它变成 TypeError。）
  const balance = cached !== null && cached !== undefined
    ? cached
    : await fetchMagicrewBalance({
        jwt: params.jwt,
        organizationCode: params.organizationCode,
        ...(params.product === undefined ? {} : { product: params.product }),
        ...(params.fetchImpl === undefined ? {} : { fetchImpl: params.fetchImpl }),
      })
  if (balance === undefined) return UNUSABLE
  if (!(balance.total > 0)) return UNUSABLE
  const now = params.now ?? Date.now()
  let earliest = Number.POSITIVE_INFINITY
  for (const item of balance.packages) {
    if (item.remaining <= 0) continue
    // ⚠️ 本项目用 `expiredTime`（ISO 串），不是来源的 `deductionEndTime`（毫秒数）。
    const atMs = item.expiredTime.length > 0 ? Date.parse(item.expiredTime) : Number.NaN
    const at = Number.isFinite(atMs) ? atMs : undefined
    // ⚠️ 批次有效性按**时刻**判，不是硬编码 `active: true`：若上游过期后仍回该批次
    //（`expiredTime` 是**过去**时刻）而不判，该账号永远被判「最早作废」⇒
    //    聚合里每轮排最前。参考 `src/credits.ts:676-678`。
    if (atMs !== undefined && atMs <= now) continue
    if (atMs !== undefined && atMs < earliest) earliest = atMs
  }
  return Number.isFinite(earliest) ? earliest : NEVER
}
