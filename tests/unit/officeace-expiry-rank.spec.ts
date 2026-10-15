import { describe, expect, it } from 'vitest'
import {
  OFFICEACE_EXPIRY_TIER,
  OFFICEACE_EXPIRY_WINDOW_DAYS,
  officeaceExpiryTier,
  officeaceTierUsable,
  rankOfficeAceAccountsByExpiry,
  splitOfficeAceCreditGroups,
  type OfficeAceAccountExpiry,
} from '../../src/providers/officeace-expiry-rank.js'
import type { OfficeAceSubscriptionSummary } from '../../src/providers/officeace-credits.js'

/**
 * OfficeAce「临期 → 长期 → 永久」消耗顺序的纯函数回归测试。
 *
 * 守三件事：分桶口径与面板一致（`credit-expiry.js` 的 `splitCreditsByExpiry`
 * 同源）、档位优先级正确、**档内保持传入顺序**（用户手动顺序不被动摇）。
 */

const NOW = Date.UTC(2026, 9, 15, 12, 0, 0) // 2026-10-15 12:00 UTC
const DAY = 24 * 60 * 60 * 1000

/** 造一个订阅桶。 */
function group(
  remaining: number,
  expiresAt?: string,
  extra: Partial<OfficeAceSubscriptionSummary['creditGroups'][number]> = {},
): OfficeAceSubscriptionSummary['creditGroups'][number] {
  return {
    key: `k-${String(expiresAt ?? 'perm')}-${remaining}`,
    name: '桶',
    remaining,
    total: remaining,
    expiresAt,
    ...extra,
  }
}

describe('splitOfficeAceCreditGroups', () => {
  it('无到期时间的桶归永久', () => {
    const split = splitOfficeAceCreditGroups([group(5000)], OFFICEACE_EXPIRY_WINDOW_DAYS, NOW)
    expect(split.permanent).toBe(5000)
    expect(split.expiring).toBe(0)
    expect(split.longTerm).toBe(0)
    expect(split.earliestExpiringAt).toBeNull()
  })

  it('距到期不足窗口天数归临期，更远归长期', () => {
    const split = splitOfficeAceCreditGroups(
      [
        group(2000, new Date(NOW + 10 * 60 * 60 * 1000).toISOString()),   // 10 小时后 ⇒ 临期
        group(4000, new Date(NOW + 30 * DAY).toISOString()),              // 30 天后 ⇒ 长期
      ],
      OFFICEACE_EXPIRY_WINDOW_DAYS,
      NOW,
    )
    expect(split.expiring).toBe(2000)
    expect(split.longTerm).toBe(4000)
    expect(split.permanent).toBe(0)
    // 最早的临期到期时刻要被记下来（面板倒计时与日志都用它）
    expect(split.earliestExpiringAt).toBe(NOW + 10 * 60 * 60 * 1000)
  })

  it('已失效的桶不计入任何一档', () => {
    const split = splitOfficeAceCreditGroups(
      [group(9999, new Date(NOW - DAY).toISOString(), { expired: true })],
      OFFICEACE_EXPIRY_WINDOW_DAYS,
      NOW,
    )
    expect(split).toEqual({ expiring: 0, longTerm: 0, permanent: 0, earliestExpiringAt: null })
  })

  it('剩余 ≤ 0 的桶不计入（与前端同一条判据）', () => {
    const split = splitOfficeAceCreditGroups(
      [group(0), group(-5, new Date(NOW + DAY).toISOString())],
      OFFICEACE_EXPIRY_WINDOW_DAYS,
      NOW,
    )
    expect(split).toEqual({ expiring: 0, longTerm: 0, permanent: 0, earliestExpiringAt: null })
  })

  it('windowDays 可覆盖（放大到 60 天，30 天后的桶也归临期）', () => {
    const split = splitOfficeAceCreditGroups(
      [group(100, new Date(NOW + 30 * DAY).toISOString())],
      60,
      NOW,
    )
    expect(split.expiring).toBe(100)
    expect(split.longTerm).toBe(0)
  })

  it('windowDays=0 时有到期时间的桶全归长期（判据是 < windowMs，不是 <=）', () => {
    const split = splitOfficeAceCreditGroups(
      [group(100, new Date(NOW + 30 * DAY).toISOString())],
      0,
      NOW,
    )
    expect(split.expiring).toBe(0)
    expect(split.longTerm).toBe(100)
  })

  it('到期时刻恰好等于窗口边界归长期（判据是 < windowMs）', () => {
    const split = splitOfficeAceCreditGroups(
      [group(100, new Date(NOW + OFFICEACE_EXPIRY_WINDOW_DAYS * DAY).toISOString())],
      OFFICEACE_EXPIRY_WINDOW_DAYS,
      NOW,
    )
    expect(split.longTerm).toBe(100)
    expect(split.expiring).toBe(0)
  })
})

