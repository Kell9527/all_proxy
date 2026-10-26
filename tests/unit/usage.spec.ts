import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { AddressInfo } from 'node:net'
import type { Server } from 'node:http'
import { AccountPool } from '../../src/pool/account-pool.js'
import { FileCredentialStore } from '../../src/pool/store.js'
import { ProviderRegistry } from '../../src/providers/registry.js'
import { createGatewayServer, type RequestRecord } from '../../src/gateway/server.js'
import { LlmAdapter, LlmError } from '../../src/shared/llm.js'
import type { GenerateOptions, StreamChunk } from '../../src/shared/llm.js'
import { ApiKeyStore } from '../../src/auth/api-keys.js'
import { createApiKeyAuthenticator } from '../../src/auth/authenticate.js'
import { AdminAuth } from '../../src/admin/auth.js'
import { createAdminHandler } from '../../src/admin/router.js'
import { UsageStore, DEFAULT_RETENTION, type UsageRecord } from '../../src/usage/store.js'
import { createUsageRecorder, toUsageRecord } from '../../src/usage/recorder.js'

/**
 * 用量记录（tasks 8.1–8.8）。
 *
 * 口径断言是本文件的核心价值：`promptTokens` 必须与**响应体**的
 * `prompt_tokens` 一致（含缓存），否则用户拿响应数字对不上用量页。
 */

const NOW_MS = 1_700_000_000_000

/** 构造一条待写入的用量记录（字段齐全，按需覆盖）。 */
function usageRecord(patch: Partial<UsageRecord> = {}): UsageRecord {
  return {
    requestId: patch.requestId ?? `req-${Math.random().toString(36).slice(2)}`,
    at: new Date(NOW_MS).toISOString(),
    keyId: 'key-1',
    keyName: '测试 key',
    provider: 'fake',
    model: 'fake/model-a',
    upstreamModel: 'model-a',
    accountId: 'account-9',
    reasoningEffort: '',
    promptTokens: 10,
    completionTokens: 5,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    stream: false,
    durationMs: 42,
    firstByteMs: 12,
    finishReason: 'stop',
    status: 200,
    errorCode: '',
    ...patch,
  }
}

/** 构造一条网关请求记录（Pick 必填字段齐全）。 */
function requestRecord(patch: Partial<RequestRecord> = {}): RequestRecord {
  return {
    requestId: `req-${Math.random().toString(36).slice(2)}`,
    callerId: 'key-1',
    callerName: '测试 key',
    model: 'fake/model-a',
    stream: false,
    status: 200,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    durationMs: 10,
    ...patch,
  }
}

