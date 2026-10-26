import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  claimOfficeAceDailyBonus,
  fetchOfficeAceBalanceDetailed,
  fetchOfficeAceCloudSubscription,
  maybeClaimOfficeAceBonus,
  officeAceDayKey,
  parseOfficeAceSubscription,
  resetOfficeAceBonusClaimThrottle,
} from '../../src/providers/officeace-credits.js'
import type { OfficeAceCredential } from '../../src/providers/officeace-auth.js'
import { OFFICEACE } from '../../src/providers/officeace-product.js'

/**
 * OfficeAce 积分查询的回归测试（V11-HMAC-SHA256 签名 + 云侧订阅直读）。
 *
 * 守的都是**移植时最容易丢的实现细节**（来源 `officeace-auth.ts` 的
 * `signAndRequest` 注释逐条列过，每条都曾导致 401）：
 * - GET **不带** `Content-Type`（POST 才带）；
 * - canonical 路径**强制尾斜杠**；
 * - 头行 **LF** 分隔、签名用小写头名；
 * - `Authorization` 的 Credential 前缀与 SignedHeaders 排序。
 */

function cred(overrides: Partial<OfficeAceCredential> = {}): OfficeAceCredential {
  return {
    modelAppKey: 'ak',
    modelAppSecret: 'sk',
    maasBaseUrl: OFFICEACE.defaultBaseUrl,
    access: 'AK-TEST',
    secret: 'SK-TEST',
    securityToken: 'STS-TOKEN',
    projectId: 'proj-1',
    expiresAt: new Date(Date.now() + 7_200_000).toISOString(),
    refreshToken: 'rt',
    dpopPrivateJwk: { kty: 'EC', crv: 'P-256', x: 'x', y: 'y' },
    ...overrides,
  }
}

/** 造 fetch 替身；返回全部调用的 URL 与请求头。 */
function fakeFetch(handler: (url: string, init: RequestInit) => Response) {
  const calls: Array<{ url: string; init: RequestInit }> = []
  const impl = vi.fn(async (url: string, init: RequestInit) => {
    calls.push({ url, init })
    return handler(url, init)
  })
  return { fetch: impl as unknown as typeof fetch, calls }
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status })
}

afterEach(() => {
  resetOfficeAceBonusClaimThrottle()
})