describe('officeaceExpiryTier', () => {
  it('有临期余额 ⇒ expiring 档', () => {
    expect(officeaceExpiryTier({ id: 'a', expiring: 1 })).toBe(OFFICEACE_EXPIRY_TIER.expiring)
  })

  it('无临期但有长期 ⇒ longTerm 档', () => {
    expect(officeaceExpiryTier({ id: 'a', expiring: 0, longTerm: 5 })).toBe(OFFICEACE_EXPIRY_TIER.longTerm)
  })

  it('只剩永久 ⇒ permanent 档', () => {
    expect(officeaceExpiryTier({ id: 'a', expiring: 0, longTerm: 0, permanent: 5 })).toBe(OFFICEACE_EXPIRY_TIER.permanent)
  })

  it('查询成功但全 0 ⇒ empty 档', () => {
    expect(officeaceExpiryTier({ id: 'a', expiring: 0, longTerm: 0, permanent: 0, ok: true } as OfficeAceAccountExpiry))
      .toBe(OFFICEACE_EXPIRY_TIER.empty)
  })

  it('查询失败 ⇒ unknown 档（不是 empty：不确定 ≠ 确定为 0）', () => {
    expect(officeaceExpiryTier({ id: 'a', ok: false } as OfficeAceAccountExpiry))
      .toBe(OFFICEACE_EXPIRY_TIER.unknown)
  })

  it('脏数据（NaN / 负数）按 0 处理', () => {
    expect(officeaceExpiryTier({ id: 'a', expiring: Number.NaN, longTerm: -1, permanent: 0, ok: true } as OfficeAceAccountExpiry))
      .toBe(OFFICEACE_EXPIRY_TIER.empty)
  })
})

describe('officeaceTierUsable', () => {
  it('未锁定时只有 empty 不可用（unknown 仍可用：查询失败可能只是暂时的）', () => {
    expect(officeaceTierUsable(OFFICEACE_EXPIRY_TIER.expiring)).toBe(true)
    expect(officeaceTierUsable(OFFICEACE_EXPIRY_TIER.longTerm)).toBe(true)
    expect(officeaceTierUsable(OFFICEACE_EXPIRY_TIER.permanent)).toBe(true)
    expect(officeaceTierUsable(OFFICEACE_EXPIRY_TIER.unknown)).toBe(true)
    expect(officeaceTierUsable(OFFICEACE_EXPIRY_TIER.empty)).toBe(false)
  })

  it('锁定永久积分时只有 expiring / longTerm 可用', () => {
    const locked = { allowPermanent: false }
    expect(officeaceTierUsable(OFFICEACE_EXPIRY_TIER.expiring, locked)).toBe(true)
    expect(officeaceTierUsable(OFFICEACE_EXPIRY_TIER.longTerm, locked)).toBe(true)
    // permanent / unknown / empty 一律不可用 —— 否则一次网络抖动就绕过锁定
    expect(officeaceTierUsable(OFFICEACE_EXPIRY_TIER.permanent, locked)).toBe(false)
    expect(officeaceTierUsable(OFFICEACE_EXPIRY_TIER.unknown, locked)).toBe(false)
    expect(officeaceTierUsable(OFFICEACE_EXPIRY_TIER.empty, locked)).toBe(false)
  })
})

describe('rankOfficeAceAccountsByExpiry', () => {
  it('临期账号排在最前，即使它在手动顺序里排最后', () => {
    const ranked = rankOfficeAceAccountsByExpiry([
      { id: 'a1', permanent: 5000 },                    // 手动第一，但只有永久
      { id: 'a2', longTerm: 4000 },                     // 手动第二，长期
      { id: 'a3', expiring: 2000 },                     // 手动第三，临期 ⇒ 应排第一
    ])
    expect(ranked.map((a) => a.id)).toEqual(['a3', 'a2', 'a1'])
  })

  it('档内保持传入顺序（不因其它键重排）', () => {
    const ranked = rankOfficeAceAccountsByExpiry([
      { id: 'a1', expiring: 100 },
      { id: 'a2', expiring: 9999 },
      { id: 'a3', expiring: 1 },
    ])
    expect(ranked.map((a) => a.id)).toEqual(['a1', 'a2', 'a3'])
  })

  it('全部查询失败时退化为手动顺序（安全降级）', () => {
    const accounts: OfficeAceAccountExpiry[] = [
      { id: 'a1', ok: false },
      { id: 'a2', ok: false },
      { id: 'a3', ok: false },
    ]
    expect(rankOfficeAceAccountsByExpiry(accounts).map((a) => a.id)).toEqual(['a1', 'a2', 'a3'])
  })

  it('查询失败排在「确定为 0」之前', () => {
    const ranked = rankOfficeAceAccountsByExpiry([
      { id: 'a1', expiring: 0, longTerm: 0, permanent: 0, ok: true },
      { id: 'a2', ok: false },
    ])
    expect(ranked.map((a) => a.id)).toEqual(['a2', 'a1'])
  })

  it('不修改入参数组', () => {
    const accounts: OfficeAceAccountExpiry[] = [
      { id: 'a1', permanent: 1 },
      { id: 'a2', expiring: 1 },
    ]
    const copy = [...accounts]
    rankOfficeAceAccountsByExpiry(accounts)
    expect(accounts).toEqual(copy)
  })

  it('锁定永久积分时 permanent-only 账号掉到 unknown/empty 之后', () => {
    const ranked = rankOfficeAceAccountsByExpiry(
      [
        { id: 'a1', permanent: 5000 },
        { id: 'a2', ok: false },
      ],
      { allowPermanent: false },
    )
    // a1 是 permanent 档（2）、a2 是 unknown 档（3）⇒ 顺序不变
    expect(ranked.map((a) => a.id)).toEqual(['a1', 'a2'])
    // 但可用性判定把 a1 判为不可用（见 officeaceTierUsable）
    expect(officeaceTierUsable(officeaceExpiryTier(ranked[0]!), { allowPermanent: false })).toBe(false)
  })
})
