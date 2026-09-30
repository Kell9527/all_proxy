/**
 * 本地 LLM 词汇表：替代 DSH 的 `@deepseek-ai/dsh-llm`。
 *
 * ## 为什么需要这个模块
 *
 * 本项目从 DSH 插件移植协议实现。被移植的适配器只依赖 DSH 的 **6 个值符号**
 * 与若干类型（`LlmAdapter` / `LlmError` / `ToolCallId` / `attributionHeaders` /
 * `ReasoningEffortId` / `CONTEXT_WINDOW_EXCEEDED_CODE` 等）。为了让那些适配器
 * **只改 import 行**即可在独立服务里运行，这里提供一套语义等价的本地实现。
 *
 * ⚠️ **不要在这里「顺手重构」**：适配器里有大量行为已由来源仓库的单测与线上
 * 流量验证。本模块的职责只是让它们的依赖可用，而不是改变它们的行为。
 *
 * ## 与 DSH 的有意差异
 *
 * 1. **`attributionHeaders` 的 User-Agent 是 all_proxy 自己的**，不是 DSH 的
 *    `deepseek-harness/...`。本项目是独立产品，向厂商归因时报自己的身份才正确；
 *    且适配器会用 `headers.set('User-Agent', ...)` 按产品/模型族覆盖它。
 * 2. **不实现 `providerRetryPolicy` / `imageRequestPricing`**：这两个方法在本
 *    项目的调用方（网关自身）不存在。来源的 8 个适配器本来也没实现它们。
 * 3. **`prepareCall` 保留**：来源适配器用它把「模型解析」与「流式分发」绑定到
 *    同一代适配器状态（Qoder 等动态适配器依赖这一点），故必须保留。
 */

/** 模型输入模态。 */
export type ModelModality = 'text' | 'image'

/**
 * 工具调用 id。
 *
 * DSH 里它是 branded string（编译期品牌，运行时就是字符串）。本项目同样只在
 * 类型层面区分，运行时保持字符串 —— 这样 `String(id)`、`Set<string>` 等既有
 * 用法逐字节不变。
 */
export type ToolCallId = string & { readonly __brand?: 'ToolCallId' }

/** 把字符串标记为工具调用 id（运行时是恒等函数）。 */
export function ToolCallId(id: string): ToolCallId {
  return id as ToolCallId
}

/** 适配器自有的推理档位标识。 */
export type ReasoningEffortId = string & { readonly __brand?: 'ReasoningEffortId' }

/** 把字符串标记为推理档位标识（运行时是恒等函数）。 */
export function ReasoningEffortId(id: string): ReasoningEffortId {
  return id as ReasoningEffortId
}

/** 会话标识。 */
export type SessionId = string & { readonly __brand?: 'SessionId' }

/** 内容块：只声明适配器实际消费的字段，其余字段按索引签名透传。 */
export interface ContentBlockLike {
  type: string
  [key: string]: unknown
}

/** 消息：角色 + 内容 + 工具结果所需的顶层字段。 */
export interface RequestMessage {
  role: string
  content: unknown
  /** 一等工具结果消息的顶层字段。 */
  toolCallId?: unknown
  isError?: unknown
  [key: string]: unknown
}

/** 工具 schema（发往上游的 `tools`）。 */
export interface ToolSchema {
  name: string
  description: string
  parameters: Record<string, unknown>
  deferLoading?: true
}

/** 结束原因。与 DSH 同形：`kind` 判别 + 失败详情。 */
export type FinishReason =
  | { kind: 'stop' }
  | { kind: 'tool-calls' }
  | { kind: 'max-tokens' }
  | { kind: 'aborted'; failure: LlmFailure }
  | { kind: 'error'; failure: LlmFailure }

/** 可序列化的失败事实。 */
export interface LlmFailure {
  readonly message: string
  readonly code: string
  readonly status?: number
  readonly providerRetryAfterMs?: number
  readonly requestId?: string
  readonly offloadImages?: number
}

