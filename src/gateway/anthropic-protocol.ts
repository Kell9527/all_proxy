/**
 * Anthropic Messages 协议层（双向翻译）。
 *
 * 10 个上游 provider 没有一个是 Anthropic 原生的（design D5），因此
 * `POST /v1/messages` 由本服务**完整翻译**：
 *
 * - **请求侧**：Anthropic 请求体 → 内部消息（OpenAI 形状，即适配器消费的词汇）；
 * - **响应侧**：内部 `StreamChunk` → Anthropic 响应体 / SSE 事件序列。
 *
 * ## 翻译要点（规格 `gateway-api`，实现时不得简化）
 *
 * 1. 顶层 `system`（字符串或内容块数组）必须映射为**上游 system 消息**，
 *    而不是用户消息 —— 它承载的是指令，角色错了模型行为会漂移。
 * 2. SSE 必须按 `message_start → content_block_start → content_block_delta →
 *    content_block_stop → message_delta → message_stop` 输出且带 `event:` 行。
 * 3. 工具调用用 `tool_use` 块表达；历史里的 `tool_result` 要翻回上游的
 *    `role:'tool'` 消息（内部词汇），否则适配器无从关联工具输出与调用。
 * 4. 错误必须是 Anthropic 信封 `{"type":"error","error":{...}}`。
 *
 * ## 已知取舍
 *
 * `message_start` 里的 `usage.input_tokens` 固定为 0：SSE 顺序要求它在任何
 * chunk 之前发出，而 input token 要等上游的 usage 帧才可知。真实的 input
 * 计数最终体现在用量库里；`message_delta` 的 `output_tokens` 是准确的。
 */

import type { RequestMessage, StreamChunk, TokenUsage, ToolSchema } from '../shared/llm.js'
import { readSystemText } from '../shared/message-shape.js'
import type { OpenAiStreamObserver } from './openai-protocol.js'
import type { GatewayError } from './errors.js'

// ───────────────────────── 请求侧：Anthropic → 内部 ─────────────────────────

/** 请求翻译结果（可直接交给适配器的入参碎片）。 */
export interface AnthropicRequestTranslation {
  /** 顶层 system 参数（已把内容块数组拼成文本）。 */
  system?: string
  /** 内部消息序列（OpenAI 形状词汇）。 */
  messages: RequestMessage[]
  maxTokens?: number
  temperature?: number
  stop?: string[]
  tools?: ToolSchema[]
}

/**
 * 翻译 Anthropic Messages 请求体。
 *
 * 结构性错误（缺 `messages` 等）返回 `ok: false`，由调用方映射为 400。
 */
export function translateAnthropicRequest(
  body: Record<string, unknown>,
): { ok: true; value: AnthropicRequestTranslation } | { ok: false; message: string } {
  const rawMessages = body['messages']
  if (!Array.isArray(rawMessages)) return { ok: false, message: 'messages 必须是数组' }

  const translation: AnthropicRequestTranslation = { messages: [] }

  // ── system（规格要点 1）：字符串或内容块数组，都归为上游 system 文本。 ──
  // 用共享的 `readSystemText` 而非在此另写一份：OpenAI 入站分支需要**同一口径**
  // 的解析（真实缺陷 2026-09-29 —— 它当时只认字符串，数组 system 被静默丢弃，
  // 导致 WorkBuddy 因首条非 system 报 400 code 11128）。两处共用可杜绝再分叉。
  const system = readSystemText(body['system'])
  if (system !== undefined) translation.system = system

  if (typeof body['max_tokens'] === 'number' && Number.isFinite(body['max_tokens']) && body['max_tokens'] > 0) {
    translation.maxTokens = body['max_tokens']
  }
  if (typeof body['temperature'] === 'number' && Number.isFinite(body['temperature'])) {
    translation.temperature = body['temperature']
  }
  if (Array.isArray(body['stop_sequences'])) {
    const stops = (body['stop_sequences'] as unknown[]).filter((s): s is string => typeof s === 'string')
    if (stops.length > 0) translation.stop = stops
  }

  // ── tools：Anthropic 的 `input_schema` → 内部的 `parameters`。 ──
  if (Array.isArray(body['tools'])) {
    translation.tools = (body['tools'] as Array<Record<string, unknown>>).flatMap(tool => {
      if (typeof tool['name'] !== 'string' || tool['name'].length === 0) return []
      return [{
        name: tool['name'],
        description: typeof tool['description'] === 'string' ? tool['description'] : '',
        parameters: typeof tool['input_schema'] === 'object' && tool['input_schema'] !== null
          ? tool['input_schema'] as Record<string, unknown>
          : { type: 'object', properties: {} },
      }]
    })
  }

  // ── messages：逐条翻译。 ──
  for (const raw of rawMessages) {
    if (typeof raw !== 'object' || raw === null) continue
    const message = raw as Record<string, unknown>
    const role = message['role'] === 'assistant' ? 'assistant' : 'user'
    const content = message['content']

    // 纯字符串 content：两种角色都原样透传。
    if (typeof content === 'string') {
      translation.messages.push({ role, content })
      continue
    }
    if (!Array.isArray(content)) {
      translation.messages.push({ role, content: '' })
      continue
    }

    if (role === 'assistant') {
      translateAssistantContent(translation.messages, content)
    } else {
      translateUserContent(translation.messages, content)
    }
  }

  return { ok: true, value: translation }
}

