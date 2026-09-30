/**
 * OpenAI Chat Completions 协议层。
 *
 * 把适配器产出的内部 `StreamChunk` 转成 OpenAI 的 `chat.completion.chunk`
 * （流式）或 `chat.completion`（非流式）。
 *
 * ## 与来源的关系
 *
 * 来源是**消费**方向（`openai-compat.ts` 的 `consumeOpenAiSse`：上游 SSE →
 * 内部 chunk）。这里是**产出**方向（内部 chunk → 对外 SSE），是新增代码，
 * 但 chunk 词汇完全沿用，故两端能对接。
 *
 * ## 字段口径
 *
 * ⚠️ `usage` 的换算必须注意：内部 `inputTokens` 是**未缓存**输入
 * （`TokenUsage` 的注释明确写「counts are DISJOINT」），而 OpenAI 的
 * `prompt_tokens` 是**总**输入。故：
 *
 * ```
 * prompt_tokens = inputTokens + cacheReadTokens + cacheWriteTokens
 * ```
 *
 * 直接用 `inputTokens` 会让命中缓存的请求看起来 prompt 变小，与上游账单对不上。
 */

import type { StreamChunk, TokenUsage } from '../shared/llm.js'

/** 一次请求的元信息（用于填充响应字段）。 */
export interface OpenAiRequestMeta {
  /** 对外模型标识（原样回显给客户端）。 */
  model: string
  /** 是否流式。 */
  stream: boolean
  /** 是否在流末尾附 usage chunk（`stream_options.include_usage`）。 */
  includeUsage: boolean
}

/**
 * 流式转换过程中的观察者。
 *
 * 存在的理由：usage 只在流的**最后一帧**才出现，而调用方（网关）需要在流结束
 * 后拿到它去记用量。若让调用方去解析自己刚写出的 SSE 文本，等于把协议层
 * 的换算逻辑复制一份到网关里，两处口径迟早会分叉（`prompt_tokens` 含不含缓存
 * 就是现成的坑）。因此由协议层在内部顺手上报。
 */
export interface OpenAiStreamObserver {
  /** 内部用量（未经 OpenAI 换算，字段口径与 `TokenUsage` 一致）。 */
  onUsage?(usage: TokenUsage): void
  /** 结束原因（已换算为 OpenAI 的 `finish_reason`）。 */
  onFinish?(reason: string): void
}

/** 生成一个响应 id。 */
function completionId(): string {
  return `chatcmpl-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`
}

/**
 * 把内部 token 用量换算为 OpenAI 口径。
 *
 * ⚠️ `prompt_tokens` 必须包含缓存部分（见文件头说明）。
 */
export function toOpenAiUsage(usage: TokenUsage): Record<string, unknown> {
  const cacheRead = usage.cacheReadTokens ?? 0
  const cacheWrite = usage.cacheWriteTokens ?? 0
  const promptTokens = usage.inputTokens + cacheRead + cacheWrite
  const completionTokens = usage.outputTokens
  return {
    prompt_tokens: promptTokens,
    completion_tokens: completionTokens,
    total_tokens: usage.totalTokens ?? promptTokens + completionTokens,
    // 缓存明细：客户端据此核对「命中了多少」。
    ...cacheRead > 0 || cacheWrite > 0
      ? {
          prompt_tokens_details: {
            cached_tokens: cacheRead,
            ...cacheWrite > 0 ? { cache_write_tokens: cacheWrite } : {},
          },
        }
      : {},
    ...usage.reasoningTokens !== undefined ? { completion_tokens_details: { reasoning_tokens: usage.reasoningTokens } } : {},
  }
}

/** 把内部结束原因映射为 OpenAI 的 `finish_reason`。 */
export function toOpenAiFinishReason(reason: { kind: string }): string {
  switch (reason.kind) {
    case 'stop': return 'stop'
    case 'tool-calls': return 'tool_calls'
    case 'max-tokens': return 'length'
    // `aborted` / `error` 由调用方在此之前抛错，不会走到这里。
    default: return 'stop'
  }
}

/**
 * 把内部 chunk 流转成 OpenAI SSE 行。
 *
 * 产出的每一行都是完整的 `data: {...}\n\n`（含结尾空行），由调用方直接写入
 * 响应流。最后一行是 `data: [DONE]\n\n`。
 *
 * @param chunks - 适配器产出的 chunk 流。
 * @param meta - 请求元信息。
 * @returns SSE 行流（字符串）。
 */
