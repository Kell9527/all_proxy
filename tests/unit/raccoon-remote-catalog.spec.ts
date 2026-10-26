import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AccountPool } from '../../src/pool/account-pool.js'
import type { ProviderAccountEntry } from '../../src/pool/types.js'
import type { ProviderRegistry } from '../../src/providers/registry.js'
import type { registerAllProviders } from '../../src/providers/wiring.js'
import type { RaccoonAdapter } from '../../src/providers/raccoon-adapter.js'

/**
 * Raccoon 远端目录接线（用户报障「这个模型列表更新了，看看为什么没有跟进」）。
 *
 * 根因：`wiring.ts` 构造 `RaccoonAdapter` 时**没有**注入 `fetchRemoteModels`，
 * 适配器只能播报 `raccoon-product.ts` 里 2026-09-26 写死的 6 条兜底表；
 * 上游后来上架的 `sn-deepseek-v4-1-flash-1017` 等模型一律看不到
 * （与 CodeArts 漏接 `glm-5.3` 是同一类缺陷）。
 *
 * 本文件锁死三件事：
 * 1. 有账号时真的去拉远端目录，并把兜底表没有的模型播报出来；
 * 2. 请求头里的 `X-Org-Code` 对个人账号折叠成空串
 *    （原样发 `personal` 会拿到 `HTTP 400 code=200022 org_not_found_error`）；
 * 3. 无账号时**不抛错**，回退静态兜底表（规格 provider-routing）。
 *
 * ⚠️ `wiring.ts` 的目录缓存是**模块级单例**（内存 6 小时 TTL + 磁盘快照），
 * 同文件内第二个用例会直接吃缓存、一个字节网络都不发。故这里每个用例
 * `vi.resetModules()` 后动态 import 一份全新模块（与 `catalog-cache.spec.ts` 同法）。
 */
type WiringModule = typeof import('../../src/providers/wiring.js')
type PoolModule = typeof import('../../src/pool/account-pool.js')
type StoreModule = typeof import('../../src/pool/store.js')
type RegistryModule = typeof import('../../src/providers/registry.js')
type AdapterModule = typeof import('../../src/providers/raccoon-adapter.js')

/** 上游真实响应形状（2026-10-21 实测，只保留断言用到的字段）。 */
const REMOTE_MODEL = {
  name: 'sn-deepseek-v4-1-flash-1017',
  description: 'DeepSeek-V4.1-Flash-1017',
  visible: true,
  tags: ['general', 'code', 'reasoning'],
  params: { context_window: 1_000_000, max_tokens: 100_000 },
  billing_multiplier: 0.25,
  billing_effective_multiplier: 0,
  billing_status: 'limited_free',
  billing_status_note: '限免至10月31日',
}

