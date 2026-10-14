/**
 * 登录编排层：把 10 个 provider 的两步式登录协议接到管理端。
 *
 * ## 职责与不职责
 *
 * 协议细节全部在 `providers/*-oauth.ts` / `login.ts`（移植自来源仓库，
 * 有自己的单测）；本层只做三件**编排**的事：
 *
 * 1. **会话管理**（两步式契约）：`start` 立即返回 `loginUrl`，绝不阻塞到
 *    授权完成 —— 浏览器只在用户手势后的短暂窗口内允许 `window.open`，
 *    阻塞式返回会让弹窗被拦截（来源在真实故障中总结的硬约束）。
 * 2. **落账号条目**：登录结果落定后**先写凭据、再写索引** —— 凭据就位后
 *    账号才可能被选中；顺序反过来会出现「索引里有账号但凭据不存在」的
 *    半截状态，选号器会在运行期才撞上 ENOENT。
 * 3. **失败可读归因**：上游返回非 JSON / 凭据失效 / 缺少必要字段三类
 *    分别给出人话，而不是把 `JSON.parse` 异常原文甩给用户。
 *
 * ## 不职责
 *
 * - 不打开浏览器：URL 交给前端，由前端在用户手势窗口内打开。
 * - 不做定时同步、不自动重试授权：授权是否完成只由用户决定。
 */

import { randomBytes, randomUUID } from 'node:crypto'
import type { AccountPool } from '../pool/account-pool.js'
import type { CredentialStore, ProviderAccountEntry } from '../pool/types.js'
import type { Logger } from '../pool/store.js'
import { startOAuthFlow } from '../providers/login.js'
import type { LoginFlowResult } from '../providers/types.js'
import { decorateLoginUrl, fetchAuthState, runBuddyLoginFlow } from '../providers/buddy-oauth.js'
import { CODEBUDDY, WORKBUDDY, type BuddyProduct } from '../providers/product.js'
import { startLobsteraiLoginFlow } from '../providers/lobsterai-oauth.js'
import { LOBSTERAI } from '../providers/lobsterai-product.js'
import { startQoderLoginFlow } from '../providers/qoder-oauth.js'
import { QODER, QODER_CN } from '../providers/qoder-product.js'
import { startTraeLoginFlow } from '../providers/trae-oauth.js'
import { TRAE } from '../providers/trae-product.js'
import { startClineLoginFlow } from '../providers/cline-oauth.js'
import { CLINE } from '../providers/cline-product.js'
import { LOOMY } from '../providers/loomy-product.js'
import { LOOMY_SESSION_TTL_SECONDS, loginLoomyBySmsCode, sendLoomySmsCode, type LoomyLoginResult } from '../providers/loomy-oauth.js'
import { startLoomyWechatLoginFlow } from '../providers/loomy-wechat-login.js'
import { startLoomyLoginFlow } from '../providers/loomy-login-page.js'
import { RACCOON } from '../providers/raccoon-product.js'
import { loginRaccoonWithPassword, loginRaccoonWithSmsCode, sendRaccoonSmsCode } from '../providers/raccoon-oauth.js'
import { startRaccoonLoginFlow } from '../providers/raccoon-login-page.js'
import { startOfficeAceLoginFlow } from '../providers/officeace-login.js'
import { startAccioLoginFlow } from '../providers/accio-login.js'

/** 登录会话的存活上限：到点自动清理回调服务器与端口。 */
export const LOGIN_SESSION_TTL_MS = 10 * 60 * 1000

/** 通道统一产出：序列化凭据 + 元数据。 */
export interface ChannelOutcome {
  /** 序列化后的凭据 JSON（直接落盘的值）。 */
  access: string
  /** 过期毫秒时间戳；无法解析时为 0。 */
  expires: number
  /** 凭据是否可静默续期（Loomy 恒 false：没有 refresh 端点）。 */
  refreshable: boolean
  /** 展示昵称（可选；缺失时落条目阶段回退 provider 显示名）。 */
  nickname?: string
}

