import { describe, expect, it } from 'vitest'
import { RACCOON } from '../../src/providers/raccoon-product.js'
import {
  claimRaccoonLoginReward,
  fetchRaccoonCreditBalance,
  fetchRaccoonCreditBalanceDetailed,
  fetchRaccoonOnboardingStatus,
  keepAliveRaccoonDailyPoints,
} from '../../src/providers/raccoon-credits.js'
import { isRaccoonAuthVerifyError, raccoonHeaders, type RaccoonCredential } from '../../src/providers/raccoon.js'

const CRED: RaccoonCredential = { access_token: 't', refresh_token: 'r' }

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

describe('fetchRaccoonCreditBalance', () => {
  it('把 available_points 映射成 total，各池作 package', async () => {
    const fetcher = async (): Promise<Response> => jsonResponse({
      code: 0,
      data: {
        available_points: 6300,
        daily_points: 300,
        monthly_points: 0,
        reward_points: 6000,
        topup_points: 0,
      },
    })
    const balance = await fetchRaccoonCreditBalance(RACCOON, CRED, fetcher)
    expect(balance).not.toBeNull()
    expect(balance?.total).toBe(6300)
    const names = balance?.packages.map((p) => p.name)
    expect(names).toContain('奖励积分')
    expect(names).toContain('每日积分')
    expect(names).toContain('充值积分')
  })

  it('请求路径与鉴权头正确', async () => {
    let seenUrl = ''
    let seenAuth = ''
    const fetcher = async (url: string, init?: RequestInit): Promise<Response> => {
      seenUrl = String(url)
      seenAuth = String((init?.headers as Record<string, string> | undefined)?.Authorization ?? '')
      return jsonResponse({ code: 0, data: { available_points: 1 } })
    }
    await fetchRaccoonCreditBalance(RACCOON, CRED, fetcher as unknown as typeof fetch)
    expect(seenUrl).toBe(`${RACCOON.apiBase}${RACCOON.pointsApiPrefix}/balance`)
    expect(seenAuth).toBe('Bearer t')
  })

  it('code 非 0 时返回 null（显示原因，不是 0）', async () => {
    const fetcher = async (): Promise<Response> => jsonResponse({ code: 200003, message: 'auth fail' }, 401)
    expect(await fetchRaccoonCreditBalance(RACCOON, CRED, fetcher)).toBeNull()
  })

  it('缺 available_points 时返回 null（不编造数字）', async () => {
    const fetcher = async (): Promise<Response> => jsonResponse({ code: 0, data: {} })
    expect(await fetchRaccoonCreditBalance(RACCOON, CRED, fetcher)).toBeNull()
  })

  it('网络异常时返回 null（不抛错，避免批量查询被单个账号中断）', async () => {
    const fetcher = async (): Promise<Response> => { throw new Error('down') }
    expect(await fetchRaccoonCreditBalance(RACCOON, CRED, fetcher)).toBeNull()
  })
})

