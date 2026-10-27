import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AccountPool } from '../../src/pool/account-pool.js'
import { FileCredentialStore } from '../../src/pool/store.js'
import { findExistingQoderAccount } from '../../src/login/qoder-dedupe.js'
import { LoginOrchestrator } from '../../src/login/orchestrator.js'
import type { ProviderAccountEntry } from '../../src/pool/types.js'

/**
 * Qoder 系登录判重的回归测试。
 *
 * 背景（用户 2026-10-27 报障）：「同一个账号可以多次登录，增加多个条目，
 * 这是不合理的」。实测 `data/state.json` 里三条 `qodercn` 条目的凭据 `uid`
 * 逐字相同 —— 同一账号被登录三次堆成三条，选号时反复命中同一个上游账号。
 *
 * 判据是凭据里的 `uid`（设备码响应 `user_id`，按账号稳定，续期会保留）。
 * ⚠️ 判重**只在同 provider 内**进行：`qoder` 与 `qodercn` 是两个站点，
 * 各自的 uid 不可跨站推断，判错方向会丢账号。
 */

/** 造一份 Qoder 凭据 JSON（uid 是按账号稳定的判据）。 */
function credentialJson(uid: string, overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    security_oauth_token: 'tok',
    access_token: 'tok',
    refresh_token: 'rt',
    machine_id: '11111111-2222-3333-4444-555555555555',
    expire_time: Date.now() + 7_200_000,
    uid,
    ...overrides,
  })
}

function entry(overrides: Partial<ProviderAccountEntry> = {}): ProviderAccountEntry {
  return {
    id: 'qodercn-001',
    provider: 'qodercn',
    nickname: 'qodercn',
    enabled: true,
    credentialRef: 'QODERCN_ACCOUNT_6A0E26BA',
    createdAt: Date.now(),
    refreshable: true,
    ...overrides,
  }
}

describe('findExistingQoderAccount', () => {
  let dir: string
  let credentials: FileCredentialStore
  let pool: AccountPool

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'all-proxy-qoder-dedupe-'))
    credentials = new FileCredentialStore(dir)
    pool = new AccountPool({ credentials, dataDir: dir })
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('池里已有同 uid 的账号 ⇒ 判命中', async () => {
    await pool.addAccount(entry())
    await credentials.set('QODERCN_ACCOUNT_6A0E26BA', credentialJson('uid-1'))
    const found = await findExistingQoderAccount(pool, 'qodercn', credentialJson('uid-1'))
    expect(found?.id).toBe('qodercn-001')
  })

  it('不同 uid ⇒ 不命中（新账号正常落条目）', async () => {
    await pool.addAccount(entry())
    await credentials.set('QODERCN_ACCOUNT_6A0E26BA', credentialJson('uid-1'))
    expect(await findExistingQoderAccount(pool, 'qodercn', credentialJson('uid-2'))).toBeUndefined()
  })

  it('多个账号时逐个比对（命中的是同一个，不是第一个）', async () => {
    await pool.addAccount(entry({ id: 'qodercn-a', credentialRef: 'QODERCN_ACCOUNT_A' }))
    await pool.addAccount(entry({ id: 'qodercn-b', credentialRef: 'QODERCN_ACCOUNT_B' }))
    await credentials.set('QODERCN_ACCOUNT_A', credentialJson('uid-1'))
    await credentials.set('QODERCN_ACCOUNT_B', credentialJson('uid-2'))
    const found = await findExistingQoderAccount(pool, 'qodercn', credentialJson('uid-2'))
    expect(found?.id).toBe('qodercn-b')
  })

  it('⚠️ 同 uid 但不同 provider（qoder 国际版 vs qodercn）⇒ 不命中', async () => {
    // 两站各自下发 uid，数值相同**不**代表同一账号；跨站合并会丢账号，
    // 故判重必须按 provider 隔离。
    await pool.addAccount(entry({ id: 'qoder-x', provider: 'qoder', credentialRef: 'QODER_ACCOUNT_X' }))
    await credentials.set('QODER_ACCOUNT_X', credentialJson('uid-shared'))
    expect(await findExistingQoderAccount(pool, 'qodercn', credentialJson('uid-shared'))).toBeUndefined()
    // 反向：同 provider 内则命中（证明差异确实来自 provider 隔离，而非判据失效）
    await pool.addAccount(entry({ id: 'qodercn-y', credentialRef: 'QODERCN_ACCOUNT_Y' }))
    await credentials.set('QODERCN_ACCOUNT_Y', credentialJson('uid-shared'))
    expect((await findExistingQoderAccount(pool, 'qodercn', credentialJson('uid-shared')))?.id)
      .toBe('qodercn-y')
  })

  it('迁移凭据只带旧字段 `user_id` ⇒ 仍能判重', async () => {
    await pool.addAccount(entry())
    await credentials.set('QODERCN_ACCOUNT_6A0E26BA', credentialJson('uid-1', { uid: undefined, user_id: 'uid-1' }))
    const found = await findExistingQoderAccount(pool, 'qodercn', credentialJson('uid-1'))
    expect(found?.id).toBe('qodercn-001')
  })

  it('凭据读不到 uid（老条目/迁移凭据）⇒ 不判重（宁可重复也不误判）', async () => {
    await pool.addAccount(entry())
    await credentials.set('QODERCN_ACCOUNT_6A0E26BA', JSON.stringify({ access_token: 'tok' }))
    expect(await findExistingQoderAccount(pool, 'qodercn', JSON.stringify({ access_token: 'tok' })))
      .toBeUndefined()
  })

  it('非 Qoder provider ⇒ 不命中（不越界判重）', async () => {
    expect(await findExistingQoderAccount(pool, 'trae', credentialJson('uid-1'))).toBeUndefined()
  })

  it('池里没有 qoder 账号 ⇒ 不命中', async () => {
    expect(await findExistingQoderAccount(pool, 'qodercn', credentialJson('uid-1'))).toBeUndefined()
  })
})

