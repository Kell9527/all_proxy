/**
 * OfficeAce 登录编排：把华为云「轮询式」OAuth 包成两步式会话的 `UrlFlowHandle`。
 *
 * ## 为什么单独一层
 *
 * 其余 provider 的登录流程放在各自的 `*-oauth.ts`（协议 + 流程一体）。OfficeAce
 * 的**协议**在 `officeace-auth.ts`（忠实移植），本文件只做**流程编排**：起
 * state、轮询 code、换 token —— 与 `orchestrator` 的两步式契约对接。
 *
 * ## 轮询式（无 loopback 端口）
 *
 * 与 buddy/workbuddy 同型：`start` 只拿到授权页 URL 与云侧 state，用户授权后由
 * 后台轮询 `GET /v1/claw/auth/code?state=` 取 code。故不占本地端口，`cancel` 是
 * 「停止轮询」而非「关服务器」。
 *
 * ## ⚠️ code 秒级时效
 *
 * 轮询到 code 后**必须立刻**换 token（`completeLogin` 内部一体化完成），不能
 * 分两步交互。
 */

import { completeLogin, pollLoginCode, startLogin, type OfficeAceCredential, type OfficeAceLoginStart } from './officeace-auth.js'
import type { LoginFlowResult } from './types.js'

/** 轮询间隔（毫秒）。华为云 code 秒级时效，故取较短间隔。 */
const OFFICEACE_POLL_INTERVAL_MS = 2_000

/** 登录整体超时（毫秒）。 */
const OFFICEACE_LOGIN_TIMEOUT_MS = 10 * 60 * 1000

export interface OfficeAceLoginFlow {
  /** 浏览器要打开的授权页 URL。 */
  loginUrl: string
  /** 凭据（成功时）。 */
  result: Promise<LoginFlowResult>
  /** 取消（停止轮询）。 */
  close: () => Promise<void>
}

/**
 * 启动一次 OfficeAce 登录。
 *
 * @param options.pollIntervalMs - 轮询间隔（测试注入短值）。
 */
export async function startOfficeAceLoginFlow(
  options: { pollIntervalMs?: number; timeoutMs?: number } = {},
): Promise<OfficeAceLoginFlow> {
  const start: OfficeAceLoginStart = await startLogin()
  let cancelled = false
  let timer: ReturnType<typeof setTimeout> | undefined

  const result = new Promise<LoginFlowResult>((resolve, reject) => {
    const deadline = Date.now() + (options.timeoutMs ?? OFFICEACE_LOGIN_TIMEOUT_MS)
    const interval = options.pollIntervalMs ?? OFFICEACE_POLL_INTERVAL_MS

    const tick = async (): Promise<void> => {
      if (cancelled) return
      try {
        const code = await pollLoginCode(start.state)
        if (cancelled) return
        if (code !== undefined) {
          // ⚠️ code 秒级时效：拿到后立刻换 token。
          const credential = await completeLogin(code, start._internal.codeVerifier, start._internal.dpopPrivateJwk)
          resolve(toLoginResult(credential, start.authorizeUrl))
          return
        }
      } catch (error) {
        // 单次轮询失败不致命（网络抖动）：继续轮询，直到超时。
        // 但换 token 阶段的失败是终态 —— 由下面的分支区分。
      }
      if (Date.now() >= deadline) {
        reject(new Error('OfficeAce 登录超时：未在时限内完成华为云授权'))
        return
      }
      timer = setTimeout(() => { void tick() }, interval)
      timer.unref?.()
    }

    timer = setTimeout(() => { void tick() }, interval)
    timer.unref?.()
  })

  return {
    loginUrl: start.authorizeUrl,
    result,
    close: async () => {
      cancelled = true
      if (timer !== undefined) clearTimeout(timer)
    },
  }
}

/** 凭据 → 统一登录结果（`access` 是序列化凭据 JSON，`expires` 是毫秒时间戳）。 */
function toLoginResult(credential: OfficeAceCredential, loginUrl: string): LoginFlowResult {
  const parsed = Date.parse(credential.expiresAt)
  return {
    access: JSON.stringify(credential),
    expires: Number.isFinite(parsed) && parsed > 0 ? parsed : 0,
    loginUrl,
  }
}