describe('用量存储（SQLite）', () => {
  let dir: string
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'all-proxy-usage-')) })
  afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

  it('8.1 建表并写入成功', () => {
    const store = new UsageStore(dir)
    expect(store.record(usageRecord({ requestId: 'req-1' }))).toBe(true)
    expect(store.count()).toBe(1)
    store.close()
  })

  it('8.1 重启（新实例）后此前的记录仍可查询', () => {
    const store = new UsageStore(dir)
    store.record(usageRecord({ requestId: 'req-persist' }))
    store.close()
    const reopened = new UsageStore(dir)
    const found = reopened.query({ limit: 10 }).records.find(r => r.requestId === 'req-persist')
    expect(found).toBeDefined()
    expect(found?.provider).toBe('fake')
    reopened.close()
  })

  it('8.2 promptTokens = inputTokens + 缓存读 + 缓存写（与响应 prompt_tokens 同口径）', () => {
    const converted = toUsageRecord(requestRecord({
      inputTokens: 100,
      outputTokens: 21,
      cacheReadTokens: 20,
      cacheWriteTokens: 30,
    }), NOW_MS)
    // 响应体里的 prompt_tokens 是总输入（100+20+30=150），用量必须同口径。
    expect(converted.promptTokens).toBe(150)
    expect(converted.completionTokens).toBe(21)
    expect(converted.cacheReadTokens).toBe(20)
  })

  it('8.2 成功请求经 recorder 落盘，token 与上游 usage 一致', async () => {
    const h = await startUsageGateway(dir, 'ok')
    try {
      const key = h.keys.create({ name: '用量测试' })
      const res = await post(`${h.url}/v1/chat/completions`, {
        model: 'fake/model-a',
        messages: [{ role: 'user', content: 'hi' }],
      }, { Authorization: `Bearer ${key.plaintext}` })
      expect(res.status).toBe(200)
      const body = await res.json() as { usage?: { prompt_tokens?: number; completion_tokens?: number } }
      await waitFor(() => h.usage.query({ limit: 10 }).records.length > 0)
      const record = h.usage.query({ limit: 10 }).records[0]!
      // 与响应体 usage 完全一致 —— 这是用户唯一能自己验证的口径。
      expect(record.promptTokens).toBe(body.usage?.prompt_tokens)
      expect(record.completionTokens).toBe(body.usage?.completion_tokens)
    } finally {
      await stopGateway(h)
    }
  })

  it('8.3 失败请求也落盘（状态码与错误码，token 为零）', async () => {
    const h = await startUsageGateway(dir, 'ok')
    try {
      const key = h.keys.create({ name: '失败记录' })
      // 硬拦截的 404：模型不存在。
      const res = await post(`${h.url}/v1/chat/completions`, { model: 'ghost/nope', messages: [] },
        { Authorization: `Bearer ${key.plaintext}` })
      expect(res.status).toBe(404)
      await waitFor(() => h.usage.query({ outcome: 'failure' }).records.length > 0)
      const record = h.usage.query({ outcome: 'failure' }).records[0]!
      expect(record.status).toBe(404)
      expect(record.errorCode).toBe('model_not_found')
      expect(record.promptTokens).toBe(0)
      expect(record.completionTokens).toBe(0)
    } finally {
      await stopGateway(h)
    }
  })

  it('8.4 记录的是实际完成请求的账号（透传 accountId，而非池默认）', () => {
    const store = new UsageStore(dir)
    const recorder = createUsageRecorder({ store, now: () => NOW_MS })
    // 轮换场景下适配器登记的账号是 account-9；池默认（第一个账号）是 account-1。
    recorder(requestRecord({ accountId: 'account-9' }))
    const found = store.query().records[0]!
    expect(found.accountId).toBe('account-9')
    expect(found.accountId).not.toBe('account-1')
    store.close()
  })

  it('思考等级：入参透传落盘，未指定记空串', () => {
    const converted = toUsageRecord(requestRecord({ reasoningEffort: 'high' }), NOW_MS)
    expect(converted.reasoningEffort).toBe('high')
    expect(toUsageRecord(requestRecord(), NOW_MS).reasoningEffort).toBe('')
  })

  it('思考等级：端到端从请求体采到用量库', async () => {
    const h = await startUsageGateway(dir, 'ok')
    try {
      const key = h.keys.create({ name: '档位采集' })
      const res = await post(`${h.url}/v1/chat/completions`, {
        model: 'fake/model-a',
        messages: [{ role: 'user', content: 'hi' }],
        reasoning_effort: 'xhigh',
      }, { Authorization: `Bearer ${key.plaintext}` })
      expect(res.status).toBe(200)
      await waitFor(() => h.requests.length > 0)
      // 内存记录（onRequest）与落盘记录都必须带上，两处口径不能分叉。
      expect(h.requests[0]!.reasoningEffort).toBe('xhigh')
      await waitFor(() => h.usage.query().records.length > 0)
      expect(h.usage.query().records[0]!.reasoningEffort).toBe('xhigh')
    } finally {
      await stopGateway(h)
    }
  })

  it('思考等级：模型被拦掉的请求也记下客户端原本要的档位', async () => {
    const h = await startUsageGateway(dir, 'ok')
    try {
      const key = h.keys.create({ name: '拦截仍记档位' })
      const res = await post(`${h.url}/v1/chat/completions`, {
        model: 'ghost/nope',
        messages: [],
        reasoning_effort: 'max',
      }, { Authorization: `Bearer ${key.plaintext}` })
      expect(res.status).toBe(404)
      await waitFor(() => h.usage.query({ outcome: 'failure' }).records.length > 0)
      // 采集点在模型解析**之前**，故这条 404 仍带着档位。
      expect(h.usage.query({ outcome: 'failure' }).records[0]!.reasoningEffort).toBe('max')
    } finally {
      await stopGateway(h)
    }
  })

  it('思考等级：汇总给出分桶分布，且可按档位筛选（空值筛「未指定」）', async () => {
    const store = new UsageStore(dir)
    for (const [id, effort] of [['e-high-1', 'high'], ['e-high-2', 'high'], ['e-low', 'low'], ['e-none', '']] as const) {
      store.record(usageRecord({ requestId: id, reasoningEffort: effort }))
    }
    const all = store.query()
    expect(all.summary.reasoningEfforts).toEqual([
      { effort: 'high', requests: 2 },
      { effort: '', requests: 1 },
      { effort: 'low', requests: 1 },
    ])
    // 空串是有效筛选值（未指定档位），不是「不过滤」。
    const unspecified = store.query({ reasoningEffort: '' })
    expect(unspecified.summary.total).toBe(1)
    expect(unspecified.records[0]!.requestId).toBe('e-none')
    expect(store.query({ reasoningEffort: 'high' }).summary.total).toBe(2)
    store.close()
  })

  it('旧库启动时自动补 reasoning_effort 列（存量表不会被建表语句改动）', () => {
    // 造一个「没有新列」的旧库，模拟升级前的 data/usage.db。
    const legacy = new DatabaseSync(join(dir, 'usage.db'))
    legacy.exec(`
      CREATE TABLE usage_records (
        request_id TEXT NOT NULL PRIMARY KEY, at TEXT NOT NULL, at_ms INTEGER NOT NULL,
        key_id TEXT NOT NULL, key_name TEXT NOT NULL, provider TEXT NOT NULL, model TEXT NOT NULL,
        upstream_model TEXT NOT NULL, account_id TEXT NOT NULL, prompt_tokens INTEGER NOT NULL,
        completion_tokens INTEGER NOT NULL, cache_read_tokens INTEGER NOT NULL,
        cache_write_tokens INTEGER NOT NULL, stream INTEGER NOT NULL, duration_ms INTEGER NOT NULL,
        first_byte_ms INTEGER, finish_reason TEXT NOT NULL, status INTEGER NOT NULL,
        error_code TEXT NOT NULL
      )
    `)
    legacy.prepare(`INSERT INTO usage_records VALUES ('old-1',?,?, 'k','n','p','p/m','m','acc',1,2,0,0,0,10,5,'stop',200,'')`)
      .run(new Date(NOW_MS).toISOString(), NOW_MS)
    legacy.close()

    // 打开即迁移：不加列的话下面这条写入会抛错（被 record() 吞成告警）。
    const store = new UsageStore(dir)
    expect(store.record(usageRecord({ requestId: 'new-1', reasoningEffort: 'high' }))).toBe(true)
    // 旧记录档位未知 → 空串，而不是被猜成某个值。
    expect(store.query().records.find(r => r.requestId === 'old-1')?.reasoningEffort).toBe('')
    expect(store.query().records.find(r => r.requestId === 'new-1')?.reasoningEffort).toBe('high')
    store.close()
  })

  it('8.5 表结构里没有任何正文列（从结构上保证不记正文）', () => {
    const store = new UsageStore(dir)
    store.record(usageRecord({ requestId: 'req-cols' }))
    store.close()
    const db = new DatabaseSync(join(dir, 'usage.db'))
    const columns = (db.prepare('PRAGMA table_info(usage_records)').all() as Array<{ name: string }>).map(c => c.name)
    db.close()
    for (const forbidden of ['content', 'messages', 'prompt_text', 'output_text', 'body']) {
      expect(columns).not.toContain(forbidden)
    }
    // 全列清单写死：后来者新增列必须显式更新本断言，防止顺手把正文塞进表。
    expect([...columns].sort()).toEqual([
      'account_id', 'at', 'at_ms', 'cache_read_tokens', 'cache_write_tokens',
      'completion_tokens', 'duration_ms', 'error_code', 'finish_reason', 'first_byte_ms',
      'key_id', 'key_name', 'model', 'prompt_tokens', 'provider', 'reasoning_effort',
      'request_id', 'status', 'stream', 'upstream_model',
    ].sort())
  })

  it('8.5 端到端：用户消息正文与模型输出都不出现在任何用量记录里', async () => {
    const h = await startUsageGateway(dir, 'ok')
    try {
      const key = h.keys.create({ name: '正文检索' })
      const SECRET = 'TOPSECRET-USER-SENTENCE-请勿落盘'
      const res = await post(`${h.url}/v1/chat/completions`, {
        model: 'fake/model-a',
        messages: [{ role: 'user', content: SECRET }],
      }, { Authorization: `Bearer ${key.plaintext}` })
      expect(res.status).toBe(200)
      const body = await res.json() as { choices?: Array<{ message?: { content?: string } }> }
      await waitFor(() => h.usage.query().records.length > 0)
      // 对落盘记录做全文检索：正文（用户输入与模型输出）一个都不能在。
      const dumped = JSON.stringify(h.usage.exportAll())
      expect(dumped).not.toContain(SECRET)
      expect(dumped).not.toContain(body.choices?.[0]?.message?.content ?? '')
      // onRequest 收到的内存记录同样不含正文。
      expect(JSON.stringify(h.requests)).not.toContain(SECRET)
    } finally {
      await stopGateway(h)
    }
  })

  it('8.6 写入失败返回 false 且不抛（关闭后再写不炸）', () => {
    const store = new UsageStore(dir)
    store.close()
    expect(store.record(usageRecord({ requestId: 'req-closed' }))).toBe(false)
  })

  it('8.6 recorder 在 store 抛错时不抛（热路径兜底）', () => {
    const badStore = {
      record: () => { throw new Error('boom') },
    } as unknown as UsageStore
    const recorder = createUsageRecorder({ store: badStore, now: () => NOW_MS })
    expect(() => recorder(requestRecord())).not.toThrow()
  })

  it('8.6 用量钩子抛错时客户端仍收到正常响应', async () => {
    const h = await startUsageGateway(dir, 'ok', { throwOnRecord: true })
    try {
      const key = h.keys.create({ name: '钩子炸了' })
      const res = await post(`${h.url}/v1/chat/completions`, {
        model: 'fake/model-a', messages: [{ role: 'user', content: 'hi' }],
      }, { Authorization: `Bearer ${key.plaintext}` })
      // 记录路径炸了也绝不能连累用户 —— 响应必须仍是 200。
      expect(res.status).toBe(200)
      const body = await res.json() as { choices?: unknown[] }
      expect(body.choices).toHaveLength(1)
    } finally {
      await stopGateway(h)
    }
  })

  it('8.7 按期限清理最旧记录', () => {
    const store = new UsageStore(dir)
    const old = new Date(NOW_MS - 100 * 24 * 60 * 60 * 1000).toISOString()
    store.record(usageRecord({ requestId: 'req-old', at: old }))
    store.record(usageRecord({ requestId: 'req-new', at: new Date(NOW_MS).toISOString() }))
    const removed = store.applyRetention({ days: 90 }, NOW_MS)
    expect(removed).toBe(1)
    const ids = store.query().records.map(r => r.requestId)
    expect(ids).toEqual(['req-new'])
    store.close()
  })

  it('8.7 按总量清理：超出上限时删的是最旧的，最新记录保留', () => {
    const store = new UsageStore(dir)
    for (let i = 0; i < 5; i++) {
      store.record(usageRecord({
        requestId: `req-${i}`,
        at: new Date(NOW_MS + i * 1000).toISOString(),
      }))
    }
    const removed = store.applyRetention({ maxRecords: 3 }, NOW_MS)
    expect(removed).toBe(2)
    const ids = store.query().records.map(r => r.requestId)
    expect(ids).toHaveLength(3)
    expect(ids).toContain('req-4') // 最新
    expect(ids).not.toContain('req-0') // 最旧
    expect(ids).not.toContain('req-1')
    store.close()
  })

  it('8.7 默认保留策略有定义（90 天 / 20 万条）', () => {
    expect(DEFAULT_RETENTION.days).toBe(90)
    expect(DEFAULT_RETENTION.maxRecords).toBe(200_000)
  })
})

