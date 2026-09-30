import { describe, expect, it } from 'vitest'
import {
  detectMessageShape,
  normalizeHarnessMessages,
  readSystemText,
} from '../../src/shared/message-shape.js'

/** 包裹形状：工具结果在 user 消息的 `tool-result` 块里。 */
function legacyMessages(): Array<Record<string, unknown>> {
  return [
    { role: 'system', content: [{ type: 'text', text: 'sys' }] },
    { role: 'user', content: [{ type: 'text', text: 'do it' }] },
    {
      role: 'assistant',
      content: [
        { type: 'text', text: 'calling' },
        { type: 'tool-call', id: 'call_a', name: 'read', arguments: '{"p":"a"}' },
      ],
    },
    {
      role: 'user',
      content: [{ type: 'tool-result', toolCallId: 'call_a', content: [{ type: 'text', text: 'A' }], isError: false }],
    },
  ]
}

/** 一等 tool 消息形状：callId/isError 在顶层。 */
function toolRoleMessages(): Array<Record<string, unknown>> {
  return [
    { role: 'system', content: [{ type: 'text', text: 'sys' }] },
    { role: 'user', content: [{ type: 'text', text: 'do it' }] },
    {
      role: 'assistant',
      content: [
        { type: 'text', text: 'calling' },
        { type: 'tool-call', id: 'call_a', name: 'read', arguments: '{"p":"a"}' },
      ],
    },
    {
      role: 'tool',
      toolCallId: 'call_a',
      content: [{ type: 'text', text: 'A' }],
      isError: false,
      source: { kind: 'tool', callId: 'call_a' },
    },
  ]
}

describe('detectMessageShape', () => {
  it('reports legacy for messages carrying wrapped tool-result blocks', () => {
    expect(detectMessageShape(legacyMessages())).toBe('legacy')
  })

  it('reports tool-role for first-class tool messages', () => {
    expect(detectMessageShape(toolRoleMessages())).toBe('tool-role')
  })

  it('reports none when the conversation has no tool results at all', () => {
    expect(detectMessageShape([
      { role: 'user', content: [{ type: 'text', text: 'hi' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'hello' }] },
    ])).toBe('none')
  })

  it('prefers tool-role when both shapes appear in one history', () => {
    // 升级期会话可能同时含两种形态；一等 tool 消息是权威判据。
    expect(detectMessageShape([...legacyMessages(), ...toolRoleMessages().slice(3)])).toBe('tool-role')
  })
})

