import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Server } from 'node:http'
import type { IncomingMessage } from 'node:http'
import type { AddressInfo } from 'node:net'
import { AccountPool } from '../../src/pool/account-pool.js'
import { FileCredentialStore } from '../../src/pool/store.js'
import { ProviderRegistry } from '../../src/providers/registry.js'
import { createGatewayServer } from '../../src/gateway/server.js'
import { LlmAdapter, LlmError } from '../../src/shared/llm.js'
import type { GenerateOptions, StreamChunk } from '../../src/shared/llm.js'

/**
 * 一个可编程的替身适配器。
 *
 * 用真实的 `LlmAdapter` 基类（而不是鸭子类型替身），这样测的是**真实的契约**
 * —— 若基类契约变了，这里会立刻失败。
 */
class FakeAdapter extends LlmAdapter {
  /** 每次 stream 收到的 options（供断言参数透传）。 */
  readonly calls: GenerateOptions[] = []
  /** 要产出的 chunk；按 `script` 决定。 */
  script: (options: GenerateOptions) => StreamChunk[] | Promise<StreamChunk[]> = () => [
    { type: 'text-delta', index: 0, text: 'hello' },
    { type: 'finish', reason: { kind: 'stop' } },
  ]
  /** 产出 chunk 前抛出的错误。 */
  throwOnStream: Error | undefined

  constructor(private readonly models: Array<{ id: string; name: string }>) {
    super()
  }

  override async listModels(): Promise<readonly { provider: string; id: string; name: string }[]> {
    return this.models.map(m => ({ provider: 'fake', id: m.id, name: m.name }))
  }

  override async resolveModel(provider: string, model: string): Promise<{ provider: string; id: string; name: string; context?: { contextWindow: number } }> {
    const found = this.models.find(m => m.id === model)
    return {
      provider,
      id: model,
      name: found?.name ?? model,
      context: { contextWindow: 1000 },
    }
  }

  async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.calls.push(options)
    if (this.throwOnStream !== undefined) throw this.throwOnStream
    for (const chunk of await this.script(options)) yield chunk
  }
}

interface Harness {
  url: string
  server: Server
  pool: AccountPool
  registry: ProviderRegistry
  adapter: FakeAdapter
  dir: string
}

/** 起一个测试用网关（随机端口）。 */
async function startGateway(
  configure?: (adapter: FakeAdapter, pool: AccountPool) => void,
  options: { authenticate?: boolean } = {},
): Promise<Harness> {
  const dir = mkdtempSync(join(tmpdir(), 'all-proxy-gw-'))
  const credentials = new FileCredentialStore(dir)
  const pool = new AccountPool({ credentials, dataDir: dir })
  const registry = new ProviderRegistry()
  const adapter = new FakeAdapter([
    { id: 'model-a', name: 'Model A · x0.5' },
    { id: 'model-b', name: 'Model B · 免费' },
  ])
  registry.register({
    id: 'fake',
    displayName: 'Fake Provider',
    apiBase: 'https://example.invalid',
    chatPath: '/v1/chat/completions',
    authKind: 'bearer',
    catalogSource: 'remote-first',
    supportsImages: true,
    rotatesAccounts: false,
  }, adapter)

  configure?.(adapter, pool)

  const server = createGatewayServer({
    registry,
    pool,
    port: 0,
    host: '127.0.0.1',
    ...options.authenticate === true
      ? {
          authenticate: (req: IncomingMessage) => {
            const header = req.headers['authorization']
            return header === 'Bearer good-key'
              ? { ok: true as const, caller: { id: 'test-key', name: '测试 key' } }
              : { ok: false as const, error: { status: 401, code: 'invalid_api_key' as const, message: 'invalid key' } }
          },
        }
      : {},
  })
  await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve) })
  const address = server.address() as AddressInfo
  return { url: `http://127.0.0.1:${address.port}`, server, pool, registry, adapter, dir }
}