/** 一个已启动、尚未收割的 URL 登录流程。 */
interface UrlFlowHandle {
  loginUrl?: string
  userCode?: string
  result: Promise<ChannelOutcome>
  cancel: () => Promise<void>
}

/** 把来源的 `LoginFlowResult` 统一成通道词汇。 */
function outcomeFromFlowResult(result: LoginFlowResult): ChannelOutcome {
  return {
    access: result.access,
    expires: result.expires,
    // codearts 的 OAuth 凭据自带 refresh_token（一次性轮换，见 refresh.ts）。
    refreshable: true,
  }
}

/** Loomy 登录结果 → 统一通道词汇（扫码与手机号两条路径共用）。 */
function loomyOutcome(login: LoomyLoginResult & { phone: string; nickname?: string }): ChannelOutcome {
  const nickname = login.nickname !== undefined && login.nickname.length > 0 ? login.nickname : undefined
  return {
    access: JSON.stringify({
      access_token: login.session,
      userid: login.userid,
      phone: login.phone,
      ...(nickname !== undefined ? { nickname } : {}),
      expires_at: String(Date.now() + LOOMY_SESSION_TTL_SECONDS * 1000),
    }),
    expires: Date.now() + LOOMY_SESSION_TTL_SECONDS * 1000,
    // ⚠️ 恒 false：Loomy 没有任何 refresh 端点（AGENTS.md 已知限制）。
    refreshable: false,
    ...(nickname !== undefined ? { nickname } : {}),
  }
}