describe('normalizeHarnessMessages', () => {
  // 核心契约：归一化后必须与既有实现期望的形状逐字节等价，
  // 这样被移植的序列化实现无需任何改动即可正确工作。
  it('converts first-class tool messages into the wrapped shape', () => {
    const normalized = normalizeHarnessMessages(toolRoleMessages())
    expect(normalized).toEqual(legacyMessages())
  })

  it('returns the identical array reference for legacy input (zero-cost passthrough)', () => {
    // 已是既有形状时必须完全不受影响：连数组身份都不能变。
    const input = legacyMessages()
    expect(normalizeHarnessMessages(input)).toBe(input)
  })

  it('returns the identical array reference when no tool results exist', () => {
    const input = [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }]
    expect(normalizeHarnessMessages(input)).toBe(input)
  })

  it('drops developer messages that carry no conversation content', () => {
    // developer 消息只承载工具增删元数据；此处兜底避免其被当成用户输入下发。
    const input = [
      { role: 'user', content: [{ type: 'text', text: 'hi' }] },
      { role: 'developer', content: [{ type: 'tool-addition', toolName: 'read' }] },
    ]
    const normalized = normalizeHarnessMessages(input)
    expect(normalized).toHaveLength(1)
    expect(normalized[0]!.role).toBe('user')
  })

  it('preserves tool-result content arrays verbatim, including nested images', () => {
    // 既有实现依赖内嵌图片块做图片提升；归一化不得压平 content。
    const image = { type: 'image', attachment: { attachmentId: 'img-1' } }
    const normalized = normalizeHarnessMessages([
      {
        role: 'tool',
        toolCallId: 'call_a',
        content: [{ type: 'text', text: 'A' }, image],
        isError: true,
      },
    ])
    expect(normalized).toEqual([
      {
        role: 'user',
        content: [{ type: 'tool-result', toolCallId: 'call_a', content: [{ type: 'text', text: 'A' }, image], isError: true }],
      },
    ])
  })

  it('omits isError when the source message omits it', () => {
    const normalized = normalizeHarnessMessages([
      { role: 'tool', toolCallId: 'call_a', content: [{ type: 'text', text: 'A' }] },
    ])
    const block = (normalized[0]!.content as Array<Record<string, unknown>>)[0]!
    expect('isError' in block).toBe(false)
  })

  it('is idempotent: normalizing the output again changes nothing', () => {
    const once = normalizeHarnessMessages(toolRoleMessages())
    expect(normalizeHarnessMessages(once)).toBe(once)
  })

  it('keeps string user content untouched', () => {
    const input = [{ role: 'user', content: 'plain string' }]
    expect(normalizeHarnessMessages(input)).toBe(input)
  })

  // 真实 session 迁移后的字段全貌：tool 消息带 `source.callId` 与 `id` 两个伴随字段。
  // fixture 用真实字段名，防止只在自造的精简形状上通过、却在真实数据上失效。
  it('handles the real tool message field layout', () => {
    const normalized = normalizeHarnessMessages([{
      role: 'tool',
      source: { kind: 'tool', callId: 'call_00_Cow4laxB9D4vdipbJ6aH8033' },
      toolCallId: 'call_00_Cow4laxB9D4vdipbJ6aH8033',
      content: [{ type: 'text', text: 'Path\n----\nD:\\jet\\code\\pg\\rdeveco-code' }],
      isError: false,
      id: '2f80db70-9ce2-415b-afd3-73acaf05f652',
    }])
    expect(normalized).toEqual([{
      role: 'user',
      content: [{
        type: 'tool-result',
        toolCallId: 'call_00_Cow4laxB9D4vdipbJ6aH8033',
        content: [{ type: 'text', text: 'Path\n----\nD:\\jet\\code\\pg\\rdeveco-code' }],
        isError: false,
      }],
    }])
  })

  it('falls back to source.callId when the top-level toolCallId is absent', () => {
    // 顶层 `toolCallId` 是主判据；`source.callId` 是伴随字段。
    // 只要有其一就不该丢 id —— 丢了会让工具结果变成无法配对的孤儿。
    const normalized = normalizeHarnessMessages([{
      role: 'tool',
      source: { kind: 'tool', callId: 'call_from_source' },
      content: [{ type: 'text', text: 'X' }],
    }])
    const block = (normalized[0]!.content as Array<Record<string, unknown>>)[0]!
    expect(block.toolCallId).toBe('call_from_source')
  })

  it('leaves assistant and system messages untouched', () => {
    const input = toolRoleMessages()
    const normalized = normalizeHarnessMessages(input)
    expect(normalized[0]).toBe(input[0])
    expect(normalized[1]).toBe(input[1])
    expect(normalized[2]).toBe(input[2])
  })
})

/**
 * OpenAI 原生形态（真实缺陷，2026-09-29）。
 *
 * 对齐 AGENTS.md 第 7 条「工具历史要保留 tool_calls / tool_call_id」——
 * 该条点名的是**蛇形** `tool_call_id`，即 OpenAI 线格式。早期实现只认驼峰
 * `toolCallId`，且不看 assistant 的顶层 `tool_calls`，导致标准 OpenAI 入站的
 * 工具历史被整段丢弃、字符串正文被吞成空串。
 */