describe('officeace-credits：V11 签名', () => {
  it('GET 不带 Content-Type，且带齐 x-subscription-type / X-Sdk-Date / X-Security-Token / Host', async () => {
    const { fetch: f, calls } = fakeFetch(() => json({
      skus: [{ sku_name: '体验版套餐', sku_code: 'p.trial', quotas: [{ sku_attr_code: 'officeace_points', sku_value: 500, current_value: 0 }] }],
    }))
    await fetchOfficeAceCloudSubscription(cred(), f)
    expect(calls).toHaveLength(1)
    const headers = calls[0]!.init.headers as Record<string, string>
    // 规则 1：GET 不发 Content-Type（多一个头签名串就多一行，服务端重算必不匹配）
    expect(headers['Content-Type']).toBeUndefined()
    expect(headers['x-subscription-type']).toBe('v2')
    expect(headers['X-Security-Token']).toBe('STS-TOKEN')
    expect(headers['Host']).toBe(new URL(OFFICEACE.defaultBaseUrl).host)
    // xdate 形态：yyyyMMddTHHmmssZ
    expect(headers['X-Sdk-Date']).toMatch(/^\d{8}T\d{6}Z$/)
    // projectId 非空才带
    expect(headers['X-Project-ID']).toBe('proj-1')
  })

  it('Authorization 形状正确（Credential 前缀 + 排序的 SignedHeaders + 64 位 hex 签名）', async () => {
    const { fetch: f, calls } = fakeFetch(() => json({
      skus: [{ sku_name: '套餐', sku_code: 'p1', quotas: [{ sku_attr_code: 'officeace_points', sku_value: 1, current_value: 0 }] }],
    }))
    await fetchOfficeAceCloudSubscription(cred(), f)
    const auth = (calls[0]!.init.headers as Record<string, string>)['Authorization']!
    expect(auth.startsWith('V11-HMAC-SHA256 Credential=AK-TEST/')).toBe(true)
    // scope = yyyyMMdd/cn-southwest-2/apic
    expect(auth).toMatch(/Credential=AK-TEST\/\d{8}\/cn-southwest-2\/apic,/)
    const signed = /SignedHeaders=([^,]+),/.exec(auth)![1]!
    // 签名用小写头名且排序
    expect(signed.split(';')).toEqual([...signed.split(';')].sort())
    expect(signed).toContain('x-sdk-date')
    expect(signed).toContain('x-security-token')
    // GET 的签名集合里**不得**出现 content-type
    expect(signed).not.toContain('content-type')
    const sig = /Signature=([0-9a-f]{64})$/.exec(auth)![1]!
    expect(sig).toMatch(/^[0-9a-f]{64}$/)
  })

  it('POST（每日福利领取）带 Content-Type 且它进入签名头集合', async () => {
    const { fetch: f, calls } = fakeFetch(() => json({ bonus_skus: [] }))
    await claimOfficeAceDailyBonus(cred(), f)
    const headers = calls[0]!.init.headers as Record<string, string>
    expect(headers['Content-Type']).toBe('application/json;charset=utf8')
    const signed = /SignedHeaders=([^,]+),/.exec(headers['Authorization']!)![1]!
    expect(signed).toContain('content-type')
  })
  it('签名随凭据变化（access/secret 换一对，Authorization 必须不同）', async () => {
    const seen: string[] = []
    const grab = fakeFetch(() => json({
      skus: [{ sku_name: '套餐', sku_code: 'p1', quotas: [{ sku_attr_code: 'officeace_points', sku_value: 1, current_value: 0 }] }],
    }))
    await fetchOfficeAceCloudSubscription(cred(), grab.fetch)
    seen.push((grab.calls[0]!.init.headers as Record<string, string>)['Authorization']!)
    await fetchOfficeAceCloudSubscription(cred({ access: 'AK-OTHER', secret: 'SK-OTHER' }), grab.fetch)
    seen.push((grab.calls[1]!.init.headers as Record<string, string>)['Authorization']!)
    expect(seen[0]).not.toBe(seen[1])
  })

  it('请求发往 {defaultBaseUrl}/v1/subscription（**不是**凭据里按账号下发的 maasBaseUrl）', async () => {
    const { fetch: f, calls } = fakeFetch(() => json({
      skus: [{ sku_name: '套餐', sku_code: 'p1', quotas: [{ sku_attr_code: 'officeace_points', sku_value: 1, current_value: 0 }] }],
    }))
    await fetchOfficeAceCloudSubscription(cred({ maasBaseUrl: 'https://account-specific.example.com' }), f)
    expect(calls[0]!.url).toBe(`${OFFICEACE.defaultBaseUrl}/v1/subscription`)
  })
})

