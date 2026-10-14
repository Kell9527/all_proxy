/**
 * Accio 登录编排：标准 OAuth 2.0 + PKCE，回调落在**本项目自己的** loopback。
 *
 * ## 为什么能脱离 IDE
 *
 * Accio 走标准 PKCE（公开客户端 `accio-work`、无 secret），且对 `return_url`
 * **无白名单校验** ⇒ 可以用自己的 loopback 完成授权，完全不需要 IDE。
 *
 * ## 与其余 provider 的形态一致
 *
 * 与 `lobsterai-oauth.ts` / `trae-oauth.ts` 同款：起一个临时 HTTP 服务器监听
 * 回调，`start` 立即返回 `loginUrl`，授权结果由返回的 Promise 收割 —— 与
 * `LoginOrchestrator` 的两步式契约对接（由 orchestrator 的 `settle` 统一落条目）。
 *
 * ## ⚠️ 打开浏览器绝不能用 `cmd /c start`
 *
 * `cmd.exe` 把 URL 里的 `&` 当命令分隔符 ⇒ URL 被截断（`code_challenge` 丢失
 * 会命中登录页的 legacy 客户端门禁，弹「请升级客户端」，且回调永不到达）。
 * 用 `rundll32`（不经过 shell）。本项目由**前端**打开 URL，故此处的 `openBrowser`
 * 仅供非 UI 场景复用。
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { ACCIO_LOGIN_TIMEOUT_MS, type AccioRegion } from './accio-product.js'
import { accioExpiresAtMs } from './accio.js'
import {
  buildAccioAuthUrl,
  createAccioPkcePair,
  createAccioState,
  exchangeAccioCode,
} from './accio-oauth.js'
import type { LoginFlowResult } from './types.js'

/** 回调路径（Accio 对 `return_url` 无白名单校验，故路径由我们自己定）。 */
const ACCIO_CALLBACK_PATH = '/auth/callback'

export interface AccioLoginFlow {
  /** 浏览器要打开的授权页 URL。 */
  loginUrl: string
  /** 凭据（成功时）。 */
  result: Promise<LoginFlowResult>
  /** 关闭回调服务器（取消 / 超时清理）。 */
  close: () => Promise<void>
}

/** 起一个 loopback 回调服务器；返回其端口与关闭函数。 */
async function startCallbackServer(
  onCode: (code: string) => void,
  onError: (error: Error) => void,
): Promise<{ port: number; close: () => Promise<void> }> {
  let server: Server
  const close = async (): Promise<void> => {
    await new Promise<void>((resolve) => { server.close(() => resolve()) })
  }
  server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    if (url.pathname !== ACCIO_CALLBACK_PATH) {
      res.writeHead(404); res.end(); return
    }
    const code = url.searchParams.get('code')
    const error = url.searchParams.get('error')
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
    res.end('<html><body><h3>登录完成，请回到 all_proxy 管理端。</h3></body></html>')
    if (typeof code === 'string' && code.length > 0) onCode(code)
    else onError(new Error(`Accio 授权回调缺少 code（error=${error ?? '(无)'}）`))
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => resolve())
  })
  const address = server.address()
  if (address === null || typeof address === 'string') {
    await close()
    throw new Error('Accio 回调服务器未取得端口')
  }
  return { port: address.port, close }
}

/**
 * 启动一次 Accio 登录。
 *
 * @param options.region - 登录区域（`cn` / `global`）。
 * @param options.timeoutMs - 授权整体超时（测试注入短值）。
 */
export async function startAccioLoginFlow(
  options: { region?: AccioRegion; fetcher?: typeof fetch; timeoutMs?: number } = {},
): Promise<AccioLoginFlow> {
  const region: AccioRegion = options.region ?? 'cn'
  const fetcher = options.fetcher ?? fetch
  const pkce = createAccioPkcePair()
  const state = createAccioState()

  let resolveResult!: (value: LoginFlowResult) => void
  let rejectResult!: (error: Error) => void
  const result = new Promise<LoginFlowResult>((resolve, reject) => {
    resolveResult = resolve
    rejectResult = reject
  })

  let closed = false
  let timer: ReturnType<typeof setTimeout> | undefined

  const onCode = (code: string): void => {
    void (async () => {
      try {
        const token = await exchangeAccioCode({
          region,
          code,
          codeVerifier: pkce.verifier,
          redirectUri: redirectUri,
          fetcher,
        })
        if (closed) return
        resolveResult({
          access: JSON.stringify({
            access_token: token.access_token,
            refresh_token: token.refresh_token,
            expires_at: token.expires_at,
            ...(token.sgcookie === undefined ? {} : { sgcookie: token.sgcookie }),
            region,
          }),
          expires: accioExpiresAtMs(token.expires_at) ?? 0,
          loginUrl,
        })
      } catch (error) {
        if (!closed) rejectResult(error instanceof Error ? error : new Error(String(error)))
      } finally {
        void close()
      }
    })()
  }

  const server = await startCallbackServer(onCode, (error) => {
    if (!closed) rejectResult(error)
  })
  const redirectUri = `http://127.0.0.1:${server.port}${ACCIO_CALLBACK_PATH}`
  const loginUrl = buildAccioAuthUrl({ region, redirectUri, state, codeChallenge: pkce.challenge })

  const close = async (): Promise<void> => {
    if (closed) return
    closed = true
    if (timer !== undefined) clearTimeout(timer)
    await server.close()
  }

  timer = setTimeout(() => {
    if (!closed) {
      rejectResult(new Error('Accio 登录超时：未在时限内完成授权'))
      void close()
    }
  }, options.timeoutMs ?? ACCIO_LOGIN_TIMEOUT_MS)
  timer.unref?.()

  return { loginUrl, result, close }
}