/** 启动各 provider 的 URL 登录流程（协议层已由移植模块提供）。 */
async function startUrlFlow(
  provider: string,
  fetcher: typeof fetch,
  flowOptions: { pollIntervalMs?: number; method?: string } = {},
): Promise<UrlFlowHandle> {
  switch (provider) {
    case 'codearts': {
      const flow = await startOAuthFlow({ fetcher })
      return {
        loginUrl: flow.loginUrl,
        result: flow.result.then(outcomeFromFlowResult),
        cancel: flow.close,
      }
    }
    case 'buddy':
    case 'workbuddy': {
      // 后端轮询式外部链接：先拿 state 与授权页地址（一次快速请求），
      // 再把轮询放到后台 —— 「未就绪」错误码由 loopGetToken 内部视为继续轮询。
      const product: BuddyProduct = provider === 'buddy' ? CODEBUDDY : WORKBUDDY
      const state = await fetchAuthState(fetcher, undefined, product)
      const flowPromise = runBuddyLoginFlow({
        state: state.state,
        product,
        fetcher,
        // 浏览器由前端打开；这里传 no-op 而不是省略（省略会打开系统浏览器）。
        openBrowser: async () => {},
      })
      flowPromise.catch(() => {})
      return {
        loginUrl: decorateLoginUrl(state.authUrl, product),
        result: flowPromise.then(outcomeFromFlowResult),
        cancel: async () => { /* 纯轮询无监听端口；Promise 落定后自然结束 */ },
      }
    }
    case 'lobsterai': {
      // clientVersion 用产品的兜底常量（与官方客户端一致的版本号；
      // 动态查询版本号的 API 需要额外网络往返，登录场景不值得）。
      const flow = await startLobsteraiLoginFlow({ product: LOBSTERAI, clientVersion: LOBSTERAI.fallbackClientVersion, fetcher })
      return {
        loginUrl: flow.loginUrl,
        result: flow.result.then(outcomeFromFlowResult),
        cancel: flow.close,
      }
    }
    case 'qoder':
    case 'qodercn': {
      const flow = await startQoderLoginFlow({
        product: provider === 'qoder' ? QODER : QODER_CN,
        fetcher,
        ...(flowOptions.pollIntervalMs !== undefined ? { pollIntervalMs: flowOptions.pollIntervalMs } : {}),
      })
      return {
        loginUrl: flow.loginUrl,
        result: flow.result.then(outcomeFromFlowResult),
        cancel: flow.close,
      }
    }
    case 'trae': {
      const flow = await startTraeLoginFlow({ product: TRAE, fetcher })
      return {
        loginUrl: flow.loginUrl,
        result: flow.result.then(outcomeFromFlowResult),
        cancel: flow.close,
      }
    }
    case 'cline': {
      const flow = await startClineLoginFlow({ product: CLINE, fetcher })
      return {
        loginUrl: flow.loginUrl,
        ...(flow.userCode !== undefined ? { userCode: flow.userCode } : {}),
        result: flow.result.then(outcomeFromFlowResult),
        cancel: flow.close,
      }
    }
    case 'loomy': {
      // **主路径是手机号验证码**（design D12：微信 openid 绑死单一微信号，
      // 扫码只能登一个 Loomy 账号；手机号可以多账号）。本地服务器承载
      // 手机号表单弹窗页，与 codearts / qoder / raccoon 的「弹窗 + 轮询」
      // 体验完全一致。扫码保留为可选（method=wechat）。
      if (flowOptions.method === 'wechat') {
        const wechat = await startLoomyWechatLoginFlow({ product: LOOMY, fetcher })
        return {
          loginUrl: wechat.loginUrl,
          result: wechat.result.then(loomyOutcome),
          cancel: wechat.close,
        }
      }
      const flow = await startLoomyLoginFlow({ product: LOOMY, fetcher })
      return {
        loginUrl: flow.loginUrl,
        result: flow.result.then(loomyOutcome),
        cancel: flow.close,
      }
    }
    case 'raccoon': {
      // 本地登录页：Tab 内含「微信扫码 / 短信登录 / 密码登录」三种方式（含阿里云滑块），
      // 全部在弹窗页内完成，宿主侧持有敏感状态。
      const flow = await startRaccoonLoginFlow({ fetcher })
      return {
        loginUrl: flow.loginUrl,
        result: flow.result.then((credential) => ({
          access: JSON.stringify(credential),
          expires: Number(credential.expires_at ?? 0) || 0,
          refreshable: typeof credential.refresh_token === 'string' && credential.refresh_token.length > 0,
        })),
        cancel: flow.close,
      }
    }
    case 'officeace': {
      // 轮询式（无 loopback 端口）：先拿云侧 state 与授权页地址，后台轮询 code。
      const flow = await startOfficeAceLoginFlow({
        ...(flowOptions.pollIntervalMs !== undefined ? { pollIntervalMs: flowOptions.pollIntervalMs } : {}),
      })
      return {
        loginUrl: flow.loginUrl,
        result: flow.result.then(outcomeFromFlowResult),
        cancel: flow.close,
      }
    }
    case 'accio': {
      // 标准 PKCE：回调落在本项目自己的 loopback（Accio 对 return_url 无白名单校验）。
      const flow = await startAccioLoginFlow({ fetcher })
      return {
        loginUrl: flow.loginUrl,
        result: flow.result.then(outcomeFromFlowResult),
        cancel: flow.close,
      }
    }
    default:
      throw new Error(`provider ${provider} 不支持链接式登录`)
  }
}

/** 支持 SMS 的 provider（返回 SMS 下发时需要的额外参数说明）。 */
export const SMS_PROVIDERS = new Set(['loomy', 'raccoon'])

// ───────────────────────── 昵称脱敏（tasks 10.15） ─────────────────────────

/** 中国大陆手机号形态（完整 11 位）。 */
const PHONE_RE = /^1[3-9]\d{9}$/

/**
 * 昵称脱敏：手机号形态只露前 3 后 4，其余**原样保留**。
 *
 * ⚠️ 对已脱敏输入**幂等**：`138****5678` 不匹配完整手机号形态，
 * 原样返回 —— 因此对同一昵称反复归一化不会越脱越狠。
 */
export function sanitizeNickname(raw: string): string {
  if (!PHONE_RE.test(raw)) return raw
  return `${raw.slice(0, 3)}****${raw.slice(7)}`
}