describe('officeace-credits：订阅归一化', () => {
  it('plan 桶与 bonus 桶分别归一化，trial 不给 expiresAt（视为永久）', () => {
    const summary = parseOfficeAceSubscription(JSON.stringify({
      skus: [{
        sku_name: '体验版套餐', sku_code: 'officeace-pro.trial',
        quotas: [{ sku_attr_code: 'officeace_points', sku_value: 500, current_value: 100, expired_time: '2099-01-01T00:00:00Z' }],
      }],
      bonus_skus: [
        { activity_id: 'daily-checkin', activity_name: '每日签到', points: 1000, current_value: 0, expired_time: '2099-02-02T00:00:00Z' },
        // ⚠️ points:null 时 Number(null)===0（isFinite 挡不住）⇒ 产出一个
        //    remaining 0 的桶 —— 这是**来源的如实行为**（Number + isFinite
        //    判据逐字保留），不是缺陷；断言锁死它，防将来「顺手修」成跳过。
        { activity_id: 'no-points', activity_name: '坏活动', points: null, current_value: 0 },
      ],
    }))
    expect(summary).toBeDefined()
    expect(summary!.planName).toBe('体验版套餐')
    // 套餐桶：trial 不给 expiresAt、不算过期
    const plan = summary!.creditGroups.find((g) => g.kind === 'plan')!
    expect(plan.remaining).toBe(400)
    expect(plan.expiresAt).toBeUndefined()
    expect(plan.expired).toBe(false)
    // bonus 桶
    const bonus = summary!.creditGroups.find((g) => g.kind === 'bonus')!
    expect(bonus.name).toBe('每日签到')
    expect(bonus.remaining).toBe(1000)
    expect(summary!.creditGroups).toHaveLength(3)
    expect(summary!.creditGroups.find((g) => g.name === '坏活动')!.remaining).toBe(0)
    // 总量只算未过期桶（0 桶不影响合计）
    expect(summary!.totalCredits).toBe(1400)
  })

  it('已过期的桶标 expired 且不计入总量', () => {
    const summary = parseOfficeAceSubscription(JSON.stringify({
      skus: [{
        sku_name: '长期套餐', sku_code: 'p-long',
        quotas: [{ sku_attr_code: 'officeace_points', sku_value: 4000, current_value: 0, expired_time: '2020-01-01T00:00:00Z' }],
      }],
    }))
    const plan = summary!.creditGroups[0]!
    expect(plan.expired).toBe(true)
    expect(plan.expiresAt).toBe('2020-01-01T00:00:00Z')
    expect(summary!.totalCredits).toBe(0)
  })

  it('没有 officeace_points 配额的 sku 不产桶；全空时返回 undefined', () => {
    expect(parseOfficeAceSubscription(JSON.stringify({ skus: [{ sku_code: 'x', quotas: [{ sku_attr_code: 'other', sku_value: 1 }] }] })))
      .toBeUndefined()
    expect(parseOfficeAceSubscription('not-json')).toBeUndefined()
  })
})

