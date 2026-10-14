import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AccountPool } from '../../src/pool/account-pool.js'
import { RefreshCoordinator } from '../../src/pool/refresh-coordinator.js'
import { FileCredentialStore } from '../../src/pool/store.js'
import { refreshProviderCredential, REFRESH_SUPPORTED_PROVIDERS } from '../../src/refresh/provider-refresher.js'
import { refreshDueAccounts } from '../../src/refresh/runtime-helpers.js'
import { fetchBalances, claimAll, claimOnboarding } from '../../src/admin/credits-endpoint.js'

/**
 * 续期接线与积分端点（补全 tasks 5.6 运行时接线与积分能力）。
 *
 * 续期序列本体照抄来源 `*-auth.ts`（已有单测），这里验证**接线语义**：
 * provider → 正确的端点与凭据合并；一次性 refresh_token 的立即回写；
 * 「续期不看 enabled」的来源约定；积分分派的错误可读性。
 */

/** 测试用单飞协调器：生产里由 `index.ts` 持有单例并跨路径共享。 */
function sharedCoordinator(): RefreshCoordinator {
  return new RefreshCoordinator()
}

function jsonResp(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

describe('provider 续期接线', () => {
  it('十一个可续期 provider 全部接线（loomy 除外：无 refresh 端点）', () => {
    expect([...REFRESH_SUPPORTED_PROVIDERS].sort()).toEqual(
      ['accio', 'buddy', 'cline', 'codearts', 'lobsterai', 'officeace', 'qoder', 'qodercn', 'raccoon', 'trae', 'workbuddy'].sort(),
    )
  })

  it('raccoon：调用 refresh 端点并返回轮换后的新凭据', async () => {
    const seen: string[] = []
    const fetcher: typeof fetch = vi.fn(async (input: RequestInfo | URL) => {
      seen.push(String(input))
      return jsonResp({ code: 0, data: { access_token: 'at-new', refresh_token: 'rt-new', expires_at: '2099-01-01T00:00:00Z' } })
    })
    const refreshed = await refreshProviderCredential('raccoon', { access_token: 'at-old', refresh_token: 'rt-old' }, fetcher)
    expect(seen[0]).toContain('/refresh')
    expect(refreshed['access_token']).toBe('at-new')
    expect(refreshed['refresh_token']).toBe('rt-new')
  })

  it('qoder：载荷携带 machine_id，返回合并后的新凭据', async () => {
    const seenBodies: Array<Record<string, unknown>> = []
    const fetcher: typeof fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      seenBodies.push({ url: String(input), ...JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown> })
      return jsonResp({ token: 'at-q2', refresh_token: 'rt-q2', expires_at: Date.now() + 86_400_000, user_id: 'uid-1', user_name: 'qoder用户' })
    })
    const refreshed = await refreshProviderCredential('qoder',
      { access_token: 'at-q1', refresh_token: 'rt-q1', machine_id: 'machine-1', uid: 'uid-1' }, fetcher)
    expect(seenBodies[0]!['url']).toContain('openapi.qoder.sh')
    expect(seenBodies[0]!['refresh_token']).toBe('rt-q1')
    expect(seenBodies[0]!['machine_id']).toBe('machine-1')
    expect(refreshed['access_token']).toBe('at-q2')
    expect(refreshed['refresh_token']).toBe('rt-q2')
    // uid 等身份字段被保留（加密推理需要）。
    expect(refreshed['uid']).toBe('uid-1')
  })

  it('qodercn 与 qoder 同形，但打到中国版端点', async () => {
    const seen: string[] = []
    const fetcher: typeof fetch = vi.fn(async (input: RequestInfo | URL) => {
      seen.push(String(input))
      return jsonResp({ token: 'at-cn2', refresh_token: 'rt-cn2' })
    })
    await refreshProviderCredential('qodercn', { access_token: 'a', refresh_token: 'r', machine_id: 'm' }, fetcher)
    expect(seen[0]).toContain('qoder')
    expect(seen[0]).not.toContain('openapi.qoder.sh') // CN 版是另一个域名
  })

  it('loomy 明确报「无 refresh 端点」（已知限制，不是未接线）', async () => {
    await expect(refreshProviderCredential('loomy', { access_token: 'x' })).rejects.toThrow(/没有 refresh 端点/)
  })

  it('未知 provider 报「尚未接线」', async () => {
    await expect(refreshProviderCredential('nope', {})).rejects.toThrow(/尚未接线/)
  })

  it('codearts：凭据缺 DPoP 材料时报可读错误（而不是裸 500）', async () => {
    await expect(refreshProviderCredential('codearts', { refresh_token: 'r' })).rejects.toThrow(/DPoP 材料/)
  })
})

