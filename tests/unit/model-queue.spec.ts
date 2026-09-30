import { describe, expect, it } from 'vitest'
import {
  BILLING_BUSINESS_CODE,
  QUEUE_BUSINESS_CODE,
  QUEUE_MAX_DELAY_MS,
  isBillingBusinessCode,
  isQueueBusinessCode,
  looksLikeBillingError,
  nextUtc8DayStartMs,
  parseQueueError,
  queueDelayMs,
} from '../../src/shared/model-queue.js'

describe('业务码识别', () => {
  it('命中排队码的字符串与数字两种编码', () => {
    expect(isQueueBusinessCode(QUEUE_BUSINESS_CODE)).toBe(true)
    expect(isQueueBusinessCode(10605)).toBe(true)
    expect(isQueueBusinessCode('105')).toBe(false)
    expect(isQueueBusinessCode(undefined)).toBe(false)
  })

  it('命中额度码的字符串与数字两种编码', () => {
    expect(isBillingBusinessCode(BILLING_BUSINESS_CODE)).toBe(true)
    expect(isBillingBusinessCode(110)).toBe(true)
    expect(isBillingBusinessCode('10605')).toBe(false)
  })

  it('排队码与额度码互不命中（语义必须分开）', () => {
    // ⚠️ 排队是「暂时受阻、等待可通过」，额度是「当天耗尽、等也无用」。
    // 两者合并会让额度错误被当成排队而白等重试。
    expect(isQueueBusinessCode(BILLING_BUSINESS_CODE)).toBe(false)
    expect(isBillingBusinessCode(QUEUE_BUSINESS_CODE)).toBe(false)
  })
})

describe('looksLikeBillingError', () => {
  it('认出真实错误文案', () => {
    expect(looksLikeBillingError('Billing daily count exceeded')).toBe(true)
    expect(looksLikeBillingError('daily count exceeded')).toBe(true)
    expect(looksLikeBillingError('billing_error')).toBe(true)
  })

  it('关键词足够窄，不误伤正常正文', () => {
    // ⚠️ `balance` / `quota` 之类泛词会误伤「模型正文里恰好讨论余额」的情形。
    expect(looksLikeBillingError('你的账户余额是 100 元')).toBe(false)
    expect(looksLikeBillingError('The quota is described in the docs')).toBe(false)
  })
})

describe('nextUtc8DayStartMs（额度按 UTC+8 自然日重置）', () => {
  it('算出 UTC+8 的当日 24:00（不是本机时区）', () => {
    // 2026-09-27 12:00:00 UTC+8 = 04:00:00 UTC
    const noon = Date.UTC(2026, 8, 27, 4, 0, 0)
    const end = nextUtc8DayStartMs(noon)
    // 期望 = 2026-09-28 00:00:00 UTC+8 = 2026-09-27 16:00:00 UTC
    expect(new Date(end).toISOString()).toBe('2026-09-27T16:00:00.000Z')
    // 12:00 → 次日 00:00 恰好 12 小时
    expect(end - noon).toBe(12 * 3_600_000)
  })

  it('接近 UTC+8 日界时，剩余时间收敛到 0（不会算到后天）', () => {
    // 2026-09-27 23:59:59 UTC+8 = 15:59:59 UTC
    const nearEnd = Date.UTC(2026, 8, 27, 15, 59, 59)
    const end = nextUtc8DayStartMs(nearEnd)
    expect(new Date(end).toISOString()).toBe('2026-09-27T16:00:00.000Z')
    expect(end - nearEnd).toBe(1000)
  })

  it('刚过 UTC+8 日界时，得到的是**下一个**日界（满 24 小时）', () => {
    // 2026-09-27 00:00:00 UTC+8 = 2026-09-26 16:00:00 UTC
    const justAfter = Date.UTC(2026, 8, 26, 16, 0, 0)
    const end = nextUtc8DayStartMs(justAfter)
    expect(new Date(end).toISOString()).toBe('2026-09-27T16:00:00.000Z')
    expect(end - justAfter).toBe(24 * 3_600_000)
  })

  it('结果恒严格大于入参（标记不会「立刻失效」）', () => {
    for (const h of [0, 3, 8, 12, 16, 20, 23]) {
      const t = Date.UTC(2026, 8, 27, h, 30, 15)
      expect(nextUtc8DayStartMs(t), `h=${h}`).toBeGreaterThan(t)
    }
  })
})

