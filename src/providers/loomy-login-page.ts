/**
 * Loomy 手机号验证码登录的本地弹窗页（**主路径**，design D12）。
 *
 * ## 为什么是本地服务器而不是管理端表单
 *
 * Jet Hub 的「+ 新建账号」走统一契约：`account.create` 返回 `loginUrl`，
 * 前端在用户手势窗口内 `window.open` 再轮询结果。Loomy 若只提供扫码，
 * 用户只有一个微信号就永远只能登一个账号（DSH 侧的真实困扰）；手机号路径
 * 可以多账号，是设计上的主路径。把手机号表单做成本地页，就与 codearts /
 * lobsterai / qoder / trae / cline / raccoon 的「弹窗 + 轮询」体验完全一致，
 * 前端零改动。
 *
 * ## 流程
 *
 * ```
 * GET  /loomy/login          → 弹窗页（手机号 + 验证码表单）
 * POST /loomy/login/send     { phone }        → sendLoomySmsCode（讯飞账号 HMAC-SHA1）
 * POST /loomy/login/verify   { phone, code }  → loginLoomyBySmsCode（msgid 服务端持有）
 * ```
 *
 * 敏感状态（`msgid`）只在**宿主侧内存**，页面侧不知道；手机号加密与签名
 * 由移植过来的 `loomy-oauth.ts` 完成。
 */

import { createServer } from 'node:http'
import type { IncomingMessage, Server, ServerResponse } from 'node:http'
import { loginLoomyBySmsCode, sendLoomySmsCode, type LoomyLoginResult } from './loomy-oauth.js'
import type { LoomyProduct } from './loomy-product.js'

/** 登录页路径。 */
export const LOOMY_LOGIN_PATH = '/loomy/login'

/** 发码路径。 */
export const LOOMY_SMS_SEND_PATH = '/loomy/login/send'

/** 验证路径。 */
export const LOOMY_SMS_VERIFY_PATH = '/loomy/login/verify'

/** 授权总超时（与微信扫码同口径：5 分钟）。 */
export const LOOMY_LOGIN_TIMEOUT_MS = 5 * 60 * 1000

/** `startLoomyLoginFlow` 的选项。 */
export interface LoomyLoginFlowOptions {
  product: LoomyProduct
  /** 注入的 fetch（测试用）。 */
  fetcher?: typeof fetch
  /** 超时（毫秒）。 */
  timeoutMs?: number
}

/** 已启动的登录流程（两步式契约，与其余 provider 同形）。 */
export interface StartedLoomyLoginFlow {
  /** 展示给用户的登录 URL（本地弹窗页）。 */
  loginUrl: string
  /** 用户完成登录（或超时/失败）后落定的结果。 */
  result: Promise<LoomyLoginResult & { phone: string }>
  /** 关闭本地服务器；**幂等**，可重复调用。 */
  close: () => Promise<void>
}

/** 服务端持有的会话状态（页面侧不可见）。 */
interface FlowState {
  /** 最近一次发码成功的 msgid（提交验证码时必须原样带回）。 */
  msgid: string
}

/** 结果类型（与微信扫码分支统一，orchestrator 无感消费）。 */
type LoginOutcome = LoomyLoginResult & { phone: string }

/**
 * 启动手机号验证码登录流程。
 *
 * **立即返回** loginUrl 与 result promise，不阻塞 —— 与其余 provider 的
 * 「两步式」约束一致。
 */