describe('refreshDueAccounts（续期调度）', () => {
  let dir: string
  let credentials: FileCredentialStore
  let pool: AccountPool

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'all-proxy-refresh-'))
    credentials = new FileCredentialStore(dir)
    pool = new AccountPool({ credentials, dataDir: dir })
  })
  afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

  it('**停用的账号同样被续期**（续期只看 refreshable，不看 enabled）', async () => {
    // raccoon 的 expires_at 由 access_token（JWT）的 exp 推算，替身要给真 JWT 形状。
    const jwtExp = Math.floor(Date.now() / 1000) + 86_400
    const jwt = `eyJhbGciOiJub25lIn0.${Buffer.from(JSON.stringify({ exp: jwtExp })).toString('base64url')}.sig`
    const fetcher: typeof fetch = vi.fn(async () =>
      jsonResp({ code: 0, data: { access_token: jwt, refresh_token: 'rt-new' } }))
    // 临期凭据。
    await credentials.set('RACCOON_ACCOUNT_TEST0001',
      JSON.stringify({ access_token: 'at-old', refresh_token: 'rt-old', expires_at: String(Date.now()) }))
    await pool.addAccount({
      id: 'raccoon-test0001', provider: 'raccoon', nickname: '测试', enabled: false,
      credentialRef: 'RACCOON_ACCOUNT_TEST0001', createdAt: Date.now(), refreshable: true,
      expiresAt: Date.now(),
    })

    await refreshDueAccounts({ pool, credentials, logger: { info: () => {}, warn: () => {}, error: () => {} }, fetcher })

    // 新凭据已回写。
    const stored = JSON.parse((await credentials.resolve('RACCOON_ACCOUNT_TEST0001'))!.value) as Record<string, unknown>
    expect(stored['access_token']).toBe(jwt) // 新 JWT 已回写
    expect(stored['refresh_token']).toBe('rt-new')
    // 有效期已回填。
    const entry = pool.findAccount('raccoon-test0001')
    expect(entry?.expiresAt).toBeGreaterThan(Date.now())
  })

  it('远期凭据不触发续期（避免无谓的上游请求）', async () => {
    const fetcher: typeof fetch = vi.fn()
    await credentials.set('RACCOON_ACCOUNT_TEST0002',
      JSON.stringify({ access_token: 'at', refresh_token: 'rt', expires_at: String(Date.now() + 30 * 86_400_000) }))
    await pool.addAccount({
      id: 'raccoon-test0002', provider: 'raccoon', nickname: '测试', enabled: true,
      credentialRef: 'RACCOON_ACCOUNT_TEST0002', createdAt: Date.now(), refreshable: true,
      expiresAt: Date.now() + 30 * 86_400_000,
    })
    await refreshDueAccounts({ pool, credentials, logger: { info: () => {}, warn: () => {}, error: () => {} }, fetcher })
    expect(fetcher).not.toHaveBeenCalled()
  })

  it('不可续期的账号被跳过（loomy 恒 refreshable=false）', async () => {
    const fetcher: typeof fetch = vi.fn()
    await credentials.set('LOOMY_ACCOUNT_TEST0003', JSON.stringify({ access_token: 's' }))
    await pool.addAccount({
      id: 'loomy-test0003', provider: 'loomy', nickname: 'L', enabled: true,
      credentialRef: 'LOOMY_ACCOUNT_TEST0003', createdAt: Date.now(), refreshable: false,
      expiresAt: Date.now(),
    })
    await refreshDueAccounts({ pool, credentials, logger: { info: () => {}, warn: () => {}, error: () => {} }, fetcher })
    expect(fetcher).not.toHaveBeenCalled()
  })

  // ── 共享凭据文件（用户报障「Raccoon 账号管理容易过期」的修复）──
  //
  // 病根：refresh_token 一次性轮换，多方各持副本会互相作废。绑到同一个文件后，
  // 谁刷新都写回同一处，其余消费者下次读到最新值。

  it('**绑到共享文件的账号：刷新前重读文件、刷新后写回同一文件**', async () => {
    const authPath = join(dir, 'auth-a.json')
    const fileRef = `FILE:${authPath}`
    // 模拟「另一个消费者刚刷新过」：文件里已是最新的 refresh_token。
    writeFileSync(authPath, JSON.stringify({ access_token: 'at-stale', refresh_token: 'rt-freshest' }), 'utf-8')

    const seenBodies: string[] = []
    const jwtExp = Math.floor(Date.now() / 1000) + 86_400
    const jwt = `eyJhbGciOiJub25lIn0.${Buffer.from(JSON.stringify({ exp: jwtExp })).toString('base64url')}.sig`
    const fetcher: typeof fetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      seenBodies.push(String(init?.body ?? ''))
      return jsonResp({ code: 0, data: { access_token: jwt, refresh_token: 'rt-rotated' } })
    })

    await pool.addAccount({
      id: 'raccoon-shared', provider: 'raccoon', nickname: '共享文件', enabled: true,
      credentialRef: fileRef, createdAt: Date.now(), refreshable: true, expiresAt: Date.now(),
    })

    await refreshDueAccounts({ pool, credentials, logger: { info: () => {}, warn: () => {}, error: () => {} }, fetcher })

    // ⚠️ 必须用**文件里的最新** refresh_token，而不是任何缓存的副本 ——
    // 用旧副本会得到「refresh token has been used」。
    expect(seenBodies[0]).toContain('rt-freshest')
    // 新 token 写回了那个共享文件（其它消费者下次就读到这里）。
    const written = JSON.parse(readFileSync(authPath, 'utf-8')) as Record<string, unknown>
    expect(written['access_token']).toBe(jwt)
    expect(written['refresh_token']).toBe('rt-rotated')
    // 有效期回填到账号索引。
    expect(pool.findAccount('raccoon-shared')?.expiresAt).toBeGreaterThan(Date.now())
  })

  it('共享文件被别的消费者删掉后：续期失败但不抛错，账号索引不受损', async () => {
    const authPath = join(dir, 'auth-gone.json')
    writeFileSync(authPath, JSON.stringify({ access_token: 'a', refresh_token: 'r' }), 'utf-8')
    await pool.addAccount({
      id: 'raccoon-gone', provider: 'raccoon', nickname: '文件没了', enabled: true,
      credentialRef: `FILE:${authPath}`, createdAt: Date.now(), refreshable: true, expiresAt: Date.now(),
    })
    rmSync(authPath)
    const fetcher: typeof fetch = vi.fn()
    const warnings: string[] = []

    await refreshDueAccounts({
      pool, credentials, fetcher,
      logger: { info: () => {}, warn: (m) => warnings.push(m), error: () => {} },
    })

    expect(fetcher).not.toHaveBeenCalled()
    expect(warnings.join('\n')).toContain('凭据不可读')
    // 账号条目仍在（不因一次续期失败被摘除）。
    expect(pool.findAccount('raccoon-gone')).toBeDefined()
  })

  it('删账号不删除共享凭据文件（那可能属于官方客户端或其它网关）', async () => {
    const authPath = join(dir, 'auth-shared-keep.json')
    writeFileSync(authPath, JSON.stringify({ access_token: 'keep' }), 'utf-8')
    await pool.addAccount({
      id: 'raccoon-keep', provider: 'raccoon', nickname: '保留文件', enabled: true,
      credentialRef: `FILE:${authPath}`, createdAt: Date.now(), refreshable: true,
    })

    await pool.removeAccount('raccoon-keep')

    expect(existsSync(authPath)).toBe(true)
    expect(pool.findAccount('raccoon-keep')).toBeUndefined()
  })

  it('两个账号指向同一文件时并发续期只打一次上游（共享 token 必须同锁）', async () => {
    const authPath = join(dir, 'auth-shared-two.json')
    writeFileSync(authPath, JSON.stringify({ access_token: 'a', refresh_token: 'r' }), 'utf-8')
    const fileRef = `FILE:${authPath}`
    for (const id of ['raccoon-twin-a', 'raccoon-twin-b']) {
      await pool.addAccount({
        id, provider: 'raccoon', nickname: id, enabled: true,
        credentialRef: fileRef, createdAt: Date.now(), refreshable: true, expiresAt: Date.now(),
      })
    }
    const jwtExp = Math.floor(Date.now() / 1000) + 86_400
    const jwt = `eyJhbGciOiJub25lIn0.${Buffer.from(JSON.stringify({ exp: jwtExp })).toString('base64url')}.sig`
    const fetcher: typeof fetch = vi.fn(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20))
      return jsonResp({ code: 0, data: { access_token: jwt, refresh_token: 'rt-n' } })
    })

    await refreshDueAccounts({
      pool, credentials, fetcher,
      logger: { info: () => {}, warn: () => {}, error: () => {} },
      coordinator: sharedCoordinator(),
    })

    // 若没按凭据 ref 单飞，这里会是 2 次 —— 第二次拿的是已作废的 refresh_token。
    expect(fetcher).toHaveBeenCalledTimes(1)
  })
})