describe('officeace-credits：fetchOfficeAceBalanceDetailed', () => {
  const SUBSCRIPTION = {
    skus: [
      { sku_name: '永久套餐', sku_code: 'p-forever', quotas: [{ sku_attr_code: 'officeace_points', sku_value: 500, current_value: 0 }] },
      { sku_name: '长期套餐', sku_code: 'p-long', quotas: [{ sku_attr_code: 'officeace_points', sku_value: 4000, current_value: 0, expired_time: '2099-12-31T00:00:00Z' }] },
      { sku_name: '临期套餐', sku_code: 'p-soon', quotas: [{ sku_attr_code: 'officeace_points', sku_value: 2000, current_value: 0, expired_time: '2099-06-01T00:00:00Z' }] },
    ],
    bonus_skus: [],
  }

  it('先自动领当日福利再查余额（顺序不能反：先查就永远少显示那一份）', async () => {
    const order: string[] = []
    const { fetch: f } = fakeFetch((url) => {
      order.push(url)
      if (url.endsWith('/bonus/claim')) return json({ bonus_skus: [] })
      return json(SUBSCRIPTION)
    })
    const result = await fetchOfficeAceBalanceDetailed(cred(), 'OFFICEACE_ACCOUNT_T1', f)
    expect(result.error).toBeUndefined()
    expect(order).toHaveLength(2)
    expect(order[0]).toContain('/v1/subscription/bonus/claim')
    expect(order[1]).toContain('/v1/subscription')
  })

  it('余额映射：unit=Token、到期时间进 expiredTime（前端分桶判据）', async () => {
    const { fetch: f } = fakeFetch((url) => (
      url.endsWith('/bonus/claim') ? json({ bonus_skus: [] }) : json(SUBSCRIPTION)
    ))
    const result = await fetchOfficeAceBalanceDetailed(cred(), 'OFFICEACE_ACCOUNT_T1', f)
    expect(result.balance?.total).toBe(6500)
    const packages = result.balance!.packages
    expect(packages.every((p) => p.unit === OFFICEACE.quotaUnit)).toBe(true)
    // 永久桶（无 expired_time）：expiredTime 空串 ⇒ 前端判「永久」
    expect(packages.find((p) => p.name === '永久套餐')!.expiredTime).toBe('')
    // 长期桶：ISO 串原样带出
    expect(packages.find((p) => p.name === '长期套餐')!.expiredTime).toBe('2099-12-31T00:00:00Z')
    expect(packages.every((p) => p.active)).toBe(true)
  })

  it('同一 ref 每小时最多领一次（节流：面板每开一次就白发一个 claim 请求）', async () => {
    const { fetch: f } = fakeFetch((url) => (
      url.endsWith('/bonus/claim') ? json({ bonus_skus: [] }) : json(SUBSCRIPTION)
    ))
    await fetchOfficeAceBalanceDetailed(cred(), 'OFFICEACE_ACCOUNT_T1', f)
    await fetchOfficeAceBalanceDetailed(cred(), 'OFFICEACE_ACCOUNT_T1', f)
    const claims = f.mock.calls.filter(([url]) => String(url).endsWith('/bonus/claim'))
    expect(claims).toHaveLength(1)
    // 不同 ref 各自要领（共用一把锁会让第二个账号永远领不到）
    await fetchOfficeAceBalanceDetailed(cred(), 'OFFICEACE_ACCOUNT_T2', f)
    expect(f.mock.calls.filter(([url]) => String(url).endsWith('/bonus/claim'))).toHaveLength(2)
  })

  it('凭据缺 STS 访问键 ⇒ 提示重新登录（不发请求）', async () => {
    const { fetch: f, calls } = fakeFetch(() => json({}))
    const result = await fetchOfficeAceBalanceDetailed(cred({ access: '' }), 'REF', f)
    expect(result.balance).toBeNull()
    expect(result.error).toContain('重新登录')
    expect(calls).toHaveLength(0)
  })

  it('云侧非 2xx / 网络异常 ⇒ balance:null + 原因（不编造 0）', async () => {
    const { fetch: f } = fakeFetch((url) => (
      url.endsWith('/bonus/claim') ? json({ bonus_skus: [] }) : json({}, 503)
    ))
    const result = await fetchOfficeAceBalanceDetailed(cred(), 'REF', f)
    expect(result.balance).toBeNull()
    expect(result.error).toContain('积分查询失败')
  })

  it('签到失败不阻断余额查询（bonus/claim 500 仍照常返回余额）', async () => {
    const { fetch: f } = fakeFetch((url) => (
      url.endsWith('/bonus/claim') ? json({}, 500) : json(SUBSCRIPTION)
    ))
    const result = await fetchOfficeAceBalanceDetailed(cred(), 'REF', f)
    expect(result.balance?.total).toBe(6500)
  })
})

