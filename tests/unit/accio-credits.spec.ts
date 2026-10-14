import { describe, expect, it, vi } from 'vitest'
import {
  fetchAccioBalanceDetailed,
  fetchAccioQuota,
  fetchAccioUserInfo,
  flattenAccioCredits,
} from '../../src/providers/accio-credits.js'
import type { AccioCredential } from '../../src/providers/accio.js'
import { ACCIO } from '../../src/providers/accio-product.js'

/**
 * Accio 积分查询的回归测试。
 *
 * 守的都是**移植时最容易丢的实现细节**（来源 `accio-credits.ts` 的文件头
 * 逐条列过）：
 * - 三个端点传参方式各不相同（POST body / GET query）—— 用错即 405/400；
 * - `code` 可能是数字（标量归一）；
 * - `balance: null` = 查不到，0 = 已用光，**互不替代**；
 * - 总余额优先服务端的 `data.remaining`。
 */

function cred(overrides: Partial<AccioCredential> = {}): AccioCredential {
  return {
    access_token: 'tok-32-hex',
    refresh_token: 'refresh-1',
    expires_at: Date.now() + 3_600_000,
    region: 'cn',
    ...overrides,
  }
}

/** 造一个按 URL 分派的 fetch 替身（记录每次调用的 URL 与 init）。 */
function fakeFetch(routes: Record<string, { status?: number; body: unknown }>) {
  const calls: Array<{ url: string; init: RequestInit }> = []
  const impl = vi.fn(async (url: string, init: RequestInit) => {
    calls.push({ url, init })
    const matched = Object.keys(routes).find((key) => url.includes(key))
    const route = matched === undefined ? undefined : routes[matched]
    const status = route?.status ?? 200
    const body = JSON.stringify(route?.body ?? {})
    return new Response(body, { status })
  })
  return { fetch: impl as unknown as typeof fetch, calls }
}

describe('accio-credits：桶拍平', () => {
  it('值为 0 的桶保留、缺席的桶不产出', () => {
    const rows = flattenAccioCredits({
      entitlement: {
        daily: { total: 100, used: 100, remaining: 0 },
        // monthly 缺席
        referral: { total: 700, used: 0, remaining: 700 },
      },
    })
    expect(rows.map((r) => r.label)).toEqual(['每日积分', '推荐积分'])
    expect(rows[0]!.remaining).toBe(0)
    expect(rows[1]!.remaining).toBe(700)
  })

  it('桶存在但 remaining 读不到时跳过该桶（不按 0 展示）', () => {
    const rows = flattenAccioCredits({
      entitlement: {
        daily: { total: 100, used: 0 }, // remaining 缺席
        referral: { total: 700, used: 0, remaining: 700 },
      },
    })
    expect(rows.map((r) => r.label)).toEqual(['推荐积分'])
  })

  it('固定顺序 daily → monthly → referral（不随响应键序漂移）', () => {
    const rows = flattenAccioCredits({
      entitlement: {
        referral: { total: 1, used: 0, remaining: 1 },
        monthly: { total: 2, used: 0, remaining: 2 },
        daily: { total: 3, used: 0, remaining: 3 },
      },
    })
    expect(rows.map((r) => r.label)).toEqual(['每日积分', '每月积分', '推荐积分'])
  })
})

describe('accio-credits：单端点查询', () => {
  it('userinfo 走 POST + body（accessToken 在 body 里）', async () => {
    const { fetch: f, calls } = fakeFetch({
      '/api/auth/userinfo': { body: { success: true, data: { userId: 'u1', userName: 'n', routeRegion: 'CN', userLevel: 'freeMember', maskedMobile: '+86 186****6665' } } },
    })
    const info = await fetchAccioUserInfo(cred(), { fetcher: f })
    expect(info?.userLevel).toBe('freeMember')
    expect(calls[0]!.init.method).toBe('POST')
    expect(calls[0]!.init.body).toBe(JSON.stringify({ accessToken: 'tok-32-hex' }))
    expect(calls[0]!.url).not.toContain('accessToken=')
  })

  it('quota 走 GET + query（token 在 query 里）', async () => {
    const { fetch: f, calls } = fakeFetch({
      '/api/entitlement/quota': { body: { success: true, data: { usagePercent: 12.5, refreshCountdownSeconds: 86400 } } },
    })
    const quota = await fetchAccioQuota(cred(), { fetcher: f })
    expect(quota?.refreshCountdownSeconds).toBe(86400)
    expect(calls[0]!.init.method).toBe('GET')
    expect(calls[0]!.url).toContain('accessToken=tok-32-hex')
  })
})

