import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
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
import { UsageStore } from '../../src/usage/store.js'
import { createUsageRecorder } from '../../src/usage/recorder.js'
import { RotatingLogger, REDACTED, isSensitiveKey, redact, redactString, type LogEntry } from '../../src/usage/logger.js'

/**
 * 运行日志（tasks 8.9–8.12）。
 *
 * 核心保证：
 * - 请求标识贯穿 —— 日志与用量记录共享 requestId，能互相定位；
 * - 阶段可区分 —— 「未连接上游 / 已连接无首字节 / 传输中断 / 完成」四种
 *   结局的排查方向完全不同，日志里必须一眼看出是哪种；
 * - 脱敏靠代码而不是靠纪律 —— 写入路径统一过 redact。
 */

// ───────────────────────── 8.10 轮转 ─────────────────────────

describe('日志轮转', () => {
  let dir: string
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'all-proxy-log-')) })
  afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

  it('8.10 达到大小上限后轮转出备份', () => {
    const path = join(dir, 'app.log')
    const logger = new RotatingLogger({ path, maxBytes: 300, maxBackups: 3 })
    for (let i = 0; i < 20; i++) {
      logger.info('completed', `填充日志第 ${i} 条，把内容撑到足够长以触发轮转逻辑。`)
    }
    expect(existsSync(path)).toBe(true)
    expect(existsSync(`${path}.1`)).toBe(true)
    // 当前文件永远不超过上限（刚写入的一条除外）。
    expect(statSync(path).size).toBeLessThanOrEqual(300 + 200)
  })

  it('8.10 备份数量受限（不会无限堆积占满磁盘）', () => {
    const path = join(dir, 'app.log')
    const logger = new RotatingLogger({ path, maxBytes: 200, maxBackups: 2 })
    for (let i = 0; i < 50; i++) {
      logger.info('completed', `第 ${i} 条，足够长以触发多次轮转，保证备份序号被反复后移。`)
    }
    expect(existsSync(`${path}.1`)).toBe(true)
    expect(existsSync(`${path}.2`)).toBe(true)
    expect(existsSync(`${path}.3`)).toBe(false) // maxBackups=2 → 不存在第三个备份
  })

  it('8.10 轮转后最新内容在主文件里（不丢最近的日志）', () => {
    const path = join(dir, 'app.log')
    const logger = new RotatingLogger({ path, maxBytes: 250, maxBackups: 2 })
    logger.info('completed', '早期的一条')
    for (let i = 0; i < 20; i++) {
      logger.info('completed', `填充 ${i}，内容足够长，反复触发轮转。`)
    }
    const latest = readFileSync(path, 'utf-8').trim().split('\n')
    expect(latest.length).toBeGreaterThan(0)
    const parsed = JSON.parse(latest[latest.length - 1]!) as LogEntry
    expect(parsed.message).toContain('填充 19')
  })
})

// ───────────────────────── 8.12 脱敏 ─────────────────────────

describe('敏感信息脱敏', () => {
  it('8.12 敏感键名的值整体替换（不保留长度）', () => {
    const out = redact({ refresh_token: 'very-secret-value', note: 'ok' }) as Record<string, unknown>
    expect(out['refresh_token']).toBe(REDACTED)
    expect(out['note']).toBe('ok')
  })

  it('8.12 键名匹配覆盖常见写法（子串匹配）', () => {
    for (const key of ['access_token', 'refreshToken', 'Authorization', 'x-api-key', 'apiKey', 'client_secret', 'session_id']) {
      expect(isSensitiveKey(key)).toBe(true)
    }
    expect(isSensitiveKey('model')).toBe(false)
    expect(isSensitiveKey('provider')).toBe(false)
  })

  it('8.12 值形态匹配：API Key 明文出现在任意字段里都会被替换', () => {
    const plaintext = 'sk-all-AbCdEfGh1234567890'
    // 键名完全无害（note），值形态兜底。
    const out = redact({ note: `调用用的 key 是 ${plaintext}，别外传` }) as Record<string, unknown>
    expect(out['note']).not.toContain(plaintext)
    expect(out['note']).toContain(REDACTED)
  })

  it('8.12 Error 只取 message，不取 stack（stack 可能带 URL 与查询参数）', () => {
    const error = new Error('请求失败')
    const out = redact({ error })
    expect(JSON.stringify(out)).not.toContain('at ')
    expect(JSON.stringify(out)).toContain('请求失败')
  })

  it('8.12 递归脱敏嵌套结构', () => {
    const out = redact({ a: { b: { api_key: 'xyz' } }, list: [{ token: 't' }] }) as Record<string, unknown>
    const a = out['a'] as Record<string, unknown>
    const b = a['b'] as Record<string, unknown>
    expect(b['api_key']).toBe(REDACTED)
    expect((out['list'] as Array<Record<string, unknown>>)[0]!['token']).toBe(REDACTED)
  })

  it('8.12 端到端：日志文件与错误响应中均无 API Key 明文', async () => {
    const h = await startLoggedGateway()
    try {
      const key = h.keys.create({ name: '脱敏测试' })
      // 一个会失败的请求（模型不存在 → 404）。
      const res = await post(`${h.url}/v1/chat/completions`, { model: 'ghost/nope', messages: [] },
        { Authorization: `Bearer ${key.plaintext}` })
      expect(res.status).toBe(404)
      const bodyText = await res.text()
      expect(bodyText).not.toContain(key.plaintext)
      // 日志文件全文检索：明文一个都不能出现。
      const logText = readFileSync(h.logPath, 'utf-8')
      expect(logText).not.toContain(key.plaintext)
      // 用量记录同样不含（它只有 keyId，本就没有明文的位置）。
      expect(JSON.stringify(h.usage.exportAll())).not.toContain(key.plaintext)
    } finally {
      await stopGateway(h)
    }
  })
})