// ───────────────────────── 失败可读归因（tasks 10.16） ─────────────────────────

/**
 * 把登录失败翻译成可读提示。
 *
 * 三类情形（规格 `provider-login`）：
 * 1. **上游返回非 JSON**：用户看到「服务端返回了非预期响应」，而不是
 *    `Unexpected token < in JSON at position 0` 这类异常原文；
 * 2. **凭据失效 / 无权限**（401/403）：引导重新登录；
 * 3. **缺少必要字段**：来源抛的错误本身就是「登录响应缺少 session」形态
 *    （明确指出缺哪个字段），原样透传即可。
 */
export function classifyLoginError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  if (/JSON/i.test(message) && /(Unexpected|position|parse|token)/i.test(message)) {
    return '上游服务返回了非预期响应（非 JSON），请稍后重试'
  }
  if (/\b401\b|\b403\b/i.test(message) || /unauthorized|forbidden|凭据已失效/i.test(message)) {
    return `凭据已失效或无权限，请重新登录（上游响应：${message}）`
  }
  return message
}

// ───────────────────────── 编排器 ─────────────────────────

/** 会话对外的状态。 */
export type LoginSessionState =
  | { status: 'pending' }
  | { status: 'done'; account: ProviderAccountEntry }
  | { status: 'failed'; message: string }

/** `start` 的返回（两步式契约的第一步）。 */
export interface StartedLoginSession {
  sessionId: string
  provider: string
  loginUrl?: string
  /** 设备码流程的用户码（cline；UI 提示用户输入）。 */
  userCode?: string
}

/** 内部会话记录。 */
interface SessionRecord {
  id: string
  provider: string
  flow: UrlFlowHandle
  settled: { status: 'done'; outcome: ChannelOutcome } | { status: 'failed'; message: string } | undefined
  account: ProviderAccountEntry | undefined
  closed: boolean
}

/** 编排器依赖。 */
export interface LoginOrchestratorOptions {
  pool: AccountPool
  credentials: CredentialStore
  /** provider 显示名（昵称回退用）；测试可不传。 */
  displayNames?: Readonly<Record<string, string>>
  logger?: Logger
  fetcher?: typeof fetch
  /** 会话 TTL（测试注入短值）。 */
  sessionTtlMs?: number
  /** 设备码轮询间隔（测试注入短值，如 qoder 的授权轮询）。 */
  pollIntervalMs?: number
}

export class LoginOrchestrator {
  private readonly sessions = new Map<string, SessionRecord>()

  constructor(private readonly options: LoginOrchestratorOptions) {}

  /**
   * 启动一次 URL 登录（两步式契约）：**立即**返回 `loginUrl`，授权结果由
   * {@link poll} 收割。结果落定时立即落账号条目（不等服务被问询）。
   */
  async start(provider: string, method?: string): Promise<StartedLoginSession> {
    const fetcher = this.options.fetcher ?? fetch
    const flow = await startUrlFlow(provider, fetcher, { pollIntervalMs: this.options.pollIntervalMs, method })
    const id = `login-${randomUUID().slice(0, 8)}`
    const record: SessionRecord = {
      id,
      provider,
      flow,
      settled: undefined,
      account: undefined,
      closed: false,
    }
    this.sessions.set(id, record)

    // 结果落定 → 立即落条目（或记失败）。poll 只读状态，不触发落盘。
    void flow.result.then(
      (outcome) => {
        record.settled = { status: 'done', outcome }
        this.settle(provider, outcome)
          .then(account => { record.account = account })
          .catch((error: unknown) => {
            // 落条目失败（如磁盘写坏）也要给出可读失败态，不能让 poll 悬着。
            record.settled = { status: 'failed', message: classifyLoginError(error) }
          })
      },
      (error: unknown) => {
        record.settled = { status: 'failed', message: classifyLoginError(error) }
      },
    )

    // 超时清理：关掉回调服务器/中止轮询，不留泄漏端口（规格要求）。
    const timer = setTimeout(() => { void this.cancel(id) }, this.options.sessionTtlMs ?? LOGIN_SESSION_TTL_MS)
    timer.unref?.()

    return {
      sessionId: id,
      provider,
      ...(flow.loginUrl !== undefined ? { loginUrl: flow.loginUrl } : {}),
      ...(flow.userCode !== undefined ? { userCode: flow.userCode } : {}),
    }
  }

