/**
 * Accio（阿里 Accio Work）LLM 适配器。
 *
 * 移植自来源 `src/accio-adapter.ts`，**改动仅限目录骨架与 DSH 专属机制**：
 * - 来源用 `createModelCatalog` 共享骨架 + `RemoteCatalogGate` + `canonical-models`
 *   （那是**聚合 provider** 的机器）→ 本项目无跨渠道聚合，改为**本文件内**的
 *   远端目录缓存 + 兜底表（与 `officeace-adapter.ts` / `raccoon-adapter.ts` 同形）；
 * - 裁掉 `broadcastCatalogChanged`（本项目无推送式目录广播）、`registerAccioLlm`、
 *   `registerAdapterIdempotent`（本项目注册走 `ProviderRegistry`）、
 *   `reportLedgerAccount`（本项目无 token 账本）；
 * - 协议层（`accio.ts` / `accio-messages.ts` / `accio-oauth.ts`）**逐字保留**。
 *
 * ## 协议要点（原样保留）
 *
 * - **token 必须在 body**（放 `Authorization` 头恒流内 402）；
 * - **`system_instruction` 必须是字符串**（对象形态恒 HTTP 200 + 流内 400）；
 * - **对外 id 是「人话」slug，上行必须反查上游 `modelCode`**（漏映射症状是
 *   「模型不回复」这种误导性形态）；
 * - **HTTP 200 也可能是风控拦截页**（`content-type` 必须校验）；
 * - **工具调用分片**必须先经合并层，且错误帧绝不能被吸收。
 */

import { LlmAdapter, LlmError, ReasoningEffortId } from '../shared/llm.js'
import type {
  GenerateOptions,
  LlmModelInfo,
  LlmProviderInfo,
  LlmResolvedModelInfo,
  StreamChunk,
} from '../shared/llm.js'
import { collectImages } from '../shared/openai-compat.js'
import { normalizeHarnessMessages } from '../shared/message-shape.js'
import { resolveToolPairing } from '../shared/sse.js'
import {
  ACCIO,
  ACCIO_LLM_PATH,
  ACCIO_REQUEST_TIMEOUT_MS,
  type AccioFallbackModel,
  type AccioProduct,
} from './accio-product.js'
import {
  accioHeaders,
  accioRequestId,
  accioSgK,
  buildAccioBody,
  isAccioExpired,
  type AccioCredential,
} from './accio.js'
import { consumeAccioSse, isAccioErrorFrame, serializeAccioMessages, toAccioTools } from './accio-messages.js'
import { normalizeNameKey } from './canonical-models.js'
import type { AccountPool } from '../pool/account-pool.js'

/** 本适配器注册的 provider 路由名。 */
export const PROVIDER = 'accio'

/** SSE 空闲超时（毫秒）。 */
export const ACCIO_SSE_IDLE_TIMEOUT_MS = 120_000

/** 设备标识兜底值（进程内稳定；上游实测不校验它）。 */
const FALLBACK_UTDID = `accio-${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36)}`

/** 展示名：把倍率拼进 `name`（本仓库约定：倍率写 `name`，不写 `description`）。 */
export function displayNameOfAccioModel(model: { name: string; multiple?: number }): string {
  const multiple = model.multiple
  if (multiple === undefined || !Number.isFinite(multiple)) return model.name
  return `${model.name} · x${multiple}`
}

/**
 * 把一个 accio 模型条目映射成**思考档位声明**；无可声明时返回 `undefined`。
 *
 * 三格判据（**顺序不可换**）：
 * | 形态 | 声明 |
 * |---|---|
 * | `efforts` 非空 | 全部档位；`defaultEffort` **落在集合内才带** |
 * | `efforts` 空、`defaultEffort` 有值 | **单档**（用户要求「只有一档也要显示」） |
 * | 两者都无 | **不声明**（不编造） |
 */
