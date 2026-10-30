import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AccountPool } from '../../src/pool/account-pool.js'
import type { ProviderAccountEntry } from '../../src/pool/types.js'
import type { ProviderRegistry } from '../../src/providers/registry.js'

/**
 * OfficeAce **模型积分倍率**（2026-10-28 用户报障「模型列表页没有显示积分消耗倍率」）。
 *
 * ## 数据源是怎么找到的（别再猜错路径）
 *
 * 用户看到的形态是模型选择器里每个模型后面跟一个 `0.18x` + 积分图标。
 * 那是果办客户端渲染的，**不是** `/v1/subscription` 的字段，也不在
 * `/v1/subscription/model-token-rates` 下面 —— 实测那条路径回
 * `APIG.0303 app not found`（那是**另一条** API 的 appkey 认证，不是我们的
 * STS 签名）。正确路径**不带 `subscription` 前缀**：`GET /v1/model-token-rates`。
 * 依据是客户端本地服务的实现（`packages/api/dist/index.js` 的 `getModelTokenRates`）。
 *
 * 上游实测响应（2026-10-28）：
 * ```json
 * {"models":[{"model_name":"deepseek-v4.1-flash","cost_coefficient":0.18},
 *            {"model_name":"kimi-k3\n","cost_coefficient":2.38}]}
 * ```
 *
 * ## 本文件锁死的不变量
 *
 * | # | 不变量 | 违反的后果 |
 * |---|--------|-----------|
 * | 1 | 倍率真的打到 `/v1/model-token-rates`，且是 V11 签名（GET 不带 Content-Type）| 401 / 倍率整列消失 |
 * | 2 | `model_name` 末尾的 `\n` 被 trim | `kimi-k3` 静默显示成"无倍率" |
 * | 3 | 倍率进 `listModels` 与 `listAllModels`（管理端读后者）| 面板一行倍率都不显示 |
 * | 4 | 倍率端点失败时**目录照常返回**，只是没有倍率 | 一个展示性问题把整个目录拖空 |
 * | 5 | `costCoefficient` 缺席 ≠ 0（不得补 0、不得当免费）| 把"未知"显示成"免费"会误导选型 |
 * | 6 | `invalidateModelCatalog()` 也清倍率缓存 | 点「刷新模型目录」后倍率仍是旧值 |
 *
 * ⚠️ `wiring.ts` 的目录缓存是**模块级单例**（6 小时 TTL + 磁盘快照），同文件第二个
 * 用例会吃缓存、一个字节网络都不发。故每个用例 `vi.resetModules()` 后重新 import
 * （与 `officeace-remote-catalog.spec.ts` 同法）。
 */
type WiringModule = typeof import('../../src/providers/wiring.js')
type PoolModule = typeof import('../../src/pool/account-pool.js')
type StoreModule = typeof import('../../src/pool/store.js')
type RegistryModule = typeof import('../../src/providers/registry.js')
type AdapterModule = typeof import('../../src/providers/officeace-adapter.js')
type ProductModule = typeof import('../../src/providers/officeace-product.js')
type CreditsModule = typeof import('../../src/providers/officeace-credits.js')

const ACCOUNT_BASE = 'https://modelgw-0009.officeace.cn-southwest-2.huaweicloud-agentarts.com'

/** 上游目录（`/v2/models`）：倍率表里有、没有的模型都要各来一个，用于验证"缺席"语义。 */
const REMOTE_IDS = ['deepseek-v4.1-flash', 'glm-5.3', 'kimi-k3', 'qwen3-32b']

/**
 * 上游倍率（`/v1/model-token-rates`）。刻意做成**不覆盖全部目录模型**：
 * `qwen3-32b` 不在里面，用于锁死"缺席时不补 0"。
 * `kimi-k3` 末尾带 `\n` —— 这是上游真实下发形态，不是笔误。
 */
const RATE_ROWS = [
  { model_name: 'deepseek-v4.1-flash', cost_coefficient: 0.18 },
  { model_name: 'glm-5.3', cost_coefficient: 0.79 },
  { model_name: 'kimi-k3\n', cost_coefficient: 2.38 },
]