/** 关掉测试网关并清理临时目录。 */
async function stopGateway(h: Harness): Promise<void> {
  await new Promise<void>((resolve) => { h.server.close(() => resolve()) })
  rmSync(h.dir, { recursive: true, force: true })
}

/** POST JSON。 */
async function post(url: string, body: unknown, headers: Record<string, string> = {}): Promise<Response> {
  return fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  })
}

describe('网关 · 非流式 chat completions', () => {
  let h: Harness
  beforeEach(async () => { h = await startGateway() })
  afterEach(async () => { await stopGateway(h) })

  it('返回合法的 chat.completion 响应', async () => {
    const res = await post(`${h.url}/v1/chat/completions`, {
      model: 'fake/model-a',
      messages: [{ role: 'user', content: 'hi' }],
    })
    expect(res.status).toBe(200)
    const body = await res.json() as Record<string, unknown>
    expect(body['object']).toBe('chat.completion')
    expect(body['model']).toBe('fake/model-a')
    const choices = body['choices'] as Array<Record<string, unknown>>
    const message = choices[0]!['message'] as Record<string, unknown>
    expect(message['role']).toBe('assistant')
    expect(message['content']).toBe('hello')
    expect(choices[0]!['finish_reason']).toBe('stop')
  })

  it('把 provider 前缀拆开后只把裸模型名传给适配器', async () => {
    await post(`${h.url}/v1/chat/completions`, {
      model: 'fake/model-a',
      messages: [{ role: 'user', content: 'hi' }],
    })
    expect(h.adapter.calls[0]?.model).toBe('model-a')
    expect(h.adapter.calls[0]?.provider).toBe('fake')
  })

  it('透传 max_tokens / temperature / stop / reasoning_effort', async () => {
    await post(`${h.url}/v1/chat/completions`, {
      model: 'fake/model-a',
      messages: [{ role: 'user', content: 'hi' }],
      max_tokens: 123,
      temperature: 0.3,
      stop: ['END'],
      reasoning_effort: 'high',
    })
    const call = h.adapter.calls[0]!
    expect(call.maxTokens).toBe(123)
    expect(call.temperature).toBe(0.3)
    expect(call.stop).toEqual(['END'])
    expect(call.reasoningEffort).toBe('high')
  })

  it('把 tools 原样传给适配器（由适配器负责下发到上游顶层）', async () => {
    await post(`${h.url}/v1/chat/completions`, {
      model: 'fake/model-a',
      messages: [{ role: 'user', content: 'hi' }],
      tools: [{ type: 'function', function: { name: 'read', description: 'r', parameters: { type: 'object' } } }],
    })
    expect(h.adapter.calls[0]?.tools).toEqual([
      { name: 'read', description: 'r', parameters: { type: 'object' } },
    ])
  })

  it('非法 max_tokens 被忽略（不写进请求）', async () => {
    await post(`${h.url}/v1/chat/completions`, {
      model: 'fake/model-a',
      messages: [],
      max_tokens: -5,
    })
    expect(h.adapter.calls[0]?.maxTokens).toBeUndefined()
  })

  it('usage 的 prompt_tokens 包含缓存部分（与上游账单口径一致）', async () => {
    h.adapter.script = () => [
      { type: 'text-delta', index: 0, text: 'x' },
      // ⚠️ 内部 inputTokens 是**未缓存**部分，故 prompt_tokens 必须加上缓存。
      { type: 'usage', usage: { inputTokens: 100, outputTokens: 20, cacheReadTokens: 900 } },
      { type: 'finish', reason: { kind: 'stop' } },
    ]
    const res = await post(`${h.url}/v1/chat/completions`, { model: 'fake/model-a', messages: [] })
    const body = await res.json() as Record<string, unknown>
    const usage = body['usage'] as Record<string, unknown>
    expect(usage['prompt_tokens']).toBe(1000)
    expect(usage['completion_tokens']).toBe(20)
    expect((usage['prompt_tokens_details'] as Record<string, unknown>)['cached_tokens']).toBe(900)
  })

  it('工具调用被聚合成 tool_calls，且 content 为 null', async () => {
    h.adapter.script = () => [
      { type: 'tool-call-delta', index: 0, id: 'call_1', name: 'read', argumentsDelta: '{"p"' },
      { type: 'tool-call-delta', index: 0, id: '', argumentsDelta: ':1}' },
      { type: 'finish', reason: { kind: 'tool-calls' } },
    ]
    const res = await post(`${h.url}/v1/chat/completions`, { model: 'fake/model-a', messages: [] })
    const body = await res.json() as Record<string, unknown>
    const message = (body['choices'] as Array<Record<string, unknown>>)[0]!['message'] as Record<string, unknown>
    expect(message['content']).toBeNull()
    expect(message['tool_calls']).toEqual([
      { id: 'call_1', type: 'function', function: { name: 'read', arguments: '{"p":1}' } },
    ])
    expect((body['choices'] as Array<Record<string, unknown>>)[0]!['finish_reason']).toBe('tool_calls')
  })

  it('思考内容走 reasoning_content 而不是混进 content', async () => {
    h.adapter.script = () => [
      { type: 'reasoning-delta', index: 0, text: 'let me think' },
      { type: 'text-delta', index: 0, text: 'answer' },
      { type: 'finish', reason: { kind: 'stop' } },
    ]
    const res = await post(`${h.url}/v1/chat/completions`, { model: 'fake/model-a', messages: [] })
    const body = await res.json() as Record<string, unknown>
    const message = (body['choices'] as Array<Record<string, unknown>>)[0]!['message'] as Record<string, unknown>
    expect(message['content']).toBe('answer')
    expect(message['reasoning_content']).toBe('let me think')
  })

  it('max-tokens 结束原因映射为 length', async () => {
    h.adapter.script = () => [
      { type: 'text-delta', index: 0, text: 'trunc' },
      { type: 'finish', reason: { kind: 'max-tokens' } },
    ]
    const res = await post(`${h.url}/v1/chat/completions`, { model: 'fake/model-a', messages: [] })
    const body = await res.json() as Record<string, unknown>
    expect((body['choices'] as Array<Record<string, unknown>>)[0]!['finish_reason']).toBe('length')
  })
})