/** token 用量（字段口径与 DSH 一致：input 为**未缓存**部分）。 */
export interface TokenUsage {
  inputTokens: number
  outputTokens: number
  totalTokens?: number
  cacheReadTokens?: number
  cacheWriteTokens?: number
  reasoningTokens?: number
}

/** 适配器产出的流式 chunk。 */
export type StreamChunk =
  | { type: 'block-start'; index: number; blockType: string }
  | { type: 'text-delta'; index: number; text: string }
  | { type: 'reasoning-delta'; index: number; text: string }
  | { type: 'tool-call-delta'; index: number; id: ToolCallId; name?: string; argumentsDelta: string }
  | { type: 'block-end'; index: number; block: ContentBlockLike }
  | { type: 'usage'; usage: TokenUsage }
  | { type: 'finish'; reason: FinishReason }

/** 一次模型请求的完整入参。 */
export interface GenerateOptions {
  provider: string
  model: string
  reasoningEffort?: ReasoningEffortId
  messages: RequestMessage[]
  system?: string
  tools?: ToolSchema[]
  temperature?: number
  maxTokens?: number
  stop?: string[]
  signal?: AbortSignal
  sessionId?: SessionId
  purpose?: string
}

/** 一个 provider 路由的展示元数据。 */
export interface LlmProviderInfo {
  id: string
  name: string
}

/** 目录里的一个模型条目。 */
export interface LlmModelInfo {
  provider: string
  id: string
  name: string
  description?: string
  inputModalities?: readonly ModelModality[]
}

/** provider 自有的上下文容量。 */
export interface LlmModelContext {
  contextWindow: number
}

/** 一个档位的展示元数据。 */
export interface LlmReasoningEffortInfo {
  id: ReasoningEffortId
  name: string
  description?: string
}

/** 某个模型可选的全部档位。 */
export interface LlmModelReasoningInfo {
  efforts: readonly LlmReasoningEffortInfo[]
  defaultEffort?: ReasoningEffortId
}

/** 精确到 provider/model 的解析结果。 */
export interface LlmResolvedModelInfo extends LlmModelInfo {
  context?: LlmModelContext
  defaultMaxTokens?: number
  reasoning?: LlmModelReasoningInfo
}

/** `prepareCall` 的返回：模型元数据 + 单代流式入口。 */
export interface PreparedAdapterCall {
  readonly model: LlmResolvedModelInfo
  stream(options: GenerateOptions): AsyncIterable<StreamChunk>
}

/** `LlmError` 的可选附加事实。 */
export interface LlmErrorOptions extends ErrorOptions {
  /** provider 边界观察到的 HTTP 状态。 */
  status?: number
  /** provider 要求的正延迟（毫秒）。 */
  providerRetryAfterMs?: number
  /** provider 签发的不透明请求 id。 */
  requestId?: string
  /** 需要额外卸载的图片出现次数（仅 `IMAGE_OFFLOAD_REQUIRED` 使用）。 */
  offloadImages?: number
}

/**
 * LLM 相关失败的带类型错误。
 *
 * `code` 是稳定的、provider 中立的机器可读码（如 `AUTH` / `QUOTA_EXCEEDED` /
 * `TIMEOUT` / `TRANSPORT` / `SERVER`）。调用方按 `code` 路由，**不要**解析
 * `message`。
 */
export class LlmError extends Error {
  /** 与实时 Error 并存的可序列化事实。 */
  readonly failure: LlmFailure
  /** 稳定机器码（与 `failure.code` 同值，便于 `error.code` 直读）。 */
  readonly code: string

  constructor(message: string, code: string, options?: LlmErrorOptions) {
    super(message, options?.cause === undefined ? undefined : { cause: options.cause })
    this.name = 'LlmError'
    this.code = code
    const failure: LlmFailure = { message, code }
    if (options?.status !== undefined) (failure as { status?: number }).status = options.status
    if (options?.providerRetryAfterMs !== undefined) {
      (failure as { providerRetryAfterMs?: number }).providerRetryAfterMs = options.providerRetryAfterMs
    }
    if (options?.requestId !== undefined) (failure as { requestId?: string }).requestId = options.requestId
    if (options?.offloadImages !== undefined) {
      (failure as { offloadImages?: number }).offloadImages = options.offloadImages
    }
    this.failure = failure
  }
}

