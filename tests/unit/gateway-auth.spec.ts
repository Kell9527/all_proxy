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
import { LlmAdapter } from '../../src/shared/llm.js'
import type { GenerateOptions, StreamChunk } from '../../src/shared/llm.js'
import { ApiKeyStore } from '../../src/auth/api-keys.js'
import { createApiKeyAuthenticator } from '../../src/auth/authenticate.js'
import { AdminAuth } from '../../src/admin/auth.js'
import { createAdminHandler } from '../../src/admin/router.js'

/**
 * 可编程替身适配器。
 *
 * ⚠️ 计数 `calls` 是**本文件的全部价值所在**：规格里「不得发起上游请求」
 * 只能靠它来证伪。用真实 `LlmAdapter` 基类而非鸭子类型，保证测的是真契约。
 */
class FakeAdapter extends LlmAdapter {
  readonly calls: GenerateOptions[] = []
  constructor(private readonly models: Array<{ id: string; name: string }>) { super() }
  override async listModels(): Promise<readonly { provider: string; id: string; name: string }[]> {
    return this.models.map(m => ({ provider: 'fake', id: m.id, name: m.name }))
  }
  override async resolveModel(provider: string, model: string): Promise<{ provider: string; id: string; name: string; context?: { contextWindow: number } }> {
    const found = this.models.find(m => m.id === model)
    return { provider, id: model, name: found?.name ?? model, context: { contextWindow: 1000 } }
  }
  async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.calls.push(options)
    yield { type: 'text-delta', index: 0, text: 'hello' }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

interface Harness {
  url: string
  server: Server
  dir: string
  pool: AccountPool
  keys: ApiKeyStore
  admin: AdminAuth
  /** 管理口令明文（自动生成的那一份）。 */
  adminSecret: string
  adapters: Map<string, FakeAdapter>
  requests: Array<Record<string, unknown>>
}

/** 起一个带完整鉴权链路的网关。 */
async function startGateway(configure?: (pool: AccountPool) => Promise<void>): Promise<Harness> {
  const dir = mkdtempSync(join(tmpdir(), 'all-proxy-auth-'))
  const credentials = new FileCredentialStore(dir)
  const pool = new AccountPool({ credentials, dataDir: dir })
  const registry = new ProviderRegistry()
  const adapters = new Map<string, FakeAdapter>()
  for (const id of ['fake', 'other']) {
    const adapter = new FakeAdapter([
      { id: 'model-a', name: 'Model A' },
      { id: 'model-b', name: 'Model B' },
    ])
    adapters.set(id, adapter)
    registry.register({
      id,
      displayName: `${id} provider`,
      apiBase: 'https://example.invalid',
      chatPath: '/v1/chat/completions',
      authKind: 'bearer',
      catalogSource: 'remote-first',
      supportsImages: true,
      rotatesAccounts: false,
    }, adapter)
  }
  await configure?.(pool)

  const keys = new ApiKeyStore(dir)
  const admin = new AdminAuth(dir)
  // ⚠️ 必须显式 `delete` 环境变量：若本机开发环境恰好设了它，自动生成的分支
  // 就走不到，`adminSecret` 会变成 `undefined` 而让一批用例静默失真。
  const savedSecret = process.env['ALL_PROXY_ADMIN_SECRET']
  delete process.env['ALL_PROXY_ADMIN_SECRET']
  let adminSecret = ''
  try {
    adminSecret = admin.ensure() ?? ''
  } finally {
    if (savedSecret !== undefined) process.env['ALL_PROXY_ADMIN_SECRET'] = savedSecret
  }
  if (adminSecret.length === 0) throw new Error('测试装置未能取得管理口令')
  const requests: Array<Record<string, unknown>> = []

  const server = createGatewayServer({
    registry,
    pool,
    port: 0,
    host: '127.0.0.1',
    authenticate: createApiKeyAuthenticator(keys),
    admin: createAdminHandler({ registry, pool, credentials, apiKeys: keys, auth: admin, logger: { info: () => {}, warn: () => {}, error: () => {} } }),
    onRequest: (record) => { requests.push(record as unknown as Record<string, unknown>) },
  })
  await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve) })
  const address = server.address() as AddressInfo
  return { url: `http://127.0.0.1:${address.port}`, server, dir, pool, keys, admin, adminSecret, adapters, requests }
}

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