export async function* streamOpenAiSse(
  chunks: AsyncIterable<StreamChunk>,
  meta: OpenAiRequestMeta,
  observer?: OpenAiStreamObserver,
): AsyncGenerator<string> {
  const id = completionId()
  const created = Math.floor(Date.now() / 1000)
  let usage: TokenUsage | undefined
  let finishReason = 'stop'
  let sentRole = false

  /** 包一层 chunk 信封。 */
  const frame = (delta: Record<string, unknown>, extra: Record<string, unknown> = {}): string => {
    const payload = {
      id,
      object: 'chat.completion.chunk',
      created,
      model: meta.model,
      choices: [{ index: 0, delta, finish_reason: null, ...extra }],
    }
    return `data: ${JSON.stringify(payload)}\n\n`
  }

  for await (const chunk of chunks) {
    switch (chunk.type) {
      case 'block-start':
      case 'block-end':
        // OpenAI 协议没有块概念；文本/工具增量已分别下发。
        break
      case 'text-delta': {
        // 首个增量必须带 role，否则部分客户端（含官方 SDK）无法确定消息角色。
        const delta: Record<string, unknown> = { content: chunk.text }
        if (!sentRole) { delta['role'] = 'assistant'; sentRole = true }
        yield frame(delta)
        break
      }
      case 'reasoning-delta': {
        const delta: Record<string, unknown> = { reasoning_content: chunk.text }
        if (!sentRole) { delta['role'] = 'assistant'; sentRole = true }
        yield frame(delta)
        break
      }
      case 'tool-call-delta': {
        const delta: Record<string, unknown> = {
          tool_calls: [{
            index: chunk.index,
            id: chunk.id,
            type: 'function',
            function: {
              // ⚠️ name 只在有值时下发：空串会覆盖客户端已解析出的名字
              // （来源记录过 `unknown tool ""` 的真实缺陷）。
              ...chunk.name !== undefined && chunk.name.length > 0 ? { name: chunk.name } : {},
              arguments: chunk.argumentsDelta,
            },
          }],
        }
        if (!sentRole) { delta['role'] = 'assistant'; sentRole = true }
        yield frame(delta)
        break
      }
      case 'usage':
        usage = chunk.usage
        observer?.onUsage?.(chunk.usage)
        break
      case 'finish':
        if (chunk.reason.kind === 'error') {
          // 终态错误：抛出，由调用方映射为错误响应。
          throw new Error(chunk.reason.failure.message)
        }
        if (chunk.reason.kind === 'aborted') {
          throw new Error(chunk.reason.failure.message)
        }
        finishReason = toOpenAiFinishReason(chunk.reason)
        observer?.onFinish?.(finishReason)
        break
      default:
        break
    }
  }

  // 收尾 chunk：带 finish_reason 与（可选）usage。
  const finalPayload: Record<string, unknown> = {
    id,
    object: 'chat.completion.chunk',
    created,
    model: meta.model,
    choices: [{ index: 0, delta: {}, finish_reason: finishReason }],
    // ⚠️ usage 只在最后一帧带（OpenAI 约定），且需 include_usage 才带。
    ...meta.includeUsage && usage !== undefined ? { usage: toOpenAiUsage(usage) } : {},
  }
  yield `data: ${JSON.stringify(finalPayload)}\n\n`
  yield 'data: [DONE]\n\n'
}

/**
 * 把内部 chunk 流聚合为**非流式** OpenAI 响应体。
 *
 * 文本与思考分别拼接；工具调用按 index 合并（同一次调用的参数分片要拼起来，
 * 且 id/name 只在首次出现时取，避免后续空值覆盖）。
 */
export async function collectOpenAiResponse(
  chunks: AsyncIterable<StreamChunk>,
  meta: OpenAiRequestMeta,
  observer?: OpenAiStreamObserver,
): Promise<Record<string, unknown>> {
  const id = completionId()
  const created = Math.floor(Date.now() / 1000)
  let content = ''
  let reasoning = ''
  let usage: TokenUsage | undefined
  let finishReason = 'stop'
  const toolCalls = new Map<number, { id: string; name: string; arguments: string }>()

  for await (const chunk of chunks) {
    switch (chunk.type) {
      case 'text-delta':
        content += chunk.text
        break
      case 'reasoning-delta':
        reasoning += chunk.text
        break
      case 'tool-call-delta': {
        const existing = toolCalls.get(chunk.index) ?? { id: '', name: '', arguments: '' }
        // ⚠️ id/name 只接受**非空**覆盖：后续分片常带空值，覆盖会把已解析出的
        // 名字清掉（来源记录过 `unknown tool ""` 的会话报废缺陷）。
        if (chunk.id.length > 0) existing.id = chunk.id
        if (chunk.name !== undefined && chunk.name.length > 0) existing.name = chunk.name
        existing.arguments += chunk.argumentsDelta
        toolCalls.set(chunk.index, existing)
        break
      }
      case 'usage':
        usage = chunk.usage
        observer?.onUsage?.(chunk.usage)
        break
      case 'finish':
        if (chunk.reason.kind === 'error') throw new Error(chunk.reason.failure.message)
        if (chunk.reason.kind === 'aborted') throw new Error(chunk.reason.failure.message)
        finishReason = toOpenAiFinishReason(chunk.reason)
        observer?.onFinish?.(finishReason)
        break
      default:
        break
    }
  }

  const message: Record<string, unknown> = { role: 'assistant' }
  // ⚠️ OpenAI 规范：有 tool_calls 且正文为空时 `content` 必须是 `null`，不是空串。
  message['content'] = content.length > 0 ? content : (toolCalls.size > 0 ? null : '')
  if (reasoning.length > 0) message['reasoning_content'] = reasoning
  if (toolCalls.size > 0) {
    message['tool_calls'] = [...toolCalls.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([, call]) => ({
        id: call.id,
        type: 'function',
        function: { name: call.name, arguments: call.arguments.length > 0 ? call.arguments : '{}' },
      }))
  }

  return {
    id,
    object: 'chat.completion',
    created,
    model: meta.model,
    choices: [{ index: 0, message, finish_reason: finishReason }],
    ...usage !== undefined ? { usage: toOpenAiUsage(usage) } : {},
  }
}

/** 构造 `GET /v1/models` 的响应体。 */
export function openAiModelList(
  models: readonly { id: string; name: string; contextWindow?: number; supportsImage: boolean }[],
): Record<string, unknown> {
  return {
    object: 'list',
    data: models.map(model => ({
      id: model.id,
      object: 'model',
      created: 0,
      owned_by: model.id.split('/')[0] ?? 'all-proxy',
      // 展示名与能力放这里：OpenAI 规范允许附加字段，客户端会忽略未知字段。
      name: model.name,
      ...model.contextWindow === undefined ? {} : { context_window: model.contextWindow },
      supports_image: model.supportsImage,
    })),
  }
}
