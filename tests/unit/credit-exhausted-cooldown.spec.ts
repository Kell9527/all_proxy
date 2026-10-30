/**
 * 额度耗尽（`14018 Credits exhausted`）的判据与换号（2026-10-25 真实缺陷，Gitee IKQ6HJ）。
 *
 * ## 症状
 *
 * 用户：「面板说可以用了，一试又不行」—— 账号每小时被重新选中一次、必然再失败一次。
 *
 * ## 根因（三条叠加）
 *
 * 1. `14018` 与频率限流**共用 HTTP 429**，而 `isRateLimited` 的文案表里没有
 *    「权益/积分耗尽」⇒ 判 `false` ⇒ **整段换号逻辑被跳过**、直接抛给用户；
 * 2. 即便侥幸命中，`parseRateLimitError` 按「1 小时后」兜底 —— 而 14018 的报文
 *    里**一个时间字段都没有**；
 * 3. 真实出路是「等次日配额 / 充值」，写成 +1h 就是每小时白撞一次。
 *
 * ## 修法
 *
 * `isCreditExhausted` 单独判（码值认**三层嵌套**，因为 buddy 的真实报文是
 * `{"error":{"data":{"code":14018,…}}}`），冷却终点取 **UTC+8 当日 24:00**
 * （`creditExhaustedResetAtMs`），与 loomy / qoder / zcode / codearts 四家同口径。
 */
import { describe, expect, it, vi } from 'vitest'
import {
  CREDIT_EXHAUSTED_BUSINESS_CODE,
  creditExhaustedResetAtMs,
  isCreditExhausted,
  isRateLimited,
} from '../../src/providers/llm-adapter.js'

/** 上游实测原文（`www.workbuddy.ai`，HTTP 429，码在**第二层**）。 */
const NESTED_14018 = JSON.stringify({
  error: { data: { code: 14018, msg: 'Credits exhausted. Please visit the link below to purchase add-on packs.' } },
})

describe('isCreditExhausted：码值腿', () => {
  it('认顶层 code', () => {
    expect(isCreditExhausted(JSON.stringify({ code: 14018, msg: 'Credits exhausted.' }))).toBe(true)
  })

  it('认嵌套 error.data.code（buddy 的真实形态）', () => {
    // ⚠️ 只看顶层 `code` 会让码值腿在这家**恒不命中**、只剩英文文案腿 ——
    // 而上游一改文案就静默失效。
    expect(isCreditExhausted(NESTED_14018)).toBe(true)
  })

  it('认字符串形态的码', () => {
    expect(isCreditExhausted(JSON.stringify({ code: '14018' }))).toBe(true)
  })

  it('业务码常量是 14018（不是 6004）', () => {
    // 6004 = 频率限流，14018 = 额度耗尽。两者动作相同但**冷却终点相反**，
    // 合并成一个常量会让其中一家的终点必然错。
    expect(CREDIT_EXHAUSTED_BUSINESS_CODE).toBe(14018)
    expect(CREDIT_EXHAUSTED_BUSINESS_CODE).not.toBe(6004)
  })
})

describe('isCreditExhausted：文案腿', () => {
  it('认英文完整短语', () => {
    expect(isCreditExhausted('Credits exhausted. Please visit the link below.')).toBe(true)
    expect(isCreditExhausted('quota exhausted')).toBe(true)
  })

  it('认中文确定性组合', () => {
    expect(isCreditExhausted('积分已用尽')).toBe(true)
    expect(isCreditExhausted('额度不足')).toBe(true)
    expect(isCreditExhausted('余额耗尽')).toBe(true)
  })

  it('**不收** insufficient 这类泛词（会把上下文超长误伤）', () => {
    // 真实误伤形态：上下文超长报文里的 `the context window is insufficient`，
    // 而那是「换号无益」的另一类失败（同类误伤在 loomy / raccoon 各踩过一次）。
    expect(isCreditExhausted('the context window is insufficient for this model')).toBe(false)
    expect(isCreditExhausted('insufficient permissions')).toBe(false)
  })

  it('空串与无关文本都不命中', () => {
    expect(isCreditExhausted('')).toBe(false)
    expect(isCreditExhausted('{"code":6004,"msg":"频率限制"}')).toBe(false)
  })
})

describe('isCreditExhausted 与 isRateLimited 必须分开（否则 14018 会被跳过）', () => {
  it('14018 不被 isRateLimited 命中（这正是修前的跳过路径）', () => {
    // ⚠️ 这条是**反向**断言，锁住「为什么必须新开一个判据而不是放宽文案表」：
    // 放宽 `RATE_LIMIT_PATTERN` 会连带把 14018 的冷却写成 +1h（错误终点）。
    expect(isRateLimited(NESTED_14018)).toBe(false)
    expect(isRateLimited(JSON.stringify({ code: 14018, msg: 'Credits exhausted.' }))).toBe(false)
  })

  it('6004 频率限流仍走 isRateLimited（两条判据互不干扰）', () => {
    const body = JSON.stringify({ code: 6004, msg: '您的使用量已超出频率限制，将在 2026-09-11 18:08:17 UTC+8 重置' })
    expect(isRateLimited(body)).toBe(true)
    expect(isCreditExhausted(body)).toBe(false)
  })
})

describe('creditExhaustedResetAtMs：终点必须是 UTC+8 当日 24:00', () => {
  it('不是 +24h 滑动窗口', () => {
    // 与 loomy 的 IKL80H 事故同一条纪律：额度按 UTC+8 自然日结算，用滑动 24h
    // 会让 23:50 烧光的账号被封到**次日 23:50** —— 用户 0 点后上游明明已放行、
    // 本服务仍说「没到重置时间」，白等近一整天。
    const now = Date.UTC(2026, 9, 30, 1, 0, 0) // UTC+8 = 09:00
    const reset = creditExhaustedResetAtMs(now)
    // 当日 UTC+8 24:00 = UTC 16:00
    expect(reset).toBe(Date.UTC(2026, 9, 30, 16, 0, 0))
    // 明显小于 +24h
    expect(reset - now).toBeLessThan(24 * 3_600_000)
  })

  it('本地 23:59:59 → 解禁间隔接近 0', () => {
    // UTC+8 的 23:59:59 = UTC 15:59:59
    const now = Date.UTC(2026, 9, 30, 15, 59, 59)
    const reset = creditExhaustedResetAtMs(now)
    expect(reset - now).toBe(1_000)
  })

  it('本地 00:00:00 → 解禁间隔恰好 24 小时', () => {
    // UTC+8 的 00:00:00 = 前一日 UTC 16:00
    const now = Date.UTC(2026, 9, 30, 16, 0, 0)
    const reset = creditExhaustedResetAtMs(now)
    expect(reset - now).toBe(24 * 3_600_000)
  })

  it('不取本机时区（换台机器算出的时刻必须一样）', () => {
    // 函数内部用算术平移，不碰 `Date` 的本地时区方法。
    const now = Date.UTC(2026, 9, 30, 3, 17, 42)
    const a = creditExhaustedResetAtMs(now)
    const b = creditExhaustedResetAtMs(now)
    expect(a).toBe(b)
    expect((a - now) % 1_000).toBe(0)
  })
})