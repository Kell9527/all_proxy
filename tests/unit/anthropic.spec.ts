import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AddressInfo } from 'node:net'
import type { Server } from 'node:http'
import { AccountPool } from '../../src/pool/account-pool.js'
import { FileCredentialStore } from '../../src/pool/store.js'
import { ProviderRegistry } from '../../src/providers/registry.js'
import { createGatewayServer } from '../../src/gateway/server.js'
import { LlmAdapter, ToolCallId } from '../../src/shared/llm.js'
import type { GenerateOptions, StreamChunk } from '../../src/shared/llm.js'
import { ApiKeyStore } from '../../src/auth/api-keys.js'
import { createApiKeyAuthenticator } from '../../src/auth/authenticate.js'

/**
 * Anthropic 兼容端点（tasks 9.1–9.6）。
 *
 * 上游没有 Anthropic 原生 —— 该端点由本服务翻译。测试策略：
 * - **9.6 对拍**是本文件的核心：同一请求分别走 OpenAI 与 Anthropic 端点，
 *   断言正文与工具调用**语义**一致（差异仅在协议形状）；
 * - 请求侧翻译（system / tool_result / tool_use 历史）通过检查替身适配器
 *   实际收到的 `GenerateOptions` 验证 —— 那才是「上游看到的东西」。
 */

const UPSTREAM_TEXT = 'hello from upstream'

type Behavior = 'text' | 'tool-call'

class ScriptedAdapter extends LlmAdapter {
  behavior: Behavior = 'text'
  readonly calls: GenerateOptions[] = []
  override async listModels(): Promise<readonly { provider: string; id: string; name: string }[]> {
    return [{ provider: 'fake', id: 'model-a', name: 'Model A' }]
  }
  override async resolveModel(provider: string, model: string): Promise<{ provider: string; id: string; name: string; context?: { contextWindow: number } }> {
    return { provider, id: model, name: model, context: { contextWindow: 1000 } }
  }
  async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.calls.push(options)
    if (this.behavior === 'tool-call') {
      // 分片风格与真实上游一致：首片带 id/name，后续只带参数片段（id 为空串）。
      yield { type: 'tool-call-delta', index: 0, id: ToolCallId('call-1'), name: 'get_weather', argumentsDelta: '{"city":' }
      yield { type: 'tool-call-delta', index: 0, id: ToolCallId(''), argumentsDelta: '"杭州"}' }
      yield { type: 'usage', usage: { inputTokens: 12, outputTokens: 8 } }
      yield { type: 'finish', reason: { kind: 'tool-calls' } }
      return
    }
    yield { type: 'text-delta', index: 0, text: 'hello ' }
    yield { type: 'text-delta', index: 0, text: 'from upstream' }
    yield { type: 'usage', usage: { inputTokens: 12, outputTokens: 8 } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

interface Harness {
  url: string
  server: Server
  dir: string
  keys: ApiKeyStore
  adapter: ScriptedAdapter
}

async function startGateway(): Promise<Harness> {
  const dir = mkdtempSync(join(tmpdir(), 'all-proxy-anthropic-'))
  const credentials = new FileCredentialStore(dir)
  const pool = new AccountPool({ credentials, dataDir: dir })
  const registry = new ProviderRegistry()
  const adapter = new ScriptedAdapter()
  registry.register({
    id: 'fake',
    displayName: 'fake provider',
    apiBase: 'https://example.invalid',
    chatPath: '/v1/chat/completions',
    authKind: 'bearer',
    catalogSource: 'remote-first',
    supportsImages: true,
    rotatesAccounts: false,
  }, adapter)
  const keys = new ApiKeyStore(dir)
  const server = createGatewayServer({
    registry,
    pool,
    port: 0,
    host: '127.0.0.1',
    authenticate: createApiKeyAuthenticator(keys),
  })
  await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve) })
  const address = server.address() as AddressInfo
  return { url: `http://127.0.0.1:${address.port}`, server, dir, keys, adapter }
}

async function stopGateway(h: Harness): Promise<void> {
  await new Promise<void>((resolve) => { h.server.close(() => resolve()) })
  rmSync(h.dir, { recursive: true, force: true })
}

function authHeaders(h: Harness, extra: Record<string, string> = {}): Record<string, string> {
  // Anthropic 客户端的标准携带方式就是 x-api-key（两种头等价性已在
  // gateway-auth.spec 验证；这里用 anthropic 侧的头，顺带覆盖该路径）。
  return { 'x-api-key': h.primaryKey, ...extra }
}

