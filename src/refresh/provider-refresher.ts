/**
 * Provider 级凭据静默续期的运行时接线。
 *
 * ## 实现方式
 *
 * 各 provider 的刷新序列照抄移植过来的 `*-auth.ts` 服务类里的
 * `refreshCredential`（错误分类与终态判定逐行保留）——那些逻辑已被来源
 * 单测与线上流量验证，这里只是把「cordis 服务方法」压成「纯函数 + 注入」。
 *
 * ## 立即回写（硬约束）
 *
 * codearts / trae / raccoon 的 refresh_token 是**一次性轮换**：调用方拿到
 * 返回的新凭据后必须立即写回凭据存储，否则该账号只能重新登录。
 */

import { RefreshTokenExpiredError } from '../providers/buddy-oauth.js'
import { CODEBUDDY, WORKBUDDY, type BuddyProduct } from '../providers/product.js'
import { refreshToken } from '../providers/buddy-oauth.js'
import { isRefreshable } from '../providers/buddy.js'
import type { BuddyCredential } from '../providers/types.js'
import { credentialFromTokenResponse, exchangeRefreshToken, keyPairFromStoredJwk } from '../providers/oauth.js'
import type { CodeArtsCredential } from '../providers/types.js'
import { LOBSTERAI } from '../providers/lobsterai-product.js'
import {
  LOBSTERAI_REFRESH_PATH,
  LOBSTERAI_REQUEST_TIMEOUT_MS,
  LobsteraiClientVersionResolver,
  applyLobsteraiRefresh,
  lobsteraiAnonymousHeaders,
  lobsteraiRefreshBody,
  parseLobsteraiEnvelope,
  parseLobsteraiTokenPayload,
} from '../providers/lobsterai.js'
import { classifyLobsteraiError, isLobsteraiTerminalError } from '../providers/lobsterai-errors.js'
import { QODER, QODER_CN } from '../providers/qoder-product.js'
import {
  QODER_REFRESH_PATH,
  QODER_REQUEST_TIMEOUT_MS,
  applyQoderRefresh,
  parseQoderTokenPayload,
  qoderRefreshBody,
} from '../providers/qoder.js'
import { RefreshTokenExpiredError as QoderRefreshExpired } from '../providers/qoder-auth.js'
import { TRAE } from '../providers/trae-product.js'
import {
  TRAE_EXCHANGE_PATH,
  TRAE_REQUEST_TIMEOUT_MS,
  applyTraeRefresh,
  parseTraeExchangeResponse,
  traeOAuthHeaders,
} from '../providers/trae.js'
import { classifyTraeError, isTraeTerminalError } from '../providers/trae-errors.js'
import { RefreshTokenExpiredError as TraeRefreshExpired } from '../providers/trae-auth.js'
import { CLINE } from '../providers/cline-product.js'
import { applyClineRefresh, clineRefreshBody, parseClineTokenPayload } from '../providers/cline.js'
import { CLINE_REFRESH_PATH } from '../providers/cline-product.js'
import { CLINE_HTTP_TIMEOUT_MS } from '../providers/cline-oauth.js'
import { RefreshTokenExpiredError as ClineRefreshExpired } from '../providers/cline-auth.js'
import { RACCOON } from '../providers/raccoon-product.js'
import { refreshRaccoonCredential } from '../providers/raccoon-oauth.js'
import type { RaccoonCredential } from '../providers/raccoon.js'

/** 已接线的 provider。loomy 没有 refresh 端点，属已知限制（AGENTS.md）。 */
export const REFRESH_SUPPORTED_PROVIDERS = new Set([
  'codearts', 'buddy', 'workbuddy', 'lobsterai', 'qoder', 'qodercn', 'trae', 'cline', 'raccoon',
])

/** 刷新结果：新凭据（整体替换写回凭据存储）。 */
export type RefreshedCredential = Record<string, unknown>