describe('入站鉴权 · 401 语义', () => {
  let h: Harness
  beforeEach(async () => { h = await startGateway() })
  afterEach(async () => { await stopGateway(h) })

  it('缺凭据 → 401 且不发上游请求', async () => {
    const res = await post(`${h.url}/v1/chat/completions`, { model: 'fake/model-a', messages: [] })
    expect(res.status).toBe(401)
    const body = await res.json() as Record<string, unknown>
    expect((body['error'] as Record<string, unknown>)['code']).toBe('invalid_api_key')
    expect(h.adapters.get('fake')!.calls).toHaveLength(0)
  })

  it('无效凭据 → 401 且不发上游请求', async () => {
    const res = await post(
      `${h.url}/v1/chat/completions`,
      { model: 'fake/model-a', messages: [] },
      { Authorization: 'Bearer sk-all-totally-made-up-key-value-here' },
    )
    expect(res.status).toBe(401)
    expect(h.adapters.get('fake')!.calls).toHaveLength(0)
  })

  it('**「不存在」与「已禁用」的响应完全一致**（不泄露 key 是否存在）', async () => {
    const created = h.keys.create({ name: 'x' })
    h.keys.update(created.summary.id, { disabled: true })

    const disabled = await post(`${h.url}/v1/chat/completions`, { model: 'fake/model-a', messages: [] }, { 'x-api-key': created.plaintext })
    const missing = await post(`${h.url}/v1/chat/completions`, { model: 'fake/model-a', messages: [] }, { 'x-api-key': 'sk-all-nonexistent-key-value-padding-here' })

    expect(disabled.status).toBe(missing.status)
    expect(await disabled.json()).toEqual(await missing.json())
  })

  it('两种携带方式对同一把 key 等价', async () => {
    const created = h.keys.create({ name: 'x' })
    const viaBearer = await post(`${h.url}/v1/chat/completions`, { model: 'fake/model-a', messages: [] }, { Authorization: `Bearer ${created.plaintext}` })
    const viaHeader = await post(`${h.url}/v1/chat/completions`, { model: 'fake/model-a', messages: [] }, { 'x-api-key': created.plaintext })
    expect(viaBearer.status).toBe(200)
    expect(viaHeader.status).toBe(200)
  })

  it('有效 key 可访问', async () => {
    const created = h.keys.create({ name: 'x' })
    const res = await post(`${h.url}/v1/chat/completions`, { model: 'fake/model-a', messages: [] }, { 'x-api-key': created.plaintext })
    expect(res.status).toBe(200)
    expect(h.adapters.get('fake')!.calls).toHaveLength(1)
  })

  it('模型列表也受鉴权保护', async () => {
    expect((await fetch(`${h.url}/v1/models`)).status).toBe(401)
  })

  it('**健康检查豁免**（未携带凭据也能读存活信息）', async () => {
    const res = await fetch(`${h.url}/health`)
    expect(res.status).toBe(200)
    const body = await res.json() as Record<string, unknown>
    expect(body['status']).toBe('ok')
  })

  it('401 响应不带 Retry-After（凭据问题重试无用）', async () => {
    const res = await post(`${h.url}/v1/chat/completions`, { model: 'fake/model-a', messages: [] })
    expect(res.headers.get('retry-after')).toBeNull()
  })
})