/** 给 harness 补一把 key（beforeEach 里注入）。 */
function withKey(h: Harness, plaintext: string): void {
  (h as unknown as { primaryKey: string }).primaryKey = plaintext
}

async function postMessages(h: Harness, body: unknown, headers: Record<string, string>): Promise<Response> {
  return fetch(`${h.url}/v1/messages`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'anthropic-version': '2023-06-01', ...headers },
    body: JSON.stringify(body),
  })
}

describe('Anthropic Messages · 非流式（9.1 / 9.2）', () => {
  let h: Harness
  beforeEach(async () => {
    h = await startGateway()
    withKey(h, h.keys.create({ name: 'anthropic' }).plaintext)
  })
  afterEach(async () => { await stopGateway(h) })

  it('9.1 返回 message 形状（type/role/content 数组/stop_reason/usage）', async () => {
    const res = await postMessages(h, {
      model: 'fake/model-a',
      max_tokens: 100,
      messages: [{ role: 'user', content: 'hi' }],
    }, authHeaders(h))
    expect(res.status).toBe(200)
    const body = await res.json() as Record<string, unknown>
    expect(typeof body['id']).toBe('string')
    expect((body['id'] as string).startsWith('msg_')).toBe(true)
    expect(body['type']).toBe('message')
    expect(body['role']).toBe('assistant')
    expect(Array.isArray(body['content'])).toBe(true)
    expect(body['stop_reason']).toBe('end_turn')
    expect(body['usage']).toEqual({ input_tokens: 12, output_tokens: 8 })
    const content = body['content'] as Array<Record<string, unknown>>
    expect(content).toEqual([{ type: 'text', text: 'hello from upstream' }])
  })

  it('9.1 content 里文本块顺序与上游输出一致（两个 delta 合并）', async () => {
    const res = await postMessages(h, {
      model: 'fake/model-a', max_tokens: 100,
      messages: [{ role: 'user', content: 'hi' }],
    }, authHeaders(h))
    const body = await res.json() as { content: Array<{ type: string; text: string }> }
    // 两个 text-delta 属于同一段输出：一个 text 块，不是两个。
    expect(body.content).toHaveLength(1)
    expect(body.content[0]!.text).toBe(UPSTREAM_TEXT)
  })

  it('9.2 顶层 system（字符串）映射为上游 system，而非用户消息', async () => {
    await postMessages(h, {
      model: 'fake/model-a', max_tokens: 100,
      system: '你是一个严谨的助手',
      messages: [{ role: 'user', content: 'hi' }],
    }, authHeaders(h))
    const options = h.adapter.calls[0]!
    expect(options.system).toBe('你是一个严谨的助手')
    // 用户消息只有一条，system 没有混进消息序列。
    expect(options.messages).toEqual([{ role: 'user', content: 'hi' }])
  })

  it('9.2 顶层 system（内容块数组）也归为 system 文本', async () => {
    await postMessages(h, {
      model: 'fake/model-a', max_tokens: 100,
      system: [{ type: 'text', text: '第一段' }, { type: 'text', text: '第二段' }],
      messages: [{ role: 'user', content: 'hi' }],
    }, authHeaders(h))
    const options = h.adapter.calls[0]!
    expect(options.system).toBe('第一段\n第二段')
  })

  it('9.1 max_tokens / temperature / stop_sequences 传给上游', async () => {
    await postMessages(h, {
      model: 'fake/model-a', max_tokens: 77, temperature: 0.3,
      stop_sequences: ['END'],
      messages: [{ role: 'user', content: 'hi' }],
    }, authHeaders(h))
    const options = h.adapter.calls[0]!
    expect(options.maxTokens).toBe(77)
    expect(options.temperature).toBe(0.3)
    expect(options.stop).toEqual(['END'])
  })
})

