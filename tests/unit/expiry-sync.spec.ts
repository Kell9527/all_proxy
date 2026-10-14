import { describe, expect, it, vi } from 'vitest'
import {
  refreshAccountWithReconcile,
  shouldRefreshNow,
  syncAccountExpiry,
  type ExpiryAccessors,
} from '../../src/providers/expiry-sync.js'
import { REFRESH_LEAD_MS } from '../../src/shared/refresh.js'

/**
 * `expiry-sync.ts` 的回归用例。
 *
 * 该模块承载两条修复，各自对应一条用户可见的症状：
 *
 * 1. **lead-time 判据**（`shouldRefreshNow`）：续期调度器从「无脑全量刷」恢复成
 *    「距过期不足 1 小时才刷」。
 * 2. **有效期回写**（`syncAccountExpiry`）：按需续期过去只更新凭据、不回写账号池，
 *    于是凭据续好了、UI 仍挂「已过期」。
 *
 * 三条硬规矩各有单独用例锁死：失败不反噬、优先用调用方的 accountId、
 * 反查必须传**凭据内容**而非 ref 名。
 */

interface FakeCredential {
  access_token: string
  refresh_token?: string
  expires_at?: string
}

const ACCESSORS: ExpiryAccessors<FakeCredential> = {
  expiresAtOf: (c) => (c.expires_at ? Number(c.expires_at) : undefined),
  refreshableOf: (c) => Boolean(c.refresh_token),
  identityOf: (c) => c.access_token,
}

interface PoolSpy {
  pool: {
    updateAccount: (id: string, patch: Record<string, unknown>) => Promise<void>
    findAccountIdByCredential: (provider: string, identity: string) => Promise<string>
  }
  patches: Array<{ id: string; patch: Record<string, unknown> }>
  lookups: string[]
}

function makePool(lookupResult = '', failWrite = false): PoolSpy {
  const patches: Array<{ id: string; patch: Record<string, unknown> }> = []
  const lookups: string[] = []
  return {
    patches,
    lookups,
    pool: {
      updateAccount: async (id, patch) => {
        if (failWrite) throw new Error('账号池写入失败')
        patches.push({ id, patch })
      },
      findAccountIdByCredential: async (_provider, identity) => {
        lookups.push(identity)
        return lookupResult
      },
    },
  }
}

const CRED: FakeCredential = {
  access_token: 'TOKEN-BODY',
  refresh_token: 'RT',
  expires_at: String(Date.now() + 7_200_000),
}

describe('shouldRefreshNow：lead-time 判据', () => {
  const NOW = 1_800_000_000_000

  it('读不到过期时间 → 刷（保守：宁可多刷一次）', () => {
    expect(shouldRefreshNow(undefined, NOW)).toBe(true)
  })

  it('已过期 → 刷', () => {
    expect(shouldRefreshNow(NOW - 1, NOW)).toBe(true)
  })

  it('距过期 30 分钟 → 刷（已进入 lead 窗口）', () => {
    expect(shouldRefreshNow(NOW + 30 * 60 * 1000, NOW)).toBe(true)
  })

  it('距过期恰好等于 lead → 刷（判据是 `<=`，边界必须包含）', () => {
    expect(shouldRefreshNow(NOW + REFRESH_LEAD_MS, NOW)).toBe(true)
  })

  it('距过期 2 小时 → 跳过（这正是「长寿命账号被无谓刷」的老缺陷）', () => {
    expect(shouldRefreshNow(NOW + 2 * 3_600_000, NOW)).toBe(false)
  })
})

