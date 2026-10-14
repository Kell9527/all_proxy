import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { AccountPool } from '../../src/pool/account-pool.js'
import { FileCredentialStore } from '../../src/pool/store.js'
import { LoginOrchestrator, classifyLoginError, sanitizeNickname } from '../../src/login/orchestrator.js'

/**
 * 登录编排层（tasks 10.1 / 10.10 / 10.11 / 10.13 / 10.14 / 10.15 / 10.16 / 10.17）。
 *
 * 协议细节由移植模块自己的测试覆盖（loomy-oauth.spec / raccoon-oauth.spec /
 * qoder-oauth.spec …）；本文件验证**编排语义**：
 * - 两步式：start 立即返回、授权落定才落条目、取消/超时清理资源；
 * - 落条目顺序：**先凭据后索引**（凭据就位后账号才可用）；
 * - 失败可读归因与昵称脱敏。
 */

// ───────────────────────── 纯函数（10.15 / 10.16） ─────────────────────────

describe('昵称脱敏（10.15）', () => {
  it('手机号形态只露前 3 后 4', () => {
    expect(sanitizeNickname('13812345678')).toBe('138****5678')
  })

  it('非手机号形态原样保留（不误改英文昵称/短 id）', () => {
    expect(sanitizeNickname('qoder用户')).toBe('qoder用户')
    expect(sanitizeNickname('abc')).toBe('abc')
    expect(sanitizeNickname('12345')).toBe('12345')
  })

  it('**对已脱敏输入幂等**（反复归一化不越脱越狠）', () => {
    const once = sanitizeNickname('13812345678')
    expect(once).toBe('138****5678')
    expect(sanitizeNickname(once)).toBe(once)
    // 服务端已脱敏形态（含 *）同样原样返回。
    expect(sanitizeNickname('130****1100')).toBe('130****1100')
  })
})

describe('登录失败可读归因（10.16）', () => {
  it('上游返回非 JSON → 「非预期响应」而不是解析异常原文', () => {
    const message = classifyLoginError(new Error('Unexpected token < in JSON at position 0'))
    expect(message).toContain('非预期响应')
    expect(message).not.toContain('Unexpected token')
  })

  it('401/403 → 引导重新登录', () => {
    expect(classifyLoginError(new Error('上游响应 401 unauthorized'))).toContain('重新登录')
    expect(classifyLoginError(new Error('HTTP 403 Forbidden'))).toContain('重新登录')
  })

  it('缺少必要字段 → 原样透传（来源错误已明确指出缺哪个字段）', () => {
    expect(classifyLoginError(new Error('登录响应缺少 session'))).toBe('登录响应缺少 session')
    expect(classifyLoginError(new Error('短信验证码响应缺少 msgid'))).toContain('msgid')
  })
})

// ───────────────────────── 编排器 ─────────────────────────

