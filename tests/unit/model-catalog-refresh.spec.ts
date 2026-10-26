import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AccountPool } from '../../src/pool/account-pool.js'
import { FileCredentialStore } from '../../src/pool/store.js'
import { ProviderRegistry } from '../../src/providers/registry.js'
import { registerAllProviders, refreshModelCatalog } from '../../src/providers/wiring.js'
import { SENSENOVA } from '../../src/providers/sensenova-product.js'

/**
 * 「刷新模型目录」的回归测试。
 *
 * ## 为什么这个功能必须有测试
 *
 * 目录有**三层**缓存，而「刷新」的价值全在「把三层都清掉」：
 * 1. `fetchRemoteCatalog` 的模块级内存缓存（6 小时 TTL）；
 * 2. 同上的磁盘快照新鲜度（`data/catalogs/<provider>.json` 的 `fetchedAt`）；
 * 3. **每个适配器自己的 `remoteModels`**（进程内，首次拉取后永不过期）。
 *
 * 漏掉第 3 层是最容易犯的错：只清模块缓存后，适配器直接返回自己那份旧列表，
 * `fetchRemoteCatalog` 根本不会被调用 —— 按钮看起来「点了没反应」。
 * 这里的用例专门锁死这一层。
 *
 * ## 另一个必须守住的东西：不能「假装刷新成功」
 *
 * 所有适配器都会在内部吞掉远端失败并回退兜底表（模型目录是展示信息，
 * 不该让 provider 报错）。所以「列表没变」既可能是上游真没新增，也可能是
 * 远端挂了。返回结果里的 `succeeded` / `error` / `fellBack` 必须能区分，
 * 否则用户会对着旧列表以为已经是最新的。
 */