export function accioReasoningOf(
  model: Pick<AccioFallbackModel, 'efforts' | 'defaultEffort'>,
): { efforts: { id: ReasoningEffortId; name: string }[]; defaultEffort?: ReasoningEffortId } | undefined {
  const declared = model.efforts ?? []
  const fallback = model.defaultEffort
  if (declared.length > 0) {
    return {
      efforts: declared.map((id) => ({ id: ReasoningEffortId(id), name: id })),
      ...fallback !== undefined && declared.includes(fallback)
        ? { defaultEffort: ReasoningEffortId(fallback) }
        : {},
    }
  }
  if (fallback !== undefined) {
    return {
      efforts: [{ id: ReasoningEffortId(fallback), name: fallback }],
      defaultEffort: ReasoningEffortId(fallback),
    }
  }
  return undefined
}

/**
 * 一个 accio 模型条目的**对外 id**（人话 slug；上游 `modelCode` 不可读）。
 *
 * ⚠️ 归一后为空时**回退原始 id**（空 id 会让目录校验抛 `INVALID_CATALOG`）。
 */
export function accioModelIdOf(model: Pick<AccioFallbackModel, 'id' | 'name'>): string {
  const slug = normalizeNameKey(model.name)
  return slug === '' ? model.id : slug
}

/** 由**对外 slug** 反查上游 `modelCode`；查不到原样返回（不静默改成空模型名）。 */
export function accioModelCodeOf(
  models: readonly Pick<AccioFallbackModel, 'id' | 'name'>[],
  slug: string,
): string {
  const hit = models.find((model) => accioModelIdOf(model) === slug)
  return hit === undefined ? slug : hit.id
}

/** 把内容载荷展平为纯文本（与 `accio-messages.ts` 的 `flattenText` 同口径）。 */
function contentToText(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .filter((block) => (block as { type?: unknown } | undefined)?.type === 'text')
    .map((block) => String((block as { text?: unknown }).text ?? ''))
    .join('')
}

/**
 * 把 **DSH 原生消息块** 转成 `serializeAccioMessages` 认得的 **OpenAI 传输形状**。
 *
 * ⚠️ 必须有这一层：`serializeAccioMessages` 读 `message.tool_calls[]` 与
 * `tool_call_id` / `name`，而 DSH 原生块里这三个字段一个都不存在 ⇒ 工具调用与
 * 工具结果**全字段静默丢失**（Accio 的 `functionResponse` **按 name 配对**，
 * 空 name 等于把工具结果丢掉）。
 */
export function toAccioWireMessages(
  messages: readonly { role: string; content?: unknown }[],
): Array<Record<string, unknown>> {
  const normalized = normalizeHarnessMessages(messages)
  const { keepCallIds, keepResultIds } = resolveToolPairing(normalized)

  const toolNames = new Map<string, string>()
  for (const message of normalized) {
    if (!Array.isArray(message.content)) continue
    for (const block of message.content) {
      const b = block as { type?: unknown; id?: unknown; name?: unknown } | null
      if (b !== null && typeof b === 'object' && b.type === 'tool-call') {
        toolNames.set(String(b.id), String(b.name ?? ''))
      }
    }
  }

  const wire: Array<Record<string, unknown>> = []
  for (const message of normalized) {
    if (message.role === 'assistant') {
      const content = Array.isArray(message.content) ? message.content : []
      const toolCalls = content
        .filter((block): block is { type: string; id: unknown; name: unknown; arguments: unknown } =>
          typeof block === 'object' && block !== null && (block as { type?: unknown }).type === 'tool-call')
        .filter((block) => keepCallIds.has(String(block.id)))
        .map((block) => ({
          id: String(block.id),
          type: 'function' as const,
          function: {
            name: String(block.name),
            arguments: typeof block.arguments === 'string' ? block.arguments : '{}',
          },
        }))
      wire.push({
        role: 'assistant',
        content: contentToText(message.content),
        ...toolCalls.length > 0 ? { tool_calls: toolCalls } : {},
      })
      continue
    }
    if (message.role === 'system') {
      wire.push({ role: 'system', content: contentToText(message.content) })
      continue
    }
    const content = Array.isArray(message.content) ? message.content : []
    const toolResults = content.filter(
      (block): block is { type: string; toolCallId: unknown; content: unknown } =>
        typeof block === 'object' && block !== null && (block as { type?: unknown }).type === 'tool-result',
    )
    const text = contentToText(message.content)
    if (text.length > 0 || toolResults.length === 0) wire.push({ role: 'user', content: text })
    for (const result of toolResults) {
      const id = String(result.toolCallId)
      if (!keepResultIds.has(id)) continue
      wire.push({
        role: 'tool',
        tool_call_id: id,
        name: toolNames.get(id) ?? '',
        content: contentToText(result.content) || '(no output)',
      })
    }
  }
  return wire
}