describe('claimRaccoonLoginReward', () => {
  it('granted:true 时返回 claimed 与积分数', async () => {
    const fetcher = async (): Promise<Response> => jsonResponse({
      code: 0,
      data: { granted: true, popup: { source: 'desktop_login', points: 3000 } },
    })
    const outcome = await claimRaccoonLoginReward(RACCOON, CRED, fetcher)
    expect(outcome.kind).toBe('claimed')
    if (outcome.kind === 'claimed') {
      expect(outcome.credit).toBe(3000)
    }
  })

  it('granted:false 时返回 already-claimed（幂等，不是失败）', async () => {
    const fetcher = async (): Promise<Response> => jsonResponse({
      code: 0,
      data: { granted: false, popup: null },
    })
    const outcome = await claimRaccoonLoginReward(RACCOON, CRED, fetcher)
    expect(outcome.kind).toBe('already-claimed')
  })

  it('必须带 X-Client-Platform（缺了会被服务端拒）', async () => {
    let seenPlatform = ''
    const fetcher = async (_url: string, init?: RequestInit): Promise<Response> => {
      seenPlatform = String((init?.headers as Record<string, string> | undefined)?.['X-Client-Platform'] ?? '')
      return jsonResponse({ code: 0, data: { granted: false } })
    }
    await claimRaccoonLoginReward(RACCOON, CRED, fetcher as unknown as typeof fetch)
    expect(seenPlatform).toBe(RACCOON.clientPlatform)
    expect(seenPlatform).toMatch(/^desktop-(windows|macos|linux)$/)
  })

  it('请求路径与方法是 POST', async () => {
    let seenUrl = ''
    let seenMethod = ''
    const fetcher = async (url: string, init?: RequestInit): Promise<Response> => {
      seenUrl = String(url)
      seenMethod = String(init?.method ?? '')
      return jsonResponse({ code: 0, data: { granted: false } })
    }
    await claimRaccoonLoginReward(RACCOON, CRED, fetcher as unknown as typeof fetch)
    expect(seenUrl).toBe(`${RACCOON.apiBase}${RACCOON.desktopApiPrefix}/login/points/grant`)
    expect(seenMethod).toBe('POST')
  })

  it('失败时返回 failed 且带原因（不抛错，保证批量领取不中断）', async () => {
    const fetcher = async (): Promise<Response> => jsonResponse({ code: 100006, message: 'boom' }, 400)
    const outcome = await claimRaccoonLoginReward(RACCOON, CRED, fetcher)
    expect(outcome.kind).toBe('failed')
    if (outcome.kind === 'failed') {
      expect(outcome.message.length).toBeGreaterThan(0)
    }
  })

  it('网络异常时返回 failed', async () => {
    const fetcher = async (): Promise<Response> => { throw new Error('down') }
    const outcome = await claimRaccoonLoginReward(RACCOON, CRED, fetcher)
    expect(outcome.kind).toBe('failed')
  })

  it('granted:true 但 popup 缺 points 时用 3000 兜底', async () => {
    const fetcher = async (): Promise<Response> => jsonResponse({
      code: 0,
      data: { granted: true },
    })
    const outcome = await claimRaccoonLoginReward(RACCOON, CRED, fetcher)
    expect(outcome.kind).toBe('claimed')
    if (outcome.kind === 'claimed') {
      expect(outcome.credit).toBe(3000)
    }
  })
})

describe('fetchRaccoonOnboardingStatus', () => {
  it('账单里已有「桌面端登录奖励」时判为已领', async () => {
    const fetcher = async (): Promise<Response> => jsonResponse({
      code: 0,
      data: {
        items: [
          { event_name: '桌面端登录奖励', biz_type: 'reward_grant', points: 3000 },
          { event_name: '每日积分发放', biz_type: 'daily_grant', points: 300 },
        ],
        paging: { offset: 0, limit: 20, total: 0 },
      },
    })
    const status = await fetchRaccoonOnboardingStatus(RACCOON, CRED, fetcher)
    expect(status.claimed).toBe(true)
    expect(status.points).toBe(3000)
  })

  it('账单里没有该记录时判为未领', async () => {
    const fetcher = async (): Promise<Response> => jsonResponse({
      code: 0,
      data: {
        items: [{ event_name: '每日积分发放', biz_type: 'daily_grant', points: 300 }],
        paging: { offset: 0, limit: 20, total: 0 },
      },
    })
    const status = await fetchRaccoonOnboardingStatus(RACCOON, CRED, fetcher)
    expect(status.claimed).toBe(false)
  })

  it('「新人注册礼包」不算作登录奖励（两者是不同来源）', async () => {
    const fetcher = async (): Promise<Response> => jsonResponse({
      code: 0,
      data: {
        items: [{ event_name: '新人注册礼包', biz_type: 'reward_grant', points: 3000 }],
      },
    })
    const status = await fetchRaccoonOnboardingStatus(RACCOON, CRED, fetcher)
    expect(status.claimed).toBe(false)
  })

  it('查询失败时保守判为未领（宁可让用户多点一次）', async () => {
    const fetcher = async (): Promise<Response> => jsonResponse({ code: 1, message: 'err' }, 500)
    const status = await fetchRaccoonOnboardingStatus(RACCOON, CRED, fetcher)
    expect(status.claimed).toBe(false)
    expect(status.points).toBe(3000)
  })

  it('网络异常时保守判为未领', async () => {
    const fetcher = async (): Promise<Response> => { throw new Error('down') }
    const status = await fetchRaccoonOnboardingStatus(RACCOON, CRED, fetcher)
    expect(status.claimed).toBe(false)
  })

  it('items 非数组时不抛错', async () => {
    const fetcher = async (): Promise<Response> => jsonResponse({ code: 0, data: { items: 'bad' } })
    const status = await fetchRaccoonOnboardingStatus(RACCOON, CRED, fetcher)
    expect(status.claimed).toBe(false)
  })
})