  /** 收割会话状态（前端轮询；幂等）。 */
  async poll(sessionId: string): Promise<LoginSessionState & { sessionId: string }> {
    const record = this.sessions.get(sessionId)
    if (record === undefined) throw new Error(`登录会话不存在或已过期: ${sessionId}`)
    const settled = record.settled
    if (settled === undefined) return { sessionId, status: 'pending' }
    if (settled.status === 'failed') return { sessionId, status: 'failed', message: settled.message }
    if (record.account === undefined) {
      // 落条目还在写盘（毫秒级窗口）：对外仍算 pending，下次 poll 拿到 done。
      return { sessionId, status: 'pending' }
    }
    return { sessionId, status: 'done', account: record.account }
  }

  /** 取消会话并清理监听资源（幂等；超时清理也走这里）。 */
  async cancel(sessionId: string): Promise<void> {
    const record = this.sessions.get(sessionId)
    if (record === undefined) return
    if (!record.closed) {
      record.closed = true
      try { await record.flow.cancel() } catch { /* 清理失败不阻断 */ }
    }
    this.sessions.delete(sessionId)
  }

  // ── SMS 通道（loomy / raccoon）──

  /**
   * 下发短信验证码。
   *
   * @returns 后续 `completeSmsLogin` 需要的票据（loomy 是 `msgid`；raccoon 无票据）。
   */
  async sendSmsCode(provider: string, phone: string, captchaParam = ''): Promise<{ ticket: string }> {
    const fetcher = this.options.fetcher ?? fetch
    if (provider === 'loomy') {
      const msgid = await sendLoomySmsCode(phone, LOOMY, fetcher)
      return { ticket: msgid }
    }
    if (provider === 'raccoon') {
      await sendRaccoonSmsCode(RACCOON, phone, captchaParam, fetcher)
      return { ticket: '' }
    }
    throw new Error(`provider ${provider} 不支持短信验证码登录`)
  }

  /**
   * 提交短信验证码完成登录，并**立即**落账号条目。
   *
   * @returns 落盘后的账号条目。
   */
  async completeSmsLogin(provider: string, phone: string, code: string, ticket: string): Promise<ProviderAccountEntry> {
    const fetcher = this.options.fetcher ?? fetch
    let outcome: ChannelOutcome
    try {
      outcome = await this.smsOutcome(provider, phone, code, ticket, fetcher)
    } catch (error) {
      // 与 URL 会话同款归因：非 JSON / 凭据失效 / 缺字段各自可读。
      throw new Error(classifyLoginError(error))
    }
    return this.settle(provider, outcome)
  }

  /** 各 provider 的短信登录协议调用（结果统一成通道词汇）。 */
  private async smsOutcome(
    provider: string,
    phone: string,
    code: string,
    ticket: string,
    fetcher: typeof fetch,
  ): Promise<ChannelOutcome> {
    if (provider === 'loomy') {
      const login = await loginLoomyBySmsCode(phone, code, ticket, LOOMY, fetcher)
      // Loomy 凭据形状对齐 `LoomyAuth.buildCredential`：本地按 14 天推算到期。
      return {
        access: JSON.stringify({
          access_token: login.session,
          userid: login.userid,
          phone,
          expires_at: String(Date.now() + LOOMY_SESSION_TTL_SECONDS * 1000),
        }),
        expires: Date.now() + LOOMY_SESSION_TTL_SECONDS * 1000,
        // ⚠️ 恒 false：Loomy 没有任何 refresh 端点（AGENTS.md 已知限制）。
        refreshable: false,
        nickname: sanitizeNickname(phone),
      }
    }
    if (provider === 'raccoon') {
      const credential = await loginRaccoonWithSmsCode(RACCOON, phone, code, fetcher)
      return {
        access: JSON.stringify(credential),
        expires: Number(credential.expires_at ?? 0) || 0,
        refreshable: typeof credential.refresh_token === 'string' && credential.refresh_token.length > 0,
        nickname: sanitizeNickname(phone),
      }
    }
    throw new Error(`provider ${provider} 不支持短信验证码登录`)
  }