describe('Anthropic Messages · SSE 事件序列（9.3）', () => {
  let h: Harness
  beforeEach(async () => {
    h = await startGateway()
    withKey(h, h.keys.create({ name: 'anthropic-sse' }).plaintext)
  })
  afterEach(async () => { await stopGateway(h) })

  interface Frame { event: string; data: Record<string, unknown> }

  /** 解析 SSE 文本为帧序列。 */
  function parseSse(text: string): Frame[] {
    return text.trim().split('\n\n').map(raw => {
      const event = /^event: (.+)$/m.exec(raw)?.[1] ?? ''
      const data = /^data: (.+)$/m.exec(raw)?.[1] ?? '{}'
      return { event, data: JSON.parse(data) as Record<string, unknown> }
    })
  }

  it('9.3 事件顺序正确且每帧带 event: 行', async () => {
    const res = await postMessages(h, {
      model: 'fake/model-a', max_tokens: 100, stream: true,
      messages: [{ role: 'user', content: 'hi' }],
    }, authHeaders(h))
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('text/event-stream')

    const frames = parseSse(await res.text())
    const events = frames.map(f => f.event)
    // 完整序列：message_start → 开块 → delta → 关块 → message_delta → message_stop。
    expect(events[0]).toBe('message_start')
    expect(events).toContain('content_block_start')
    expect(events).toContain('content_block_delta')
    expect(events).toContain('content_block_stop')
    expect(events[events.length - 2]).toBe('message_delta')
    expect(events[events.length - 1]).toBe('message_stop')

    // message_start 的形状。
    const start = frames[0]!.data as { message: Record<string, unknown> }
    expect(start.type).toBe('message_start')
    expect(start.message['role']).toBe('assistant')
    expect(start.message['type']).toBe('message')

    // 开块在 delta 之前，且 delta 的 index 与开块一致。
    const blockStartIdx = events.indexOf('content_block_start')
    const blockStart = frames[blockStartIdx]!.data as { index: number; content_block: Record<string, unknown> }
    expect(blockStart.content_block['type']).toBe('text')
    const firstDelta = frames[events.indexOf('content_block_delta')]!.data as { index: number; delta: Record<string, unknown> }
    expect(firstDelta.index).toBe(blockStart.index)
    expect(firstDelta.delta['type']).toBe('text_delta')

    // message_delta 带 stop_reason 与 output_tokens。
    const messageDelta = frames[events.indexOf('message_delta')]!.data as { delta: Record<string, unknown>; usage: Record<string, unknown> }
    expect(messageDelta.delta['stop_reason']).toBe('end_turn')
    expect(messageDelta.usage['output_tokens']).toBe(8)
  })

  it('9.3 流内 text_delta 拼接等于上游输出', async () => {
    const res = await postMessages(h, {
      model: 'fake/model-a', max_tokens: 100, stream: true,
      messages: [{ role: 'user', content: 'hi' }],
    }, authHeaders(h))
    const frames = parseSse(await res.text())
    const text = frames
      .filter(f => f.event === 'content_block_delta')
      .map(f => ((f.data as { delta: { text?: string } }).delta.text ?? ''))
      .join('')
    expect(text).toBe(UPSTREAM_TEXT)
  })

  it('9.3 工具调用流：tool_use 块的 input_json_delta 可拼出完整参数', async () => {
    h.adapter.behavior = 'tool-call'
    const res = await postMessages(h, {
      model: 'fake/model-a', max_tokens: 100, stream: true,
      messages: [{ role: 'user', content: 'hi' }],
    }, authHeaders(h))
    const frames = parseSse(await res.text())
    const events = frames.map(f => f.event)
    const startIdx = events.indexOf('content_block_start')
    const block = (frames[startIdx]!.data as { content_block: Record<string, unknown> }).content_block
    expect(block['type']).toBe('tool_use')
    expect(block['id']).toBe('call-1')
    expect(block['name']).toBe('get_weather')

    const partialJson = frames
      .filter(f => f.event === 'content_block_delta')
      .map(f => (f.data as { delta: { partial_json?: string } }).delta.partial_json ?? '')
      .join('')
    expect(JSON.parse(partialJson)).toEqual({ city: '杭州' })

    const messageDelta = frames[events.indexOf('message_delta')]!.data as { delta: Record<string, unknown> }
    expect(messageDelta.delta['stop_reason']).toBe('tool_use')
  })
})