describe('LoginOrchestrator 判重接线（qoder 系）', () => {
  let dir: string
  let credentials: FileCredentialStore
  let pool: AccountPool

  /** 与 `src/index.ts` 接线同形。 */
  function dedupeHook(provider: string, json: string) {
    return provider === 'qoder' || provider === 'qodercn'
      ? findExistingQoderAccount(pool, provider, json)
      : Promise.resolve(undefined)
  }

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'all-proxy-qoder-login-dedupe-'))
    credentials = new FileCredentialStore(dir)
    pool = new AccountPool({ credentials, dataDir: dir })
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('判重命中 ⇒ 不建新条目、新凭据写回既有 ref', async () => {
    const orchestrator = new LoginOrchestrator({
      pool, credentials, displayNames: { qodercn: 'Qoder (中国版)' },
      sessionTtlMs: 5000, dedupe: dedupeHook,
    })

    // 第一次登录：正常落条目
    await orchestrator.settle('qodercn', {
      access: credentialJson('uid-1'), expires: Date.now() + 3_600_000, refreshable: true,
    })
    expect(await pool.listAccounts('qodercn')).toHaveLength(1)

    // 同一账号再登录一次（凭据是新签发的：access_token 已变）
    await orchestrator.settle('qodercn', {
      access: credentialJson('uid-1', { security_oauth_token: 'tok2', access_token: 'tok2' }),
      expires: Date.now() + 7_200_000, refreshable: true,
    })

    const accounts = await pool.listAccounts('qodercn')
    expect(accounts).toHaveLength(1)
    const stored = await credentials.resolve(accounts[0]!.credentialRef)
    expect((JSON.parse(stored!.value) as { security_oauth_token?: string }).security_oauth_token).toBe('tok2')
  })

  it('判重命中时同步条目 expiresAt（面板有效期与续期调度都读它）', async () => {
    const orchestrator = new LoginOrchestrator({
      pool, credentials, displayNames: { qodercn: 'Qoder (中国版)' },
      sessionTtlMs: 5000, dedupe: dedupeHook,
    })
    const first = Date.now() + 3_600_000
    const second = Date.now() + 7_200_000
    await orchestrator.settle('qodercn', { access: credentialJson('uid-1'), expires: first, refreshable: true })
    await orchestrator.settle('qodercn', { access: credentialJson('uid-1'), expires: second, refreshable: true })

    const accounts = await pool.listAccounts('qodercn')
    expect(accounts).toHaveLength(1)
    expect(accounts[0]!.expiresAt).toBe(second)
  })

  it('判重未命中 ⇒ 正常新建条目（两个不同 uid 得到两条）', async () => {
    const orchestrator = new LoginOrchestrator({
      pool, credentials, displayNames: { qodercn: 'Qoder (中国版)' },
      sessionTtlMs: 5000, dedupe: dedupeHook,
    })
    await orchestrator.settle('qodercn', { access: credentialJson('uid-1'), expires: Date.now() + 3_600_000, refreshable: true })
    await orchestrator.settle('qodercn', { access: credentialJson('uid-2'), expires: Date.now() + 3_600_000, refreshable: true })
    expect(await pool.listAccounts('qodercn')).toHaveLength(2)
  })

  it('⚠️ 反向验证：不接判重钩子时会堆出重复条目（即本次修复的缺陷）', async () => {
    // 这正是修复前的行为，用它锁住「判重钩子确实是这条链路的必要环」。
    const orchestrator = new LoginOrchestrator({
      pool, credentials, displayNames: { qodercn: 'Qoder (中国版)' }, sessionTtlMs: 5000,
      // 刻意不传 dedupe
    })
    await orchestrator.settle('qodercn', { access: credentialJson('uid-1'), expires: Date.now() + 3_600_000, refreshable: true })
    await orchestrator.settle('qodercn', { access: credentialJson('uid-1'), expires: Date.now() + 3_600_000, refreshable: true })
    expect(await pool.listAccounts('qodercn')).toHaveLength(2)
  })
})
