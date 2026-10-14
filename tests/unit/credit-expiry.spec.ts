import { describe, expect, it } from 'vitest'
import {
  ACCIO_DAILY_BUCKET,
  CREDIT_EXPIRY_WINDOW_DAYS,
  accioResetSeconds,
  expiryCountdown,
  expirySplitParts,
  formatAccioResetCountdown,
  formatNamedPoolLine,
  packageExpiryMs,
  splitCreditsByExpiry,
} from '../../plugin-src/client/credit-expiry.js'

/**
 * 积分包分桶纯函数的回归测试。
 *
 * 对应界面上两行用户可见的文案（2026-10-14 用户报障「本地仅显示登录状态」）：
 * - OfficeAce：`永久 500 · 长期 4000 · 临期 2000（10 小时 13 分钟）`
 * - Accio：`每日 100 · 每月 0 · 推荐 700` + `每日额度 24 小时 0 分后刷新`
 */

const NOW = 1_800_000_000_000
const DAY = 86_400_000

/** 造一个积分包（默认有效、无到期时间 = 永久）。 */
function pkg(overrides: Record<string, unknown> = {}) {
  return {
    name: '包',
    unit: 'credit',
    remaining: 100,
    total: 100,
    used: 0,
    active: true,
    cycleStartTime: '',
    cycleEndTime: '',
    expiredTime: '',
    ...overrides,
  }
}

/** 保留整数的格式化（与 jet-hub.js 的 formatCredits 对齐）。 */
const fmt = (v) => (Number.isInteger(v) ? String(v) : v.toFixed(2))

describe('credit-expiry：三档分桶', () => {
  it('无到期时间 = 永久；超窗口 = 长期；窗口内 = 临期', () => {
    const split = splitCreditsByExpiry([
      pkg({ name: '永久套餐', remaining: 500 }),
      pkg({ name: '长期套餐', remaining: 4000, expiredTime: new Date(NOW + 60 * DAY).toISOString() }),
      pkg({ name: '临期套餐', remaining: 2000, expiredTime: new Date(NOW + 10 * 3_600_000 + 13 * 60_000).toISOString() }),
    ], CREDIT_EXPIRY_WINDOW_DAYS, NOW)

    expect(split.permanent).toBe(500)
    expect(split.longTerm).toBe(4000)
    expect(split.expiring).toBe(2000)
    expect(split.earliestExpiringAt).toBe(NOW + 10 * 3_600_000 + 13 * 60_000)
  })

  it('失效包与剩余 ≤0 的包不计入任何一档', () => {
    const split = splitCreditsByExpiry([
      pkg({ name: '失效', remaining: 999, active: false, expiredTime: new Date(NOW - DAY).toISOString() }),
      pkg({ name: '用尽', remaining: 0 }),
    ], CREDIT_EXPIRY_WINDOW_DAYS, NOW)
    expect(split).toEqual({ permanent: 0, longTerm: 0, expiring: 0, earliestExpiringAt: null })
  })

  it('已过期的临期包不产生倒计时（earliestExpiringAt 只认未来时刻）', () => {
    const split = splitCreditsByExpiry([
      pkg({ name: '刚过期', remaining: 100, expiredTime: new Date(NOW - 3_600_000).toISOString() }),
    ], CREDIT_EXPIRY_WINDOW_DAYS, NOW)
    expect(split.expiring).toBe(100)
    expect(split.earliestExpiringAt).toBeNull()
  })

  it('windowDays 边界：恰好在窗口外沿归长期', () => {
    // 15 天整：`end - now < windowMs` 为假 ⇒ 长期
    const split = splitCreditsByExpiry([
      pkg({ remaining: 10, expiredTime: new Date(NOW + CREDIT_EXPIRY_WINDOW_DAYS * DAY).toISOString() }),
    ], CREDIT_EXPIRY_WINDOW_DAYS, NOW)
    expect(split.longTerm).toBe(10)
    expect(split.expiring).toBe(0)
  })
})

