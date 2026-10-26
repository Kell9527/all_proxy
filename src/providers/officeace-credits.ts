/**
 * OfficeAce（华为云 ModelArts MaaS）的**积分查询** —— V11-HMAC-SHA256 签名的
 * 云侧订阅直读 + 每日福利自动领取。
 *
 * 移植自来源 `src/officeace-auth.ts` 的 `signAndRequest` / `fetchCloudSubscriptionFor` /
 * `claimDailyBonus` / `maybeClaimBonus` 四支（超出移植基线 `3611a62`，故不走
 * `port-providers.mjs`，手工移植并只改存储层依赖）。
 *
 * ## 与来源的差异（刻意裁掉的三块）
 *
 * | 来源能力 | 本项目 | 原因 |
 * |---|---|---|
 * | 本地 `127.0.0.1:3004` API（读果办 `oc_sid` cookie） | **裁掉** | 只对「装过 OfficeAce 客户端」的用户有意义；且 cookie 是**全局单一账号**，多账号下会让所有卡片显示同一个账号的余额（实测两个账号都显示 6500） |
 * | Redis 6399 / DPAPI / PowerShell 迁移桥 | **裁掉** | 与 `officeace-auth.ts` 同款决定（见那里的模块头） |
 * | `subscription-cache-<ref>.json` 磁盘缓存 | **裁掉** | 缓存是第二个数据源：账号已删/凭据已换时它会显示**旧账号的余额**，比显示「查询失败」更糟。查询失败如实报错，不拿陈旧数字糊弄 |
 *
 * 保留的**主路径**即：给定凭据 → 自动领当日福利 → V11 签名云侧直读 → 归一化成分桶。
 *
 * ## ⚠️ 多账号：查哪个账号由**入参凭据**决定
 *
 * 本模块的每个函数都**显式接收凭据**，不做任何「该读哪一份」的猜测 ——
 * 来源在这里踩过串号坑（本地 cookie 无法按 ref 区分账号）。
 *
 * ## 失败语义
 *
 * 与 `accio-credits.ts` 同：`balance: null` + 原因，**绝不编造 0**；
 * 「未登录/凭据缺字段」与「上游暂不可用」分开表述（用户动作完全不同）。
 */

import { createHash, createHmac } from 'node:crypto'
import { OFFICEACE } from './officeace-product.js'
import type { OfficeAceCredential } from './officeace-auth.js'
import {
  roundCredits,
  type CreditBalance,
  type CreditPackage,
  type ProviderBalanceDetail,
} from './credits.js'

/** 请求超时（与 officeace-auth 的协议层一致）。 */
const REQUEST_TIMEOUT_MS = 30_000

/**
 * 订阅摘要（果办界面右上角的积分池，云侧直读归一化结果）。
 *
 * `creditGroups` 的每个桶 = 面板上「永久 / 长期 / 临期」分桶的原料：
 * - `expiresAt` 缺席 = 真·永久桶（前端据此归入「永久」）；
 * - `expired` 是独立布尔（不是 `active` 的反义 —— 已过期但仍可能在响应里）。
 */
export interface OfficeAceSubscriptionSummary {
  planName?: string
  totalCredits: number
  usedCredits: number
  creditGroups: Array<{
    key: string
    name: string
    kind?: string
    remaining: number
    total: number
    used?: number
    expiresAt?: string
    expired?: boolean
  }>
}

/** 签名请求的结果：`ok` 表示上游回 2xx，`text` 是响应正文（失败时为空串）。 */
interface SignedResponse {
  ok: boolean
  text: string
}