export async function startLoomyLoginFlow(options: LoomyLoginFlowOptions): Promise<StartedLoomyLoginFlow> {
  const fetcher = options.fetcher ?? fetch
  const product = options.product
  const state: FlowState = { msgid: '' }

  let resolveResult!: (value: LoginOutcome) => void
  let rejectResult!: (reason: unknown) => void
  const result = new Promise<LoginOutcome>((resolve, reject) => {
    resolveResult = resolve
    rejectResult = reject
  })
  // 先挂空处理器：用户极快失败/超时发生时避免 unhandled rejection。
  result.catch(() => {})

  let settled = false
  const settleOk = (value: LoginOutcome): void => {
    if (settled) return
    settled = true
    resolveResult(value)
  }
  const settleErr = (error: unknown): void => {
    if (settled) return
    settled = true
    rejectResult(error)
  }

  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    void handleRequest(request, response, { state, product, fetcher, settleOk }).catch((error: unknown) => {
      writeJson(response, { error: error instanceof Error ? error.message : String(error) }, 500)
    })
  })

  const port = await listenOnRandomPort(server)
  const loginUrl = `http://127.0.0.1:${port}${LOOMY_LOGIN_PATH}`

  let closed = false
  const close = async (): Promise<void> => {
    if (closed) return
    closed = true
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }

  const timeoutMs = options.timeoutMs ?? LOOMY_LOGIN_TIMEOUT_MS
  const timer = setTimeout(() => {
    settleErr(new Error(`Loomy 手机号登录超时（${Math.round(timeoutMs / 1000)} 秒内未完成）`))
  }, timeoutMs)
  timer.unref?.()

  // 结果落定即关服务器（含超时与失败路径），不留泄漏端口。
  result.catch(() => {}).finally(() => {
    clearTimeout(timer)
    void close()
  })

  return { loginUrl, result, close }
}

/** 中国大陆手机号形态。 */
const PHONE_RE = /^1[3-9]\d{9}$/

/** 处理一次本地请求。 */
async function handleRequest(
  request: IncomingMessage,
  response: ServerResponse,
  deps: {
    state: FlowState
    product: LoomyProduct
    fetcher: typeof fetch
    settleOk: (value: LoginOutcome) => void
  },
): Promise<void> {
  const url = new URL(request.url ?? '/', `http://127.0.0.1:${request.socket.localPort ?? 0}`)
  const { state, product, fetcher } = deps

  if (url.pathname === LOOMY_LOGIN_PATH) {
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
    response.end(renderLoginPage())
    return
  }

  if (url.pathname === LOOMY_SMS_SEND_PATH && request.method === 'POST') {
    const body = await readJsonBody(request)
    const phone = typeof body['phone'] === 'string' ? body['phone'].trim() : ''
    if (!PHONE_RE.test(phone)) {
      writeJson(response, { error: '手机号格式不正确（11 位中国大陆号码）' }, 400)
      return
    }
    try {
      state.msgid = await sendLoomySmsCode(phone, product, fetcher)
      writeJson(response, { ok: true })
    } catch (error) {
      writeJson(response, { error: error instanceof Error ? error.message : String(error) }, 400)
    }
    return
  }

  if (url.pathname === LOOMY_SMS_VERIFY_PATH && request.method === 'POST') {
    const body = await readJsonBody(request)
    const phone = typeof body['phone'] === 'string' ? body['phone'].trim() : ''
    const code = typeof body['code'] === 'string' ? body['code'].trim() : ''
    if (!PHONE_RE.test(phone)) {
      writeJson(response, { error: '手机号格式不正确' }, 400)
      return
    }
    if (code.length === 0) {
      writeJson(response, { error: '请输入验证码' }, 400)
      return
    }
    if (state.msgid.length === 0) {
      writeJson(response, { error: '请先点击「发送验证码」' }, 400)
      return
    }
    try {
      const login = await loginLoomyBySmsCode(phone, code, state.msgid, product, fetcher)
      deps.settleOk({ ...login, phone })
      writeJson(response, { ok: true })
    } catch (error) {
      writeJson(response, { error: error instanceof Error ? error.message : String(error) }, 400)
    }
    return
  }

  response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
  response.end('not found')
}

/** 监听随机本地端口（127.0.0.1）。 */
function listenOnRandomPort(server: Server): Promise<number> {
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      resolve(typeof address === 'object' && address !== null ? address.port : 0)
    })
  })
}

/** 读 JSON body（小型表单请求，容纳 8 KB）。 */
async function readJsonBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of request) {
    const buf = chunk as Buffer
    size += buf.length
    if (size > 8 * 1024) break
    chunks.push(buf)
  }
  const text = Buffer.concat(chunks).toString('utf-8').trim()
  if (text.length === 0) return {}
  try {
    const parsed = JSON.parse(text) as unknown
    return typeof parsed === 'object' && parsed !== null ? parsed as Record<string, unknown> : {}
  } catch {
    return {}
  }
}

