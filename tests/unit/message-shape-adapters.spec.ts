/**
 * 0.1.7 消息形状双兼容：序列化等价性回归。
 *
 * 核心不变式：**同一份语义数据，按 0.1.5 形状与 0.1.7 形状分别喂入，
 * 序列化输出必须逐字节等价**。
 *
 * 这条不变式比"逐个断言字段"更强 —— 它直接锁住"0.1.7 不会让工具调用丢失"
 * 这一修复目标，且对实现方式保持中立。
 */
import { describe, expect, it } from 'vitest'
import { serializeMessages as serializeCodeArts } from '../../src/providers/llm-adapter.js'
import { serializeMessages as serializeOpenAiCompat } from '../../src/providers/openai-compat.js'
import { resolveToolPairing } from '../../src/providers/sse.js'

/**
 * 一段带两次工具调用与两个结果的历史。
 *
 * `shape` 决定工具结果的承载方式：
 * - `legacy`：0.1.5，包裹在 user 消息的 `tool-result` 块里；
 * - `tool-role`：0.1.7，一等 `tool` 消息（`toolCallId`/`isError` 在顶层）；
 * - `openai-native`：标准 OpenAI 线格式 —— assistant 的 `tool_calls` 在**顶层**、
 *   `content` 为 `null`，工具结果是一等 `role:'tool'` 且 id 用**蛇形** `tool_call_id`。
 */
function history(shape: 'legacy' | 'tool-role' | 'openai-native'): Array<Record<string, unknown>> {
  const head: Array<Record<string, unknown>> = [
    { role: 'system', content: [{ type: 'text', text: 'SYS' }] },
    { role: 'user', content: [{ type: 'text', text: 'TASK' }] },
  ]
  const results = [
    { id: 'call_a', text: 'FILE A' },
    { id: 'call_b', text: 'MATCH B' },
  ]
  // openai-native 的 assistant 走**顶层** tool_calls + content:null。
  head.push(shape === 'openai-native'
    ? {
      role: 'assistant',
      content: null,
      tool_calls: [
        { id: 'call_a', type: 'function', function: { name: 'read', arguments: '{"file_path":"a.ts"}' } },
        { id: 'call_b', type: 'function', function: { name: 'grep', arguments: '{"pattern":"x"}' } },
      ],
    }
    : {
      role: 'assistant',
      content: [
        { type: 'reasoning', text: 'think' },
        { type: 'text', text: 'working' },
        { type: 'tool-call', id: 'call_a', name: 'read', arguments: '{"file_path":"a.ts"}' },
        { type: 'tool-call', id: 'call_b', name: 'grep', arguments: '{"pattern":"x"}' },
      ],
    })
  const tail = shape === 'legacy'
    ? results.map(result => ({
      role: 'user',
      content: [{
        type: 'tool-result',
        toolCallId: result.id,
        content: [{ type: 'text', text: result.text }],
        isError: false,
      }],
    }))
    : shape === 'openai-native'
      ? results.map(result => ({
        role: 'tool',
        tool_call_id: result.id,
        content: result.text,
      }))
      : results.map(result => ({
        role: 'tool',
        toolCallId: result.id,
        content: [{ type: 'text', text: result.text }],
        isError: false,
        source: { kind: 'tool', callId: result.id },
      }))
  return [...head, ...tail]
}

