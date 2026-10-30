import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { AccountPool } from '../../src/pool/account-pool.js'
import { FileCredentialStore } from '../../src/pool/store.js'
import { ProviderRegistry } from '../../src/providers/registry.js'
import { createGatewayServer } from '../../src/gateway/server.js'
import { createAdminHandler } from '../../src/admin/router.js'
import { AdminAuth } from '../../src/admin/auth.js'
import { ApiKeyStore } from '../../src/auth/api-keys.js'
import { resetOfficeAceBonusClaimThrottle } from '../../src/providers/officeace-credits.js'
import { resetMagicrewClaimThrottle } from '../../src/providers/magicrew-credits.js'

/**
 * `POST /api/credits/daily-bonus` —— OfficeAce 补领当日福利的 API 层回归。
 *
 * 这一支存在的理由（用户要求「加个手动，防止定时任务没领到」）：服务端每小时
 * 自动领一次，但定时任务只在**进程活着**时跑。用户关掉服务过夜、或跨天后才
 * 启动时，当天的额度可能已经错过窗口（按 UTC+8 自然日作废）。
 *
 * 守四件事：
 * 1. 端点真的接上了（未接线时会落到「未知管理方法」或 404）；
 * 2. **手动跳过去重闸门**（`force: true`）—— 否则「今天定时任务已试过」会让
 *    用户点了毫无反应，看起来就是按钮坏了；
 * 3. 逐账号明细回流（面板要逐条如实显示「领到 / 早已领过 / 失败」）；
 * 4. 非法 provider 明确拒绝，不是悄悄成功。
 */

const adminSecretHolder = { secret: '' }

/** 远期有效的 OfficeAce 凭据 JSON（不触发续期，隔离网络分支）。 */
function officeAceCredentialJson(): string {
  return JSON.stringify({
    modelAppKey: 'ak',
    modelAppSecret: 'sk',
    maasBaseUrl: 'https://officeace.example.com',
    access: 'AK',
    secret: 'SK',
    securityToken: 'STS',
    projectId: 'proj',
    expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    refreshToken: 'rt',
    dpopPrivateJwk: { kty: 'EC', crv: 'P-256', x: 'x', y: 'y' },
  })
}