/**
 * V11 签名的请求 —— **GET 与 POST 共用**。
 *
 * 逐字复刻 OfficeAce `chunk-XOTX5NN5.js` 的 `B()`/`F()`。三条**必须**记住的
 * 规则（每条都曾导致 401，别再凭直觉改）：
 *
 * 1. **头集合**：GET 请求**不发 `Content-Type`**（OfficeAce 的 `cloudFetch` 只在
 *    `method !== 'GET'` 时设置它）。多这一个头，签名串就多一行，服务端重算必不匹配。
 * 2. **密钥派生**（`z(accessKey, secretKey, scope)`）：
 *    `u = HMAC(sha256, accessKey).update(secretKey)`；
 *    `a = scope 字节 + 0x01`；`derive = HMAC(sha256, u).update(a)` 取**前 32 字节**。
 *    最后**以 derive 的 hex 字符串（不是 raw bytes）作为 key** 签 stringToSign。
 * 3. **分隔符**：canonical 头行与 stringToSign 都是 **LF** 分隔（不是空格）；
 *    canonical 路径**强制尾斜杠**。
 *
 * POST 与 GET 的**唯一**差异是 `Content-Type` 是否进入签名头集合（规则 1：
 * GET 不带），以及 body 参与 payload 哈希 —— 故抽成一个函数，避免两处签名逻辑
 * 漂移（那正是当初 GET 反复 401 的成因）。
 *
 * @param body - 请求体文本；`undefined`（无 body）时按空串计哈希。
 * @returns 是否 2xx 与响应正文；非 2xx 或异常时 `ok:false`（调用方按「读不到」降级）。
 */
async function signAndRequest(
  url: string,
  credential: OfficeAceCredential,
  method: 'GET' | 'POST',
  body?: string,
  fetcher: typeof fetch = fetch,
): Promise<SignedResponse> {
  const region = 'cn-southwest-2'
  const service = 'apic'
  const pad = (n: number): string => (n >= 10 ? String(n) : `0${n}`)
  const now = new Date()
  const xdate = String(now.getUTCFullYear()) + pad(now.getUTCMonth() + 1) + pad(now.getUTCDate())
    + 'T' + pad(now.getUTCHours()) + pad(now.getUTCMinutes()) + pad(now.getUTCSeconds()) + 'Z'
  const urlEncode = (s: string): string => encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)

  const u = new URL(url)
  // N()：canonical 路径 —— 逐段编码后 **强制尾斜杠**
  const canonicalUri0 = u.pathname.split('/').map((s) => urlEncode(decodeURIComponent(s))).join('/')
  const canonicalUri = canonicalUri0.endsWith('/') ? canonicalUri0 : `${canonicalUri0}/`
  // P()：query 排序拼接（当前端点无 query，实现保留）
  const queryPairs: Array<[string, string]> = []
  u.searchParams.forEach((v, n) => queryPairs.push([n, v]))
  queryPairs.sort(([a, b], [c, d]) => (a === c ? b.localeCompare(d) : a.localeCompare(c)))
  const canonicalQuery = queryPairs.map(([k, v]) => `${urlEncode(k)}=${urlEncode(v)}`).join('&')

  // 规则 1：**GET 不带 `Content-Type`**；POST 必须带（且要与签名头集合一致）。
  const contentType = 'application/json;charset=utf8'
  const original: Record<string, string> = {
    'x-subscription-type': 'v2',
    'X-Sdk-Date': xdate,
    'X-Security-Token': credential.securityToken.trim(),
    Host: u.host,
  }
  if (method === 'POST') original['Content-Type'] = contentType
  if (credential.projectId) original['X-Project-ID'] = credential.projectId
  // R()：签名用**小写名**，值 trim + 折叠空白
  const lower: Record<string, string> = {}
  for (const [k, v] of Object.entries(original)) lower[k.toLowerCase()] = v.trim().replace(/\s+/g, ' ')
  const signedHeaders = Object.keys(lower).sort()
  // 规则 3：头行 LF 分隔 + 末尾 LF
  let canonicalHeaders = ''
  for (const h of signedHeaders) canonicalHeaders += `${h}:${lower[h]}\n`
  // payload 哈希：**待签body文本**（无 body 时为空串）
  const payloadHash = createHash('sha256').update(body ?? '', 'utf8').digest('hex')
  const canonicalRequest = [
    method, canonicalUri, canonicalQuery, canonicalHeaders,
    signedHeaders.join(';'), payloadHash,
  ].join('\n')
  const scope = `${xdate.slice(0, 8)}/${region}/${service}`
  const stringToSign = ['V11-HMAC-SHA256', xdate, scope, createHash('sha256').update(canonicalRequest).digest('hex')].join('\n')
  // 规则 2：密钥派生
  const u1 = createHmac('sha256', credential.access).update(credential.secret).digest()
  const derivedKey = createHmac('sha256', u1)
    .update(Buffer.concat([Buffer.from(scope, 'utf8'), Buffer.from([1])]))
    .digest()
    .subarray(0, 32)
    .toString('hex')
  const signature = createHmac('sha256', Buffer.from(derivedKey, 'utf8')).update(stringToSign).digest('hex')

  try {
    const r = await fetcher(url, {
      method,
      headers: {
        ...original,
        Authorization: `V11-HMAC-SHA256 Credential=${credential.access}/${scope}, SignedHeaders=${signedHeaders.join(';')}, Signature=${signature}`,
      },
      ...body === undefined ? {} : { body },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    })
    return r.ok ? { ok: true, text: await r.text() } : { ok: false, text: '' }
  } catch {
    // 网络异常按「读不到」降级（与来源的非 2xx 处理同）。
    return { ok: false, text: '' }
  }
}

