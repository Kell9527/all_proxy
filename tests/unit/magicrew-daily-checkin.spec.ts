import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  claimMagicrewDailyCheckin,
  magicrewDayKey,
  maybeClaimMagicrewDaily,
  parseMagicrewClaim,
  resetMagicrewClaimThrottle,
} from '../../src/providers/magicrew-credits.js'
import { MAGICREW_LOGIN_GIFT_PATH } from '../../src/providers/magicrew-product.js'

/**
 * Magicrew（超级麦吉）每日登录积分（签到）的回归。
 *
 * ## 这些用例锁的是「真机实测出来的三件事」（2026-10-30，三个真实账号）
 *
 * 1. **成功判据是 `data.granted`，不是 HTTP 状态、也不是 `code`**
 *    三种情形全是 `HTTP 200 + code:1000(ok)`：
 *    - 领到：`{granted:true, point_amount:200}`
 *    - 今天已领：`{granted:false, point_amount:0, message:"今日已领取登录积分"}`
 *    - 没资格：`{granted:false, point_amount:0, message:"当前账号暂不符合活动参与条件"}`
 *    拿 `res.ok` 当成功 ⇒ 每天给出一条假的「+200 分」。
 *
 * 2. **当天到期、不累计**（`expire_type:1`，前端文案「奖励的积分在今日内有效」）
 *    ⇒ 必须每天领，且去重按 **UTC+8 自然日**（不取本机时区）。
 *
 * 3. **上游幂等**：重复 POST 不报错、不重复发分 ⇒ 不需要预检状态。
 *
 * ## ⚠️ 未取证：`granted:true` 的真实报文
 *
 * 实测三个账号当天都已领过，故首领那一次的形状是按「字段语义 + 前端调用形态」
 * 推断的。`parseMagicrewClaim` 因此要求 **`granted===true` 且 `point_amount>0`**
 * 双条件 —— 任一不满足都当没领到。下面「双条件」那组用例就是为这条守的。
 */

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

const CREDENTIAL = { jwt: 'jwt-value', organizationCode: 'org-code' }