/**
 * 每日积分保活（`keepAliveRaccoonDailyPoints`）。
 *
 * 背景：每日 300 积分服务端自动发放，但**不登录就当天 24:00 清零**；
 * 只有「当日登录」才把有效期延长到 7 天。本函数模拟这次登录。
 *
 * ⚠️ 测试的核心是**判定逻辑**：`daily_grant.created_at` 等于整点
 * `00:00:00` 表示未延长，是真实时刻表示已延长。触发端点已由 2026-10-11
 * 跨日对照实验确证为 `setting_info`（见 `raccoon-credits.ts` 的说明），
 * 但实现仍是「候选逐个尝试 + 复查账单自验证」——测试必须锁住这个语义：
 * 判定看**账单变化**，而不是「我调了哪个端点」。
 */
describe('keepAliveRaccoonDailyPoints', () => {
  /** 构造「账单查询」响应。 */
  function billsResponse(createdAt: string, expireAt: string): Response {
    return jsonResponse({
      code: 0,
      data: {
        items: [{
          biz_type: 'daily_grant',
          grant_at: '2026-10-09T00:00:00+08:00',
          created_at: createdAt,
          expire_at: expireAt,
          points: 300,
        }],
      },
    })
  }

  // 用固定「现在」把 UTC+8 当日锁死在 2026-10-09（避免跨日 flaky）。
  const NOW = Date.parse('2026-10-09T02:00:00Z')

  it('当天已延长（created_at 非整点）时直接返回 already-extended，不发触发请求', async () => {
    const calls: string[] = []
    const fetcher = async (url: string): Promise<Response> => {
      calls.push(String(url))
      return billsResponse('2026-10-09T09:22:09+08:00', '2026-10-15T23:59:59+08:00')
    }
    const outcome = await keepAliveRaccoonDailyPoints(RACCOON, CRED, fetcher as unknown as typeof fetch, { now: NOW })
    expect(outcome.kind).toBe('already-extended')
    // 只应发过一次账单查询，**没有**任何触发请求
    expect(calls.length).toBe(1)
    expect(calls[0]).toContain('/bills')
  })

  it('未延长时按候选顺序尝试，命中 setting_info 即停并回报 trigger', async () => {
    const calls: string[] = []
    let billReads = 0
    const fetcher = async (url: string): Promise<Response> => {
      const u = String(url)
      calls.push(u)
      if (u.includes('/bills')) {
        billReads += 1
        // 第一次读：未延长；第二次读（触发后复查）：已延长
        return billReads === 1
          ? billsResponse('2026-10-09T00:00:00+08:00', '2026-10-09T23:59:59+08:00')
          : billsResponse('2026-10-09T10:05:00+08:00', '2026-10-15T23:59:59+08:00')
      }
      return jsonResponse({ code: 0, data: {} })
    }
    const outcome = await keepAliveRaccoonDailyPoints(RACCOON, CRED, fetcher as unknown as typeof fetch, { now: NOW })
    expect(outcome.kind).toBe('extended')
    if (outcome.kind === 'extended') {
      expect(outcome.trigger).toBe('setting_info')
      expect(outcome.expireAt).toBe('2026-10-15T23:59:59+08:00')
    }
    // setting_info 是第一个候选，命中后**不得**再试 balance
    expect(calls.some((u) => u.includes('/setting_info'))).toBe(true)
    expect(calls.some((u) => u.endsWith('/balance'))).toBe(false)
  })

  it('setting_info 无效时继续试 balance（候选链不因单点失败中断）', async () => {
    const calls: string[] = []
    let billReads = 0
    const fetcher = async (url: string): Promise<Response> => {
      const u = String(url)
      calls.push(u)
      if (u.includes('/bills')) {
        billReads += 1
        return billReads === 1
          ? billsResponse('2026-10-09T00:00:00+08:00', '2026-10-09T23:59:59+08:00')
          : billsResponse('2026-10-09T10:05:00+08:00', '2026-10-15T23:59:59+08:00')
      }
      if (u.includes('/setting_info')) return jsonResponse({ code: 1, message: 'nope' }, 500)
      return jsonResponse({ code: 0, data: { available_points: 300 } })
    }
    const outcome = await keepAliveRaccoonDailyPoints(RACCOON, CRED, fetcher as unknown as typeof fetch, { now: NOW })
    expect(outcome.kind).toBe('extended')
    if (outcome.kind === 'extended') expect(outcome.trigger).toBe('balance')
  })

  it('候选全部无效时返回 not-extended 并列出已尝试的候选（不谎报成功）', async () => {
    const fetcher = async (url: string): Promise<Response> => {
      const u = String(url)
      if (u.includes('/bills')) {
        // 始终未延长
        return billsResponse('2026-10-09T00:00:00+08:00', '2026-10-09T23:59:59+08:00')
      }
      return jsonResponse({ code: 0, data: {} })
    }
    const outcome = await keepAliveRaccoonDailyPoints(RACCOON, CRED, fetcher as unknown as typeof fetch, { now: NOW })
    expect(outcome.kind).toBe('not-extended')
    if (outcome.kind === 'not-extended') {
      expect(outcome.tried).toEqual(['setting_info', 'balance'])
      expect(outcome.message.length).toBeGreaterThan(0)
    }
  })

  it('账单里没有今天（UTC+8）的 daily_grant 时仍会尝试候选（不因查不到而放弃）', async () => {
    const calls: string[] = []
    let billReads = 0
    const fetcher = async (url: string): Promise<Response> => {
      const u = String(url)
      calls.push(u)
      if (u.includes('/bills')) {
        billReads += 1
        if (billReads === 1) return jsonResponse({ code: 0, data: { items: [] } })
        return billsResponse('2026-10-09T10:00:00+08:00', '2026-10-15T23:59:59+08:00')
      }
      return jsonResponse({ code: 0, data: {} })
    }
    const outcome = await keepAliveRaccoonDailyPoints(RACCOON, CRED, fetcher as unknown as typeof fetch, { now: NOW })
    expect(outcome.kind).toBe('extended')
  })

  it('只认 UTC+8 当日的发放记录（昨天的记录不参与判定）', async () => {
    const calls: string[] = []
    const fetcher = async (url: string): Promise<Response> => {
      const u = String(url)
      calls.push(u)
      if (u.includes('/bills')) {
        // 只有 10-08 的记录（昨天），且未延长
        return jsonResponse({
          code: 0,
          data: {
            items: [{
              biz_type: 'daily_grant',
              grant_at: '2026-10-08T00:00:00+08:00',
              created_at: '2026-10-08T00:00:00+08:00',
              expire_at: '2026-10-08T23:59:59+08:00',
              points: 300,
            }],
          },
        })
      }
      return jsonResponse({ code: 0, data: {} })
    }
    const outcome = await keepAliveRaccoonDailyPoints(RACCOON, CRED, fetcher as unknown as typeof fetch, { now: NOW })
    // 昨天的记录不该被当成「今天已延长」→ 应继续尝试候选
    expect(calls.some((u) => u.includes('/setting_info'))).toBe(true)
    expect(outcome.kind).toBe('not-extended')
  })

  it('候选请求网络异常不抛错，且归为 unavailable（上游不可用，不是「端点无效」）', async () => {
    const fetcher = async (url: string): Promise<Response> => {
      const u = String(url)
      if (u.includes('/bills')) return billsResponse('2026-10-09T00:00:00+08:00', '2026-10-09T23:59:59+08:00')
      throw new Error('network down')
    }
    const outcome = await keepAliveRaccoonDailyPoints(RACCOON, CRED, fetcher as unknown as typeof fetch, { now: NOW })
    // ⚠️ 网络异常 ⇒ 端点**没调用成功** ⇒ 是「上游不可用」，不是「调用成功但没触发」。
    expect(outcome.kind).toBe('unavailable')
    if (outcome.kind === 'unavailable') {
      expect(outcome.lastError).toContain('network down')
      expect(outcome.tried).toEqual(['setting_info', 'balance'])
    }
  })

  it('候选端点全部返回 503 code=200903 service_unavailable → 归为 unavailable（不谎称「未触发延长」）', async () => {
    // 这是用户报障的真实形态：上游对**全部鉴权业务请求**返回 503 200903。
    // 此前被并入 not-extended 并显示成「候选端点均未触发延长」，把服务端故障
    // 说成了功能结论 —— 本用例锁死「必须区分」。
    const fetcher = async (url: string): Promise<Response> => {
      const u = String(url)
      if (u.includes('/bills')) {
        // 账单查询同样 503：读不到记录（干净初始态，不编造）。
        return jsonResponse({ code: 200903, message: 'service_unavailable' }, 503)
      }
      return jsonResponse({ code: 200903, message: 'service_unavailable' }, 503)
    }
    const outcome = await keepAliveRaccoonDailyPoints(RACCOON, CRED, fetcher as unknown as typeof fetch, { now: NOW })
    expect(outcome.kind).toBe('unavailable')
    if (outcome.kind === 'unavailable') {
      expect(outcome.lastError).toContain('200903')
      expect(outcome.lastError).toContain('service_unavailable')
      expect(outcome.tried).toEqual(['setting_info', 'balance'])
      expect(outcome.attempts.every((a) => a.code === 200903)).toBe(true)
      // 文案必须点明「上游不可用 / 请稍后重试」，而不是「端点未触发」。
      expect(outcome.message).toContain('上游服务暂时不可用')
    }
  })

  it('一端点失败、一端点成功但未触发 → 仍归 not-extended（不是 unavailable）', async () => {
    // 只要**有一个**候选调用成功，就不是「上游整体不可用」。
    const fetcher = async (url: string): Promise<Response> => {
      const u = String(url)
      if (u.includes('/bills')) return billsResponse('2026-10-09T00:00:00+08:00', '2026-10-09T23:59:59+08:00')
      if (u.includes('/setting_info')) return jsonResponse({ code: 200903, message: 'service_unavailable' }, 503)
      return jsonResponse({ code: 0, data: {} })
    }
    const outcome = await keepAliveRaccoonDailyPoints(RACCOON, CRED, fetcher as unknown as typeof fetch, { now: NOW })
    expect(outcome.kind).toBe('not-extended')
    if (outcome.kind === 'not-extended') {
      expect(outcome.attempts.find((a) => a.id === 'setting_info')?.ok).toBe(false)
      expect(outcome.attempts.find((a) => a.id === 'balance')?.ok).toBe(true)
    }
  })

  it('already-extended 带 note 如实说明「本次未发请求」（防假阳性）', async () => {
    const fetcher = async (): Promise<Response> =>
      billsResponse('2026-10-09T09:22:09+08:00', '2026-10-15T23:59:59+08:00')
    const outcome = await keepAliveRaccoonDailyPoints(RACCOON, CRED, fetcher as unknown as typeof fetch, { now: NOW })
    expect(outcome.kind).toBe('already-extended')
    if (outcome.kind === 'already-extended') {
      expect(outcome.note).toContain('未发任何请求')
    }
  })

  it('触发请求带 Authorization 头（这正是「续期不带鉴权所以不算登录」的反面）', async () => {
    let triggerAuth = ''
    let billReads = 0
    const fetcher = async (url: string, init?: RequestInit): Promise<Response> => {
      const u = String(url)
      if (u.includes('/bills')) {
        billReads += 1
        return billReads === 1
          ? billsResponse('2026-10-09T00:00:00+08:00', '2026-10-09T23:59:59+08:00')
          : billsResponse('2026-10-09T10:05:00+08:00', '2026-10-15T23:59:59+08:00')
      }
      triggerAuth = String((init?.headers as Record<string, string> | undefined)?.Authorization ?? '')
      return jsonResponse({ code: 0, data: {} })
    }
    await keepAliveRaccoonDailyPoints(RACCOON, CRED, fetcher as unknown as typeof fetch, { now: NOW })
    expect(triggerAuth).toBe('Bearer t')
  })
})

