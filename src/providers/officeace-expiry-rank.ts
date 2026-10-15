/**
 * OfficeAce 账号按**积分到期时间**分档排序（2026-10-15 用户指定）。
 *
 * ## 它解决什么
 *
 * OfficeAce（华为云 ModelArts MaaS）的积分不是一个数，而是**一组带到期时间的
 * 积分包**（`/v1/subscription` 的 `skus[]` 与 `bonus_skus[]`），面板上据此分
 * 「永久 / 长期 / 临期」三桶（见 `officeace-credits.ts` 与前端
 * `plugin-src/client/credit-expiry.js`）。
 *
 * 多账号时按账号数组顺序取第一个，结果是「谁排第一就烧谁」—— 排第一的账号
 * 若只剩**永久**积分，就会先把永久的烧掉，而另一个账号里的**临期**积分到期
 * 作废。用户要的顺序恰好相反：
 *
 * | 优先级 | 档位 | 判据 |
 * |---|---|---|
 * | 1 | `expiring` | 有临期余额（距到期不足窗口天数） |
 * | 2 | `longTerm` | 无临期，有长期余额 |
 * | 3 | `permanent` | 只有永久余额（无到期时间的桶） |
 * | 4 | `unknown` | 余额查询失败（**不确定**，不是确定为 0） |
 * | 5 | `empty` | 查到了，但可用余额为 0 |
 *
 * ## 三条必须保持的性质
 *
 * 1. **档内保持传入顺序**（= 用户在 Jet Hub 拖拽的手动顺序），不重排 ——
 *    与 `getAvailableAccount` 的既有语义一致（AGENTS.md 纪律：账号数组顺序
 *    即选号优先级，不得重新引入按其它键排序的 sort）。
 * 2. **查询失败不抛错、不阻断选号**：归 `unknown` 档。全部查询失败时所有账号
 *    同档 ⇒ 稳定排序 ⇒ 退化成手动顺序，与加本模块之前的行为一致。
 * 3. **分桶口径与面板逐字同源**：同一份 `creditGroups`、同一个窗口天数、
 *    同一条「已失效/剩余 ≤ 0 的包不计入」规则。否则用户会在面板上看到
 *    「临期 2000」却被一个永久账号抢走请求。
 */

import type { OfficeAceSubscriptionSummary } from './officeace-credits.js'

/**
 * 「长期 / 临期」的分桶窗口天数。
 *
 * ⚠️ 与后端 `admin/credits-endpoint.ts` 的 `CREDIT_EXPIRY_WINDOW_DAYS`、
 * 前端 `plugin-src/client/credit-expiry.js` 的 `CREDIT_EXPIRY_WINDOW_DAYS`
 * **三者必须同值**（现在都是 15）。改一处不改其余处，症状是面板显示的口径
 * 与选号实际用的口径不一致 —— 用户看到「长期」的桶被当成「临期」优先消耗。
 */
export const OFFICEACE_EXPIRY_WINDOW_DAYS = 15

/** 账号到期档位。数字越小越优先。 */
export const OFFICEACE_EXPIRY_TIER = Object.freeze({
  /** 有临期余额（距到期不足窗口天数）—— 优先消耗它（不用就作废）。 */
  expiring: 0,
  /** 无临期，有长期余额。 */
  longTerm: 1,
  /** 只有永久余额（无到期时间的桶）。 */
  permanent: 2,
  /** 余额查询失败 —— 不知道有没有，但不是「确定为 0」。 */
  unknown: 3,
  /** 查到了，但可用余额为 0（或锁定永久积分时的 permanent-only）。 */
  empty: 4,
} as const)

export type OfficeAceExpiryTier = (typeof OFFICEACE_EXPIRY_TIER)[keyof typeof OFFICEACE_EXPIRY_TIER]

/** 参与分档的账号到期信息（字段缺失表示查询失败）。 */
export interface OfficeAceAccountExpiry {
  id: string
  /** 临期桶剩余合计；`undefined` = 查询失败。 */
  expiring?: number
  /** 长期桶剩余合计。 */
  longTerm?: number
  /** 永久桶剩余合计。 */
  permanent?: number
  /** 最早的临期到期时刻（毫秒）；无临期包时为 `null`（诊断/日志用）。 */
  earliestExpiringAt?: number | null
}

/** 分档选项。 */
export interface OfficeAceExpiryOptions {
  /** 是否允许消耗永久积分。默认 `true`（解锁）。 */
  allowPermanent?: boolean
  /** 「长期 / 临期」的分桶窗口天数，缺省 {@link OFFICEACE_EXPIRY_WINDOW_DAYS}。 */
  windowDays?: number
}

/** 一个订阅桶（`officeace-credits.ts` 归一化后的最小形状）。 */
type OfficeAceCreditGroup = OfficeAceSubscriptionSummary['creditGroups'][number]

/** 分桶结果。 */
export interface OfficeAceExpirySplit {
  expiring: number
  longTerm: number
  permanent: number
  /** 最早的临期到期时刻（毫秒）；无临期包或临期包都已过期时为 `null`。 */
  earliestExpiringAt: number | null
}

/**
 * 把归一化后的订阅桶按到期时间分成三档。
 *
 * 与前端 `splitCreditsByExpiry` 逐行同构（同一判据、同一窗口、同一条
 * 「`active !== true` / 剩余 ≤ 0 不计入」）—— 口径一致是硬要求：
 * 面板显示「临期 N」而选号不认它，用户会以为功能坏了。
 *
 * @param groups - `fetchOfficeAceCloudSubscription` 返回的 `creditGroups`。
 * @param windowDays - 「长期 / 临期」分界天数。
 * @param now - 当前时刻（测试注入）。
 */
