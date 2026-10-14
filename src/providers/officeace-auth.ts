/**
 * OfficeAce 凭据层：华为云 OAuth（PKCE + DPoP），**零外部依赖**。
 *
 * 移植自来源 `src/officeace-auth.ts`，**改动仅限依赖与存储层**：
 * - `@deepseek-ai/dsh-credentials` 的 `credentialRef` → 本地 `./credential-ref.js`；
 * - 来源自持的 `~/.dsh-officeace/session.json` → 本项目的统一凭据存储
 *   （`src/pool/`，按 `credentialRef` 索引，天然多账号）；
 * - **裁掉** Windows 迁移桥（Redis 6399 / DPAPI / PowerShell 读 Windows 凭据
 *   管理器 / 本地 `127.0.0.1:3004`）—— 那只对「装过 OfficeAce 客户端」的用户
 *   有意义，且是兜底而非主路径；
 * - **裁掉** V11-HMAC-SHA256 签名（`/v1/subscription` 余额与倍率）—— 本轮只
 *   移植**推理所需**的最小签名（Basic + SDK-HMAC-SHA256 的 `fetchModelInfo`）。
 *   余额/倍率相关能力暂缺，管理端显示降级。
 *
 * ## 华为云登录链（全部实测验证，2026-10-12）
 *
 * ```
 * 1. POST {claw}/v1/claw/auth/state          → 云侧登记 state（匿名）
 * 2. 浏览器打开 auth.huaweicloud.com 授权页    → SSO 秒过 → 回调带 code
 * 3. GET  {claw}/v1/claw/auth/code?state=    → 取回 code（匿名，秒级时效）
 * 4. POST sts.../v1/oauth2/tokens            → code+verifier+DPoP 换 token
 * 5. GET  {claw}/v1/claw/client-permission-validate（AK/SK 签名）
 *    → 返回 modelInfo（model_app_key/secret）⇒ 推理凭据
 * ```
 *
 * client_id `pdp5_for_agentarts` 是 PKCE 公开客户端（无 secret）。
 *
 * ## 时序陷阱（实测踩过）
 *
 * - code 有效期**秒级**：拿到后必须立刻换 token（一体化流程，不能分两步交互）
 * - state 必须来自云侧（自造的查不到）
 * - refresh_token 一次性：刷新成功后必须立即落盘新 token，否则重放触发
 *   STS5.1806 "has been used" 死循环
 * - **DPoP 私钥必须持久化**：refresh 请求要用同一把密钥签 proof
 */

import { createHash, createHmac, randomBytes, webcrypto } from 'node:crypto'
import { OFFICEACE } from './officeace-product.js'

/** WebCrypto 的 JWK 类型（lib.dom 不可用时手动声明最小形状）。 */
export type DpopPrivateJwk = { kty?: string; crv?: string; x?: string; y?: string; d?: string }
type JsonWebKey = DpopPrivateJwk
/** webcrypto.subtle.importKey 的返回（结构化最小形状，避免依赖 lib.dom）。 */
type SubtleCryptoKey = Awaited<ReturnType<typeof webcrypto.subtle.importKey>>

/** 华为云端点（与 OfficeAce green-package 的默认值一致）。 */
const CLAW_BASE = 'https://agentarts.cn-southwest-2.myhuaweicloud.com'
const TOKEN_URL = 'https://sts.cn-north-4.myhuaweicloud.com/v1/oauth2/tokens'
const CLIENT_ID = 'pdp5_for_agentarts'
const REDIRECT_URI = `${CLAW_BASE}/v1/claw/auth/callback`

export interface OfficeAceCredential {
  /** MaaS 推理的 Basic 凭据对（permission-validate 返回）。 */
  modelAppKey: string
  modelAppSecret: string
  /** MaaS 端点 host（model_api_url_base）。 */
  maasBaseUrl: string
  /** 华为云 IAM STS 凭据（AK/SK/STS，调 claw 管理 API 用）。 */
  access: string
  secret: string
  securityToken: string
  projectId: string
  expiresAt: string
  /** OAuth refresh token（30 天，一次性）。 */
  refreshToken: string
  /** DPoP 私钥 JWK（refresh 必须同钥）。 */
  dpopPrivateJwk: JsonWebKey
  /** 用户显示名。 */
  displayName?: string
  /** 账号 id。 */
  accountId?: string
}