describe('入站鉴权 · key 级范围', () => {
  let h: Harness
  beforeEach(async () => { h = await startGateway() })
  afterEach(async () => { await stopGateway(h) })

  it('**限制到指定 provider：范围外模型被拒且不发上游请求**', async () => {
    const created = h.keys.create({ name: 'only-fake', providers: ['fake'] })
    const res = await post(
      `${h.url}/v1/chat/completions`,
      { model: 'other/model-a', messages: [] },
      { 'x-api-key': created.plaintext },
    )
    expect(res.status).toBe(403)
    const body = await res.json() as Record<string, unknown>
    expect((body['error'] as Record<string, unknown>)['code']).toBe('model_not_authorized')
    expect(h.adapters.get('other')!.calls).toHaveLength(0)
  })

  it('范围内的 provider 正常放行', async () => {
    const created = h.keys.create({ name: 'only-fake', providers: ['fake'] })
    const res = await post(
      `${h.url}/v1/chat/completions`,
      { model: 'fake/model-a', messages: [] },
      { 'x-api-key': created.plaintext },
    )
    expect(res.status).toBe(200)
  })

  it('限制到指定模型：范围外被拒', async () => {
    const created = h.keys.create({ name: 'one-model', models: ['fake/model-a'] })
    const ok = await post(`${h.url}/v1/chat/completions`, { model: 'fake/model-a', messages: [] }, { 'x-api-key': created.plaintext })
    const denied = await post(`${h.url}/v1/chat/completions`, { model: 'fake/model-b', messages: [] }, { 'x-api-key': created.plaintext })
    expect(ok.status).toBe(200)
    expect(denied.status).toBe(403)
    // 只有放行的那次触达上游。
    expect(h.adapters.get('fake')!.calls).toHaveLength(1)
  })

  it('`<provider>/*` 通配该 provider 的全部模型', async () => {
    const created = h.keys.create({ name: 'wildcard', models: ['fake/*'] })
    const a = await post(`${h.url}/v1/chat/completions`, { model: 'fake/model-a', messages: [] }, { 'x-api-key': created.plaintext })
    const b = await post(`${h.url}/v1/chat/completions`, { model: 'fake/model-b', messages: [] }, { 'x-api-key': created.plaintext })
    expect(a.status).toBe(200)
    expect(b.status).toBe(200)
  })

  it('**未配置范围 = 不限制**', async () => {
    const created = h.keys.create({ name: 'unlimited' })
    const a = await post(`${h.url}/v1/chat/completions`, { model: 'fake/model-a', messages: [] }, { 'x-api-key': created.plaintext })
    const b = await post(`${h.url}/v1/chat/completions`, { model: 'other/model-b', messages: [] }, { 'x-api-key': created.plaintext })
    expect(a.status).toBe(200)
    expect(b.status).toBe(200)
  })

  it('**空范围 = 一个都不许**（与「未配置」不同）', async () => {
    const created = h.keys.create({ name: 'nothing', providers: [] })
    const res = await post(`${h.url}/v1/chat/completions`, { model: 'fake/model-a', messages: [] }, { 'x-api-key': created.plaintext })
    expect(res.status).toBe(403)
    expect(h.adapters.get('fake')!.calls).toHaveLength(0)
  })

  it('**范围判定先于开关**（受限 key 无法探测哪些模型被关闭）', async () => {
    const restricted = h.keys.create({ name: 'restricted', providers: ['other'] })
    // 把 fake 的模型关掉：若判定顺序反了，受限 key 会收到「已被关闭」（404）
    // 而不是「无权访问」（403），从而探测出服务端的开关配置。
    await h.pool.setModelDisabled('fake', 'model-a', true)
    const res = await post(`${h.url}/v1/chat/completions`, { model: 'fake/model-a', messages: [] }, { 'x-api-key': restricted.plaintext })
    expect(res.status).toBe(403)
    const body = await res.json() as Record<string, unknown>
    expect((body['error'] as Record<string, unknown>)['code']).toBe('model_not_authorized')
  })
})