/** 空响应（退化补全）的稳定错误码。 */
export const EMPTY_RESPONSE_CODE = 'EMPTY_RESPONSE'

/** 超出模型上下文窗口的稳定错误码。 */
export const CONTEXT_WINDOW_EXCEEDED_CODE = 'CONTEXT_WINDOW_EXCEEDED'

/** 额度耗尽的稳定错误码。 */
export const QUOTA_EXCEEDED_CODE = 'QUOTA'

/** 账号级额度耗尽的稳定错误码。 */
export const ACCOUNT_QUOTA_EXCEEDED_CODE = 'ACCOUNT_QUOTA'

// ── 上下文超限识别（正则与 DSH 逐字一致，保证判据不漂移） ──────────────

const STRUCTURED_CONTEXT_OVERFLOW = new RegExp(
  String.raw`(?:^|[^a-z0-9])context[\s_-](?:length|window)[\s_-]`
  + String.raw`(?:exceed(?:ed|s)?|overflow(?:ed)?|limit[\s_-]exceeded)(?:$|[^a-z0-9])`,
  'i',
)
const TOO_LARGE_FOR_CONTEXT = new RegExp(
  String.raw`\b(?:request|prompt|input|messages?)\s+(?:is\s+|are\s+)?`
  + String.raw`too\s+(?:large|long)\s+for\s+(?:(?:this|the)\s+)?`
  + String.raw`(?:model(?:'s)?\s+)?context(?:\s+window)?\b`,
  'i',
)
const EXCEEDS_MODEL_CONTEXT = new RegExp(
  String.raw`\b(?:input|prompt|request|messages?)\b.{0,40}`
  + String.raw`\b(?:exceed(?:s|ed)?|overflows?|is\s+larger\s+than)\b.{0,40}`
  + String.raw`\b(?:the\s+)?(?:model(?:'s)?\s+)?context(?:\s+(?:length|window))?\b`,
  'i',
)

/**
 * 判定错误文本是否表示「请求超出模型上下文窗口」。
 *
 * @param detail - 把 provider 的 code/type/message 拼成的一段文本。
 * @returns 命中上下文超限时 true。
 */
export function isContextWindowExceededError(detail: string): boolean {
  return STRUCTURED_CONTEXT_OVERFLOW.test(detail)
    || /\b(?:maximum|max)(?:\s+(?:allowed|supported))?\s+context\s+(?:length|window)\b/i.test(detail)
    || TOO_LARGE_FOR_CONTEXT.test(detail)
    || /\b(?:input|prompt|request)\s+(?:is\s+)?too\s+(?:long|large)\s+for\s+(?:this|the)\s+model\b/i.test(detail)
    || EXCEEDS_MODEL_CONTEXT.test(detail)
}

/**
 * 判定错误文本是否表示「账号额度已耗尽」（而非瞬时限流）。
 *
 * ⚠️ 与 {@link isContextWindowExceededError} 一样，判据必须**窄**：只认明确的
 * 额度/余额措辞，避免把模型正文里讨论「配额」误判为错误。
 */
export function isQuotaExceededError(detail: string): boolean {
  return /\binsufficient[\s_-]+(?:quota|balance|credits?)\b/i.test(detail)
    || /\b(?:quota|usage[\s_-]+limit)[\s_-]+(?:exceeded|exhausted|reached)\b/i.test(detail)
    || /\bexceed(?:ed|s)?[\s_-]+(?:(?:your|the)[\s_-]+)?(?:current[\s_-]+)?quota\b/i.test(detail)
    || /\b(?:balance|credits?)[\s_-]+(?:exhausted|depleted)\b/i.test(detail)
    || /\bout[\s_-]+of[\s_-]+(?:credits?|budget)\b/i.test(detail)
}