describe('Raccoon 远端模型目录接线', () => {
  let dir: string
  let modules: {
    wiring: WiringModule
    poolM: PoolModule
    storeM: StoreModule
    registryM: RegistryModule
    adapterM: AdapterModule
  }
  /** 捕获到的 `X-Org-Code` 头（用来断言个人账号折叠成空串）。 */
  let seenOrgCodes: string[]

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'all-proxy-raccoon-catalog-'))
    seenOrgCodes = []
    vi.resetModules()
    modules = {
      wiring: await import('../../src/providers/wiring.js'),
      poolM: await import('../../src/pool/account-pool.js'),
      storeM: await import('../../src/pool/store.js'),
      registryM: await import('../../src/providers/registry.js'),
      adapterM: await import('../../src/providers/raccoon-adapter.js'),
    }
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    rmSync(dir, { recursive: true, force: true })
  })

  function makeFetcher(): typeof fetch {
    return (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      if (!url.endsWith('/api/web/llm/v2/model_catalog')) {
        return new Response('', { status: 404 })
      }
      const headers = (init?.headers ?? {}) as Record<string, string>
      seenOrgCodes.push(headers['X-Org-Code'] ?? '<absent>')
      return new Response(JSON.stringify({
        code: 0,
        data: {
          categories: [{
            type: 'chat',
            default_model: 'raccoon-8c4485',
            models: [
              // visible:false 的内部模型必须被过滤
              { name: 'raccoon-8c4485', description: 'Raccoon-Work', visible: false, tags: [], params: {} },
              REMOTE_MODEL,
            ],
          }],
        },
      }), { status: 200, headers: { 'Content-Type': 'application/json' } })
    }) as unknown as typeof fetch
  }

  function makeAccount(overrides: Partial<ProviderAccountEntry> = {}): ProviderAccountEntry {
    return {
      id: 'raccoon-001',
      provider: 'raccoon',
      nickname: 'raccoon-001',
      enabled: true,
      credentialRef: 'RACCOON_ACCOUNT_T1',
      createdAt: Date.now(),
      expiresAt: Date.now() + 3_600_000,
      refreshable: true,
      ...overrides,
    }
  }

  /** 装好一套 registry；`orgCode` 写进凭据的 `office_identity`。 */
  async function setUp(options: { orgCode?: string; withAccount?: boolean } = {}): Promise<ProviderRegistry> {
    const credentials = new modules.storeM.FileCredentialStore(dir)
    const pool: AccountPool = new modules.poolM.AccountPool({ credentials, dataDir: dir })
    if (options.withAccount !== false) {
      await credentials.set('RACCOON_ACCOUNT_T1', JSON.stringify({
        access_token: 'tok-test',
        refresh_token: 'rt-test',
        expires_at: new Date(Date.now() + 3_600_000).toISOString(),
        ...options.orgCode === undefined ? {} : { office_identity: options.orgCode },
      }))
      await pool.addAccount(makeAccount())
    }
    const registry = new modules.registryM.ProviderRegistry()
    modules.wiring.registerAllProviders(registry, {
      pool,
      credentials,
      dataDir: dir,
      logger: { info: () => {}, warn: () => {}, error: () => {} },
      fetcher: makeFetcher(),
      resolveCredential: async () => undefined,
      refresh: async () => {},
      readImage: async () => { throw new Error('本项目暂无附件服务') },
    })
    return registry
  }

  it('有账号时从远端拉目录，兜底表没有的模型也出现在列表里', async () => {
    const registry = await setUp()

    const models = await registry.get('raccoon')!.adapter.listModels('raccoon')
    const ids = models.map((m) => m.id)

    // 上游新增、兜底表里没有的模型 —— 只能靠远端目录拿到。
    expect(ids, '上游有 flash-1017，列表里就必须有').toContain('sn-deepseek-v4-1-flash-1017')
    // visible:false 的内部模型不能泄漏到对外目录。
    expect(ids).not.toContain('raccoon-8c4485')
    // 展示名带倍率（生效价 0 → 「免费」）。
    expect(models.find((m) => m.id === 'sn-deepseek-v4-1-flash-1017')?.name)
      .toBe('DeepSeek-V4.1-Flash-1017 · 免费')
  })

  it('远端目录真的被请求过（不是靠兜底表蒙对）', async () => {
    const registry = await setUp()
    await registry.get('raccoon')!.adapter.listModels('raccoon')
    expect(seenOrgCodes.length).toBeGreaterThan(0)
  })

  it('个人账号的 `office_identity: personal` 折叠成空串（否则 400 org_not_found_error）', async () => {
    const registry = await setUp({ orgCode: 'personal' })

    await registry.get('raccoon')!.adapter.listModels('raccoon')
    expect(seenOrgCodes).toEqual([''])
  })

  it('真实组织码原样发出（不能被误折叠）', async () => {
    const registry = await setUp({ orgCode: 'org-abc123' })

    await registry.get('raccoon')!.adapter.listModels('raccoon')
    expect(seenOrgCodes).toEqual(['org-abc123'])
  })

  it('无账号时不抛错，回退静态兜底表', async () => {
    const registry = await setUp({ withAccount: false })

    const models = await registry.get('raccoon')!.adapter.listModels('raccoon')
    const ids = models.map((m) => m.id)
    expect(ids).toContain('sn-glm-5-3')
    expect(ids).not.toContain('sn-deepseek-v4-1-flash-1017')
    // 无凭据时不该发网络（发了也只会 401）。
    expect(seenOrgCodes).toEqual([])
  })

  it('适配器自身在 fetchRemoteModels 缺失时保持兜底表（旧行为不回退）', async () => {
    // 直接构造（不经 wiring）：证明「没接远端」时的行为就是纯兜底表。
    const adapter = new modules.adapterM.RaccoonAdapter({
      resolveCredential: async () => undefined,
      refresh: async () => {},
    })
    const ids = (await adapter.listModels('raccoon')).map((m: { id: string }) => m.id)
    expect(ids).toContain('sn-glm-5-3')
    expect(ids).not.toContain('sn-deepseek-v4-1-flash-1017')
  })
})