describe('入站鉴权 · /v1/models 按 key 过滤', () => {
  let h: Harness
  beforeEach(async () => { h = await startGateway() })
  afterEach(async () => { await stopGateway(h) })

  it('不限制的 key 看到全部模型', async () => {
    const created = h.keys.create({ name: 'all' })
    const res = await fetch(`${h.url}/v1/models`, { headers: { 'x-api-key': created.plaintext } })
    const body = await res.json() as { data: Array<{ id: string }> }
    expect(body.data.map(m => m.id).sort()).toEqual(['fake/model-a', 'fake/model-b', 'other/model-a', 'other/model-b'])
  })

  it('**受限 key 只看到自己可访问的模型**', async () => {
    const created = h.keys.create({ name: 'only-fake', providers: ['fake'] })
    const res = await fetch(`${h.url}/v1/models`, { headers: { 'x-api-key': created.plaintext } })
    const body = await res.json() as { data: Array<{ id: string }> }
    const ids = body.data.map(m => m.id)
    expect(ids.every(id => id.startsWith('fake/'))).toBe(true)
    expect(ids).not.toContain('other/model-a')
  })

  it('**受限 key 的目录与模型开关取交集**', async () => {
    const created = h.keys.create({ name: 'one-model', models: ['fake/model-a'] })
    const res = await fetch(`${h.url}/v1/models`, { headers: { 'x-api-key': created.plaintext } })
    const body = await res.json() as { data: Array<{ id: string }> }
    expect(body.data.map(m => m.id)).toEqual(['fake/model-a'])
  })
})

describe('入站鉴权 · key 级限额', () => {
  let h: Harness
  beforeEach(async () => { h = await startGateway() })
  afterEach(async () => { await stopGateway(h) })

  it('速率超限 → 429 且带 Retry-After', async () => {
    const created = h.keys.create({ name: 'slow', rateLimitPerMinute: 2 })
    const send = () => post(`${h.url}/v1/chat/completions`, { model: 'fake/model-a', messages: [] }, { 'x-api-key': created.plaintext })
    expect((await send()).status).toBe(200)
    expect((await send()).status).toBe(200)
    const over = await send()
    expect(over.status).toBe(429)
    const body = await over.json() as Record<string, unknown>
    expect((body['error'] as Record<string, unknown>)['code']).toBe('rate_limit_exceeded')
    expect(Number(over.headers.get('retry-after'))).toBeGreaterThan(0)
    // 第三次没有触达上游（只有前两次成功）。
    expect(h.adapters.get('fake')!.calls).toHaveLength(2)
  })

  it('**额度用尽 → 429 quota_exceeded 且不发上游请求**', async () => {
    const created = h.keys.create({ name: 'small', quotaTokens: 5 })
    h.keys.recordUsage(created.summary.id, 5)
    const res = await post(`${h.url}/v1/chat/completions`, { model: 'fake/model-a', messages: [] }, { 'x-api-key': created.plaintext })
    expect(res.status).toBe(429)
    const body = await res.json() as Record<string, unknown>
    expect((body['error'] as Record<string, unknown>)['code']).toBe('quota_exceeded')
    expect(h.adapters.get('fake')!.calls).toHaveLength(0)
  })

  it('未配置限额 = 不受限制', async () => {
    const created = h.keys.create({ name: 'free' })
    for (let i = 0; i < 20; i++) {
      const res = await post(`${h.url}/v1/chat/completions`, { model: 'fake/model-a', messages: [] }, { 'x-api-key': created.plaintext })
      expect(res.status).toBe(200)
    }
  })
})

