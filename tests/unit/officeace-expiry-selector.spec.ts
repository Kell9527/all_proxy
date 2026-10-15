import { describe, expect, it, vi } from 'vitest'
import {
  OFFICEACE_EXPIRY_CACHE_TTL_MS,
  OfficeAceExpirySelector,
} from '../../src/providers/officeace-expiry-selector.js'
import { OFFICEACE_EXPIRY_TIER } from '../../src/providers/officeace-expiry-rank.js'
import type { OfficeAceCredential } from '../../src/providers/officeace-auth.js'
import { OFFICEACE } from '../../src/providers/officeace-product.js'

/**
 * OfficeAce「临期优先」选号器的回归测试。
 *
 * 守四件事：TTL 缓存（别把选号变成 N 次网络请求）、**查询失败不抛错**
 * （降级成手动顺序）、档位优先级、锁定永久积分时「只剩永久桶 ⇒ 无可用账号」。
 */

const NOW = Date.UTC(2026, 9, 15, 12, 0, 0)
const DAY = 24 * 60 * 60 * 1000

function cred(overrides: Partial<OfficeAceCredential> = {}): OfficeAceCredential {
  return {
    modelAppKey: 'ak',
    modelAppSecret: 'sk',
    maasBaseUrl: OFFICEACE.defaultBaseUrl,
    access: 'AK-TEST',
    secret: 'SK-TEST',
    securityToken: 'STS-TOKEN',
    projectId: 'proj-1',
    expiresAt: new Date(NOW + 7_200_000).toISOString(),
    refreshToken: 'rt',
    dpopPrivateJwk: { kty: 'EC', crv: 'P-256', x: 'x', y: 'y' },
    ...overrides,
  }
}

/** 造一个 `/v1/subscription` 响应体（skus，桶按到期时间区分三档）。 */
function subscriptionBody(quotas: Array<{ remaining: number; expiresAt?: string }>): unknown {
  return {
    skus: [{
      sku_name: '套餐',
      sku_code: 'p1',
      quotas: quotas.map((q) => ({
        sku_attr_code: 'officeace_points',
        sku_value: q.remaining,
        current_value: 0,
        expired_time: q.expiresAt,
      })),
    }],
  }
}

/** 只有永久桶。 */
const PERMANENT_ONLY = subscriptionBody([{ remaining: 5000 }])
/** 只有长期桶。 */
const LONGTERM_ONLY = subscriptionBody([{ remaining: 4000, expiresAt: new Date(NOW + 30 * DAY).toISOString() }])
/** 只有临期桶。 */
const EXPIRING_ONLY = subscriptionBody([{ remaining: 2000, expiresAt: new Date(NOW + 3_600_000).toISOString() }])

/**
 * 按凭据的 `securityToken` 分派订阅响应的 fetch 替身。
 *
 * ⚠️ 用 `X-Security-Token` 而不是 `Authorization` 分派：后者是 V11 签名算出来的，
 * 测试里无法预计算；而前者逐字来自凭据字段（`signAndRequest` 直接放进请求头），
 * 既唯一又可控。
 */
function makeFetcher(byToken: Record<string, unknown | 'fail'>) {
  return vi.fn(async (_input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const token = String((init?.headers as Record<string, string> | undefined)?.['X-Security-Token'] ?? '')
    const spec = byToken[token]
    if (spec === undefined) throw new Error(`未预期的 securityToken: ${token}`)
    if (spec === 'fail') return new Response('', { status: 503 })
    return new Response(JSON.stringify(spec), { status: 200, headers: { 'content-type': 'application/json' } })
  })
}

/** 按 ref 返回不同凭据的解析器。 */
function makeResolver(byRef: Record<string, unknown>) {
  return async (ref: string): Promise<unknown> => byRef[ref]
}

/** 造一个 securityToken 唯一的凭据（供替身分派）。 */
function credWith(token: string): OfficeAceCredential {
  return cred({ securityToken: token, access: `AK-${token}`, secret: `SK-${token}` })
}

