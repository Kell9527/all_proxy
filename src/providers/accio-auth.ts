/**
 * Accio 目录解析与凭据辅助（本项目形态）。
 *
 * 移植自来源 `src/accio-auth.ts`，**改动仅限依赖与形态**：
 * - 来源是一个 cordis `Service`（`AccioAuth extends Service`），负责登录编排、
 *   续期队列、账号池回写 —— 这些在本项目分别由 `src/login/orchestrator.ts`、
 *   `src/refresh/refresh-account.ts`（单飞 + 锁内重读）、`src/pool/` 承担；
 * - 故本文件只保留**协议纯函数**：目录条目归一化、目录解析、终态续期判据、
 *   region 归一化、以及「拉远端目录」的一次请求。
 *
 * ⚠️ **目录条目解析器只此一处**（`parseAccioCatalog` 也走它）—— 两处各写一份
 * 必然漂移，而 `visible` / `multimodal` / `effectiveMultiple` 三处都是踩过坑的字段。
 */

import {
  ACCIO,
  ACCIO_CATALOG_PATH,
  ACCIO_REGIONS,
  ACCIO_REQUEST_TIMEOUT_MS,
  type AccioFallbackModel,
  type AccioRegion,
} from './accio-product.js'
import type { AccioCredential } from './accio.js'

/** 续期被服务端判定为**终态**（`refresh_token` 已不可用）时抛出的错误。 */
export class AccioRefreshTokenExpiredError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'AccioRefreshTokenExpiredError'
  }
}

/**
 * 服务端明确表示「这份 refresh_token 不再被接受」的报文标记。
 *
 * ⚠️ 逐条都要求**指向 refresh_token 本身**：`unauthorized` / `403` 这类泛化状态词
 * **不在**此列 —— 网关抖动、区域策略、风控都可能回它们，判成终态会让材料完好的
 * 账号被标死。
 */
const ACCIO_TERMINAL_REFRESH_MARKERS: readonly string[] = [
  'invalid_grant',
  'invalid refresh token',
  'invalid refresh_token',
  'refresh token has been used',
  'refresh_token has been used',
  'refresh token expired',
  'refresh_token expired',
  'expired refresh token',
  'NOT_LOGIN',
  'not_login',
]

/** 判断一次续期失败是不是**终态**（`refresh_token` 真的不能用了）。 */
export function isAccioTerminalRefreshError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  const lowered = message.toLowerCase()
  return ACCIO_TERMINAL_REFRESH_MARKERS.some((marker) => lowered.includes(marker.toLowerCase()))
}

/**
 * 把外部传入的 region 归一化到白名单（未知值回落 `'cn'`）。
 *
 * ⚠️ `region` 来自客户端自报，未登记的值会被原样写进凭据并决定登录域名 —— 收敛到白名单。
 */
export function normalizeAccioRegion(raw: unknown): AccioRegion {
  return ACCIO_REGIONS.includes(raw as AccioRegion) ? (raw as AccioRegion) : 'cn'
}

/** 从存储值解析凭据 JSON；解析失败返回 undefined。 */
export function parseAccioCredential(value: string): AccioCredential | undefined {
  try {
    const parsed = JSON.parse(value) as AccioCredential
    return typeof parsed === 'object' && parsed !== null && typeof parsed.access_token === 'string'
      ? parsed
      : undefined
  } catch {
    return undefined
  }
}

/**
 * 把**一条**远端目录条目归一化为 `AccioFallbackModel`（与兜底表同形）。
 *
 * ⚠️ `visible !== true` 一律剔除。
 * ⚠️ `supportsImage` 是**二值投影**（`multimodal === true`）—— 表达不了三态里的
 * 「未知」，需要三态的一方（适配器）不得把 `false` 当作「明确不支持」。
 * ⚠️ 档位：`reasoningEfforts` 可能是 `null`（与空数组同样表达「无档位」）；
 * `defaultReasoningEffort` 可在数组为 `null` 时单独存在（实测服务端接受 ⇒ 单档）。
 */
export function normalizeAccioModel(raw: unknown): AccioFallbackModel | undefined {
  if (raw === null || typeof raw !== 'object') return undefined
  const row = raw as Record<string, unknown>
  if (row.visible !== true) return undefined
  const id = typeof row.modelCode === 'string' ? row.modelCode : ''
  if (id === '') return undefined
  const displayName = typeof row.modelDisplayName === 'string' ? row.modelDisplayName : ''
  const contextWindow = typeof row.contextWindow === 'number' && Number.isFinite(row.contextWindow)
    ? row.contextWindow
    : 0
  const multiple = typeof row.effectiveMultiple === 'number' && Number.isFinite(row.effectiveMultiple)
    ? row.effectiveMultiple
    : undefined
  const maxTokens = typeof row.maxTokens === 'number' && Number.isFinite(row.maxTokens)
    ? row.maxTokens
    : undefined
  const efforts = Array.isArray(row.reasoningEfforts)
    ? (row.reasoningEfforts as unknown[]).filter(
        (e): e is string => typeof e === 'string' && e.trim() !== '',
      )
    : []
  const defaultEffort = typeof row.defaultReasoningEffort === 'string'
    && row.defaultReasoningEffort.trim() !== ''
    ? row.defaultReasoningEffort
    : undefined
  return {
    id,
    name: displayName === '' ? id : displayName,
    contextWindow,
    supportsImage: row.multimodal === true,
    ...multiple === undefined ? {} : { multiple },
    ...maxTokens === undefined ? {} : { maxTokens },
    ...efforts.length === 0 ? {} : { efforts },
    ...defaultEffort === undefined ? {} : { defaultEffort },
  }
}

/**
 * 解析 `POST /api/llm/config/v2` 的响应体（`data[].modelList[]`），
 * 按**倍率升序**（便宜在前）返回；无倍率的排最后。
 *
 * ⚠️ 排序必须显式处理「两边都没有倍率」：`(a.multiple ?? Infinity) - (b.multiple ?? Infinity)`
 * 在两者都缺时得到 `NaN`，而比较器返回 `NaN` 是未定义行为。
 */
export function parseAccioCatalog(body: unknown): AccioFallbackModel[] {
  const data = (body as { data?: unknown } | null | undefined)?.data
  if (!Array.isArray(data)) return []
  const models: AccioFallbackModel[] = []
  for (const group of data) {
    const list = (group as { modelList?: unknown } | null | undefined)?.modelList
    if (!Array.isArray(list)) continue
    for (const raw of list) {
      const entry = normalizeAccioModel(raw)
      if (entry !== undefined) models.push(entry)
    }
  }
  return models.sort((a, b) => {
    const left = a.multiple
    const right = b.multiple
    if (left === undefined && right === undefined) return 0
    if (left === undefined) return 1
    if (right === undefined) return -1
    return left - right
  })
}

/**
 * 拉取远端模型目录（`POST /api/llm/config/v2`，token 在 body）。
 *
 * ⚠️ 失败返回空数组（**不抛错**）：目录是展示信息，不该让整个 provider 报错
 * —— 适配器据此回退兜底表。
 */
export async function fetchAccioRemoteModels(
  credential: AccioCredential,
  fetcher: typeof fetch = fetch,
): Promise<AccioFallbackModel[]> {
  try {
    const response = await fetcher(`${ACCIO.gatewayBaseUrl}${ACCIO_CATALOG_PATH}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ token: credential.access_token }),
      signal: AbortSignal.timeout(ACCIO_REQUEST_TIMEOUT_MS),
    })
    if (!response.ok) return []
    return parseAccioCatalog(await response.json() as unknown)
  } catch {
    return []
  }
}