/** 安全读取 `Error.message`。 */
function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message
  try { return String(error) } catch { return 'unknown error' }
}

/** 传输级错误判定（网络抖动，归可重试的 `TRANSPORT`）。 */
function isTransportError(error: unknown): boolean {
  if (!(error instanceof Error)) return false
  const message = error.message.toLowerCase()
  if (error.name.startsWith('UND_ERR_')) return true
  if (message.includes('fetch failed')) return true
  if (message.includes('terminated') || message.includes('econnreset')) return true
  if (message.includes('epipe') || message.includes('socket hang up')) return true
  return false
}

/**
 * HTTP 状态码 → provider-neutral 错误码。
 *
 * ⚠️ **402 必须归 `QUOTA_EXCEEDED`**（不得归 `SERVER`，那会被原样重发 N 次）。
 */
function httpErrorCode(status: number): string {
  if (status === 401 || status === 403) return 'AUTH'
  if (status === 402) return 'QUOTA_EXCEEDED'
  if (status === 429) return 'RATE_LIMIT'
  if (status === 400) return 'INVALID_REQUEST'
  if (status >= 500) return 'SERVER'
  return `HTTP_${status}`
}

/** 从错误体里抠出可读 detail（**逐字保留服务端原文**，不吞）。 */
function errorDetail(body: string): string {
  try {
    const data = JSON.parse(body) as Record<string, unknown>
    const parts = [
      typeof data.error_code === 'string' || typeof data.error_code === 'number'
        ? `error_code=${String(data.error_code)}` : undefined,
      typeof data.error_message === 'string' ? data.error_message : undefined,
      typeof data.code === 'string' || typeof data.code === 'number' ? `code=${String(data.code)}` : undefined,
      typeof data.message === 'string' ? data.message : undefined,
      typeof data.error === 'string' ? data.error : undefined,
    ].filter((value): value is string => value !== undefined)
    if (parts.length > 0) return parts.join(' ')
  } catch { /* 非 JSON 错误体：原样返回 */ }
  return body
}

/** 把访问令牌写进请求体（**唯一**的 token 落点）。 */
function applyAccessToken(body: Record<string, unknown>, accessToken: string): void {
  body.token = accessToken
}

/**
 * 合并一次工具调用的多个参数分片。
 *
 * 两种形态都处理：**累积式**（后一份以前一份为前缀）⇒ 取最后一份；
 * **增量式**（非前缀）⇒ 依次拼接。
 */
export function mergeAccioToolArgs(fragments: readonly string[]): string {
  const nonEmpty = fragments.filter((fragment) => fragment !== '')
  if (nonEmpty.length === 0) return ''
  let cumulative = true
  for (let i = 1; i < nonEmpty.length; i++) {
    if (!nonEmpty[i]!.startsWith(nonEmpty[i - 1]!)) { cumulative = false; break }
  }
  if (cumulative) return nonEmpty[nonEmpty.length - 1]!
  let merged = ''
  for (const fragment of nonEmpty) {
    merged = fragment.startsWith(merged) ? fragment : merged + fragment
  }
  return merged
}