/**
 * assistant 消息：`text` 块 → content 文本；`tool_use` 块 → `tool_calls`；
 * `thinking` 块丢弃（历史思考不下发，上游自己管理推理）。
 */
function translateAssistantContent(out: RequestMessage[], content: unknown[]): void {
  let text = ''
  const toolCalls: Array<Record<string, unknown>> = []
  for (const raw of content) {
    if (typeof raw !== 'object' || raw === null) continue
    const block = raw as Record<string, unknown>
    switch (block['type']) {
      case 'text':
        if (typeof block['text'] === 'string') text += block['text']
        break
      case 'tool_use': {
        const input = block['input']
        toolCalls.push({
          id: typeof block['id'] === 'string' ? block['id'] : `toolu_${toolCalls.length}`,
          type: 'function',
          function: {
            name: typeof block['name'] === 'string' ? block['name'] : '',
            arguments: JSON.stringify(input ?? {}),
          },
        })
        break
      }
      default:
        break
    }
  }
  out.push({
    role: 'assistant',
    // ⚠️ OpenAI 规范：有 tool_calls 且正文为空时 content 为 `null`，不是空串。
    content: text.length > 0 ? text : (toolCalls.length > 0 ? null : ''),
    ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
  })
}

/**
 * user 消息：`text` / `image` 块累积为 user 消息；`tool_result` 块拆成
 * **独立的** `role:'tool'` 消息（内部词汇是一等工具结果消息，
 * `toolCallId` 在顶层，由 `normalizeHarnessMessages` 统一降级）。
 *
 * 顺序敏感：`text → tool_result → text` 的 user 消息要翻成
 * `user → tool → user` 三条，不能把工具结果并进文本消息。
 */
function translateUserContent(out: RequestMessage[], content: unknown[]): void {
  let pending: Array<Record<string, unknown>> = []
  const flush = (): void => {
    if (pending.length > 0) {
      out.push({ role: 'user', content: pending })
      pending = []
    }
  }
  for (const raw of content) {
    if (typeof raw !== 'object' || raw === null) continue
    const block = raw as Record<string, unknown>
    switch (block['type']) {
      case 'text':
        pending.push({ type: 'text', text: typeof block['text'] === 'string' ? block['text'] : '' })
        break
      case 'image': {
        const url = imageSourceToUrl(block['source'])
        if (url !== undefined) pending.push({ type: 'image_url', image_url: { url } })
        break
      }
      case 'tool_result': {
        // 先把已积累的文本/图片冲成一条 user 消息，保证工具结果的位置正确。
        flush()
        const toolMessage: RequestMessage = {
          role: 'tool',
          content: toolResultToText(block['content']),
          toolCallId: block['tool_use_id'],
        }
        if (block['is_error'] === true) toolMessage.isError = true
        out.push(toolMessage)
        break
      }
      default:
        break
    }
  }
  flush()
}

