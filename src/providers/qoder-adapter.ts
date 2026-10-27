/**
 * Qoder LLM 适配器。
 *
 * ## 两条推理路径
 *
 * Qoder 有**两套**推理端点，认**两套不同的模型名** —— 这是本项目
 * 最容易踩的坑，务必分清：
 *
 * | 路径 | 端点 | 模型名 | 说明 |
 * |---|---|---|---|
 * | **加密（本适配器默认）** | `api2.qoder.sh/algo/api/v2/service/pro/sse/agent_chat_generation?Encode=1` | **目录 key**（`qfmodel` / `dmodel`） | 客户端真实链路；body 由 `src/qoder-wasm.ts` 加密；能拿到 Qwen3.8 系列 |
 * | 公开 | `api2-v2.qoder.sh/model/v1/chat/completions` | 通用名（`qwen-flash`） | 标准 OpenAI；但目录 key 一律 `Unsupported model` |
 *
 * **真实缺陷**（用户报障）：「向 qwen3.8-flash 发消息后没收到回复就终止」。
 * 根因是早期把**目录 key 发给了公开端点** → `invalid_model_error`，
 * 而错误帧又被解析器静默吞掉。
 *
 * ⚠️ `api2.qoder.sh`（加密）与 `api2-v2.qoder.sh`（公开）**不是同一个 host**，
 * 混用会 404。
 *
 * OpenAI 协议层的通用逻辑（消息序列化、SSE 消费、错误归类）复用
 * `src/openai-compat.ts`；加密端点的响应信封由 `src/qoder-envelope.ts` 剥离。
 */

import type { Context } from './cordis.js'
import type { CredentialRef } from './credential-ref.js'
import { LlmAdapter, LlmError } from './llm.js'
import type { GenerateOptions, LlmModelInfo, LlmProviderInfo, LlmResolvedModelInfo, StreamChunk } from './llm.js'
import { randomUUID } from 'node:crypto'
import { AccountPool, providerCatalogVisible } from './account-pool.js'
import { settingsNamespaceFor } from './settings-compat.js'
import { isQoderExpired, type QoderCredential } from './qoder.js'
import { describeWasmFailure, QoderEncryptedInfer, type QoderInferMessage, type QoderInferRequest, type QoderInferTool, type QoderInferToolCall } from './qoder-wasm.js'
import { unwrapQoderEnvelopeStream } from './qoder-envelope.js'
import { QODER, type QoderFallbackModel, type QoderModelPromotion, type QoderProduct } from './qoder-product.js'
import {
  collectImages,
  consumeOpenAiSse,
  contentToText,
  errorDetail,
  httpErrorCode,
  isTransportError,
  ModelQueuedError,
  serializeMessages,
} from './openai-compat.js'
import {
  BILLING_BUSINESS_CODE,
  QUEUE_BUSINESS_CODE,
  QUEUE_MAX_ATTEMPTS,
  QUEUE_MAX_DELAY_MS,
  isBillingBusinessCode,
  isQueueBusinessCode,
  looksLikeBillingError,
  nextUtc8DayStartMs,
  parseQueueError,
  queueDelayMs,
  type QueueInfo,
} from './model-queue.js'

/**
 * 本模块内使用的别名（`export { … as …
 * }` **不会**在模块内建立可用的名字 —— 那只对导入方生效）。
 */
type QoderQueueInfo = QueueInfo
const parseQoderQueueError = parseQueueError
const qoderQueueDelayMs = queueDelayMs

/**
 * ⚠️ **向后兼容的再导出**：排队解析的实现已移到 `src/model-queue.ts`
 * （因为 SSE 消费器也要用，而它不能被本模块反向 import —— 会成环）。
 * 这里保留同名导出，避免既有调用方与测试失效。
 */
export {
  BILLING_BUSINESS_CODE as QODER_BILLING_CODE,
  QUEUE_BUSINESS_CODE as QODER_QUEUE_CODE,
  QUEUE_MAX_ATTEMPTS as QODER_QUEUE_MAX_ATTEMPTS,
  QUEUE_MAX_DELAY_MS as QODER_QUEUE_MAX_DELAY_MS,
  isBillingBusinessCode,
  isQueueBusinessCode,
  looksLikeBillingError,
  nextUtc8DayStartMs,
  parseQueueError as parseQoderQueueError,
  queueDelayMs as qoderQueueDelayMs,
  type QueueInfo as QoderQueueInfo,
}

/**
 * 判断一个错误是否为**额度受限**（`QUOTA_EXCEEDED`）。
 *
 * ⚠️ 必须同时认 `code` **与** `message`：
 * - `code`：`openai-compat` 抛的 `LlmError(…, 'QUOTA_EXCEEDED')`（主判据）；
 * - `message`：兜底 —— 若哪天错误从别的路径冒出来（如未被包装的原始文本），
 *   文案里仍带 `Billing daily count exceeded`，可据此识别。
 *
 * ⚠️ 用 `code` 判据**而不是**重新解析错误文本：`ModelQueuedError` 已证明
 * 「在适配器里重解析一遍」会与上游判定漂移（同一份判据两处实现必然不同步）。
 */
function isQuotaExceededError(error: unknown): boolean {
  if (error instanceof LlmError) {
    if (error.code === 'QUOTA_EXCEEDED' || error.code === 'QUOTA') return true
  }
  if (error instanceof Error) {
    // 仅在**没有**更精确的 code 时用文案兜底（避免把正常文本误判）
    if (!(error instanceof LlmError)) return looksLikeBillingError(error.message)
  }
  return false
}

/** 本适配器注册的 provider 路由名（历史常量，等价于 `QODER.id`）。 */
export const PROVIDER = 'qoder'

/**
 * **单个账号**排队等待的上限（毫秒），默认 **1 分钟**。
 *
 * ## 语义（2026-10-27 用户要求）
 *
 * > 排队超过 1 分钟就自动切账号，全部都要超过 1 分钟就直接报错
 *
 * ⚠️ 这是**每账号**预算，不是整请求预算 —— 换号后**重新计时**。故一次请求
 * 的总耗时上限是「账号数 × 1 分钟」，而不是某个固定值。
 *
 * 为什么不再「等满预算再失败」（原实现）：Qoder 的免费模型（`isFree`，如
 * `dfmodel` / `qfmodel`）免费池最挤，队列常常长时间不动。原实现死等同一个
 * 账号，实测一次 `qodercn/dfmodel` 请求挂了 **30 分钟**才失败
 * （`req-55f749e3136f3afd`，本地 16:32:30 → 17:02:33），用户体感即「卡死」。
 * 而多账号池的价值恰恰在于**换一个号重排**——队列常与账号相关，换个账号
 * 往往立刻就能跑。
 *
 * 1 分钟的取值理由：单次等待已封顶 `QUEUE_MAX_DELAY_MS = 10 秒`，1 分钟够
 * 跨过数轮「等 2 秒就通」的瞬时排队（见 `REAL_TRANSIENT` 用例），又不会让
 * 用户在单个账号上干等太久。
 */
export const DEFAULT_QUEUE_TIMEOUT_MS = 60_000

/**
 * 单账号排队上限（毫秒），可用 `DSH_QODER_QUEUE_TIMEOUT_MS` 覆盖。
 *
 * ⚠️ **不能用 `parseInt(…) || 默认值`**：`0` 是**合法**配置（表示「不等，立即
 * 判超时 → 立刻换号」，单测就靠它验证该开关），而 `0` 是 falsy，会被 `||`
 * 静默换成默认值 —— 那会让这个开关在「想关掉排队等待」时**恰好失效**。
 * 故显式判 `undefined`。
 */
export function resolveQueueTimeoutMs(): number {
  const raw = process.env.DSH_QODER_QUEUE_TIMEOUT_MS
  if (raw === undefined || raw.length === 0) return DEFAULT_QUEUE_TIMEOUT_MS
  const parsed = Number.parseInt(raw, 10)
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : DEFAULT_QUEUE_TIMEOUT_MS
}

/**
 * 读 `AbortSignal.aborted`（**刻意做成函数**）。
 *
 * 为什么不能内联 `signal?.aborted === true`：TS 会在 `await` 之前的一次
 * early-throw 之后把该表达式**静态窄化**为字面量 `false`，于是「等待期间被
 * 中止」这第二次检查会被判为「无重叠的比较」而**编译报错** —— 那个报错本身
 * 是假阳性（`aborted` 是随时间的可变状态）。经函数读取即可保留真实语义，
 * 也把「这里为什么再查一次」的意图写清楚。
 */