// ───────────────────────── 8.9 / 8.11 阶段与请求标识 ─────────────────────────

describe('请求日志阶段与请求标识', () => {
  let h: Awaited<ReturnType<typeof startLoggedGateway>>
  beforeEach(async () => { h = await startLoggedGateway() })
  afterEach(async () => { await stopGateway(h) })

  /** 读出日志文件里的全部结构化条目。 */
  function logEntries(): LogEntry[] {
    return readFileSync(h.logPath, 'utf-8').trim().split('\n').filter(l => l.length > 0)
      .map(line => JSON.parse(line) as LogEntry)
  }

  it('8.11 成功请求标记为 completed', async () => {
    const key = h.keys.create({ name: '阶段测试' })
    const res = await post(`${h.url}/v1/chat/completions`, { model: 'fake/model-a', messages: [{ role: 'user', content: 'hi' }] },
      { Authorization: `Bearer ${key.plaintext}` })
    expect(res.status).toBe(200)
    const entries = logEntries()
    expect(entries.some(e => e.stage === 'received')).toBe(true)
    expect(entries.some(e => e.stage === 'completed')).toBe(true)
  })

  it('8.11 硬拦截（模型不可用）标记为 rejected —— 请求未连接上游', async () => {
    const key = h.keys.create({ name: '阶段测试' })
    const res = await post(`${h.url}/v1/chat/completions`, { model: 'ghost/nope', messages: [] },
      { Authorization: `Bearer ${key.plaintext}` })
    expect(res.status).toBe(404)
    const entry = logEntries().find(e => e.stage === 'rejected')
    expect(entry).toBeDefined()
    expect(entry?.message).toContain('model_not_found')
  })

  it('8.11 请求体无效也是 rejected', async () => {
    const key = h.keys.create({ name: '阶段测试' })
    const res = await fetch(`${h.url}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key.plaintext}` },
      body: '这不是 JSON',
    })
    expect(res.status).toBe(400)
    expect(logEntries().some(e => e.stage === 'rejected')).toBe(true)
  })

  it('8.11 已连接但无首字节（上游立即失败）标记为 upstream-connected', async () => {
    h.setAdapterBehavior({ throwBeforeFirstByte: true })
    const key = h.keys.create({ name: '阶段测试' })
    const res = await post(`${h.url}/v1/chat/completions`, { model: 'fake/model-a', messages: [{ role: 'user', content: 'hi' }] },
      { Authorization: `Bearer ${key.plaintext}` })
    expect(res.status).toBe(502)
    const entry = logEntries().find(e => e.stage === 'upstream-connected')
    expect(entry).toBeDefined()
  })

  it('8.11 有首字节后中断标记为 transfer-aborted', async () => {
    h.setAdapterBehavior({ throwAfterFirstByte: true })
    const key = h.keys.create({ name: '阶段测试' })
    const res = await post(`${h.url}/v1/chat/completions`, { model: 'fake/model-a', messages: [{ role: 'user', content: 'hi' }] },
      { Authorization: `Bearer ${key.plaintext}` })
    expect(res.status).toBe(502)
    const entry = logEntries().find(e => e.stage === 'transfer-aborted')
    expect(entry).toBeDefined()
  })

  it('8.11 流式中断同样能区分两个失败阶段', async () => {
    const key = h.keys.create({ name: '阶段测试' })
    // 流式 + 无首字节。
    h.setAdapterBehavior({ throwBeforeFirstByte: true })
    const res1 = await post(`${h.url}/v1/chat/completions`, { model: 'fake/model-a', messages: [{ role: 'user', content: 'hi' }], stream: true },
      { Authorization: `Bearer ${key.plaintext}` })
    expect(res1.status).toBe(200) // SSE 已发头
    const sse1 = await res1.text()
    expect(sse1).toContain('upstream_error') // 错误作为 SSE 帧下发

    // 流式 + 有首字节后中断。
    h.setAdapterBehavior({ throwAfterFirstByte: true })
    const res2 = await post(`${h.url}/v1/chat/completions`, { model: 'fake/model-a', messages: [{ role: 'user', content: 'hi' }], stream: true },
      { Authorization: `Bearer ${key.plaintext}` })
    const sse2 = await res2.text()
    expect(sse2).toContain('partial') // 首字节内容已到达

    const stages = logEntries().filter(e => e.stage === 'upstream-connected' || e.stage === 'transfer-aborted').map(e => e.stage)
    expect(stages).toContain('upstream-connected')
    expect(stages).toContain('transfer-aborted')
  })

  it('8.9 同一次请求的运行日志与用量记录共享同一 requestId', async () => {
    const key = h.keys.create({ name: '贯穿测试' })
    const res = await post(`${h.url}/v1/chat/completions`, { model: 'fake/model-a', messages: [{ role: 'user', content: 'hi' }] },
      { Authorization: `Bearer ${key.plaintext}` })
    expect(res.status).toBe(200)
    await waitFor(() => h.usage.query().records.length > 0)
    const usageId = h.usage.query().records[0]!.requestId
    expect(usageId.length).toBeGreaterThan(0)
    // 日志里同一标识出现在多条阶段日志上。
    const entries = logEntries().filter(e => e.requestId === usageId)
    expect(entries.length).toBeGreaterThanOrEqual(2) // received + completed
    expect(entries.map(e => e.stage)).toContain('received')
    expect(entries.map(e => e.stage)).toContain('completed')
  })

  it('8.9 失败请求同样贯穿（用量失败记录与 rejected 日志同标识）', async () => {
    const key = h.keys.create({ name: '贯穿测试' })
    await post(`${h.url}/v1/chat/completions`, { model: 'ghost/nope', messages: [] },
      { Authorization: `Bearer ${key.plaintext}` })
    await waitFor(() => h.usage.query({ outcome: 'failure' }).records.length > 0)
    const usageId = h.usage.query({ outcome: 'failure' }).records[0]!.requestId
    const entry = logEntries().find(e => e.requestId === usageId && e.stage === 'rejected')
    expect(entry).toBeDefined()
  })
})

