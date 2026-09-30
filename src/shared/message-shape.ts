/**
 * 消息形状归一化：把各种**入站**形态降级为「既有序列化实现已理解」的形状。
 *
 * ## 为什么这个模块在 all_proxy 里仍然必要
 *
 * 本项目移植自 DSH 插件，而**被移植的序列化实现**（`serializeMessages` 等）
 * 统一按两种约定读取消息：
 *
 * - 工具结果在 user 消息的 `tool-result` 块里（`toolCallId` **驼峰**）；
 * - assistant 的正文与工具调用都在 `content` **数组**里（`text` / `tool-call` 块）。
 *
 * 但对外 API 收到的是三种形态：
 *
 * | 来源 | assistant 的工具调用 | 工具结果 |
 * |---|---|---|
 * | DSH 0.1.7+ | `content` 数组里的 `tool-call` 块 | 一等 `role:'tool'`，`toolCallId` 驼峰 |
 * | OpenAI Chat Completions | **顶层 `tool_calls`**（`content` 常为 `null`） | 一等 `role:'tool'`，**`tool_call_id` 蛇形** |
 * | Anthropic Messages | 翻译层已转成顶层 `tool_calls` | 翻译层已转成一等 `role:'tool'` |
 *
 * 若不做归一化，主流程有两处静默失效（都是 2026-09-29 实测复现的真实缺陷）：
 *
 * 1. **顶层 `tool_calls` 与蛇形 `tool_call_id` 被无视**。序列化只遍历
 *    `content` 数组找 `type:'tool-call'` 块，而 OpenAI 把它挂在消息**顶层**、
 *    `content` 为 `null`；结果 id 又只读驼峰 `toolCallId`，蛇形取不到 →
 *    变成 `undefined` → `resolveToolPairing` 的 `allResultIds` 收集不到配对
 *    → **assistant 的 `tool_calls` 与全部工具结果被成对剔除**。
 *    表现为模型完全失忆（每轮重新发起同一调用，`prompt_tokens` 逐字节恒定）。
 * 2. **assistant 的字符串 `content` 被当成空数组**。序列化用
 *    `Array.isArray(content) ? content : []` 取值，于是**纯文本会话**里
 *    模型说过的每一句历史回复都会变成空串 —— 不需要任何工具就能触发。
 *
 * ## 设计取舍
 *
 * 把新形态**降级/升级**为既有实现已理解的形状，而不是改造那些已被大量单测与
 * 线上流量验证的序列化实现（那有 5 份独立副本，且分属不同 provider 的成熟路径）。
 * 归一化集中在本模块，改动收敛为「每个入口插一次调用」。
 *
 * 探测用**形状**而非版本号：形状就在入参里，且对「升级期混合形态」天然鲁棒。
 *
 * ⚠️ **不得读取 `tool_calls` 之外的 provider 私有字段**：本模块是 6 个适配器
 * 的共用入口，只应识别**公开协议形状**。
 */

/** 传入的消息（只需 role / content / 工具 id 等维度）。 */
export interface HarnessMessageLike {
  role: string
  content?: unknown
  toolCallId?: unknown
  /** OpenAI 线格式的工具结果 id（蛇形）。 */
  tool_call_id?: unknown
  /** OpenAI 线格式的工具调用数组（挂在 assistant 消息顶层）。 */
  tool_calls?: unknown
  isError?: unknown
  [key: string]: unknown
}

/** 归一化探测结果。 */
export type MessageShape =
  /** 工具结果包裹在 user 消息的 `tool-result` 块里（既有实现期望的形状）。 */
  | 'legacy'
  /** 工具结果是一等 `role:'tool'` 消息。 */
  | 'tool-role'
  /** OpenAI 原生形态：assistant 的 `tool_calls` 在**顶层**、`content` 常为 null。 */
  | 'openai-native'
  /** 整段历史没有任何工具结果。 */
  | 'none'

/** 判断一个 content 块是否为包裹式的 `tool-result` 块。 */
function isWrappedToolResult(block: unknown): boolean {
  return typeof block === 'object' && block !== null
    && (block as { type?: unknown }).type === 'tool-result'
}

/**
 * 从顶层 `system` 参数读出纯文本。
 *
 * 认两种形态：**字符串**（OpenAI 风格）与**内容块数组**
 * （Anthropic 风格，形如 `[{type:'text', text:'…'}]`）。
 *
 * ⚠️ **两条入站路径必须共用本函数**（真实缺陷，2026-09-29）：Anthropic 翻译层
 * 早就认数组，而 OpenAI 分支只认字符串 —— 客户端用数组形式传 system 时，
 * 指令会被**静默丢弃**，于是 wire 首条不再是 system。对 WorkBuddy 这类强制
 * 要求 `messages[0]` 为 system 的上游，直接变成 HTTP 400
 * `code 11128 "first message is not system prompt"`，且该错误被上游
 * `displayMsg` 伪装成「请求被安全策略拦截」，与真实原因毫无关系。
 *
 * 多块的拼接方式与 Anthropic 翻译层保持一致（`\n` 连接、丢弃空块）。
 *
 * @returns 归一化后的文本；无有效内容时返回 `undefined`（**不返回空串**，
 *          以便调用方区分「没有 system」与「system 是空字符串」）。
 */