describe('网关 · 流式 chat completions', () => {
  let h: Harness
  beforeEach(async () => { h = await startGateway() })
  afterEach(async () => { await stopGateway(h) })

  it('逐块输出 chat.completion.chunk 并以 [DONE] 结束', async () => {
    h.adapter.script = () => [
      { type: 'text-delta', index: 0, text: 'Hel' },
      { type: 'text-delta', index: 0, text: 'lo' },
      { type: 'finish', reason: { kind: 'stop' } },
    ]
    const res = await post(`${h.url}/v1/chat/completions`, {
      model: 'fake/model-a',
      messages: [],
      stream: true,
    })
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('text/event-stream')
    const text = await res.text()
    const lines = text.split('\n').filter(l => l.startsWith('data: '))
    expect(lines.at(-1)).toBe('data: [DONE]')
    // 两条文本增量 + 一条收尾 chunk
    expect(lines).toHaveLength(4)
    const first = JSON.parse(lines[0]!.slice(6)) as Record<string, unknown>
    expect(first['object']).toBe('chat.completion.chunk')
    // 首个增量带 role（官方 SDK 依赖它确定角色）。
    const delta = (first['choices'] as Array<Record<string, unknown>>)[0]!['delta'] as Record<string, unknown>
    expect(delta['role']).toBe('assistant')
    expect(delta['content']).toBe('Hel')
  })

  it('未开 include_usage 时收尾 chunk 不带 usage', async () => {
    h.adapter.script = () => [
      { type: 'text-delta', index: 0, text: 'x' },
      { type: 'usage', usage: { inputTokens: 1, outputTokens: 1 } },
      { type: 'finish', reason: { kind: 'stop' } },
    ]
    const res = await post(`${h.url}/v1/chat/completions`, { model: 'fake/model-a', messages: [], stream: true })
    const text = await res.text()
    const frames = text.split('\n').filter(l => l.startsWith('data: ') && !l.includes('[DONE]'))
    const last = JSON.parse(frames.at(-1)!.slice(6)) as Record<string, unknown>
    expect('usage' in last).toBe(false)
  })

  it('开 include_usage 时收尾 chunk 带 usage', async () => {
    h.adapter.script = () => [
      { type: 'text-delta', index: 0, text: 'x' },
      { type: 'usage', usage: { inputTokens: 7, outputTokens: 3 } },
      { type: 'finish', reason: { kind: 'stop' } },
    ]
    const res = await post(`${h.url}/v1/chat/completions`, {
      model: 'fake/model-a',
      messages: [],
      stream: true,
      stream_options: { include_usage: true },
    })
    const text = await res.text()
    const frames = text.split('\n').filter(l => l.startsWith('data: ') && !l.includes('[DONE]'))
    const last = JSON.parse(frames.at(-1)!.slice(6)) as Record<string, unknown>
    expect((last['usage'] as Record<string, unknown>)['prompt_tokens']).toBe(7)
    expect((last['usage'] as Record<string, unknown>)['completion_tokens']).toBe(3)
  })

  it('流式工具调用分片被下发为 tool_calls delta', async () => {
    h.adapter.script = () => [
      { type: 'tool-call-delta', index: 0, id: 'call_1', name: 'read', argumentsDelta: '{"a"' },
      { type: 'tool-call-delta', index: 0, id: 'call_1', argumentsDelta: ':1}' },
      { type: 'finish', reason: { kind: 'tool-calls' } },
    ]
    const res = await post(`${h.url}/v1/chat/completions`, { model: 'fake/model-a', messages: [], stream: true })
    const text = await res.text()
    const frames = text.split('\n').filter(l => l.startsWith('data: ') && !l.includes('[DONE]'))
    const deltas = frames.map(f => JSON.parse(f.slice(6)) as Record<string, unknown>)
      .flatMap(f => (f['choices'] as Array<Record<string, unknown>>)[0]!['delta'] as Record<string, unknown>)
      .filter(d => d['tool_calls'] !== undefined)
    expect(deltas).toHaveLength(2)
    expect((deltas[0]!['tool_calls'] as Array<Record<string, unknown>>)[0]!['id']).toBe('call_1')
  })

  it('空 name 的 tool-call 分片不下发 name 字段（避免清空已解析的名字）', async () => {
    h.adapter.script = () => [
      { type: 'tool-call-delta', index: 0, id: 'call_1', name: 'read', argumentsDelta: '{"a"' },
      { type: 'tool-call-delta', index: 0, id: 'call_1', name: '', argumentsDelta: ':1}' },
      { type: 'finish', reason: { kind: 'tool-calls' } },
    ]
    const res = await post(`${h.url}/v1/chat/completions`, { model: 'fake/model-a', messages: [], stream: true })
    const text = await res.text()
    const frames = text.split('\n').filter(l => l.startsWith('data: ') && !l.includes('[DONE]'))
    const second = JSON.parse(frames[1]!.slice(6)) as Record<string, unknown>
    const call = ((second['choices'] as Array<Record<string, unknown>>)[0]!['delta'] as Record<string, unknown>)['tool_calls'] as Array<Record<string, unknown>>
    const fn = call[0]!['function'] as Record<string, unknown>
    expect('name' in fn).toBe(false)
  })
})