/** Anthropic 图片 source → data URL / http URL（内部词汇是 OpenAI 的 `image_url`）。 */
function imageSourceToUrl(source: unknown): string | undefined {
  if (typeof source !== 'object' || source === null) return undefined
  const s = source as Record<string, unknown>
  if (s['type'] === 'base64' && typeof s['media_type'] === 'string' && typeof s['data'] === 'string') {
    return `data:${s['media_type']};base64,${s['data']}`
  }
  if (s['type'] === 'url' && typeof s['url'] === 'string') return s['url']
  return undefined
}

/**
 * 工具结果内容 → 文本（内部 `role:'tool'` 消息的 content 是字符串）。
 *
 * 字符串原样；数组取 text 块拼接、其余块序列化保留信息；其他类型 JSON 化。
 */
function toolResultToText(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content.map(block => {
      if (typeof block === 'object' && block !== null && (block as Record<string, unknown>)['type'] === 'text') {
        const text = (block as Record<string, unknown>)['text']
        return typeof text === 'string' ? text : ''
      }
      return JSON.stringify(block)
    }).filter(part => part.length > 0).join('\n')
  }
  if (content === null || content === undefined) return ''
  return JSON.stringify(content)
}

// ───────────────────────── 响应侧：内部 → Anthropic ─────────────────────────

/** 响应侧元信息。 */
export interface AnthropicResponseMeta {
  /** 对外模型标识（原样回显）。 */
  model: string
}

/** 内部结束原因 → Anthropic `stop_reason`。 */
export function toAnthropicStopReason(kind: string): string {
  switch (kind) {
    case 'tool-calls': return 'tool_use'
    case 'max-tokens': return 'max_tokens'
    default: return 'end_turn'
  }
}

/** 生成一个响应 id。 */
function messageId(): string {
  return `msg_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`
}

/**
 * 内部用量 → Anthropic 口径。
 *
 * 与 OpenAI 侧相反，Anthropic 的 `input_tokens` **不含**缓存（与内部
 * `TokenUsage.inputTokens` 同为未缓存输入），缓存单独成字段 —— 口径恰好一致，
 * 直接透传即可。
 */
function toAnthropicUsage(usage: TokenUsage): Record<string, unknown> {
  const cacheRead = usage.cacheReadTokens ?? 0
  const cacheWrite = usage.cacheWriteTokens ?? 0
  return {
    input_tokens: usage.inputTokens,
    output_tokens: usage.outputTokens,
    ...(cacheRead > 0 ? { cache_read_input_tokens: cacheRead } : {}),
    ...(cacheWrite > 0 ? { cache_creation_input_tokens: cacheWrite } : {}),
  }
}

/** 一段按顺序累积的输出（文本 / 思考 / 工具调用）。 */
interface OutputSegment {
  kind: 'text' | 'thinking' | 'tool'
  text: string
  /** 仅 tool：上游调用标识与名字。 */
  id: string
  name: string
  /** 仅 tool：参数 JSON 分片的累计。 */
  json: string
  /** 仅 tool：内部流的调用序号（分片合并键）。 */
  toolIndex: number
}