export function readSystemText(system: unknown): string | undefined {
  if (typeof system === 'string') return system.length > 0 ? system : undefined
  if (!Array.isArray(system)) return undefined
  const text = system
    .map(block => (typeof block === 'object' && block !== null
      && typeof (block as { text?: unknown }).text === 'string'
      ? (block as { text: string }).text
      : ''))
    .filter(part => part.length > 0)
    .join('\n')
  return text.length > 0 ? text : undefined
}

/** 判断一条消息是否为一等工具结果消息。 */
function isToolRoleMessage(message: HarnessMessageLike): boolean {
  return message.role === 'tool'
}

/**
 * 判断一条消息是否携带 **OpenAI 线格式的顶层 `tool_calls`**。
 *
 * 这是「assistant 的工具调用不在 content 数组里」的权威判据，与
 * `role:'tool'` 相互独立 —— 一次工具往返里 assistant 侧与结果侧各自成立，
 * 而两者可能被分别修复（例如历史被截断只剩 assistant 侧）。
 */
function hasTopLevelToolCalls(message: HarnessMessageLike): boolean {
  if (message.role !== 'assistant') return false
  return Array.isArray(message.tool_calls) && message.tool_calls.length > 0
}

/**
 * 探测整段历史的消息形状。
 *
 * ⚠️ **`.tool_calls` 认**（即便同时存在 `role:'tool'`）。一次 OpenAI 原生往返
 * 两处信号同时成立，但归一的**动作**是分开的，故两者都要探测到。
 *
 * ⚠️ **同时出现多种形态时以覆盖面最广的为准**：升级期的会话可能前半段是旧形态、
 * 后半段是新形态，而 `tool` 角色是新形态的权威判据。反之若判成 `legacy`，
 * 新形态的工具结果会被漏掉，等于没修。
 *
 * @param messages - 完整消息序列。
 * @returns 该历史使用的形状。
 */
export function detectMessageShape(messages: readonly HarnessMessageLike[]): MessageShape {
  let sawLegacy = false
  for (const message of messages) {
    if (isToolRoleMessage(message)) return 'tool-role'
    if (hasTopLevelToolCalls(message)) return 'openai-native'
    const content = message.content
    if (Array.isArray(content) && content.some(isWrappedToolResult)) sawLegacy = true
  }
  return sawLegacy ? 'legacy' : 'none'
}

/**
 * 把一条 assistant 消息的**顶层 `tool_calls`** 搬运为 content 数组里的
 * `tool-call` 块（既有序列化实现唯一认识的形态）。
 *
 * 与既有 content 块**合并**而非覆盖：OpenAI 允许 assistant 同时带正文与工具调用
 * （`content: "我查一下"` + `tool_calls: [...]`）。覆盖会让正文凭空消失。
 *
 * ⚠️ **参数原样透传为字符串**：OpenAI 的 `function.arguments` 本就是 JSON 字符串，
 * 而内部 `tool-call` 块的 `arguments` 也约定为字符串（下游 `normalizeToolArguments`
 * 会做校验与回退）。此处若先解析再序列化，会把「参数被截断的残缺 JSON」变成
 * 抛错或静默变成 `{}`，丢掉下游那条「残缺参数」的专门处理。
 */
function hoistTopLevelToolCalls(message: HarnessMessageLike): HarnessMessageLike {
  if (!hasTopLevelToolCalls(message)) return message
  const raw = message.tool_calls as unknown[]
  const blocks: Array<Record<string, unknown>> = []
  for (const item of raw) {
    if (typeof item !== 'object' || item === null) continue
    const call = item as { id?: unknown; function?: { name?: unknown; arguments?: unknown } }
    blocks.push({
      type: 'tool-call',
      id: call.id,
      name: call.function?.name,
      arguments: call.function?.arguments,
    })
  }
  if (blocks.length === 0) return message
  // 已有 content 块（数组）保留在前，工具调用追加在后；字符串正文升为 text 块。
  const existing = Array.isArray(message.content)
    ? message.content as unknown[]
    : (typeof message.content === 'string' && message.content.length > 0
        ? [{ type: 'text', text: message.content }]
        : [])
  // 顶层 `tool_calls` 已搬运进 content，**必须移除**原字段：留着会让下游
  // 再次看到它（例如 qoder 的私有 wire 转换），造成工具调用重复下发。
  const { tool_calls: _dropped, ...rest } = message
  return { ...rest, content: [...existing, ...blocks] }
}

