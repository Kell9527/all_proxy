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
import { magicrewDecimalOf, magicrewSignedDecimalOf } from './magicrew-number.js'
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

/**
 * Magicrew 业务 API 的请求头 —— **全仓唯一一份**。
 *
 * ⚠️ 导出：新人奖励（`magicrew-checkin.ts`）与积分走同一个 Go 服务、同一套
 * 网关校验。两处各写一份私有实现，形状会**几乎**一样但细节漂移
 * （来源就踩过：`magicrew-auth.ts` 与积分各有一份、UA 取值不同）。
 *
 * ⚠️ `origin` 必带：网关会看 Origin，缺了偶发 403。
 * ⚠️ `organization-code` 只在非空时附 —— 国际站缺了会被上游拒绝，所以**调用方**
 * 必须保证 `organizationCode` 真的取到了（不是这里补空串）。
 */
export function magicrewApiHeaders(params: {
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

/** 内部别名（本文件内的既有调用点不改名，减少 diff 面）。 */
const headersOf = magicrewApiHeaders

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
  /**
   * ⚠️⚠️ **必须回读校验**（来源二审实测的真缺陷）：`Date.UTC` 对越界分量是
   * **静默归一化**，不是 `NaN` —— `Date.UTC(2026, 12, 45, 25, 99, 99)` 会被算成
   * 2027-02-15，于是 `"2026-13-45 25:99:99"` 这种**明显非法的日期**被当成真实
   * 到期时刻：前端落「长期」、后端落「永久」，**没有任何告警**。
   * 本函数契约是「解析不出来返回 `undefined`，绝不编造」，所以把归一化后的六个
   * 分量读回来逐个比对；任何一个变了就说明输入越界 ⇒ `undefined`。
   * 真实上游只给合法值 ⇒ 回读恒等，无行为变化。
   */
  const back = new Date(utcMs)
  if (
    back.getUTCFullYear() !== Number(year)
    || back.getUTCMonth() !== Number(month) - 1
    || back.getUTCDate() !== Number(day)
    || back.getUTCHours() !== Number(hour)
    || back.getUTCMinutes() !== Number(minute)
    || back.getUTCSeconds() !== Number(second)
  ) return undefined
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
  /**
   * ⚠️ **`total_points` 必须容错解析，不能要求 `typeof === 'number'`**：
   * 上游把它改成字符串 `"2661"` 时，旧判据直接 `return undefined` ⇒ 面板
   * 「查询失败」、锁定态选号判 `none` ⇒ **积分与选号同时全死**，且与「凭据失效」同形。
   * ⚠️ 用 `magicrewSignedDecimalOf`（**允许负数**）而**不是** `magicrewDecimalOf`：
   * 上游实测过 `total_points: -31`（欠费），拒绝负数会让整条余额消失。
   */
  const total = magicrewSignedDecimalOf(data.total_points)
  if (total === undefined) return undefined
  const rawBatches = Array.isArray(data.expiring_quota_details) ? data.expiring_quota_details : []
  const packages: CreditPackage[] = []
  for (const raw of rawBatches) {
    if (typeof raw !== 'object' || raw === null) continue
    const batch = raw as Record<string, unknown>
    /**
     * ⚠️ **必须容错解析**：上游把 `remaining_points` 写成字符串 `"50"`
     * （最常见的类型漂移）时，旧的 `typeof === 'number'` 判据会**静默丢弃该批次**，
     * 差额由 `total − Σ批次` 的残差吸收 ⇒ **临期积分被误标成永久积分** ⇒
     * 锁定永久积分时误拒这个账号（方向恰好反了：它能用的积分被当成不能用的）。
     */
    const remaining = magicrewDecimalOf(batch.remaining_points) ?? 0
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
      //    解析不出来的时刻留空串（**不编造**）。
      expiredTime: expiresAt === undefined ? '' : new Date(expiresAt).toISOString(),
    })
  }
  /**
   * ## 守恒裁剪（上游报文自相矛盾时以 `total_points` 为权威）
   *
   * 上游可能下发「批次合计 > `total_points`」的报文（实测构造过
   * `total 100` + 批次 `200 + 50`）。`total_points` 是**权威余额** ——
   * 面板合计、`magicrewExpiry` 的 `total > 0` 判据都以它为准；
   * `expiring_quota_details` 只是「其中这部分会过期」的细分。
   *
   * ⚠️ 顺序**不能反**：必须**临期优先保留**（先到期先消耗）。反过来先保留远期，
   * 会让被裁掉的那笔变成「少显示的临期积分」—— 用户以为它还能用，而锁定态选号
   * 也会据此误判（临期没了 ⇒ 判 `exhausted`/`locked`，方向恰好反了）。
   *
   * 不裁的后果：三档合计 **大于** 账户实际余额（实测 350 vs 100），用户无法判断哪个是真的。
   *
   * ⚠️⚠️ **`total <= 0` 时不做裁剪**：上游可以回**负数** `total_points`（欠费，
   * 实测 −31）。若照 `total` 裁剪，循环首轮就 `budget <= 0` ⇒ break ⇒
   * 它的正批次被**整条丢弃**、`packages = []` ⇒ 面板只剩「积分 -31」
   * （无包、三档行不渲染），而同一份报文里其实给了可用批次。
   *
   * 语义上「欠费」与「批次额度」是两件事：`total` 是净额、批次是各项余额。
   * 报文自相矛盾时**如实两样都显示**，比把明细删掉让用户以为「什么都没有」更可诊断。
   */
  const trimBudget = Math.max(0, total)
  const rawListed = packages.reduce((sum, item) => sum + item.remaining, 0)
  if (total >= 0 && rawListed > trimBudget) {
    const byExpiry = [...packages].sort(
      (a, b) => expiryMsOf(a) - expiryMsOf(b),
    )
    packages.length = 0
    let budget = trimBudget
    for (const item of byExpiry) {
      if (budget <= 0) break
      const keep = Math.min(item.remaining, budget)
      packages.push(keep === item.remaining ? item : { ...item, remaining: keep, total: keep })
      budget -= keep
    }
  }
  /**
   * ⚠️ **合成「永久积分」包** —— 残差就是上游「不给到期时间」的那部分。
   *
   * 取证（2026-11-01 两站真实账号只读探测）：
   *
   * | 站 | `total_points` | 批次合计 | 残差 |
   * |---|---|---|---|
   * | 国内 | 2661 | 1661 | **1000** |
   * | 国际 | 347 | 247 | **100** |
   *
   * 1. `expiring_quota_details` 的真实语义是「**所有带到期时间的批次**」
   *    （里面有 2027 年的远期批次），不是「只有临期」。
   * 2. 残差在两站都是正整数且没有任何到期时刻 ⇒ 那才是**永久积分**
   *    （注册奖励 / 活动赠送 / 后台充值）。
   *
   * ## 为什么原名「长期积分」是**命名错误**（不只是措辞问题）
   *
   * 前端的判据（`plugin-src/client/credit-expiry.js` 的 `splitCreditsByExpiry`）是
   * 「**有没有到期时间**」：没有 ⇒ 落 `permanent`（绿）、超窗口 ⇒ `longTerm`（黄）、
   * 窗口内 ⇒ `expiring`（红）。⇒ 这个包**没有**到期时间，落的是 **permanent** 桶，
   * 名字却叫「长期」（longTerm）—— 名字与落桶自相矛盾，用户会去找一个并不存在的
   * 「长期」分组。
   *
   * 不合成的话：账号卡片的 hover 列包只列批次、合计对不上 `total_points`
   * ⇒ 用户以为丢了积分。合成后 `sum(remaining) === total`。
   *
   * ⚠️⚠️ **刻意不给 `expiredTime`**（两条腿都不能动）：
   * · 少了它 ⇒ `magicrewExpiry` 的「无到期时间 ⇒ 跳过」那条腿跳过，
   *   「只有永久积分」的号仍得 `NEVER`（排最后但不剔除）；
   * · **编一个远期值** ⇒ 它会落进 `longTerm`（黄）并让前端把它算进「可烧」的
   *   长期桶 —— 而锁定永久积分保护的正是它。
   */
  const listedRemaining = packages.reduce((sum, item) => sum + item.remaining, 0)
  const permanentRemaining = total - listedRemaining
  if (permanentRemaining > 0) {
    packages.push({
      name: '永久积分',
      unit: '积分',
      remaining: permanentRemaining,
      total: permanentRemaining,
      used: 0,
      active: true,
      cycleStartTime: '',
      cycleEndTime: '',
      expiredTime: '',
    })
  }
  // ⚠️ `expiredTotal` = 0：上游**不下发**失效额度（既无 frozen 字段、也不回已失效桶），
  //    如实为 0 并在此注明「**不是**算出来的 0」。
  return { total, packages, expiredTotal: 0 }
}