/**
 * 鉴权失效 vs 上游不可用（2026-10-14 用户报障「3 个上游暂时不可用」）。
 *
 * 真实形态：三个账号的 `refresh_token` 都被服务端作废，`/auth/v1/refresh` 与
 * **全部**业务端点一致回 `HTTP 401` + `code=200003 authorization_verify_error`。
 * 旧实现把它归入 `unavailable` 并提示「请稍后重试」—— 用户照着重试无数次
 * 依旧失败，还误以为功能坏了。
 *
 * 本组锁死：**同一种「候选端点都调不通」，必须按根因分成两类提示**。
 */
describe('raccoon 鉴权失效与上游不可用的区分', () => {
  /** 401 + 200003：鉴权失效（服务端不再接受这份凭据）。 */
  function authFailure(): Response {
    return jsonResponse({ code: 200003, message: 'authorization_verify_error', details: 'authorization verify failed' }, 401)
  }

  /** 503 + 200903：上游整体不可用（稍后重试即可）。 */
  function serviceFailure(): Response {
    return jsonResponse({ code: 200903, message: 'service_unavailable' }, 503)
  }

  it('账单查询即 401/200003 → auth-expired，且**不发**任何候选请求', async () => {
    const calls: string[] = []
    const fetcher = async (url: string): Promise<Response> => {
      calls.push(String(url))
      return authFailure()
    }
    const outcome = await keepAliveRaccoonDailyPoints(
      RACCOON, CRED, fetcher as unknown as typeof fetch, { now: Date.parse('2026-10-09T02:00:00Z') },
    )
    expect(outcome.kind).toBe('auth-expired')
    // 鉴权已失效，换候选端点没有意义（下一个同样 401）—— 不该白发请求。
    expect(calls.length).toBe(1)
    expect(calls[0]).toContain('/bills')
    if (outcome.kind === 'auth-expired') {
      expect(outcome.lastError).toContain('200003')
      expect(outcome.lastError).toContain('authorization_verify_error')
      expect(outcome.message).toContain('重新登录')
    }
  })

  it('候选端点全部 401/200003 → auth-expired（不是 unavailable）', async () => {
    const fetcher = async (url: string): Promise<Response> => {
      const u = String(url)
      if (u.includes('/bills')) {
        return jsonResponse({ code: 0, data: { items: [] } })
      }
      return authFailure()
    }
    const outcome = await keepAliveRaccoonDailyPoints(
      RACCOON, CRED, fetcher as unknown as typeof fetch, { now: Date.parse('2026-10-09T02:00:00Z') },
    )
    expect(outcome.kind).toBe('auth-expired')
    if (outcome.kind === 'auth-expired') {
      // 鉴权已失效 ⇒ 第一个候选就该收手，不该再把注定 401 的请求挨个发一遍。
      expect(outcome.tried).toEqual(['setting_info'])
      expect(outcome.attempts.every((a) => a.authFailed)).toBe(true)
      expect(outcome.attempts[0]?.code).toBe(200003)
    }
  })

  it('一端点 401、一端点 503 → auth-expired（鉴权失效优先，重试无用）', async () => {
    const fetcher = async (url: string): Promise<Response> => {
      const u = String(url)
      if (u.includes('/bills')) return jsonResponse({ code: 0, data: { items: [] } })
      if (u.includes('/setting_info')) return authFailure()
      return serviceFailure()
    }
    const outcome = await keepAliveRaccoonDailyPoints(
      RACCOON, CRED, fetcher as unknown as typeof fetch, { now: Date.parse('2026-10-09T02:00:00Z') },
    )
    expect(outcome.kind).toBe('auth-expired')
  })

  it('候选端点全部 503/200903 → 仍是 unavailable（与上面三种形成对照）', async () => {
    const fetcher = async (url: string): Promise<Response> => {
      const u = String(url)
      if (u.includes('/bills')) return jsonResponse({ code: 0, data: { items: [] } })
      return serviceFailure()
    }
    const outcome = await keepAliveRaccoonDailyPoints(
      RACCOON, CRED, fetcher as unknown as typeof fetch, { now: Date.parse('2026-10-09T02:00:00Z') },
    )
    expect(outcome.kind).toBe('unavailable')
  })
})