function isAborted(signal?: AbortSignal): boolean {
  return signal?.aborted === true
}

/**
 * 从 SSE 层抛出的 {@link ModelQueuedError} 里取出排队信息。
 *
 * `ModelQueuedError.queueInfo` 是已经解析好的 `QueueInfo`，但类型放宽成了
 * `Record<string, unknown>`（共享模块不该暴露 provider 私有类型）。
 * 这里原样取回 —— **不要再解析一次**（那会与已解析的结果产生两套口径）。
 */
function queueInfoOf(error: ModelQueuedError): QoderQueueInfo {
  return error.queueInfo as QoderQueueInfo
}


/**
 * 把 DSH 的工具 schema 映射成加密端点认的 `tools[]`。
 *
 * 形态取自客户端 `$Hc(A)`：
 * `{type:'function', function:{name, description?, parameters?}}` ——
 * `description` / `parameters` **缺省时该键不出现**（不是填空串/空对象）。
 *
 * ⚠️ 这是 `options.tools` 的**唯一出口**。适配器若不下发它，模型在 wire 上
 * 看不到任何函数定义，只能用正文里的 XML 文本臆造工具调用 —— 用户报障
 * 「qwen3.8-flash 执行任务出现任务调用 xml 泄露任务终止」的根因。
 *
 * @param tools - DSH 的 `GenerateOptions.tools`（可能缺席）。
 * @returns 可直接写入请求体顶层 `tools` 的数组；无工具时为空数组。
 */
export function buildQoderTools(
  tools: readonly { name: string; description: string; parameters: Record<string, unknown> }[] | undefined,
): QoderInferTool[] {
  if (tools === undefined || tools.length === 0) return []
  return tools.map((tool) => ({
    type: 'function' as const,
    function: {
      name: tool.name,
      ...(tool.description.length > 0 ? { description: tool.description } : {}),
      ...(tool.parameters === undefined ? {} : { parameters: tool.parameters }),
    },
  }))
}

/** {@link buildQoderHistory} 的入参：DSH 序列化后的 wire 消息（OpenAI 形态）。 */
interface QoderWireMessage {
  role?: unknown
  content?: unknown
  tool_calls?: unknown
  tool_call_id?: unknown
}

/** 把 wire 消息的 content 归一化为字符串（工具调用消息的正文是空串）。 */
function qoderContentText(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .filter((block): block is { type: string; text: unknown } =>
        typeof block === 'object' && block !== null && (block as { type?: unknown }).type === 'text')
      .map((block) => String(block.text))
      .join('')
  }
  // `null`（assistant 只带 tool_calls 时的 OpenAI 规范值）与畸形值都退化为空串：
  // 客户端 `t2c()` 的 content 恒为字符串（`udn(r, '')`）。
  return ''
}

/**
 * 把 wire 消息的 content 数组**逐字段搬运**成多模态 parts。
 *
 * ## 为什么必须保留数组（真实缺陷，用户报障）
 *
 * 「给 qodercn 的 qwen3.8-flash 发送图片，模型说没读到图片」。
 *
 * 根因**不在** `chat_context.imageUrls` —— 客户端官方实现 `Hyc()` 就把那个字段
 * **恒置 `null`**（obf 产物原文：`function Hyc(A,e,t){return{text:A,features:[],
 * extra:{…},chatPrompt:"",imageUrls:null}}`），我们那行是忠实复刻。
 * 图片的正确通道是 **`messages[].content` 的多模态数组**：客户端 `eQc()` 把
 * `{type:'base64',media_type,data}` 转成 `{type:'image_url',image_url:{url}}`，
 * `bJc()` 再转成 `{type:'input_image',image_url:…}` 后发出。
 *
 * 而上游 `serializeMessages`（`src/openai-compat.ts`）**已经**把图片正确转成了
 * `{type:'image_url',image_url:{url:'data:…'}}` 放进 content 数组 ——
 * 是 `buildQoderHistory` 用 `qoderContentText()` 把它压成纯文本吃掉的。
 *
 * ⚠️ 这是本文件第三个同型缺陷（前两个：`tools` 不下发、工具历史丢
 * `tool_calls`）—— 都是「序列化层没保留多模态结构」。改动时务必三者一起想。
 *
 * ⚠️ **只保留协议认识的两个键**（与 `buildQoderInferPayload` 的「逐字段搬运」
 * 同一原则）：不要把 DSH 的内部字段（`id` / `source` / `attachment` 等）
 * 原样发给上游。
 *
 * @returns 规范化后的 parts；**无图或全部畸形**时返回 undefined（调用方据此
 *          决定是否降级为字符串，以免把纯文本消息也改成数组形态）。
 */
function qoderContentParts(content: unknown): Array<Record<string, unknown>> | undefined {
  if (!Array.isArray(content)) return undefined
  const parts: Array<Record<string, unknown>> = []
  let hasImage = false
  for (const raw of content) {
    if (typeof raw !== 'object' || raw === null) continue
    const block = raw as { type?: unknown; text?: unknown; image_url?: { url?: unknown } }
    if (block.type === 'text') {
      const text = String(block.text ?? '')
      if (text.length > 0) parts.push({ type: 'text', text })
      continue
    }
    if (block.type === 'image_url') {
      // ⚠️ 只搬 `url`：`image_url` 里可能还有 `detail` 等字段，客户端 `bJc()`
      // 只在存在时透传 `detail`，这里与它对齐（缺省不写该键）。
      const url = block.image_url?.url
      if (typeof url !== 'string' || url.length === 0) continue
      const detail = (block.image_url as { detail?: unknown }).detail
      parts.push({
        type: 'image_url',
        image_url: {
          url,
          ...(typeof detail === 'string' && detail.length > 0 ? { detail } : {}),
        },
      })
      hasImage = true
      continue
    }
    // 其余类型（如 Anthropic 风格的 `image`、`tool_result` 内层块）不由本函数处理：
    // 它们要么已被 `serializeMessages` 转成 image_url，要么不属于推理载荷。
  }
  // 无图时返回 undefined，让调用方继续用字符串形态（上游对字符串兼容性最好）。
  return hasImage ? parts : undefined
}

/**
 * 把 `serializeMessages` 的 wire 消息转成加密端点的 `messages[]`。
 *
 * ## 真实缺陷（本次修复）
 *
 * 早期实现写成「只保留 `content` 为字符串的消息」：
 *
 * ```ts
 * messages.filter((m) => typeof m.content === 'string')
 * ```
 *
 * 这有两个后果，都会让**多步工具调用**彻底坏掉：
 * 1. assistant 带工具调用时 `content` 是 **`null`**（OpenAI 规范）→ 整条消息
 *    被丢弃，模型**看不到自己调用过什么**；
 * 2. `role:'tool'` 消息的 `tool_call_id` 被一并丢掉 → 工具结果无法与调用配对。
 *
 * 于是模型只能反复重调同一个工具或凭空编造结果 —— 与 TRAE 那条已记录的
 * 同型缺陷（「消息序列化漏做 → 模型看不到工具调用与结果」）完全一致。
 *
 * 形态对齐客户端：assistant 挂 `tool_calls`，`role:'tool'` 挂 `tool_call_id`。
 */
export function buildQoderHistory(messages: readonly QoderWireMessage[]): QoderInferMessage[] {
  const history: QoderInferMessage[] = []
  for (const message of messages) {
    if (typeof message.role !== 'string') continue
    // ⚠️ 含图消息必须保留 content **数组**（见 `qoderContentParts` 的缺陷说明）；
    // 纯文本仍走字符串，保持与既有形态和上游兼容性逐字节一致。
    const parts = qoderContentParts(message.content)
    const content = parts === undefined ? qoderContentText(message.content) : parts
    const toolCalls = Array.isArray(message.tool_calls) && message.tool_calls.length > 0
      ? (message.tool_calls as QoderInferToolCall[])
      : undefined
    const toolCallId = typeof message.tool_call_id === 'string' ? message.tool_call_id : undefined
    // 三者皆空的消息没有承载意义（如只有 reasoning 的帧），跳过以免发出
    // 「空 assistant」这种会让上游困惑的条目。
    //
    // ⚠️ 判空必须把**图片**算作内容：`parts` 为非空数组（含 image_url）时
    // 即便 `qoderContentText` 结果为空串也不能丢弃 —— 否则「只发一张图、
    // 不带文字」的消息会被整条吃掉（用户报障场景之一）。
    const isEmpty = parts === undefined
      ? content.length === 0
      : (content as Array<Record<string, unknown>>).length === 0
    if (isEmpty && toolCalls === undefined && toolCallId === undefined) continue
    history.push({
      role: message.role,
      content,
      ...(toolCalls === undefined ? {} : { tool_calls: toolCalls }),
      ...(toolCallId === undefined ? {} : { tool_call_id: toolCallId }),
    })
  }
  return history
}