/** 抽取一帧上的**终帧元数据**（`turn_complete` / `usage_metadata` / `finish_reason`）。 */
function frameMetaOf(frame: unknown): Record<string, unknown> | undefined {
  if (frame === null || typeof frame !== 'object') return undefined
  const f = frame as Record<string, unknown>
  const meta: Record<string, unknown> = {}
  if (f.turn_complete !== undefined) meta.turn_complete = f.turn_complete
  if (f.usage_metadata !== undefined) meta.usage_metadata = f.usage_metadata
  if (f.usageMetadata !== undefined) meta.usageMetadata = f.usageMetadata
  if (f.finish_reason !== undefined) meta.finish_reason = f.finish_reason
  if (f.finishReason !== undefined) meta.finishReason = f.finishReason
  return Object.keys(meta).length > 0 ? meta : undefined
}

/** 从一个 `function_call` 上抽**参数串**（三种形态与 `normalizeAccioPart` 同口径）。 */
function accioArgsTextOf(call: Record<string, unknown>): string {
  const raw = call.args_json ?? call.argsJson
  if (typeof raw === 'string' && raw !== '') return raw
  const obj = call.args
  if (obj !== null && typeof obj === 'object' && !Array.isArray(obj)) {
    try { return JSON.stringify(obj) } catch { return '' }
  }
  return ''
}

/** 取一份 `usage` 上的 **total**（读不到时 `-1`）。 */
function usageTotalOf(u: unknown): number {
  if (u === null || typeof u !== 'object' || Array.isArray(u)) return -1
  const r = u as Record<string, unknown>
  const raw = r.totalTokenCount ?? r.total_token_count
  return typeof raw === 'number' && Number.isFinite(raw) ? raw : -1
}

/** 合并两帧的终帧元数据（usage 取 total 更大者；其余后者覆盖前者）。 */
function mergeFrameMeta(
  prev: Record<string, unknown> | undefined,
  next: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = prev === undefined ? {} : { ...prev }
  for (const [key, value] of Object.entries(next)) {
    if (key === 'usage_metadata' || key === 'usageMetadata') continue
    out[key] = value
  }
  const candidates: unknown[] = [out.usage_metadata, out.usageMetadata, next.usage_metadata, next.usageMetadata]
  delete out.usage_metadata
  delete out.usageMetadata
  let winner: unknown
  for (const c of candidates) {
    if (c === undefined || c === null) continue
    if (winner === undefined || usageTotalOf(c) >= usageTotalOf(winner)) winner = c
  }
  if (winner !== undefined) out.usage_metadata = winner
  return out
}

/**
 * 把 Accio 的**分片**工具调用合并成「一次调用一帧」的 SSE 改写流。
 *
 * 四条纪律：① 只缓冲工具调用 part（非工具 part 原样透传，绝不丢）；
 * ② flush 排在当前行之前；③ 按 `id` 分组；④ 非 `data:` 行原样透传。
 *
 * ⚠️ **错误帧绝不能被吸收**（与 `consumeAccioSse` 的判据同源，复用
 * `isAccioErrorFrame`）：否则额度/认证失败会被反转成「工具调用成功」。
 */