describe('网关 · 模型寻址与硬拦截', () => {
  let h: Harness
  beforeEach(async () => { h = await startGateway() })
  afterEach(async () => { await stopGateway(h) })

  it('provider 不存在 → 404 model_not_found 且不发上游请求', async () => {
    const res = await post(`${h.url}/v1/chat/completions`, { model: 'nope/model-a', messages: [] })
    expect(res.status).toBe(404)
    const body = await res.json() as Record<string, unknown>
    expect(((body['error'] as Record<string, unknown>)['code'])).toBe('model_not_found')
    expect(h.adapter.calls).toHaveLength(0)
  })

  it('缺 provider 前缀（裸名）→ 404 且提示正确写法', async () => {
    const res = await post(`${h.url}/v1/chat/completions`, { model: 'model-a', messages: [] })
    expect(res.status).toBe(404)
    const body = await res.json() as Record<string, unknown>
    expect(String((body['error'] as Record<string, unknown>)['message'])).toContain('<provider>/<model>')
    expect(h.adapter.calls).toHaveLength(0)
  })

  it('模型名本身含斜杠时，按第一个斜杠切分', async () => {
    h.registry.list() // 触发一次注册表读取（无副作用，仅确保可用）
    // 注册一个 id 含斜杠的模型，验证「其余整体作为模型名」。
    const registry = h.registry
    const adapter = new FakeAdapter([{ id: 'vendor/model-x', name: 'Vendor X' }])
    registry.register({
      id: 'slashy',
      displayName: 'Slashy',
      apiBase: 'https://example.invalid',
      chatPath: '/v1/chat/completions',
      authKind: 'bearer',
      catalogSource: 'remote-first',
      supportsImages: false,
      rotatesAccounts: false,
    }, adapter)
    const res = await post(`${h.url}/v1/chat/completions`, { model: 'slashy/vendor/model-x', messages: [] })
    expect(res.status).toBe(200)
    expect(adapter.calls[0]?.model).toBe('vendor/model-x')
    expect(adapter.calls[0]?.provider).toBe('slashy')
  })

  it('**调用被关闭的模型 → 404 且不发上游请求**（硬拦截）', async () => {
    await h.pool.setModelDisabled('fake', 'model-a', true)
    const res = await post(`${h.url}/v1/chat/completions`, { model: 'fake/model-a', messages: [] })
    expect(res.status).toBe(404)
    const body = await res.json() as Record<string, unknown>
    expect(((body['error'] as Record<string, unknown>)['code'])).toBe('model_not_found')
    // ⚠️ 关键：硬拦截必须**零上游消耗**。
    expect(h.adapter.calls).toHaveLength(0)
  })

  it('provider 被关闭 → 该 provider 全部模型 404', async () => {
    await h.pool.setProviderEnabled('fake', false)
    const res = await post(`${h.url}/v1/chat/completions`, { model: 'fake/model-a', messages: [] })
    expect(res.status).toBe(404)
    expect(h.adapter.calls).toHaveLength(0)
  })

  it('全局总开关关闭 → 全部模型 404', async () => {
    await h.pool.setGlobalModelsEnabled(false)
    const res = await post(`${h.url}/v1/chat/completions`, { model: 'fake/model-a', messages: [] })
    expect(res.status).toBe(404)
    expect(h.adapter.calls).toHaveLength(0)
  })

  it('未关闭的同 provider 其他模型不受影响', async () => {
    await h.pool.setModelDisabled('fake', 'model-a', true)
    const res = await post(`${h.url}/v1/chat/completions`, { model: 'fake/model-b', messages: [] })
    expect(res.status).toBe(200)
  })
})