/**
 * SSE 空闲超时（毫秒）。
 *
 * 分两阶段：等待首 token 的窗口与两次 chunk 之间的最大静默，均可用环境变量
 * 覆盖（便于测试用短超时触发 TIMEOUT 路径）。**每次 `stream()` 调用时读取**
 * —— 模块顶层常量会在 import 时定型，导致测试里设环境变量不生效。
 *
 * 这层保护的必要性：半开 SSE 连接下 `reader.read()` 会永久挂起，
 * adapter 的 generator 永不返回，会话卡死在「运行中」，用户无法恢复。
 */
function resolveFirstTokenTimeoutMs(): number {
  return Number.parseInt(process.env.DSH_QODER_SSE_FIRST_TOKEN_TIMEOUT_MS ?? '', 10) || 120_000
}
function resolveChunkTimeoutMs(): number {
  return Number.parseInt(process.env.DSH_QODER_SSE_CHUNK_TIMEOUT_MS ?? '', 10) || 120_000
}

/** `QoderAdapter` 的构造选项。 */
export interface QoderAdapterOptions {
  /** 默认凭据 ref（仅用于类型/日志，实际解析走 `resolveCredential`）。 */
  credentialRef: CredentialRef
  /**
   * 从凭据存储解析凭据。
   *
   * ⚠️ **`modelId` 必须透传给选号器**：空串会让 `AccountPool.getAvailableAccount`
   * 的**模型级限流过滤整体短路**（`if (modelId.length === 0) return true`），
   * 于是刚被标记额度用尽的账号下次仍会被选中 —— 表现为「每个请求都先打一次
   * 必然失败的账号再换号」，换号形同虚设（真实缺陷，2026-10-26 实测复现：
   * 标记 A 的 dfmodel 受限后，传空串仍返回 A，传 'dfmodel' 才正确返回 B）。
   * 与 `TraeAdapterOptions.resolveCredential` 的同名约束同源。
   */
  resolveCredential: (modelId?: string) => Promise<QoderCredential | undefined>
  /** 静默续期凭据。 */
  refresh: () => Promise<void>
  /** 多账号池（用于限流时切换账号与模型黑名单）。 */
  accountPool?: AccountPool
  /**
   * 补齐凭据缺失的 **`uid`**（加密推理必需）。
   *
   * ⚠️ 为什么需要这个钩子：`uid` 是后加的字段，**在此之前的旧凭据里没有它**，
   * 而 `generate_runtime_auth_fields` 依赖它派生 `encrypt_user_info`。
   * 缺 uid 时 WASM 产出**签名无效**的请求 → 服务端回
   * `Signature invalid (101)`（真实缺陷，用户报障）。
   *
   * 传入旧凭据，实现应调一次 userinfo 取 `id`、**回写凭据存储**，
   * 并返回补好 uid 的新凭据；无法补齐时返回 undefined。
   *
   * 未提供该钩子、且凭据缺 uid 时，会**明确报错**而不是发出必然失败的请求。
   */
  resolveUid?: (credential: QoderCredential) => Promise<QoderCredential | undefined>
  /**
   * 读取图片附件的原始字节（内联为 data URL 用）。
   *
   * 由调用方桥接 `ctx.attachments.readImage(ref)`；未提供时收到图片会报
   * `UNSUPPORTED_CONTENT`（而不是静默丢弃）。
   */
  readImage?: (attachment: unknown) => Promise<{ data: Uint8Array; mediaType: string } | undefined>
  /** 产品配置；默认 {@link QODER}。 */
  product?: QoderProduct
  /** 注入的 fetch（测试用）。 */
  fetchImpl?: typeof fetch
  /**
   * 拉取**远端模型目录**（由 `wiring.ts` 注入 `QoderAuth.fetchModels(pool)`）。
   *
   * ## ⚠️ 为什么是「注入一个取数函数」而不是适配器自己解析凭据
   *
   * 适配器手上的取凭据入口是 `resolveCredential`，而它**有副作用**：选中账号
   * 时接线层会记录「本次实际使用的账号」（供额度报错时标记）。目录请求是
   * **周期性**的（每次列表 + 后台刷新），若走同一条路，它会在一次聊天请求选号
   * 之后把那个记录**改写成目录用的账号** ⇒ 额度标记落到无辜账号上。
   *
   * 故与其余 provider 同形：由 auth 服务做**只读**取号 + 拉取，适配器只拿结果。
   *
   * 省略时**不发远端请求**（恒用兜底表）—— 纯测试/未接线场景的安全默认。
   */
  fetchRemoteModels?: () => Promise<readonly QoderFallbackModel[]>
  /**
   * 目录读取失败的告警出口（缺省静默）。
   *
   * ⚠️ 与「失败即回退兜底表」配套：回退是**静默**的，没有这条日志就没有
   * 任何证据表明上游目录取不到（只剩「倍率不更新」这种无信息的症状）。
   */
  warn?: (message: string) => void
  /** 注入的时钟（测试用；缺省 `Date.now`）。 */
  now?: () => number
  /**
   * 当前生效账号的 id（额度受限时用于**标记该账号**）。
   *
   * ⚠️ 做成**回调**而不是构造期常量：账号会在 `refreshAll` / 限流切换 /
   * Jet Hub 手动启停后变化，构造期快照会标记到**已经不再使用**的账号上。
   * 未提供时跳过标记（仍会尝试切号），不会因此崩。
   */
  currentAccountId?: () => string | undefined
  /**
   * 注入的休眠实现（**测试用**）。
   *
   * 排队重试要真等（最长 10s × 180 次），单测不能真睡 —— 注入后即可断言
   * 「等了几次、每次多久」，并在毫秒级完成。
   */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>
}

/** Qoder 模型适配器。使用 Bearer access_token 鉴权，仅支持 SSE。 */
export class QoderAdapter extends LlmAdapter {
  private readonly product: QoderProduct
  private readonly fetchImpl: typeof fetch
  /** 产品级兜底模型索引（`product.fallbackModels` 的 id → 条目）。 */
  private readonly fallbackIndex: ReadonlyMap<string, QoderFallbackModel>
  /**
   * **远端**模型目录缓存（成功拉取后保留到 TTL 过期）。
   *
   * ⚠️ 2026-10-20 前本家**恒用编译期兜底表**（一次远端请求都不发），
   * 上游改价/改免费额度/上下架模型都不会反映 —— 用户报障
   * 「DeepSeek-Flash 上游已经 0×（免费）了，插件还显示 0.1」。
   * 现在远端优先、兜底表只作回退（见 `qoder-catalog.ts`）。
   */
  private remoteModels: QoderFallbackModel[] | undefined

  /**
   * 丢弃已缓存的远端模型目录，供管理端「刷新模型目录」按钮强制重拉。
   * 见 `src/providers/llm-adapter.ts` 与 `wiring.ts` 的 `refreshModelCatalog`。
   */
  override invalidateModelCatalog(): void {
    this.remoteModels = undefined
  }
  /** 上次**成功**读到远端目录的时刻（0 = 从未成功过）。 */
  private catalogAt = 0
  /** 目录拉取的**并发去重**（同一时刻只发一次上游请求）。 */
  private catalogInFlight: Promise<void> | undefined

  constructor(private readonly options: QoderAdapterOptions) {
    super()
    this.product = options.product ?? QODER
    this.fetchImpl = options.fetchImpl ?? fetch
    this.fallbackIndex = new Map(
      (this.product.fallbackModels ?? []).map((model) => [model.id, model]),
    )
  }

  /**
   * 可中止的休眠；信号中止时立即 resolve（不抛错，由调用方检查 signal）。
   *
   * ⚠️ **必须响应 `signal`**：排队等待是**每账号 1 分钟**、多账号可累加，用户中途
   * 取消会话时不能让 generator 卡在 `setTimeout` 里 —— 那会表现为「点了停止但没反应」。
   */
  private async sleep(ms: number, signal?: AbortSignal): Promise<void> {
    if (this.options.sleep !== undefined) {
      await this.options.sleep(ms, signal)
      return
    }
    if (ms <= 0 || signal?.aborted === true) return
    await new Promise<void>((resolve) => {
      const onAbort = (): void => { clearTimeout(timer); resolve() }
      const timer = setTimeout(() => {
        signal?.removeEventListener('abort', onAbort)
        resolve()
      }, ms)
      signal?.addEventListener('abort', onAbort, { once: true })
    })
  }