describe('parseQueueError', () => {
  it('解析外层整体形态（HTTP 403 的 JSON 体）', () => {
    const body = JSON.stringify({
      code: '10605',
      message: JSON.stringify({ isQueued: true, retryAfterSeconds: 30, queueType: 'llm' }),
    })
    const info = parseQueueError(body)
    expect(info?.isQueued).toBe(true)
    expect(info?.retryAfterSeconds).toBe(30)
    expect(info?.queueType).toBe('llm')
  })

  it('解析内层消息形态（SSE 错误帧的 message，没有 code 字段）', () => {
    // ⚠️ 这是踩过的坑：若要求「必须命中 code 才算排队」，
    // 该形态会被判 undefined，导致 SSE 通道的修复静默失效。
    const inner = JSON.stringify({ isQueued: true, serviceAvailable: true, retryAfterSeconds: 2 })
    const info = parseQueueError(inner)
    expect(info).toBeDefined()
    expect(info?.retryAfterSeconds).toBe(2)
  })

  it('穿透多层嵌套（顶层 code 是 403、业务码在 message 里）', () => {
    // 实测帧形如：{code:403, message:"{\"code\":\"10605\",\"message\":\"{...}\"}"}
    const body = {
      code: 403,
      message: JSON.stringify({
        code: '10605',
        message: JSON.stringify({ isQueued: true, retryAfterSeconds: 5 }),
      }),
      type: 'model_error',
    }
    const info = parseQueueError(body)
    expect(info?.retryAfterSeconds).toBe(5)
  })

  it('瞬时排队（isQueued:false）同样识别', () => {
    // ⚠️ 不能要求 `isQueued === true`：服务端可立即处理时下发的是 false，
    // 用户报告「一次重试就能成功」正是这一形态。
    const info = parseQueueError({ isQueued: false, serviceAvailable: true, waitTime: 0, retryAfterSeconds: 2 })
    expect(info).toBeDefined()
    expect(info?.retryAfterSeconds).toBe(2)
  })

  it('网关形态（无 code，只有 message + type）也认', () => {
    const info = parseQueueError({ message: '{"isQueued":true,"retryAfterSeconds":7}', type: 'model_error' })
    expect(info?.retryAfterSeconds).toBe(7)
  })

  it('非排队错误返回 undefined', () => {
    expect(parseQueueError({ error: { message: 'bad request' } })).toBeUndefined()
    expect(parseQueueError('not json')).toBeUndefined()
    expect(parseQueueError(null)).toBeUndefined()
    expect(parseQueueError({ code: '105' })).toBeUndefined()
  })

  it('数值字段一律截断为整数', () => {
    const info = parseQueueError({ isQueued: true, retryAfterSeconds: 2.9, queueCount: 3.7 })
    expect(info?.retryAfterSeconds).toBe(2)
    expect(info?.queueCount).toBe(3)
  })
})

describe('queueDelayMs（用户定下的等待规则）', () => {
  it('优先取毫秒口径的字段', () => {
    expect(queueDelayMs({ retry_after_ms: 2000, retryAfterSeconds: 30 })).toBe(2000)
    expect(queueDelayMs({ retryAfterMs: 1500, retryAfterSeconds: 30 })).toBe(1500)
  })

  it('从秒换算', () => {
    expect(queueDelayMs({ retryAfterSeconds: 2 })).toBe(2000)
  })

  it('服务端给的时间 ≥10 秒时封顶到 10 秒', () => {
    // 用户规则：避免一次阻塞 30 秒让 UI 长期停在「运行中」。
    expect(queueDelayMs({ retryAfterSeconds: 30 })).toBe(QUEUE_MAX_DELAY_MS)
    expect(queueDelayMs({ retry_after_ms: 60_000 })).toBe(QUEUE_MAX_DELAY_MS)
  })

  it('小于 10 秒时按服务端的值', () => {
    expect(queueDelayMs({ retryAfterSeconds: 2 })).toBe(2000)
    expect(queueDelayMs({ retry_after_ms: 9999 })).toBe(9999)
  })

  it('非法值忽略而不是当 0（避免忙循环烧掉机会）', () => {
    expect(queueDelayMs({ retryAfterSeconds: -1 })).toBeUndefined()
    expect(queueDelayMs({ retry_after_ms: Number.NaN })).toBeUndefined()
    expect(queueDelayMs({ retryAfterSeconds: Number.POSITIVE_INFINITY })).toBeUndefined()
    expect(queueDelayMs({})).toBeUndefined()
    expect(queueDelayMs(undefined)).toBeUndefined()
  })

  it('0 是合法值（表示不等）', () => {
    expect(queueDelayMs({ retryAfterSeconds: 0 })).toBe(0)
  })
})