describe('accio-credits：fetchAccioBalanceDetailed', () => {
  it('聚合三个端点：总余额优先 data.remaining，daily 桶带 cycleEndTime', async () => {
    const now = 1_800_000_000_000
    vi.useFakeTimers()
    vi.setSystemTime(now)
    try {
      const { fetch: f, calls } = fakeFetch({
        '/api/entitlement/currentSubscription': {
          body: {
            success: true,
            data: {
              // 服务端自己算的总余额（各有效桶剩余之和）
              remaining: 800,
              entitlement: {
                daily: { total: 100, used: 0, remaining: 100 },
                monthly: { total: 0, used: 0, remaining: 0 },
                referral: { total: 700, used: 0, remaining: 700 },
              },
            },
          },
        },
        '/api/entitlement/quota': { body: { success: true, data: { refreshCountdownSeconds: 86400 } } },
        '/api/auth/userinfo': { body: { success: true, data: { userLevel: 'freeMember' } } },
      })
      const result = await fetchAccioBalanceDetailed(cred(), { fetcher: f })
      expect(result.error).toBeUndefined()
      expect(result.balance?.total).toBe(800)
      // 账号等级搭车回来（面板「账号规格」行）
      expect(result.extra?.accountTier?.label).toBe('Free')
      expect(result.extra?.accountTier?.title).toContain('freeMember')
      // daily 桶的周期结束时刻由 quota 倒计时现算；其余桶留空（不复用它的值）
      const [daily, monthly, referral] = result.balance!.packages
      expect(daily!.cycleEndTime).toBe(new Date(now + 86_400_000).toISOString())
      expect(monthly!.cycleEndTime).toBe('')
      expect(referral!.cycleEndTime).toBe('')
      // 三个包都 active（上游没下发失效信息就不臆造）
      expect(result.balance!.packages.every((p) => p.active)).toBe(true)
      // 必需端点第一个发（未登录/网络故障可短路）
      expect(calls[0]!.url).toContain('/api/entitlement/currentSubscription')
      // 总余额优先服务端口径：桶求和也是 800，换一个不等价的读数才能区分
      expect(result.balance!.total).toBe(800)
    } finally {
      vi.useRealTimers()
    }
  })

  it('桶求和只在 data.remaining 缺席时兜底', async () => {
    const { fetch: f } = fakeFetch({
      '/api/entitlement/currentSubscription': {
        body: { success: true, data: { entitlement: { daily: { total: 100, used: 40, remaining: 60 } } } },
      },
      '/api/entitlement/quota': { body: { success: true, data: {} } },
      '/api/auth/userinfo': { body: { success: true, data: {} } },
    })
    const result = await fetchAccioBalanceDetailed(cred(), { fetcher: f })
    expect(result.balance?.total).toBe(60)
  })

  it('未登录（HTTP 200 + body code:"401"）⇒ 提示重新登录，不退化成分桶', async () => {
    const { fetch: f } = fakeFetch({
      '/api/entitlement/currentSubscription': { body: { success: false, code: '401', message: 'NOT_LOGIN' } },
      '/api/entitlement/quota': { body: { success: true, data: { refreshCountdownSeconds: 86400 } } },
      '/api/auth/userinfo': { body: { success: true, data: { userLevel: 'freeMember' } } },
    })
    const result = await fetchAccioBalanceDetailed(cred(), { fetcher: f })
    expect(result.balance).toBeNull()
    expect(result.error).toContain('未登录')
    expect(result.error).toContain('NOT_LOGIN')
  })

  it('未登录判据认**数字** code（String() 归一，防方向性误诊）', async () => {
    const { fetch: f } = fakeFetch({
      '/api/entitlement/currentSubscription': { body: { success: false, code: 401, message: 'unauthorized' } },
    })
    const result = await fetchAccioBalanceDetailed(cred(), { fetcher: f })
    expect(result.balance).toBeNull()
    expect(result.error).toContain('未登录')
  })

  it('查询失败 ⇒ balance:null + 原因（**不编造 0**）', async () => {
    const { fetch: f } = fakeFetch({
      '/api/entitlement/currentSubscription': { status: 503, body: { success: false, message: 'upstream busy' } },
    })
    const result = await fetchAccioBalanceDetailed(cred(), { fetcher: f })
    expect(result.balance).toBeNull()
    expect(result.error).toContain('积分查询失败')
    expect(result.error).toContain('upstream busy')
  })

  it('响应「成功」但既无桶也无总余额 ⇒ 明说未包含余额字段，且**不发**后两个请求', async () => {
    const { fetch: f, calls } = fakeFetch({
      '/api/entitlement/currentSubscription': { body: { success: true, data: { entitlement: {} } } },
    })
    const result = await fetchAccioBalanceDetailed(cred(), { fetcher: f })
    expect(result.balance).toBeNull()
    expect(result.error).toContain('未包含余额字段')
    // 形状判据必须排在两个可容忍请求之前（先发就是白发）
    expect(calls).toHaveLength(1)
  })

  it('服务端只给总余额（entitlement:{}）时补一个「可用积分」包', async () => {
    const { fetch: f } = fakeFetch({
      '/api/entitlement/currentSubscription': { body: { success: true, data: { remaining: 42 } } },
      '/api/entitlement/quota': { body: { success: true, data: { refreshCountdownSeconds: 3600 } } },
      '/api/auth/userinfo': { body: { success: true, data: {} } },
    })
    const result = await fetchAccioBalanceDetailed(cred(), { fetcher: f })
    expect(result.balance?.total).toBe(42)
    expect(result.balance?.packages).toHaveLength(1)
    expect(result.balance?.packages[0]!.name).toBe('可用积分')
    // extra 缺席（userLevel 读不到）—— 面板据此整行不渲染
    expect(result.extra).toBeUndefined()
  })

  it('空 token 本地短路：不发任何请求', async () => {
    const { fetch: f, calls } = fakeFetch({})
    const result = await fetchAccioBalanceDetailed(cred({ access_token: '' }), { fetcher: f })
    expect(result.balance).toBeNull()
    expect(result.error).toContain('未登录')
    expect(calls).toHaveLength(0)
  })

  it('桶全为 0 时如实返回 total:0（那是「已用光」，与 null 严格区分）', async () => {
    const { fetch: f } = fakeFetch({
      '/api/entitlement/currentSubscription': {
        body: { success: true, data: { remaining: 0, entitlement: { daily: { total: 100, used: 100, remaining: 0 } } } },
      },
      '/api/entitlement/quota': { body: { success: true, data: { refreshCountdownSeconds: 86400 } } },
      '/api/auth/userinfo': { body: { success: true, data: { userLevel: 'freeMember' } } },
    })
    const result = await fetchAccioBalanceDetailed(cred(), { fetcher: f })
    expect(result.balance?.total).toBe(0)
    expect(result.error).toBeUndefined()
  })

  it('请求发往 gateway（与区域无关）， Accept 头照实测只发这一个', async () => {
    const { fetch: f, calls } = fakeFetch({
      '/api/entitlement/currentSubscription': { body: { success: true, data: { remaining: 1 } } },
      '/api/entitlement/quota': { body: { success: true, data: {} } },
      '/api/auth/userinfo': { body: { success: true, data: {} } },
    })
    await fetchAccioBalanceDetailed(cred({ region: 'global' }), { fetcher: f })
    expect(calls[0]!.url.startsWith(`${ACCIO.gatewayBaseUrl}/api/entitlement/currentSubscription`)).toBe(true)
    const headers = calls[0]!.init.headers as Record<string, string>
    // 只读端点照实测只发 Accept（不把推理端的 appKey/version/utdid 顺手带过来）
    expect(Object.keys(headers)).toEqual(['Accept'])
  })
})