export function splitOfficeAceCreditGroups(
  groups: readonly OfficeAceCreditGroup[] | undefined,
  windowDays: number = OFFICEACE_EXPIRY_WINDOW_DAYS,
  now: number = Date.now(),
): OfficeAceExpirySplit {
  const windowMs = Math.max(0, Number(windowDays)) * 24 * 60 * 60 * 1000
  const split: OfficeAceExpirySplit = { expiring: 0, longTerm: 0, permanent: 0, earliestExpiringAt: null }
  for (const group of groups ?? []) {
    if (!group || group.expired === true) continue
    const remaining = Number(group.remaining)
    if (!Number.isFinite(remaining) || remaining <= 0) continue
    const end = typeof group.expiresAt === 'string' && group.expiresAt.length > 0
      ? Date.parse(group.expiresAt)
      : Number.NaN
    // 无到期时间 / 不可解析 ⇒ 真·永久桶。**不能用 0 冒充**（0 会被当成已过期）。
    if (!Number.isFinite(end) || end <= 0) {
      split.permanent += remaining
    } else if (end - now < windowMs) {
      split.expiring += remaining
      if (end > now && (split.earliestExpiringAt === null || end < split.earliestExpiringAt)) {
        split.earliestExpiringAt = end
      }
    } else {
      split.longTerm += remaining
    }
  }
  return split
}

/** 把归一化为安全正数；非法值（`NaN` / 负数 / `undefined`）归 0。 */
function positiveNumber(value: unknown): number {
  const n = Number(value)
  return Number.isFinite(n) && n > 0 ? n : 0
}

/**
 * 判定单个账号的到期档位。
 *
 * ⚠️ **临期 > 长期 > 永久**：临期桶不用就作废，永久桶不会，故只要还有临期
 * 余额就一定先用它。
 *
 * ⚠️ **查询失败（`ok !== true`）归 `unknown` 而不是 `empty`**：两者都排在有
 * 余额的账号之后，但「不确定」与「确定为 0」在**锁定永久积分**时语义不同
 * （见 {@link officeaceTierUsable}）—— 锁定时不能把不确定的账号当成可用，
 * 否则一次网络抖动就绕过锁定、照样烧掉永久积分。
 */
export function officeaceExpiryTier(
  expiry: OfficeAceAccountExpiry,
  // 档位判定**不依赖** options：`allowPermanent` 改变的是「可用性」而不是
  // 「档位」（见 {@link officeaceTierUsable}）。参数保留只为与
  // `loomyBalanceTier` / `rankLoomyAccountsByBalance` 的同族签名一致。
  _options: OfficeAceExpiryOptions = {},
): OfficeAceExpiryTier {
  if (positiveNumber(expiry.expiring) > 0) return OFFICEACE_EXPIRY_TIER.expiring
  if (positiveNumber(expiry.longTerm) > 0) return OFFICEACE_EXPIRY_TIER.longTerm
  if (positiveNumber(expiry.permanent) > 0) return OFFICEACE_EXPIRY_TIER.permanent
  // 三个桶都读不到正数：`ok === true` 是「查到了、确实用光」⇒ empty；
  // 否则是「没查到」⇒ unknown。二者都排在末尾，但锁定永久积分时可用性
  // 判定不同（见 {@link officeaceTierUsable}）。
  return (expiry as { ok?: boolean }).ok === true
    ? OFFICEACE_EXPIRY_TIER.empty
    : OFFICEACE_EXPIRY_TIER.unknown
}

/**
 * 该档位是否「可用」（可承载请求）。
 *
 * - 未锁定：只有 `empty`（确定为 0）不可用；`unknown` 仍可用 —— 查询失败可能
 *   是暂时的，账号其实还有额度，排进候选让上游去报错比直接说「没有账号」
 *   更诚实（与 Loomy 的既有取舍一致）。
 * - **锁定永久积分**（`allowPermanent: false`）：只有 `expiring` / `longTerm`
 *   可用。`permanent` / `unknown` / `empty` 一律不可用 —— 用户要的是「永久
 *   积分不参与」，不确定的账号若可用，锁定就成了一次网络抖动即可绕过的装饰。
 */
export function officeaceTierUsable(
  tier: OfficeAceExpiryTier,
  options: OfficeAceExpiryOptions = {},
): boolean {
  if (options.allowPermanent === false) {
    return tier === OFFICEACE_EXPIRY_TIER.expiring || tier === OFFICEACE_EXPIRY_TIER.longTerm
  }
  return tier !== OFFICEACE_EXPIRY_TIER.empty
}

/**
 * 按到期档位排序账号（**稳定排序**：档内保持传入顺序）。
 *
 * 用「装饰 - 排序 - 解装饰」而不是直接比较档位：`Array.prototype.sort` 在 V8
 * 里虽已稳定，但显式带原始下标可让意图自明、且不受引擎实现影响。
 *
 * @param accounts - 待排序账号（顺序即手动优先级）。
 * @param options - 分档选项。
 * @returns **新数组**（不修改入参）。
 */
export function rankOfficeAceAccountsByExpiry<T extends OfficeAceAccountExpiry>(
  accounts: readonly T[],
  options: OfficeAceExpiryOptions = {},
): T[] {
  return accounts
    .map((account, index) => ({ account, index, tier: officeaceExpiryTier(account, options) }))
    .sort((a, b) => (a.tier - b.tier) || (a.index - b.index))
    .map((entry) => entry.account)
}