export function accioToolCallMergeTransform(): TransformStream<Uint8Array, Uint8Array> {
  const decoder = new TextDecoder()
  const encoder = new TextEncoder()
  let buffer = ''
  const pending = new Map<string, { id: string; name: string; fragments: string[] }>()
  let pendingMeta: Record<string, unknown> | undefined

  const flushPending = (out: string[]): void => {
    if (pending.size === 0) {
      if (pendingMeta !== undefined) {
        out.push(`data: ${JSON.stringify(pendingMeta)}`)
        pendingMeta = undefined
      }
      return
    }
    const parts: unknown[] = []
    for (const entry of pending.values()) {
      const args = mergeAccioToolArgs(entry.fragments)
      parts.push({
        function_call: {
          id: entry.id,
          name: entry.name,
          ...args === '' ? {} : { args_json: args },
        },
      })
    }
    pending.clear()
    const frame: Record<string, unknown> = {
      content: { role: 'model', parts },
      partial: true,
      ...(pendingMeta !== undefined ? pendingMeta : {}),
    }
    pendingMeta = undefined
    out.push(`data: ${JSON.stringify(frame)}`)
  }

  const anonKey = (): string => {
    let n = pending.size
    while (pending.has(`anon-${n}`)) n++
    return `anon-${n}`
  }

  const absorbCallParts = (callParts: unknown[], meta: Record<string, unknown> | undefined): void => {
    for (const part of callParts) {
      const call = (part as { function_call?: unknown } | null)?.function_call
      if (call === null || typeof call !== 'object' || Array.isArray(call)) continue
      const c = call as Record<string, unknown>
      const id = typeof c.id === 'string' && c.id !== '' ? c.id : anonKey()
      const name = typeof c.name === 'string' ? c.name : ''
      const args = accioArgsTextOf(c)
      const entry = pending.get(id)
      if (entry === undefined) pending.set(id, { id, name, fragments: args === '' ? [] : [args] })
      else {
        if (name !== '') entry.name = name
        if (args !== '') entry.fragments.push(args)
      }
    }
    if (meta !== undefined) pendingMeta = mergeFrameMeta(pendingMeta, meta)
  }

  const handleLine = (line: string, out: string[]): void => {
    if (!line.startsWith('data:')) { out.push(line); return }
    const payload = line.slice(5).trim()
    if (payload === '' || payload === '[DONE]') { flushPending(out); out.push(line); return }
    let parsed: unknown
    try { parsed = JSON.parse(payload) } catch { flushPending(out); out.push(line); return }
    const frame = parsed as { content?: { parts?: unknown }; function_call?: unknown; [key: string]: unknown } | null

    if (isAccioErrorFrame(frame)) { flushPending(out); out.push(line); return }

    const parts = frame?.content?.parts
    const hasPartsArray = Array.isArray(parts)
    const topCall = frame?.function_call ?? frame?.functionCall

    let effectiveLine = line
    if (!hasPartsArray
      && frame !== null && typeof frame === 'object'
      && topCall !== null && typeof topCall === 'object' && !Array.isArray(topCall)
      && !Array.isArray(frame.candidates)) {
      effectiveLine = `data: ${JSON.stringify({
        ...frame,
        content: { role: 'model', parts: [{ function_call: topCall }] },
      })}`
    }
    const meta = frameMetaOf(frame)
    if (effectiveLine !== line) {
      const rewritten = JSON.parse(effectiveLine.slice(5).trim()) as { content?: { parts?: unknown } }
      const rewrittenParts = rewritten.content?.parts
      if (Array.isArray(rewrittenParts)) {
        absorbCallParts(rewrittenParts, meta)
        return
      }
    }
    if (!hasPartsArray) { flushPending(out); out.push(line); return }

    const isCall = (part: unknown): boolean =>
      part !== null && typeof part === 'object'
      && (part as { function_call?: unknown }).function_call !== undefined
    const callParts = (parts as unknown[]).filter(isCall)
    if (callParts.length === 0) { flushPending(out); out.push(line); return }

    const otherParts = (parts as unknown[]).filter((part) => !isCall(part))
    if (otherParts.length > 0) {
      out.push(`data: ${JSON.stringify({ ...frame, content: { ...frame!.content, parts: otherParts } })}`)
    }
    absorbCallParts(callParts, meta)
  }

  return new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      buffer += decoder.decode(chunk, { stream: true })
      const lines = buffer.split('\n')
      buffer = lines.pop() ?? ''
      const out: string[] = []
      for (const line of lines) {
        const trimmedEnd = line.endsWith('\r') ? line.slice(0, -1) : line
        handleLine(trimmedEnd, out)
      }
      if (out.length > 0) controller.enqueue(encoder.encode(`${out.join('\n')}\n`))
    },
    flush(controller) {
      buffer += decoder.decode()
      const out: string[] = []
      if (buffer !== '') handleLine(buffer, out)
      flushPending(out)
      if (out.length > 0) controller.enqueue(encoder.encode(out.join('\n')))
    },
  })
}