/** 把内部 chunk 流聚合为**非流式** Anthropic 响应体。 */
export async function collectAnthropicResponse(
  chunks: AsyncIterable<StreamChunk>,
  meta: AnthropicResponseMeta,
  observer?: OpenAiStreamObserver,
): Promise<Record<string, unknown>> {
  const segments: OutputSegment[] = []
  let usage: TokenUsage | undefined
  let stopReason = 'end_turn'

  /** 把文本追加到最后一个同种类段（种类变化或工具分片另开新段）。 */
  const appendText = (kind: OutputSegment['kind'], text: string): void => {
    const last = segments[segments.length - 1]
    if (last !== undefined && last.kind === kind && kind !== 'tool') {
      last.text += text
      return
    }
    segments.push({ kind, text, id: '', name: '', json: '', toolIndex: -1 })
  }

  for await (const chunk of chunks) {
    switch (chunk.type) {
      case 'text-delta':
        appendText('text', chunk.text)
        break
      case 'reasoning-delta':
        appendText('thinking', chunk.text)
        break
      case 'tool-call-delta': {
        let seg = segments.find(s => s.kind === 'tool' && s.toolIndex === chunk.index)
        if (seg === undefined) {
          seg = { kind: 'tool', text: '', id: '', name: '', json: '', toolIndex: chunk.index }
          segments.push(seg)
        }
        // ⚠️ id/name 只接受非空覆盖（后续分片常带空值，会清掉已解析的名字）。
        if (chunk.id.length > 0) seg.id = chunk.id
        if (chunk.name !== undefined && chunk.name.length > 0) seg.name = chunk.name
        seg.json += chunk.argumentsDelta
        break
      }
      case 'usage':
        usage = chunk.usage
        observer?.onUsage?.(chunk.usage)
        break
      case 'finish':
        if (chunk.reason.kind === 'error') throw new Error(chunk.reason.failure.message)
        if (chunk.reason.kind === 'aborted') throw new Error(chunk.reason.failure.message)
        stopReason = toAnthropicStopReason(chunk.reason.kind)
        observer?.onFinish?.(stopReason)
        break
      default:
        break
    }
  }

  const content = segmentsToContent(segments)
  return {
    id: messageId(),
    type: 'message',
    role: 'assistant',
    model: meta.model,
    content,
    stop_reason: stopReason,
    stop_sequence: null,
    usage: toAnthropicUsage(usage ?? { inputTokens: 0, outputTokens: 0 }),
  }
}

/** 累积段 → Anthropic content 块数组。 */
function segmentsToContent(segments: readonly OutputSegment[]): Array<Record<string, unknown>> {
  const content: Array<Record<string, unknown>> = []
  for (const seg of segments) {
    if (seg.kind === 'tool') {
      content.push({
        type: 'tool_use',
        id: seg.id.length > 0 ? seg.id : `toolu_${seg.toolIndex}`,
        name: seg.name,
        // 参数解析失败时给空对象：工具调用本身仍可被客户端识别。
        input: safeParseObject(seg.json),
      })
      continue
    }
    if (seg.text.length === 0) continue
    if (seg.kind === 'thinking') {
      content.push({ type: 'thinking', thinking: seg.text })
    } else {
      content.push({ type: 'text', text: seg.text })
    }
  }
  return content
}

/** 解析参数 JSON；失败回退空对象。 */
function safeParseObject(text: string): Record<string, unknown> {
  const trimmed = text.trim()
  if (trimmed.length === 0) return {}
  try {
    const parsed: unknown = JSON.parse(trimmed)
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>
    }
    return {}
  } catch {
    return {}
  }
}

/**
 * 把内部 chunk 流转成 Anthropic SSE 事件流。
 *
 * 每一帧都带 `event:` 行（规格要点 2）。块边界由本函数自行管理：
 * 文本 / 思考 / 工具调用各自占据一个 `content_block`，`index` 单调递增。
 */
