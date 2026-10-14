import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AccountPool } from '../../src/pool/account-pool.js'
import { FileCredentialStore } from '../../src/pool/store.js'
import { findExistingOfficeAceAccount } from '../../src/login/officeace-dedupe.js'
import { LoginOrchestrator } from '../../src/login/orchestrator.js'
import type { ProviderAccountEntry } from '../../src/pool/types.js'

/**
 * OfficeAce 登录判重的回归测试。
 *
 * 背景（用户 2026-10-14 报障）：「新建账号每次都会自动登录同一个账号，且重复
 * 登录多次」—— 不判重就会在池里堆出多条指向同一账号的条目：看起来是 N 个
 * 账号，实际是 1 个，选号时反复命中同一个上游账号，用户却以为在轮换。
 */

/** 造一份 OfficeAce 凭据 JSON（accountId 是按账号稳定的判据）。 */
function credentialJson(accountId: string): string {
  return JSON.stringify({
    modelAppKey: 'ak', modelAppSecret: 'sk', maasBaseUrl: 'https://maas.example.com',
    access: 'AK', secret: 'SK', securityToken: 'STS', projectId: 'p',
    expiresAt: new Date(Date.now() + 7_200_000).toISOString(),
    refreshToken: 'rt', dpopPrivateJwk: { kty: 'EC', crv: 'P-256', x: 'x', y: 'y' },
    accountId,
  })
}

function entry(overrides: Partial<ProviderAccountEntry> = {}): ProviderAccountEntry {
  return {
    id: 'officeace-001',
    provider: 'officeace',
    nickname: 'OfficeAce bca660e1',
    enabled: true,
    credentialRef: 'OFFICEACE_ACCOUNT_6A0E26BA',
    createdAt: Date.now(),
    refreshable: true,
    ...overrides,
  }
}

describe('findExistingOfficeAceAccount', () => {
  let dir: string
  let credentials: FileCredentialStore
  let pool: AccountPool

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'all-proxy-officeace-dedupe-'))
    credentials = new FileCredentialStore(dir)
    pool = new AccountPool({ credentials, dataDir: dir })
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('池里已有同 accountId 的账号 ⇒ 判命中', async () => {
    await pool.addAccount(entry())
    await credentials.set('OFFICEACE_ACCOUNT_6A0E26BA', credentialJson('acct-1'))
    const found = await findExistingOfficeAceAccount(pool, credentialJson('acct-1'))
    expect(found?.id).toBe('officeace-001')
  })

  it('不同 accountId ⇒ 不命中（新账号正常落条目）', async () => {
    await pool.addAccount(entry())
    await credentials.set('OFFICEACE_ACCOUNT_6A0E26BA', credentialJson('acct-1'))
    expect(await findExistingOfficeAceAccount(pool, credentialJson('acct-2'))).toBeUndefined()
  })

  it('多个账号时逐个比对（命中的是同一个，不是第一个）', async () => {
    await pool.addAccount(entry({ id: 'officeace-a', credentialRef: 'OFFICEACE_ACCOUNT_A' }))
    await pool.addAccount(entry({ id: 'officeace-b', credentialRef: 'OFFICEACE_ACCOUNT_B' }))
    await credentials.set('OFFICEACE_ACCOUNT_A', credentialJson('acct-1'))
    await credentials.set('OFFICEACE_ACCOUNT_B', credentialJson('acct-2'))
    const found = await findExistingOfficeAceAccount(pool, credentialJson('acct-2'))
    expect(found?.id).toBe('officeace-b')
  })

  it('凭据读不到 accountId（老条目/迁移凭据）⇒ 不判重（宁可重复也不误判）', async () => {
    await pool.addAccount(entry())
    await credentials.set('OFFICEACE_ACCOUNT_6A0E26BA', JSON.stringify({ access: 'AK' }))
    expect(await findExistingOfficeAceAccount(pool, JSON.stringify({ access: 'AK' }))).toBeUndefined()
  })

  it('池里没有 officeace 账号 ⇒ 不命中', async () => {
    expect(await findExistingOfficeAceAccount(pool, credentialJson('acct-1'))).toBeUndefined()
  })
})

describe('LoginOrchestrator 判重接线', () => {
  let dir: string
  let credentials: FileCredentialStore
  let pool: AccountPool

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'all-proxy-login-dedupe-'))
    credentials = new FileCredentialStore(dir)
    pool = new AccountPool({ credentials, dataDir: dir })
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('判重命中 ⇒ 不建新条目、新凭据写回既有 ref', async () => {
    // 池里已有一个 OfficeAce 账号（acct-1）
    await pool.addAccount(entry())
    await credentials.set('OFFICEACE_ACCOUNT_6A0E26BA', credentialJson('acct-1'))

    const orchestrator = new LoginOrchestrator({
      pool,
      credentials,
      displayNames: { officeace: 'OfficeAce (华为云)' },
      sessionTtlMs: 5000,
      dedupe: async (provider, json) => (
        provider === 'officeace' ? findExistingOfficeAceAccount(pool, json) : undefined
      ),
    })

    // 同一个账号再次「登录完成」（凭据是新的：refresh_token 已轮换）
    await orchestrator.settle('officeace', {
      access: credentialJson('acct-1'),
      expires: Date.now() + 7_200_000,
      refreshable: true,
    })

    // 池里仍然只有 1 条（没有堆出重复条目）
    const accounts = await pool.listAccounts('officeace')
    expect(accounts).toHaveLength(1)
    // 新凭据写回了既有 ref（旧的一次性 refresh_token 不能继续占位）。
    // ⚠️ 比对解析后的字段而不是整串：credentialJson 每次调用的 expiresAt
    // 都是新时间戳，整串比必然不相等。
    const stored = await credentials.resolve('OFFICEACE_ACCOUNT_6A0E26BA')
    const parsed = JSON.parse(stored!.value) as { accountId?: string; refreshToken?: string }
    expect(parsed.accountId).toBe('acct-1')
    expect(parsed.refreshToken).toBe('rt')
  })

  it('判重未命中 ⇒ 正常新建条目', async () => {
    const orchestrator = new LoginOrchestrator({
      pool,
      credentials,
      displayNames: { officeace: 'OfficeAce (华为云)' },
      sessionTtlMs: 5000,
      dedupe: async (provider, json) => (
        provider === 'officeace' ? findExistingOfficeAceAccount(pool, json) : undefined
      ),
    })
    await orchestrator.settle('officeace', {
      access: credentialJson('acct-new'),
      expires: Date.now() + 7_200_000,
      refreshable: true,
    })
    expect(await pool.listAccounts('officeace')).toHaveLength(1)
  })
})
