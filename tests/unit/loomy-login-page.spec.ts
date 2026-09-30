import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { LOOMY } from '../../src/providers/loomy-product.js'
import { LOOMY_LOGIN_PATH, LOOMY_SMS_SEND_PATH, LOOMY_SMS_VERIFY_PATH, startLoomyLoginFlow } from '../../src/providers/loomy-login-page.js'

/**
 * Loomy 手机号登录页（主路径，tasks 10.10 的链接式落点）。
 *
 * 验证「弹窗 + 轮询」契约：start 立即返回 loginUrl；发码/验证走本地端点；
 * 验证成功后 result 落定 {session, userid, phone}（orchestrator 落账号条目
 * 的形状来源）。敏感 msgid 只在宿主侧，页面侧不可见。
 */

/** 讯飞账号端点信封（成功的 code 是字符串 '000000'）。 */
function envelope(data: unknown, code = '000000', message = ''): unknown {
  return { code, message, data }
}

/** 按 URL 分派的替身 fetch。 */
function makeFetcher(behaviors: {
  onSend?: (body: Record<string, unknown>) => { status?: number; payload: unknown }
  onVerify?: (body: Record<string, unknown>) => { status?: number; payload: unknown }
}): { fetcher: typeof fetch; calls: Array<{ url: string; body: Record<string, unknown> }> } {
  const calls: Array<{ url: string; body: Record<string, unknown> }> = []
  const fetcher: typeof fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>
    calls.push({ url, body })
    if (url.includes('/login/phone/sendMsgCode')) {
      const behavior = behaviors.onSend?.(body)
      return new Response(JSON.stringify(behavior?.payload ?? envelope({ msgid: 'msgid-1' })), {
        status: behavior?.status ?? 200, headers: { 'Content-Type': 'application/json' },
      })
    }
    if (url.includes('/login/phone/checkCode')) {
      const behavior = behaviors.onVerify?.(body)
      return new Response(JSON.stringify(behavior?.payload ?? envelope({ session: 'sess-1', userid: 'uid-1' })), {
        status: behavior?.status ?? 200, headers: { 'Content-Type': 'application/json' },
      })
    }
    return new Response('not found', { status: 404 })
  })
  return { fetcher, calls }
}

describe('Loomy 手机号登录页', () => {
  const flows: Array<() => Promise<void>> = []

  beforeEach(() => { flows.length = 0 })
  afterEach(async () => {
    for (const close of flows.splice(0)) {
      await close().catch(() => {})
    }
  })

  it('start 立即返回 loginUrl（本地登录页），不阻塞授权', async () => {
    const { fetcher } = makeFetcher({})
    const flow = await startLoomyLoginFlow({ product: LOOMY, fetcher, timeoutMs: 3000 })
    flows.push(flow.close)
    expect(flow.loginUrl).toContain('127.0.0.1:')
    expect(flow.loginUrl.endsWith(LOOMY_LOGIN_PATH)).toBe(true)
  })

  it('发码 → 验证 → result 落定 {session, userid, phone}', async () => {
    const { fetcher, calls } = makeFetcher({})
    const flow = await startLoomyLoginFlow({ product: LOOMY, fetcher, timeoutMs: 3000 })
    flows.push(flow.close)

    const page = await fetch(flow.loginUrl)
    expect(page.status).toBe(200)
    const html = await page.text()
    expect(html).toContain('手机号')
    expect(html).toContain('验证码')

    // 1. 发码。
    const sendRes = await fetch(new URL(LOOMY_SMS_SEND_PATH, flow.loginUrl), {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ phone: '13812345678' }),
    })
    expect(sendRes.status).toBe(200)
    // 发码请求带有正确手机号与 expire，拿到服务端 msgid。
    expect(calls[0]!.url).toContain('/login/phone/sendMsgCode')
    expect((calls[0]!.body['param'] as Record<string, unknown>)['phone']).toBe('13812345678')

    // 2. 验证码登录。
    const verifyRes = await fetch(new URL(LOOMY_SMS_VERIFY_PATH, flow.loginUrl), {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ phone: '13812345678', code: '654321' }),
    })
    expect(verifyRes.status).toBe(200)
    // 提交时把 msgid 原样带回（服务端判有效性的依据）。
    expect(calls[1]!.url).toContain('/login/phone/checkCode')
    expect((calls[1]!.body['param'] as Record<string, unknown>)['msgid']).toBe('msgid-1')
    expect((calls[1]!.body['param'] as Record<string, unknown>)['mcode']).toBe('654321')

    // 3. result 落定。
    const outcome = await flow.result
    expect(outcome).toEqual({ session: 'sess-1', userid: 'uid-1', phone: '13812345678' })
  })

  it('手机号格式非法 → 400（不发上游）', async () => {
    const { fetcher, calls } = makeFetcher({})
    const flow = await startLoomyLoginFlow({ product: LOOMY, fetcher, timeoutMs: 3000 })
    flows.push(flow.close)
    const res = await fetch(new URL(LOOMY_SMS_SEND_PATH, flow.loginUrl), {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ phone: '123' }),
    })
    expect(res.status).toBe(400)
    expect(calls).toHaveLength(0)
  })

  it('未先发码就提交验证码 → 400 提示先发码', async () => {
    const { fetcher } = makeFetcher({})
    const flow = await startLoomyLoginFlow({ product: LOOMY, fetcher, timeoutMs: 3000 })
    flows.push(flow.close)
    const res = await fetch(new URL(LOOMY_SMS_VERIFY_PATH, flow.loginUrl), {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ phone: '13812345678', code: '654321' }),
    })
    expect(res.status).toBe(400)
    const body = await res.json() as { error: string }
    expect(body.error).toContain('发送验证码')
  })

  it('发码失败（上游业务码非 0）→ 400 带可读原因', async () => {
    const { fetcher } = makeFetcher({ onSend: () => ({ payload: envelope(null, '020003', '发送过于频繁') }) })
    const flow = await startLoomyLoginFlow({ product: LOOMY, fetcher, timeoutMs: 3000 })
    flows.push(flow.close)
    const res = await fetch(new URL(LOOMY_SMS_SEND_PATH, flow.loginUrl), {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ phone: '13812345678' }),
    })
    expect(res.status).toBe(400)
    const body = await res.json() as { error: string }
    expect(body.error).toContain('发送过于频繁')
  })
})
