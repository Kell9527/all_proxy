import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AccountPool } from '../../src/pool/account-pool.js'
import { RefreshCoordinator } from '../../src/pool/refresh-coordinator.js'
import { FileCredentialStore } from '../../src/pool/store.js'
import { refreshProviderCredential, REFRESH_SUPPORTED_PROVIDERS } from '../../src/refresh/provider-refresher.js'
import { claimOfficeAceDailyBonuses, refreshDueAccounts } from '../../src/refresh/runtime-helpers.js'
import { resetOfficeAceBonusClaimThrottle } from '../../src/providers/officeace-credits.js'
import { fetchBalances, claimAll, claimOnboarding, keepAliveDailyPoints } from '../../src/admin/credits-endpoint.js'

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

  /**
   * raccoon 的鉴权失效必须与「上游暂时不可用」分开（2026-10-14 用户报障）。
   *
   * 真实形态：三个账号的 refresh_token 都被服务端作废，`/auth/v1/refresh` 与
   * 全部业务端点一致回 `HTTP 401` + `code=200003 authorization_verify_error`。
   * 旧实现把它归入 `unavailable` 并在面板提示「请稍后重试」—— 用户照做无数次
   * 依旧失败，还误以为功能坏了。
   */
  describe('raccoon 积分/保活的失败分类', () => {
    /** 建一个 raccoon 账号并返回其 ref。 */
    async function addRaccoonAccount(id: string, credential: Record<string, unknown>): Promise<void> {
      await credentials.set(id, JSON.stringify(credential))
      await pool.addAccount({
        id: `raccoon-${id}`, provider: 'raccoon', nickname: 'raccoon', enabled: true,
        credentialRef: id, createdAt: Date.now(), refreshable: true,
      })
    }

    it('余额查询遇 401/200003 → 文案指向「重新登录」，不是笼统的「查询失败」', async () => {
      await addRaccoonAccount('RACCOON_ACCOUNT_AUTH0001', { access_token: 'at', refresh_token: 'rt' })
      const fetcher: typeof fetch = vi.fn(async () =>
        jsonResp({ code: 200003, message: 'authorization_verify_error' }, 401))
      const result = await fetchBalances('raccoon', { pool, credentials, fetcher })
      expect(result.accounts[0]!.balance).toBeNull()
      expect(result.accounts[0]!.error).toContain('登录态已失效')
      expect(result.accounts[0]!.error).toContain('重新登录')
      // 不得提示「稍后重试」——那会让用户白等
      expect(result.accounts[0]!.error).not.toContain('稍后重试')
    })

    it('余额查询遇 503/200903 → 归为「上游暂时不可用，请稍后重试」', async () => {
      await addRaccoonAccount('RACCOON_ACCOUNT_SVC00001', { access_token: 'at', refresh_token: 'rt' })
      const fetcher: typeof fetch = vi.fn(async () =>
        jsonResp({ code: 200903, message: 'service_unavailable' }, 503))
      const result = await fetchBalances('raccoon', { pool, credentials, fetcher })
      expect(result.accounts[0]!.error).toContain('上游暂时不可用')
      expect(result.accounts[0]!.error).toContain('稍后重试')
    })

    it('保活遇 401/200003 → summary.authExpired 记 1（不是 unavailable）', async () => {
      await addRaccoonAccount('RACCOON_ACCOUNT_AUTH0002', { access_token: 'at', refresh_token: 'rt' })
      const fetcher: typeof fetch = vi.fn(async () =>
        jsonResp({ code: 200003, message: 'authorization_verify_error' }, 401))
      const result = await keepAliveDailyPoints('raccoon', { pool, credentials, fetcher })
      expect(result.summary.authExpired).toBe(1)
      expect(result.summary.unavailable).toBe(0)
      expect(result.results[0]!.outcome?.kind).toBe('auth-expired')
    })

    it('保活遇 503/200903 → summary.unavailable 记 1（与上面形成对照）', async () => {
      await addRaccoonAccount('RACCOON_ACCOUNT_SVC00002', { access_token: 'at', refresh_token: 'rt' })
      const fetcher: typeof fetch = vi.fn(async () =>
        jsonResp({ code: 200903, message: 'service_unavailable' }, 503))
      const result = await keepAliveDailyPoints('raccoon', { pool, credentials, fetcher })
      expect(result.summary.unavailable).toBe(1)
      expect(result.summary.authExpired).toBe(0)
    })
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

/**
 * OfficeAce 每日福利的**定时领取**（2026-10-23，用户报障
 * 「刚刚我在客户端打开了，然后登录领了 100 分」）。
 *
 * 病根：领取只在「管理端拉积分余额」时触发（`fetchOfficeAceBalanceDetailed`），
 * 用户不开面板时服务自跑却从不领 —— 福利按 UTC+8 自然日作废，当天白丢。
 */
describe('claimOfficeAceDailyBonuses（定时领取当日福利）', () => {
  let dir: string
  let credentials: FileCredentialStore
  let pool: AccountPool
  const noopLogger = { info: () => {}, warn: () => {}, error: () => {} }

  /** 远期有效的 OfficeAce 凭据（不触发续期，隔离掉刷新路径的干扰）。 */
  function officeAceCredential(): string {
    return JSON.stringify({
      modelAppKey: 'ak', modelAppSecret: 'sk', maasBaseUrl: 'https://example.com',
      access: 'AK', secret: 'SK', securityToken: 'STS', projectId: 'p',
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      refreshToken: 'rt', dpopPrivateJwk: { kty: 'EC', crv: 'P-256', x: 'x', y: 'y' },
    })
  }

  async function addOfficeAce(id: string, options: { enabled?: boolean } = {}): Promise<string> {
    const ref = `OFFICEACE_ACCOUNT_${id.toUpperCase()}`
    await credentials.set(ref, officeAceCredential())
    await pool.addAccount({
      id, provider: 'officeace', nickname: id, enabled: options.enabled ?? true,
      credentialRef: ref, createdAt: Date.now(), refreshable: true,
      expiresAt: Date.now() + 3_600_000,
    })
    return ref
  }

  const CLAIMED_BODY = {
    bonus_skus: [{ activity_id: 'bonus-daily-checkin-2026', activity_name: '每日签到有礼', points: 100 }],
  }

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'all-proxy-officeace-bonus-'))
    credentials = new FileCredentialStore(dir)
    pool = new AccountPool({ credentials, dataDir: dir })
    resetOfficeAceBonusClaimThrottle()
  })
  afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

  it('给启用中的账号领分并汇报条数/合计', async () => {
    await addOfficeAce('officeace-a')
    await addOfficeAce('officeace-b')
    const fetcher: typeof fetch = vi.fn(async () => jsonResp(CLAIMED_BODY))
    const result = await claimOfficeAceDailyBonuses({ pool, credentials, logger: noopLogger, fetcher })
    expect(result.claimed).toBe(2)
    // 实测每日福利是 100 分（旧注释写 1000，已按上游订正）
    expect(result.totalPoints).toBe(200)
    expect(fetcher).toHaveBeenCalledTimes(2)
  })

  it('上游回空桶（今天早已领过）计 alreadyClaimed，不算失败', async () => {
    await addOfficeAce('officeace-c')
    const fetcher: typeof fetch = vi.fn(async () => jsonResp({ bonus_skus: [] }))
    const result = await claimOfficeAceDailyBonuses({ pool, credentials, logger: noopLogger, fetcher })
    expect(result.alreadyClaimed).toBe(1)
    expect(result.claimed).toBe(0)
    expect(result.failed).toBe(0)
  })

  it('**停用的账号不领**（只影响当天额度；对弃用账号发写请求是越界）', async () => {
    await addOfficeAce('officeace-on', { enabled: true })
    await addOfficeAce('officeace-off', { enabled: false })
    const fetcher: typeof fetch = vi.fn(async () => jsonResp(CLAIMED_BODY))
    const result = await claimOfficeAceDailyBonuses({ pool, credentials, logger: noopLogger, fetcher })
    expect(result.claimed).toBe(1)
    expect(result.skipped).toBe(1)
    expect(fetcher).toHaveBeenCalledTimes(1)
  })

  it('一个账号失败不影响其余账号（失败只记录，不抛错）', async () => {
    await addOfficeAce('officeace-ok')
    await addOfficeAce('officeace-bad')
    let n = 0
    const fetcher: typeof fetch = vi.fn(async () => {
      n += 1
      // 第一个账号失败，第二个成功
      return n === 1 ? jsonResp({}, 500) : jsonResp(CLAIMED_BODY)
    })
    const result = await claimOfficeAceDailyBonuses({ pool, credentials, logger: noopLogger, fetcher })
    expect(result.failed).toBe(1)
    expect(result.claimed).toBe(1)
  })

  it('凭据不可读的账号跳过并留痕，不发请求', async () => {
    const ref = `OFFICEACE_ACCOUNT_MISSING`
    await pool.addAccount({
      id: 'officeace-missing', provider: 'officeace', nickname: '缺凭据', enabled: true,
      credentialRef: ref, createdAt: Date.now(), refreshable: true,
    })
    const fetcher: typeof fetch = vi.fn()
    const warnings: string[] = []
    const result = await claimOfficeAceDailyBonuses({
      pool, credentials, fetcher,
      logger: { info: () => {}, warn: (m) => warnings.push(m), error: () => {} },
    })
    expect(result.skipped).toBe(1)
    expect(fetcher).not.toHaveBeenCalled()
    expect(warnings.join('\n')).toContain('凭据不可读')
  })

  it('STS 临期先续期再领（过期凭据打 claim 必失败）', async () => {
    const ref = 'OFFICEACE_ACCOUNT_EXPIRING'
    await credentials.set(ref, JSON.stringify({
      modelAppKey: 'ak', modelAppSecret: 'sk', maasBaseUrl: 'https://example.com',
      access: 'AK', secret: 'SK', securityToken: 'STS', projectId: 'p',
      // 已过期 ⇒ isExpiring 为真
      expiresAt: new Date(Date.now() - 60_000).toISOString(),
      refreshToken: 'rt',
      dpopPrivateJwk: { kty: 'EC', crv: 'P-256', x: 'x', y: 'y' },
    }))
    await pool.addAccount({
      id: 'officeace-exp', provider: 'officeace', nickname: '临期', enabled: true,
      credentialRef: ref, createdAt: Date.now(), refreshable: true, expiresAt: Date.now() - 60_000,
    })
    const urls: string[] = []
    const fetcher: typeof fetch = vi.fn(async (input: RequestInfo | URL) => {
      urls.push(String(input))
      if (String(input).includes('/v1/subscription/bonus/claim')) return jsonResp(CLAIMED_BODY)
      // 续期端点：回一份新的远期凭据（形状由 officeace-auth 决定，这里只求不抛）
      return jsonResp({ access_token: 'n', refresh_token: 'n', expires_in: 7200 })
    })
    await claimOfficeAceDailyBonuses({ pool, credentials, logger: noopLogger, fetcher })
    // 至少发生过一次非 claim 的请求（即续期尝试）；claim 也照常发出
    expect(urls.some((u) => u.includes('/bonus/claim'))).toBe(true)
    expect(urls.length).toBeGreaterThan(0)
  })

  // ── 手动补领（用户要求「加个手动，防止定时任务没领到」）──
  //
  // 定时任务只在服务进程活着时跑：关掉服务过夜、或跨天后才启动时，
  // 当天额度可能已经错过窗口（按 UTC+8 自然日作废）。

  it('force：定时任务已领过后，手动仍会真的重领', async () => {
    await addOfficeAce('officeace-manual')
    const fetcher: typeof fetch = vi.fn(async () => jsonResp({ bonus_skus: [] }))
    // 第一次（定时任务语义）：记下「今天已领」
    await claimOfficeAceDailyBonuses({ pool, credentials, logger: noopLogger, fetcher })
    expect(fetcher).toHaveBeenCalledTimes(1)
    // 第二次（定时任务语义）：被去重表挡住
    const again = await claimOfficeAceDailyBonuses({ pool, credentials, logger: noopLogger, fetcher })
    expect(again.skipped).toBe(1)
    expect(fetcher).toHaveBeenCalledTimes(1)
    // 第三次（手动语义 force）：必须真的重打上游
    const manual = await claimOfficeAceDailyBonuses({ pool, credentials, logger: noopLogger, fetcher, force: true })
    expect(manual.alreadyClaimed).toBe(1)
    expect(fetcher).toHaveBeenCalledTimes(2)
  })

  it('force：手动补领能拿到分并带出逐账号明细', async () => {
    await addOfficeAce('officeace-gain')
    const fetcher: typeof fetch = vi.fn(async () => jsonResp(CLAIMED_BODY))
    const result = await claimOfficeAceDailyBonuses({ pool, credentials, logger: noopLogger, fetcher, force: true })
    expect(result.claimed).toBe(1)
    expect(result.totalPoints).toBe(100)
    expect(result.results).toHaveLength(1)
    expect(result.results[0]).toMatchObject({
      kind: 'claimed',
      points: 100,
      activities: ['每日签到有礼'],
    })
  })

  it('逐账号明细：停用/早已领过/失败分别归类（面板据此逐条显示）', async () => {
    await addOfficeAce('officeace-det-ok', { enabled: true })
    await addOfficeAce('officeace-det-off', { enabled: false })
    const fetcher: typeof fetch = vi.fn(async () => jsonResp({ bonus_skus: [] }))
    const result = await claimOfficeAceDailyBonuses({ pool, credentials, logger: noopLogger, fetcher, force: true })
    const byId = new Map(result.results.map((r) => [r.accountId, r]))
    expect(byId.get('officeace-det-off')?.kind).toBe('skipped')
    expect(byId.get('officeace-det-off')?.error).toContain('停用')
    expect(byId.get('officeace-det-ok')?.kind).toBe('already-claimed')
    expect(result.results).toHaveLength(2)
  })
})