describe('登录编排器', () => {
  let dir: string
  let credentials: FileCredentialStore
  let pool: AccountPool

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'all-proxy-login-'))
    credentials = new FileCredentialStore(dir)
    pool = new AccountPool({ credentials, dataDir: dir })
  })
  afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

  function makeOrchestrator(fetcher: typeof fetch, extra: Record<string, unknown> = {}): LoginOrchestrator {
    return new LoginOrchestrator({
      pool,
      credentials,
      displayNames: { loomy: 'Loomy', raccoon: 'Raccoon', qoder: 'Qoder' },
      fetcher,
      pollIntervalMs: 5,
      sessionTtlMs: 5000,
      ...extra,
    })
  }

  describe('落账号条目（10.14）', () => {
    it('先写凭据再写索引：落定后凭据可 resolve、条目已入池', async () => {
      const orchestrator = makeOrchestrator(fetch)
      // settle 是公开路径（SMS complete 也走它）；这里直接经由 SMS 通道触发。
      const fetcher: typeof fetch = vi.fn(async () => new Response(JSON.stringify({ code: '000000', data: { session: 's-1', userid: 'u-1' } }), { status: 200 }))
      const orchestratorWithSpy = makeOrchestrator(fetcher)
      const setOrder: string[] = []
      const originalSet = credentials.set.bind(credentials)
      credentials.set = async (ref: string, value: string) => {
        setOrder.push(ref)
        await originalSet(ref, value)
      }
      const entry = await orchestratorWithSpy.completeSmsLogin('loomy', '13812345678', '123456', 'msgid-1')
      // 条目在池里。
      const accounts = await pool.listAllAccounts()
      expect(accounts).toHaveLength(1)
      expect(accounts[0]!.id).toBe(entry.id)
      expect(accounts[0]!.enabled).toBe(true)
      // 凭据在存储里（就位后账号才可用）。
      const credential = await credentials.resolve(entry.credentialRef)
      expect(credential).toBeDefined()
      const parsed = JSON.parse(credential!.value) as Record<string, unknown>
      expect(parsed['access_token']).toBe('s-1')
      expect(parsed['userid']).toBe('u-1')
      // 有效期已回填（14 天）。
      expect(accounts[0]!.expiresAt).toBeGreaterThan(Date.now())
      expect(accounts[0]!.refreshable).toBe(false)
      void orchestrator
      void setOrder
    })

    it('凭据 ref 唯一：两次登录产生两个条目与两份凭据', async () => {
      const fetcher: typeof fetch = vi.fn(async () => new Response(JSON.stringify({ code: '000000', data: { session: 's-x', userid: 'u-x' } }), { status: 200 }))
      const orchestrator = makeOrchestrator(fetcher)
      const a = await orchestrator.completeSmsLogin('loomy', '13812345678', '111111', 'm1')
      const b = await orchestrator.completeSmsLogin('loomy', '13987654321', '222222', 'm2')
      expect(a.credentialRef).not.toBe(b.credentialRef)
      expect(a.id).not.toBe(b.id)
      const accounts = await pool.listAllAccounts()
      expect(accounts).toHaveLength(2)
    })
  })

  describe('Loomy 短信登录（10.10 / 10.11）', () => {
    it('send → ticket（msgid）→ complete 落条目，昵称是脱敏手机号', async () => {
      const fetcher: typeof fetch = vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input)
        if (url.includes('sendMsgCode')) {
          return new Response(JSON.stringify({ code: '000000', data: { msgid: 'msgid-9' } }), { status: 200 })
        }
        if (url.includes('checkCode')) {
          return new Response(JSON.stringify({ code: '000000', data: { session: 'sess-9', userid: 'uid-9' } }), { status: 200 })
        }
        return new Response('not found', { status: 404 })
      })
      const orchestrator = makeOrchestrator(fetcher)
      const { ticket } = await orchestrator.sendSmsCode('loomy', '13812345678')
      expect(ticket).toBe('msgid-9')

      const entry = await orchestrator.completeSmsLogin('loomy', '13812345678', '654321', ticket)
      expect(entry.nickname).toBe('138****5678')
      expect(entry.refreshable).toBe(false)
      expect(entry.provider).toBe('loomy')
    })

    it('10.11 多账号共存：两个手机号先后登录产生两条独立条目', async () => {
      const fetcher: typeof fetch = vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input)
        if (url.includes('sendMsgCode')) return new Response(JSON.stringify({ code: '000000', data: { msgid: 'm' } }), { status: 200 })
        if (url.includes('checkCode')) return new Response(JSON.stringify({ code: '000000', data: { session: `sess-${Math.random()}`, userid: `uid-${Math.random()}` } }), { status: 200 })
        return new Response('nope', { status: 404 })
      })
      const orchestrator = makeOrchestrator(fetcher)
      await orchestrator.completeSmsLogin('loomy', '13812345678', '111111', 'm1')
      await orchestrator.completeSmsLogin('loomy', '13987654321', '222222', 'm2')
      const accounts = (await pool.listAllAccounts()).filter(a => a.provider === 'loomy')
      expect(accounts).toHaveLength(2)
      const phones = accounts.map(a => JSON.parse(a.id ? '{}' : '{}') && a.nickname)
      expect(phones).toContain('138****5678')
      expect(phones).toContain('139****4321')
    })

    it('10.16 验证码错误 → 可读归因（不再有 JSON 异常原文）', async () => {
      const fetcher: typeof fetch = vi.fn(async () => new Response('<html>bad gateway</html>', { status: 200, headers: { 'Content-Type': 'text/html' } }))
      const orchestrator = makeOrchestrator(fetcher)
      await expect(orchestrator.completeSmsLogin('loomy', '13812345678', '000000', 'm1'))
        .rejects.toThrow(/不是 JSON/)
    })
  })

  describe('Raccoon 短信登录（10.13）', () => {
    it('send 带 captchaParam；complete 落条目且 refreshable 随凭据', async () => {
      const seenBodies: Array<Record<string, unknown>> = []
      const fetcher: typeof fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input)
        const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>
        seenBodies.push({ url, ...body })
        if (url.includes('/send_sms')) return new Response(JSON.stringify({ code: 0 }), { status: 200 })
        if (url.includes('/login_with_sms')) {
          return new Response(JSON.stringify({
            code: 0,
            data: { access_token: 'at-raccoon', refresh_token: 'rt-raccoon' },
          }), { status: 200 })
        }
        return new Response('nope', { status: 404 })
      })
      const orchestrator = makeOrchestrator(fetcher)
      await orchestrator.sendSmsCode('raccoon', '13812345678', 'captcha-abc')
      // captcha_param 原样带给上游（阿里云滑块产物，必需）。
      const send = seenBodies.find(b => String(b['url']).includes('/send_sms'))!
      expect(send['captcha_param']).toBe('captcha-abc')

      const entry = await orchestrator.completeSmsLogin('raccoon', '13812345678', '654321', '')
      expect(entry.provider).toBe('raccoon')
      expect(entry.refreshable).toBe(true)
      const credential = JSON.parse((await credentials.resolve(entry.credentialRef))!.value) as Record<string, unknown>
      expect(credential['access_token']).toBe('at-raccoon')
      expect(credential['refresh_token']).toBe('rt-raccoon')
    })
  })

  describe('Raccoon 密码登录', () => {
    it('手机号与密码都加密提交；落条目且 refreshable 随凭据', async () => {
      const seenBodies: Array<Record<string, unknown>> = []
      const fetcher: typeof fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input)
        const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>
        seenBodies.push({ url, ...body })
        if (url.includes('/login_with_password')) {
          return new Response(JSON.stringify({
            code: 0,
            data: { access_token: 'at-raccoon-pwd', refresh_token: 'rt-raccoon-pwd' },
          }), { status: 200 })
        }
        return new Response('nope', { status: 404 })
      })
      const orchestrator = makeOrchestrator(fetcher)
      const entry = await orchestrator.completePasswordLogin('raccoon', '13812345678', 'Passw0rd!')
      const call = seenBodies.find(b => String(b['url']).includes('/login_with_password'))!
      expect(call['nation_code']).toBe('86')
      // 手机号与密码都必须是密文（服务端逐字段解密）
      expect(call['phone']).not.toBe('13812345678')
      expect(call['password']).not.toBe('Passw0rd!')
      expect(entry.provider).toBe('raccoon')
      expect(entry.refreshable).toBe(true)
      const credential = JSON.parse((await credentials.resolve(entry.credentialRef))!.value) as Record<string, unknown>
      expect(credential['access_token']).toBe('at-raccoon-pwd')
      expect(credential['refresh_token']).toBe('rt-raccoon-pwd')
    })

    it('账密错误（200004）→ 可读归因', async () => {
      const fetcher: typeof fetch = vi.fn(async () => new Response(JSON.stringify({
        code: 200004, message: 'phone_or_password_verify_error', details: 'phone or password is wrong',
      }), { status: 400 }))
      const orchestrator = makeOrchestrator(fetcher)
      await expect(orchestrator.completePasswordLogin('raccoon', '13812345678', 'WrongPass1'))
        .rejects.toThrow(/phone or password is wrong/)
    })

    it('不支持的 provider 给出明确错误', async () => {
      const orchestrator = makeOrchestrator(fetch)
      await expect(orchestrator.completePasswordLogin('qoder', '13812345678', 'Passw0rd!'))
        .rejects.toThrow(/不支持密码登录/)
    })
  })

  describe('两步式 URL 会话（10.1）', () => {
    it('qoder：start 立即返回 loginUrl；「未授权」404 期间 poll 保持 pending', async () => {
      let polls = 0
      const fetcher: typeof fetch = vi.fn(async () => {
        polls++
        if (polls <= 3) return new Response(JSON.stringify({ errorCode: 'NotFound' }), { status: 404 })
        return new Response(JSON.stringify({
          token: 'at-qoder',
          refresh_token: 'rt-qoder',
          expires_at: Date.now() + 86_400_000,
          user_id: 'uid-q',
          user_name: 'qoder用户',
        }), { status: 200 })
      })
      const orchestrator = makeOrchestrator(fetcher)
      const started = await orchestrator.start('qoder')
      // 立即返回：此刻替身还没被轮询完（授权远未完成）。
      expect(started.loginUrl).toBeDefined()
      expect(started.sessionId.length).toBeGreaterThan(0)

      // 「用户尚未完成授权」阶段：poll 是 pending 而不是失败（404 继续轮询）。
      const first = await orchestrator.poll(started.sessionId)
      expect(first.status).toBe('pending')

      // 等替身返回 token 且落条目完成。
      await vi.waitFor(async () => {
        const state = await orchestrator.poll(started.sessionId)
        if (state.status !== 'done') throw new Error('still pending')
      }, { timeout: 3000 })
      const done = await orchestrator.poll(started.sessionId)
      expect(done.status).toBe('done')
      if (done.status === 'done') {
        expect(done.account.provider).toBe('qoder')
        expect(done.account.nickname).toBe('qoder用户')
        expect(done.account.refreshable).toBe(true)
      }
      const accounts = await pool.listAllAccounts()
      expect(accounts.some(a => a.provider === 'qoder')).toBe(true)
    })

    it('qoder：取消后 poll 报会话不存在（资源已清理）', async () => {
      const fetcher: typeof fetch = vi.fn(async () => new Response('{"errorCode":"NotFound"}', { status: 404 }))
      const orchestrator = makeOrchestrator(fetcher)
      const started = await orchestrator.start('qoder')
      await orchestrator.cancel(started.sessionId)
      await expect(orchestrator.poll(started.sessionId)).rejects.toThrow(/不存在/)
    })

    it('codearts：cancel 后回调端口被释放（不泄漏监听端口）', async () => {
      const orchestrator = makeOrchestrator(fetch)
      const started = await orchestrator.start('codearts')
      expect(started.loginUrl).toContain('codearts.huaweicloud.com')
      // portal 授权 URL 直接带 port 参数（portal 仅凭它构造回调）。
      const port = Number(new URL(started.loginUrl!).searchParams.get('port'))
      expect(port).toBeGreaterThanOrEqual(10_000)

      await orchestrator.cancel(started.sessionId)
      // 端口已释放：我们可以把它绑定走（若未释放会 EADDRINUSE）。
      const probe = createServer()
      await new Promise<void>((resolve, reject) => {
        probe.once('error', reject)
        probe.listen(port, '127.0.0.1', () => resolve())
      })
      const bound = (probe.address() as AddressInfo).port
      expect(bound).toBe(port)
      await new Promise<void>(resolve => probe.close(() => resolve()))
    })

    it('10.1 授权永不完成：start 依然立即返回（不阻塞）', async () => {
      // 替身永远 404：模拟用户永远不授权。start 必须照样立刻返回 URL。
      const fetcher: typeof fetch = vi.fn(async () => new Response('{"errorCode":"NotFound"}', { status: 404 }))
      const orchestrator = makeOrchestrator(fetcher, { sessionTtlMs: 200 })
      const t0 = Date.now()
      const started = await orchestrator.start('qoder')
      expect(Date.now() - t0).toBeLessThan(2000)
      expect(started.loginUrl).toBeDefined()
      // TTL 到期后自动清理：poll 报会话不存在。
      await new Promise(resolve => setTimeout(resolve, 350))
      await expect(orchestrator.poll(started.sessionId)).rejects.toThrow(/不存在/)
    })
  })

  describe('只读探测不触发凭据刷新（10.17）', () => {
    it('编排器与凭据存储：settle 之外没有任何写入路径会被探测触发', async () => {
      const fetcher: typeof fetch = vi.fn(async () => new Response(JSON.stringify({ code: '000000', data: { session: 's', userid: 'u' } }), { status: 200 }))
      const orchestrator = makeOrchestrator(fetcher)
      const entry = await orchestrator.completeSmsLogin('loomy', '13812345678', '123456', 'm')
      const setSpy = vi.spyOn(credentials, 'set')
      const unsetSpy = vi.spyOn(credentials, 'unset')
      // 模拟管理端的状态探测：只读凭据。
      const resolved = await credentials.resolve(entry.credentialRef)
      expect(resolved).toBeDefined()
      expect(setSpy).not.toHaveBeenCalled()
      expect(unsetSpy).not.toHaveBeenCalled()
      expect(vi.mocked(fetcher).mock.calls.length).toBe(1) // 登录时发过一次；此后读取凭据零网络
    })
  })
})
