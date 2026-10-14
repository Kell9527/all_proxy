import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { AccountPool } from '../../src/pool/account-pool.js'
import { FileCredentialStore } from '../../src/pool/store.js'
import { createAdminHandler } from '../../src/admin/router.js'
import { AdminAuth } from '../../src/admin/auth.js'
import { ApiKeyStore } from '../../src/auth/api-keys.js'
import { AccountPhoneResolver } from '../../src/admin/account-phone.js'
import { ProviderRegistry } from '../../src/providers/registry.js'
import { RACCOON } from '../../src/providers/raccoon-product.js'
import { ACCIO, ACCIO_USERINFO_PATH } from '../../src/providers/accio-product.js'

/**
 * 账号卡片「凭据」一栏的手机号展示。
 *
 * 基准行为（Loomy 一向如此）：内置凭据显示手机号而不是机器生成的 ref 名。
 * 本文件覆盖把它扩展到 raccoon / accio / officeace 的三条路径：
 * 凭据里已有字段、上游只读身份端点、以及上游根本没有手机号时的退档。
 */

const logger = { info: () => {}, warn: () => {}, error: () => {} }

/** 被测代码实际会打的只读身份端点（用产品常量拼，避免与实现漂移）。 */
const RACCOON_USER_INFO_URL = `${RACCOON.apiBase}${RACCOON.authApiPrefix}/user_info`
const ACCIO_USERINFO_URL = `${ACCIO.gatewayBaseUrl}${ACCIO_USERINFO_PATH}`

/** 内存凭据存储替身（只实现解析器用到的 `resolve`）。 */
function memoryStore(values: Record<string, string>): { resolve(ref: string): Promise<{ value: string } | undefined> } {
  return {
    async resolve(ref: string) {
      const value = values[ref]
      return value === undefined ? undefined : { value }
    },
  }
}

/** 造一个假的 fetch：按 URL 返回固定 JSON（记录调用次数供断言）。 */
function fakeFetch(routes: Record<string, { status?: number; body: unknown }>): typeof fetch & { calls: string[] } {
  const calls: string[] = []
  const impl = (async (input: string | URL | Request) => {
    const url = String(input)
    calls.push(url)
    const route = routes[url]
    if (route === undefined) return new Response('not found', { status: 404 })
    return new Response(JSON.stringify(route.body), { status: route.status ?? 200 })
  }) as typeof fetch & { calls: string[] }
  impl.calls = calls
  return impl
}