/**
 * 用**给定**凭据云侧直读订阅（V11 签名）。
 *
 * 端点：`GET {defaultBaseUrl}/v1/subscription`（`x-subscription-type: v2`）。
 * 响应含套餐桶（`skus[].quotas`，`sku_attr_code === 'officeace_points'`）与
 * bonus 桶（`bonus_skus[]`）—— 与果办界面右上角的分桶完全同源
 * （复刻自 OfficeAce `hHe()` 的归一化逻辑）。
 *
 * ⚠️ 凭据由调用方明确指定，本函数不做任何「该读哪一份」的猜测 ——
 *    多账号下这个猜测必错（实测两个账号都显示第一个账号的余额）。
 *
 * @returns 归一化摘要；凭据缺字段 / 请求失败 / 响应无桶时返回 undefined。
 */
export async function fetchOfficeAceCloudSubscription(
  credential: OfficeAceCredential,
  fetcher: typeof fetch = fetch,
): Promise<OfficeAceSubscriptionSummary | undefined> {
  if (credential === undefined || credential.access.length === 0 || credential.securityToken.length === 0) {
    return undefined
  }
  const body = await signAndRequest(
    `${OFFICEACE.defaultBaseUrl.replace(/\/+$/, '')}/v1/subscription`,
    credential,
    'GET',
    undefined,
    fetcher,
  )
  if (!body.ok || body.text.length === 0) return undefined
  return parseOfficeAceSubscription(body.text)
}