  // ── 密码登录通道（raccoon）──

  /**
   * 用手机号 + 密码完成登录，并**立即**落账号条目。
   *
   * 与 SMS 通道对称：管理端也可以不经本地登录页直连（`/api/login/password/complete`）。
   * 常规路径是本地登录页的「密码登录」Tab（宿主侧加密）。
   *
   * @returns 落盘后的账号条目。
   */
  async completePasswordLogin(provider: string, phone: string, password: string): Promise<ProviderAccountEntry> {
    const fetcher = this.options.fetcher ?? fetch
    let outcome: ChannelOutcome
    try {
      outcome = await this.passwordOutcome(provider, phone, password, fetcher)
    } catch (error) {
      throw new Error(classifyLoginError(error))
    }
    return this.settle(provider, outcome)
  }

  /** 各 provider 的密码登录协议调用（结果统一成通道词汇）。 */
  private async passwordOutcome(
    provider: string,
    phone: string,
    password: string,
    fetcher: typeof fetch,
  ): Promise<ChannelOutcome> {
    if (provider === 'raccoon') {
      const credential = await loginRaccoonWithPassword(RACCOON, phone, password, fetcher)
      return {
        access: JSON.stringify(credential),
        expires: Number(credential.expires_at ?? 0) || 0,
        refreshable: typeof credential.refresh_token === 'string' && credential.refresh_token.length > 0,
        nickname: sanitizeNickname(phone),
      }
    }
    throw new Error(`provider ${provider} 不支持密码登录`)
  }

  // ── 落账号条目（tasks 10.14）──

  /**
   * 登录产物 → 账号条目。
   *
   * ⚠️ **先写凭据、再写索引**：索引里出现账号的前提是凭据已经落盘。
   * 顺序颠倒会在「写索引成功、写凭据失败」时留下选号器看得见却用不了的账号。
   */
  async settle(provider: string, outcome: ChannelOutcome): Promise<ProviderAccountEntry> {
    const ref = `${provider.toUpperCase()}_ACCOUNT_${randomBytes(4).toString('hex').toUpperCase()}`
    await this.options.credentials.set(ref, outcome.access)
    const entry: ProviderAccountEntry = {
      id: `${provider}-${randomBytes(4).toString('hex')}`,
      provider,
      // 昵称优先级：通道显式给出 → 凭据 JSON 里的昵称字段（trae/qoder 等会带）
      // → provider 显示名。统一过脱敏（幂等，不改变非手机号昵称）。
      nickname: sanitizeNickname(
        outcome.nickname ?? nicknameFromCredential(outcome.access) ?? this.options.displayNames?.[provider] ?? provider,
      ),
      enabled: true,
      credentialRef: ref,
      createdAt: Date.now(),
      refreshable: outcome.refreshable,
      ...(outcome.expires > 0 ? { expiresAt: outcome.expires } : {}),
    }
    await this.options.pool.addAccount(entry)
    return entry
  }
}

/** 从凭据 JSON 里提取展示昵称（各 provider 的字段名不一，逐个兼容）。 */
function nicknameFromCredential(access: string): string | undefined {
  try {
    const parsed = JSON.parse(access) as Record<string, unknown>
    for (const key of ['nickname', 'user_name', 'userName', 'display_name']) {
      const value = parsed[key]
      if (typeof value === 'string' && value.trim().length > 0) return value.trim()
    }
    return undefined
  } catch {
    return undefined
  }
}