/** {@link AccioAdapter} 的构造选项。 */
export interface AccioAdapterOptions {
  /**
   * 解析本轮要用的凭据。
   *
   * ⚠️ 入参是**本轮要用的模型 id**：多账号池的选号会按它过滤限流账号，
   * 传空串会让限流过滤整体短路（与 `TraeAdapterOptions.resolveCredential` 同因）。
   */
  resolveCredential: (modelId?: string) => Promise<AccioCredential | undefined>
  /** 静默续期凭据（过期 / 401 时调用）。 */
  refresh: () => Promise<void>
  /** 动态拉取远端模型目录；失败或未登录时回退 `product.fallbackModels`。 */
  fetchRemoteModels?: () => Promise<AccioFallbackModel[]>
  /** 注入的 fetch（测试用）；缺省全局 `fetch`。 */
  fetchImpl?: typeof fetch
  /** 多账号池（仅用于读模型黑名单）。 */
  accountPool?: AccountPool
  /** 设备标识（`utdid`）；上游实测不校验。 */
  utdid?: string
  /** 产品配置；默认 {@link ACCIO}。 */
  product?: AccioProduct
}

/** Accio 模型适配器。 */
export class AccioAdapter extends LlmAdapter {
  private readonly product: AccioProduct
  private readonly fetchImpl: typeof fetch
  private readonly utdid: string
  /** 远端目录缓存（成功拉取后永久保留）。 */
  private remoteModels: AccioFallbackModel[] | undefined
  /** 目录拉取失败冷却（避免每模型重试放大）。 */
  private catalogFailedAt: number | undefined

  constructor(private readonly options: AccioAdapterOptions) {
    super()
    this.product = options.product ?? ACCIO
    this.fetchImpl = options.fetchImpl ?? fetch
    this.utdid = options.utdid ?? FALLBACK_UTDID
  }

  providerInfo(provider: string): LlmProviderInfo {
    const id = typeof provider === 'string' && provider.length > 0 ? provider : this.product.id
    return { id, name: this.product.displayName }
  }

  /** 本家全部条目（远端优先，未落地时回退兜底表）。 */
  private sourceModels(): readonly AccioFallbackModel[] {
    return this.remoteModels ?? this.product.fallbackModels
  }

  /** 懒加载远端目录（一次；失败冷却 10 分钟内不重试）。 */
  private async ensureRemoteModels(): Promise<void> {
    const fetchRemote = this.options.fetchRemoteModels
    if (this.remoteModels !== undefined || fetchRemote === undefined) return
    const now = Date.now()
    if (this.catalogFailedAt !== undefined && now - this.catalogFailedAt < 10 * 60 * 1000) return
    try {
      const models = await fetchRemote()
      if (models.length > 0) this.remoteModels = models
      else this.catalogFailedAt = Date.now()
    } catch {
      this.catalogFailedAt = Date.now()
    }
  }

  /** 模型 id → 中间条目（含展示名、档位、上下文）。 */
  private entryOf(model: AccioFallbackModel): {
    id: string
    name: string
    bareName: string
    contextWindow?: number
    maxTokens?: number
    reasoning?: ReturnType<typeof accioReasoningOf>
  } {
    return {
      id: accioModelIdOf(model),
      name: displayNameOfAccioModel(model),
      bareName: model.name,
      ...model.contextWindow > 0 ? { contextWindow: model.contextWindow } : {},
      ...model.maxTokens !== undefined && Number.isSafeInteger(model.maxTokens) && model.maxTokens > 0
        ? { maxTokens: model.maxTokens }
        : {},
      ...(() => {
        const reasoning = accioReasoningOf(model)
        return reasoning === undefined ? {} : { reasoning }
      })(),
    }
  }

  /** 全量目录（**不套黑名单**），带最终展示名（含倍率）。 */
  listAllModels(): readonly { id: string; name: string }[] {
    return this.sourceModels().map((model) => ({ id: accioModelIdOf(model), name: displayNameOfAccioModel(model) }))
  }