beforeEach(() => {
  resetMagicrewClaimThrottle()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('parseMagicrewClaim：成功判据必须是 granted', () => {
  it('granted:true 且 point_amount 为正 ⇒ claimed', () => {
    const result = parseMagicrewClaim({ code: 1000, message: 'ok', data: { granted: true, point_amount: 200, expire_type: 1 } })
    expect(result.kind).toBe('claimed')
    expect(result.points).toBe(200)
  })

  it('「今日已领取登录积分」（实测原文）⇒ already-claimed，且 points 为 0', () => {
    const result = parseMagicrewClaim({
      code: 1000, message: 'ok',
      data: { granted: false, point_amount: 0, expire_type: 1, message: '今日已领取登录积分' },
    })
    expect(result.kind).toBe('already-claimed')
    expect(result.points).toBe(0)
  })

  it('「当前账号暂不符合活动参与条件」（实测原文）⇒ ineligible，与「已领」分开', () => {
    // ⚠️ 混进 already-claimed 会让用户以为领到了 200 分；混进 failed 会让定时任务
    //    每小时打一次必然同样结果的上游。必须是独立状态。
    const result = parseMagicrewClaim({
      code: 1000, message: 'ok',
      data: { granted: false, point_amount: 0, expire_type: 1, message: '当前账号暂不符合活动参与条件' },
    })
    expect(result.kind).toBe('ineligible')
    expect(result.points).toBe(0)
  })

  it('HTTP 200 + granted:false 但给了一个正数 point_amount ⇒ 仍然不算领到', () => {
    // 双条件的另一半：只认 granted。
    const result = parseMagicrewClaim({ code: 1000, data: { granted: false, point_amount: 200 } })
    expect(result.kind).not.toBe('claimed')
    expect(result.points).toBe(0)
  })

  it('granted:true 但 point_amount 为 0 ⇒ 不算领到（不虚报积分）', () => {
    const result = parseMagicrewClaim({ code: 1000, data: { granted: true, point_amount: 0 } })
    expect(result.kind).not.toBe('claimed')
    expect(result.points).toBe(0)
  })

  it('业务码非 1000 ⇒ failed（token 无效等真错误不该被当成「已领」）', () => {
    const result = parseMagicrewClaim({ code: 403, message: 'token无效' })
    expect(result.kind).toBe('failed')
    expect(result.message).toContain('token无效')
  })

  it('信封是 null ⇒ failed（`JSON.parse("null")` 不得抛 TypeError）', () => {
    expect(parseMagicrewClaim(null).kind).toBe('failed')
  })

  it('缺少 data ⇒ failed', () => {
    expect(parseMagicrewClaim({ code: 1000, message: 'ok' }).kind).toBe('failed')
  })
})

describe('claimMagicrewDailyCheckin：请求形态', () => {
  it('POST 到 /api/v1/login-gift，且带 JWT + organization-code 两个头', async () => {
    const calls: Array<{ url: string, init: RequestInit }> = []
    const fetcher = (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init: init ?? {} })
      return jsonResponse({ code: 1000, data: { granted: false, point_amount: 0, message: '今日已领取登录积分' } })
    }) as unknown as typeof fetch

    await claimMagicrewDailyCheckin({ ...CREDENTIAL, fetchImpl: fetcher })

    expect(calls).toHaveLength(1)
    expect(calls[0].url).toContain(MAGICREW_LOGIN_GIFT_PATH)
    expect(calls[0].init.method).toBe('POST')
    const headers = calls[0].init.headers as Record<string, string>
    expect(headers.authorization).toBe('Bearer jwt-value')
    expect(headers['organization-code']).toBe('org-code')
    // ⚠️ 前端调用是 `e.post('/api/v1/login-gift', void 0, …)` ⇒ 必须是空 body。
    expect(calls[0].init.body).toBeUndefined()
    // 必须带超时，否则会挂到 undici 默认 ~300s。
    expect(calls[0].init.signal).toBeInstanceOf(AbortSignal)
  })

  it('网络异常 ⇒ failed，不抛错（一个账号抖动不该中断整轮 sweep）', async () => {
    const fetcher = (async () => { throw new Error('ECONNRESET') }) as unknown as typeof fetch
    const result = await claimMagicrewDailyCheckin({ ...CREDENTIAL, fetchImpl: fetcher })
    expect(result.kind).toBe('failed')
    expect(result.message).toContain('ECONNRESET')
  })

  it('非 JSON 响应 ⇒ failed，且带 HTTP 状态（405/404 说明路径变了，不能当成已领）', async () => {
    const fetcher = (async () => new Response('Not Found', { status: 404 })) as unknown as typeof fetch
    const result = await claimMagicrewDailyCheckin({ ...CREDENTIAL, fetchImpl: fetcher })
    expect(result.kind).toBe('failed')
    expect(result.message).toContain('404')
  })
})