describe('用量查询 API（8.8）', () => {
  let dir: string
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'all-proxy-usage-api-')) })
  afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

  it('查询返回记录与汇总（总数、成功、失败、token 合计、平均首字节）', async () => {
    const h = await startUsageGateway(dir, 'ok')
    try {
      const key = h.keys.create({ name: '查询测试' })
      // 一条成功（真实请求）+ 一条失败（直接写入）。
      await post(`${h.url}/v1/chat/completions`, { model: 'fake/model-a', messages: [{ role: 'user', content: 'hi' }] },
        { Authorization: `Bearer ${key.plaintext}` })
      await waitFor(() => h.usage.query().records.length > 0)
      h.usage.record(usageRecord({ requestId: 'req-fail', status: 502, errorCode: 'bad_gateway', promptTokens: 0, completionTokens: 0 }))

      const res = await fetch(`${h.url}/api/usage`, { headers: adminHeaders(h.adminSecret) })
      expect(res.status).toBe(200)
      const payload = await res.json() as {
        records: UsageRecord[]
        summary: { total: number; success: number; failure: number; promptTokens: number; completionTokens: number; avgFirstByteMs: number | null }
        limit: number
        offset: number
      }
      expect(payload.summary.total).toBe(2)
      expect(payload.summary.success).toBe(1)
      expect(payload.summary.failure).toBe(1)
      expect(payload.summary.promptTokens).toBeGreaterThanOrEqual(0)
      expect(payload.summary.avgFirstByteMs).not.toBeNull()
    } finally {
      await stopGateway(h)
    }
  })

  it('按维度筛选（provider / model / keyId / outcome）与时间范围', async () => {
    const h = await startUsageGateway(dir, 'ok')
    try {
      h.usage.record(usageRecord({ requestId: 'r-a', provider: 'fake', model: 'fake/model-a' }))
      h.usage.record(usageRecord({ requestId: 'r-b', provider: 'other', model: 'other/model-b' }))
      h.usage.record(usageRecord({ requestId: 'r-c', provider: 'fake', status: 500, errorCode: 'boom' }))

      const byProvider = await getJson(`${h.url}/api/usage?provider=fake`, h.adminSecret)
      expect(byProvider.summary.total).toBe(2)
      expect(byProvider.records.every((r: UsageRecord) => r.provider === 'fake')).toBe(true)

      const byModel = await getJson(`${h.url}/api/usage?model=other/model-b`, h.adminSecret)
      expect(byModel.summary.total).toBe(1)

      const failures = await getJson(`${h.url}/api/usage?outcome=failure`, h.adminSecret)
      expect(failures.summary.total).toBe(1)
      expect(failures.records[0]!.requestId).toBe('r-c')

      const timeRanged = await getJson(
        `${h.url}/api/usage?from=${encodeURIComponent(new Date(NOW_MS - 1000).toISOString())}&to=${encodeURIComponent(new Date(NOW_MS + 1000).toISOString())}`,
        h.adminSecret,
      )
      expect(timeRanged.summary.total).toBe(3)
    } finally {
      await stopGateway(h)
    }
  })

  it('分页：limit/offset 生效，不一次性返回全部历史', async () => {
    const h = await startUsageGateway(dir, 'ok')
    try {
      for (let i = 0; i < 7; i++) {
        h.usage.record(usageRecord({ requestId: `p-${i}`, at: new Date(NOW_MS + i * 1000).toISOString() }))
      }
      const page1 = await getJson(`${h.url}/api/usage?limit=3&offset=0`, h.adminSecret)
      expect(page1.records).toHaveLength(3)
      expect(page1.matched).toBe(7)
      // 倒序：第一页是最新的三条。
      expect(page1.records.map((r: UsageRecord) => r.requestId)).toEqual(['p-6', 'p-5', 'p-4'])
      const page3 = await getJson(`${h.url}/api/usage?limit=3&offset=6`, h.adminSecret)
      expect(page3.records).toHaveLength(1)
    } finally {
      await stopGateway(h)
    }
  })

  it('按 key 汇总消耗（判断额度分配的依据）', async () => {
    const h = await startUsageGateway(dir, 'ok')
    try {
      h.usage.record(usageRecord({ requestId: 'k-1', keyId: 'key-1', keyName: '甲', promptTokens: 100, completionTokens: 10 }))
      h.usage.record(usageRecord({ requestId: 'k-2', keyId: 'key-1', keyName: '甲', promptTokens: 50, completionTokens: 5 }))
      h.usage.record(usageRecord({ requestId: 'k-3', keyId: 'key-2', keyName: '乙', promptTokens: 7, completionTokens: 1 }))
      const res = await fetch(`${h.url}/api/usage/keys`, { headers: adminHeaders(h.adminSecret) })
      expect(res.status).toBe(200)
      const payload = await res.json() as { data: Array<{ keyId: string; requests: number; promptTokens: number; completionTokens: number }> }
      const jia = payload.data.find(k => k.keyId === 'key-1')!
      expect(jia.requests).toBe(2)
      expect(jia.promptTokens).toBe(150)
      expect(jia.completionTokens).toBe(15)
      expect(payload.data.find(k => k.keyId === 'key-2')!.requests).toBe(1)
    } finally {
      await stopGateway(h)
    }
  })

  it('用量存储未启用时返回 503（而不是静默空列表）', async () => {
    const h = await startUsageGateway(dir, 'ok', { withoutUsage: true })
    try {
      const res = await fetch(`${h.url}/api/usage`, { headers: adminHeaders(h.adminSecret) })
      expect(res.status).toBe(503)
    } finally {
      await stopGateway(h)
    }
  })

  it('管理口令错误 → 401（用量数据不出给普通调用方）', async () => {
    const h = await startUsageGateway(dir, 'ok')
    try {
      const res = await fetch(`${h.url}/api/usage`, { headers: { Authorization: 'Bearer wrong-secret' } })
      expect(res.status).toBe(401)
    } finally {
      await stopGateway(h)
    }
  })
})