// ────────────────────────── DPoP（复刻 OfficeAce oauth-crypto.js）──────────────────────────

function b64(buf: ArrayBuffer | Uint8Array): string {
  return Buffer.from(buf as Uint8Array).toString('base64url')
}

async function generateDpopKeyPair(): Promise<{ privateJwk: JsonWebKey; publicJwk: JsonWebKey }> {
  const kp = await webcrypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'])
  return {
    privateJwk: await webcrypto.subtle.exportKey('jwk', kp.privateKey),
    publicJwk: await webcrypto.subtle.exportKey('jwk', kp.publicKey),
  }
}

async function importDpopPrivateKey(jwk: JsonWebKey): Promise<SubtleCryptoKey> {
  return webcrypto.subtle.importKey('jwk', jwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign'])
}

async function generateDpopJwt(
  privateKey: SubtleCryptoKey,
  publicJwk: JsonWebKey,
  htm: string,
  htu: string,
  nowMs = Date.now(),
): Promise<string> {
  const header = { typ: 'dpop+jwt', alg: 'ES256', jwk: { kty: publicJwk.kty, x: publicJwk.x, y: publicJwk.y, crv: publicJwk.crv } }
  const payload = { htm, htu, iat: Math.floor(nowMs / 1000), jti: randomBytes(16).toString('hex') }
  const input = `${b64(Buffer.from(JSON.stringify(header)))}.${b64(Buffer.from(JSON.stringify(payload)))}`
  const sig = await webcrypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, privateKey, Buffer.from(input))
  return `${input}.${b64(new Uint8Array(sig))}`
}

// ────────────────────────── 登录流程（步骤 1-3 的浏览器外部分）──────────────────────────

export interface OfficeAceLoginStart {
  /** 浏览器要打开的授权页 URL。 */
  authorizeUrl: string
  /** 云侧登记的 state（login.poll 用它取 code）。 */
  state: string
  /** PKCE verifier + DPoP 私钥（换 token 时用；内存中间态，不落盘）。 */
  _internal: {
    codeVerifier: string
    dpopPrivateJwk: JsonWebKey
  }
}

/**
 * 步骤 1：向云侧注册 state 并生成授权 URL。
 *
 * `_internal` 由调用方保存在内存（登录会话记录），授权完成后传给
 * {@link completeLogin}。
 */