/** 解析 `/v1/subscription` 响应（抽出来供单测直接喂 JSON 文本）。 */
export function parseOfficeAceSubscription(body: string): OfficeAceSubscriptionSummary | undefined {
  let j: {
    skus?: { sku_name?: unknown; sku_code?: unknown; quotas?: { sku_attr_code?: unknown; sku_value?: unknown; current_value?: unknown; expired_time?: unknown }[] }[]
    bonus_skus?: { activity_id?: unknown; activity_name?: unknown; points?: unknown; current_value?: unknown; expired_time?: unknown }[]
  }
  try {
    j = JSON.parse(body) as typeof j
  } catch {
    return undefined
  }
  const now2 = Date.now()
  const creditGroups: OfficeAceSubscriptionSummary['creditGroups'] = []
  for (const sku of j.skus ?? []) {
    for (const q of sku.quotas ?? []) {
      if (q.sku_attr_code !== 'officeace_points') continue
      const total = Number(q.sku_value)
      const used = Number(q.current_value)
      const expiredAt = typeof q.expired_time === 'string' && q.expired_time.length > 0 ? q.expired_time : null
      const isTrial = String(sku.sku_code ?? '').endsWith('.trial')
      creditGroups.push({
        key: `plan-${String(sku.sku_code ?? '')}`,
        name: typeof sku.sku_name === 'string' ? sku.sku_name : '套餐',
        kind: 'plan',
        remaining: Math.max(0, total - used),
        total,
        used,
        expiresAt: isTrial ? undefined : expiredAt ?? undefined,
        expired: !isTrial && expiredAt !== null && new Date(expiredAt).getTime() <= now2,
      })
    }
  }
  for (const bonus of j.bonus_skus ?? []) {
    const points = Number(bonus.points)
    const used = Number(bonus.current_value)
    if (!Number.isFinite(points)) continue
    creditGroups.push({
      key: `bonus-${String(bonus.activity_id ?? '')}`,
      name: typeof bonus.activity_name === 'string' ? bonus.activity_name : '活动奖励',
      kind: 'bonus',
      remaining: Math.max(0, points - used),
      total: points,
      used,
      expiresAt: typeof bonus.expired_time === 'string' ? bonus.expired_time : undefined,
      expired: typeof bonus.expired_time === 'string' && new Date(bonus.expired_time).getTime() <= now2,
    })
  }
  if (creditGroups.length === 0) return undefined
  const totalCredits = creditGroups
    .filter((g) => !g.expired)
    .reduce((sum, g) => sum + g.remaining, 0)
  return {
    planName: creditGroups.find((g) => g.kind === 'plan')?.name,
    totalCredits,
    usedCredits: creditGroups.reduce((sum, g) => sum + (g.used ?? 0), 0),
    creditGroups,
  }
}

/**
 * 一次领取的结果。
 *
 * ⚠️ **必须区分 `claimed` 与 `empty`**：上游对「今天已经领过」回的是
 * `HTTP 200 {"bonus_skus":[]}`（2026-10-23 实测），与「活动不存在」完全同形。
 * 合并成「领到 0 分」会让调用方无法判断该不该重试 —— 定时任务按天去重、
 * 手动刷新按结果提示，两者都需要这个区分。
 */
export interface OfficeAceBonusClaimResult {
  /** `claimed` 本次真的领到；`empty` 上游回 200 但没有新桶（多为今天已领）；`failed` 请求失败。 */
  kind: 'claimed' | 'empty' | 'failed'
  /** 本次新领到的活动桶（`kind==='claimed'` 时至少一个）。 */
  claimed: Array<{ activityId: string; activityName: string; points: number }>
}

/**
 * 自动领取每日福利（**签到**）——`POST /v1/subscription/bonus/claim`。
 *
 * ## 为什么需要它（以及为什么必须是**自动**的）
 *
 * OfficeAce 的签到实际上是「每日送积分」的活动桶（`bonus_skus` 里的
 * `bonus-daily-checkin-2026`）。果办客户端的做法是**订阅页一挂载就自动
 * 调这个端点**（源码 `SubscriptionStateProvider`：用「年+月+日+时」做去重键，
 * 每小时最多领一次）—— **UI 上没有签到按钮**，不存在「手动签到」这回事。
 *
 * ⚠️ **积分当日作废**（2026-10-23 实测）：`expired_time` 是
 *    `2026-10-23T15:59:59.000Z`，折合北京时间当日 23:59:59 —— 即 UTC+8 自然日
 *    结束时作废。当天不领就永久失去那一份，这正是自动领取的价值所在。
 *
 * ⚠️ **POST 必须带 `Content-Type`**（规则 1 的另一面）：实测不带会得到
 *    HTTP 500 `OfficeAce.11020001 内部服务器错误`；带了才是 200。
 *    body 为空即可 —— 该端点不需要入参（果办也是 `void 0`）。
 *
 * @returns 领取结果；**不抛错**（签到失败不该阻断余额展示，由调用方决定提示）。
 */