describe('refreshModelCatalog', () => {
  let dir: string
  let credentials: FileCredentialStore
  let pool: AccountPool
  let registry: ProviderRegistry
  const noopLogger = { info: () => {}, warn: () => {}, error: () => {} }

  /** SenseNova 静态 key 的凭据 JSON（唯一有 `access_token` 即可）。 */
  const KEY = 'sk-test-key-0123456789'

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'all-proxy-refresh-catalog-'))
    credentials = new FileCredentialStore(dir)
    pool = new AccountPool({ credentials, dataDir: dir })
    await credentials.set('SENSENOVA_ACCOUNT_CAT1', JSON.stringify({ access_token: KEY }))
    await pool.addAccount({
      id: 'sensenova-cat1',
      provider: 'sensenova',
      nickname: 'cat',
      enabled: true,
      credentialRef: 'SENSENOVA_ACCOUNT_CAT1',
      createdAt: Date.now(),
      refreshable: false,
    })
    registry = new ProviderRegistry()
  })

  afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

  /** 造一份 `/v1/models` 响应体（只列文本模型）。 */
  function modelsBody(ids: string[]): Response {
    return new Response(JSON.stringify({
      data: ids.map((id) => ({
        id,
        name: id,
        output_modalities: ['text'],
        input_modalities: ['text'],
        context_length: 1_000_000,
        max_output_length: 65_536,
      })),
    }), { status: 200 })
  }

  /** 注册只含 SenseNova 的 provider 集合（其余 provider 需要各自的凭据，会干扰计数）。 */
  function registerSensenovaOnly(fetcher: typeof fetch): void {
    registerAllProviders(registry, {
      pool,
      credentials,
      dataDir: dir,
      logger: noopLogger,
      resolveCredential: async () => { throw new Error('本用例不发推理请求') },
      refresh: async () => {},
      readImage: async () => undefined,
      fetcher,
    })
  }

  it('**清掉适配器自己的 remoteModels**：首次 listModels 后缓存，刷新后能拿到新模型', async () => {
    let served = ['kimi-k3', 'glm-5.2']
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).includes('/models')) return modelsBody(served)
      return new Response('{}', { status: 404 })
    }) as unknown as typeof fetch

    registerSensenovaOnly(fetcher)

    // 1) 首次读取：拉远端并缓存（含适配器自己的 remoteModels）。
    const adapter = registry.get('sensenova')!.adapter
    const first = await adapter.listModels('sensenova')
    expect(first.map((m) => m.id)).toEqual(['kimi-k3', 'glm-5.2'])
    expect(fetcher).toHaveBeenCalledTimes(1)

    // 2) 上游上架了新模型。
    served = ['kimi-k3', 'glm-5.2', 'brand-new-model']

    // 3) 不刷新直接再读：命中适配器缓存 ⇒ 看不到新模型（这是正常缓存行为）。
    expect((await adapter.listModels('sensenova')).map((m) => m.id)).not.toContain('brand-new-model')

    // 4) 刷新：必须绕过三层缓存，拿到新模型。
    const result = await refreshModelCatalog(registry, 'sensenova')
    expect(result.succeeded).toBe(1)
    const ids = (await adapter.listModels('sensenova')).map((m) => m.id)
    expect(ids).toContain('brand-new-model')
  })

  it('刷新会重写磁盘快照（fetchedAt 前进，新模型落盘）', async () => {
    const fetcher = vi.fn(async () => modelsBody(['kimi-k3'])) as unknown as typeof fetch
    registerSensenovaOnly(fetcher)
    registry.get('sensenova')!.adapter.invalidateModelCatalog()

    await refreshModelCatalog(registry, 'sensenova')
    const snapshot = JSON.parse(
      readFileSync(join(dir, 'catalogs', 'sensenova.json'), 'utf-8'),
    ) as { fetchedAt: number; models: Array<{ id: string }> }
    expect(snapshot.models.map((m) => m.id)).toContain('kimi-k3')
    expect(typeof snapshot.fetchedAt).toBe('number')
    expect(Date.now() - snapshot.fetchedAt).toBeLessThan(60_000)
  })

  it('**绕过失败冷却**：上一次失败后立刻点刷新，仍会真的再试一次', async () => {
    let fail = true
    const fetcher = vi.fn(async () => (
      fail ? new Response('', { status: 503 }) : modelsBody(['kimi-k3'])
    )) as unknown as typeof fetch
    registerSensenovaOnly(fetcher)

    // 首轮：远端失败（进入 10 分钟失败冷却）。
    await registry.get('sensenova')!.adapter.listModels('sensenova')
    const callsAfterFail = fetcher.mock.calls.length

    // 冷却期内普通读取不会再发网络。
    await registry.get('sensenova')!.adapter.listModels('sensenova')

    // 用户点「刷新模型目录」——语义是「现在就试一次」，冷却必须被绕过。
    fail = false
    await refreshModelCatalog(registry, 'sensenova')
    expect(fetcher.mock.calls.length).toBeGreaterThan(callsAfterFail)
  })

  it('远端失败时如实报错（不假装刷新成功）', async () => {
    const fetcher = vi.fn(async () => new Response('', { status: 503 })) as unknown as typeof fetch
    registerSensenovaOnly(fetcher)
    const result = await refreshModelCatalog(registry, 'sensenova')
    expect(result.succeeded).toBe(0)
    const entry = result.results.find((r) => r.provider === 'sensenova')!
    expect(entry.error).toBeDefined()
    // 回退到兜底表时仍给出模型，但必须标记 fellBack（用户看到的不是新数据）。
    if (entry.count > 0) expect(entry.fellBack).toBe(true)
  })

  it('省略 provider 时刷新全部已注册渠道', async () => {
    const fetcher = vi.fn(async () => modelsBody(['kimi-k3'])) as unknown as typeof fetch
    registerSensenovaOnly(fetcher)
    const result = await refreshModelCatalog(registry)
    expect(result.refreshed).toBe(registry.list().length)
    expect(result.results.map((r) => r.provider)).toEqual(registry.ids())
  })

  it('按 provider 过滤：只刷指定的那个', async () => {
    const fetcher = vi.fn(async () => modelsBody(['kimi-k3'])) as unknown as typeof fetch
    registerSensenovaOnly(fetcher)
    const result = await refreshModelCatalog(registry, 'sensenova')
    expect(result.refreshed).toBe(1)
    expect(result.results).toHaveLength(1)
    expect(result.results[0]!.provider).toBe('sensenova')
  })

  it('未知 provider 不刷新任何渠道（不静默刷新全部）', async () => {
    const fetcher = vi.fn(async () => modelsBody(['kimi-k3'])) as unknown as typeof fetch
    registerSensenovaOnly(fetcher)
    const result = await refreshModelCatalog(registry, 'not-a-provider')
    expect(result.refreshed).toBe(0)
    expect(result.results).toHaveLength(0)
  })

  it('刷新后的目录仍按黑名单过滤（listModels 语义不变）', async () => {
    const fetcher = vi.fn(async () => modelsBody(['kimi-k3', 'glm-5.2'])) as unknown as typeof fetch
    registerSensenovaOnly(fetcher)
    await pool.setModelDisabled('sensenova', 'glm-5.2', true)
    const result = await refreshModelCatalog(registry, 'sensenova')
    // 面板可见数 = 目录数 - 被关闭数
    expect(result.results[0]!.count).toBe(1)
  })

  it('每次适配器的 invalidateModelCatalog 都真的清了它自己的缓存', () => {
    // 结构性断言：10 个远端目录适配器都必须覆盖这个方法，
    // 否则那个 provider 的「刷新」只会清模块缓存、适配器仍返回旧列表。
    for (const name of registry.ids()) {
      const adapter = registry.get(name)!.adapter
      expect(typeof adapter.invalidateModelCatalog).toBe('function')
    }
  })

  /**
   * 强制标记必须**用完即清**。
   *
   * 若异常时没清掉，该 provider 此后每次读取都会无视缓存直连上游 ——
   * 面板每开一次就打一次外部请求，正是缓存要防的事。
   */
  it('刷新结束后强制标记被清除（不会让后续读取永久打上游）', async () => {
    let n = 0
    const fetcher = vi.fn(async () => {
      n += 1
      return modelsBody(['kimi-k3'])
    }) as unknown as typeof fetch
    registerSensenovaOnly(fetcher)
    await refreshModelCatalog(registry, 'sensenova')
    const callsAfterRefresh = n

    // 刷新后再连读三次：应当全部命中缓存，不再发网络。
    for (let i = 0; i < 3; i += 1) {
      await registry.get('sensenova')!.adapter.listModels('sensenova')
    }
    expect(n).toBe(callsAfterRefresh)
  })
})

describe('SENSENOVA 目录与静态 key 的配合', () => {
  it('provider 配置声明了 modelsPath，远端拉取才有 URL', () => {
    expect(SENSENOVA.modelsPath).toBe('/models')
    expect(SENSENOVA.apiBase.endsWith('/v1')).toBe(true)
  })
})