describe('fetchRaccoonCreditBalanceDetailed', () => {
  it('成功时返回 ok 与 balance', async () => {
    const fetcher = async (): Promise<Response> => jsonResponse({ code: 0, data: { available_points: 1948, daily_points: 1948 } })
    const result = await fetchRaccoonCreditBalanceDetailed(RACCOON, CRED, fetcher)
    expect(result.kind).toBe('ok')
    if (result.kind === 'ok') expect(result.balance.total).toBe(1948)
  })

  it('401/200003 → auth-expired（文案必须指向「重新登录」）', async () => {
    const fetcher = async (): Promise<Response> =>
      jsonResponse({ code: 200003, message: 'authorization_verify_error' }, 401)
    const result = await fetchRaccoonCreditBalanceDetailed(RACCOON, CRED, fetcher)
    expect(result.kind).toBe('auth-expired')
  })

  it('503/200903 → unavailable（与 auth-expired 分开）', async () => {
    const fetcher = async (): Promise<Response> =>
      jsonResponse({ code: 200903, message: 'service_unavailable' }, 503)
    const result = await fetchRaccoonCreditBalanceDetailed(RACCOON, CRED, fetcher)
    expect(result.kind).toBe('unavailable')
  })

  it('响应缺 available_points → no-data（不编造 0）', async () => {
    const fetcher = async (): Promise<Response> => jsonResponse({ code: 0, data: {} })
    const result = await fetchRaccoonCreditBalanceDetailed(RACCOON, CRED, fetcher)
    expect(result.kind).toBe('no-data')
  })
})