// ───────────────────────── 测试装置 ─────────────────────────

interface AdapterBehavior {
  /** 在产出任何内容之前抛错（无首字节）。 */
  throwBeforeFirstByte?: boolean
  /** 先产出一个 delta 再抛错（有首字节）。 */
  throwAfterFirstByte?: boolean
}

class ScriptedAdapter extends LlmAdapter {
  behavior: AdapterBehavior = {}
  override async listModels(): Promise<readonly { provider: string; id: string; name: string }[]> {
    return [{ provider: 'fake', id: 'model-a', name: 'Model A' }]
  }
  override async resolveModel(provider: string, model: string): Promise<{ provider: string; id: string; name: string; context?: { contextWindow: number } }> {
    return { provider, id: model, name: model, context: { contextWindow: 1000 } }
  }
  async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    if (this.behavior.throwBeforeFirstByte === true) {
      throw new LlmError('上游连接后立即失败', 'SERVER', { status: 502 })
    }
    yield { type: 'text-delta', index: 0, text: 'partial' }
    if (this.behavior.throwAfterFirstByte === true) {
      throw new LlmError('传输途中断了', 'SERVER', { status: 502 })
    }
    yield { type: 'usage', usage: { inputTokens: 3, outputTokens: 4 } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

interface LoggedHarness {
  url: string
  server: Server
  dir: string
  keys: ApiKeyStore
  usage: UsageStore
  adminSecret: string
  logPath: string
  requests: RequestRecord[]
  setAdapterBehavior(behavior: AdapterBehavior): void
}

/** 起一个带运行日志 + 用量链路的网关。 */
async function startLoggedGateway(): Promise<LoggedHarness> {
  const dir = mkdtempSync(join(tmpdir(), 'all-proxy-loggw-'))
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
  const usage = new UsageStore(dir)
  const recorder = createUsageRecorder({ store: usage })
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

  const logPath = join(dir, 'logs', 'app.log')
  const requestLog = new RotatingLogger({ path: logPath })
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
      usage,
    }),
    onRequest: (record) => { requests.push(record); recorder(record) },
    requestLog,
  })
  await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve) })
  const address = server.address() as AddressInfo
  return {
    url: `http://127.0.0.1:${address.port}`,
    server,
    dir,
    keys,
    usage,
    adminSecret,
    logPath,
    requests,
    setAdapterBehavior(behavior: AdapterBehavior) { adapter.behavior = behavior },
  }
}

async function stopGateway(h: LoggedHarness): Promise<void> {
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

async function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  throw new Error('waitFor 超时')
}