export async function startLogin(): Promise<OfficeAceLoginStart> {
  // 1. 云侧登记 state（⚠️ 必须用云侧发的——自造的 state 回调后查不到）
  const stateRes = await fetch(`${CLAW_BASE}/v1/claw/auth/state`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{}',
    signal: AbortSignal.timeout(15_000),
  })
  if (!stateRes.ok) {
    throw new Error(`华为云 state 注册失败：HTTP ${stateRes.status}`)
  }
  const state = ((await stateRes.json()) as { state?: unknown }).state
  if (typeof state !== 'string' || state.length === 0) {
    throw new Error('华为云未返回 state')
  }

  // 2. PKCE + 授权 URL
  const codeVerifier = b64(randomBytes(32))
  const codeChallenge = createHash('sha256').update(codeVerifier).digest('base64url')
  const { privateJwk, publicJwk } = await generateDpopKeyPair()

  const params = new URLSearchParams({
    client_id: CLIENT_ID,
    code_challenge: codeChallenge,
    code_challenge_method: 'SHA-256',
    state,
    scope: 'openid',
    redirect_uri: REDIRECT_URI,
    response_type: 'code',
  })
  const authorizeUrl = `https://auth.huaweicloud.com/authui/login.html?service=${encodeURIComponent(
    `https://auth.huaweicloud.com/authui/v1/oauth2/authorize?${params.toString()}`,
  )}`

  return { authorizeUrl, state, _internal: { codeVerifier, dpopPrivateJwk: privateJwk } }
}

/**
 * 步骤 2：向云侧轮询 code（state 已登记时，用户授权后此端点返回 code）。
 *
 * @returns code；用户尚未授权时返回 undefined（前端继续轮询）。
 */
export async function pollLoginCode(state: string): Promise<string | undefined> {
  const r = await fetch(`${CLAW_BASE}/v1/claw/auth/code?state=${encodeURIComponent(state)}`, {
    headers: { Accept: 'application/json' },
    signal: AbortSignal.timeout(15_000),
  })
  if (!r.ok) return undefined // 202/404 = 未就绪
  try {
    const j = (await r.json()) as { code?: unknown; data?: { code?: unknown } }
    const code = j.code ?? j.data?.code
    return typeof code === 'string' && code.length > 0 ? code : undefined
  } catch {
    return undefined
  }
}

// ────────────────────────── 步骤 4-5：token 交换 + modelInfo ──────────────────────────

interface IamTokenResponse {
  credentials: {
    access_key_id: string
    secret_access_key: string
    security_token: string
    expiration: string
    project_id?: string
  }
  refresh_token?: string
  id_token?: string
}

interface PermissionResponse {
  account_id?: string
  principal_urn?: string
  subscription?: {
    model_info?: {
      model_auth_info?: { model_app_key?: unknown; model_app_secret?: unknown }
      model_api_url_base?: unknown
    }
  }
}

/**
 * 华为云 APIG 请求签名（AK/SK，SDK-HMAC-SHA256）。
 *
 * ⚠️ 逐字复刻（反编译对齐，三处坑全踩过）：
 *
 * 1. **canonical 路径强制尾斜杠**：缺它就是 `verify ak sk signature failed`。
 * 2. **签名密钥就是裸 Secret**：`Hmac(SHA256, Secret)` 签 StringToSign ——
 *    **没有** AWS 系的 scope 密钥派生（曾按 scope 派生，401）。
 * 3. **头名全小写排序**，头值 trim，GET 的 body 视为空。
 */
function signHuaweiRequest(
  method: string,
  url: string,
  headers: Record<string, string>,
  bodyText: string,
  accessKey: string,
  secretKey: string,
): Record<string, string> {
  const u = new URL(url)
  const now = new Date()
  const pad = (n: number): string => (n >= 10 ? String(n) : `0${n}`)
  const xdate = String(now.getUTCFullYear()) + pad(now.getUTCMonth() + 1) + pad(now.getUTCDate())
    + 'T' + pad(now.getUTCHours()) + pad(now.getUTCMinutes()) + pad(now.getUTCSeconds()) + 'Z'
  const urlEncode = (s: string): string => encodeURIComponent(s)

  // k()：canonical URI —— 逐段 urlEncode 后 join，**末尾补 /**
  const canonicalUri0 = u.pathname.split('/').map((seg) => urlEncode(seg)).join('/')
  const canonicalUri = canonicalUri0.endsWith('/') ? canonicalUri0 : `${canonicalUri0}/`

  // C()：query 排序拼接（本项目 GET 无 query，但实现保留）
  const queryPairs: string[] = []
  for (const key of [...u.searchParams.keys()].sort()) {
    queryPairs.push(`${urlEncode(key)}=${urlEncode(u.searchParams.get(key) ?? '')}`)
  }
  const canonicalQuery = queryPairs.join('&')

  // 头：全小写 + host + x-sdk-date；值 trim
  const lower: Record<string, string> = {}
  for (const [k, v] of Object.entries(headers)) lower[k.toLowerCase()] = v.trim()
  lower.host = u.host
  lower['x-sdk-date'] = xdate
  const signedHeaders = Object.keys(lower).sort()
  let canonicalHeaders = ''
  for (const h of signedHeaders) canonicalHeaders += `${h}:${lower[h]}\n`

  const bodyHash = (method === 'PUT' || method === 'PATCH' || method === 'POST')
    ? createHash('sha256').update(bodyText).digest('hex')
    : createHash('sha256').update('').digest('hex')
  const canonicalRequest = [method, canonicalUri, canonicalQuery, canonicalHeaders, signedHeaders.join(';'), bodyHash].join('\n')
  const stringToSign = ['SDK-HMAC-SHA256', xdate, createHash('sha256').update(canonicalRequest).digest('hex')].join('\n')
  // D()：签名密钥 = 裸 Secret
  const sig = createHmac('sha256', secretKey).update(stringToSign).digest('hex')
  return {
    ...headers,
    'X-Sdk-Date': xdate,
    Authorization: `SDK-HMAC-SHA256 Access=${accessKey}, SignedHeaders=${signedHeaders.join(';')}, Signature=${sig}`,
  }
}

/**
 * 步骤 4：code + verifier + DPoP 换 token。
 *
 * ⚠️ code 秒级时效 —— 轮询到后**立刻**调用本函数。
 */
async function exchangeToken(
  code: string,
  codeVerifier: string,
  dpopPrivateJwk: JsonWebKey,
): Promise<IamTokenResponse> {
  const privateKey = await importDpopPrivateKey(dpopPrivateJwk)
  // DPoP 密钥对与 verifier 同批生成 —— 这里从 store 恢复不了（只有私钥 JWK），
  // 所以 publicJwk 从私钥 JWK 推回（同 crv/x/y，少 d 一项）。
  const publicJwk: JsonWebKey = { kty: 'EC', crv: 'P-256', x: dpopPrivateJwk.x, y: dpopPrivateJwk.y }
  const dpopJwt = await generateDpopJwt(privateKey, publicJwk, 'POST', TOKEN_URL)

  const body = new URLSearchParams({
    client_id: CLIENT_ID,
    code,
    code_verifier: codeVerifier,
    grant_type: 'authorization_code',
    redirect_uri: REDIRECT_URI,
  })
  const r = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', DPoP: dpopJwt },
    body: body.toString(),
    signal: AbortSignal.timeout(30_000),
  })
  const text = await r.text()
  if (!r.ok) {
    throw new Error(`华为云 token 交换失败：HTTP ${r.status} ${text.slice(0, 200)}`)
  }
  return JSON.parse(text) as IamTokenResponse
}

/**
 * 步骤 5：用 STS 凭据调 permission-validate，拿 modelInfo（推理凭据）。
 */
async function fetchModelInfo(credential: OfficeAceCredential): Promise<void> {
  const url = `${CLAW_BASE}/v1/claw/client-permission-validate`
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    'x-security-token': credential.securityToken,
  }
  if (credential.projectId) headers['x-project-id'] = credential.projectId
  const signed = signHuaweiRequest('GET', url, headers, '', credential.access, credential.secret)
  const r = await fetch(url, { method: 'GET', headers: signed, signal: AbortSignal.timeout(30_000) })
  const text = await r.text()
  if (!r.ok) {
    throw new Error(`华为云权限校验失败：HTTP ${r.status} ${text.slice(0, 200)}`)
  }
  const j = JSON.parse(text) as PermissionResponse
  const modelInfo = j.subscription?.model_info
  const auth = modelInfo?.model_auth_info
  if (typeof auth?.model_app_key !== 'string' || typeof auth.model_app_secret !== 'string') {
    // ⚠️ 2026-10-14 用户连续三次报障「授权成功但账号没加进来」的真相：
    // 他用**另一个华为账号**授权，授权与 token 交换都成功，但这个账号
    // **没有开通 ModelArts MaaS** ⇒ permission-validate 不下发推理凭据。
    // 文案必须讲清「是什么 + 怎么办」，否则用户只会反复重试同一个账号。
    throw new Error(
      '华为云未返回 MaaS 推理凭据 —— 该华为账号尚未开通 ModelArts MaaS'
      + '（OfficeAce 的推理走 ModelArts MaaS）。请在华为云控制台开通后重试，'
      + '或换一个已开通的华为账号。',
    )
  }
  credential.modelAppKey = auth.model_app_key
  credential.modelAppSecret = auth.model_app_secret
  const baseUrl = modelInfo?.model_api_url_base
  credential.maasBaseUrl = typeof baseUrl === 'string' && baseUrl.length > 0
    ? `https://${baseUrl.replace(/^https?:\/\//, '')}`
    : OFFICEACE.defaultBaseUrl
  credential.accountId = j.account_id ?? credential.accountId
}