describe('officeace-credits：每日福利领取的结果分类', () => {
  it('领到新桶 ⇒ kind=claimed 并带出活动与分值', async () => {
    const { fetch: f } = fakeFetch(() => json({
      bonus_skus: [{ activity_id: 'bonus-daily-checkin-2026', activity_name: '每日签到有礼', points: 100 }],
    }))
    const result = await claimOfficeAceDailyBonus(cred(), f)
    expect(result.kind).toBe('claimed')
    expect(result.claimed).toEqual([
      { activityId: 'bonus-daily-checkin-2026', activityName: '每日签到有礼', points: 100 },
    ])
  })

  it('上游回 200 但空桶 ⇒ kind=empty（实测即「今天已经领过」）', async () => {
    // 2026-10-23 对已领账号实测：HTTP 200 + {"bonus_skus":[]}
    const { fetch: f } = fakeFetch(() => json({ bonus_skus: [] }))
    expect((await claimOfficeAceDailyBonus(cred(), f)).kind).toBe('empty')
  })

  it('非 2xx ⇒ kind=failed（不可与 empty 混淆：后者不该重试）', async () => {
    const { fetch: f } = fakeFetch(() => json({}, 500))
    expect((await claimOfficeAceDailyBonus(cred(), f)).kind).toBe('failed')
  })

  it('2xx 但不是 JSON ⇒ kind=failed（重试有意义）', async () => {
    const { fetch: f } = fakeFetch(() => new Response('<html>gateway</html>', { status: 200 }))
    expect((await claimOfficeAceDailyBonus(cred(), f)).kind).toBe('failed')
  })

  it('凭据缺 STS ⇒ failed 且不发请求', async () => {
    const { fetch: f, calls } = fakeFetch(() => json({ bonus_skus: [] }))
    const result = await claimOfficeAceDailyBonus(cred({ securityToken: '' }), f)
    expect(result.kind).toBe('failed')
    expect(calls).toHaveLength(0)
  })
})

describe('officeace-credits：领取去重（UTC+8 自然日）', () => {
  it('officeAceDayKey 取 UTC+8 日界，不取本机时区', () => {
    // UTC 2026-10-22T16:30Z = 北京时间 2026-10-23 00:30 ⇒ 属于 10-23
    expect(officeAceDayKey(new Date('2026-10-22T16:30:00Z'))).toBe('2026-10-23')
    // UTC 2026-10-23T15:59Z = 北京时间 23:59，仍是 10-23
    expect(officeAceDayKey(new Date('2026-10-23T15:59:00Z'))).toBe('2026-10-23')
    // UTC 2026-10-23T16:00Z = 北京时间次日 00:00 ⇒ 进入 10-24
    expect(officeAceDayKey(new Date('2026-10-23T16:00:00Z'))).toBe('2026-10-24')
  })

  it('同一 UTC+8 自然日内成功领取后不再打上游', async () => {
    const { fetch: f } = fakeFetch(() => json({ bonus_skus: [] }))
    const at = Date.parse('2026-10-23T01:00:00Z')
    await maybeClaimOfficeAceBonus(cred(), 'REF_A', f, () => at)
    expect(await maybeClaimOfficeAceBonus(cred(), 'REF_A', f, () => at + 60_000)).toBeUndefined()
    expect(f).toHaveBeenCalledTimes(1)
  })

  it('跨 UTC+8 自然日后重新领取', async () => {
    const { fetch: f } = fakeFetch(() => json({ bonus_skus: [] }))
    const day1 = Date.parse('2026-10-23T01:00:00Z')
    await maybeClaimOfficeAceBonus(cred(), 'REF_B', f, () => day1)
    // 次日（UTC 16:00 之后即北京次日）
    const day2 = Date.parse('2026-10-23T16:30:00Z')
    expect(await maybeClaimOfficeAceBonus(cred(), 'REF_B', f, () => day2)).toBeDefined()
    expect(f).toHaveBeenCalledTimes(2)
  })

  it('**失败不记日期**：网络抖动后当天仍会重试（早期实现会白丢当天额度）', async () => {
    let fail = true
    const { fetch: f } = fakeFetch(() => (fail ? json({}, 503) : json({
      bonus_skus: [{ activity_id: 'bonus-daily-checkin-2026', activity_name: '每日签到有礼', points: 100 }],
    })))
    const at = Date.parse('2026-10-23T01:00:00Z')
    const first = await maybeClaimOfficeAceBonus(cred(), 'REF_C', f, () => at)
    expect(first?.kind).toBe('failed')
    // 冷却期内不重试（避免面板与定时器连续打上游）
    expect(await maybeClaimOfficeAceBonus(cred(), 'REF_C', f, () => at + 60_000)).toBeUndefined()
    // 冷却结束后**真的重试**（说明失败没有被记成「今天已领」）
    fail = false
    const later = await maybeClaimOfficeAceBonus(cred(), 'REF_C', f, () => at + 11 * 60_000)
    expect(later?.kind).toBe('claimed')
  })

  it('不同 ref 各自领取（共用一把锁会让第二个账号永远领不到）', async () => {
    const { fetch: f } = fakeFetch(() => json({ bonus_skus: [] }))
    const at = Date.parse('2026-10-23T01:00:00Z')
    await maybeClaimOfficeAceBonus(cred(), 'REF_D1', f, () => at)
    await maybeClaimOfficeAceBonus(cred(), 'REF_D2', f, () => at)
    expect(f).toHaveBeenCalledTimes(2)
  })
})