describe('syncAccountExpiry：回写账号池', () => {
  it('不传 pool 时静默跳过（兼容既有单参调用方）', async () => {
    await expect(syncAccountExpiry({ pool: undefined, provider: 'fake', credential: CRED, accessors: ACCESSORS, tag: '[fake]' }))
      .resolves.toBeUndefined()
  })

  it('优先用调用方给的 accountId，**不做反查**', async () => {
    const { pool, patches, lookups } = makePool()
    await syncAccountExpiry({ pool, provider: 'fake', credential: CRED, accessors: ACCESSORS, accountId: 'acct-1', tag: '[fake]' })
    expect(patches[0]?.id).toBe('acct-1')
    expect(lookups).toHaveLength(0)
  })

  it('⚠️ 缺 accountId 时反查必须传**凭据内容**（access_token），不是 ref 名', async () => {
    const { pool, patches, lookups } = makePool('acct-9')
    await syncAccountExpiry({ pool, provider: 'fake', credential: CRED, accessors: ACCESSORS, tag: '[fake]' })
    expect(lookups).toEqual(['TOKEN-BODY'])
    expect(patches[0]?.id).toBe('acct-9')
  })

  it('反查也匹配不到时不写、也不抛', async () => {
    const { pool, patches } = makePool('')
    await syncAccountExpiry({ pool, provider: 'fake', credential: CRED, accessors: ACCESSORS, tag: '[fake]' })
    expect(patches).toHaveLength(0)
  })

  it('池内现值一致时不重复写盘', async () => {
    const { pool, patches } = makePool()
    await syncAccountExpiry({
      pool, provider: 'fake', credential: CRED, accessors: ACCESSORS, accountId: 'acct-1',
      current: { expiresAt: Number(CRED.expires_at), refreshable: true }, tag: '[fake]',
    })
    expect(patches).toHaveLength(0)
  })

  it('⚠️ 凭据里读不到过期时间时**不覆盖**池内旧值', async () => {
    const { pool, patches } = makePool()
    const noExpiry: FakeCredential = { access_token: 'T' }
    await syncAccountExpiry({
      pool, provider: 'fake', credential: noExpiry,
      accessors: { ...ACCESSORS, refreshableOf: undefined }, accountId: 'acct-1', tag: '[fake]',
    })
    expect(patches).toHaveLength(0)
  })

  it('回写失败**只记日志、不上抛**：凭据已续成功，索引不该反噬它', async () => {
    const { pool } = makePool('acct-1', true)
    const warn = vi.fn()
    await expect(syncAccountExpiry({ pool, provider: 'fake', credential: CRED, accessors: ACCESSORS, accountId: 'acct-1', tag: '[fake]', warn }))
      .resolves.toBeUndefined()
    expect(warn).toHaveBeenCalled()
  })
})

describe('refreshAccountWithReconcile：单账号编排', () => {
  it('⚠️ 仍在有效期内：**不发续期请求，但必须校正账号池**', async () => {
    const { pool, patches } = makePool()
    const refresh = vi.fn()
    const fresh: FakeCredential = { ...CRED, expires_at: String(Date.now() + 2 * 3_600_000) }
    const did = await refreshAccountWithReconcile({
      pool, provider: 'fake', tag: '[fake]', accountId: 'acct-1', credential: fresh, accessors: ACCESSORS, refresh, save: vi.fn(),
    })
    expect(did).toBe(false)
    expect(refresh).not.toHaveBeenCalled()
    // 「不刷」的分支仍必须对账 —— 否则存量账号的池值永远无人更正。
    expect(patches).toHaveLength(1)
  })

  it('已进入 lead 窗口 → 续期、落盘、回写池，并返回 true', async () => {
    const { pool, patches } = makePool()
    // ⚠️ 必须用**临期**凭据（10 分钟）才落在 lead 窗口内；CRED 是 2 小时，不刷。
    const soon: FakeCredential = { ...CRED, expires_at: String(Date.now() + 10 * 60 * 1000) }
    const renewed: FakeCredential = { access_token: 'TOKEN-NEW', refresh_token: 'RT2', expires_at: String(Date.now() + 2 * 3_600_000) }
    const save = vi.fn()
    const did = await refreshAccountWithReconcile({
      pool, provider: 'fake', tag: '[fake]', accountId: 'acct-1', credential: soon, accessors: ACCESSORS,
      refresh: async () => renewed, save,
    })
    expect(did).toBe(true)
    expect(save).toHaveBeenCalledWith(renewed)
    expect(patches).toHaveLength(1)
  })

  it('续期响应缺少令牌时**绝不落盘**（否则把一份好凭据覆盖成 "undefined"）', async () => {
    const { pool } = makePool()
    const soon: FakeCredential = { ...CRED, expires_at: String(Date.now() + 10 * 60 * 1000) }
    const save = vi.fn()
    await expect(refreshAccountWithReconcile({
      pool, provider: 'fake', tag: '[fake]', accountId: 'acct-1', credential: soon, accessors: ACCESSORS,
      refresh: async () => undefined as never, save,
    })).rejects.toThrow(/缺少访问令牌/)
    expect(save).not.toHaveBeenCalled()
  })
})
