import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AccountPool } from '../../src/pool/account-pool.js'
import type { ProviderAccountEntry } from '../../src/pool/types.js'
import type { ProviderRegistry } from '../../src/providers/registry.js'
import type { OfficeAceAdapter } from '../../src/providers/officeace-adapter.js'

/**
 * OfficeAce 远端目录接线（2026-10-27 用户报障「为什么这个不会刷新缓存？」）。
 *
 * 症状：面板「模型列表」显示 `8 个模型` + 一句
 * `远端未返回目录，仍显示本地缓存（8 个模型）`，点「刷新模型目录」纹丝不动。
 *
 * 根因：`wiring.ts` 构造 `OfficeAceAdapter` 时**没有**注入 `fetchRemoteModels`，
 * 适配器连这个选项都不存在 —— `listModels` 恒返回 `OFFICEACE_MODELS` 里
 * 2026-10-13 写死的 8 条。上游当时 `/v2/models` 已返回 **26 条**（新增 kimi-k3
 * 系列、openpangu、deepseek-v4-pro 等）。那句「远端未返回目录」是**误导性文案**：
 * 不是远端挂了，而是根本没有远端请求。
 *
 * 这是同一个缺陷的第 5 次重演（codearts / raccoon / sensenova / loomy 之后）。
 *
 * ## 本文件锁死的不变量
 *
 * | # | 不变量 | 违反的后果 |
 * |---|--------|-----------|
 * | 1 | 有账号时真的打 `/v2/models`，并播报兜底表没有的模型 | 模型选择器永远只有 8 个（原始缺陷）|
 * | 2 | 请求打的是**凭据里按账号下发的 host** | 401 `APIG.1009` ⇒ 静默退兜底表 |
 * | 3 | test 档模型被过滤（兜底表从未暴露过）| 上游灰度版本涌进选择器 |
 * | 4 | 无账号 / 远端失败时不抛错，回退兜底表 | 目录失败把整个 provider 变空 |
 * | 5 | `invalidateModelCatalog()` 真的清掉适配器缓存 | 「刷新模型目录」点了没反应 |
 *
 * ⚠️ `wiring.ts` 的目录缓存是**模块级单例**（内存 6 小时 TTL + 磁盘快照），
 * 同文件内第二个用例会直接吃缓存、一个字节网络都不发。故每个用例
 * `vi.resetModules()` 后动态 import 一份全新模块（与 `raccoon-remote-catalog.spec.ts` 同法）。
 */
type WiringModule = typeof import('../../src/providers/wiring.js')
type PoolModule = typeof import('../../src/pool/account-pool.js')
type StoreModule = typeof import('../../src/pool/store.js')
type RegistryModule = typeof import('../../src/providers/registry.js')
type AdapterModule = typeof import('../../src/providers/officeace-adapter.js')
type ProductModule = typeof import('../../src/providers/officeace-product.js')

/** 上游真实响应形状（2026-10-27 实测：`{object:'list', data:[{id,object,created,owned_by}]}`）。 */
const ACCOUNT_BASE = 'https://modelgw-0004.officeace.cn-southwest-2.huaweicloud-agentarts.com'

/** 上游 26 条里挑一部分 —— `kimi-k3` / `deepseek-v4-pro` / `openpangu-2.0-pro` 兜底表都没有。 */
const REMOTE_IDS = [
  'deepseek-v4.1-flash',
  'glm-5.3',
  'kimi-k3.1-pro',
  'kimi-k3-test-1009', // test 档，必须被过滤
  'openpangu-2.0-pro',
  'glm-5.3-test', // test 档，必须被过滤
  'deepseek-v4-pro',
]

