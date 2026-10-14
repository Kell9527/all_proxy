import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { AccountPool } from '../../src/pool/account-pool.js'
import { FileCredentialStore } from '../../src/pool/store.js'
import { ProviderRegistry } from '../../src/providers/registry.js'
import { createGatewayServer } from '../../src/gateway/server.js'
import { createAdminHandler } from '../../src/admin/router.js'
import { AdminAuth } from '../../src/admin/auth.js'
import { ApiKeyStore } from '../../src/auth/api-keys.js'
import { LlmAdapter } from '../../src/shared/llm.js'
import type { GenerateOptions, StreamChunk } from '../../src/shared/llm.js'

/**
 * 供应商总开关的 **API 层**回归测试。
 *
 * 覆盖的是此前的测试缺口：`PATCH /api/models` 的 `{ provider, enabled }` 分支
 * （provider 开关写入口）与 `GET /api/providers`（开关弹窗的状态源）从来
 * 没有直接测过——pool 层三层判定有测、gateway 404 有测，偏偏「管理端怎么把
 * 开关拨过去」这条链是空的。
 *
 * 语义基准（AGENTS.md 分叉点表）：provider 开关是 `disabledProviders` 里的
 * **独立键**，关闭即硬拦截（与来源的「目录过滤」不同）。
 */

/** 最小可用替身适配器（两个模型，供列表断言）。 */
class FakeAdapter extends LlmAdapter {
  override async listModels(): Promise<readonly { provider: string; id: string; name: string }[]> {
    return [
      { provider: 'fake', id: 'model-a', name: 'Model A' },
      { provider: 'fake', id: 'model-b', name: 'Model B' },
    ]
  }

  override async resolveModel(provider: string, model: string): Promise<{ provider: string; id: string; name: string; context?: { contextWindow: number } }> {
    return { provider, id: model, name: model, context: { contextWindow: 1000 } }
  }

  async *stream(_options: GenerateOptions): AsyncIterable<StreamChunk> {
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

/** 本次启动实际生效的管理口令（env 值或 ensure 生成值；见 beforeEach）。 */
const adminSecretHolder = { secret: '' }

describe('供应商开关 API（PATCH /api/models {provider, enabled}）', () => {
  let dir: string
  let server: Server
  let url: string
  let pool: AccountPool

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'all-proxy-provider-switch-'))
    const credentials = new FileCredentialStore(dir)
    pool = new AccountPool({ credentials, dataDir: dir })
    const registry = new ProviderRegistry()
    registry.register({
      id: 'fake',
      displayName: 'Fake Provider',
      apiBase: 'https://example.invalid',
      chatPath: '/v1/chat/completions',
      authKind: 'bearer',
      catalogSource: 'remote-first',
      supportsImages: true,
      rotatesAccounts: false,
    }, new FakeAdapter())
    // ⚠️ **只读** ALL_PROXY_ADMIN_SECRET，绝不写它：环境变量是进程级全局
    // 状态，vitest 多文件并行运行时写入会泄漏给无关用例（实测 anthropic /
    // gateway / provider-wiring 三个文件因此变红）。ensure 的优先级是
    // 「env → 已有文件 → 自动生成」，故口令取值分两种：
    //   env 有值 ⇒ 用它（ensure 会把它落盘）；
    //   env 无值 ⇒ 用 ensure 自动生成的明文（其返回值）。
    const auth = new AdminAuth(dir, { info: () => {}, warn: () => {}, error: () => {} })
    const generated = auth.ensure(undefined, { minSecretLength: 4 })
    const secret = process.env['ALL_PROXY_ADMIN_SECRET']?.trim() || generated || ''
    server = createGatewayServer({
      registry,
      pool,
      port: 0,
      host: '127.0.0.1',
      admin: createAdminHandler({
        registry,
        pool,
        credentials,
        apiKeys: new ApiKeyStore(dir),
        auth,
        logger: { info: () => {}, warn: () => {}, error: () => {} },
      }),
    })
    await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve) })
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
    // 供 adminFetch 使用（挂到实例上，避免用例间共享）。
    adminSecretHolder.secret = secret
  })

  afterEach(async () => {
    await new Promise<void>((resolve) => { server.close(() => resolve()) })
    rmSync(dir, { recursive: true, force: true })
    adminSecretHolder.secret = ''
  })

  const adminFetch = (path: string, init: RequestInit = {}): Promise<Response> =>
    fetch(`${url}${path}`, {
      ...init,
      headers: { 'x-admin-secret': adminSecretHolder.secret, 'Content-Type': 'application/json', ...(init.headers ?? {}) },
    })

  it('GET /api/providers 带 enabled 与账号数（开关弹窗的状态源）', async () => {
    const res = await adminFetch('/api/providers')
    expect(res.status).toBe(200)
    const body = await res.json() as { data: Array<Record<string, unknown>> }
    const fake = body.data.find(p => p['id'] === 'fake')!
    expect(fake['enabled']).toBe(true)
    expect(fake['accountCount']).toBe(0)
    expect(fake['enabledAccountCount']).toBe(0)
  })

  it('关闭后 GET /api/providers 反映 enabled:false，再打开恢复', async () => {
    const off = await adminFetch('/api/models', {
      method: 'PATCH',
      body: JSON.stringify({ provider: 'fake', enabled: false }),
    })
    expect(off.status).toBe(200)

    let body = await (await adminFetch('/api/providers')).json() as { data: Array<Record<string, unknown>> }
    expect(body.data.find(p => p['id'] === 'fake')!['enabled']).toBe(false)

    const on = await adminFetch('/api/models', {
      method: 'PATCH',
      body: JSON.stringify({ provider: 'fake', enabled: true }),
    })
    expect(on.status).toBe(200)
    body = await (await adminFetch('/api/providers')).json() as { data: Array<Record<string, unknown>> }
    expect(body.data.find(p => p['id'] === 'fake')!['enabled']).toBe(true)
  })

  it('未知 provider 拒绝（拼错的 id 不该变成永不生效的死键）', async () => {
    const res = await adminFetch('/api/models', {
      method: 'PATCH',
      body: JSON.stringify({ provider: 'fke', enabled: false }),
    })
    expect(res.status).toBe(400)
    const body = await res.json() as { error: { message: string } }
    expect(body.error.message).toContain('未知的 provider')
    // 拒绝即不落盘：池里没有任何 provider 被关
    expect(pool.providerEnabled('fake')).toBe(true)
  })

  it('enabled 非布尔时不落到 provider 分支（缺失 ⇒ 缺少 modelId 的可读错误）', async () => {
    const res = await adminFetch('/api/models', {
      method: 'PATCH',
      body: JSON.stringify({ provider: 'fake' }),
    })
    expect(res.status).toBe(400)
    expect(pool.providerEnabled('fake')).toBe(true)
  })

  it('关闭后该 provider 的模型从 GET /v1/models 消失（硬拦截语义）', async () => {
    await adminFetch('/api/models', {
      method: 'PATCH',
      body: JSON.stringify({ provider: 'fake', enabled: false }),
    })
    const res = await fetch(`${url}/v1/models`)
    const body = await res.json() as { data: Array<{ id: string }> }
    expect(body.data.some(m => m.id.startsWith('fake/'))).toBe(false)
  })
})