describe('AccountPhoneResolver', () => {
  it('凭据里有 phone 时直接显示，不打上游（loomy / raccoon 新账号）', async () => {
    const fetcher = fakeFetch({})
    const resolver = new AccountPhoneResolver({
      credentials: memoryStore({ R: JSON.stringify({ access_token: 't', phone: '13800001111' }) }),
      fetcher,
    })
    expect(await resolver.resolve('loomy', 'R')).toBe('13800001111')
    expect(await resolver.resolve('raccoon', 'R')).toBe('13800001111')
    expect(fetcher.calls).toEqual([])
  })

  it('raccoon 老账号（凭据无 phone）打一次 user_info 并缓存，不重复请求', async () => {
    const fetcher = fakeFetch({
      [RACCOON_USER_INFO_URL]: { body: { code: 0, data: { id: '7192470', name: 'RaccoonMia', phone: '18922873950' } } },
    })
    const resolver = new AccountPhoneResolver({
      credentials: memoryStore({ R: JSON.stringify({ access_token: 't', refresh_token: 'r' }) }),
      fetcher,
    })
    expect(await resolver.resolve('raccoon', 'R')).toBe('18922873950')
    // 第二次走缓存：账号列表每次刷新都不该再打一次上游。
    expect(await resolver.resolve('raccoon', 'R')).toBe('18922873950')
    expect(fetcher.calls).toHaveLength(1)
  })

  it('accio 打 userinfo 取 maskedMobile（上游脱敏值原样呈现）', async () => {
    const fetcher = fakeFetch({
      [ACCIO_USERINFO_URL]: {
        body: { success: true, data: { userId: '1', userName: 'Zt Pan', maskedMobile: '+86 189****3950' } },
      },
    })
    const resolver = new AccountPhoneResolver({
      credentials: memoryStore({ R: JSON.stringify({ access_token: 't', refresh_token: 'r', expires_at: 1 }) }),
      fetcher,
    })
    expect(await resolver.resolve('accio', 'R')).toBe('+86 189****3950')
  })

  it('officeace 没有上游手机号来源，退到凭据里的 accountId', async () => {
    const fetcher = fakeFetch({})
    const resolver = new AccountPhoneResolver({
      credentials: memoryStore({ R: JSON.stringify({ accountId: 'bca660e1fa124fe08b0c9d5bcf16f3c0' }) }),
      fetcher,
    })
    expect(await resolver.resolve('officeace', 'R')).toBe('bca660e1fa124fe08b0c9d5bcf16f3c0')
    // 关键：**不发任何上游请求**（华为云没有人员信息端点，见 account-phone.ts 文件头）。
    expect(fetcher.calls).toEqual([])
  })

  it('officeace 凭据连 accountId 都没有时返回 undefined（调用方回退 ref 名）', async () => {
    const resolver = new AccountPhoneResolver({
      credentials: memoryStore({ R: JSON.stringify({ access: 'ak' }) }),
      fetcher: fakeFetch({}),
    })
    expect(await resolver.resolve('officeace', 'R')).toBeUndefined()
  })

  it('上游查不到（未登录 / 401）时返回 undefined，且短缓存不反复打', async () => {
    const fetcher = fakeFetch({
      [RACCOON_USER_INFO_URL]: { status: 401, body: { code: 200003, message: 'authorization_verify_error' } },
    })
    const resolver = new AccountPhoneResolver({
      credentials: memoryStore({ R: JSON.stringify({ access_token: 'bad', refresh_token: 'r' }) }),
      fetcher,
    })
    expect(await resolver.resolve('raccoon', 'R')).toBeUndefined()
    expect(await resolver.resolve('raccoon', 'R')).toBeUndefined()
    expect(fetcher.calls).toHaveLength(1)
  })

  it('凭据读不到 / JSON 损坏 / 不是对象时一律 undefined，不抛错', async () => {
    const resolver = new AccountPhoneResolver({
      credentials: {
        async resolve(ref: string) {
          if (ref === 'missing') return undefined
          if (ref === 'broken') return { value: 'not json at all' }
          return { value: '["array"]' }
        },
      },
      fetcher: fakeFetch({}),
    })
    expect(await resolver.resolve('raccoon', 'missing')).toBeUndefined()
    expect(await resolver.resolve('raccoon', 'broken')).toBeUndefined()
    expect(await resolver.resolve('raccoon', 'array')).toBeUndefined()
  })

  it('凭据读取抛错时不向上冒（账号列表不能整页 500）', async () => {
    const resolver = new AccountPhoneResolver({
      credentials: {
        async resolve(): Promise<{ value: string }> { throw new Error('EPERM') },
      },
      fetcher: fakeFetch({}),
    })
    expect(await resolver.resolve('raccoon', 'R')).toBeUndefined()
  })

  it('没有上游来源的 provider 不发请求（buddy 等仍走原路径）', async () => {
    const fetcher = fakeFetch({})
    const resolver = new AccountPhoneResolver({
      credentials: memoryStore({ R: JSON.stringify({ access_token: 't', user_id: 'u' }) }),
      fetcher,
    })
    expect(await resolver.resolve('buddy', 'R')).toBeUndefined()
    expect(fetcher.calls).toEqual([])
  })
})

// ───────────────────────── 管理端点（GET /api/accounts） ─────────────────────────