describe('resolveToolPairing 跨形状等价', () => {
  // 真实缺陷的判据：0.1.7 形状下若结果为 0，assistant 的 tool_calls 会被
  // 整体剔除，模型完全看不到自己调用过什么 —— 表现为提前结束或循环思考。
  it('keeps every tool call under both shapes', () => {
    const legacy = resolveToolPairing(history('legacy'))
    const toolRole = resolveToolPairing(history('tool-role'))
    expect(legacy.keepCallIds.size).toBe(2)
    expect(toolRole.keepCallIds.size).toBe(legacy.keepCallIds.size)
    expect(toolRole.keepResultIds.size).toBe(legacy.keepResultIds.size)
  })

  it('keeps every tool call under the OpenAI-native shape too', () => {
    // 2026-09-29 真实缺陷：标准 OpenAI 入站（顶层 tool_calls + 蛇形
    // tool_call_id）曾让 keepCallIds/keepResultIds 双双为空 —— 工具历史整段
    // 蒸发，模型每轮重新发起同一调用，prompt_tokens 逐字节恒定。
    const legacy = resolveToolPairing(history('legacy'))
    const native = resolveToolPairing(history('openai-native'))
    expect(native.keepCallIds.size).toBe(legacy.keepCallIds.size)
    expect([...native.keepCallIds].sort()).toEqual([...legacy.keepCallIds].sort())
    expect([...native.keepResultIds].sort()).toEqual([...legacy.keepResultIds].sort())
  })

  it('keeps the exact same call ids under both shapes', () => {
    const legacy = resolveToolPairing(history('legacy'))
    const toolRole = resolveToolPairing(history('tool-role'))
    expect([...toolRole.keepCallIds].sort()).toEqual([...legacy.keepCallIds].sort())
  })

  it('still drops orphan tool calls (regression guard for the original defense)', () => {
    // 原有防线不能被削弱：无结果的调用必须仍被剔除，否则后端 400。
    const messages = history('tool-role').filter(message =>
      !(message.role === 'tool' && message.toolCallId === 'call_b'))
    const { keepCallIds } = resolveToolPairing(messages)
    expect(keepCallIds.size).toBe(0)
  })
})

describe('serializeMessages 跨形状等价', () => {
  it('produces identical CodeArts wire bodies', () => {
    expect(serializeCodeArts(history('tool-role'))).toEqual(serializeCodeArts(history('legacy')))
  })

  it('produces identical OpenAI-compatible wire bodies', () => {
    expect(serializeOpenAiCompat(history('tool-role'))).toEqual(serializeOpenAiCompat(history('legacy')))
  })

  it('produces the same tool history under the OpenAI-native shape as legacy', () => {
    // 端到端判据：标准 OpenAI 入站必须与内部形状产出**等价的工具历史**。
    // 只比对「工具相关结构」而非整串输出：三种形状的正文表意不同
    // （openai-native 的 content 是 null，legacy 带 'working' 正文），
    // 断言整串相等会把无关差异也算成失败。
    const pick = (wire: Array<Record<string, unknown>>): unknown => ({
      calls: wire.filter(m => m['role'] === 'assistant').map(m => m['tool_calls'] ?? null),
      results: wire
        .filter(m => m['role'] === 'tool')
        .map(m => ({ id: m['tool_call_id'], content: m['content'] })),
    })
    const legacy = pick(serializeOpenAiCompat(history('legacy')))
    const native = pick(serializeOpenAiCompat(history('openai-native')))
    expect(native).toEqual(legacy)
    // 反向守卫：避免两边同时为空而假通过。
    expect((legacy as { results: unknown[] }).results).toHaveLength(2)
  })

  it('emits both tool calls and both tool results under 0.1.7', () => {
    // 直接断言"没丢东西"，避免等价性测试因两边同时为空而假通过。
    const wire = serializeCodeArts(history('tool-role'))
    const assistant = wire.find(message => message.role === 'assistant') as { tool_calls?: unknown[] }
    expect(assistant.tool_calls).toHaveLength(2)
    const toolMessages = wire.filter(message => message.role === 'tool')
    expect(toolMessages).toHaveLength(2)
    expect(toolMessages.map(message => (message as { tool_call_id: string }).tool_call_id).sort())
      .toEqual(['call_a', 'call_b'])
  })

  it('emits both tool calls and both tool results under the OpenAI-native shape', () => {
    const wire = serializeCodeArts(history('openai-native'))
    const assistant = wire.find(message => message.role === 'assistant') as { tool_calls?: unknown[] }
    expect(assistant.tool_calls).toHaveLength(2)
    const toolMessages = wire.filter(message => message.role === 'tool')
    expect(toolMessages).toHaveLength(2)
    expect(toolMessages.map(message => (message as { tool_call_id: string }).tool_call_id).sort())
      .toEqual(['call_a', 'call_b'])
  })

  it('preserves tool result text under 0.1.7', () => {
    const wire = serializeCodeArts(history('tool-role'))
    const texts = wire
      .filter(message => message.role === 'tool')
      .map(message => String((message as { content: unknown }).content))
    expect(texts).toEqual(['FILE A', 'MATCH B'])
  })
})