  /**
   * 描述本适配器拥有的 provider 路由。
   *
   * 对入参做防御性归一化：DSH 会强制校验 `info.id === provider`，而模型设置页
   * 会用该 id 计算 `deriveKeyRef(provider)`（内部调 `provider.toUpperCase()`）。
   * 一旦 provider 不是字符串（上游传入 undefined），直接回退到本产品的 id，
   * 避免 `undefined.toUpperCase is not a function` 在客户端炸开。
   */
  providerInfo(provider: string): LlmProviderInfo {
    const id = typeof provider === 'string' && provider.length > 0 ? provider : this.product.id
    return { id, name: this.product.displayName }
  }

  /**
   * 当前**目录条目**：远端优先，未落地时回退编译期兜底表。
   *
   * ⚠️ 回退不是「优化」而是**必需**：纯插件用户（或上游目录接口故障时）
   * 若目录为空，模型列表会把该 provider 判成「没有模型」而整个隐藏。
   */
  private catalogSource(): readonly QoderFallbackModel[] {
    return this.remoteModels ?? this.product.fallbackModels
  }

  /**
   * 按 id 取条目，供**能力/元数据**判据使用：**远端优先，未命中回退兜底表**。
   *
   * ## ⚠️⚠️ 为什么是「两份目录的并集」，而不是只用远端
   *
   * **远端目录是「按账号」下发的**（实测一个免费额度号上游只给 2 条）。
   * 若只查远端，静态表里其它模型会被判成「未知」⇒ `inputModalitiesFor`
   * 报 `['text']` ⇒ `stream()` 会**硬拒图片**，同时 name 退化成裸 id、
   * `context` 消失、请求体的 display_name / max_input_tokens 一并退化。
   *
   * | 场景 | 只查远端 | 并集（现行） |
   * |---|---|---|
   * | 远端大目录里的模型 | ✅ | ✅ 远端优先 |
   * | 远端只剩 2 条（免费号）时用 `dmodel` | ❌ 硬拒图片 + 元数据退化 | ✅ 回退静态表 |
   * | 只在远端有的 `fast` | ✅ | ✅ 远端命中 |
   *
   * ⚠️ **菜单（`listModels`）仍以远端为准** —— 这条并集只作用于
   * 「能力/元数据判据」，不改变「有哪些模型可选」：让**能力**判据取并集，
   * 让**可选项**保持单一来源。
   */
  private catalogModel(id: string): QoderFallbackModel | undefined {
    return this.catalogSource().find((model) => model.id === id) ?? this.fallbackIndex.get(id)
  }

  /**
   * 模型接受的输入模态。
   *
   * 按**模型**判定（目录条目的 `supportsImage`），不是按 provider 一刀切。
   * 未声明时**保守报 text**：宁可少报能力（用户改用文本描述），
   * 也不要报一个服务端不认的模态（请求会失败）。
   *
   * ⚠️ 判据取自 `catalogModel()`（**远端 ∪ 静态表**）—— 只取远端会让
   * 「按账号收缩的目录」把静态表里已知的模型判成未知。
   */
  private inputModalitiesFor(model: string): readonly ('text' | 'image')[] {
    return this.catalogModel(model)?.supportsImage === true ? ['text', 'image'] : ['text']
  }

  /**
   * 完整模型目录（**不应用用户黑名单**），含最终展示名（倍率/免费标记）。
   *
   * 设置页必须渲染被关闭的模型（否则用户无法重新打开），而 `listModels` 会按
   * 黑名单过滤掉它们 —— RPC 层只能凭裸 id 补回，展示名与倍率随之丢失
   * （用户报障：「关闭的就没有显示倍率」）。详见 `model.list` 端点的注释。
   */
  listAllModels(): readonly { id: string; name: string }[] {
    return this.catalogSource().map((model) => ({ id: model.id, name: qoderDisplayName(model) }))
  }

  async listModels(_provider: string): Promise<readonly LlmModelInfo[]> {
    // ⚠️ 没有任何已登录账号时返回空数组 → DSH 的 `buildModelCatalog` 把整个
    // provider 分组隐藏（它显式 `.filter(group => group.models.length > 0)`）。
    // ⚠️ 必须返回 `[]` 而**不能抛错**（抛错会被归入 catalog 的 `failures`，
    // 界面上反而多出一条 provider 报错）。
    if (!await providerCatalogVisible(this.options.accountPool, this.product.id)) return []
    // 远端优先：拉不到时 `ensureRemoteModels` 静默保持兜底表。
    await this.ensureRemoteModels()
    // 用户在 Jet Hub 关闭的模型（黑名单制：不在表里即默认打开）。
    const disabled = this.options.accountPool?.disabledModelsFor(this.product.id)
    const source = this.catalogSource()
    const listed = disabled === undefined || disabled.size === 0
      ? source
      : source.filter((model) => !disabled.has(model.id))
    return listed.map((model) => ({
      provider: this.product.id,
      id: model.id,
      // 倍率拼进 `name`（**不是** `description`）：composer 的模型切换菜单
      // 只渲染 name，description 仅用于 /model 弹窗。见 qoderDisplayName。
      name: qoderDisplayName(model),
      inputModalities: this.inputModalitiesFor(model.id),
    }))
  }

  async resolveModel(provider: string, model: string, _signal?: AbortSignal): Promise<LlmResolvedModelInfo> {
    // ⚠️ **必须先把远端目录拉到位再取条目**（TTL 闸门内是 no-op，零额外请求）：
    // 冷缓存下 `catalogSource()` 还是静态表，此时远端独有的模型（如 `fast`）
    // 会退化成裸 id。
    await this.ensureRemoteModels()
    const entry = this.catalogModel(model)
    const resolved: LlmResolvedModelInfo = {
      provider,
      id: model,
      name: entry?.name ?? model,
      inputModalities: this.inputModalitiesFor(model),
    }
    // 上下文窗口：未知模型不编造 context（宁可让调用方用默认值，
    // 也不要报一个假的窗口大小）。
    if (entry !== undefined && entry.contextWindow > 0) {
      resolved.context = { contextWindow: entry.contextWindow }
    }
    return resolved
  }

  /** 目录缓存的 TTL：20 分钟（与来源 `isCatalogFreshFor` 的 A 类口径一致）。 */
  private static readonly CATALOG_TTL_MS = 20 * 60 * 1000

  private nowMs(): number {
    return this.options.now?.() ?? Date.now()
  }

  /**
   * 懒加载远端模型目录（TTL 内不重复拉；并发去重）。
   *
   * 三条口径：
   * 1. **只在成功时**记 `catalogAt` —— 失败也记会让一次网络抖动把 TTL 上界刷掉，
   *    下一轮要再等满 20 分钟才发现上游没恢复；
   * 2. 空结果视为失败（保持兜底表，不把菜单清空）；
   * 3. 失败**静默**回退，但留一条 warn 日志（否则「倍率不更新」无任何证据）。
   */
  private async ensureRemoteModels(): Promise<void> {
    if (this.remoteModels !== undefined
      && this.nowMs() - this.catalogAt < QoderAdapter.CATALOG_TTL_MS) {
      return
    }
    // 并发去重：同一时刻只发一次上游请求（列表 + 解析元信息会并发调用）。
    if (this.catalogInFlight !== undefined) {
      await this.catalogInFlight
      return
    }
    this.catalogInFlight = this.loadRemoteModelsOnce()
    try {
      await this.catalogInFlight
    } finally {
      this.catalogInFlight = undefined
    }
  }

  /** 真发一次远端目录请求（失败返回空数组并留日志）。 */
  private async loadRemoteModelsOnce(): Promise<void> {
    const fetchRemote = this.options.fetchRemoteModels
    if (fetchRemote === undefined) return
    try {
      const models = await fetchRemote()
      if (models.length === 0) return
      this.remoteModels = [...models]
      this.catalogAt = this.nowMs()
    } catch (error) {
      this.options.warn?.(
        `[${this.product.id}] 模型目录读取失败，退用内置兜底表：`
        + (error instanceof Error ? error.message : String(error)),
      )
    }
  }