describe('OfficeAce 模型积分倍率', () => {
  let dir: string
  let modules: {
    wiring: WiringModule
    poolM: PoolModule
    storeM: StoreModule
    registryM: RegistryModule
    adapterM: AdapterModule
    productM: ProductModule
    creditsM: CreditsModule
  }
  /** 捕获到的倍率请求（URL + 请求头）。 */
  let rateUrls: string[]
  let rateHeaders: Array<Record<string, string>>
  /** 倍率端点行为。 */
  let rateMode: 'ok' | 'http-500' | 'empty' | 'garbage'
  /** 倍率表内容（用例可改写以模拟上游调价）。 */
  let rateRows: Array<{ model_name: string; cost_coefficient: number }>

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'all-proxy-officeace-rates-'))
    rateUrls = []
    rateHeaders = []
    rateMode = 'ok'
    rateRows = [...RATE_ROWS]
    vi.resetModules()
    modules = {
      wiring: await import('../../src/providers/wiring.js'),
      poolM: await import('../../src/pool/account-pool.js'),
      storeM: await import('../../src/pool/store.js'),
      registryM: await import('../../src/providers/registry.js'),
      adapterM: await import('../../src/providers/officeace-adapter.js'),
      productM: await import('../../src/providers/officeace-product.js'),
      creditsM: await import('../../src/providers/officeace-credits.js'),
    }
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    rmSync(dir, { recursive: true, force: true })
  })

  /** 模拟上游两个端点：`/v2/models`（目录）与 `/v1/model-token-rates`（倍率）。 */
  function makeFetcher(): typeof fetch {
    return (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      const headers = (init?.headers ?? {}) as Record<string, string>

      if (url.includes('/v2/models')) {
        const isProbe = (headers['Accept'] ?? headers['accept'] ?? '') === ''
        if (isProbe) {
          return new Response(JSON.stringify({ object: 'list', data: [] }), {
            status: 200, headers: { 'Content-Type': 'application/json' },
          })
        }
        return new Response(JSON.stringify({
          object: 'list',
          data: REMOTE_IDS.map((id) => ({ id, object: 'list', created: 0, owned_by: 'system' })),
        }), { status: 200, headers: { 'Content-Type': 'application/json' } })
      }

      if (url.includes('/v1/model-token-rates')) {
        rateUrls.push(url)
        rateHeaders.push(headers)
        if (rateMode === 'http-500') return new Response('boom', { status: 500 })
        if (rateMode === 'empty') {
          return new Response(JSON.stringify({ models: [] }), {
            status: 200, headers: { 'Content-Type': 'application/json' },
          })
        }
        if (rateMode === 'garbage') return new Response('<html>not json</html>', { status: 200 })
        return new Response(JSON.stringify({ models: rateRows }), {
          status: 200, headers: { 'Content-Type': 'application/json' },
        })
      }

      return new Response('', { status: 404 })
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

  function makeCredential(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      modelAppKey: 'app-key',
      modelAppSecret: 'app-secret',
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

  /** 建池 + 注册表；`dataDir` 指到临时目录，避免污染真实 `data/catalogs`。 */
  async function setUp(): Promise<{ registry: ProviderRegistry; pool: AccountPool }> {
    const credentials = new modules.storeM.FileCredentialStore(dir)
    const pool: AccountPool = new modules.poolM.AccountPool({ credentials, dataDir: dir })
    await credentials.set('OFFICEACE_ACCOUNT_T1', JSON.stringify(makeCredential()))
    await pool.addAccount(makeAccount())
    // ⚠️ `probe()` 走的是**全局 `fetch`**（适配器只对目录/倍率/推理用注入的
    //    fetchImpl），故必须同时 stub 全局，否则 probe 会打真实网络并 401
    //    ⇒ 空目录，测不到倍率这条路。
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
    return { registry, pool }
  }

  function officeaceAdapter(registry: ProviderRegistry): OfficeAceAdapterLike {
    const entry = registry.list().find((e) => e.descriptor.id === 'officeace')
    if (entry === undefined) throw new Error('officeace 未注册')
    return entry.adapter as unknown as OfficeAceAdapterLike
  }

  interface OfficeAceAdapterLike {
    listModels(provider: string): Promise<readonly { id: string; name: string; costCoefficient?: number }[]>
    listAllModels(provider?: string): readonly { id: string; name: string; costCoefficient?: number }[]
    invalidateModelCatalog(): void
  }

  // ───────────────────────── 解析层（纯函数） ─────────────────────────

  describe('parseOfficeAceModelTokenRates', () => {
    it('剥掉 model_name 末尾的换行（上游真实下发 kimi-k3\\n）', () => {
      const parsed = modules.productM.parseOfficeAceModelTokenRates({ models: RATE_ROWS })
      const kimi = parsed.find((r) => r.model === 'kimi-k3')
      expect(kimi?.costCoefficient).toBe(2.38)
      // 未 trim 的实现会产出 'kimi-k3\n' 这个键，导致目录里永远匹配不上。
      expect(parsed.some((r) => r.model.includes('\n'))).toBe(false)
    })

    it('同时认下划线与驼峰两种字段名', () => {
      const parsed = modules.productM.parseOfficeAceModelTokenRates({
        models: [
          { model_name: 'a', cost_coefficient: 0.5 },
          { modelName: 'b', costCoefficient: 0.7 },
        ],
      })
      expect(parsed).toEqual([
        expect.objectContaining({ model: 'a', costCoefficient: 0.5 }),
        expect.objectContaining({ model: 'b', costCoefficient: 0.7 }),
      ])
    })

    it('顶层裸数组也认（上游改形状时不必再发一版）', () => {
      const parsed = modules.productM.parseOfficeAceModelTokenRates(RATE_ROWS)
      expect(parsed).toHaveLength(3)
    })

    it('四个字段全缺的条目被丢弃（留着会让调用方以为"有数据"）', () => {
      const parsed = modules.productM.parseOfficeAceModelTokenRates({
        models: [{ model_name: 'x' }, { model_name: 'y', cost_coefficient: 0.3 }],
      })
      expect(parsed.map((r) => r.model)).toEqual(['y'])
    })

    it('倍率为非有限数时按缺席处理，不产出 0', () => {
      const parsed = modules.productM.parseOfficeAceModelTokenRates({
        models: [{ model_name: 'x', cost_coefficient: 'abc' }],
      })
      expect(parsed).toEqual([])
    })
  })

  // ───────────────────────── 契约层：LlmModelInfo ─────────────────────────

  it('listModels 播报 costCoefficient，且缺席的模型不带该字段（不是 0）', async () => {
    const { registry } = await setUp()
    const models = await officeaceAdapter(registry).listModels('officeace')

    const deepseek = models.find((m) => m.id === 'deepseek-v4.1-flash')
    expect(deepseek?.costCoefficient).toBe(0.18)

    const kimi = models.find((m) => m.id === 'kimi-k3')
    expect(kimi?.costCoefficient).toBe(2.38)

    // 上游倍率表里没有 qwen3-32b ⇒ 字段必须**缺席**，不能补 0。
    const qwen = models.find((m) => m.id === 'qwen3-32b')
    expect(qwen).toBeDefined()
    expect(qwen && 'costCoefficient' in qwen).toBe(false)
  })

  it('listAllModels（管理端「模型列表」读的正是它）也带倍率', async () => {
    const { registry } = await setUp()
    const adapter = officeaceAdapter(registry)
    // 管理端链路：先 listModels 灌缓存，再 listAllModels 读。
    await adapter.listModels('officeace')
    const all = adapter.listAllModels('officeace')
    expect(all.find((m) => m.id === 'glm-5.3')?.costCoefficient).toBe(0.79)
  })

  // ───────────────────────── 协议层：签名与端点 ─────────────────────────

  it('倍率请求打到 /v1/model-token-rates，且是 V11 签名 GET（不带 Content-Type）', async () => {
    const { registry } = await setUp()
    await officeaceAdapter(registry).listModels('officeace')

    expect(rateUrls).toHaveLength(1)
    // ⚠️ 与余额查询（`fetchOfficeAceCloudSubscription`）用**同一个** base：
    //    两者同属云侧订阅 API 族、同一套 V11 签名。实测 `defaultBaseUrl` 与
    //    凭据里的 `maasBaseUrl` 对这条端点都回 200 且数据一致
    //    （2026-10-28），故沿用 credits 的口径保持一致，不另起一套寻址规则。
    //    注意这与**推理/目录**不同 —— 那两处必须用账号下发的 host（Basic 认证，
    //    打错域会 401 `APIG.1009`）。
    expect(rateUrls[0]).toBe(`${modules.productM.OFFICEACE.defaultBaseUrl}/v1/model-token-rates`)
    const headers = rateHeaders[0]
    expect(headers['Authorization']).toMatch(/^V11-HMAC-SHA256 Credential=/)
    // 规则 1：GET 不带 Content-Type（多这一个头签名串就多一行，服务端重算必不匹配）。
    expect(headers['Content-Type'] ?? headers['content-type']).toBeUndefined()
    expect(headers['X-Security-Token'] ?? headers['x-security-token']).toBe('tok')
  })

  // ───────────────────────── 失败语义 ─────────────────────────

  it.each([
    ['http-500', 'HTTP 500'],
    ['empty', '上游回空表'],
    ['garbage', '非 JSON'],
  ] as const)('倍率端点失败（%s）时目录照常返回，只是没有倍率', async (mode) => {
    rateMode = mode
    const { registry } = await setUp()
    const models = await officeaceAdapter(registry).listModels('officeace')

    // 目录是主信息，绝不能因为「少一列数字」而变空。
    expect(models.length).toBeGreaterThan(0)
    expect(models.every((m) => m.costCoefficient === undefined)).toBe(true)
  })

  it('未注入 fetchRemoteTokenRates 时 listModels 正常、无倍率（不是崩溃）', async () => {
    const adapter = new modules.adapterM.OfficeAceAdapter({
      resolveCredential: async () => makeCredential() as never,
      fetchRemoteModels: async () => REMOTE_IDS.map((id) => ({ id, name: id })),
    } as never)
    // probe 走全局 fetch —— 没有注入 fetchImpl 时用真实 fetch，这里桩掉它。
    vi.stubGlobal('fetch', makeFetcher())
    const models = await adapter.listModels('officeace')
    expect(models.length).toBeGreaterThan(0)
    expect(models.every((m) => m.costCoefficient === undefined)).toBe(true)
  })

  // ───────────────────────── 刷新语义 ─────────────────────────

  it('「刷新模型目录」能把倍率一起刷新（含 wiring 的三层缓存与副键强制标记）', async () => {
    const { registry } = await setUp()
    const adapter = officeaceAdapter(registry)
    await adapter.listModels('officeace')
    expect(adapter.listAllModels('officeace').find((m) => m.id === 'glm-5.3')?.costCoefficient).toBe(0.79)

    // 上游调价
    rateRows = [{ model_name: 'glm-5.3', cost_coefficient: 0.42 }]

    // ⚠️ 必须走**用户真实路径** `refreshModelCatalog`，而不是只调
    //    `adapter.invalidateModelCatalog()`：倍率在 wiring 里还有一层模块级
    //    缓存（键 `officeace-token-rates`，6 小时 TTL + 磁盘快照）。
    //    只清适配器缓存的话，`fetchRemoteTokenRates` 仍会命中 wiring 的缓存、
    //    一个字节网络都不发 —— 用户点「刷新」看到的是旧倍率，且界面没有任何
    //    线索说明为什么。这正是本项目踩过多次的「点了刷新纹丝不动」同型缺陷。
    const result = await modules.wiring.refreshModelCatalog(registry, 'officeace')
    expect(result.results?.[0]?.provider).toBe('officeace')

    expect(adapter.listAllModels('officeace').find((m) => m.id === 'glm-5.3')?.costCoefficient).toBe(0.42)
  })
})