export async function* streamAnthropicSse(
  chunks: AsyncIterable<StreamChunk>,
  meta: AnthropicResponseMeta,
  observer?: OpenAiStreamObserver,
): AsyncGenerator<string> {
  const id = messageId()
  let usage: TokenUsage | undefined
  let stopReason = 'end_turn'

  const emit = (event: string, data: Record<string, unknown>): string =>
    `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`

  yield emit('message_start', {
    type: 'message_start',
    message: {
      id,
      type: 'message',
      role: 'assistant',
      model: meta.model,
      content: [],
      stop_reason: null,
      stop_sequence: null,
      // 已知取舍：input 要等上游 usage 帧才可知，而 message_start 必须先发。
      usage: { input_tokens: 0, output_tokens: 0 },
    },
  })

  let nextIndex = 0
  /** 当前打开的 content_block（同一时刻至多一个）。 */
  let open: { index: number; kind: 'text' | 'thinking' | 'tool'; toolIndex: number } | null = null

  for await (const chunk of chunks) {
    switch (chunk.type) {
      case 'text-delta':
      case 'reasoning-delta': {
        const kind = chunk.type === 'text-delta' ? 'text' : 'thinking'
        if (open === null || open.kind !== kind) {
          if (open !== null) {
            yield emit('content_block_stop', { type: 'content_block_stop', index: open.index })
          }
          const index = nextIndex++
          open = { index, kind, toolIndex: -1 }
          yield emit('content_block_start', {
            type: 'content_block_start',
            index,
            content_block: kind === 'text' ? { type: 'text', text: '' } : { type: 'thinking', thinking: '' },
          })
        }
        yield emit('content_block_delta', {
          type: 'content_block_delta',
          index: open.index,
          delta: kind === 'text'
            ? { type: 'text_delta', text: (chunk as { text: string }).text }
            : { type: 'thinking_delta', thinking: (chunk as { text: string }).text },
        })
        break
      }
      case 'tool-call-delta': {
        if (open === null || open.kind !== 'tool' || open.toolIndex !== chunk.index) {
          if (open !== null) {
            yield emit('content_block_stop', { type: 'content_block_stop', index: open.index })
          }
          const index = nextIndex++
          open = { index, kind: 'tool', toolIndex: chunk.index }
          yield emit('content_block_start', {
            type: 'content_block_start',
            index,
            content_block: {
              type: 'tool_use',
              // 分片 id 缺失时用序号兜底（与内部流的合并序号一致）。
              id: chunk.id.length > 0 ? chunk.id : `toolu_${chunk.index}`,
              name: chunk.name ?? '',
              input: {},
            },
          })
        }
        if (chunk.argumentsDelta.length > 0) {
          yield emit('content_block_delta', {
            type: 'content_block_delta',
            index: open.index,
            delta: { type: 'input_json_delta', partial_json: chunk.argumentsDelta },
          })
        }
        break
      }
      case 'usage':
        usage = chunk.usage
        observer?.onUsage?.(chunk.usage)
        break
      case 'finish':
        if (chunk.reason.kind === 'error') throw new Error(chunk.reason.failure.message)
        if (chunk.reason.kind === 'aborted') throw new Error(chunk.reason.failure.message)
        stopReason = toAnthropicStopReason(chunk.reason.kind)
        observer?.onFinish?.(stopReason)
        break
      default:
        break
    }
  }

  // 收尾：关闭打开的块 → message_delta（stop_reason + output_tokens）→ message_stop。
  if (open !== null) {
    yield emit('content_block_stop', { type: 'content_block_stop', index: open.index })
  }
  yield emit('message_delta', {
    type: 'message_delta',
    delta: { stop_reason: stopReason, stop_sequence: null },
    usage: { output_tokens: usage?.outputTokens ?? 0 },
  })
  yield emit('message_stop', { type: 'message_stop' })
}

// ───────────────────────── 错误信封（规格要点 4） ─────────────────────────

/** 对外错误码 → Anthropic `error.type`。 */
export function toAnthropicErrorType(code: GatewayError['code']): string {
  switch (code) {
    case 'invalid_api_key':
    case 'authentication_error':
      return 'authentication_error'
    case 'model_not_found':
      return 'not_found_error'
    case 'model_not_authorized':
      return 'permission_error'
    case 'rate_limit_exceeded':
    case 'quota_exceeded':
      return 'rate_limit_error'
    case 'invalid_request_error':
      return 'invalid_request_error'
    default:
      // upstream_error / upstream_timeout / no_available_account / internal_error
      // 都是「服务端侧的问题」，归 api_error。
      return 'api_error'
  }
}

/** 构造 Anthropic 错误信封（**不是** OpenAI 的 `{"error":{...}}`）。 */
export function anthropicErrorBody(error: GatewayError): Record<string, unknown> {
  return {
    type: 'error',
    error: {
      type: toAnthropicErrorType(error.code),
      message: error.message,
    },
  }
}