export async function claimOfficeAceDailyBonus(
  credential: OfficeAceCredential,
  fetcher: typeof fetch = fetch,
): Promise<OfficeAceBonusClaimResult> {
  if (credential === undefined || credential.access.length === 0 || credential.securityToken.length === 0) {
    return { kind: 'failed', claimed: [] }
  }
  const body = await signAndRequest(
    `${OFFICEACE.defaultBaseUrl.replace(/\/+$/, '')}/v1/subscription/bonus/claim`,
    credential,
    'POST',
    undefined,
    fetcher,
  )
  if (!body.ok) return { kind: 'failed', claimed: [] }
  try {
    const j = JSON.parse(body.text) as {
      bonus_skus?: Array<{
        activity_id?: unknown
        activity_name?: unknown
        points?: unknown
      }>
    }
    const claimed = (j.bonus_skus ?? []).map((s) => ({
      activityId: String(s.activity_id ?? ''),
      activityName: typeof s.activity_name === 'string' ? s.activity_name : '活动奖励',
      points: Number(s.points) || 0,
    }))
    return claimed.length === 0 ? { kind: 'empty', claimed } : { kind: 'claimed', claimed }
  } catch {
    // 2xx 但不是 JSON：算失败（重试有意义），不算「今天已领」。
    return { kind: 'failed', claimed: [] }
  }
}

/**
 * 领取去重的日期键：**UTC+8 自然日**（`yyyy-mm-dd`）。
 *
 * 上游的到期时间是 `...T15:59:59Z` 折合北京时间当日 23:59:59，即额度按
 * **UTC+8 自然日**作废，故去重也必须用同一个日界。⚠️ 不能取本机时区 ——
 * 用户出差或改系统时区会算出错的日界，导致「刚过本机 0 点就以为新的一天」
 * 而在同一 UTC+8 自然日里重复领取（或反之，整天不领）。
 */
export function officeAceDayKey(now: Date = new Date()): string {
  return new Date(now.getTime() + 8 * 60 * 60 * 1000).toISOString().slice(0, 10)
}

/** 失败后的重试冷却：避免网络抖动时定时任务与面板路径连续打上游。 */
const BONUS_RETRY_COOLDOWN_MS = 10 * 60 * 1000

interface BonusClaimState {
  /** 已**成功**领取（或确认当天早已领过）的 UTC+8 日期键；未成功时不写。 */
  settledDay?: string
  /** 最近一次尝试的时刻（毫秒，含失败）。 */
  lastAttemptAt: number
}

/**
 * 「今天领过就别再领」的去重表。
 *
 * ⚠️ **按 ref 而非全局**：多账号下每个账号**各自**都要领，共用一把锁会让
 *    第二个账号永远领不到（它的签到分当日作废）。
 * ⚠️ **成功才记日期**：早期实现「先标记再请求」，一次网络抖动就把当天记成
 *    「已领」，该账号当天剩下的时间再也不会重试 ⇒ 白丢当天额度。现在失败不
 *    记日期，只记尝试时刻用于短冷却。
 * ⚠️ **按自然日而非小时**：额度当日作废，同日重复领取毫无收益；而按小时节流
 *    跨天后仍会等满一小时才补领（进程常在早晨就已被定时任务唤醒）。
 *
 * 进程内 Map（不落盘）：重启后第一次会补领一次，与「客户端每次启动都领」的
 * 语义一致，且上游对重复领取幂等（回 200 + 空桶）。
 */
const bonusClaimState = new Map<string, BonusClaimState>()

/**
 * 节流后的自动领取（`ref` 用账号的 credentialRef，缺省时用 'default'）。
 *
 * @param options.force - **手动补领**时置 true：跳过「今天已领」与失败冷却两道闸门。
 *   用户点按钮就是明确要求「现在就试一次」，被去重表静默忽略会让人以为按钮坏了。
 *   仍会照常更新去重表（成功后定时任务不再重复打上游）。
 * @returns 本次的实际结果；被节流跳过时返回 `undefined`（不可与「失败」混淆）。
 */
