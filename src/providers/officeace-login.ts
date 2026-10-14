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

/**
 * 登录整体超时（毫秒）。
 *
 * ⚠️ 2026-10-14 从 10 分钟提到 30 分钟（用户报障「授权后账号没添加」）：
 * 现在的授权链是「点 + 新建账号 → 复制链接 → 开无痕窗口/换浏览器 → **登华为
 * 账号**（可能输密码、过 2FA）→ 点授权」，比自动开窗时代长得多，10 分钟
 * 经常不够。超时的后果是用户明明看到「欢迎使用OfficeAce」回调页，账号却
 * 进不来 —— 因为服务端已经没人领 code 了。
 */
const OFFICEACE_LOGIN_TIMEOUT_MS = 30 * 60 * 1000

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
      // ── 阶段一：取 code（失败可容忍：网络抖动 / 用户还没授权）──
      let code: string | undefined
      try {
        code = await pollLoginCode(start.state)
      } catch (error) {
        // 单次轮询失败不致命（网络抖动）：继续轮询，直到超时。
        console.warn(`[officeace] 轮询授权码失败（继续重试）: ${error instanceof Error ? error.message : String(error)}`)
      }
      if (cancelled) return

      // ── 阶段二：拿到 code ⇒ 立刻换 token（**失败是终态**）──
      //
      // ⚠️⚠️ 这两个阶段**绝不能**合在一个 try 里（本项目第一版的真实缺陷，
      // 直接造成用户报障「授权后账号没添加」）：换 token 失败被当成「本轮
      // 没授权」吞掉后继续轮询，而华为云的 code 很可能是一次性的 —— 之后
      // 每轮都取不到 code，于是一直空转到超时。用户看着「欢迎使用
      // OfficeAce」回调页，账号却永远进不来，且**没有任何错误提示**。
      // 现在：换 token 失败立刻 reject 并带上原文，前端能显示真实原因。
      if (code !== undefined) {
        console.info('[officeace] 已取得授权码，正在交换 token…')
        try {
          // ⚠️ code 秒级时效：拿到后立刻换 token。
          const credential = await completeLogin(code, start._internal.codeVerifier, start._internal.dpopPrivateJwk)
          if (cancelled) return
          console.info(`[officeace] 登录成功（accountId=${credential.accountId ?? '未知'}）`)
          resolve(toLoginResult(credential, start.authorizeUrl))
          return
        } catch (error) {
          if (!cancelled) {
            const message = error instanceof Error ? error.message : String(error)
            console.warn(`[officeace] token 交换失败（终态，不再重试）: ${message}`)
            reject(new Error(`华为云 token 交换失败：${message}。请重新点「+ 新建账号」再试一次`))
          }
          return
        }
      }

      if (Date.now() >= deadline) {
        console.warn('[officeace] 登录超时：未在时限内完成华为云授权')
        reject(new Error('OfficeAce 登录超时：未在时限内完成华为云授权。链接已失效，请重新点「+ 新建账号」'))
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