describe('raccoonHeaders 的 X-Org-Code', () => {
  it('office_identity 为 personal 时发空串（否则服务端按组织码查库 → 400 org_not_found）', () => {
    // 实测 2026-10-14：官方客户端往共享凭据文件里写的就是字面量 'personal'，
    // 原样发出去会让 /points/v1/balance 回 400 code=200022 org_not_found_error。
    const headers = raccoonHeaders({ access_token: 't', refresh_token: 'r', office_identity: 'personal' })
    expect(headers['X-Org-Code']).toBe('')
  })

  it('真正的组织码原样发送', () => {
    const headers = raccoonHeaders({ access_token: 't', refresh_token: 'r', office_identity: 'ORG123' })
    expect(headers['X-Org-Code']).toBe('ORG123')
  })

  it('无 office_identity 时发空串（个人账号）', () => {
    const headers = raccoonHeaders({ access_token: 't', refresh_token: 'r' })
    expect(headers['X-Org-Code']).toBe('')
  })
})

describe('isRaccoonAuthVerifyError', () => {
  it('401 / code=200003 / 文案三种判据都认', () => {
    expect(isRaccoonAuthVerifyError(401, 0, '')).toBe(true)
    expect(isRaccoonAuthVerifyError(200, 200003, 'authorization_verify_error')).toBe(true)
    expect(isRaccoonAuthVerifyError(200, 0, 'authorization_verify_error')).toBe(true)
  })

  it('503/200903 等服务级错误不算鉴权失败', () => {
    expect(isRaccoonAuthVerifyError(503, 200903, 'service_unavailable')).toBe(false)
    expect(isRaccoonAuthVerifyError(200, 200022, 'org_not_found_error')).toBe(false)
    expect(isRaccoonAuthVerifyError(200, 0, 'success')).toBe(false)
  })
})