describe('网关 · GET /v1/models', () => {
  let h: Harness
  beforeEach(async () => { h = await startGateway() })
  afterEach(async () => { await stopGateway(h) })

  it('返回带 provider 前缀的 OpenAI 列表', async () => {
    const res = await fetch(`${h.url}/v1/models`)
    expect(res.status).toBe(200)
    const body = await res.json() as Record<string, unknown>
    expect(body['object']).toBe('list')
    const data = body['data'] as Array<Record<string, unknown>>
    expect(data.map(m => m['id'])).toEqual(['fake/model-a', 'fake/model-b'])
    expect(data[0]!['owned_by']).toBe('fake')
    expect(data[0]!['object']).toBe('model')
  })

  it('条目带上下文窗口与图片能力', async () => {
    const body = await (await fetch(`${h.url}/v1/models`)).json() as Record<string, unknown>
    const first = (body['data'] as Array<Record<string, unknown>>)[0]!
    expect(first['context_window']).toBe(1000)
    expect(first['supports_image']).toBe(false)
  })

  it('被关闭的模型不出现在列表里', async () => {
    await h.pool.setModelDisabled('fake', 'model-a', true)
    const body = await (await fetch(`${h.url}/v1/models`)).json() as Record<string, unknown>
    expect((body['data'] as Array<Record<string, unknown>>).map(m => m['id'])).toEqual(['fake/model-b'])
  })

  it('全局关闭时返回空列表', async () => {
    await h.pool.setGlobalModelsEnabled(false)
    const body = await (await fetch(`${h.url}/v1/models`)).json() as Record<string, unknown>
    expect(body['data']).toEqual([])
  })

  it('provider 关闭时跳过该 provider', async () => {
    await h.pool.setProviderEnabled('fake', false)
    const body = await (await fetch(`${h.url}/v1/models`)).json() as Record<string, unknown>
    expect(body['data']).toEqual([])
  })
})