describe('normalizeHarnessMessages · OpenAI 原生形态', () => {
  /** 标准 OpenAI 形态：assistant 顶层 `tool_calls`，tool 消息顶层蛇形 `tool_call_id`。 */
  function openAiNativeMessages(): Array<Record<string, unknown>> {
    return [
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'do it' },
      {
        role: 'assistant',
        content: null,
        tool_calls: [
          { id: 'call_a', type: 'function', function: { name: 'read', arguments: '{"p":"a"}' } },
        ],
      },
      { role: 'tool', tool_call_id: 'call_a', content: 'A' },
    ]
  }

  it('detects the openai-native shape from top-level tool_calls alone', () => {
    // 只有 assistant 侧有工具调用（历史被截断、结果缺失）时也必须识别出来，
    // 否则不会走归一分支，顶层 tool_calls 永远修不回来。
    expect(detectMessageShape([
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: null, tool_calls: [{ id: 'call_a', type: 'function', function: { name: 'read', arguments: '{}' } }] },
    ])).toBe('openai-native')
  })

  it('reads snake_case tool_call_id so the result can pair with its call', () => {
    const normalized = normalizeHarnessMessages(openAiNativeMessages())
    const resultBlock = (normalized[3]!.content as Array<Record<string, unknown>>)[0]!
    // 这是整个修复的关键：id 不再是 undefined。
    expect(resultBlock.toolCallId).toBe('call_a')
  })

  it('hoists top-level tool_calls into content blocks the serializers understand', () => {
    const normalized = normalizeHarnessMessages(openAiNativeMessages())
    const assistant = normalized[2]!
    const block = (assistant.content as Array<Record<string, unknown>>)
      .find(b => b['type'] === 'tool-call')!
    expect(block).toEqual({
      type: 'tool-call',
      id: 'call_a',
      name: 'read',
      arguments: '{"p":"a"}',
    })
    // 原字段必须移除，否则下游会重复下发同一批工具调用。
    expect('tool_calls' in assistant).toBe(false)
  })

  it('keeps assistant text alongside tool_calls instead of dropping either', () => {
    const normalized = normalizeHarnessMessages([
      {
        role: 'assistant',
        content: '我查一下',
        tool_calls: [{ id: 'call_a', type: 'function', function: { name: 'read', arguments: '{}' } }],
      },
    ])
    const assistant = normalized[0]!
    expect(assistant.content).toEqual([
      { type: 'text', text: '我查一下' },
      { type: 'tool-call', id: 'call_a', name: 'read', arguments: '{}' },
    ])
  })

  it('upgrades plain string assistant content to a text block', () => {
    // 早期实现用 `Array.isArray(content) ? content : []` 取值，字符串正文被当成
    // 空数组丢掉 —— 纯文本多轮会话里模型说过的每句话都变成空串。
    const normalized = normalizeHarnessMessages([
      { role: 'user', content: 'Q1' },
      { role: 'assistant', content: 'A1' },
      { role: 'user', content: 'Q2' },
    ])
    expect(normalized[1]!.content).toEqual([{ type: 'text', text: 'A1' }])
  })

  it('handles the empty-content assistant turn without inventing a text block', () => {
    // content 为 null（工具专用轮）不得被升级成空 text 块。
    const normalized = normalizeHarnessMessages([
      {
        role: 'assistant',
        content: null,
        tool_calls: [{ id: 'call_a', type: 'function', function: { name: 'read', arguments: '{}' } }],
      },
    ])
    expect(normalized[0]!.content).toEqual([
      { type: 'tool-call', id: 'call_a', name: 'read', arguments: '{}' },
    ])
  })
})

/**
 * 顶层 `system` 参数解析（真实缺陷，2026-09-29）。
 *
 * Anthropic 翻译层早就认内容块数组，而 OpenAI 入站分支只认字符串 —— 客户端
 * 用数组形式传 system 时指令被静默丢弃，wire 首条不再是 system，对 WorkBuddy
 * 这类强制要求 `messages[0]` 为 system 的上游直接 400 `code 11128`。
 */
describe('readSystemText', () => {
  it('returns a non-empty string as-is', () => {
    expect(readSystemText('You are helpful')).toBe('You are helpful')
  })

  it('joins text blocks from the Anthropic-style array form', () => {
    expect(readSystemText([
      { type: 'text', text: 'first' },
      { type: 'text', text: 'second' },
    ])).toBe('first\nsecond')
  })

  it('drops empty blocks and non-text blocks', () => {
    expect(readSystemText([
      { type: 'text', text: '' },
      { type: 'image', source: {} },
      { type: 'text', text: 'kept' },
    ])).toBe('kept')
  })

  it('returns undefined for absent or empty input', () => {
    // 返回 undefined（而非空串）让调用方区分「没有 system」与「system 是空串」。
    expect(readSystemText(undefined)).toBeUndefined()
    expect(readSystemText('')).toBeUndefined()
    expect(readSystemText([])).toBeUndefined()
    expect(readSystemText(42)).toBeUndefined()
  })
})