describe('credit-expiry：分段文案', () => {
  it('三段齐全时按 永久/长期/临期 顺序输出，临期带倒计时', () => {
    const split = splitCreditsByExpiry([
      pkg({ remaining: 500 }),
      pkg({ remaining: 4000, expiredTime: new Date(NOW + 60 * DAY).toISOString() }),
      pkg({ remaining: 2000, expiredTime: new Date(NOW + 10 * 3_600_000 + 13 * 60_000).toISOString() }),
    ], CREDIT_EXPIRY_WINDOW_DAYS, NOW)
    const parts = expirySplitParts(split, fmt, NOW)
    expect(parts.map((p) => [p.key, p.text, p.tone])).toEqual([
      ['permanent', '永久 500', 'ok'],
      ['longTerm', '长期 4000', 'warn'],
      ['expiring', '临期 2000（10 小时 13 分钟）', 'error'],
    ])
  })

  it('全零时返回空数组（调用方据此不渲染该行）', () => {
    expect(expirySplitParts(splitCreditsByExpiry([], CREDIT_EXPIRY_WINDOW_DAYS, NOW), fmt, NOW)).toEqual([])
  })
})

describe('credit-expiry：倒计时', () => {
  it('向上取整到分钟；不足一小时只显示分钟', () => {
    expect(expiryCountdown(NOW + 3_600_000, NOW)).toBe('1 小时 0 分钟')
    // 90.5 秒向上取整成 2 分钟（不是 1 分钟 —— 「还剩 1 分钟」会过早）
    expect(expiryCountdown(NOW + 90_500, NOW)).toBe('2 分钟')
  })

  it('已过期或没有临期包 ⇒ 空串', () => {
    expect(expiryCountdown(NOW - 1, NOW)).toBe('')
    expect(expiryCountdown(null, NOW)).toBe('')
  })
})

describe('credit-expiry：accio 命名池', () => {
  it('逐包按服务端顺序拼接，剩余 0 照显，包名去掉「积分」后缀', () => {
    const line = formatNamedPoolLine([
      pkg({ name: ACCIO_DAILY_BUCKET, remaining: 100 }),
      pkg({ name: '每月积分', remaining: 0 }),
      pkg({ name: '推荐积分', remaining: 700 }),
    ], fmt)
    expect(line).toBe('每日 100 · 每月 0 · 推荐 700')
  })

  it('失效包跳过；没有 active 包时返回 null', () => {
    expect(formatNamedPoolLine([pkg({ name: '每日积分', remaining: 1, active: false })], fmt)).toBeNull()
  })
})

describe('credit-expiry：accio 每日刷新倒计时', () => {
  it('daily 桶的 cycleEndTime ⇒ 秒数 ⇒ 「24 小时 0 分」', () => {
    const packages = [pkg({ name: ACCIO_DAILY_BUCKET, cycleEndTime: new Date(NOW + 86_400_000).toISOString() })]
    expect(accioResetSeconds(packages, NOW)).toBe(86_400)
    expect(formatAccioResetCountdown(86_400)).toBe('24 小时 0 分')
  })

  it('读不到倒计时 ⇒ null（调用方不渲染该行，**不写死 86400**）', () => {
    expect(accioResetSeconds([pkg({ name: ACCIO_DAILY_BUCKET, cycleEndTime: '' })], NOW)).toBeNull()
    expect(accioResetSeconds([pkg({ name: '每月积分' })], NOW)).toBeNull()
    expect(formatAccioResetCountdown(null)).toBeNull()
    expect(formatAccioResetCountdown(-1)).toBeNull()
  })

  it('不足一小时显示分钟', () => {
    expect(formatAccioResetCountdown(3_600)).toBe('1 小时 0 分')
    expect(formatAccioResetCountdown(120)).toBe('2 分钟')
  })
})

describe('credit-expiry：packageExpiryMs', () => {
  it('空串 / 不可解析 / 非正数都算「没有到期时间」（真·永久的判据）', () => {
    expect(packageExpiryMs(pkg({ expiredTime: '' }))).toBeNull()
    expect(packageExpiryMs(pkg({ expiredTime: 'not-a-date' }))).toBeNull()
    expect(packageExpiryMs(pkg({ expiredTime: new Date(0).toISOString() }))).toBeNull()
  })
})