/**
 * 本产品向厂商归因时使用的 User-Agent 身份。
 *
 * ⚠️ **与 DSH 不同**：本项目是独立产品，归因应报自己的身份。适配器会在需要时
 * 用 `headers.set('User-Agent', ...)` 按产品/模型族覆盖它（腾讯系后台按该头
 * 分列「使用端」）。
 */
export const APP_IDENTITY = {
  product: 'all-proxy',
  version: '0.1.0',
  url: 'https://github.com/local/all-proxy',
} as const

/** 构造标准 User-Agent：`product/version (+url)`。 */
export function userAgent(identity: typeof APP_IDENTITY = APP_IDENTITY): string {
  return `${identity.product}/${identity.version} (+${identity.url})`
}

/**
 * 构造适配器必须随每个上游请求发送的归因头。
 *
 * ⚠️ 头名一律**小写**（HTTP 字段名大小写不敏感）。适配器用 `Headers.set()`
 * 覆盖它时不受影响（`Headers` 键大小写不敏感）。
 *
 * @param identity - 要发送的身份；默认 {@link APP_IDENTITY}。
 * @returns 需合并进上游请求的头（目前只有 `user-agent`）。
 */
export function attributionHeaders(identity: typeof APP_IDENTITY = APP_IDENTITY): Record<string, string> {
  return { 'user-agent': userAgent(identity) }
}

/**
 * 创建一条用户消息。
 *
 * 移植自 DSH 的同名工厂：适配器与探针用它构造一次性请求。
 */
export function createUserMessage(input: { content: unknown; source?: unknown }): RequestMessage {
  return {
    role: 'user',
    content: input.content,
    ...input.source === undefined ? {} : { source: input.source },
  }
}

/**
 * provider 侧 wire 适配器的本地基类。
 *
 * ⚠️ **只保留本项目需要的契约**：`providerInfo` / `listModels` / `resolveModel` /
 * `prepareCall` / `stream`。DSH 基类另有 `providerRetryPolicy` 与
 * `imageRequestPricing`，本项目的调用方（网关自身）不需要它们，且来源的 8 个
 * 适配器本来也没实现。
 */
export abstract class LlmAdapter {
  /**
   * 描述本适配器拥有的 provider 路由。
   * @param provider - 传给注册表的路由名。
   * @returns 展示元数据，其 `id` 必须等于 `provider`。
   */
  providerInfo(provider: string): LlmProviderInfo {
    return { id: provider, name: provider }
  }

  /**
   * 列出该 provider 当前可播报的模型。
   * @param _provider - 本适配器拥有的路由名。
   * @returns 按适配器偏好排序的可发现模型。
   */
  async listModels(_provider: string): Promise<readonly LlmModelInfo[]> {
    return []
  }

  /**
   * 解析某个精确模型的全部可用元数据。
   * @param provider - 本适配器拥有的路由名。
   * @param model - 精确模型 id。
   * @param _signal - 该次查询的取消信号。
   * @returns provider/model 身份，以及已知的上下文与默认值。
   */
  async resolveModel(provider: string, model: string, _signal?: AbortSignal): Promise<LlmResolvedModelInfo> {
    return { provider, id: model, name: model }
  }

  /**
   * 把「精确模型元数据」与「最终请求分发」绑定到同一代适配器状态。
   *
   * 动态适配器（如 Qoder）必须覆盖它，否则在解析与分发之间发生的设置变更会让
   * 某一代的能力与另一代的端点组合在一起。
   */
  async prepareCall(provider: string, model: string, signal?: AbortSignal): Promise<PreparedAdapterCall> {
    return {
      model: await this.resolveModel(provider, model, signal),
      stream: (options: GenerateOptions) => this.stream(options),
    }
  }

  /**
   * 流式执行一次模型调用。
   * @param options - 完整请求；实现必须尊重 `options.signal`。
   * @returns 流式 chunk。
   */
  abstract stream(options: GenerateOptions): AsyncIterable<StreamChunk>
}