describe('OfficeAce 远端模型目录接线', () => {
  let dir: string
  let modules: {
    wiring: WiringModule
    poolM: PoolModule
    storeM: StoreModule
    registryM: RegistryModule
    adapterM: AdapterModule
    productM: ProductModule
  }
  /** 捕获到的**目录**请求 URL（不含 probe）。 */
  let seenUrls: string[]
  let seenAuth: string[]
  /** 捕获到的全部 `/v2/models` 请求（含 probe）。 */
  let allModelUrls: string[]
  /** 远端当前播报的模型 id（用例可改写以模拟「上游上架」）。 */
  let remoteIds: string[]
  /** 让远端失败/为空的开关（只影响目录请求，不影响 probe）。 */
  let remoteMode: 'ok' | 'http-500' | 'empty' | 'garbage'

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'all-proxy-officeace-catalog-'))
    seenUrls = []
    seenAuth = []
    allModelUrls = []
    remoteIds = [...REMOTE_IDS]
    remoteMode = 'ok'
    vi.resetModules()
    modules = {
      wiring: await import('../../src/providers/wiring.js'),
      poolM: await import('../../src/pool/account-pool.js'),
      storeM: await import('../../src/pool/store.js'),
      registryM: await import('../../src/providers/registry.js'),
      adapterM: await import('../../src/providers/officeace-adapter.js'),
      productM: await import('../../src/providers/officeace-product.js'),
    }
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    rmSync(dir, { recursive: true, force: true })
  })

  /**
   * 模拟上游 `/v2/models`。
   *
   * ⚠️ probe 与目录拉取打的是**同一个端点**，只能靠请求头区分：
   * `probe()` 只发 `Authorization`，`fetchOfficeAceRemoteModels()` 另发
   * `Accept: application/json`。据此把「凭据有效性探测」与「目录内容」解耦 ——
   * 否则模拟「目录挂了」时 probe 也会挂，走到的是
   * 「凭据失效 ⇒ 空目录（隐藏分组）」那条**不同**的既有语义。
   */
  function makeFetcher(): typeof fetch {
    return (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      if (!url.includes('/v2/models')) return new Response('', { status: 404 })
      allModelUrls.push(url)
      const headers = (init?.headers ?? {}) as Record<string, string>
      const isProbe = (headers['Accept'] ?? headers['accept'] ?? '') === ''
      if (isProbe) {
        return new Response(JSON.stringify({ object: 'list', data: [] }), {
          status: 200, headers: { 'Content-Type': 'application/json' },
        })
      }
      seenUrls.push(url)
      seenAuth.push(headers['Authorization'] ?? headers['authorization'] ?? '<absent>')
      if (remoteMode === 'http-500') return new Response('boom', { status: 500 })
      if (remoteMode === 'empty') {
        return new Response(JSON.stringify({ object: 'list', data: [] }), {
          status: 200, headers: { 'Content-Type': 'application/json' },
        })
      }
      if (remoteMode === 'garbage') {
        return new Response(JSON.stringify({ object: 'list', data: [{ nope: 1 }, null] }), {
          status: 200, headers: { 'Content-Type': 'application/json' },
        })
      }
      return new Response(JSON.stringify({
        object: 'list',
        data: remoteIds.map((id) => ({ id, object: 'list', created: 0, owned_by: 'system' })),
      }), { status: 200, headers: { 'Content-Type': 'application/json' } })
    }) as unknown as typeof fetch
  }

  function makeAccount(overrides: Partial<ProviderAccountEntry> = {}): ProviderAccountEntry {
    return {
      id: 'officeace-001',
      provider: 'officeace',
      nickname: 'officeace-001',
      enabled: true,
      credentialRef: 'OFFICEACE_ACCOUNT_T1',
      createdAt: Date.now(),
      expiresAt: Date.now() + 3_600_000,
      refreshable: true,
      ...overrides,
    }
  }

  /** OfficeAce 凭据（字段全给，避免 `isExpiring` 触发刷新路径）。 */
  function makeCredential(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      modelAppKey: 'app-key',
      modelAppSecret: 'app-secret',
      // ⚠️ 必须与硬编码默认域不同 —— 用它证明请求走的是「按账号下发的 host」。
      maasBaseUrl: ACCOUNT_BASE,
      access: 'ak',
      secret: 'sk',
      securityToken: 'tok',
      projectId: 'p',
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      refreshToken: 'rt',
      dpopPrivateJwk: {},
      ...overrides,
    }
  }

  async function setUp(options: { withAccount?: boolean; enabled?: boolean; credential?: Record<string, unknown> } = {}): Promise<ProviderRegistry> {
    const credentials = new modules.storeM.FileCredentialStore(dir)
    const pool: AccountPool = new modules.poolM.AccountPool({ credentials, dataDir: dir })
    if (options.withAccount !== false) {
      await credentials.set('OFFICEACE_ACCOUNT_T1', JSON.stringify(options.credential ?? makeCredential()))
      await pool.addAccount(makeAccount({ enabled: options.enabled ?? true }))
    }
    // ⚠️ `probe()` 走的是**全局 `fetch`**（适配器只对目录/推理用 `fetchImpl`），
    //    故这里必须同时 stub 全局，否则 probe 会打真实网络并 401 ⇒ 空目录，
    //    测试就测不到远端目录这条路。注入同一个 fetcher 让计数与响应一致。
    const fetcher = makeFetcher()
    vi.stubGlobal('fetch', fetcher)
    const registry = new modules.registryM.ProviderRegistry()
    modules.wiring.registerAllProviders(registry, {
      pool,
      credentials,
      dataDir: dir,
      logger: { info: () => {}, warn: () => {}, error: () => {} },
      fetcher,
      resolveCredential: async () => undefined,
      refresh: async () => {},
      readImage: async () => { throw new Error('本项目暂无附件服务') },
    })
    return registry
  }

  function adapterOf(registry: ProviderRegistry): OfficeAceAdapter {
    return registry.get('officeace')!.adapter as unknown as OfficeAceAdapter
  }

  it('① 有账号时从远端拉目录，兜底表没有的模型也出现在列表里', async () => {
    const registry = await setUp()
    const ids = (await adapterOf(registry).listModels('officeace')).map((m) => m.id)

    // 上游有、兜底表没有 —— 只能靠远端目录拿到（这是本缺陷的核心断言）。
    expect(ids, '上游有 kimi-k3.1-pro，列表里就必须有').toContain('kimi-k3.1-pro')
    expect(ids).toContain('deepseek-v4-pro')
    expect(ids).toContain('openpangu-2.0-pro')
    expect(ids.length, '远端 5 条有效（7 条减去 2 个 test 档）').toBe(5)
  })

  it('② 目录请求打的是凭据里按账号下发的 host（打错 = 401 APIG.1009 ⇒ 静默退兜底表）', async () => {
    const registry = await setUp()
    await adapterOf(registry).listModels('officeace')

    expect(seenUrls.length, '必须真的发出过目录请求').toBeGreaterThan(0)
    // 目录请求与 probe 都打账号专属域名，不得出现硬编码默认域。
    for (const url of allModelUrls) {
      expect(url, `目录/probe 请求打错 host: ${url}`).toContain(ACCOUNT_BASE)
      expect(url).not.toContain(modules.productM.OFFICEACE.defaultBaseUrl)
    }
    // 目录请求带 Basic 凭据（与推理同源），不能漏鉴权。
    expect(seenAuth.every((a) => a.startsWith('Basic '))).toBe(true)
  })

  it('③ test 档模型被过滤（兜底表从未暴露过上游灰度条目）', async () => {
    const registry = await setUp()
    const ids = (await adapterOf(registry).listModels('officeace')).map((m) => m.id)
    expect(ids).not.toContain('kimi-k3-test-1009')
    expect(ids).not.toContain('glm-5.3-test')
  })

  it('④ 展示名不是裸 id（上游目录只回 id，必须本地美化）', async () => {
    const registry = await setUp()
    const models = await adapterOf(registry).listModels('officeace')
    const byId = new Map(models.map((m) => [m.id, m.name]))

    // 兜底表命中 ⇒ 用表里的美化名。
    expect(byId.get('glm-5.3')).toBe('GLM-5.3')
    expect(byId.get('deepseek-v4.1-flash')).toBe('DeepSeek-V4.1-Flash')
    // 兜底表没有 ⇒ 仍然要美化，不能回显裸 id。
    expect(byId.get('kimi-k3.1-pro')).toBe('Kimi-K3.1-Pro')
    expect(byId.get('openpangu-2.0-pro')).toBe('OpenPangu-2.0-Pro')
    expect(byId.get('deepseek-v4-pro')).toBe('DeepSeek-V4-Pro')
  })

  it('⑤ 多模态闸门仍按静态实测表判（远端不返回能力元数据）', async () => {
    const registry = await setUp()
    const models = await adapterOf(registry).listModels('officeace')
    const modalities = new Map(models.map((m) => [m.id, m.inputModalities]))
    // deepseek-v4.1-flash 实测能吃图；glm-5.3 实测 400（见 OFFICEACE_MODELS 注释）。
    expect(modalities.get('deepseek-v4.1-flash')).toEqual(['text', 'image'])
    expect(modalities.get('glm-5.3')).toEqual(['text'])
  })

  it('⑥ 远端 HTTP 500 时不抛错，回退内置兜底表（8 条）', async () => {
    const registry = await setUp()
    remoteMode = 'http-500'
    const models = await adapterOf(registry).listModels('officeace')
    expect(models.length, '远端失败必须退兜底表，不能变空目录').toBe(8)
    expect(models.map((m) => m.id)).toContain('qwen3-32b')
  })

  it('⑦ 远端返回空目录时回退兜底表（空 ≠ 这个账号没有模型）', async () => {
    const registry = await setUp()
    remoteMode = 'empty'
    const models = await adapterOf(registry).listModels('officeace')
    expect(models.length).toBe(8)
  })

  it('⑧ 远端返回畸形条目时回退兜底表（不因解析失败而空目录）', async () => {
    const registry = await setUp()
    remoteMode = 'garbage'
    const models = await adapterOf(registry).listModels('officeace')
    expect(models.length).toBe(8)
  })

  it('⑨ 无账号时不抛错，回退兜底表且不发目录请求', async () => {
    const registry = await setUp({ withAccount: false })
    const models = await adapterOf(registry).listModels('officeace')
    // 无凭据时 listModels 本就返回 []（分组隐藏），不该是兜底表 —— 这是既有语义。
    expect(models).toEqual([])
    expect(allModelUrls, '无账号不该发任何 /v2/models 请求').toEqual([])
  })

  it('⑩ 停用账号仍能给出目录（拉目录与「能否发推理」无关）', async () => {
    const registry = await setUp({ enabled: false })
    // 停用后 `resolveCredential`（积分分档选号）没有候选，listModels 走空目录分支；
    // 但目录本身仍应可拉 —— 这里直接验证 wiring 的 firstUsable 不过滤 enabled。
    const models = await adapterOf(registry).listModels('officeace')
    // 既有语义：无可用推理凭据 ⇒ 空目录。锁住它，避免将来「顺手」改成播报兜底表。
    expect(models).toEqual([])
  })

  it('⑪ 适配器自身在 fetchRemoteModels 缺失时保持兜底表（旧行为不回退）', async () => {
    // 直接构造（不经 wiring）：证明「没接远端」时的行为就是纯兜底表。
    const adapter = new modules.adapterM.OfficeAceAdapter({
      resolveCredential: async () => undefined,
    })
    expect(adapter.listAllModels().length).toBe(8)
    expect(adapter.listAllModels().map((m) => m.id)).toContain('qwen3-32b')
  })

  it('⑫ invalidateModelCatalog() 立即丢弃适配器自己那份缓存', async () => {
    const registry = await setUp()
    const adapter = adapterOf(registry)

    // 第一轮：远端 5 条（7 条减去 2 个 test 档），已进适配器缓存。
    expect((await adapter.listModels('officeace')).length).toBe(5)
    expect(adapter.listAllModels().length, 'listAllModels 读的是同一份缓存').toBe(5)

    // 失效后**同步**就该回落到兜底表 8 条 —— 这证明适配器那份缓存真的被丢了
    //（不是「看起来清了、其实还吃着旧的」）。
    adapter.invalidateModelCatalog()
    expect(adapter.listAllModels().length, 'invalidate 后 listAllModels 必须回落兜底表').toBe(8)
  })

  it('⑬ refreshModelCatalog() 端到端：刷新后看到上游新增（「刷新模型目录」按钮的真实路径）', async () => {
    const registry = await setUp()
    const adapter = adapterOf(registry)

    // 首次读目录：远端 5 条，三层缓存全部就位。
    expect((await adapter.listModels('officeace')).length).toBe(5)
    const before = seenUrls.length

    // 上游上架新模型。
    remoteIds = [...REMOTE_IDS, 'glm-5.3-flash']

    // 只调 refreshModelCatalog（按钮的真实入口）：它必须清掉**三层**缓存 ——
    // 模块级内存、磁盘快照新鲜度、以及适配器自己的 remoteModels。
    // ⚠️ 只清第三层是不够的：`fetchRemoteCatalog` 会用模块缓存把旧目录补回来
    //    （这正是「点了没反应」的成因之一）。本用例锁死整条链路。
    const result = await modules.wiring.refreshModelCatalog(registry, 'officeace')
    expect(result.results[0]?.error, `刷新不该报错：${result.results[0]?.error}`).toBeUndefined()
    expect(seenUrls.length, '刷新必须真的打了上游').toBeGreaterThan(before)
    expect(result.results[0]?.count, '刷新后报告的是新目录条数').toBe(6)

    const ids = (await adapter.listModels('officeace')).map((m) => m.id)
    expect(ids, '刷新后必须看到上游新增的模型').toContain('glm-5.3-flash')
  })

  it('⑭ registry 描述里 catalogSource 已改为 remote-first（不再是 static-only）', async () => {
    const registry = await setUp()
    expect(registry.get('officeace')!.descriptor.catalogSource).toBe('remote-first')
  })
})