describe('POST /api/credits/daily-bonus（OfficeAce 补领当日福利）', () => {
  let dir: string
  let server: Server
  let url: string
  let pool: AccountPool
  let credentials: FileCredentialStore

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'all-proxy-daily-bonus-'))
    credentials = new FileCredentialStore(dir)
    pool = new AccountPool({ credentials, dataDir: dir })
    resetOfficeAceBonusClaimThrottle()

    const registry = new ProviderRegistry()
    const auth = new AdminAuth(dir, { info: () => {}, warn: () => {}, error: () => {} })
    const generated = auth.ensure(undefined, { minSecretLength: 4 })
    adminSecretHolder.secret = process.env['ALL_PROXY_ADMIN_SECRET']?.trim() || generated || ''

    server = createGatewayServer({
      registry,
      pool,
      port: 0,
      host: '127.0.0.1',
      admin: createAdminHandler({
        registry,
        pool,
        credentials,
        apiKeys: new ApiKeyStore(dir),
        auth,
        logger: { info: () => {}, warn: () => {}, error: () => {} },
        // 注入替身 fetch：端点层只验证「接线与 force 语义」，
        // 上游协议本身由 officeace-credits.spec.ts 覆盖。
        fetcher: vi.fn(async (input: RequestInfo | URL) => {
          if (String(input).includes('/v1/subscription/bonus/claim')) {
            return new Response(JSON.stringify({
              bonus_skus: [{ activity_id: 'bonus-daily-checkin-2026', activity_name: '每日签到有礼', points: 100 }],
            }), { status: 200 })
          }
          return new Response('{}', { status: 500 })
        }) as unknown as typeof fetch,
      }),
    })
    await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve) })
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  })

  afterEach(async () => {
    await new Promise<void>((resolve) => { server.close(() => resolve()) })
    rmSync(dir, { recursive: true, force: true })
    adminSecretHolder.secret = ''
  })

  const adminFetch = (path: string, init: RequestInit = {}): Promise<Response> =>
    fetch(`${url}${path}`, {
      ...init,
      headers: {
        'x-admin-secret': adminSecretHolder.secret,
        'Content-Type': 'application/json',
        ...(init.headers ?? {}),
      },
    })

  async function addOfficeAceAccount(id: string, options: { enabled?: boolean } = {}): Promise<void> {
    const ref = `OFFICEACE_ACCOUNT_${id.toUpperCase()}`
    await credentials.set(ref, officeAceCredentialJson())
    await pool.addAccount({
      id,
      provider: 'officeace',
      nickname: id,
      enabled: options.enabled ?? true,
      credentialRef: ref,
      createdAt: Date.now(),
      refreshable: true,
      expiresAt: Date.now() + 3_600_000,
    })
  }

  it('补领成功：返回汇总与逐账号明细（面板据此显示 +100 分）', async () => {
    await addOfficeAceAccount('officeace-api-1')
    const res = await adminFetch('/api/credits/daily-bonus', {
      method: 'POST',
      body: JSON.stringify({ provider: 'officeace' }),
    })
    expect(res.status).toBe(200)
    const body = await res.json() as {
      summary: Record<string, number>
      results: Array<Record<string, unknown>>
    }
    expect(body.summary['claimed']).toBe(1)
    expect(body.summary['totalPoints']).toBe(100)
    expect(body.results).toHaveLength(1)
    expect(body.results[0]).toMatchObject({ kind: 'claimed', points: 100 })
    expect(body.results[0]!['activities']).toEqual(['每日签到有礼'])
  })

  it('**手动跳过去重闸门**：同一天连点两次都会真的打上游', async () => {
    await addOfficeAceAccount('officeace-api-2')
    const first = await adminFetch('/api/credits/daily-bonus', {
      method: 'POST',
      body: JSON.stringify({ provider: 'officeace' }),
    })
    expect((await first.json() as { summary: Record<string, number> }).summary['claimed']).toBe(1)

    // 第二次：若不 force，去重表会把这次静默跳过 —— 用户会以为按钮坏了。
    const second = await adminFetch('/api/credits/daily-bonus', {
      method: 'POST',
      body: JSON.stringify({ provider: 'officeace' }),
    })
    expect(second.status).toBe(200)
    const body = await second.json() as { summary: Record<string, number> }
    // 上游幂等（替身每次都回同一个桶），故这里仍是 claimed —— 关键是**没有被跳过**。
    expect(body.summary['skipped']).toBe(0)
    expect(body.summary['claimed']).toBe(1)
  })

  it('停用账号出现在明细里并标注原因（不静默消失）', async () => {
    await addOfficeAceAccount('officeace-api-on', { enabled: true })
    await addOfficeAceAccount('officeace-api-off', { enabled: false })
    const res = await adminFetch('/api/credits/daily-bonus', {
      method: 'POST',
      body: JSON.stringify({ provider: 'officeace' }),
    })
    const body = await res.json() as { summary: Record<string, number>; results: Array<Record<string, unknown>> }
    expect(body.summary['claimed']).toBe(1)
    expect(body.summary['skipped']).toBe(1)
    const off = body.results.find((r) => r['accountId'] === 'officeace-api-off')!
    expect(off['kind']).toBe('skipped')
    expect(String(off['error'])).toContain('停用')
  })

  it('非法 provider 明确拒绝（不是悄悄成功）', async () => {
    const res = await adminFetch('/api/credits/daily-bonus', {
      method: 'POST',
      body: JSON.stringify({ provider: 'raccoon' }),
    })
    expect(res.status).toBe(400)
    const body = await res.json() as { error: { code: string; message: string } }
    expect(body.error.code).toBe('credits_unsupported')
    expect(body.error.message).toContain('officeace')
  })

  it('缺 provider 也拒绝（空字符串不该被当成 officeace）', async () => {
    const res = await adminFetch('/api/credits/daily-bonus', {
      method: 'POST',
      body: JSON.stringify({}),
    })
    expect(res.status).toBe(400)
  })
})

/**
 * `POST /api/credits/claim-all` 的 **Magicrew 分支**（每日登录积分 / 签到）。
 *
 * Magicrew（超级麦吉）的每日登录积分是 **200 分/天，且当天 23:59:59 作废、不累计**
 * —— 比 officeace 更紧迫，跨天即归零。它是「每天必须主动领」的签到语义，
 * 故手动入口走 `credits.claimAll`（面板「一键领取积分」，能力位 `dailyCheckin`），
 * **不是** `daily-bonus`（那是 OfficeAce「服务端自动发放」的手动兜底，语义不同：
 * 两者汇总形状也不同，混用会多一处字段漂移面）。
 *
 * 守四件事：
 * 1. 分支真的接上了（未接线时 magicrew 会落到 `throw new Error(不支持)`）；
 * 2. 领到 200 分如实回流（`summary.claimed` / `totalCredit`）；
 * 3. `already-claimed` 与 `inactive` 保持区分（混成一个会让用户以为领到了分，
 *    或让「无资格」看起来像临时故障）；
 * 4. 逐账号明细带原因（面板逐条渲染，缺失就只能显示「1 个失败」）。
 */
