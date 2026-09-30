import { describe, expect, it } from 'vitest'
import {
  CONTEXT_WINDOW_EXCEEDED_CODE,
  EMPTY_RESPONSE_CODE,
  LlmAdapter,
  LlmError,
  ToolCallId,
  attributionHeaders,
  createUserMessage,
  isContextWindowExceededError,
  isQuotaExceededError,
  userAgent,
} from '../../src/shared/llm.js'
import type { GenerateOptions, LlmResolvedModelInfo, StreamChunk } from '../../src/shared/llm.js'

describe('LlmError', () => {
  it('carries the code on both the error and its failure record', () => {
    const error = new LlmError('boom', 'AUTH', { status: 401 })
    expect(error).toBeInstanceOf(LlmError)
    expect(error).toBeInstanceOf(Error)
    expect(error.code).toBe('AUTH')
    expect(error.failure.code).toBe('AUTH')
    expect(error.failure.status).toBe(401)
    expect(error.message).toBe('boom')
  })

  it('is discriminable with instanceof (adapters rely on this)', () => {
    // ⚠️ `readWithIdleTimeout` 等实现用 `error instanceof LlmError` 区分
    // 「空闲超时」与「用户取消」，故这条不能退化为鸭子类型。
    const error = new LlmError('x', 'TIMEOUT')
    expect(error instanceof LlmError).toBe(true)
    expect(new Error('x') instanceof LlmError).toBe(false)
  })

  it('omits absent optional facts instead of writing undefined', () => {
    const error = new LlmError('boom', 'SERVER')
    expect('status' in error.failure).toBe(false)
    expect('requestId' in error.failure).toBe(false)
    expect('providerRetryAfterMs' in error.failure).toBe(false)
  })

  it('preserves cause for transport diagnostics', () => {
    const cause = new TypeError('fetch failed')
    const error = new LlmError('boom', 'TRANSPORT', { cause })
    expect(error.cause).toBe(cause)
  })

  it('does not leak credential-looking data through the failure record', () => {
    // 错误对象会被日志与响应序列化；这里锁定它只带我们自己放进去的字段。
    const error = new LlmError('raccoon: unauthorized', 'AUTH', { status: 401 })
    const serialized = JSON.stringify({ message: error.message, failure: error.failure })
    expect(serialized).not.toMatch(/refresh_token|access_token|Bearer [A-Za-z0-9._-]{20,}/)
  })
})

describe('ToolCallId / ReasoningEffortId', () => {
  it('are runtime identity functions (so Set<string> usage is unchanged)', () => {
    const id = ToolCallId('call_abc')
    expect(id).toBe('call_abc')
    expect(typeof id).toBe('string')
    expect(new Set([id]).has('call_abc')).toBe(true)
  })
})

describe('createUserMessage', () => {
  it('builds a user message with content', () => {
    expect(createUserMessage({ content: [{ type: 'text', text: 'hi' }] })).toEqual({
      role: 'user',
      content: [{ type: 'text', text: 'hi' }],
    })
  })

  it('includes source only when provided', () => {
    expect('source' in createUserMessage({ content: 'x' })).toBe(false)
    expect(createUserMessage({ content: 'x', source: { kind: 'user' } }).source).toEqual({ kind: 'user' })
  })
})