/**
 * 读一个包的到期时刻（毫秒），供守恒裁剪按「先到期先保留」排序。
 *
 * 无到期时间（ISO 空串/不可解析）⇒ `+Infinity`：永久积分在裁剪序里**最后**
 * 被保留 —— 与「临期优先消耗」一致。
 */
function expiryMsOf(pkg: CreditPackage): number {
  const raw = pkg.expiredTime
  if (typeof raw !== 'string' || raw.length === 0) return Number.POSITIVE_INFINITY
  const parsed = Date.parse(raw)
  return Number.isFinite(parsed) ? parsed : Number.POSITIVE_INFINITY
}

/**
 * `input_points` 的「**已知**」判据 —— 倍率与免费标记**共用这一处**（不写第二份）。
 *
 * ⚠️ 入参是 `unknown`，强转有洞：`Number([]) === 0`、`Number(true) === 1`、
 * `Number(null) === 0` ⇒ 原本会把 `[]` 判成「0 积分 = 免费」、把 `true` 判成
 * 0.0005 倍率。故只放行 **`number`** 与 **十进制数字字符串**，其余一律「未知」。
 *
 * ⚠️⚠️ **判据已抽到 `magicrew-number.ts`**：本文件此前自带一份同名实现、
 * **没有**「只认十进制」的约束，于是 `input_points: "0x10"` 在这里被当成 **16**
 * （倍率 0.008），而签到侧的同名字段被当成 **0** —— 同一个上游字段在两个模块
 * 解释不同。现在统一走 `magicrewDecimalOf`（契约同为 `number | undefined`，
 * 且**拒绝负数**：负单价会让倍率变成负值直接显示在模型列表上）。
 */