  /**
   * 后台目录刷新入口。
   *
   * ⚠️ 与 `options.refresh`（HTTP 401 后的**凭据**续期）**不是同一件事**，
   * 两者同名纯属巧合，**不得合并**。
   */
  async refresh(): Promise<void> {
    // 先清时刻，保证「无视新鲜度，强制拉一次」。
    this.catalogAt = 0
    this.remoteModels = undefined
    await this.ensureRemoteModels()
  }

  /**
   * 兼容 0.1.1-rc.2：新版 `LlmRuntime.prepareCall()` 会调用
   * `registration.adapter.prepareCall(...)`，而本仓库链接的 dsh-llm 副本
   * 基类尚未提供该方法，缺少时会在每轮请求开始时抛
   * `registration.adapter.prepareCall is not a function`。
   * 与 `BuddyAdapter` / `LobsteraiAdapter` 同款 shim。
   */
  async prepareCall(
    provider: string,
    model: string,
    signal?: AbortSignal,
  ): Promise<{ model: LlmResolvedModelInfo; stream: (options: GenerateOptions) => AsyncIterable<StreamChunk> }> {
    return {
      model: await this.resolveModel(provider, model, signal),
      stream: (options: GenerateOptions) => this.stream(options),
    }
  }

  async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    // 图片能力按**模型**判定（兜底表 supportsImage）。
    //
    // 这里**不能**放宽成「总是接受」：DSH 在 LlmRuntime 里按适配器播报的
    // `inputModalities` 决定要不要把图片投影成文本占位符，声明支持就必须真支持。
    const imageRefs = new Map<string, unknown>()
    for (const message of options.messages) {
      if (Array.isArray(message.content)) collectImages(message.content, imageRefs)
    }
    let imageUrls: Map<string, string> | undefined
    if (imageRefs.size > 0) {
      if (!this.inputModalitiesFor(options.model).includes('image')) {
        throw new LlmError(
          `qoder: 模型 "${options.model}" 不支持图片输入`,
          'UNSUPPORTED_CONTENT',
        )
      }
      if (this.options.readImage === undefined) {
        throw new LlmError('qoder: 图片输入需要附件服务', 'UNSUPPORTED_CONTENT')
      }
      // 保留**空 Map**（而非降级为 undefined）：图片存在但全部读取失败时，
      // 空 Map 仍会让 userContentParts 产出 [image unavailable] 占位符。
      imageUrls = new Map()
      for (const [id, ref] of imageRefs) {
        const image = await this.options.readImage(ref)
        if (image === undefined) continue
        imageUrls.set(id, `data:${image.mediaType};base64,${Buffer.from(image.data).toString('base64')}`)
      }
    }

    // 1. 获取凭据（过期则先静默续期）
    //
    // ⚠️ 必须传 `options.model`：选号器靠它过滤「该模型已额度用尽」的账号。
    // 传空串会让过滤整体短路，刚用完额度的账号下次仍被选中（见选项注释）。
    let credential = await this.options.resolveCredential(options.model)
    if (credential === undefined || isQoderExpired(credential)) {
      await this.options.refresh()
      credential = await this.options.resolveCredential(options.model)
    }
    if (credential === undefined || credential.access_token.length === 0) {
      throw new LlmError('qoder: no usable credential; log in first', 'MISSING_CREDENTIAL')
    }

    // 2. 补齐 **uid**（加密推理必需）。
    //
    // ⚠️ `uid` 是后加字段，旧凭据里没有；缺它时 WASM 会产出**签名无效**的
    // 请求，服务端回 `Signature invalid (101)`（真实缺陷，用户报障）。
    // 这里调用注入的钩子补一次（实现会调 userinfo 并回写凭据）。
    credential = await this.ensureUid(credential)

    // 3. 走**加密推理**路径（客户端真实链路，认模型目录 key）。
    //
    // 目录 key（`qfmodel` 等）只有这条路能用；公开端点是另一套通用名。
    const messages = serializeMessages(options.messages, imageUrls)
    const systemText = options.system !== undefined && options.system.length > 0
      ? options.system
      : undefined

    /** 最后一条 user 消息即本轮提问；其余作为历史。 */
    const userMessages = messages.filter((m) => m.role === 'user')
    const lastUser = userMessages.at(-1)
    // ⚠️ 带图消息的 content 是**多模态数组**（见 `qoderContentParts`），
    // 只判 `typeof === 'string'` 会让 `chat_context.text` / `originalContent`
    // 退化成空串 —— 那会让模型收到「一张没有配文的图」，与用户实际输入不符。
    // 故两种形态都要取文本（数组时取其中的 text 块）。
    const userText = typeof lastUser?.content === 'string'
      ? lastUser.content
      : (Array.isArray(lastUser?.content)
          ? (lastUser.content as Array<{ type?: unknown; text?: unknown }>)
              .filter((block) => block.type === 'text')
              .map((block) => String(block.text ?? ''))
              .join('')
          : '')
    // ⚠️ 必须走 buildQoderHistory：早期内联的「只留 content 为字符串」过滤器
    // 会丢掉 assistant 的 tool_calls（content 为 null）与 tool 的 tool_call_id，
    // 使多步工具调用彻底坏掉（模型看不到自己调用过什么）。
    const history = buildQoderHistory(messages)
    // ⚠️ 工具定义必须真的下发：加密端点的顶层 `tools`。不下发时模型只能
    // 用正文里的 XML 文本臆造工具调用 → harness 认不出 → 任务终止
    // （用户报障「qwen3.8-flash 执行任务出现任务调用 xml 泄露任务终止」）。
    const tools = buildQoderTools(options.tools)

    // ⚠️ 远端优先（并集回退）：目录是**按账号**下发的，只查远端会让
    // 「当前账号的小目录」把静态表里已知的模型判成未知 ⇒ 图片被硬拒、
    // 元数据退化。见 `catalogModel()` 的注释。
    const fallback = this.catalogModel(options.model)

    /** 用给定凭据构造一次加密请求（首次与 401 重试共用，避免两处漂移）。 */
    const buildRequest = async (c: QoderCredential): Promise<QoderInferRequest> => {
      // 🔴 `client` 持有 wasm `QoderContext`，**本次构造用完必须释放**：
      // 不释放则进程级共享的 wasm 堆只增不减，长会话最终以裸
      // `RuntimeError: unreachable` 暴毙。用 `try/finally` 而非顺序调用：
      // `create` / `prepareInfer` 抛错时同样要释放，否则**异常路径**反倒
      // 成了泄漏最多的那条路。
      let client: QoderEncryptedInfer | undefined
      try {
        client = await QoderEncryptedInfer.create({
          user: {
            uid: c.uid!,
            securityOauthToken: c.security_oauth_token ?? c.access_token,
          },
          machineId: c.machine_id,
          metadata: { ...this.product.clientMetadata },
          host: this.product.encryptedInferBase,
        })
        return client.prepareInfer({
          modelKey: options.model,
          userText,
          ...(systemText !== undefined ? { systemText } : {}),
          isReasoning: fallback?.supportsThinking ?? false,
          history,
          // 工具定义：这是模型**唯一**能学到函数 schema 的通道，
          // 缺了它模型只能用正文 XML 臆造调用（真实缺陷）。
          tools,
          ...(options.maxTokens !== undefined ? { maxTokens: options.maxTokens } : {}),
          ...(options.reasoningEffort !== undefined ? { reasoningEffort: options.reasoningEffort } : {}),
          ...(fallback?.supportsImage !== undefined ? { isVl: fallback.supportsImage } : {}),
          // 官方 `model_config` 的 display_name / max_input_tokens 必须带上。
          ...(fallback?.name !== undefined ? { displayName: fallback.name } : {}),
          ...(fallback?.contextWindow !== undefined ? { maxInputTokens: fallback.contextWindow } : {}),
          // ⚠️ **`business` 必填**，否则服务端把请求路由到错误的后端节点。
          //
          // 实测（2026-09-20）：不带 `business` 时 `qfmodel`（Qwen3.8-Flash）
          // 恒落到故障节点 `oa_qwen-plus-2025-04-28` 并返回
          // `[FAIL]node:... msg:Execution failed`；补上 `business` 后立即正常
          // （其余模型如 `qmodel_38max` 恰好不受影响，故早期排查易误判为
          // 「该模型服务端故障」）。`agent` / `sec_scan` 等取值都能通。
          //
          // 源码依据：`MPi(A) { return A === 'sec_scan' ? 'security' : 'default' }`
          // —— 服务端按 `business.type` 选路由池，缺字段会走异常分支。
          business: { type: 'agent' },
        })
      } catch (error) {
        // wasm trap（裸 `unreachable`）在 glue 层已被改写；这里再兜一次，
        // 保证任何情况下都不会有裸 `unreachable` 冒到 UI。
        throw describeWasmFailure(error)
      } finally {
        // ⚠️⚠️ **释放失败绝不能顶替 `try` 块里的原始错误**：JS 的 `finally`
        // 里 `throw` 会无条件覆盖 `try` 的 `throw`，而 `dispose()` →
        // `freePointer()` 在**堆耗尽时确实会抛** —— 恰在本修复要治理的场景下。
        // 那会把上游的 401 / AUTH 改写成「WASM 堆耗尽」，同时丢掉可重试性判据。
        // ⇒ 释放是**清理动作**，它失败不该改变本次请求的结论。
        try {
          client?.dispose()
        } catch {
          // 刻意静默：本类没有 logger 通道，不为一条清理失败的日志新开通道。
        }
      }
    }

