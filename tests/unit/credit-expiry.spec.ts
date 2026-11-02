import { describe, expect, it } from 'vitest'
import {
  ACCIO_DAILY_BUCKET,
  CREDIT_EXPIRY_WINDOW_DAYS,
  accioResetSeconds,
  expiryBucketLabel,
  expiryCountdown,
  expirySplitParts,
  formatAccioResetCountdown,
  formatExpiryHint,
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

  it('失效包与剩余 ≤0 的包不计入任何一档（`expired` 也不出现）', () => {
    const split = splitCreditsByExpiry([
      pkg({ name: '失效', remaining: 999, active: false, expiredTime: new Date(NOW - DAY).toISOString() }),
      pkg({ name: '用尽', remaining: 0 }),
    ], CREDIT_EXPIRY_WINDOW_DAYS, NOW)
    expect(split).toEqual({
      permanent: 0, longTerm: 0, expiring: 0, earliestExpiringAt: null, earliestExpiringAmount: 0,
    })
    // ⚠️ `expired` 键必须**缺席**而不是 0：它只在真有已作废额度时出现，
    // 否则每个调用方都要为「多一个恒 0 的键」改断言，而它毫无信息量。
    expect('expired' in split).toBe(false)
  })

  it('⚠️ 已过期（active 仍为 true）落**独立 expired 桶**，不进 expiring', () => {
    // 改前这里把它算进 expiring ⇒ 面板写「临期 100」却没有倒计时，
    // 而同一个包的附注写「已过期」—— 一条数据两个说法（来源对抗审计 B1）。
    // 可达性：TRAE / Qoder 的 active 是硬编码 true，从不反映是否过期。
    const split = splitCreditsByExpiry([
      pkg({ name: '刚过期', remaining: 100, expiredTime: new Date(NOW - 3_600_000).toISOString() }),
      pkg({ name: '真临期', remaining: 50, expiredTime: new Date(NOW + DAY).toISOString() }),
    ], CREDIT_EXPIRY_WINDOW_DAYS, NOW)
    expect(split.expiring).toBe(50)
    expect(split.expired).toBe(100)
    expect(split.earliestExpiringAt).toBe(NOW + DAY)
    // 守恒：permanent + longTerm + expiring + expired === 总额
    expect(split.permanent + split.longTerm + split.expiring + split.expired).toBe(150)
  })

  it('earliestExpiringAmount 只记**最早那批**的量（不与更晚的临期批次相加）', () => {
    // 来源 2026-10-20 报障「怎么可能全都同一天到期」：临期总额与倒计时
    // 指向的不是同一批，并排显示会被读成「全部同时到期」。
    const split = splitCreditsByExpiry([
      pkg({ name: '早', remaining: 19656, expiredTime: new Date(NOW + 4 * DAY).toISOString() }),
      pkg({ name: '晚', remaining: 1200, expiredTime: new Date(NOW + 6 * DAY).toISOString() }),
    ], CREDIT_EXPIRY_WINDOW_DAYS, NOW)
    expect(split.expiring).toBe(20856)
    expect(split.earliestExpiringAmount).toBe(19656)
    expect(split.earliestExpiringAt).toBe(NOW + 4 * DAY)
  })

  it('同一时刻并列的临期批次 ⇒ 量累加（它们确实是同一批）', () => {
    const at = new Date(NOW + 2 * DAY).toISOString()
    const split = splitCreditsByExpiry([
      pkg({ name: 'a', remaining: 30, expiredTime: at }),
      pkg({ name: 'b', remaining: 70, expiredTime: at }),
    ], CREDIT_EXPIRY_WINDOW_DAYS, NOW)
    expect(split.earliestExpiringAmount).toBe(100)
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
  it('三段齐全时按 永久/长期/临期 顺序输出，倒计时是**独立字段**', () => {
    const split = splitCreditsByExpiry([
      pkg({ remaining: 500 }),
      pkg({ remaining: 4000, expiredTime: new Date(NOW + 60 * DAY).toISOString() }),
      pkg({ remaining: 2000, expiredTime: new Date(NOW + 10 * 3_600_000 + 13 * 60_000).toISOString() }),
    ], CREDIT_EXPIRY_WINDOW_DAYS, NOW)
    const parts = expirySplitParts(split, fmt, NOW)
    // ⚠️ 倒计时**不再拼进 text**（`临期 2000（10 小时 13 分钟）` 会被读成
    //    「这 2000 会在 10 小时后一起掉」）。text 只放总量，倒计时单独一格。
    expect(parts.map((p) => [p.key, p.text, p.tone])).toEqual([
      ['permanent', '永久 500', 'ok'],
      ['longTerm', '长期 4000', 'warn'],
      ['expiring', '临期 2000', 'error'],
    ])
    expect(parts[2].countdown).toBe('10 小时 13 分钟')
  })

  it('★ 临期总额里有多批不同到期时刻时，倒计时必须降级为「其中 N 于…后到期」', () => {
    // 用户给过的那张截图就是这个形态：
    //   临期 3977.97（其中 100 于 9 小时 13 分钟后到期）
    //   —— 3977.97 的总量照显（守恒），但明说只有其中 100 是那个时刻到期。
    const split = splitCreditsByExpiry([
      pkg({ name: '大包', remaining: 3877.97, expiredTime: new Date(NOW + 12 * DAY).toISOString() }),
      pkg({ name: '小包', remaining: 100, expiredTime: new Date(NOW + 9 * 3_600_000 + 13 * 60_000).toISOString() }),
    ], CREDIT_EXPIRY_WINDOW_DAYS, NOW)
    const parts = expirySplitParts(split, fmt, NOW)
    const expiring = parts.find((p) => p.key === 'expiring')
    expect(expiring.text).toBe('临期 3977.97')
    expect(expiring.countdown).toBe('其中 100 于 9 小时 13 分钟后到期')
  })

  it('倒计时那批覆盖**全部**临期时，不加「其中」（那两个字是废话）', () => {
    const split = splitCreditsByExpiry([
      pkg({ remaining: 2000, expiredTime: new Date(NOW + 3 * 3_600_000).toISOString() }),
    ], CREDIT_EXPIRY_WINDOW_DAYS, NOW)
    const expiring = expirySplitParts(split, fmt, NOW).find((p) => p.key === 'expiring')
    expect(expiring.countdown).toBe('3 小时 0 分钟')
    expect(expiring.countdown).not.toContain('其中')
  })

  it('临期批次全无到期时刻 ⇒ 不编造倒计时（不带括号）', () => {
    // 只可能来自「同一时刻并列」取不到量之类的边界；此处直接构造 split。
    const parts = expirySplitParts({
      expiring: 100, longTerm: 0, permanent: 0, earliestExpiringAt: null, earliestExpiringAmount: 0,
    }, fmt, NOW)
    expect(parts[0]).toEqual({ key: 'expiring', text: '临期 100', tone: 'error' })
    expect(parts[0].countdown).toBeUndefined()
  })

  it('★ 已过期单列一段（不混进临期），色调为 dim', () => {
    const split = splitCreditsByExpiry([
      pkg({ remaining: 100, expiredTime: new Date(NOW + DAY).toISOString() }),
      pkg({ remaining: 7, expiredTime: new Date(NOW - DAY).toISOString() }),
    ], CREDIT_EXPIRY_WINDOW_DAYS, NOW)
    const parts = expirySplitParts(split, fmt, NOW)
    expect(parts.map((p) => [p.key, p.text, p.tone])).toEqual([
      ['expiring', '临期 100', 'error'],
      ['expired', '已过期 7', 'dim'],
    ])
  })

  it('全零时返回空数组（调用方据此不渲染该行）', () => {
    expect(expirySplitParts(splitCreditsByExpiry([], CREDIT_EXPIRY_WINDOW_DAYS, NOW), fmt, NOW)).toEqual([])
  })
})

describe('credit-expiry：逐包到期附注（tooltip 每行）', () => {
  it('★ 有到期时间 ⇒ 「距到期 N 天（N 天内到期 / 还有 N 天）」', () => {
    // 用户截图里的形态：「新用户专属福利: 3877.97 / 4000 · 距到期 12 天（12 天内到期）」
    const near = pkg({ expiredTime: new Date(NOW + 12 * DAY).toISOString() })
    expect(formatExpiryHint(near, CREDIT_EXPIRY_WINDOW_DAYS, NOW)).toBe('距到期 12 天（12 天内到期）')
    const far = pkg({ expiredTime: new Date(NOW + 40 * DAY).toISOString() })
    expect(formatExpiryHint(far, CREDIT_EXPIRY_WINDOW_DAYS, NOW)).toBe('距到期 40 天（还有 40 天）')
  })

  it('没有到期时间（真·永久）⇒ 空串（不追加附注）', () => {
    expect(formatExpiryHint(pkg(), CREDIT_EXPIRY_WINDOW_DAYS, NOW)).toBe('')
  })

  it('⚠️ 已过期 ⇒ 直接回「已过期」，**不得**拼出「距到期 -3 天（已过期）」', () => {
    // 一半修好一半没修比全错更难看；`Math.ceil(-0.5) = -0` 还会变成「距到期 0 天」。
    const stale = pkg({ expiredTime: new Date(NOW - 3 * DAY).toISOString() })
    expect(formatExpiryHint(stale, CREDIT_EXPIRY_WINDOW_DAYS, NOW)).toBe('已过期')
    expect(expiryBucketLabel(stale, CREDIT_EXPIRY_WINDOW_DAYS, NOW)).toBe('已过期')
  })

  it('拿不到窗口天数时仍给「距到期 N 天」（它本身就解释了分类依据）', () => {
    const p = pkg({ expiredTime: new Date(NOW + 12 * DAY).toISOString() })
    expect(formatExpiryHint(p, undefined, NOW)).toBe('距到期 12 天')
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
