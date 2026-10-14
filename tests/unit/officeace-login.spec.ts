import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * OfficeAce 登录编排的回归测试。
 *
 * 重点守**两阶段错误分离**（用户 2026-10-14 报障「授权后账号没添加」的根因）：
 * 第一版把「轮询 code」和「换 token」放在同一个 try 里，换 token 失败被当成
 * 「本轮没授权」吞掉后继续轮询 —— 而华为云的 code 很可能一次性，之后每轮都
 * 取不到，于是一直空转到超时。用户看着「欢迎使用 OfficeAce」回调页，账号却
 * 永远进不来，且没有任何错误提示。
 *
 * 故这里逐条锁死：
 * - 换 token 失败 ⇒ **立刻 reject 且带原文**，不再继续轮询；
 * - 轮询 code 失败（网络抖动）⇒ 可容忍，继续轮询；
 * - cancel 后彻底停摆（不再发请求）。
 */

const startLoginMock = vi.fn()
const pollLoginCodeMock = vi.fn()
const completeLoginMock = vi.fn()

vi.mock('../../src/providers/officeace-auth.js', () => ({
  startLogin: (...args: unknown[]) => startLoginMock(...args),
  pollLoginCode: (...args: unknown[]) => pollLoginCodeMock(...args),
  completeLogin: (...args: unknown[]) => completeLoginMock(...args),
}))

const { startOfficeAceLoginFlow } = await import('../../src/providers/officeace-login.js')

/** 一份最小可用凭据。 */
function credential(accountId = 'acct-1') {
  return {
    modelAppKey: 'ak', modelAppSecret: 'sk', maasBaseUrl: 'https://maas.example.com',
    access: 'AK', secret: 'SK', securityToken: 'STS', projectId: 'p',
    expiresAt: new Date(Date.now() + 7_200_000).toISOString(),
    refreshToken: 'rt', dpopPrivateJwk: { kty: 'EC', crv: 'P-256', x: 'x', y: 'y' },
    accountId,
  }
}

beforeEach(() => {
  startLoginMock.mockReset()
  pollLoginCodeMock.mockReset()
  completeLoginMock.mockReset()
  startLoginMock.mockResolvedValue({
    authorizeUrl: 'https://auth.huaweicloud.com/authui/login.html?service=x',
    state: 'state-1',
    _internal: { codeVerifier: 'verifier', dpopPrivateJwk: { kty: 'EC' } },
  })
})

afterEach(() => {
  vi.useRealTimers()
})

/** 推进足够多的宏任务，让异步 tick 链跑完。 */
async function flush(rounds = 8): Promise<void> {
  for (let i = 0; i < rounds; i += 1) {
    await Promise.resolve()
    await new Promise((r) => setTimeout(r, 0))
  }
}

describe('officeace-login：正常流程', () => {
  it('轮询到 code 后立刻换 token 并 resolve（含 accountId 进凭据）', async () => {
    pollLoginCodeMock
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce('code-abc')
    completeLoginMock.mockResolvedValue(credential())

    const flow = await startOfficeAceLoginFlow({ pollIntervalMs: 1, timeoutMs: 5000 })
    const result = await flow.result
    expect(completeLoginMock).toHaveBeenCalledWith('code-abc', 'verifier', { kty: 'EC' })
    const parsed = JSON.parse(result.access) as { accountId?: string }
    expect(parsed.accountId).toBe('acct-1')
    expect(result.expires).toBeGreaterThan(Date.now())
    expect(result.loginUrl).toContain('auth.huaweicloud.com')
    await flow.close()
  })
})

describe('officeace-login：两阶段错误分离（核心回归）', () => {
  it('换 token 失败 ⇒ 立刻 reject 带原文，且**不再继续轮询**', async () => {
    pollLoginCodeMock.mockResolvedValue('code-abc')
    completeLoginMock.mockRejectedValue(new Error('HTTP 400 invalid_grant'))

    const flow = await startOfficeAceLoginFlow({ pollIntervalMs: 1, timeoutMs: 5000 })
    await expect(flow.result).rejects.toThrow(/token 交换失败/)
    await expect(flow.result).rejects.toThrow(/invalid_grant/)
    // 关键断言：失败是终态 —— 换 token 只试一次，不空转到超时
    expect(completeLoginMock).toHaveBeenCalledTimes(1)
    await flush()
    expect(pollLoginCodeMock).toHaveBeenCalledTimes(1)
  })

  it('轮询 code 失败（网络抖动）⇒ 可容忍，继续轮询直至成功', async () => {
    pollLoginCodeMock
      .mockRejectedValueOnce(new Error('ECONNRESET'))
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce('code-xyz')
    completeLoginMock.mockResolvedValue(credential('acct-2'))

    const flow = await startOfficeAceLoginFlow({ pollIntervalMs: 1, timeoutMs: 5000 })
    const result = await flow.result
    const parsed = JSON.parse(result.access) as { accountId?: string }
    expect(parsed.accountId).toBe('acct-2')
    // 网络失败没有阻止后续轮询
    expect(pollLoginCodeMock.mock.calls.length).toBeGreaterThanOrEqual(3)
    await flow.close()
  })
})

describe('officeace-login：超时与取消', () => {
  it('超时 ⇒ reject 且提示重新生成链接', async () => {
    pollLoginCodeMock.mockResolvedValue(undefined)
    const flow = await startOfficeAceLoginFlow({ pollIntervalMs: 1, timeoutMs: 50 })
    await expect(flow.result).rejects.toThrow(/超时/)
    await expect(flow.result).rejects.toThrow(/新建账号/)
  })

  it('cancel 后停摆（不再发轮询请求）', async () => {
    pollLoginCodeMock.mockResolvedValue(undefined)
    const flow = await startOfficeAceLoginFlow({ pollIntervalMs: 1, timeoutMs: 5000 })
    await flush(2)
    const before = pollLoginCodeMock.mock.calls.length
    expect(before).toBeGreaterThan(0)
    await flow.close()
    await flush(6)
    expect(pollLoginCodeMock.mock.calls.length).toBe(before)
  })
})