/** 写 JSON 响应。 */
function writeJson(response: ServerResponse, payload: unknown, status = 200): void {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' })
  response.end(JSON.stringify(payload))
}

/** 弹窗页：手机号 + 验证码表单（无外部资源，data 全部走本地端点）。 */
function renderLoginPage(): string {
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Loomy 手机号登录</title>
<style>
  body { font-family: system-ui, sans-serif; background: #f6f7f9; margin: 0; min-height: 100vh; display: flex; align-items: center; justify-content: center; }
  .card { background: #fff; border-radius: 12px; padding: 28px; width: 320px; box-shadow: 0 4px 24px rgba(0,0,0,.08); }
  h1 { font-size: 17px; margin: 0 0   px; }
  p.dim { color: #7a7f87; font-size: 12px; margin: 0 0 18px; }
  input { width: 100%; box-sizing: border-box; padding: 9px 10px; border: 1px solid #d6d9de; border-radius: 7px; font-size: 14px; margin-bottom: 12px; }
  button { width: 100%; padding: 10px 0; border: 0; border-radius: 7px; background: #2b5cff; color: #fff; font-size: 14px; cursor: pointer; }
  button.ghost { background: #eef1f6; color: #2b2f36; margin-top: 8px; }
  button:disabled { background: #b9c2d0; cursor: default; }
  .row { display: flex; gap: 8px; }
  .row input { flex: 1; }
  .row button { width: auto; padding: 9px 12px; white-space: nowrap; }
  .msg { font-size: 13px; margin: 10px 0 0; min-height: 18px; }
  .msg.err { color: #c0392b; }
  .msg.ok { color: #1e8e4a; }
</style>
</head>
<body>
<div class="card">
  <h1>Loomy 手机号登录</h1>
  <p class="dim">验证码登录（可登录多个账号）。登录成功后此页可关闭。</p>
  <input id="phone" type="tel" maxlength="11" placeholder="手机号" />
  <div class="row">
    <input id="code" type="text" maxlength="8" placeholder="短信验证码" />
    <button id="send" class="ghost" onclick="send()">发送验证码</button>
  </div>
  <button id="login" onclick="login()">登 录</button>
  <div id="msg" class="msg"></div>
</div>
<script>
  const $ = (id) => document.getElementById(id)
  const say = (text, cls) => { const m = $('msg'); m.textContent = text; m.className = 'msg ' + (cls || '') }
  async function send() {
    const phone = $('phone').value.trim()
    if (!/^1[3-9]\\d{9}$/.test(phone)) { say('手机号格式不正确', 'err'); return }
    $('send').disabled = true
    say('正在发送…')
    try {
      const res = await fetch('${LOOMY_SMS_SEND_PATH}', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ phone }),
      })
      const data = await res.json()
      if (!res.ok) { say(data.error || '发送失败', 'err'); return }
      let left = 60
      say('验证码已发送，60 秒后可重发', 'ok')
      const timer = setInterval(() => {
        left -= 1
        $('send').textContent = left > 0 ? left + ' 秒' : '重新发送'
        if (left <= 0) { clearInterval(timer); $('send').disabled = false }
      }, 1000)
    } catch (e) {
      say('网络错误：' + e.message, 'err')
    } finally {
      if ($('send').textContent === '发送验证码') $('send').disabled = false
    }
  }
  async function login() {
    const phone = $('phone').value.trim()
    const code = $('code').value.trim()
    if (code.length === 0) { say('请输入验证码', 'err'); return }
    $('login').disabled = true
    say('正在登录…')
    try {
      const res = await fetch('${LOOMY_SMS_VERIFY_PATH}', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ phone, code }),
      })
      const data = await res.json()
      if (!res.ok) { say(data.error || '登录失败', 'err'); $('login').disabled = false; return }
      say('登录成功，可关闭此页', 'ok')
      setTimeout(() => window.close(), 1200)
    } catch (e) {
      say('网络错误：' + e.message, 'err')
      $('login').disabled = false
    }
  }
  $('phone').addEventListener('keydown', (e) => { if (e.key === 'Enter') send() })
  $('code').addEventListener('keydown', (e) => { if (e.key === 'Enter') login() })
</script>
</body>
</html>`
}