describe('网关 · 错误映射', () => {
  let h: Harness
  beforeEach(async () => { h = await startGateway() })
  afterEach(async () => { await stopGateway(h) })

  it('无凭据 → 401 authentication_error', async () => {
    h.adapter.throwOnStream = llmError('no credential', 'MISSING_CREDENTIAL')
    const res = await post(`${h.url}/v1/chat/completions`, { model: 'fake/model-a', messages: [] })
    expect(res.status).toBe(401)
    const body = await res.json() as Record<string, unknown>
    expect(((body['error'] as Record<string, unknown>)['code'])).toBe('authentication_error')
  })

  it('额度耗尽 → 429 quota_exceeded（与限流区分）', async () => {
    h.adapter.throwOnStream = llmError('out of credits', 'QUOTA_EXCEEDED')
    const res = await post(`${h.url}/v1/chat/completions`, { model: 'fake/model-a', messages: [] })
    expect(res.status).toBe(429)
    const body = await res.json() as Record<string, unknown>
    expect(((body['error'] as Record<string, unknown>)['code'])).toBe('quota_exceeded')
  })

  it('限流 → 429 rate_limit_exceeded', async () => {
    h.adapter.throwOnStream = llmError('slow down', 'RATE_LIMIT')
    const res = await post(`${h.url}/v1/chat/completions`, { model: 'fake/model-a', messages: [] })
    expect(res.status).toBe(429)
    const body = await res.json() as Record<string, unknown>
    expect(((body['error'] as Record<string, unknown>)['code'])).toBe('rate_limit_exceeded')
  })

  it('传输失败 → 502 upstream_error', async () => {
    h.adapter.throwOnStream = llmError('fetch failed', 'TRANSPORT')
    const res = await post(`${h.url}/v1/chat/completions`, { model: 'fake/model-a', messages: [] })
    expect(res.status).toBe(502)
  })

  it('超时 → 504 upstream_timeout', async () => {
    h.adapter.throwOnStream = llmError('timeout', 'TIMEOUT')
    const res = await post(`${h.url}/v1/chat/completions`, { model: 'fake/model-a', messages: [] })
    expect(res.status).toBe(504)
  })

  it('上下文超限 → 400 invalid_request_error（不是 5xx）', async () => {
    h.adapter.throwOnStream = llmError('context too long', 'CONTEXT_WINDOW_EXCEEDED')
    const res = await post(`${h.url}/v1/chat/completions`, { model: 'fake/model-a', messages: [] })
    expect(res.status).toBe(400)
    const body = await res.json() as Record<string, unknown>
    expect(((body['error'] as Record<string, unknown>)['code'])).toBe('invalid_request_error')
  })

  it('上游 4xx 原样透传状态码（不伪装成 500）', async () => {
    h.adapter.throwOnStream = llmError('bad param', 'UNKNOWN', 422)
    const res = await post(`${h.url}/v1/chat/completions`, { model: 'fake/model-a', messages: [] })
    expect(res.status).toBe(422)
  })

  it('错误响应体是 OpenAI 形状', async () => {
    h.adapter.throwOnStream = llmError('boom', 'TRANSPORT')
    const res = await post(`${h.url}/v1/chat/completions`, { model: 'fake/model-a', messages: [] })
    const body = await res.json() as Record<string, unknown>
    const error = body['error'] as Record<string, unknown>
    expect(error['message']).toBeDefined()
    expect(error['type']).toBeDefined()
    expect(error['code']).toBeDefined()
    expect('param' in error).toBe(true)
  })

  it('请求体不是合法 JSON → 400', async () => {
    const res = await fetch(`${h.url}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{oops',
    })
    expect(res.status).toBe(400)
  })

  it('未知端点 → 404', async () => {
    const res = await post(`${h.url}/v1/nope`, {})
    expect(res.status).toBe(404)
  })
})

describe('网关 · GET /health', () => {
  it('返回 provider 状态且**不发起上游请求**', async () => {
    const h = await startGateway()
    try {
      const res = await fetch(`${h.url}/health`)
      expect(res.status).toBe(200)
      const body = await res.json() as Record<string, unknown>
      expect(body['status']).toBe('ok')
      const providers = body['providers'] as Array<Record<string, unknown>>
      expect(providers.map(p => p['id'])).toEqual(['fake'])
      // ⚠️ 规格要求：健康检查不消耗上游额度。
      expect(h.adapter.calls).toHaveLength(0)
    } finally {
      await stopGateway(h)
    }
  })

  it('报告账号数与就绪状态', async () => {
    const h = await startGateway(async (_adapter, pool) => {
      await pool.addAccount({
        id: 'fake-1', provider: 'fake', nickname: 'n', enabled: true,
        credentialRef: 'FAKE_ACCOUNT_1', createdAt: Date.now(), refreshable: true,
      })
    })
    try {
      const body = await (await fetch(`${h.url}/health`)).json() as Record<string, unknown>
      const provider = (body['providers'] as Array<Record<string, unknown>>)[0]!
      expect(provider['accounts']).toBe(1)
      expect(provider['enabledAccounts']).toBe(1)
      expect(provider['ready']).toBe(true)
    } finally {
      await stopGateway(h)
    }
  })

  it('健康检查在鉴权开启时仍可访问（豁免）', async () => {
    const h = await startGateway(undefined, { authenticate: true })
    try {
      expect((await fetch(`${h.url}/health`)).status).toBe(200)
    } finally {
      await stopGateway(h)
    }
  })
})

/**
 * 网关 · 标准 OpenAI 入站形态（真实缺陷回归，2026-09-29）。
 *
 * ## 分层：这里只测**网关层**的职责
 *
 * 按 design D5，OpenAI 侧是**透传**：网关把 `body.messages` 原样交给适配器，
 * 形态归一发生在各适配器的 `serializeMessages`（内部调 `normalizeHarnessMessages`）。
 * 故本组断言两件事：
 *
 * 1. **网关确实把消息透传**（不静默丢弃/改写）—— 锁住 D5 这条设计契约，
 *    防止日后有人在这里加一层有损翻译；
 * 2. **顶层 `system` 的数组形态被正确读出** —— 这是**网关层**的真实缺陷：
 *    早期只认字符串，数组 system 被静默丢弃，wire 首条不再是 system，
 *    WorkBuddy 因此 400 `code 11128`（且被上游伪装成「安全策略拦截」）。
 *
 * 工具历史保真的**端到端**断言在适配器层（见 `loomy-adapter.spec.ts` /
 * `buddy-adapter.spec.ts` 的「OpenAI 原生入站形态」用例）—— 那里才真正经过
 * 序列化，也只有那里能证明 `tool_calls` / `tool_call_id` 没在出站时丢掉。
 */
describe('网关 · 标准 OpenAI 入站形态', () => {
  let h: Harness
  beforeEach(async () => { h = await startGateway() })
  afterEach(async () => { await stopGateway(h) })

  /** 读回适配器收到的消息。 */
  function inbound(): Array<Record<string, unknown>> {
    return h.adapter.calls[0]!.messages as unknown as Array<Record<string, unknown>>
  }

  it('顶层 system 用内容块数组形式也能被读出（不静默丢弃）', async () => {
    // WorkBuddy 强制要求 messages[0] 是 system，丢弃数组形式会让它 400
    // code 11128（且被上游伪装成「安全策略拦截」）。
    await post(`${h.url}/v1/chat/completions`, {
      model: 'fake/model-a',
      system: [{ type: 'text', text: 'part one' }, { type: 'text', text: 'part two' }],
      messages: [{ role: 'user', content: 'hi' }],
    })
    expect(h.adapter.calls[0]?.system).toBe('part one\npart two')
  })

  it('顶层 system 用字符串形式照旧可用（不回归）', async () => {
    await post(`${h.url}/v1/chat/completions`, {
      model: 'fake/model-a',
      system: 'plain system',
      messages: [{ role: 'user', content: 'hi' }],
    })
    expect(h.adapter.calls[0]?.system).toBe('plain system')
  })

  it('没有 system 时不编造（交回 undefined，由适配器决定兜底）', async () => {
    await post(`${h.url}/v1/chat/completions`, {
      model: 'fake/model-a',
      messages: [{ role: 'user', content: 'hi' }],
    })
    expect(h.adapter.calls[0]?.system).toBeUndefined()
  })

  it('把 OpenAI 原生形态的消息原样透传给适配器（D5：不在此层改写）', async () => {
    const messages = [
      { role: 'system', content: 'SYS' },
      { role: 'user', content: '读文件' },
      {
        role: 'assistant',
        content: null,
        tool_calls: [
          { id: 'call_1', type: 'function', function: { name: 'read', arguments: '{"p":"a.ts"}' } },
        ],
      },
      { role: 'tool', tool_call_id: 'call_1', content: 'FILE A' },
      { role: 'user', content: '继续' },
    ]
    await post(`${h.url}/v1/chat/completions`, { model: 'fake/model-a', messages })

    // 透传的判据：字段一个不少、层级不塌陷。归一化由适配器负责，
    // 网关若在这里「顺手改写」就会与适配器的归一化重复或冲突。
    expect(inbound()).toEqual(messages)
  })
})

describe('网关 · 入站鉴权', () => {
  it('缺凭据 → 401 invalid_api_key 且不发上游请求', async () => {
    const h = await startGateway(undefined, { authenticate: true })
    try {
      const res = await post(`${h.url}/v1/chat/completions`, { model: 'fake/model-a', messages: [] })
      expect(res.status).toBe(401)
      const body = await res.json() as Record<string, unknown>
      expect(((body['error'] as Record<string, unknown>)['code'])).toBe('invalid_api_key')
      expect(h.adapter.calls).toHaveLength(0)
    } finally {
      await stopGateway(h)
    }
  })

  it('有效凭据可访问', async () => {
    const h = await startGateway(undefined, { authenticate: true })
    try {
      const res = await post(
        `${h.url}/v1/chat/completions`,
        { model: 'fake/model-a', messages: [] },
        { Authorization: 'Bearer good-key' },
      )
      expect(res.status).toBe(200)
    } finally {
      await stopGateway(h)
    }
  })

  it('模型列表也受鉴权保护', async () => {
    const h = await startGateway(undefined, { authenticate: true })
    try {
      expect((await fetch(`${h.url}/v1/models`)).status).toBe(401)
    } finally {
      await stopGateway(h)
    }
  })
})

/** 构造一个带指定 code 的 `LlmError`（服务器按 `instanceof` 判定）。 */
function llmError(message: string, code: string, status?: number): LlmError {
  return new LlmError(message, code, status === undefined ? undefined : { status })
}