describe('OfficeAceExpirySelector.expiryOf', () => {
  it('查到订阅时按到期时间分成三桶', async () => {
    const fetcher = makeFetcher({
      'STS-1': subscriptionBody([
        { remaining: 2000, expiresAt: new Date(NOW + 3_600_000).toISOString() }, // 临期
        { remaining: 4000, expiresAt: new Date(NOW + 30 * DAY).toISOString() },  // 长期
        { remaining: 5000 },                                                     // 永久
      ]),
    })
    const selector = new OfficeAceExpirySelector({
      resolveCredential: makeResolver({ r1: credWith('STS-1') }),
      fetcher: fetcher as unknown as typeof fetch,
      now: () => NOW,
    })

    const entry = await selector.expiryOf({ id: 'a1', credentialRef: 'r1' })
    expect(entry.ok).toBe(true)
    expect(entry.expiring).toBe(2000)
    expect(entry.longTerm).toBe(4000)
    expect(entry.permanent).toBe(5000)
    expect(entry.earliestExpiringAt).toBe(NOW + 3_600_000)
  })

  it('上游非 2xx 时返回 ok:false 且带原因（不抛错）', async () => {
    const fetcher = makeFetcher({ 'STS-1': 'fail' })
    const selector = new OfficeAceExpirySelector({
      resolveCredential: makeResolver({ r1: credWith('STS-1') }),
      fetcher: fetcher as unknown as typeof fetch,
      now: () => NOW,
    })

    const entry = await selector.expiryOf({ id: 'a1', credentialRef: 'r1' })
    expect(entry.ok).toBe(false)
    expect(entry.error).toMatch(/积分查询失败/)
    // 三个分桶字段都不该编造数字
    expect(entry.expiring).toBeUndefined()
    expect(entry.longTerm).toBeUndefined()
    expect(entry.permanent).toBeUndefined()
  })

  it('凭据缺 access / securityToken 时返回 ok:false（不把 TypeError 冒泡成选号崩溃）', async () => {
    const fetcher = vi.fn() as unknown as typeof fetch
    const selector = new OfficeAceExpirySelector({
      resolveCredential: makeResolver({ r1: { modelAppKey: 'ak' } }),
      fetcher,
      now: () => NOW,
    })

    const entry = await selector.expiryOf({ id: 'a1', credentialRef: 'r1' })
    expect(entry.ok).toBe(false)
    expect(entry.error).toMatch(/凭据/)
    // 一个请求都不该发出去（形状校验在请求之前）
    expect(fetcher).not.toHaveBeenCalled()
  })

  it('凭据未配置时返回 ok:false', async () => {
    const selector = new OfficeAceExpirySelector({
      resolveCredential: makeResolver({}),
      fetcher: vi.fn() as unknown as typeof fetch,
      now: () => NOW,
    })
    const entry = await selector.expiryOf({ id: 'a1', credentialRef: 'missing' })
    expect(entry.ok).toBe(false)
    expect(entry.error).toMatch(/凭据/)
  })

  it('凭据解析抛错时也返回 ok:false（不冒泡）', async () => {
    const selector = new OfficeAceExpirySelector({
      resolveCredential: async () => { throw new Error('boom') },
      fetcher: vi.fn() as unknown as typeof fetch,
      now: () => NOW,
    })
    const entry = await selector.expiryOf({ id: 'a1', credentialRef: 'r1' })
    expect(entry.ok).toBe(false)
    expect(entry.error).toMatch(/boom/)
  })
})

describe('OfficeAceExpirySelector 缓存', () => {
  it('TTL 内重复查同一账号只发一次请求', async () => {
    const fetcher = makeFetcher({ 'STS-1': PERMANENT_ONLY })
    let now = NOW
    const selector = new OfficeAceExpirySelector({
      resolveCredential: makeResolver({ r1: credWith('STS-1') }),
      fetcher: fetcher as unknown as typeof fetch,
      now: () => now,
    })

    await selector.expiryOf({ id: 'a1', credentialRef: 'r1' })
    now += OFFICEACE_EXPIRY_CACHE_TTL_MS - 1
    await selector.expiryOf({ id: 'a1', credentialRef: 'r1' })
    expect(fetcher).toHaveBeenCalledTimes(1)
  })

  it('超过 TTL 后重新查', async () => {
    const fetcher = makeFetcher({ 'STS-1': PERMANENT_ONLY })
    let now = NOW
    const selector = new OfficeAceExpirySelector({
      resolveCredential: makeResolver({ r1: credWith('STS-1') }),
      fetcher: fetcher as unknown as typeof fetch,
      now: () => now,
    })

    await selector.expiryOf({ id: 'a1', credentialRef: 'r1' })
    now += OFFICEACE_EXPIRY_CACHE_TTL_MS + 1
    await selector.expiryOf({ id: 'a1', credentialRef: 'r1' })
    expect(fetcher).toHaveBeenCalledTimes(2)
  })

  it('invalidate 立即失效（不指定 id 则全清）', async () => {
    const fetcher = makeFetcher({ 'STS-1': PERMANENT_ONLY })
    const selector = new OfficeAceExpirySelector({
      resolveCredential: makeResolver({ r1: credWith('STS-1') }),
      fetcher: fetcher as unknown as typeof fetch,
      now: () => NOW,
    })

    await selector.expiryOf({ id: 'a1', credentialRef: 'r1' })
    selector.invalidate('a1')
    await selector.expiryOf({ id: 'a1', credentialRef: 'r1' })
    expect(fetcher).toHaveBeenCalledTimes(2)

    selector.invalidate()
    await selector.expiryOf({ id: 'a1', credentialRef: 'r1' })
    expect(fetcher).toHaveBeenCalledTimes(3)
  })
})