  async listModels(_provider: string): Promise<readonly LlmModelInfo[]> {
    await this.ensureRemoteModels()
    const disabled = this.options.accountPool?.disabledModelsFor(this.product.id)
    const all = this.sourceModels()
    const listed = disabled === undefined || disabled.size === 0
      ? all
      : all.filter((model) => !disabled.has(accioModelIdOf(model)))
    return listed.map((model) => {
      const entry = this.entryOf(model)
      return {
        provider: this.product.id,
        id: entry.id,
        name: entry.name,
        // ⚠️ **刻意省略 `inputModalities`**（三态里的「未知」）：本 provider 的
        //    图片通路未实测，写 `['text']` 是把「未知」写成「明确不支持」。
        //    代价是图片会走到适配器 ⇒ `stream` 显式抛 `UNSUPPORTED_CONTENT`。
        ...entry.reasoning === undefined ? {} : { reasoning: entry.reasoning },
      } as LlmModelInfo
    })
  }

  async resolveModel(provider: string, model: string, _signal?: AbortSignal): Promise<LlmResolvedModelInfo> {
    await this.ensureRemoteModels()
    const hit = this.sourceModels().find((m) => accioModelIdOf(m) === model)
    const entry = hit === undefined ? undefined : this.entryOf(hit)
    return {
      provider,
      id: model,
      // ⚠️ `resolveModel` 用**不带倍率**的裸名（价格只属于选择列表语境）。
      name: entry?.bareName ?? model,
      // ⚠️ 省略 `inputModalities`（未知，见 listModels）。
      ...entry?.contextWindow !== undefined ? { context: { contextWindow: entry.contextWindow } } : {},
      ...entry?.maxTokens !== undefined ? { defaultMaxTokens: entry.maxTokens } : {},
      ...entry?.reasoning === undefined ? {} : { reasoning: entry.reasoning },
    }
  }

  async prepareCall(provider: string, model: string, signal?: AbortSignal): Promise<{
    model: LlmResolvedModelInfo
    stream: (options: GenerateOptions) => AsyncIterable<StreamChunk>
  }> {
    return {
      model: await this.resolveModel(provider, model, signal),
      stream: (options: GenerateOptions) => this.stream(options),
    }
  }

  async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    // 1. 图片：本 provider 的通路**未实测**，故 `inputModalities` 是省略（未知）
    //    ⇒ 图片会走到这里。**必须显式报错**（静默放行 = 静默丢图）。
    //    ⚠️ 扫描**递归**（工具结果内层也可内嵌图片）。
    const imageRefs = new Map<string, unknown>()
    for (const message of options.messages) {
      if (Array.isArray(message.content)) collectImages(message.content, imageRefs)
    }
    if (imageRefs.size > 0) {
      throw new LlmError('accio: 本 provider 的图片通路尚未实测，暂不支持图片输入', 'UNSUPPORTED_CONTENT')
    }

    // 1b. ⚠️ `options.model` 是「人话」slug，上行 body 必须用上游 `modelCode`。
    //     漏了这一步的症状是「模型不回复」（不是参数错误）—— 功能承重，不是装饰。
    await this.ensureRemoteModels()
    const wireModel = accioModelCodeOf(this.sourceModels(), options.model)

    // 2. 凭据（过期则先静默续期）。传 `options.model` 让选号器过滤限流账号。
    let credential = await this.options.resolveCredential(options.model)
    if (credential === undefined || isAccioExpired(credential)) {
      await this.options.refresh()
      credential = await this.options.resolveCredential(options.model)
    }
    if (credential === undefined || credential.access_token === '') {
      throw new LlmError('accio: no usable credential; log in first', 'MISSING_CREDENTIAL')
    }