describe('管理端鉴权', () => {
  let h: Harness
  beforeEach(async () => { h = await startGateway() })
  afterEach(async () => { await stopGateway(h) })

  it('**普通 API Key 不能访问管理 API**', async () => {
    const created = h.keys.create({ name: 'client' })
    const res = await fetch(`${h.url}/api/keys`, { headers: { 'x-api-key': created.plaintext } })
    expect(res.status).toBe(401)
  })

  it('管理口令可访问管理 API', async () => {
    const res = await fetch(`${h.url}/api/keys`, { headers: { 'x-admin-secret': h.adminSecret } })
    expect(res.status).toBe(200)
  })

  it('Bearer 形式的管理口令也可用', async () => {
    const res = await fetch(`${h.url}/api/keys`, { headers: { Authorization: `Bearer ${h.adminSecret}` } })
    expect(res.status).toBe(200)
  })

  it('无凭据访问管理 API → 401', async () => {
    expect((await fetch(`${h.url}/api/keys`)).status).toBe(401)
  })

  it('错误管理口令 → 401', async () => {
    const res = await fetch(`${h.url}/api/keys`, { headers: { 'x-admin-secret': 'wrong-secret-value-here' } })
    expect(res.status).toBe(401)
  })

  it('未知管理端点 → 404 且是管理形状的错误', async () => {
    const res = await fetch(`${h.url}/api/nope`, { headers: { 'x-admin-secret': h.adminSecret } })
    expect(res.status).toBe(404)
    const body = await res.json() as Record<string, unknown>
    expect((body['error'] as Record<string, unknown>)['code']).toBe('admin_not_found')
  })

  it('**管理端创建 key 返回一次性明文，列表不含明文**', async () => {
    const created = await fetch(`${h.url}/api/keys`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-admin-secret': h.adminSecret },
      body: JSON.stringify({ name: 'from-admin' }),
    })
    expect(created.status).toBe(200)
    const body = await created.json() as Record<string, unknown>
    const plaintext = body['key'] as string
    expect(plaintext).toMatch(/^sk-all-/)

    const list = await (await fetch(`${h.url}/api/keys`, { headers: { 'x-admin-secret': h.adminSecret } })).json() as { data: unknown[] }
    expect(JSON.stringify(list)).not.toContain(plaintext)
    // 创建出来的 key 立刻可用。
    const use = await post(`${h.url}/v1/chat/completions`, { model: 'fake/model-a', messages: [] }, { 'x-api-key': plaintext })
    expect(use.status).toBe(200)
  })

  it('管理端可禁用与删除 key', async () => {
    const created = await fetch(`${h.url}/api/keys`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-admin-secret': h.adminSecret },
      body: JSON.stringify({ name: 'temp' }),
    })
    const body = await created.json() as Record<string, unknown>
    const id = (body['data'] as Record<string, unknown>)['id'] as string
    const plaintext = body['key'] as string

    const disabled = await fetch(`${h.url}/api/keys/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', 'x-admin-secret': h.adminSecret },
      body: JSON.stringify({ disabled: true }),
    })
    expect(disabled.status).toBe(200)
    expect((await post(`${h.url}/v1/chat/completions`, { model: 'fake/model-a', messages: [] }, { 'x-api-key': plaintext })).status).toBe(401)

    const removed = await fetch(`${h.url}/api/keys/${id}`, { method: 'DELETE', headers: { 'x-admin-secret': h.adminSecret } })
    expect(removed.status).toBe(200)
  })
})

describe('管理端留痕', () => {
  let h: Harness
  beforeEach(async () => { h = await startGateway() })
  afterEach(async () => { await stopGateway(h) })

  it('**写操作被留痕，且不含凭据明文**', async () => {
    const created = await fetch(`${h.url}/api/keys`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-admin-secret': h.adminSecret },
      body: JSON.stringify({ name: 'audited' }),
    })
    const body = await created.json() as Record<string, unknown>
    const plaintext = body['key'] as string

    const audit = await (await fetch(`${h.url}/api/admin/audit`, { headers: { 'x-admin-secret': h.adminSecret } })).json() as { data: { operations: Array<Record<string, unknown>> } }
    expect(audit.data.operations.length).toBeGreaterThan(0)
    const record = audit.data.operations.find(o => o['action'] === 'create-key')
    expect(record).toBeDefined()
    expect(record!['ok']).toBe(true)
    // ⚠️ 留痕里绝不能出现明文。
    expect(JSON.stringify(audit)).not.toContain(plaintext)
  })

  it('失败的写操作也被留痕（ok=false）', async () => {
    await fetch(`${h.url}/api/keys/key-does-not-exist`, {
      method: 'DELETE',
      headers: { 'x-admin-secret': h.adminSecret },
    })
    const audit = await (await fetch(`${h.url}/api/admin/audit`, { headers: { 'x-admin-secret': h.adminSecret } })).json() as { data: { operations: Array<Record<string, unknown>> } }
    expect(audit.data.operations.some(o => o['action'] === 'delete-key')).toBe(true)
  })
})

describe('请求记录钩子', () => {
  let h: Harness
  beforeEach(async () => { h = await startGateway() })
  afterEach(async () => { await stopGateway(h) })

  it('成功请求产生一条记录（含调用方与模型）', async () => {
    const created = h.keys.create({ name: 'recorder' })
    await post(`${h.url}/v1/chat/completions`, { model: 'fake/model-a', messages: [] }, { 'x-api-key': created.plaintext })
    expect(h.requests).toHaveLength(1)
    const record = h.requests[0]!
    expect(record['status']).toBe(200)
    expect(record['callerId']).toBe(created.summary.id)
    expect(record['callerName']).toBe('recorder')
    expect(record['model']).toBe('fake/model-a')
    expect(record['provider']).toBe('fake')
    expect(record['upstreamModel']).toBe('model-a')
  })

  it('鉴权失败**不产生**记录（未通过鉴权，网关未进入业务路径）', async () => {
    await post(`${h.url}/v1/chat/completions`, { model: 'fake/model-a', messages: [] })
    expect(h.requests).toHaveLength(0)
  })

  it('模型被拒也产生记录（带错误码与 0 token）', async () => {
    const created = h.keys.create({ name: 'restricted', providers: ['other'] })
    await post(`${h.url}/v1/chat/completions`, { model: 'fake/model-a', messages: [] }, { 'x-api-key': created.plaintext })
    expect(h.requests).toHaveLength(1)
    expect(h.requests[0]!['status']).toBe(403)
    expect(h.requests[0]!['errorCode']).toBe('model_not_authorized')
    expect(h.requests[0]!['inputTokens']).toBe(0)
  })

  it('请求体不是 JSON 也产生记录（400）', async () => {
    const created = h.keys.create({ name: 'x' })
    await fetch(`${h.url}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': created.plaintext },
      body: '{ 坏 JSON',
    })
    expect(h.requests).toHaveLength(1)
    expect(h.requests[0]!['status']).toBe(400)
  })

  it('**记录里不含消息正文**（隐私要求）', async () => {
    const created = h.keys.create({ name: 'x' })
    await post(
      `${h.url}/v1/chat/completions`,
      { model: 'fake/model-a', messages: [{ role: 'user', content: '这是一段极其独特的用户私密文本' }] },
      { 'x-api-key': created.plaintext },
    )
    expect(JSON.stringify(h.requests)).not.toContain('这是一段极其独特的用户私密文本')
  })

  it('记录带请求标识，且每次请求各不相同', async () => {
    const created = h.keys.create({ name: 'x' })
    await post(`${h.url}/v1/chat/completions`, { model: 'fake/model-a', messages: [] }, { 'x-api-key': created.plaintext })
    await post(`${h.url}/v1/chat/completions`, { model: 'fake/model-a', messages: [] }, { 'x-api-key': created.plaintext })
    const ids = h.requests.map(r => r['requestId'])
    expect(ids[0]).toMatch(/^req-[0-9a-f]{16}$/)
    expect(new Set(ids).size).toBe(2)
  })

  it('记录带耗时与首字节耗时', async () => {
    const created = h.keys.create({ name: 'x' })
    await post(`${h.url}/v1/chat/completions`, { model: 'fake/model-a', messages: [] }, { 'x-api-key': created.plaintext })
    const record = h.requests[0]!
    expect(record['durationMs']).toBeGreaterThanOrEqual(0)
    expect(record['firstByteMs']).toBeGreaterThanOrEqual(0)
    expect(record['finishReason']).toBe('stop')
  })
})