/**
 * 手动补领（面板按钮）：`force: true` 必须跳过两道闸门。
 *
 * 用户点按钮就是明确要求「现在就试一次」。若被去重表静默忽略，按钮看起来
 * 就是坏的 —— 这正是要防的形态。
 */
describe('officeace-credits：手动补领（force）', () => {
  it('force 跳过「今天已领」闸门，真的重打上游', async () => {
    const { fetch: f } = fakeFetch(() => json({ bonus_skus: [] }))
    const at = Date.parse('2026-10-23T01:00:00Z')
    await maybeClaimOfficeAceBonus(cred(), 'REF_F1', f, () => at)
    expect(f).toHaveBeenCalledTimes(1)
    // 不带 force：被去重表挡住
    expect(await maybeClaimOfficeAceBonus(cred(), 'REF_F1', f, () => at)).toBeUndefined()
    expect(f).toHaveBeenCalledTimes(1)
    // 带 force：照常请求
    const forced = await maybeClaimOfficeAceBonus(cred(), 'REF_F1', f, () => at, { force: true })
    expect(forced?.kind).toBe('empty')
    expect(f).toHaveBeenCalledTimes(2)
  })

  it('force 跳过失败冷却期（用户不想等 10 分钟）', async () => {
    let fail = true
    const { fetch: f } = fakeFetch(() => (fail ? json({}, 503) : json({
      bonus_skus: [{ activity_id: 'bonus-daily-checkin-2026', activity_name: '每日签到有礼', points: 100 }],
    })))
    const at = Date.parse('2026-10-23T01:00:00Z')
    expect((await maybeClaimOfficeAceBonus(cred(), 'REF_F2', f, () => at))?.kind).toBe('failed')
    // 冷却期内不带 force ⇒ 跳过
    expect(await maybeClaimOfficeAceBonus(cred(), 'REF_F2', f, () => at + 1000)).toBeUndefined()
    // 带 force ⇒ 立刻重试
    fail = false
    const forced = await maybeClaimOfficeAceBonus(cred(), 'REF_F2', f, () => at + 2000, { force: true })
    expect(forced?.kind).toBe('claimed')
  })

  it('force 领取成功后仍更新去重表（定时任务不会重复打上游）', async () => {
    const { fetch: f } = fakeFetch(() => json({
      bonus_skus: [{ activity_id: 'bonus-daily-checkin-2026', activity_name: '每日签到有礼', points: 100 }],
    }))
    const at = Date.parse('2026-10-23T01:00:00Z')
    await maybeClaimOfficeAceBonus(cred(), 'REF_F3', f, () => at, { force: true })
    expect(f).toHaveBeenCalledTimes(1)
    // 随后的定时任务（不带 force）应被挡住
    expect(await maybeClaimOfficeAceBonus(cred(), 'REF_F3', f, () => at + 60_000)).toBeUndefined()
    expect(f).toHaveBeenCalledTimes(1)
  })
})