describe('Anthropic Messages · 工具调用双向翻译（9.4）', () => {
  let h: Harness
  beforeEach(async () => {
    h = await startGateway()
    withKey(h, h.keys.create({ name: 'anthropic-tools' }).plaintext)
  })
  afterEach(async () => { await stopGateway(h) })

  const TOOL_ROUNDTRIP_BODY = {
    model: 'fake/model-a',
    max_tokens: 200,
    tools: [{
      name: 'get_weather',
      description: '查询天气',
      input_schema: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] },
    }],
    messages: [
      { role: 'user', content: '杭州天气怎么样？' },
      { role: 'assistant', content: [
        { type: 'text', text: '我查一下' },
        { type: 'tool_use', id: 'call-1', name: 'get_weather', input: { city: '杭州' } },
      ] },
      { role: 'user', content: [
        { type: 'tool_result', tool_use_id: 'call-1', content: '晴，25 度' },
      ] },
    ],
  }

  it('9.4 响应侧：tool_use 块含 id/name/input（input 是对象）', async () => {
    h.adapter.behavior = 'tool-call'
    const res = await postMessages(h, {
      model: 'fake/model-a', max_tokens: 100,
      messages: [{ role: 'user', content: 'hi' }],
    }, authHeaders(h))
    const body = await res.json() as { content: Array<Record<string, unknown>>; stop_reason: string }
    expect(body.stop_reason).toBe('tool_use')
    const toolUse = body.content.find(b => b['type'] === 'tool_use')
    expect(toolUse).toEqual({ type: 'tool_use', id: 'call-1', name: 'get_weather', input: { city: '杭州' } })
  })

  it('9.4 请求侧：tool_result 翻回 role:tool 且 toolCallId 正确', async () => {
    await postMessages(h, TOOL_ROUNDTRIP_BODY, authHeaders(h))
    const messages = h.adapter.calls[0]!.messages as Array<Record<string, unknown>>
    expect(messages).toHaveLength(3)
    // 工具结果是一等 tool 消息，不是用户文本。
    expect(messages[2]!['role']).toBe('tool')
    expect(messages[2]!['toolCallId']).toBe('call-1')
    expect(messages[2]!['content']).toBe('晴，25 度')
    // 它前面是 assistant 的工具调用。
    expect(messages[1]!['role']).toBe('assistant')
  })

  it('9.4 请求侧：历史 tool_use 翻回 tool_calls，tools 翻为内部 schema', async () => {
    await postMessages(h, TOOL_ROUNDTRIP_BODY, authHeaders(h))
    const options = h.adapter.calls[0]!
    const assistant = options.messages[1] as Record<string, unknown>
    expect(assistant['content']).toBe('我查一下')
    const toolCalls = assistant['tool_calls'] as Array<Record<string, unknown>>
    expect(toolCalls).toEqual([{
      id: 'call-1',
      type: 'function',
      function: { name: 'get_weather', arguments: '{"city":"杭州"}' },
    }])
    expect(options.tools).toEqual([{
      name: 'get_weather',
      description: '查询天气',
      parameters: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] },
    }])
  })

  it('9.4 完整往返：一次带工具的对话能走通（调用 → 结果 → 继续生成）', async () => {
    // 第一轮：模型决定调用工具。
    const res1 = await postMessages(h, {
      model: 'fake/model-a', max_tokens: 200,
      tools: [TOOL_ROUNDTRIP_BODY.tools[0]],
      messages: [{ role: 'user', content: '杭州天气怎么样？' }],
    }, authHeaders(h))
    expect(res1.status).toBe(200)
    // 第二轮：把工具结果带回历史（适配器不报错、正常生成，即为可用）。
    const res2 = await postMessages(h, TOOL_ROUNDTRIP_BODY, authHeaders(h))
    expect(res2.status).toBe(200)
    const body = await res2.json() as { type: string }
    expect(body.type).toBe('message')
  })

  it('9.4 工具结果前的文本不被吞掉（user 消息拆分为 user → tool）', async () => {
    await postMessages(h, {
      model: 'fake/model-a', max_tokens: 100,
      messages: [
        { role: 'user', content: [
          { type: 'text', text: '补充说明' },
          { type: 'tool_result', tool_use_id: 'call-9', content: '结果' },
        ] },
      ],
    }, authHeaders(h))
    const messages = h.adapter.calls[0]!.messages as Array<Record<string, unknown>>
    expect(messages).toHaveLength(2)
    expect(messages[0]).toEqual({ role: 'user', content: [{ type: 'text', text: '补充说明' }] })
    expect(messages[1]!['role']).toBe('tool')
  })
})