/** 传输层失败：**不能**判为终态，网络抖动不该让用户重新登录。 */
function networkError(what: string, error: unknown): Error {
  return new Error(`${what} 续期网络失败：${error instanceof Error ? error.message : String(error)}`)
}

// ───────────────────────── 各 provider 的刷新实现 ─────────────────────────

/** codearts：DPoP + PKCE 的 OAuth 刷新（照抄 CodeArtsAuth.refreshAccountCredential）。 */
async function refreshCodearts(credential: Record<string, unknown>, fetcher: typeof fetch): Promise<RefreshedCredential> {
  const c = credential as unknown as CodeArtsCredential
  if (!c.refresh_token || !c.code_verifier || !c.dpop_private_key_jwk) {
    throw new Error('凭据缺少 refresh_token 或 DPoP 材料，请重新登录')
  }
  const keyPair = keyPairFromStoredJwk(c.dpop_private_key_jwk)
  let token
  try {
    token = await exchangeRefreshToken(c.refresh_token, c.code_verifier, keyPair, fetcher)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (/401|403|invalid|expired/i.test(message)) {
      throw new RefreshTokenExpiredError(`codearts refresh_token 已失效，请重新登录（${message}）`)
    }
    throw networkError('codearts', error)
  }
  const refreshed = credentialFromTokenResponse(token, { codeVerifier: c.code_verifier, codeChallenge: '' }, keyPair) as unknown as Record<string, unknown>
  // 保留无变化字段（domain_id/user_id/user_name 等）。
  for (const key of ['domain_id', 'user_id', 'user_name', 'model_rate_limits']) {
    if (credential[key] !== undefined) refreshed[key] = credential[key]
  }
  return refreshed
}

/** buddy 系：`refreshToken` + 字段级合并（照抄 BuddyAuth.refreshCredential）。 */
async function refreshBuddy(
  provider: 'buddy' | 'workbuddy',
  credential: Record<string, unknown>,
  fetcher: typeof fetch,
): Promise<RefreshedCredential> {
  const product: BuddyProduct = provider === 'buddy' ? CODEBUDDY : WORKBUDDY
  const c = credential as unknown as BuddyCredential
  if (!isRefreshable(c)) throw new RefreshTokenExpiredError('无 refresh_token，请重新登录')
  const token = await refreshToken(c, fetcher, undefined, product)
  return {
    ...credential,
    access_token: token.accessToken,
    refresh_token: token.refreshToken,
    expires_at: token.expiresAt,
    refresh_expires_at: token.refreshExpiresAt,
    token_type: token.tokenType,
    scope: token.scope,
    ...(token.domain.length > 0 ? { domain: token.domain } : {}),
  } as RefreshedCredential
}

/** lobsterai：`/api/auth/refresh` + 信封剥离 + 客户端版本号解析。 */
async function refreshLobsterai(credential: Record<string, unknown>, fetcher: typeof fetch): Promise<RefreshedCredential> {
  const resolver = new LobsteraiClientVersionResolver({ fetcher })
  const { version: clientVersion } = await resolver.resolve(LOBSTERAI)
  const body = lobsteraiRefreshBody(credential as never, clientVersion)
  let response: Response
  try {
    response = await fetcher(`${LOBSTERAI.apiBase}${LOBSTERAI_REFRESH_PATH}`, {
      method: 'POST',
      headers: lobsteraiAnonymousHeaders(LOBSTERAI),
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(LOBSTERAI_REQUEST_TIMEOUT_MS),
    })
  } catch (error) {
    throw networkError('LobsterAI', error)
  }
  let parsed: unknown
  try {
    parsed = await response.json()
  } catch {
    throw new Error(`LobsterAI 续期响应不是 JSON（HTTP ${response.status}）`)
  }
  const envelope = parseLobsteraiEnvelope(parsed)
  if (!envelope.ok) {
    const kind = classifyLobsteraiError(response.status, JSON.stringify(parsed))
    if (response.status === 401 || response.status === 403 || isLobsteraiTerminalError(kind)) {
      throw new RefreshTokenExpiredError(envelope.message)
    }
    throw new Error(`LobsterAI 续期失败：${envelope.message}`)
  }
  const payload = parseLobsteraiTokenPayload(envelope.data)
  if (payload.accessToken.length === 0) {
    throw new RefreshTokenExpiredError('续期响应缺少 accessToken，请重新登录')
  }
  return applyLobsteraiRefresh(credential as never, payload) as unknown as RefreshedCredential
}