describe('POST /api/credits/claim-all（Magicrew 每日登录积分）', () => {
  let dir: string
  let server: Server
  let url: string
  let pool: AccountPool
  let credentials: FileCredentialStore
  let giftHits: number
  /** 下一次 `/api/v1/login-gift` 的响应体（用例可改写）。 */
  let giftResponse: unknown

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'all-proxy-magicrew-checkin-'))
    credentials = new FileCredentialStore(dir)
    pool = new AccountPool({ credentials, dataDir: dir })
    resetMagicrewClaimThrottle()
    giftHits = 0
    giftResponse = { code: 1000, message: 'ok', data: { granted: true, point_amount: 200, expire_type: 1 } }

    const registry = new ProviderRegistry()
    const auth = new AdminAuth(dir, { info: () => {}, warn: () => {}, error: () => {} })
    const generated = auth.ensure(undefined, { minSecretLength: 4 })
    adminSecretHolder.secret = process.env['ALL_PROXY_ADMIN_SECRET']?.trim() || generated || ''

    server = createGatewayServer({
      registry,
      pool,
      port: 0,
      host: '127.0.0.1',
      admin: createAdminHandler({
        registry,
        pool,
        credentials,
        apiKeys: new ApiKeyStore(dir),
        auth,
        logger: { info: () => {}, warn: () => {}, error: () => {} },
        fetcher: vi.fn(async (input: RequestInfo | URL) => {
          if (String(input).includes('/api/v1/login-gift')) {
            giftHits += 1
            return new Response(JSON.stringify(giftResponse), { status: 200 })
          }
          return new Response('{}', { status: 500 })
        }) as unknown as typeof fetch,
      }),
    })
    await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve) })
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  })

  afterEach(async () => {
    await new Promise<void>((resolve) => { server.close(() => resolve()) })
    rmSync(dir, { recursive: true, force: true })
    adminSecretHolder.secret = ''
  })

  const adminFetch = (path: string, init: RequestInit = {}): Promise<Response> =>
    fetch(`${url}${path}`, {
      ...init,
      headers: { 'x-admin-secret': adminSecretHolder.secret, 'Content-Type': 'application/json', ...(init.headers ?? {}) },
    })

  async function addMagicrewAccount(id: string): Promise<void> {
    const ref = `MAGICREW_ACCOUNT_${id.toUpperCase()}`
    await credentials.set(ref, JSON.stringify({ jwt: 'jwt-value', organizationCode: 'org-code' }))
    await pool.addAccount({
      id, provider: 'magicrew', nickname: id, enabled: true,
      credentialRef: ref, createdAt: Date.now(), refreshable: false,
    })
  }

  it('分支已接上：领到 200 分如实回流（不是「不支持每日签到」）', async () => {
    await addMagicrewAccount('magicrew-ck-1')
    const res = await adminFetch('/api/credits/claim-all', {
      method: 'POST',
      body: JSON.stringify({ provider: 'magicrew' }),
    })
    expect(res.status).toBe(200)
    const body = await res.json() as { summary: Record<string, number>, results: Array<Record<string, unknown>> }
    expect(body.summary['claimed']).toBe(1)
    expect(body.summary['totalCredit']).toBe(200)
    expect(giftHits).toBe(1)
    expect(body.results).toHaveLength(1)
  })

  it('手动入口跳过去重闸门：同一天连点两次都真的打上游', async () => {
    await addMagicrewAccount('magicrew-ck-2')
    await adminFetch('/api/credits/claim-all', { method: 'POST', body: JSON.stringify({ provider: 'magicrew' }) })
    await adminFetch('/api/credits/claim-all', { method: 'POST', body: JSON.stringify({ provider: 'magicrew' }) })
    expect(giftHits).toBe(2)
  })

  it('「今天已领」（实测原文）回报 already-claimed，不是失败', async () => {
    giftResponse = { code: 1000, data: { granted: false, point_amount: 0, expire_type: 1, message: '今日已领取登录积分' } }
    await addMagicrewAccount('magicrew-ck-3')
    const res = await adminFetch('/api/credits/claim-all', { method: 'POST', body: JSON.stringify({ provider: 'magicrew' }) })
    const body = await res.json() as { summary: Record<string, number>, results: Array<Record<string, unknown>> }
    expect(body.summary['alreadyClaimed']).toBe(1)
    expect(body.summary['claimed']).toBe(0)
    expect(body.summary['failed']).toBe(0)
    // 原因要透出（面板逐条渲染 outcome.message）
    const outcome = body.results[0]!['outcome'] as Record<string, unknown>
    expect(outcome['kind']).toBe('already-claimed')
    expect(String(outcome['message'])).toContain('已领取')
  })

  it('「不符合活动条件」（实测原文）报 inactive（重试无益，不该显示成失败）', async () => {
    giftResponse = { code: 1000, data: { granted: false, point_amount: 0, expire_type: 1, message: '当前账号暂不符合活动参与条件' } }
    await addMagicrewAccount('magicrew-ck-4')
    const res = await adminFetch('/api/credits/claim-all', { method: 'POST', body: JSON.stringify({ provider: 'magicrew' }) })
    const body = await res.json() as { summary: Record<string, number>, results: Array<Record<string, unknown>> }
    expect(body.summary['inactive']).toBe(1)
    expect(body.summary['failed']).toBe(0)
    expect(body.summary['claimed']).toBe(0)
  })
})