describe('去重闸门：按 UTC+8 自然日，且失败不记日期', () => {
  it('同一天第二次被闸门挡下（返回 undefined，不打上游）', async () => {
    let hits = 0
    const fetcher = (async () => {
      hits += 1
      return jsonResponse({ code: 1000, data: { granted: true, point_amount: 200 } })
    }) as unknown as typeof fetch
    const now = () => Date.UTC(2026, 9, 30, 2, 0, 0) // UTC+8 = 2026-10-30 10:00

    const first = await maybeClaimMagicrewDaily({ ...CREDENTIAL, ref: 'REF_A', fetchImpl: fetcher, now })
    const second = await maybeClaimMagicrewDaily({ ...CREDENTIAL, ref: 'REF_A', fetchImpl: fetcher, now })

    expect(first?.kind).toBe('claimed')
    expect(second).toBeUndefined()
    expect(hits).toBe(1)
  })

  it('跨天后重新领取（前一天已领不挡今天）', async () => {
    let hits = 0
    const fetcher = (async () => {
      hits += 1
      return jsonResponse({ code: 1000, data: { granted: true, point_amount: 200 } })
    }) as unknown as typeof fetch

    await maybeClaimMagicrewDaily({
      ...CREDENTIAL, ref: 'REF_A', fetchImpl: fetcher,
      now: () => Date.UTC(2026, 9, 30, 2, 0, 0),
    })
    const nextDay = await maybeClaimMagicrewDaily({
      ...CREDENTIAL, ref: 'REF_A', fetchImpl: fetcher,
      now: () => Date.UTC(2026, 9, 31, 2, 0, 0),
    })

    expect(nextDay?.kind).toBe('claimed')
    expect(hits).toBe(2)
  })

  it('不同 ref 各自领取（多账号共用一把锁会让第二个账号当天领不到）', async () => {
    const fetcher = (async () => jsonResponse({ code: 1000, data: { granted: true, point_amount: 200 } })) as unknown as typeof fetch
    const now = () => Date.UTC(2026, 9, 30, 2, 0, 0)

    const a = await maybeClaimMagicrewDaily({ ...CREDENTIAL, ref: 'REF_A', fetchImpl: fetcher, now })
    const b = await maybeClaimMagicrewDaily({ ...CREDENTIAL, ref: 'REF_B', fetchImpl: fetcher, now })

    expect(a?.kind).toBe('claimed')
    expect(b?.kind).toBe('claimed')
  })

  it('ineligible 也算「今天已有结论」⇒ 不重复打上游', async () => {
    let hits = 0
    const fetcher = (async () => {
      hits += 1
      return jsonResponse({ code: 1000, data: { granted: false, point_amount: 0, message: '当前账号暂不符合活动参与条件' } })
    }) as unknown as typeof fetch
    const now = () => Date.UTC(2026, 9, 30, 2, 0, 0)

    const first = await maybeClaimMagicrewDaily({ ...CREDENTIAL, ref: 'REF_A', fetchImpl: fetcher, now })
    const second = await maybeClaimMagicrewDaily({ ...CREDENTIAL, ref: 'REF_A', fetchImpl: fetcher, now })

    expect(first?.kind).toBe('ineligible')
    expect(second).toBeUndefined()
    expect(hits).toBe(1)
  })

  it('失败**不记日期**（早期「先标记再请求」会把一次抖动记成整天已领）', async () => {
    let hits = 0
    const fetcher = (async () => {
      hits += 1
      return new Response('boom', { status: 500 })
    }) as unknown as typeof fetch
    const now = () => Date.UTC(2026, 9, 30, 2, 0, 0)

    const first = await maybeClaimMagicrewDaily({ ...CREDENTIAL, ref: 'REF_A', fetchImpl: fetcher, now })
    expect(first?.kind).toBe('failed')

    // 冷却期内仍被挡（防定时任务与面板同时打这一枪）。
    const cooled = await maybeClaimMagicrewDaily({ ...CREDENTIAL, ref: 'REF_A', fetchImpl: fetcher, now })
    expect(cooled).toBeUndefined()
    expect(hits).toBe(1)

    // 冷却过后重试 —— 关键点：当天仍会真的再试一次（没被记成已领）。
    const later = await maybeClaimMagicrewDaily({
      ...CREDENTIAL, ref: 'REF_A', fetchImpl: fetcher,
      now: () => Date.UTC(2026, 9, 30, 2, 30, 0),
    })
    expect(later?.kind).toBe('failed')
    expect(hits).toBe(2)
  })

  it('force 跳过闸门（手动补领按钮必须真的打一次，否则点了没反应）', async () => {
    let hits = 0
    const fetcher = (async () => {
      hits += 1
      return jsonResponse({ code: 1000, data: { granted: false, point_amount: 0, message: '今日已领取登录积分' } })
    }) as unknown as typeof fetch
    const now = () => Date.UTC(2026, 9, 30, 2, 0, 0)

    await maybeClaimMagicrewDaily({ ...CREDENTIAL, ref: 'REF_A', fetchImpl: fetcher, now })
    const forced = await maybeClaimMagicrewDaily({ ...CREDENTIAL, ref: 'REF_A', fetchImpl: fetcher, now, force: true })

    expect(forced?.kind).toBe('already-claimed')
    expect(hits).toBe(2)
  })
})

describe('magicrewDayKey：按 UTC+8 而非本机时区', () => {
  it('UTC 16:00 已经是北京时间次日', () => {
    // 2026-10-30T16:00Z === 2026-10-31 00:00 UTC+8
    expect(magicrewDayKey(new Date(Date.UTC(2026, 9, 30, 16, 0, 0)))).toBe('2026-10-31')
  })

  it('UTC 15:59 仍是北京时间当天', () => {
    expect(magicrewDayKey(new Date(Date.UTC(2026, 9, 30, 15, 59, 59)))).toBe('2026-10-30')
  })
})