    // 3. 发送（⚠️ 头必须原样透传：Authorization 是 WASM 生成的
    //    `Bearer COSY.<载荷>.<签名>`，用普通 Bearer 覆盖会 403 Signature invalid）
    //
    // ## 三种 403 的语义**互不相同**，必须分开处理
    //
    // | 形态 | 判据 | 处理 |
    // |---|---|---|
    // | **排队** | 业务码 `10605`（`model_queued`） | 按服务端给的延迟**内部等待后重试**（见下） |
    // | 重复请求 | 业务码（客户端 `_TA="duplicate_request"`） | 不刷新凭据，直接重发一次 |
    // | 认证失败 | 业务码 `105`（`auth_error`）或 401 | 续期凭据后重试（**唯一**该走 refresh 的情形） |
    //
    // ⚠️ **真实缺陷**（用户报障，2026-09-27）：旧实现把**所有** 401/403 都当认证
    // 失败 → 排队时白白续期一次，再落到 harness 的 5 次通用退避（500/1000/2000/
    // 4000/8000 ≈ 共 15.5 秒）—— 而服务端明确要求等 30 秒，于是**永远等不到**；
    // 中国版那条「等 2 秒就能成功」的瞬时排队也因走错路径而反复失败。
    // ⚠️ **排队预算是「每账号」的**（2026-10-27 用户要求），故用 `let` 而不是
    // 一次算好的 `const`：换号时在下面**重新计时**。
    //
    // 语义：单账号排队累计超过 `resolveQueueTimeoutMs()`（默认 1 分钟）⇒ 换下一个
    // 账号重排；所有账号都排不上 ⇒ 报错。故一次请求的总上限是「账号数 × 预算」。
    let queueDeadline = Date.now() + resolveQueueTimeoutMs()
    let queueAttempts = 0
    let authRefreshed = false
    let duplicateRetried = false
    let response: Response
    /**
     * 已尝试过的账号 id（额度受限切号用）。
     *
     * ⚠️ 必须跨重试保留（不能在每次迭代里新建）：它是「**已试过哪些账号**」的
     * 记录，用来保证每个账号最多试一次、试完才判定「全部受限」。每次迭代重置
     * 会让切换在两个账号之间**无限来回**。
     */
    const triedAccounts = new Set<string>()
    /**
     * **当前生效账号的 id**（会随额度受限切号而更新）。
     *
     * ⚠️ 是**局部可变**状态、而不是每次都问 `this.options.currentAccountId()`：
     * 那个回调返回的是「池当前的默认账号」，一旦我们切到下一个账号它**不会跟着变**
     * —— 若用它标记，切到 B 后失败时会**再标记一次 A**，而 B 从未被标记，
     * 下次取号又把 B 选中，于是在 A/B 之间**反复空转**
     *（写单测时实测到了：标记记录是 `['acct-A','acct-A']` 而非 `['acct-A','acct-B']`）。
     */
    let activeAccountId = this.options.currentAccountId?.()
    if (activeAccountId !== undefined && activeAccountId.length > 0) {
      triedAccounts.add(activeAccountId)
    }
    // 4. 剥掉加密端点的响应信封，交给统一的 OpenAI SSE 消费器。
    //
    // ⚠️ **必须放在重试循环内**：排队错误的**第二种**下发形态是
    // **HTTP 200 + SSE 内嵌 `{code:"10605",…}` 帧**（真实缺陷，用户报障
    // 2026-09-27 —— 第一版修复只覆盖了 HTTP 403 形态，于是这条路径被
    // SSE 消费器归为 `SERVER` 直接抛给 harness，以 500…8000ms 快退避重试
    // 5 次，而服务端要求等 30 秒，**永远等不到**）。
    for (;;) {
      response = await this.sendEncrypted(await buildRequest(credential), options)

      if (!response.ok && (response.status === 401 || response.status === 403)) {
        // ⚠️ 必须**先读体再判断**，且 body 只能读一次 —— 排队信息就藏在
        // `message` 那个 JSON 字符串里（见 `parseQoderQueueError`）。
        const errorText = await response.text().catch(() => '')
        const queueInfo = parseQoderQueueError(errorText)

        if (queueInfo !== undefined) {
          const { waited } = await this.waitForQueue(queueInfo, ++queueAttempts, queueDeadline, options)
          if (waited) continue
          // 本账号排队预算耗尽 ⇒ 换号重排（不标记限流，理由见 switchAccountOnQueue）。
          const switched = await this.switchAccountOnQueue(options, triedAccounts, activeAccountId)
          if (switched !== undefined) {
            credential = switched.credential
            activeAccountId = switched.accountId
            authRefreshed = false // 新账号可再续期一次
            queueAttempts = 0
            queueDeadline = Date.now() + resolveQueueTimeoutMs() // 新账号重新计时
            continue
          }
          throw new LlmError('qoder: 排队等待超时（所有账号均排队）', 'QUEUE', { status: response.status })
        }

        // ⚠️ **额度受限也要切账号**（用户要求，2026-09-27）。
        //
        // 这条与 SSE 层那条**必须都有**：Qoder 的额度错误实测走 SSE 通道
        // （HTTP 200），但若哪天服务端改成用 HTTP 状态码下发，只处理一条就会漏。
        // 两处调用**同一个** `switchAccountOnQuota`，不会漂移。
        if (isBillingBusinessCode(response.status) || looksLikeBillingError(errorText)) {
          const switched = await this.switchAccountOnQuota(options, triedAccounts, activeAccountId)
          if (switched !== undefined) {
            credential = switched.credential
            activeAccountId = switched.accountId
            authRefreshed = false // 新账号可再续期一次
            continue
          }
          throw new LlmError(`qoder: ${errorDetail(errorText)}`, 'QUOTA_EXCEEDED', { status: response.status })
        }

        // 非排队：认证失败才续期（且每次请求最多一次，避免刷爆 userinfo）。
        if (!authRefreshed) {
          authRefreshed = true
          await this.options.refresh()
          const refreshed = await this.options.resolveCredential(options.model)
          if (refreshed === undefined || refreshed.access_token.length === 0) {
            throw new LlmError('qoder: credential expired and refresh failed', 'AUTH', { status: response.status })
          }
          credential = await this.ensureUid(refreshed)
          continue
        }
        throw new LlmError(`qoder: ${errorDetail(errorText)}`, httpErrorCode(response.status), { status: response.status })
      }

      // 重复请求（客户端 `duplicate_request`）：凭据没问题，重发一次即可。
      if (!response.ok && response.status === 409 && !duplicateRetried) {
        duplicateRetried = true
        continue
      }

      if (!response.ok) {
        const errorText = await response.text().catch(() => '')
        throw new LlmError(`qoder: ${errorDetail(errorText)}`, httpErrorCode(response.status), { status: response.status })
      }

      // ⚠️ 消费 SSE 时**捕获流内排队错误**，走与 HTTP 层**完全相同**的等待逻辑。
      // `consumeOpenAiSse` 是生成器：无法「try 一次再重试」，故这里手动迭代，
      // 捕获到排队就等待后重发整条请求（排队期间未产出任何 chunk，可安全重放）。
      const inner = consumeOpenAiSse(
        unwrapQoderEnvelopeStream(response, 'qoder'),
        { signal: options.signal },
        {
          label: 'qoder',
          firstTokenTimeoutMs: resolveFirstTokenTimeoutMs(),
          chunkTimeoutMs: resolveChunkTimeoutMs(),
        },
      )
      const iterator = inner[Symbol.asyncIterator]()
      let queued = false
      for (;;) {
        let step: IteratorResult<StreamChunk>
        try {
          step = await iterator.next()
        } catch (error) {
          if (error instanceof ModelQueuedError) {
            const { waited } = await this.waitForQueue(
              queueInfoOf(error),
              ++queueAttempts,
              queueDeadline,
              options,
            )
            if (waited) {
              queued = true
              break
            }
            // 本账号排队预算耗尽 ⇒ 换号重排（与 HTTP 层同一套判据，不标记限流）。
            const switched = await this.switchAccountOnQueue(options, triedAccounts, activeAccountId)
            if (switched === undefined) {
              throw new LlmError('qoder: 排队等待超时（所有账号均排队）', 'QUEUE')
            }
            credential = switched.credential
            activeAccountId = switched.accountId
            queueAttempts = 0
            queueDeadline = Date.now() + resolveQueueTimeoutMs() // 新账号重新计时
            queued = true // 复用「回到循环顶部重发」的语义
            break
          }
          // ⚠️ **额度受限（110）要标记 + 切账号**（用户要求，2026-09-27）。
          //
          // ⚠️ 必须**在这里**捕获（SSE 层）而不只在 HTTP 层：Qoder 的额度错误
          // 实测以 **HTTP 200 + SSE 内嵌帧** 下发（与排队同通道），
          // 只在 HTTP 层处理会漏掉真实链路。
          if (isQuotaExceededError(error)) {
            const switched = await this.switchAccountOnQuota(options, triedAccounts, activeAccountId)
            if (switched !== undefined) {
              credential = switched.credential
              activeAccountId = switched.accountId
              queued = true // 复用「回到循环顶部重发」的语义
              break
            }
            throw error // 无可用账号 → 如实抛出（已含额度语义）
          }
          throw error
        }
        if (step.done === true) break
        yield step.value
      }
      if (queued) continue
      return
    }
  }

  /**
   * 额度受限时：**标记当前账号该模型受限到 UTC+8 当日 24:00，然后切下一个账号**。
   *
   * ## 用户要求（2026-09-27）
   *
   * > qoder 碰到当日额度受限应该像 workbuddy/codebuddy 一样，设置一个模型受限时间
   * > （他们是返回错误中带时间，qoder 和 qodercn 需要自己设置当日 24:00 受限）
   * > 然后切换账号池中的下一个可用模型
   *
   * ## ⚠️ 与 buddy/CodeArts 的**关键差异**
   *
   * 它们的错误文案里**带重置时间**（`parseRateLimitError` 从中解析）；
   * Qoder **不带** —— 故这里用 {@link nextUtc8DayStartMs} **自己算**
   * 「UTC+8 当日 24:00」。**不能**复用 `parseRateLimitError`：它会因解析不到
   * 时间而退回「1 小时后」（`Date.now() + 3_600_000`），那对**按自然日**结算的
   * 额度是错的 —— 会让标记过早失效，用户 1 小时后再撞一次同样的墙。
   *
   * @param activeAccountId - **当前正在使用的**账号 id（见下）。
   * @returns 新凭据；无可用账号时 `undefined`（调用方如实抛出原错误）。
   */
  private async switchAccountOnQuota(
    options: GenerateOptions,
    tried: Set<string>,
    activeAccountId: string | undefined,
  ): Promise<{ credential: QoderCredential; accountId: string } | undefined> {
    const pool = this.options.accountPool
    if (pool === undefined) return undefined

    // ① 记录「本账号 + 本模型」受限到 UTC+8 当日 24:00。
    //
    // ⚠️ 只标记**该模型**（不标记账号全部模型）：额度是「模型 + 账号」维度的，
    // 该账号在别的模型上仍可能可用（`modelRateLimits` 的既有语义即如此）。
    //
    // ⚠️ 用的是调用方传入的 `activeAccountId`，**不是** `this.options.currentAccountId()`：
    // 后者是「会话启动时/池当前的默认账号」，一旦我们切换到下一个账号，它**不会
    // 跟着变** —— 若用它标记，切到 B 后失败时会**再标记一次 A**，而 B 从未被标记，
    // 下次取号又把 B 选中，导致在 A/B 之间**反复空转**（写单测时实测到了：
    // 标记记录是 `['acct-A','acct-A']` 而非 `['acct-A','acct-B']`）。
    if (activeAccountId !== undefined && activeAccountId.length > 0) {
      await pool.updateModelRateLimit(activeAccountId, options.model, nextUtc8DayStartMs())
      tried.add(activeAccountId)
    }

    // ② 取下一个可用账号。
    //
    // ⚠️ 必须传 `tried`：池按「限流重置时间最早到期」排序，**刚失败的账号可能
    // 仍排第一**，不排除就会拿回同一个、命中下面的检查而立即放弃切换。
    // （与 buddy 的注释同因，见 `buddy-adapter.ts` 的 1200 行附近。）
    const next = await pool.getAvailableAccount(this.product.id, options.model, tried)
    if (next === null || tried.has(next.entry.id)) return undefined
    tried.add(next.entry.id)

    const credential = next.credential as QoderCredential
    // 切号后必须重新过一遍 uid 补齐（每个账号的 uid 不同，缺了会签名无效）。
    return { credential: await this.ensureUid(credential), accountId: next.entry.id }
  }

  /**
   * 排队等待（HTTP 层与 SSE 层**共用**）。
   *
   * 两处形态必须走同一套判据，否则会再次出现「只修了一条路径」的缺陷。
   *
   * @returns `waited: true` = 已按服务端延迟等过，调用方应重发同一账号；
   *   `waited: false` = **本账号排队预算已耗尽**，调用方应**换个账号**重排
   *   （见 `switchAccountOnQueue`），换不到再报错。
   *
   * ⚠️ **不在这里抛超时错**：预算耗尽只意味着「这个账号排不上」，而池里
   * 可能还有别的账号能立刻排上（队列常与账号相关）。抛错就等于放弃了换号，
   * 正是 2026-10-27 用户报障「排队半小时」的成因。
   */
  private async waitForQueue(
    queueInfo: QoderQueueInfo | undefined,
    attempts: number,
    deadline: number,
    options: GenerateOptions,
  ): Promise<{ waited: boolean }> {
    // ⚠️ **先判时间、再判次数**：时间上限是硬约束（用户可调），次数上限只是
    // 防御性兜底。反过来写会让「180 次空转」在绝大多数情况下先生效，
    // 使 `DSH_QODER_QUEUE_TIMEOUT_MS` **形同虚设**（写用例时实测到了）。
    //
    // ⚠️ 用 `>=` 而不是 `>`：上限为 **0** 是合法配置（「不等，立即判超时 →
    // 立刻换号」），而同一毫秒内 `Date.now() > now + 0` 为 **false**，会让它
    // **先等一次**才超时 —— 那与「0 = 不等待」的语义不符（单测专门守这一点）。
    if (Date.now() >= deadline) return { waited: false }
    if (attempts > QUEUE_MAX_ATTEMPTS) return { waited: false }
    if (options.signal?.aborted === true) {
      throw new LlmError('qoder: 排队等待期间请求已取消', 'QUEUE')
    }
    const waitMs = qoderQueueDelayMs(queueInfo)
    // ⚠️ 拿不到服务端延迟时**不忙等**：用保守的短退避，避免瞬间烧掉机会
    // （客户端 W7c() 此时会退回 ltA() 指数退避）。
    await this.sleep(waitMs ?? 1_000, options.signal)
    // ⚠️ 这次检查**不是**上一次的重复：它检测的是「**等待期间**被中止」。
    // `AbortSignal.aborted` 是随时间的可变状态，但 TS 会静态窄化成字面量
    // `false` 而报「无重叠」—— 故经**不透明函数**读取，避免静态收窄掩盖
    // 这个真实场景（`await` 之后状态可能已变）。
    if (isAborted(options.signal)) {
      throw new LlmError('qoder: 排队等待期间请求已取消', 'QUEUE')
    }
    return { waited: true }
  }

  /**
   * 排队预算耗尽时：**换下一个账号重排**（不写限流标记）。
   *
   * ## 用户要求（2026-10-27）
   *
   * > 排队超过 1 分钟就自动切账号，全部都要超过 1 分钟就直接报错
   *
   * ## ⚠️ 与 `switchAccountOnQuota` 的关键差异：**不标记限流**
   *
   * 额度受限是**按自然日**的确定性状态 —— 该账号今天就是没额度了，故必须
   * `updateModelRateLimit` 标到 UTC+8 当日 24:00，后续请求也别再选它。
   *
   * 排队是**暂时**状态 —— 队列随时会通，几分钟后同一账号照样能用。若也标记，
   * 就会把一个好好的账号锁掉一整天（用户会看到「明明配额没用完却整天不选它」）。
   * 故这里只用**请求级**的 `tried` 排除集：本请求不再试它，但**不写池**，
   * 下个请求仍可正常选它。
   *
   * @param activeAccountId - 当前排队超时的账号（加入 `tried` 以免重选）。
   * @returns 新凭据；无可用账号时 `undefined`（调用方据此报错）。
   */
  private async switchAccountOnQueue(
    options: GenerateOptions,
    tried: Set<string>,
    activeAccountId: string | undefined,
  ): Promise<{ credential: QoderCredential; accountId: string } | undefined> {
    const pool = this.options.accountPool
    if (pool === undefined) return undefined

    // 只排除、**不标记**（与额度受限的区别，见方法注释）。
    if (activeAccountId !== undefined && activeAccountId.length > 0) {
      tried.add(activeAccountId)
    }

    // 传 `tried`：刚排不上的账号可能仍排在第一位，不排除就会拿回同一个、
    // 命中下面的检查而立即放弃切换（与 `switchAccountOnQuota` 同因）。
    const next = await pool.getAvailableAccount(this.product.id, options.model, tried)
    if (next === null || tried.has(next.entry.id)) return undefined
    tried.add(next.entry.id)

    const credential = next.credential as QoderCredential
    // 切号后必须重新过一遍 uid 补齐（每个账号的 uid 不同，缺了会签名无效）。
    return { credential: await this.ensureUid(credential), accountId: next.entry.id }
  }

  /**
   * 确保凭据带 **`uid`**（加密推理必需），必要时经注入钩子补齐。
   *
   * ⚠️ 缺 uid 时**不能静默用空串发请求** —— 那样 WASM 会产出签名无效的
   * 请求，服务端回 `Signature invalid (101)`，用户看到的是「签名错误」
   * 而非「凭据不完整」，极难定位（真实缺陷）。这里宁可明确报错。
   */
  private async ensureUid(credential: QoderCredential): Promise<QoderCredential> {
    if (credential.uid !== undefined && credential.uid.length > 0) return credential

    const patched = await this.options.resolveUid?.(credential)
    if (patched?.uid !== undefined && patched.uid.length > 0) return patched

    throw new LlmError(
      'qoder: 凭据缺少 uid，加密推理无法签名（请重新登录该账号）',
      'MISSING_CREDENTIAL',
    )
  }

  /** 发送一次**加密**推理请求（`agent_chat_generation`）。 */
  private async sendEncrypted(
    request: { url: string; headers: Record<string, string>; body: string },
    options: GenerateOptions,
  ): Promise<Response> {
    const headers = new Headers(request.headers)
    headers.set('Accept', 'text/event-stream')
    try {
      return await this.fetchImpl(request.url, {
        method: 'POST',
        headers,
        body: request.body,
        signal: options.signal,
      })
    } catch (error) {
      if (options.signal?.aborted) throw error
      if (isTransportError(error)) {
        throw new LlmError(`qoder: transport error: ${error instanceof Error ? error.message : String(error)}`,
          'TRANSPORT', { cause: error as Error })
      }
      throw error
    }
  }
}