    // 3. 构造信封。必须先经 `toAccioWireMessages`（原生块 → OpenAI 传输形状）。
    const requestId = accioRequestId()
    const wireMessages = toAccioWireMessages(
      options.messages as unknown as readonly { role: string; content?: unknown }[],
    )
    // ⚠️ `options.system` 是独立字段，不在 `messages` 里；不显式插进去会被整体静默丢弃。
    if (options.system !== undefined && options.system !== '') {
      wireMessages.unshift({ role: 'system', content: options.system })
    }
    const { contents, systemInstruction } = serializeAccioMessages(wireMessages)
    const body = buildAccioBody({
      model: wireModel,
      accessToken: credential.access_token,
      contents,
      systemInstruction,
      tools: toAccioTools((options.tools ?? []).map((tool) => ({
        type: 'function' as const,
        function: { name: tool.name, description: tool.description, parameters: tool.parameters },
      }))),
      ...options.temperature === undefined ? {} : { temperature: options.temperature },
      ...options.maxTokens === undefined ? {} : { maxOutputTokens: options.maxTokens },
      utdid: this.utdid,
      requestId,
    })
    // ⚠️ `system_instruction` 必须是**字符串**（对象形态恒 HTTP 200 + 流内 400）。
    if (systemInstruction !== '') body.system_instruction = systemInstruction
    else delete body.system_instruction
    if (options.stop !== undefined && options.stop.length > 0) body.stop_sequences = options.stop

    // 4. 发送（401/403 时刷新一次凭据后重试一次）。
    //    ⚠️ 重试前必须把**新令牌**写回 body（令牌在 body.token 里）。
    applyAccessToken(body, credential.access_token)
    let response = await this.send(credential, body, options)
    if (!response.ok && (response.status === 401 || response.status === 403)) {
      await this.options.refresh()
      const refreshed = await this.options.resolveCredential(options.model)
      if (refreshed === undefined || refreshed.access_token === '') {
        throw new LlmError('accio: credential expired and refresh failed', 'AUTH', { status: response.status })
      }
      credential = refreshed
      applyAccessToken(body, credential.access_token)
      response = await this.send(credential, body, options)
    }
    if (!response.ok) {
      const text = await response.text().catch(() => '')
      throw new LlmError(`accio: ${errorDetail(text)}`, httpErrorCode(response.status), { status: response.status })
    }
    if (response.body === null) {
      throw new LlmError('accio: empty model response body', 'EMPTY_RESPONSE')
    }
    // ⚠️ 必须校验 `content-type`：HTTP 200 也可能是风控拦截页（HTML）⇒ 不校验会
    //    被喂给 SSE 解析器、报「模型未返回任何内容块」，真因（风控）完全被掩盖。
    const contentType = response.headers.get('content-type') ?? ''
    if (!contentType.includes('text/event-stream')) {
      const peek = await response.text().catch(() => '')
      throw new LlmError(
        `accio: 上游未返回事件流（content-type: ${contentType || '(空)'}）——`
        + `通常是被风控拦截（网关返回 200 + HTML 拦截页）。`
        + `${peek === '' ? '' : ` 服务端原文：${peek.slice(0, 200)}`}`,
        'SERVER',
        { status: response.status },
      )
    }

    // 5. 消费 SSE。工具调用分片先经合并层；流内错误由 `consumeAccioSse` 抛（HTTP 仍 200）。
    const merged = response.body.pipeThrough(accioToolCallMergeTransform())
    yield* consumeAccioSse({
      body: merged,
      ...options.signal === undefined ? {} : { signal: options.signal },
      idleTimeoutMs: ACCIO_SSE_IDLE_TIMEOUT_MS,
    })
  }

  /** 发起一次推理请求；网络失败映射为可重试的 `TRANSPORT`。 */
  private async send(
    credential: AccioCredential,
    body: Record<string, unknown>,
    options: GenerateOptions,
  ): Promise<Response> {
    const requestId = String(body.request_id)
    const url = `${this.product.gatewayBaseUrl}${ACCIO_LLM_PATH}?sg_k=${accioSgK(requestId)}`
    const headers = accioHeaders({
      utdid: this.utdid,
      ...credential.sgcookie === undefined ? {} : { sgcookie: credential.sgcookie },
    })
    try {
      return await this.fetchImpl(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: options.signal ?? AbortSignal.timeout(ACCIO_REQUEST_TIMEOUT_MS),
      })
    } catch (error) {
      if (options.signal?.aborted) throw error
      if (isTransportError(error)) {
        throw new LlmError(`accio: transport error: ${errorMessage(error)}`, 'TRANSPORT', {
          cause: error as Error,
        })
      }
      throw error
    }
  }
}