/**
 * 完成登录：code → token → modelInfo → **返回凭据（不落盘）**。
 *
 * ⚠️ 必须在轮询到 code 后**立刻**调用（code 秒级时效）。
 *
 * ⚠️ **落盘由调用方完成**（本项目走 `LoginOrchestrator.settle`，与其余 provider
 * 一致）：凭据存进统一凭据存储并按 `credentialRef` 索引 —— 这才是号池多账号的根。
 */
export async function completeLogin(
  code: string,
  codeVerifier: string,
  dpopPrivateJwk: JsonWebKey,
): Promise<OfficeAceCredential> {
  const token = await exchangeToken(code, codeVerifier, dpopPrivateJwk)
  const c = token.credentials
  const credential: OfficeAceCredential = {
    modelAppKey: '',
    modelAppSecret: '',
    maasBaseUrl: OFFICEACE.defaultBaseUrl,
    access: c.access_key_id,
    secret: c.secret_access_key,
    securityToken: c.security_token,
    projectId: c.project_id ?? '',
    expiresAt: c.expiration,
    refreshToken: token.refresh_token ?? '',
    dpopPrivateJwk,
  }
  await fetchModelInfo(credential)
  return credential
}

// ────────────────────────── 刷新 ──────────────────────────

/**
 * 续期**一份已读入内存的凭据**（纯协议：STS 交换 + modelInfo），**不落盘**。
 *
 * ⚠️ `refresh_token` **一次性**：调用方拿到返回值后必须**立即落盘**（见模块头
 * 的死循环教训）。落盘职责留给调用方 —— 本函数只做协议交换。
 *
 * @returns 新凭据；refresh_token 失效（STS5.1806）返回 undefined（需重新登录）。
 */