describe('Anthropic Messages · 错误信封（9.5）', () => {
  let h: Harness
  beforeEach(async () => {
    h = await startGateway()
    withKey(h, h.keys.create({ name: 'anthropic-err' }).plaintext)
  })
  afterEach(async () => { await stopGateway(h) })

  it('9.5 模型不存在 → 404 + not_found_error 信封', async () => {
    const res = await postMessages(h, {
      model: 'ghost/nope', max_tokens: 10,
      messages: [{ role: 'user', content: 'hi' }],
    }, authHeaders(h))
    expect(res.status).toBe(404)
    const body = await res.json() as { type: string; error: { type: string; message: string } }
    // 必须是 Anthropic 形状，而不是 OpenAI 的 {"error":{"message":...}}。
    expect(body.type).toBe('error')
    expect(body.error.type).toBe('not_found_error')
    expect(typeof body.error.message).toBe('string')
  })

  it('9.5 无凭据 → 401 + authentication_error 信封', async () => {
    const res = await postMessages(h, {
      model: 'fake/model-a', max_tokens: 10,
      messages: [{ role: 'user', content: 'hi' }],
    }, {})
    expect(res.status).toBe(401)
    const body = await res.json() as { type: string; error: { type: string } }
    expect(body.type).toBe('error')
    expect(body.error.type).toBe('authentication_error')
  })

  it('9.5 请求体缺 messages → 400 信封（而非 OpenAI 形状）', async () => {
    const res = await postMessages(h, { model: 'fake/model-a', max_tokens: 10 }, authHeaders(h))
    expect(res.status).toBe(400)
    const body = await res.json() as { type: string; error: { type: string } }
    expect(body.type).toBe('error')
    expect(body.error.type).toBe('invalid_request_error')
  })
})

describe('OpenAI ↔ Anthropic 对拍（9.6）', () => {
  let h: Harness
  beforeEach(async () => {
    h = await startGateway()
    withKey(h, h.keys.create({ name: '对拍' }).plaintext)
  })
  afterEach(async () => { await stopGateway(h) })

  function openaiHeaders(): Record<string, string> {
    return { Authorization: `Bearer ${(h as unknown as { primaryKey: string }).primaryKey}` }
  }

  it('9.6 纯文本：两个端点的正文一致', async () => {
    const openaiRes = await fetch(`${h.url}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...openaiHeaders() },
      body: JSON.stringify({ model: 'fake/model-a', messages: [{ role: 'user', content: 'hi' }] }),
    })
    const anthropicRes = await postMessages(h, {
      model: 'fake/model-a', max_tokens: 100,
      messages: [{ role: 'user', content: 'hi' }],
    }, authHeaders(h))

    const openai = await openaiRes.json() as { choices: Array<{ message: { content: string } }> }
    const anthropic = await anthropicRes.json() as { content: Array<{ type: string; text: string }> }
    const openaiText = openai.choices[0]!.message.content
    const anthropicText = anthropic.content.filter(b => b.type === 'text').map(b => b.text).join('')
    expect(anthropicText).toBe(openaiText)
    expect(anthropicText).toBe(UPSTREAM_TEXT)
    // 上游收到的请求也一致（同一适配器、同一模型）。
    expect(h.adapter.calls).toHaveLength(2)
    expect(h.adapter.calls[0]!.model).toBe('model-a')
    expect(h.adapter.calls[1]!.model).toBe('model-a')
  })

  it('9.6 工具调用：两个端点的工具语义一致（差异仅在协议形状）', async () => {
    h.adapter.behavior = 'tool-call'
    const openaiRes = await fetch(`${h.url}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...openaiHeaders() },
      body: JSON.stringify({
        model: 'fake/model-a',
        messages: [{ role: 'user', content: 'hi' }],
      }),
    })
    const anthropicRes = await postMessages(h, {
      model: 'fake/model-a', max_tokens: 100,
      messages: [{ role: 'user', content: 'hi' }],
    }, authHeaders(h))

    const openai = await openaiRes.json() as {
      choices: Array<{ finish_reason: string; message: { tool_calls?: Array<{ id: string; function: { name: string; arguments: string } }> } }>
    }
    const anthropic = await anthropicRes.json() as {
      stop_reason: string
      content: Array<{ type: string; id?: string; name?: string; input?: unknown }>
    }

    // 结束原因语义一致。
    expect(openai.choices[0]!.finish_reason).toBe('tool_calls')
    expect(anthropic.stop_reason).toBe('tool_use')
    // 工具调用语义一致：同一个 id、名字与参数（OpenAI 是 JSON 字符串，Anthropic 是对象）。
    const openaiCall = openai.choices[0]!.message.tool_calls?.[0]
    const anthropicUse = anthropic.content.find(b => b.type === 'tool_use')
    expect(openaiCall).toBeDefined()
    expect(anthropicUse).toBeDefined()
    expect(openaiCall!.id).toBe(anthropicUse!.id)
    expect(openaiCall!.function.name).toBe(anthropicUse!.name)
    expect(JSON.parse(openaiCall!.function.arguments)).toEqual(anthropicUse!.input)
  })
})
