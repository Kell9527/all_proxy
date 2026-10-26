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