export async function refreshOfficeAceCredential(
  current: OfficeAceCredential,
): Promise<OfficeAceCredential | undefined> {
  if (current.refreshToken.length === 0) return undefined
  const privateKey = await importDpopPrivateKey(current.dpopPrivateJwk)
  const publicJwk: JsonWebKey = { kty: 'EC', crv: 'P-256', x: current.dpopPrivateJwk.x, y: current.dpopPrivateJwk.y }
  const dpopJwt = await generateDpopJwt(privateKey, publicJwk, 'POST', TOKEN_URL)

  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: current.refreshToken,
    client_id: CLIENT_ID,
  })
  const r = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', DPoP: dpopJwt },
    body: body.toString(),
    signal: AbortSignal.timeout(30_000),
  })
  if (!r.ok) {
    // ⚠️ **必须留痕**（失败不允许静默吞掉）：refresh_token 被消费丢失
    //    （STS5.1806）时日志零字，用户只看到「渠道停了」，无从排查。
    const detail = await r.text().catch(() => '')
    console.warn(
      `[officeace] STS 续期失败 HTTP ${r.status}：${detail.slice(0, 200)}`
      + '（refresh_token 是一次性的：若报 STS5.1806 已被消费，必须重新登录才能恢复）',
    )
    return undefined
  }
  const token = (await r.json()) as IamTokenResponse
  const c = token.credentials
  const next: OfficeAceCredential = {
    ...current,
    access: c.access_key_id,
    secret: c.secret_access_key,
    securityToken: c.security_token,
    projectId: c.project_id ?? current.projectId,
    expiresAt: c.expiration,
    refreshToken: token.refresh_token ?? current.refreshToken,
  }
  // modelInfo 里的 MaaS 凭据也随之更新（可能轮换）。
  try {
    await fetchModelInfo(next)
  } catch {
    // modelInfo 拉取失败不回滚 STS：推理凭据可能仍有效
  }
  return next
}

/** Basic 授权头值（推理用）。 */
export function basicAuthorization(credential: OfficeAceCredential): string {
  return 'Basic ' + Buffer.from(`${credential.modelAppKey}:${credential.modelAppSecret}`).toString('base64')
}

/** 读凭据并顺带判断 STS 是否临期（调用方决定是否先刷新）。 */
export function isExpiring(credential: OfficeAceCredential, leadMs = 10 * 60 * 1000): boolean {
  const exp = Date.parse(credential.expiresAt)
  if (!Number.isFinite(exp)) return true
  return exp - Date.now() < leadMs
}

/** 凭据里读到的过期时刻（毫秒）；读不到/非法返回 `undefined`（⇒ 需要续期）。 */
export function officeaceExpiresAtMs(credential: OfficeAceCredential): number | undefined {
  // ⚠️ 华为 STS 的 `expiration` 是 **ISO 8601 字符串**（不是数值时间戳），
  //    故这里**不需要**秒→毫秒归一化，也不是一个 bug。
  const parsed = Date.parse(credential.expiresAt)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined
}

export { OFFICEACE }
