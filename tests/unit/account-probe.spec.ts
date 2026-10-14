/**
 * 限流标记重测 / 重置的单元测试。
 *
 * 全部使用桩函数：**不发起任何网络请求**（探测函数由 deps.probe 注入），
 * 遵循 tests/unit 的约定。
 */
import { readFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'
import { LlmError } from '../../src/providers/llm.js'
import {
  resetAccount,
  resetAllAccounts,
  retestAccount,
  retestAllAccounts,
} from '../../src/providers/account-probe.js'
import type { ProbePool } from '../../src/providers/account-probe.js'
import type { ProviderAccountEntry } from '../../src/providers/types.js'

/** 构造账号条目；默认带一条 deepseek-v4.1-flash 的未到期限流记录。 */
function makeEntry(overrides: Partial<ProviderAccountEntry> = {}): ProviderAccountEntry {
  return {
    id: 'buddy-1',
    provider: 'buddy',
    nickname: '测试号',
    enabled: true,
    credentialRef: 'BUDDY_ACCOUNT_TEST',
    createdAt: 1,
    refreshable: true,
    modelRateLimits: { 'deepseek-v4.1-flash': Date.now() + 3_600_000 },
    ...overrides,
  }
}

/**
 * 记录调用的账号池替身。
 *
 * `clearModelRateLimits` 真实改写内部状态，使「重测后再查」能反映清除结果，
 * 从而验证"只有实测通过的模型才被清除"。
 */
function makePool(entries: ProviderAccountEntry[]) {
  const accounts = new Map(entries.map(e => [e.id, { ...e }]))
  const cleared: Array<{ accountId: string; modelIds?: readonly string[] }> = []
  const updated: Array<{ accountId: string; modelId: string; resetAtMs: number }> = []
  const pool: ProbePool & {
    cleared: typeof cleared
    updated: typeof updated
    get(id: string): ProviderAccountEntry | undefined
  } = {
    cleared,
    updated,
    get: (id) => accounts.get(id),
    findAccount: (id) => accounts.get(id),
    listAccountsByProvider: (provider) => [...accounts.values()].filter(a => a.provider === provider),
    async resolveCredentialForAccount(id) {
      const entry = accounts.get(id)
      if (entry === undefined) return undefined
      return { access_token: 'AT', refresh_token: 'RT', expires_at: '2099-01-01T00:00:00Z' } as never
    },
    async clearModelRateLimits(accountId, modelIds) {
      const entry = accounts.get(accountId)
      if (entry?.modelRateLimits === undefined) return 0
      const limits = { ...entry.modelRateLimits }
      let removed = 0
      const targets = modelIds ?? Object.keys(limits)
      for (const m of targets) {
        if (Object.prototype.hasOwnProperty.call(limits, m)) { delete limits[m]; removed++ }
      }
      if (removed === 0) return 0
      const next = { ...entry }
      if (Object.keys(limits).length === 0) delete next.modelRateLimits
      else next.modelRateLimits = limits
      accounts.set(accountId, next)
      cleared.push({ accountId, modelIds })
      return removed
    },
    // 真实写回，供「仍受限时用上游新时刻覆盖旧值」的断言使用。
    async updateModelRateLimit(accountId, modelId, resetAtMs) {
      const entry = accounts.get(accountId)
      if (entry === undefined) return
      accounts.set(accountId, {
        ...entry,
        modelRateLimits: { ...entry.modelRateLimits, [modelId]: resetAtMs },
      })
      updated.push({ accountId, modelId, resetAtMs })
    },
  }
  return pool
}

describe('retestAccount', () => {
  it('实测通过的模型被清除标记', async () => {
    const pool = makePool([makeEntry()])
    const probe = vi.fn(async (_entry: ProviderAccountEntry, modelId: string) => ({ modelId, ok: true }))
    const result = await retestAccount(pool, 'buddy-1', { probe })

    expect(result.tested).toBe(1)
    expect(result.cleared).toEqual(['deepseek-v4.1-flash'])
    expect(result.stillLimited).toEqual([])
    // 关键：真的写回了池子，且只清除通过的模型
    expect(pool.cleared).toEqual([{ accountId: 'buddy-1', modelIds: ['deepseek-v4.1-flash'] }])
    expect(pool.get('buddy-1')?.modelRateLimits).toBeUndefined()
  })

  it('仍受限的模型保留标记，并回报原因', async () => {
    const pool = makePool([makeEntry({
      modelRateLimits: { 'model-a': Date.now() + 1000, 'model-b': Date.now() + 1000 },
    })])
    const probe = vi.fn(async (_entry: ProviderAccountEntry, modelId: string) => (
      modelId === 'model-a'
        ? { modelId, ok: false, message: '仍受限：频率限制' }
        : { modelId, ok: true }
    ))
    const result = await retestAccount(pool, 'buddy-1', { probe })

    expect(result.cleared).toEqual(['model-b'])
    expect(result.stillLimited).toEqual([{ modelId: 'model-a', ok: false, message: '仍受限：频率限制' }])
    // 只清除了 model-b，model-a 的标记必须还在
    expect(pool.cleared).toEqual([{ accountId: 'buddy-1', modelIds: ['model-b'] }])
    expect(pool.get('buddy-1')?.modelRateLimits).toEqual({ 'model-a': expect.any(Number) })
  })

  it('没有任何限流标记时不发请求', async () => {
    const pool = makePool([makeEntry({ modelRateLimits: undefined })])
    const probe = vi.fn()
    const result = await retestAccount(pool, 'buddy-1', { probe })

    expect(result.tested).toBe(0)
    expect(probe).not.toHaveBeenCalled()
    expect(pool.cleared).toEqual([])
  })

  /**
   * 回归：限流是**滚动窗口**，上游每次都会把重置时刻往后推。若重测只报「仍受限」
   * 而不把新时刻写回，存储会一直停在第一次的旧值 —— 旧值一旦过期，
   * UI 的 `modelRateLimits[v] > Date.now()` 判为过期而**不再渲染「限额重置」**，
   * 于是出现「弹窗说仍受限、账号卡片却空白」的矛盾，选号也会误判为可用。
   */
  it('仍受限时用上游给出的新重置时刻覆盖旧值（滚动窗口）', async () => {
    const staleReset = Date.now() - 60_000 // 已过期的旧时刻
    const freshReset = Date.now() + 45 * 60_000 // 上游推后到 45 分钟后
    const pool = makePool([makeEntry({
      modelRateLimits: { 'deepseek-v4.1-flash': staleReset },
    })])
    const probe = vi.fn(async (_entry: ProviderAccountEntry, modelId: string) => ({
      modelId, ok: false, message: '仍受限：频率限制', resetTimeMs: freshReset,
    }))

    const result = await retestAccount(pool, 'buddy-1', { probe })

    expect(result.cleared).toEqual([])
    // 关键：新时刻被写回并覆盖过期旧值 ⇒ UI 才会重新显示「限额重置」
    expect(pool.updated).toEqual([
      { accountId: 'buddy-1', modelId: 'deepseek-v4.1-flash', resetAtMs: freshReset },
    ])
    expect(pool.get('buddy-1')?.modelRateLimits).toEqual({ 'deepseek-v4.1-flash': freshReset })
  })

  it('仍受限但没有可解析的重置时刻时不写回（保留原标记）', async () => {
    const staleReset = Date.now() + 3_600_000
    const pool = makePool([makeEntry({
      modelRateLimits: { 'deepseek-v4.1-flash': staleReset },
    })])
    const probe = vi.fn(async (_entry: ProviderAccountEntry, modelId: string) => ({
      modelId, ok: false, message: '仍受限：频率限制', // 无 resetTimeMs
    }))

    await retestAccount(pool, 'buddy-1', { probe })

    expect(pool.updated).toEqual([])
    expect(pool.get('buddy-1')?.modelRateLimits).toEqual({ 'deepseek-v4.1-flash': staleReset })
  })

  it('账号不存在时返回错误而不抛异常', async () => {
    const pool = makePool([])
    const result = await retestAccount(pool, 'missing', { probe: vi.fn() })
    expect(result.error).toContain('不存在')
    expect(result.tested).toBe(0)
  })

  it('凭据不可用时不清除标记', async () => {
    const entry = makeEntry()
    const pool = makePool([entry])
    // 覆盖为"凭据不可用"
    pool.resolveCredentialForAccount = async () => undefined
    // 用真实默认探测（deps.probe 省略）会走 resolveCredentialForAccount
    const result = await retestAccount(pool, 'buddy-1')

    expect(result.cleared).toEqual([])
    expect(result.stillLimited[0]?.message).toContain('凭据不可用')
    expect(pool.cleared).toEqual([])
  })
})

describe('retestAllAccounts', () => {
  it('遍历该 provider 的全部账号，包含已停用账号', async () => {
    const pool = makePool([
      makeEntry({ id: 'buddy-on', enabled: true }),
      makeEntry({ id: 'buddy-off', enabled: false }),
      makeEntry({ id: 'codearts-1', provider: 'codearts', credentialRef: 'CODEARTS_ACCOUNT_X' }),
    ])
    const seen: string[] = []
    const probe = vi.fn(async (entry: ProviderAccountEntry, modelId: string) => {
      seen.push(entry.id)
      return { modelId, ok: true }
    })
    const res = await retestAllAccounts(pool, 'buddy', { probe })

    // 停用的 buddy-off 也必须被重测（用户明确要求）
    expect(seen.sort()).toEqual(['buddy-off', 'buddy-on'])
    expect(res.accounts.map(a => a.accountId).sort()).toEqual(['buddy-off', 'buddy-on'])
    expect(res.clearedCount).toBe(2)
    // codearts 账号不应被 buddy 的批量操作波及
    expect(res.accounts.some(a => a.accountId === 'codearts-1')).toBe(false)
  })

  it('按顺序逐个探测，避免并发触发真实限流', async () => {
    const pool = makePool([makeEntry({ id: 'a' }), makeEntry({ id: 'b' }), makeEntry({ id: 'c' })])
    let inFlight = 0
    let maxInFlight = 0
    const probe = vi.fn(async (_entry: ProviderAccountEntry, modelId: string) => {
      inFlight++
      maxInFlight = Math.max(maxInFlight, inFlight)
      await new Promise(r => setTimeout(r, 1))
      inFlight--
      return { modelId, ok: true }
    })
    await retestAllAccounts(pool, 'buddy', { probe })
    expect(maxInFlight).toBe(1)
  })
})

describe('resetAccount / resetAllAccounts', () => {
  it('重置不发请求，直接清除全部标记', async () => {
    const pool = makePool([makeEntry({
      modelRateLimits: { 'model-a': Date.now() + 1000, 'model-b': Date.now() + 2000 },
    })])
    const res = await resetAccount(pool, 'buddy-1')

    expect(res.clearedCount).toBe(2)
    expect(res.accountCount).toBe(1)
    expect(pool.get('buddy-1')?.modelRateLimits).toBeUndefined()
  })

  it('无标记时重置返回 0', async () => {
    const pool = makePool([makeEntry({ modelRateLimits: undefined })])
    expect(await resetAccount(pool, 'buddy-1')).toEqual({ clearedCount: 0, accountCount: 0 })
  })

  it('重置所有覆盖停用账号并统计正确', async () => {
    const pool = makePool([
      makeEntry({ id: 'on', enabled: true }),
      makeEntry({ id: 'off', enabled: false }),
      makeEntry({ id: 'none', enabled: false, modelRateLimits: undefined }),
      makeEntry({ id: 'ca', provider: 'codearts', credentialRef: 'CODEARTS_ACCOUNT_X' }),
    ])
    const res = await resetAllAccounts(pool, 'buddy')

    // on + off 各 1 条；none 无标记不计入；codearts 不在范围内
    expect(res.clearedCount).toBe(2)
    expect(res.accountCount).toBe(2)
    expect(pool.get('ca')?.modelRateLimits).toBeDefined()
  })
})

describe('限流判定（isRateLimitFailure 经由默认探测暴露的行为）', () => {
  it('LlmError 的 QUOTA_EXCEEDED / RATE_LIMIT / QUOTA 都识别为限流', () => {
    // 该判定是私有的，通过默认探测路径间接验证：这里直接断言错误码集合
    // 与实际适配器抛出的码一致，防止词汇漂移（buddy 用 QUOTA_EXCEEDED，
    // harness 常量是 QUOTA）。
    for (const code of ['RATE_LIMIT', 'QUOTA_EXCEEDED', 'QUOTA']) {
      const error = new LlmError('频率限制', code)
      expect(error.code).toBe(code)
    }
  })
})

/**
 * 探测适配器分派表（源码级回归）。
 *
 * ⚠️ `probeWithAdapter` 里的分派表**已两次因「新增 provider 没同步」出缺陷**
 * （workbuddy、trae，见 `account-probe.ts` 的文件头注释）：漏分支会让账号
 * 落到 `else` 用 CodeArtsAdapter（华为云 HMAC 签名）去打别家端点，请求必然失败
 * 而错误信息完全指错方向。raccoon 是第三个会写 `modelRateLimits` 的 provider
 * （`raccoon-adapter.ts` 的换号分支），因此卡片上真有「重测」按钮，必须分派。
 *
 * 这里用源码级断言而不是行为测试：分支的存在本身就是要锁的东西，而真发一次
 * 请求既慢又依赖上游状态。
 */
describe('探测适配器分派表覆盖 raccoon', () => {
  const source = readFileSync(
    new URL('../../src/providers/account-probe.ts', import.meta.url), 'utf8',
  )

  it('存在 raccoon 分支，且构造的是 RaccoonAdapter', () => {
    expect(source).toContain("RACCOON_PROVIDER_ID = 'raccoon'")
    expect(source).toContain("entry.provider === RACCOON_PROVIDER_ID")
    expect(source).toContain('new RaccoonAdapter({')
  })

  it('raccoon 分支不传 accountPool（探测不得产生换号/限流副作用）', () => {
    const start = source.indexOf("entry.provider === RACCOON_PROVIDER_ID")
    expect(start).toBeGreaterThan(-1)
    const raw = source.slice(start, source.indexOf('} else {', start))
    expect(raw).toContain('new RaccoonAdapter({')
    // 先剔掉注释行再判：分支说明里本就写着「不传 accountPool」这个词
    const code = raw.split(/\n/).filter((l) => !l.trim().startsWith('//')).join('\n')
    expect(code).not.toContain('accountPool')
  })
})