/**
 * 判断当前是否落在错峰折扣窗口内（本地推算）。
 *
 * ⚠️ **为什么不直接用目录的 `promotion.active`**：那是**目录下发那一刻**的
 * 快照，客户端长时间不重启就会过期 —— 用它会让用户在窗口外看到折后价
 * （按折扣价预期、实际按原价计费），或窗口内看不到折扣。
 * 窗口本身（`windowStart`/`windowEnd`）稳定，故按当前时间**本地推算**。
 *
 * 窗口按 **UTC+8** 计（目录 `timezone: Asia/Singapore`，与用户所在时区一致）；
 * 支持跨零点（如 22:00–08:00）。窗口字段缺失时回退到目录的 `active`。
 */
export function promotionActiveNow(promotion: QoderModelPromotion, now: Date): boolean {
  const { windowStart, windowEnd } = promotion
  if (windowStart === undefined || windowEnd === undefined) return promotion.active
  const toMinutes = (hhmm: string): number | undefined => {
    const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm.trim())
    if (m === null) return undefined
    const h = Number(m[1]); const min = Number(m[2])
    return h < 24 && min < 60 ? h * 60 + min : undefined
  }
  const start = toMinutes(windowStart)
  const end = toMinutes(windowEnd)
  if (start === undefined || end === undefined) return promotion.active

  // 取 UTC+8 的「墙上时间」（目录时区与用户一致，故无需真实时区换算）
  const utc8 = new Date(now.getTime() + 8 * 3_600_000)
  const minutes = utc8.getUTCHours() * 60 + utc8.getUTCMinutes()
  return start <= end
    ? minutes >= start && minutes < end
    : minutes >= start || minutes < end
}