describe('积分端点分派', () => {
  let dir: string
  let credentials: FileCredentialStore
  let pool: AccountPool
  const noopLogger = { info: () => {}, warn: () => {}, error: () => {} }

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'all-proxy-credits-'))
    credentials = new FileCredentialStore(dir)
    pool = new AccountPool({ credentials, dataDir: dir })
  })
  afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

  it('未登记积分能力的 provider 给出明确错误', async () => {
    await expect(fetchBalances('nope', { pool, credentials })).rejects.toThrow(/不支持积分余额查询/)
    await expect(claimAll('cline', { pool, credentials })).rejects.toThrow(/不支持每日签到/)
    await expect(claimAll('raccoon', { pool, credentials })).rejects.toThrow(/每日积分由服务端自动发放/)
  })

  it('qodercn 余额：凭据缺失的账号带原因，不发上游', async () => {
    await pool.addAccount({
      id: 'qodercn-missing', provider: 'qodercn', nickname: '缺凭据', enabled: true,
      credentialRef: 'QODERCN_ACCOUNT_NOPE0001', createdAt: Date.now(), refreshable: true,
    })
    const result = await fetchBalances('qodercn', { pool, credentials })
    expect(result.accounts).toHaveLength(1)
    expect(result.accounts[0]!.balance).toBeNull()
    expect(result.accounts[0]!.error).toContain('凭据')
  })

  it('qodercn 余额：上游 401 → balance 为 null 且带原因（不显示成 0）', async () => {
    await credentials.set('QODERCN_ACCOUNT_TEST0001', JSON.stringify({ access_token: 'at', refresh_token: 'rt', machine_id: 'm', uid: 'u' }))
    await pool.addAccount({
      id: 'qodercn-t1', provider: 'qodercn', nickname: '过期号', enabled: true,
      credentialRef: 'QODERCN_ACCOUNT_TEST0001', createdAt: Date.now(), refreshable: true,
    })
    const fetcher: typeof fetch = vi.fn(async () => new Response('{"code":"TOKEN_INVALID"}', { status: 401 }))
    const result = await fetchBalances('qodercn', { pool, credentials, fetcher })
    expect(result.accounts[0]!.balance).toBeNull()
    expect(result.accounts[0]!.error).toBeDefined()
    // 请求发到了中国版的 usage 端点。
    expect((fetcher as ReturnType<typeof vi.fn>).mock.calls[0]![0]).toContain('/sash/api/v2/me/usage')
  })

  it('raccoon 新手任务：首次领取返回 claimed 与积分', async () => {
    await credentials.set('RACCOON_ACCOUNT_TEST0004',
      JSON.stringify({ access_token: 'at', refresh_token: 'rt' }))
    await pool.addAccount({
      id: 'raccoon-ob', provider: 'raccoon', nickname: 'R', enabled: true,
      credentialRef: 'RACCOON_ACCOUNT_TEST0004', createdAt: Date.now(), refreshable: true,
    })
    const fetcher: typeof fetch = vi.fn(async () =>
      jsonResp({ code: 0, data: { granted: true, popup: { points: 3000 } } }))
    const r = await claimOnboarding('raccoon', 'raccoon-ob', { pool, credentials, fetcher })
    expect(r.claimed).toHaveLength(1)
    expect(r.claimed[0]!.points).toBe(3000)
    expect(r.earned).toBe(3000)
    expect(r.total).toBe(3000)
  })
})