describe('attributionHeaders', () => {
  it('reports all-proxy identity, not the harness identity', () => {
    // ⚠️ 有意与 DSH 不同：本项目是独立产品，向厂商归因必须报自己的身份。
    const headers = attributionHeaders()
    expect(headers['user-agent']).toContain('all-proxy/')
    expect(headers['user-agent']).not.toContain('deepseek-harness')
  })

  it('formats the user agent as product/version (+url)', () => {
    expect(userAgent()).toMatch(/^all-proxy\/\d+\.\d+\.\d+ \(\+https?:\/\//)
  })

  it('uses lowercase header names', () => {
    expect(Object.keys(attributionHeaders())).toEqual(['user-agent'])
  })
})

describe('isContextWindowExceededError', () => {
  it('recognizes structured overflow wording', () => {
    expect(isContextWindowExceededError('context_length_exceeded')).toBe(true)
    expect(isContextWindowExceededError('This model\'s maximum context length is 128000 tokens')).toBe(true)
    expect(isContextWindowExceededError('input is too long for this model')).toBe(true)
  })

  it('does not fire on unrelated errors', () => {
    expect(isContextWindowExceededError('rate limit exceeded')).toBe(false)
    expect(isContextWindowExceededError('model not found')).toBe(false)
  })
})

describe('isQuotaExceededError', () => {
  it('recognizes terminal quota wording', () => {
    expect(isQuotaExceededError('insufficient quota')).toBe(true)
    expect(isQuotaExceededError('quota exceeded')).toBe(true)
    expect(isQuotaExceededError('out of credits')).toBe(true)
  })

  it('does not fire on transient rate limiting', () => {
    // ⚠️ 额度耗尽（不可重试）与瞬时限流（可重试）必须分开。
    expect(isQuotaExceededError('rate limit exceeded')).toBe(false)
    expect(isQuotaExceededError('too many requests')).toBe(false)
  })
})

describe('stable error codes', () => {
  it('match the values the ported adapters compare against', () => {
    // 这些字符串由适配器直接比较（如 resolveEmptyResponseReason），改名会静默失效。
    expect(EMPTY_RESPONSE_CODE).toBe('EMPTY_RESPONSE')
    expect(CONTEXT_WINDOW_EXCEEDED_CODE).toBe('CONTEXT_WINDOW_EXCEEDED')
  })
})

/** 最小具体适配器：只实现抽象方法，用于验证基类默认行为。 */
class StubAdapter extends LlmAdapter {
  streamCalls: GenerateOptions[] = []

  async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.streamCalls.push(options)
    yield { type: 'text-delta', index: 0, text: 'ok' }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

describe('LlmAdapter base class', () => {
  it('provides a default providerInfo equal to the route name', () => {
    expect(new StubAdapter().providerInfo('raccoon')).toEqual({ id: 'raccoon', name: 'raccoon' })
  })

  it('provides an empty default catalog', async () => {
    expect(await new StubAdapter().listModels('raccoon')).toEqual([])
  })

  it('provides a default resolveModel that echoes identity without inventing metadata', async () => {
    const resolved = await new StubAdapter().resolveModel('raccoon', 'sn-glm-5-3')
    expect(resolved.provider).toBe('raccoon')
    expect(resolved.id).toBe('sn-glm-5-3')
    // 不编造上下文窗口：未知就留空，让调用方用自己的默认值。
    expect(resolved.context).toBeUndefined()
    expect(resolved.defaultMaxTokens).toBeUndefined()
  })

  it('binds model metadata and streaming in prepareCall', async () => {
    const adapter = new StubAdapter()
    const prepared = await adapter.prepareCall('raccoon', 'sn-glm-5-3')
    expect(prepared.model.id).toBe('sn-glm-5-3')
    const chunks: StreamChunk[] = []
    for await (const chunk of prepared.stream({ provider: 'raccoon', model: 'sn-glm-5-3', messages: [] })) {
      chunks.push(chunk)
    }
    expect(chunks).toHaveLength(2)
    expect(adapter.streamCalls).toHaveLength(1)
  })

  it('requires subclasses to implement stream (compile-time) and keeps it abstract at runtime', () => {
    // 抽象性由 TS 保证；这里锁定基类自身不含可用的 stream 实现，
    // 避免有人日后给基类加一个「空实现」而让漏实现静默通过。
    expect(Object.getOwnPropertyNames(LlmAdapter.prototype)).not.toContain('stream')
  })

  it('exposes the five methods the ported adapters override', () => {
    for (const method of ['providerInfo', 'listModels', 'resolveModel', 'prepareCall']) {
      expect(typeof (LlmAdapter.prototype as Record<string, unknown>)[method]).toBe('function')
    }
  })
})

describe('LlmResolvedModelInfo shape', () => {
  it('accepts the fields the ported adapters set', () => {
    const resolved: LlmResolvedModelInfo = {
      provider: 'raccoon',
      id: 'sn-glm-5-3',
      name: 'GLM-5-3',
      inputModalities: ['text', 'image'],
      context: { contextWindow: 1_000_000 },
      defaultMaxTokens: 100_000,
    }
    expect(resolved.context?.contextWindow).toBe(1_000_000)
  })
})