/**
 * 生成模型选择器里显示的名字。
 *
 * 形态（**与 TRAE / buddy 三 provider 统一**）：
 *
 * ```
 * Qwen3.8-Flash · 免费            ← priceFactor = 0
 * Qwen3.8-Max · x0.5→x0.2        ← 折扣窗口内：原价→折后价
 * Qwen3.8-Max · x0.5             ← 窗口外：只有原价
 * Sonus · x8                     ← 无促销
 * ```
 *
 * ⚠️ **倍率必须写进 `name` 而不是 `description`**：composer 的模型切换菜单
 * 只渲染 `name`（见 dsh-client-ui-model-selection 的 ModelSelect：
 * `children: model.name`），`description` 仅用于 `/model` 弹窗。
 *
 * ⚠️ **折扣统一用「原价→折后价」箭头**，不再附中文角标（如「错峰 4 折」）：
 * ① 旧形态只有折后价，看不出原价与折扣幅度；② 角标与数字**冗余**
 * （0.2/0.5 本就是 4 折）。TRAE（`x0.4→x0.2`）与 buddy（`x0.79→x0.50`）
 * 早就是这个形态，本次把 Qoder 对齐过去。
 *
 * ⚠️ 折后价**不直接采信目录的 `priceFactor`**：它是采集时刻的生效价，
 * 窗口切换后即失真。改为按 `beforePromotionPriceFactor × discountFactor`
 * 本地推算（实测三条全部吻合），窗口外则用原价。
 */
export function qoderDisplayName(model: QoderFallbackModel, now: Date = new Date()): string {
  const promo = model.promotion
  const before = promo?.beforePromotionPriceFactor
  const discount = promo?.discountFactor
  const hasPromo = promo !== undefined && before !== undefined && discount !== undefined
  const active = hasPromo && promotionActiveNow(promo, now)

  // 免费优先于一切（`0` 是合法倍率，不能显示成 `x0`）。
  if (model.priceFactor === 0) return `${model.name} · 免费`

  if (hasPromo && active) {
    // 折扣生效中：`原价→折后价`（与 TRAE / buddy 同形态）
    const effective = Number((before * discount).toFixed(4))
    return `${model.name} · x${before}→x${effective}`
  }

  // 窗口外用**原价**（有 promotion 时原价就是 before，而非采集到的折后价）；
  // 窗口外显示折后价会让用户按折扣价预期、实际被按原价计费。
  const price = hasPromo ? before : model.priceFactor
  return price !== undefined ? `${model.name} · x${price}` : model.name
}

/**
 * 在 `ctx.llm` 上注册 Qoder provider 路由与适配器。
 *
 * 路由名与配置页展示名由产品配置驱动，得到 `qoder`。`settingsNs` 经
 * `settingsNamespaceFor()` 解析：老契约（≤0.1.6）下是 `llm-qoder`；
 * 0.1.7-rc.1 起 settings 命名空间只能是 profile 条目 id，故解析为本插件条目 id。
 */
export function registerQoderLlm(ctx: Context, options: QoderAdapterOptions): QoderAdapter {
  const product = options.product ?? QODER
  ctx.llm.registerConfigurableProviders([
    {
      provider: product.id,
      displayName: product.displayName,
      settingsNs: settingsNamespaceFor(ctx, `llm-${product.id}`),
      settingsPath: [],
    },
  ])
  const adapter = new QoderAdapter(options)
  ctx.llm.registerAdapter([product.id], adapter)
  // 返回实例：Jet Hub「显示列表」需要 `listAllModels()`（不受黑名单影响、
  // 带最终展示名/倍率）。`ctx.llm` 不透传自定义方法，须由调用方持有引用。
  return adapter
}