// ───────────────────────── 测试装置 ─────────────────────────

class FakeAdapter extends LlmAdapter {
  constructor(private readonly behavior: 'ok' | 'boom') { super() }
  override async listModels(): Promise<readonly { provider: string; id: string; name: string }[]> {
    return [{ provider: 'fake', id: 'model-a', name: 'Model A' }]
  }
  override async resolveModel(provider: string, model: string): Promise<{ provider: string; id: string; name: string; context?: { contextWindow: number } }> {
    return { provider, id: model, name: model, context: { contextWindow: 1000 } }
  }
  async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    if (this.behavior === 'boom') throw new LlmError('上游炸了', 'SERVER', { status: 502 })
    yield { type: 'text-delta', index: 0, text: 'hi' }
    yield { type: 'usage', usage: { inputTokens: 100, outputTokens: 21, cacheReadTokens: 20, cacheWriteTokens: 30 } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

interface UsageHarness {
  url: string
  server: Server
  dir: string
  keys: ApiKeyStore
  usage: UsageStore
  adminSecret: string
  requests: RequestRecord[]
}

interface UsageHarnessOptions {
  /** onRequest 钩子抛错（验证网关兜底）。 */
  throwOnRecord?: boolean
  /** 不给 admin handler 挂 usage（验证 503）。 */
  withoutUsage?: boolean
}

/** 起一个带用量链路的网关（API Key 鉴权 + 管理 API + 用量落盘）。 */
async function startUsageGateway(dir: string, behavior: 'ok' | 'boom', options: UsageHarnessOptions = {}): Promise<UsageHarness> {
  const credentials = new FileCredentialStore(dir)
  const pool = new AccountPool({ credentials, dataDir: dir })
  const registry = new ProviderRegistry()
  registry.register({
    id: 'fake',
    displayName: 'fake provider',
    apiBase: 'https://example.invalid',
    chatPath: '/v1/chat/completions',
    authKind: 'bearer',
    catalogSource: 'remote-first',
    supportsImages: true,
    rotatesAccounts: false,
  }, new FakeAdapter(behavior))

  const keys = new ApiKeyStore(dir)
  const usage = new UsageStore(dir)
  const recorder = createUsageRecorder({ store: usage, apiKeys: keys, now: () => Date.now() })
  const admin = new AdminAuth(dir)
  const savedSecret = process.env['ALL_PROXY_ADMIN_SECRET']
  delete process.env['ALL_PROXY_ADMIN_SECRET']
  let adminSecret = ''
  try {
    adminSecret = admin.ensure() ?? ''
  } finally {
    if (savedSecret !== undefined) process.env['ALL_PROXY_ADMIN_SECRET'] = savedSecret
  }
  if (adminSecret.length === 0) throw new Error('测试装置未能取得管理口令')

  const requests: RequestRecord[] = []
  const server = createGatewayServer({
    registry,
    pool,
    port: 0,
    host: '127.0.0.1',
    authenticate: createApiKeyAuthenticator(keys),
    admin: createAdminHandler({
      registry,
      pool,
      credentials,
      apiKeys: keys,
      auth: admin,
      logger: { info: () => {}, warn: () => {}, error: () => {} },
      ...(options.withoutUsage === true ? {} : { usage }),
    }),
    onRequest: (record) => {
      if (options.throwOnRecord === true) throw new Error('记录钩子炸了')
      requests.push(record)
      recorder(record)
    },
  })
  await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve) })
  const address = server.address() as AddressInfo
  return { url: `http://127.0.0.1:${address.port}`, server, dir, keys, usage, adminSecret, requests }
}

async function stopGateway(h: UsageHarness): Promise<void> {
  h.usage.close()
  await new Promise<void>((resolve) => { h.server.close(() => resolve()) })
  rmSync(h.dir, { recursive: true, force: true })
}

async function post(url: string, body: unknown, headers: Record<string, string> = {}): Promise<Response> {
  return fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  })
}

function adminHeaders(secret: string): Record<string, string> {
  return { Authorization: `Bearer ${secret}` }
}

async function getJson(url: string, secret: string): Promise<Record<string, unknown> & { records: UsageRecord[]; summary: Record<string, unknown> }> {
  const res = await fetch(url, { headers: adminHeaders(secret) })
  expect(res.status).toBe(200)
  return await res.json() as never
}

/** 轮询等待异步落盘完成（recorder 在响应之后同步执行，但 fetch 返回时序上可能晚一拍）。 */
async function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  throw new Error('waitFor 超时')
}