function magicrewPointsOf(entry: { input_points?: unknown }): number | undefined {
  return magicrewDecimalOf(entry.input_points)
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
  /**
   * ⚠️⚠️ **`granted` 必须是布尔值**，否则判失败而不是「已领取」。
   *
   * 只判 `granted === true` 时，一个 `200 + {}`（或任何缺 `granted` 的畸形响应）
   * 会落进下面「没发分」那条腿 ⇒ 返回 `already-claimed`「今日已领取登录积分」
   * ⇒ **用户以为今天领过了，实际什么都没发生**（静默漏领，零报错）。
   *
   * 正常响应（两站实测）是 `{"code":1000,"data":{"granted":true|false,…}}` ——
   * `granted` **恒存在且是布尔**。缺它 = 上游形态已变 ⇒ 报失败让用户看见。
   */
  if (typeof data.granted !== 'boolean') {
    return { kind: 'failed', points: 0, message: '响应里没有 granted 字段（上游形态可能已变）' }
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
  /**
   * ⚠️ **国际站缺 org 要在本地就拦下**（与 `magicrew-checkin.ts` 的
   * `magicrewRequest` 同一条判据）。
   *
   * 业务 API（`/api/v1/*`，本函数打的这个）缺 `organization-code` 时实测回
   * `{"code":2182,"message":"用户所在组织不存在"}` —— 官方文案会被用户读成
   * 「我的组织被删了」，而真实原因是「这个账号没选过组织」。
   * 本地前置校验把它变成一条**可操作**的文案（去网页端选组织 → 重新登录）。
   *
   * ⚠️ 只对 `needsOrgOnGateway` 的站生效：国内站不强制（缺了仍 200），
   *    在这里拦会让本来能用的国内账号也失败（回归）。
   */
  if (product.needsOrgOnGateway && params.organizationCode.length === 0) {
    return {
      kind: 'failed',
      points: 0,
      message: `${product.displayName}缺少组织码（organizationCode）—— 请在网页端选中一个组织后重新登录；`
        + '该站的业务 API 会回「用户所在组织不存在」',
    }
  }
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
// ⚠️ 键是**凭据 ref**，而 ref 前缀按站区分（`MAGICREW_ACCOUNT_*` /
//    `MAGICREWINTL_ACCOUNT_*`）⇒ 两站的去重天然隔离，不需要再拼 product.id。
//    若将来引入「共享凭据文件」让两站共用同一个 ref，**必须**在这把键里补站标识
//    —— 否则国内站领完会把国际站当天也记成「已领」（静默漏领 50 分）。

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
  /**
   * 是否存在**任何可用**批次（含「有额度但无到期时刻」= 永久）。
   *
   * ⚠️ 没有它的话，「只剩已作废批次」会走到 `return NEVER`（长期）——
   * 而那是「有额度」的意思 ⇒ 该账号被排进候选、每轮先失败一次。
   */
  let hasUsable = false
  /** 是否**存在任何**（`remaining > 0` 的）批次 —— 用于区分「无批次」与「批次全作废」。 */
  let sawBatch = false
  for (const item of balance.packages) {
    if (item.remaining <= 0) continue
    sawBatch = true
    /**
     * ⚠️ 本项目用 `expiredTime`（ISO 串），不是来源的 `deductionEndTime`（毫秒数）。
     *
     * ⚠️⚠️ **这里曾有一个真缺陷**：原写法
     * `const atMs = item.expiredTime.length > 0 ? Date.parse(...) : Number.NaN`
     * 后接 `if (atMs !== undefined && atMs <= now)` —— `Number.NaN` **不是**
     * `undefined`，故那条守卫**恒为真**、`NaN <= now` 也恒为 false ⇒
     * 「无到期时间」的永久积分包会被当成「有到期时间」，虽然结果侥幸相同，
     * 但 `atMs < earliest` 也恒 false ⇒ **它拿不到 `earliest`**，
     * 「只有永久积分」的号因此走不到 `NEVER` 分支的注释意图。
     * ⇒ 现在显式区分 `undefined`（无到期时刻）与有限正数。
     *
     * ⚠️ 判据与前端 `credit-expiry.js` 的 `packageExpiryMs` **同一份**：
     * 读 ISO 串、不可解析即 `null`（= 永久）。
     */
    const parsed = item.expiredTime.length > 0 ? Date.parse(item.expiredTime) : Number.NaN
    const atMs = Number.isFinite(parsed) && parsed > 0 ? parsed : undefined
    // ⚠️ 批次有效性按**时刻**判，不是硬编码 `active: true`：若上游过期后仍回该批次
    //（`expiredTime` 是**过去**时刻）而不判，该账号永远被判「最早作废」⇒
    //    聚合里每轮排最前。参考 `src/credits.ts:676-678`。
    // 已作废 ⇒ 扣不到，既不算可用、也不参与排序。
    if (atMs !== undefined && atMs <= now) continue
    hasUsable = true
    if (atMs !== undefined && atMs < earliest) earliest = atMs
  }
  // ⚠️ 两种「不可用」要分开：
  // ① **一个批次都没给**（`packages: []`）但 `total > 0`：上游只说有余额、不说批次
  //    ⇒ 如实当「永久」（排最后但不剔除）—— 这是既有语义，别改成 UNUSABLE。
  // ② **有批次但全作废**：那些额度扣不到 ⇒ `UNUSABLE`（钱已经没了）。
  if (!sawBatch) return NEVER
  if (!hasUsable) return UNUSABLE
  return Number.isFinite(earliest) ? earliest : NEVER
}