describe('OfficeAceExpirySelector.select', () => {
  /** 两个账号的通用接线：a1 只有永久、a2 只有临期。 */
  function twoAccountSelector(a2Body: unknown = EXPIRING_ONLY) {
    return new OfficeAceExpirySelector({
      resolveCredential: makeResolver({ r1: credWith('STS-1'), r2: credWith('STS-2') }),
      fetcher: makeFetcher({ 'STS-1': PERMANENT_ONLY, 'STS-2': a2Body }) as unknown as typeof fetch,
      now: () => NOW,
    })
  }

  const TWO_CANDIDATES = [
    { id: 'a1', credentialRef: 'r1' },
    { id: 'a2', credentialRef: 'r2' },
  ]

  it('优先选有临期积分的账号（即使它在手动顺序里排最后）', async () => {
    const picked = await twoAccountSelector().select(TWO_CANDIDATES)
    expect(picked?.account.id).toBe('a2')
    expect(picked?.tier).toBe(OFFICEACE_EXPIRY_TIER.expiring)
    expect(picked?.expiry.expiring).toBe(2000)
  })

  it('都无临期时选有长期积分的', async () => {
    const picked = await twoAccountSelector(LONGTERM_ONLY).select(TWO_CANDIDATES)
    expect(picked?.account.id).toBe('a2')
    expect(picked?.tier).toBe(OFFICEACE_EXPIRY_TIER.longTerm)
  })

  it('只剩永久积分时选它（未锁定：让上游去报余额不足，错误更准确）', async () => {
    const selector = new OfficeAceExpirySelector({
      resolveCredential: makeResolver({ r1: credWith('STS-1') }),
      fetcher: makeFetcher({ 'STS-1': PERMANENT_ONLY }) as unknown as typeof fetch,
      now: () => NOW,
    })

    const picked = await selector.select([{ id: 'a1', credentialRef: 'r1' }])
    expect(picked?.account.id).toBe('a1')
    expect(picked?.tier).toBe(OFFICEACE_EXPIRY_TIER.permanent)
  })

  it('全部查询失败时退化为手动顺序（一次网络抖动不该改变用哪个号）', async () => {
    const selector = new OfficeAceExpirySelector({
      resolveCredential: makeResolver({ r1: credWith('STS-1'), r2: credWith('STS-2') }),
      fetcher: makeFetcher({ 'STS-1': 'fail', 'STS-2': 'fail' }) as unknown as typeof fetch,
      now: () => NOW,
    })

    const picked = await selector.select(TWO_CANDIDATES)
    expect(picked?.account.id).toBe('a1')
    expect(picked?.tier).toBe(OFFICEACE_EXPIRY_TIER.unknown)
  })

  it('锁定永久积分且所有账号都只剩永久桶 ⇒ 无可用账号', async () => {
    const picked = await twoAccountSelector(PERMANENT_ONLY).select(TWO_CANDIDATES, { allowPermanent: false })
    expect(picked).toBeUndefined()
  })

  it('锁定永久积分但有账号带临期桶 ⇒ 照常选它', async () => {
    const picked = await twoAccountSelector(EXPIRING_ONLY).select(TWO_CANDIDATES, { allowPermanent: false })
    expect(picked?.account.id).toBe('a2')
  })

  it('锁定永久积分且全部查询失败 ⇒ 无可用账号（不可因不确定就绕过锁定）', async () => {
    const selector = new OfficeAceExpirySelector({
      resolveCredential: makeResolver({ r1: credWith('STS-1') }),
      fetcher: makeFetcher({ 'STS-1': 'fail' }) as unknown as typeof fetch,
      now: () => NOW,
    })

    const picked = await selector.select([{ id: 'a1', credentialRef: 'r1' }], { allowPermanent: false })
    expect(picked).toBeUndefined()
  })

  it('候选为空时返回 undefined', async () => {
    const selector = new OfficeAceExpirySelector({
      resolveCredential: makeResolver({}),
      fetcher: vi.fn() as unknown as typeof fetch,
    })
    expect(await selector.select([])).toBeUndefined()
  })
})
