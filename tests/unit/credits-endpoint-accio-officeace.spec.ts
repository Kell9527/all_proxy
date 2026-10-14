import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AccountPool } from '../../src/pool/account-pool.js'
import { FileCredentialStore } from '../../src/pool/store.js'
import { CREDIT_EXPIRY_WINDOW_DAYS, fetchBalances } from '../../src/admin/credits-endpoint.js'
import type { ProviderAccountEntry } from '../../src/pool/types.js'

/**
 * 管理端积分端点对 **accio / officeace** 两个新分支的回归测试。
 *
 * 守三件事：
 * 1. 分支真的接上了（`provider X 不支持积分余额查询` 是接入前的老错误）；
 * 2. `extra`（账号规格）与 `windowDays`（分桶窗口）随响应回流 —— 少了它们
 *    前端「账号规格」行与「长期/临期」分桶会静默不渲染；
 * 3. 失败带**原因**而不是把 balance 压成 null 什么都不说。
 */

function entry(overrides: Partial<ProviderAccountEntry> = {}): ProviderAccountEntry {
  return {
    id: 'accio-001',
    provider: 'accio',
    nickname: 'accio-ba15f06d',
    enabled: true,
    credentialRef: 'ACCIO_ACCOUNT_3CC14F48',
    createdAt: Date.now(),
    refreshable: true,
    ...overrides,
  }
}

describe('credits 端点：accio / officeace', () => {
  let dir: string
  let credentials: FileCredentialStore
  let pool: AccountPool

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'all-proxy-credits-endpoint-'))
    credentials = new FileCredentialStore(dir)
    pool = new AccountPool({ credentials, dataDir: dir })
    await pool.addAccount(entry())
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('accio：聚合三端点，extra.accountTier 与 windowDays 一起回流', async () => {
    await credentials.set('ACCIO_ACCOUNT_3CC14F48', JSON.stringify({
      access_token: 'tok',
      refresh_token: 'rt',
      expires_at: Date.now() + 3_600_000,
      region: 'cn',
    }))
    const fetcher = vi.fn(async (url: string) => {
      if (url.includes('/api/entitlement/currentSubscription')) {
        return new Response(JSON.stringify({
          success: true,
          data: {
            remaining: 800,
            entitlement: {
              daily: { total: 100, used: 0, remaining: 100 },
              monthly: { total: 0, used: 0, remaining: 0 },
              referral: { total: 700, used: 0, remaining: 700 },
            },
          },
        }), { status: 200 })
      }
      if (url.includes('/api/entitlement/quota')) {
        return new Response(JSON.stringify({ success: true, data: { refreshCountdownSeconds: 86400 } }), { status: 200 })
      }
      return new Response(JSON.stringify({ success: true, data: { userLevel: 'freeMember' } }), { status: 200 })
    }) as unknown as typeof fetch

    const result = await fetchBalances('accio', { pool, credentials, fetcher })
    expect(result.accounts).toHaveLength(1)
    const item = result.accounts[0]!
    expect(item.error).toBeUndefined()
    expect(item.balance?.total).toBe(800)
    expect(item.balance?.packages.map((p) => p.name)).toEqual(['每日积分', '每月积分', '推荐积分'])
    // 账号规格（面板「账号规格」行的数据源）
    expect(item.extra?.accountTier?.label).toBe('Free')
    // 分桶窗口必须随响应下发（前端不再各自写默认值）
    expect(result.windowDays).toBe(CREDIT_EXPIRY_WINDOW_DAYS)
  })

  it('accio：未登录 ⇒ error 提示重新登录（不是一句「查询失败」）', async () => {
    await credentials.set('ACCIO_ACCOUNT_3CC14F48', JSON.stringify({
      access_token: 'tok', refresh_token: 'rt', expires_at: Date.now() + 3_600_000, region: 'cn',
    }))
    const fetcher = vi.fn(async () => new Response(
      JSON.stringify({ success: false, code: '401', message: 'NOT_LOGIN' }), { status: 200 },
    )) as unknown as typeof fetch

    const result = await fetchBalances('accio', { pool, credentials, fetcher })
    expect(result.accounts[0]!.balance).toBeNull()
    expect(result.accounts[0]!.error).toContain('未登录')
  })

  it('officeace：云侧直读 + 自动领取，映射成 CreditBalance', async () => {
    await pool.addAccount(entry({ id: 'officeace-001', provider: 'officeace', credentialRef: 'OFFICEACE_ACCOUNT_6A0E26BA' }))
    await credentials.set('OFFICEACE_ACCOUNT_6A0E26BA', JSON.stringify({
      modelAppKey: 'ak', modelAppSecret: 'sk', maasBaseUrl: 'https://maas.example.com',
      access: 'AK', secret: 'SK', securityToken: 'STS', projectId: 'p',
      expiresAt: new Date(Date.now() + 7_200_000).toISOString(),
      refreshToken: 'rt', dpopPrivateJwk: { kty: 'EC', crv: 'P-256', x: 'x', y: 'y' },
    }))
    const fetcher = vi.fn(async (url: string) => {
      if (url.includes('/bonus/claim')) return new Response(JSON.stringify({ bonus_skus: [] }), { status: 200 })
      return new Response(JSON.stringify({
        skus: [
          { sku_name: '永久套餐', sku_code: 'p-forever', quotas: [{ sku_attr_code: 'officeace_points', sku_value: 500, current_value: 0 }] },
          { sku_name: '长期套餐', sku_code: 'p-long', quotas: [{ sku_attr_code: 'officeace_points', sku_value: 4000, current_value: 0, expired_time: '2099-12-31T00:00:00Z' }] },
          { sku_name: '临期套餐', sku_code: 'p-soon', quotas: [{ sku_attr_code: 'officeace_points', sku_value: 2000, current_value: 0, expired_time: '2099-06-01T00:00:00Z' }] },
        ],
        bonus_skus: [],
      }), { status: 200 })
    }) as unknown as typeof fetch

    const result = await fetchBalances('officeace', { pool, credentials, fetcher })
    const item = result.accounts[0]!
    expect(item.error).toBeUndefined()
    expect(item.balance?.total).toBe(6500)
    expect(item.balance?.packages).toHaveLength(3)
    expect(result.windowDays).toBe(CREDIT_EXPIRY_WINDOW_DAYS)
  })

  it('officeace：上游 503 ⇒ 带原因失败（不编造 0）', async () => {
    await pool.addAccount(entry({ id: 'officeace-002', provider: 'officeace', credentialRef: 'OFFICEACE_ACCOUNT_DOWN' }))
    await credentials.set('OFFICEACE_ACCOUNT_DOWN', JSON.stringify({
      modelAppKey: 'ak', modelAppSecret: 'sk', maasBaseUrl: 'https://maas.example.com',
      access: 'AK', secret: 'SK', securityToken: 'STS', projectId: 'p',
      expiresAt: new Date(Date.now() + 7_200_000).toISOString(),
      refreshToken: 'rt', dpopPrivateJwk: { kty: 'EC', crv: 'P-256', x: 'x', y: 'y' },
    }))
    const fetcher = vi.fn(async () => new Response('', { status: 503 })) as unknown as typeof fetch

    const result = await fetchBalances('officeace', { pool, credentials, fetcher })
    expect(result.accounts[0]!.balance).toBeNull()
    expect(result.accounts[0]!.error).toContain('积分查询失败')
  })

  it('未接入的 provider 仍然显式报错（不静默返回空）', async () => {
    await expect(fetchBalances('sensenova', { pool, credentials, fetcher: fetch }))
      .rejects.toThrow(/不支持积分余额查询/)
  })
})