/** qoder 系：`/api/v1/deviceToken/refresh`（载荷含 machine_id，必须原样回传）。 */
async function refreshQoder(
  provider: 'qoder' | 'qodercn',
  credential: Record<string, unknown>,
  fetcher: typeof fetch,
): Promise<RefreshedCredential> {
  const product = provider === 'qoder' ? QODER : QODER_CN
  let response: Response
  try {
    response = await fetcher(`${product.openApiBase}${QODER_REFRESH_PATH}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        'User-Agent': `${product.userAgentPrefix}/1.0.0`,
      },
      body: JSON.stringify(qoderRefreshBody(credential as never)),
      signal: AbortSignal.timeout(QODER_REQUEST_TIMEOUT_MS),
    })
  } catch (error) {
    throw networkError('Qoder', error)
  }
  if (response.status === 401 || response.status === 403) {
    throw new QoderRefreshExpired(`Qoder 续期被拒绝（HTTP ${response.status}），请重新登录`)
  }
  let parsed: unknown
  try {
    parsed = await response.json()
  } catch {
    throw new Error(`Qoder 续期响应不是 JSON（HTTP ${response.status}）`)
  }
  if (!response.ok) {
    const detail = JSON.stringify(parsed).slice(0, 200)
    throw new Error(`Qoder 续期失败（HTTP ${response.status}）：${detail}`)
  }
  const payload = parseQoderTokenPayload(parsed)
  if (payload.accessToken.length === 0) {
    throw new QoderRefreshExpired('续期响应缺少访问令牌，请重新登录')
  }
  return applyQoderRefresh(credential as never, payload) as unknown as RefreshedCredential
}

/** trae：ExchangeToken（轮换 refreshToken，返回后必须立即回写）。 */
async function refreshTrae(credential: Record<string, unknown>, fetcher: typeof fetch): Promise<RefreshedCredential> {
  const c = credential as never as { refresh_token?: string; api_host?: string }
  if (typeof c.refresh_token !== 'string' || c.refresh_token.length === 0) {
    throw new TraeRefreshExpired('TRAE 凭据缺少 refresh_token，请重新登录')
  }
  const host = c.api_host ?? TRAE.oauthHost
  const exchangeBody = {
    ClientID: TRAE.clientId,
    RefreshToken: c.refresh_token,
    ClientSecret: '-',
    UserID: '',
  }
  let response: Response
  try {
    response = await fetcher(`${host}${TRAE_EXCHANGE_PATH}`, {
      method: 'POST',
      headers: traeOAuthHeaders(TRAE),
      body: JSON.stringify(exchangeBody),
      signal: AbortSignal.timeout(TRAE_REQUEST_TIMEOUT_MS),
    })
  } catch (error) {
    throw networkError('TRAE', error)
  }
  // 凭据失效时网关返回 HTML 错误页：取文本再尝试解析，不要 response.json()。
  const text = await response.text().catch(() => '')
  let parsed: Record<string, unknown> | undefined
  try {
    const candidate = JSON.parse(text) as unknown
    if (typeof candidate === 'object' && candidate !== null) parsed = candidate as Record<string, unknown>
  } catch {
    parsed = undefined
  }
  const exchange = parsed === undefined ? undefined : parseTraeExchangeResponse(parsed)
  if (exchange === undefined || exchange.accessToken.length === 0) {
    const kind = classifyTraeError(response.status, text)
    const noTokenInSuccessResponse = response.ok && parsed !== undefined
    if (response.status === 401 || response.status === 403
      || isTraeTerminalError(kind) || noTokenInSuccessResponse) {
      throw new TraeRefreshExpired('TRAE refresh_token 已失效，请重新登录')
    }
    throw new Error(`TRAE 续期失败（HTTP ${response.status}）：${text.slice(0, 200)}`)
  }
  return applyTraeRefresh(credential as never, exchange) as unknown as RefreshedCredential
}

/** cline：驼峰 `{refreshToken, grantType}` 请求体（与 qoder 的下划线不同）。 */
async function refreshCline(credential: Record<string, unknown>, fetcher: typeof fetch): Promise<RefreshedCredential> {
  let response: Response
  try {
    response = await fetcher(`${CLINE.apiBase}${CLINE_REFRESH_PATH}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        ...CLINE.clientHeaders,
      },
      body: JSON.stringify(clineRefreshBody(credential as never)),
      signal: AbortSignal.timeout(CLINE_HTTP_TIMEOUT_MS),
    })
  } catch (error) {
    throw networkError('Cline', error)
  }
  if (response.status === 401 || response.status === 403) {
    throw new ClineRefreshExpired(`Cline 续期被拒绝（HTTP ${response.status}），请重新登录`)
  }
  let parsed: unknown
  try {
    parsed = await response.json()
  } catch {
    throw new Error(`Cline 续期响应不是 JSON（HTTP ${response.status}）`)
  }
  if (!response.ok) {
    const detail = JSON.stringify(parsed).slice(0, 200)
    throw new Error(`Cline 续期失败（HTTP ${response.status}）：${detail}`)
  }
  const payload = parseClineTokenPayload(parsed)
  if (payload.accessToken.length === 0) {
    throw new ClineRefreshExpired('续期响应缺少访问令牌，请重新登录')
  }
  return applyClineRefresh(credential as never, payload, CLINE) as unknown as RefreshedCredential
}