/**
 * 把 assistant 的**字符串正文**升级为 content 块数组。
 *
 * 既有序列化实现一律用 `Array.isArray(content) ? content : []` 取值，于是
 * OpenAI 原生形态的 `content: "模型说过的话"` 会被当成**空数组**丢弃 ——
 * 纯文本多轮会话里模型的每句历史回复都会变成空串（2026-09-29 实测复现）。
 *
 * 只动 assistant：user 的字符串 content 是既有实现的正常输入路径
 * （`contentToText` 对字符串原样返回），动了反而多余。
 */
function upgradeAssistantTextContent(message: HarnessMessageLike): HarnessMessageLike {
  if (message.role !== 'assistant') return message
  if (typeof message.content !== 'string') return message
  if (message.content.length === 0) return message
  return { ...message, content: [{ type: 'text', text: message.content }] }
}

/**
 * 把一等 `tool` 消息降级为包裹形状。
 *
 * 规则：
 * - `role:'tool'` → `role:'user'`，content 包成单个 `{type:'tool-result',...}` 块，
 *   id 依次取 **`tool_call_id`（OpenAI 线格式，蛇形）→ `toolCallId`（DSH 0.1.7，驼峰）
 *   → `source.callId`**，`isError` **仅在存在时**携带（避免给下游造出
 *   `isError: undefined` 的差异）；
 * - `role:'developer'` → **丢弃**。它只承载工具增删元数据，不是对话内容；
 * - 其余消息**原样透传**（保持引用身份）。
 *
 * ⚠️ **`content` 数组整体保留、不压平** —— 既有实现依赖内嵌 `image` 块做图片提升
 * （工具结果内嵌图片须挂到其后的独立 user 消息），压平会让图片静默丢失。
 *
 * ⚠️ **三种 id 字段名都要认**（真实缺陷，2026-09-29）：OpenAI 客户端发的是蛇形
 * `tool_call_id`，早期只读驼峰 `toolCallId`，于是标准 OpenAI 形态的工具结果 id
 * 恒为 `undefined` → 配对全灭 → `tool_calls` 与工具结果被成对剔除。
 *
 * @param messages - 完整消息序列。
 * @returns 归一化后的消息序列；**无需改动时返回原数组引用**（零成本透传）。
 */
export function normalizeHarnessMessages<T extends HarnessMessageLike>(
  messages: readonly T[],
): readonly HarnessMessageLike[] {
  // 三个判据相互独立，故分别求值：
  // ① `shape` 决定工具结果长什么样；
  // ② `developer` 是另一维度的角色（只承载工具增删元数据），无论有没有工具结果都必须剥离；
  // ③ assistant 的字符串正文 / 顶层 `tool_calls` 是 OpenAI 原生形态的特征，
  //    即使整段历史**没有任何工具结果**（`shape === 'none'`）也需要升级。
  const shape = detectMessageShape(messages)
  const hasDeveloper = messages.some(message => message.role === 'developer')
  const needsAssistantUpgrade = messages.some(message =>
    hasTopLevelToolCalls(message)
    || (message.role === 'assistant' && typeof message.content === 'string' && message.content.length > 0))
  if (shape !== 'tool-role' && !hasDeveloper && !needsAssistantUpgrade) {
    // 已是既有形状：连数组身份都不变，确保既有行为逐字节不受影响。
    return messages
  }
  const normalized: HarnessMessageLike[] = []
  for (const message of messages) {
    if (message.role === 'developer') continue
    if (isToolRoleMessage(message)) {
      // `source.callId` 是伴随字段；顶层缺失时回退它，
      // 两者都缺则保持 undefined（下游按「无 id」处理，与旧行为一致）。
      const source = message['source']
      const sourceCallId = typeof source === 'object' && source !== null
        ? (source as { callId?: unknown }).callId
        : undefined
      const toolCallId = message.tool_call_id ?? message.toolCallId ?? sourceCallId
      const block: Record<string, unknown> = {
        type: 'tool-result',
        toolCallId,
        content: message.content,
      }
      if (message.isError !== undefined) block.isError = message.isError
      normalized.push({ role: 'user', content: [block] })
      continue
    }
    // assistant：先搬顶层 tool_calls，再把字符串正文升级为块数组。顺序无关
    // （两者作用于不同字段），但 hoist 已把字符串正文并入 content，故须先 hoist。
    normalized.push(upgradeAssistantTextContent(hoistTopLevelToolCalls(message)))
  }
  return normalized
}