export async function maybeClaimOfficeAceBonus(
  credential: OfficeAceCredential,
  ref: string,
  fetcher: typeof fetch = fetch,
  now: () => number = Date.now,
  options: { force?: boolean } = {},
): Promise<OfficeAceBonusClaimResult | undefined> {
  const at = now()
  const dayKey = officeAceDayKey(new Date(at))
  const state = bonusClaimState.get(ref)
  if (options.force !== true && state !== undefined) {
    // 今天已成功领过（或上游确认今天早已领过）⇒ 不重复打上游。
    if (state.settledDay === dayKey) return undefined
    // 刚失败过 ⇒ 冷却期内不重试（面板与定时器会同时打这一枪）。
    if (at - state.lastAttemptAt < BONUS_RETRY_COOLDOWN_MS) return undefined
  }

  bonusClaimState.set(ref, { ...state, lastAttemptAt: at })
  const result = await claimOfficeAceDailyBonus(credential, fetcher)
  if (result.kind !== 'failed') {
    // `claimed` 与 `empty`（今天早已领过）都意味着「今天不用再试」。
    bonusClaimState.set(ref, { settledDay: dayKey, lastAttemptAt: at })
  }
  return result
}

/** 测试辅助：清空领取去重表（避免跨用例串日期键）。 */
export function resetOfficeAceBonusClaimThrottle(): void {
  bonusClaimState.clear()
}

/**
 * 查一个账号的 OfficeAce 余额（**带原因**）。
 *
 * 顺序（与来源一致，**不能反**）：先自动领当日福利，再云侧直读 ——
 * 签到会把当日的福利分打进 `bonus_skus`，先查就永远少显示那一份，
 * 用户会以为没领到。
 *
 * ⚠️ 这里的领取只是**面板路径上的顺带补领**，不是唯一入口：服务侧还有
 * `claimOfficeAceDailyBonuses`（`src/refresh/runtime-helpers.ts`）在启动时与
 * 每小时兜底。两处共用同一份去重表（按 ref + UTC+8 自然日），故不会重复打上游。
 *
 * 三条失败路径全部 `balance: null` + 原因，没有一条退化成 0：
 * 1. 凭据缺 STS 访问键（账号未完成登录 / 迁移条目）⇒ 提示重新登录；
 * 2. 云侧直读失败（网络 / 非 2xx / 非 JSON）⇒ 提示稍后重试；
 * 3. 响应成功但没有任何订阅桶 ⇒ 明说「未包含订阅数据」。
 */
export async function fetchOfficeAceBalanceDetailed(
  credential: OfficeAceCredential,
  ref: string,
  fetcher: typeof fetch = fetch,
): Promise<ProviderBalanceDetail> {
  if (credential.access.length === 0 || credential.securityToken.length === 0) {
    return { balance: null, error: 'OfficeAce 凭据缺少华为云访问键（请重新登录以补全）' }
  }

  // ① 自动领当日福利（去重：按 ref + UTC+8 自然日；失败不记日期）
  await maybeClaimOfficeAceBonus(credential, ref, fetcher)

  // ② 云侧直读
  const summary = await fetchOfficeAceCloudSubscription(credential, fetcher)
  if (summary === undefined) {
    return { balance: null, error: '积分查询失败：华为云订阅接口未返回数据（凭据失效或上游暂不可用），请稍后重试' }
  }

  const packages: CreditPackage[] = summary.creditGroups.map((group) => ({
    name: group.name,
    // 量纲如实登记：华为云按 token 计费（前端「积分」行的 dt 仍写「积分」，
    // 与面板其余渠道统一；明细 tooltip 里可见单位）。
    unit: OFFICEACE.quotaUnit,
    remaining: roundCredits(group.remaining),
    total: roundCredits(group.total),
    used: roundCredits(group.used ?? 0),
    active: group.expired !== true,
    cycleStartTime: '',
    cycleEndTime: '',
    // 到期时间走 CreditPackage 既有的 expiredTime（ISO 串；空串 = 无固定失效
    // 时间 = 真·永久桶）。前端分桶（永久/长期/临期）按它解析。
    expiredTime: group.expiresAt ?? '',
  }))

  const expiredTotal = summary.creditGroups
    .filter((g) => g.expired === true)
    .reduce((sum, g) => sum + g.remaining, 0)

  const balance: CreditBalance = {
    total: roundCredits(summary.totalCredits),
    packages,
    expiredTotal: roundCredits(expiredTotal),
  }
  return { balance }
}