/** raccoon：`/refresh`（refresh_token 轮换，返回后必须立即回写）。 */
async function refreshRaccoon(credential: Record<string, unknown>, fetcher: typeof fetch): Promise<RefreshedCredential> {
  const refreshToken = credential['refresh_token']
  if (typeof refreshToken !== 'string' || refreshToken.length === 0) {
    throw new Error('raccoon 凭据缺少 refresh_token，请重新登录')
  }
  const refreshed = await refreshRaccoonCredential(RACCOON, credential as unknown as RaccoonCredential, fetcher)
  return refreshed as unknown as RefreshedCredential
}

/**
 * 刷新某账号的凭据并返回**新凭据**。
 *
 * ⚠️ 调用方（调度器/适配器回调）必须把返回值**立即回写**凭据存储——
 * codearts / trae / raccoon 的 refresh_token 是一次性轮换，丢弃返回值
 * 等于让账号只能重新登录。
 *
 * @throws loomy（无续期端点，属预期）、凭据缺材料、refresh_token 失效
 *   （终态，消息含「请重新登录」）、网络/上游瞬态失败。
 */
export async function refreshProviderCredential(
  provider: string,
  credential: Record<string, unknown>,
  fetcher: typeof fetch = fetch,
): Promise<RefreshedCredential> {
  switch (provider) {
    case 'codearts': return refreshCodearts(credential, fetcher)
    case 'buddy': return refreshBuddy('buddy', credential, fetcher)
    case 'workbuddy': return refreshBuddy('workbuddy', credential, fetcher)
    case 'lobsterai': return refreshLobsterai(credential, fetcher)
    case 'qoder': return refreshQoder('qoder', credential, fetcher)
    case 'qodercn': return refreshQoder('qodercn', credential, fetcher)
    case 'trae': return refreshTrae(credential, fetcher)
    case 'cline': return refreshCline(credential, fetcher)
    case 'raccoon': return refreshRaccoon(credential, fetcher)
    case 'loomy':
      throw new Error('Loomy 没有 refresh 端点，token 过期只能重新登录（手机号验证码路径成本很低）')
    default:
      throw new Error(`provider ${provider} 的静默续期尚未接线`)
  }
}
