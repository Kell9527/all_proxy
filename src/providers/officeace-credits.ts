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
 * @returns 响应正文；非 2xx 或异常返回空串（调用方按「读不到」降级）。
 */
async function signAndRequest(
  url: string,
  credential: OfficeAceCredential,
  method: 'GET' | 'POST',
  body?: string,
  fetcher: typeof fetch = fetch,
): Promise<string> {
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
    return r.ok ? await r.text() : ''
  } catch {
    // 网络异常按「读不到」降级（与来源的非 2xx 处理同）。
    return ''
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
  if (body.length === 0) return undefined
  return parseOfficeAceSubscription(body)
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
 * 自动领取每日福利（**签到**）——`POST /v1/subscription/bonus/claim`。
 *
 * ## 为什么需要它（以及为什么必须是**自动**的）
 *
 * OfficeAce 的签到实际上是「每日送 1000 积分」的活动桶（`bonus_skus` 里的
 * `bonus-bonus-daily-checkin-2026`）。果办客户端的做法是**订阅页一挂载就自动
 * 调这个端点**（源码 `SubscriptionStateProvider`：用「年+月+日+时」做去重键，
 * 每小时最多领一次）—— **UI 上没有签到按钮**，不存在「手动签到」这回事。
 *
 * 故插件侧也必须是自动的：拉余额之前顺手领一次。
 *
 * ⚠️ **积分当日作废**（实测）：`expired_time` 是当天 23:59:59。当天不领就
 * 永久失去那 1000 分 —— 这正是自动领取的价值所在。
 *
 * ⚠️ **POST 必须带 `Content-Type`**（规则 1 的另一面）：实测不带会得到
 *    HTTP 500 `OfficeAce.11020001 内部服务器错误`；带了才是 200。
 *    body 为空即可 —— 该端点不需要入参（果办也是 `void 0`）。
 *
 * @returns 领取到的活动桶；失败返回空数组（**不抛错**：签到失败不该阻断余额展示）。
 */
export async function claimOfficeAceDailyBonus(
  credential: OfficeAceCredential,
  fetcher: typeof fetch = fetch,
): Promise<Array<{ activityId: string; activityName: string; points: number }>> {
  if (credential === undefined || credential.access.length === 0 || credential.securityToken.length === 0) {
    return []
  }
  try {
    const body = await signAndRequest(
      `${OFFICEACE.defaultBaseUrl.replace(/\/+$/, '')}/v1/subscription/bonus/claim`,
      credential,
      'POST',
      undefined,
      fetcher,
    )
    if (body.length === 0) return []
    const j = JSON.parse(body) as {
      bonus_skus?: Array<{
        activity_id?: unknown
        activity_name?: unknown
        points?: unknown
      }>
    }
    return (j.bonus_skus ?? []).map((s) => ({
      activityId: String(s.activity_id ?? ''),
      activityName: typeof s.activity_name === 'string' ? s.activity_name : '活动奖励',
      points: Number(s.points) || 0,
    }))
  } catch {
    // ⚠️ 签到失败**绝不阻断**余额查询。
    return []
  }
}

/**
 * 「够了就不要再领」的节流：同一 ref **每小时最多领一次**（与果办客户端同款
 * 去重键：年+月+日+时）。
 *
 * ⚠️ 不去重的后果：余额每次刷新都打一次 claim ⇒ 面板每开一次就多发一个
 *    请求，且服务端若对重复领取返回异常，日志会被刷屏。
 * ⚠️ 按 ref 而非全局：多账号下每个账号**各自**都要领，共用一把锁会让
 *    第二个账号永远领不到（它的签到分当日作废）。
 *
 * 进程内 Map（不落盘）：重启后第一次查询会补领一次，与「客户端每次启动都领」
 * 的语义一致，且幂等（服务端对重复领取返回已有桶）。
 */
const lastBonusClaimAt = new Map<string, string>()

/** 节流后的自动领取（`ref` 用账号的 credentialRef，缺省时用 'default'）。 */
export async function maybeClaimOfficeAceBonus(
  credential: OfficeAceCredential,
  ref: string,
  fetcher: typeof fetch = fetch,
): Promise<void> {
  const now = new Date()
  const hourKey = `${now.getFullYear()}-${now.getMonth()}-${now.getDate()}-${now.getHours()}`
  if (lastBonusClaimAt.get(ref) === hourKey) return
  lastBonusClaimAt.set(ref, hourKey)
  try {
    await claimOfficeAceDailyBonus(credential, fetcher)
  } catch {
    // 领取失败不影响余额查询（claimOfficeAceDailyBonus 本身已吞错，双保险）。
  }
}

/** 测试辅助：清空领取节流表（避免跨用例串小时键）。 */
export function resetOfficeAceBonusClaimThrottle(): void {
  lastBonusClaimAt.clear()
}

/**
 * 查一个账号的 OfficeAce 余额（**带原因**）。
 *
 * 顺序（与来源一致，**不能反**）：先自动领当日福利，再云侧直读 ——
 * 签到会把当日 1000 分打进 `bonus_skus`，先查就永远少显示那一份，
 * 用户会以为没领到。
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

  // ① 自动领当日福利（节流：每小时最多一次）
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
