/**
 * `officeace-refresh.spec.ts` —— OfficeAce 续期的 provider 级契约。
 *
 * ## 为什么需要这个文件
 *
 * `officeace-auth.ts` 的模块头写着「`refresh_token` **一次性**」「DPoP 私钥
 * **必须持久化**（refresh 要用同一把密钥签 proof）」。本项目把「锁内重读 /
 * 单飞 / 立即回写」统一放在 `src/refresh/refresh-account.ts`（已由既有测试覆盖），
 * 故本文件只锁 **OfficeAce 特有**的两条：
 *
 * 1. 续期用**凭据里持久化的那把 DPoP 私钥**签 proof（不是新生成的）；
 * 2. 续期返回的新 `refresh_token` 被**如实带出**（调用方据此立即回写）。
 *
 * ⚠️ **必须用真实的 P-256 密钥对**（不能写占位 `'x'/'y'/'d'`）：`refreshOfficeAceCredential`
 * 会拿 `dpopPrivateJwk` 真的去 `importKey` 签 DPoP proof，占位 JWK 会让
 * WebCrypto 抛 `Invalid JWK EC key`。这也顺带覆盖「用的是同一把已持久化的私钥」。
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { webcrypto } from 'node:crypto'
import { refreshProviderCredential, REFRESH_SUPPORTED_PROVIDERS } from '../../src/refresh/provider-refresher.js'
import type { OfficeAceCredential } from '../../src/providers/officeace-auth.js'

/** 真实的 P-256 私钥 JWK。 */
async function realJwk(): Promise<{ kty: string; crv: string; x: string; y: string; d: string }> {
  const pair = await webcrypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'])
  const jwk = await webcrypto.subtle.exportKey('jwk', (pair as CryptoKeyPair).privateKey)
  return { kty: jwk.kty ?? 'EC', crv: jwk.crv ?? 'P-256', x: jwk.x ?? '', y: jwk.y ?? '', d: jwk.d ?? '' }
}

async function makeCredential(overrides: Partial<OfficeAceCredential> = {}): Promise<Record<string, unknown>> {
  const credential: OfficeAceCredential = {
    modelAppKey: 'ak',
    modelAppSecret: 'sk',
    maasBaseUrl: 'https://example.invalid',
    access: 'access-key',
    secret: 'secret-key',
    securityToken: 'sts-token',
    projectId: 'proj',
    expiresAt: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
    refreshToken: 'refresh-1',
    dpopPrivateJwk: await realJwk(),
    ...overrides,
  }
  return credential as unknown as Record<string, unknown>
}

const savedFetch = globalThis.fetch
afterEach(() => {
  globalThis.fetch = savedFetch
  vi.restoreAllMocks()
})

describe('OfficeAce 续期（provider 级契约）', () => {
  it('officeace 已接线进 REFRESH_SUPPORTED_PROVIDERS', () => {
    expect(REFRESH_SUPPORTED_PROVIDERS.has('officeace')).toBe(true)
  })

  it('缺 refresh_token ⇒ 明确报错（引导重新登录）', async () => {
    const credential = await makeCredential({ refreshToken: '' })
    await expect(refreshProviderCredential('officeace', credential))
      .rejects.toThrow(/refresh_token/)
  })

  it('缺 DPoP 私钥 ⇒ 明确报错（无法签 proof）', async () => {
    const credential = await makeCredential({ dpopPrivateJwk: {} as never })
    await expect(refreshProviderCredential('officeace', credential))
      .rejects.toThrow(/DPoP/)
  })

  it('续期成功：STS 换 token 用持久化私钥签 DPoP，并带出**轮换后的** refresh_token', async () => {
    const credential = await makeCredential({ refreshToken: 'refresh-OLD' })
    let sawDpop = ''
    let sawRefreshBody = ''
    globalThis.fetch = vi.fn(async (url: string, init?: RequestInit) => {
      const u = String(url)
      if (u.includes('/v1/oauth2/tokens')) {
        sawDpop = String((init?.headers as Record<string, string> | undefined)?.DPoP ?? '')
        sawRefreshBody = String(init?.body ?? '')
        return new Response(JSON.stringify({
          credentials: {
            access_key_id: 'access-key-2',
            secret_access_key: 'secret-key-2',
            security_token: 'sts-token-2',
            project_id: 'proj',
            expiration: new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString(),
          },
          refresh_token: 'refresh-NEW',
        }), { status: 200 })
      }
      // permission-validate（SDK-HMAC-SHA256）回最小 modelInfo。
      return new Response(JSON.stringify({
        account_id: 'acct',
        subscription: {
          model_info: {
            model_auth_info: { model_app_key: 'ak2', model_app_secret: 'sk2' },
            model_api_url_base: 'modelgw-0004.example.invalid',
          },
        },
      }), { status: 200 })
    }) as never

    const next = await refreshProviderCredential('officeace', credential)

    // ① DPoP proof 真的发出去了（三段的 JWT 形态）。
    expect(sawDpop.split('.')).toHaveLength(3)
    // ② body 里带的是**旧** refresh_token（一次性交换的输入）。
    expect(sawRefreshBody).toContain('refresh-OLD')
    // ③ 轮换后的新 refresh_token 被如实带出 —— 调用方据此立即回写。
    //    ⚠️ OfficeAce 凭据字段是 **camelCase**（`refreshToken`），不是 snake_case。
    expect(next['refreshToken']).toBe('refresh-NEW')
    // ④ 新的 MaaS Basic 凭据被拉回（fetchModelInfo 生效）。
    expect(next['modelAppKey']).toBe('ak2')
    expect(next['maasBaseUrl']).toBe('https://modelgw-0004.example.invalid')
    // ⑤ 持久化的私钥字段被保留（下一次续期还要用它）。
    expect(next['dpopPrivateJwk']).toBeDefined()
  })

  it('STS 拒绝（一次性 token 已被消费）⇒ 抛终态错（引导重新登录）', async () => {
    const credential = await makeCredential()
    globalThis.fetch = vi.fn(async () => new Response('{"error":"STS5.1806 has been used"}', { status: 400 })) as never
    await expect(refreshProviderCredential('officeace', credential))
      .rejects.toThrow(/请重新登录/)
  })
})