describe('GET /api/accounts?provider=… 的凭据展示', () => {
  let dir: string
  let secret: string
  let pool: AccountPool
  let credentials: FileCredentialStore

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'all-proxy-account-phone-'))
    credentials = new FileCredentialStore(dir)
    pool = new AccountPool({ credentials, dataDir: dir })
    const auth = new AdminAuth(dir, { info: () => {}, warn: () => {}, error: () => {} })
    // ⚠️ 必须先 `ensure`（它负责把口令写盘，环境变量口令也写），再取明文：
    // 写成 `env || auth.ensure(...)` 会让环境变量分支**短路**掉 ensure，
    // 凭据文件根本没落盘，随后新建的 AdminAuth 实例一律 401。
    auth.ensure(undefined, { minSecretLength: 4 })
    secret = process.env['ALL_PROXY_ADMIN_SECRET']?.trim() || auth.generatedSecret() || ''
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  /** 直接调 handler（不起真实服务器）：只需要 headers 与 writeHead/end。 */
  async function listAccounts(
    provider: string,
    resolver: AccountPhoneResolver,
  ): Promise<{ status: number; data: Array<Record<string, unknown>> }> {
    const handler = createAdminHandler({
      registry: new ProviderRegistry(),
      pool,
      credentials,
      apiKeys: new ApiKeyStore(dir),
      auth: new AdminAuth(dir, logger),
      logger,
      accountPhone: resolver,
    })
    const req = { headers: { 'x-admin-secret': secret } } as unknown as IncomingMessage
    let status = 0
    let body = ''
    const res = {
      writeHead(code: number) { status = code },
      end(payload: string) { body = payload },
    } as unknown as ServerResponse
    const handled = await handler(req, res, new URL(`http://127.0.0.1/api/accounts?provider=${provider}`))
    expect(handled).toBe(true)
    return { status, data: (JSON.parse(body) as { data: Array<Record<string, unknown>> }).data }
  }

  it('raccoon 账号的凭据一栏显示手机号（老账号经上游补齐）', async () => {
    await credentials.set('RACCOON_ACCOUNT_A1', JSON.stringify({ access_token: 't', refresh_token: 'r' }))
    await pool.addAccount({
      id: 'raccoon-a1', provider: 'raccoon', nickname: 'raccoon', enabled: true,
      credentialRef: 'RACCOON_ACCOUNT_A1', createdAt: Date.now(), refreshable: true,
    })
    const resolver = new AccountPhoneResolver({
      credentials,
      fetcher: fakeFetch({
        [RACCOON_USER_INFO_URL]: { body: { code: 0, data: { id: '1', phone: '13145960262' } } },
      }),
    })
    const { status, data } = await listAccounts('raccoon', resolver)
    expect(status).toBe(200)
    expect(data).toHaveLength(1)
    expect(data[0]!['credentialDisplay']).toBe('13145960262')
    expect(data[0]!['credentialKind']).toBe('inline')
  })

  it('取不到手机号时仍显示 ref 名（不变成空串）', async () => {
    await credentials.set('RACCOON_ACCOUNT_B2', JSON.stringify({ access_token: 't', refresh_token: 'r' }))
    await pool.addAccount({
      id: 'raccoon-b2', provider: 'raccoon', nickname: 'raccoon', enabled: true,
      credentialRef: 'RACCOON_ACCOUNT_B2', createdAt: Date.now(), refreshable: true,
    })
    const resolver = new AccountPhoneResolver({
      credentials,
      fetcher: fakeFetch({
        [RACCOON_USER_INFO_URL]: { status: 401, body: { code: 200003 } },
      }),
    })
    const { data } = await listAccounts('raccoon', resolver)
    expect(data[0]!['credentialDisplay']).toBe('RACCOON_ACCOUNT_B2')
  })

  it('officeace 账号显示华为 accountId', async () => {
    await credentials.set('OFFICEACE_ACCOUNT_C3', JSON.stringify({ accountId: '01a139739d9875d09cfda1d7b402f9fe' }))
    await pool.addAccount({
      id: 'officeace-c3', provider: 'officeace', nickname: 'officeace', enabled: true,
      credentialRef: 'OFFICEACE_ACCOUNT_C3', createdAt: Date.now(), refreshable: true,
    })
    const { data } = await listAccounts('officeace', new AccountPhoneResolver({ credentials }))
    expect(data[0]!['credentialDisplay']).toBe('01a139739d9875d09cfda1d7b402f9fe')
  })
})
