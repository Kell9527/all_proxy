import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { AccountPool } from '../../src/pool/account-pool.js'
import { FileCredentialStore } from '../../src/pool/store.js'
import { ProviderRegistry } from '../../src/providers/registry.js'
import { ALL_PROVIDER_IDS, registerAllProviders } from '../../src/providers/wiring.js'
import { LoomyAdapter } from '../../src/providers/loomy-adapter.js'
import { listAvailableModels } from '../../src/gateway/model-resolver.js'
import { parseModelRef } from '../../src/providers/registry.js'

const HERE = dirname(fileURLToPath(import.meta.url))

/** 全部 13 个 provider 的期望清单（与规格一致）。 */
const EXPECTED = [
  'codearts', 'buddy', 'workbuddy', 'lobsterai', 'qoder', 'qodercn', 'trae', 'cline', 'loomy', 'raccoon', 'officeace', 'accio', 'sensenova',
]

describe('13 个 provider 的装配', () => {
  let dir: string
  let pool: AccountPool
  let registry: ProviderRegistry

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'all-proxy-wiring-'))
    pool = new AccountPool({ credentials: new FileCredentialStore(dir), dataDir: dir })
    registry = new ProviderRegistry()
    registerAllProviders(registry, {
      pool,
      credentials: new FileCredentialStore(dir),
      logger: { info: () => {}, warn: () => {}, error: () => {} },
      // 没有账号时解析器返回 undefined —— 这正是我们要测的「无凭据不崩」。
      resolveCredential: async () => undefined,
      refresh: async () => {},
      readImage: async () => { throw new Error('本项目暂无附件服务') },
    })
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('注册了全部 13 个 provider（一个不少、一个不多）', () => {
    expect(registry.ids().sort()).toEqual([...EXPECTED].sort())
    expect(registry.ids()).toHaveLength(13)
  })

  it('ALL_PROVIDER_IDS 与注册结果一致（防止清单漂移）', () => {
    expect([...ALL_PROVIDER_IDS].sort()).toEqual([...EXPECTED].sort())
  })

  it('每个 provider 的 descriptor 字段完整', () => {
    for (const { descriptor } of registry.list()) {
      expect(descriptor.id.length, 'id 不能为空').toBeGreaterThan(0)
      expect(descriptor.displayName.length, `${descriptor.id} 缺 displayName`).toBeGreaterThan(0)
      expect(descriptor.apiBase).toMatch(/^https?:\/\//)
      expect(descriptor.chatPath.length).toBeGreaterThan(0)
      expect(descriptor.authKind.length).toBeGreaterThan(0)
      expect(descriptor.catalogSource).toMatch(/^(remote-first|static-only)$/)
    }
  })

  it('鉴权方式按 provider 正确分类', () => {
    expect(registry.get('codearts')?.descriptor.authKind).toBe('huawei-signature')
    expect(registry.get('qoder')?.descriptor.authKind).toBe('qoder-wasm')
    expect(registry.get('qodercn')?.descriptor.authKind).toBe('qoder-wasm')
    expect(registry.get('raccoon')?.descriptor.authKind).toBe('bearer')
  })

  it('Qoder 系两站都走远端目录（WASM 签名已接上）', () => {
    // ⚠️ 2026-10-20 前是 `static-only`：目录端点需要 WASM 签名，本项目当时
    // 没实现 `prepareRequest` ⇒ 恒用编译期兜底表。后果是上游改价 / 改免费额度
    // 一律不反映（用户报障「DeepSeek-Flash 上游已 0×，列表还显示 0.1」）。
    // 现已在 `qoder-catalog.ts` 接上签名远端目录，兜底表降为回退。
    expect(registry.get('qoder')?.descriptor.catalogSource).toBe('remote-first')
    expect(registry.get('qodercn')?.descriptor.catalogSource).toBe('remote-first')
  })

  it('CodeArts 如实登记为不支持图片', () => {
    // ⚠️ CodeArts 只有 text 块能过序列化，声明支持图片会让上游 400。
    expect(registry.get('codearts')?.descriptor.supportsImages).toBe(false)
  })

  it('**loomy / raccoon / sensenova 登记为会轮换账号**', () => {
    // loomy 与 raccoon 早期如实登记为 false（来源没有轮换逻辑）；后应用户要求
    // 为两者补上「额度耗尽 / 限流 / 认证失败 → 换下一个账号」的故障转移，
    // 换号带 tried 排除集不会反复重试同一个账号，故如实改登记为 true。
    // sensenova（静态 API Key）同样有请求级换号：429 换下一把 key（用户要求）。
    expect(registry.get('loomy')?.descriptor.rotatesAccounts).toBe(true)
    expect(registry.get('raccoon')?.descriptor.rotatesAccounts).toBe(true)
    expect(registry.get('sensenova')?.descriptor.rotatesAccounts).toBe(true)
  })

  it('其余 provider 登记为会轮换账号', () => {
    for (const id of ['codearts', 'buddy', 'workbuddy', 'lobsterai', 'qoder', 'qodercn', 'trae', 'cline']) {
      expect(registry.get(id)?.descriptor.rotatesAccounts, `${id} 应会轮换`).toBe(true)
    }
  })

  it('sensenova 用 Bearer 鉴权、支持图片、远端目录', () => {
    const descriptor = registry.get('sensenova')!.descriptor
    expect(descriptor.authKind).toBe('bearer')
    expect(descriptor.catalogSource).toBe('remote-first')
    expect(descriptor.apiBase).toBe('https://token.sensenova.cn/v1')
  })

  it('重复注册同一个 id 会抛错（而不是静默覆盖）', () => {
    const descriptor = registry.get('raccoon')!.descriptor
    const adapter = registry.get('raccoon')!.adapter
    expect(() => registry.register(descriptor, adapter)).toThrow(/已被注册/)
  })
})

describe('11 个 provider 的模型目录', () => {
  let dir: string
  let pool: AccountPool
  let registry: ProviderRegistry

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'all-proxy-catalog-'))
    pool = new AccountPool({ credentials: new FileCredentialStore(dir), dataDir: dir })
    registry = new ProviderRegistry()
    registerAllProviders(registry, {
      pool,
      credentials: new FileCredentialStore(dir),
      logger: { info: () => {}, warn: () => {}, error: () => {} },
      resolveCredential: async () => undefined,
      refresh: async () => {},
      readImage: async () => { throw new Error('本项目暂无附件服务') },
    })
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('**没有任何 provider 因目录失败而整体报错**', async () => {
    // 规格 provider-routing：单个 provider 的目录失败不该让整个列表失败。
    // 这里所有 provider 都没有账号、也没有远端可达，故走兜底表或空目录，
    // 但**绝不能抛错**。
    await expect(listAvailableModels(registry, pool)).resolves.toBeDefined()
  })

  it('每个 provider 的 listModels 单独调用都不抛错', async () => {
    for (const { descriptor, adapter } of registry.list()) {
      await expect(
        adapter.listModels(descriptor.id),
        `${descriptor.id}.listModels 不应抛错`,
      ).resolves.toBeDefined()
    }
  })

  it('Qoder 系（静态目录）在没有网络时也能列出模型', async () => {
    // 静态目录是刻意的：远端目录需要 WASM 签名，且不该依赖网络。
    const qoderModels = await registry.get('qoder')!.adapter.listModels('qoder')
    expect(qoderModels.length).toBeGreaterThan(0)
    const cnModels = await registry.get('qodercn')!.adapter.listModels('qodercn')
    expect(cnModels.length).toBeGreaterThan(0)
  })

  it('**qoder 与 qodercn 的目录不相同**（CN 有独有模型、缺国际版模型）', async () => {
    // AGENTS.md：CN 是 14 条、独有 q37fmodel/gm51model，缺
    // ultimate/performance/efficient/smodel/cmodel。沿用会让菜单出现
    // CN 端点根本不认的模型。
    const intl = new Set((await registry.get('qoder')!.adapter.listModels('qoder')).map(m => m.id))
    const cn = new Set((await registry.get('qodercn')!.adapter.listModels('qodercn')).map(m => m.id))
    expect(cn.has('q37fmodel'), 'CN 应有 q37fmodel').toBe(true)
    expect(intl.has('q37fmodel'), '国际版不应有 q37fmodel').toBe(false)
    expect(intl.has('smodel'), '国际版应有 smodel').toBe(true)
    expect(cn.has('smodel'), 'CN 不应有 smodel').toBe(false)
  })

  it('**模型 id 可以自身含斜杠，且能通过前缀往返还原**', async () => {
    // ⚠️ 这不是假想：`cline` 的模型 id 真的形如 `stealth/pixel-canary`、
    // `cline-free/deepseek-v4.1-flash`。这正是 `parseModelRef` **只按第一个
    // 斜杠切分**的原因 —— 若按最后一个切，这些模型永远无法寻址。
    let sawSlashInId = false
    for (const { descriptor, adapter } of registry.list()) {
      const models = await adapter.listModels(descriptor.id)
      for (const model of models) {
        if (model.id.includes('/')) sawSlashInId = true
        // 核心不变式：`<provider>/<model>` 必须能还原出原始模型 id。
        const ref = `${descriptor.id}/${model.id}`
        const parsed = parseModelRef(ref)
        expect(parsed.ok, `${ref} 应可解析`).toBe(true)
        if (parsed.ok) {
          expect(parsed.provider).toBe(descriptor.id)
          expect(parsed.model, `${ref} 的模型部分应原样还原`).toBe(model.id)
        }
      }
    }
    // 确认这个用例确实覆盖了「模型 id 含斜杠」的情形（否则它是同义反复）。
    expect(sawSlashInId, '应当至少有一个模型 id 含斜杠（cline 的 stealth/* 等）').toBe(true)
  })

  it('被关闭的模型不出现在网关的可用目录里', async () => {
    const all = await listAvailableModels(registry, pool)
    if (all.length === 0) return
    const target = all[0]!
    await pool.setModelDisabled(target.provider, target.model, true)
    const after = await listAvailableModels(registry, pool)
    expect(after.map(m => m.id)).not.toContain(target.id)
  })

  it('全局开关关闭时可用目录为空', async () => {
    await pool.setGlobalModelsEnabled(false)
    expect(await listAvailableModels(registry, pool)).toEqual([])
  })
})

describe('Qoder WASM 资产', () => {
  it('qoder-auth-wasm.wasm 存在于源码目录（与 qoder-wasm.ts 同目录）', () => {
    // ⚠️ `qoder-wasm.ts` 按 `import.meta.url` 相对自身目录解析该文件。
    // 源码树里缺它时，Qoder 会在**第一次请求时**才 ENOENT。
    const wasm = join(HERE, '..', '..', 'src', 'providers', 'qoder-auth-wasm.wasm')
    expect(existsSync(wasm), `缺少 ${wasm}`).toBe(true)
  })

  it('构建脚本会把它复制到 dist（防止 tsc 不搬 .wasm 的坑）', () => {
    const script = join(HERE, '..', '..', 'scripts', 'copy-assets.mjs')
    expect(existsSync(script)).toBe(true)
  })
})

describe('模型寻址在 11 个 provider 上的表现', () => {
  it('每个 provider 的 id 都能作为前缀解析', () => {
    for (const id of EXPECTED) {
      const parsed = parseModelRef(`${id}/some-model`)
      expect(parsed.ok, `${id} 前缀应可解析`).toBe(true)
      if (parsed.ok) {
        expect(parsed.provider).toBe(id)
        expect(parsed.model).toBe('some-model')
      }
    }
  })

  it('重名模型在不同前缀下解析为不同目标', () => {
    // ⚠️ `deepseek-v4-flash` 同时存在于 codearts / buddy / workbuddy /
    // trae / lobsterai —— 这正是强制前缀的原因。
    const a = parseModelRef('codearts/deepseek-v4-flash')
    const b = parseModelRef('buddy/deepseek-v4-flash')
    expect(a.ok && b.ok).toBe(true)
    if (a.ok && b.ok) {
      expect(a.provider).not.toBe(b.provider)
      expect(a.model).toBe(b.model)
    }
  })
})

/**
 * Loomy 的余额选号接线（2026-09-29 移植补齐）。
 *
 * 来源 `src/index.ts` 给 LoomyAdapter 注入的 resolveCredential 是
 * 「按余额分档选号」——通用选号「按手动顺序取第一个」会让 0 积分账号
 * 每次都被选中（用户报障「积分不足不切号」的另一半根因）。
 * 本组用例锁死接线本身：选号器真的被接上、modelId 真的透传。
 */
describe('Loomy 的余额选号接线', () => {
  let dir: string
  let pool: AccountPool
  let registry: ProviderRegistry
  /** 余额查询按 token 返回的积分表（token → 两池余额）。 */
  const balanceByToken: Record<string, { balance: number; dailyBalance: number }> = {}
  /** chat 请求捕获到的 Authorization。 */
  const chatAuth: string[] = []

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'all-proxy-loomy-wiring-'))
    registry = new ProviderRegistry()
    chatAuth.length = 0
    for (const key of Object.keys(balanceByToken)) delete balanceByToken[key]
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    rmSync(dir, { recursive: true, force: true })
  })

  /** 写入两个账号（零分号排首位）并注册全部 provider，返回 loomy 适配器。 */
  async function setup(): Promise<LoomyAdapter> {
    const credentials = new FileCredentialStore(dir)
    await credentials.set('LOOMY_ACCOUNT_AAA1', JSON.stringify({ access_token: 'tok-1', userid: 'u1', phone: 'p1' }))
    await credentials.set('LOOMY_ACCOUNT_BBB2', JSON.stringify({ access_token: 'tok-2', userid: 'u2', phone: 'p2' }))
    pool = new AccountPool({ credentials, dataDir: dir })
    await pool.addAccount({
      id: 'loomy-acc1', provider: 'loomy', nickname: '零分号', enabled: true,
      credentialRef: 'LOOMY_ACCOUNT_AAA1', createdAt: 1, refreshable: false,
    })
    await pool.addAccount({
      id: 'loomy-acc2', provider: 'loomy', nickname: '有分号', enabled: true,
      credentialRef: 'LOOMY_ACCOUNT_BBB2', createdAt: 2, refreshable: false,
    })

    // 按 URL 分流：/points/records 是余额查询（token 在 `token` 头），
    // /chat/completions 是 chat 请求（token 在 Authorization 头）。
    const fetcher = (async (url: unknown, init?: RequestInit) => {
      const href = String(url)
      const headers = (init?.headers ?? {}) as Record<string, string>
      if (href.includes('/points/records')) {
        const found = balanceByToken[headers.token ?? ''] ?? { balance: 0, dailyBalance: 0 }
        return new Response(JSON.stringify({ code: '000000', data: found }), {
          status: 200, headers: { 'Content-Type': 'application/json' },
        })
      }
      if (href.includes('/chat/completions')) {
        chatAuth.push(headers.Authorization ?? '')
        return new Response(
          'data: {"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
          { status: 200, headers: { 'Content-Type': 'text/event-stream' } },
        )
      }
      return new Response('{}', { status: 404 })
    }) as unknown as typeof fetch

    // ⚠️ 适配器构造时若未注入 fetchImpl 会**捕获当时的全局 fetch**（生产行为）。
    // 必须在 registerAllProviders（构造）之前 stub 全局，否则 chat 请求会真的
    // 打到 Loomy 上游（真实教训：首轮运行拿到了上游「登录已失效」的真响应）。
    vi.stubGlobal('fetch', fetcher)
    registerAllProviders(registry, {
      pool,
      credentials,
      logger: { info: () => {}, warn: () => {}, error: () => {} },
      resolveCredential: async () => undefined,
      refresh: async () => {},
      readImage: async () => { throw new Error('本项目暂无附件服务') },
      fetcher,
    })
    return registry.get('loomy')!.adapter as unknown as LoomyAdapter
  }

  /** 跑一次 loomy chat 流（mock 上游恒成功）。 */
  async function runOnce(adapter: LoomyAdapter): Promise<void> {
    for await (const _chunk of adapter.stream({
      provider: 'loomy', model: 'qwen-3.8-max',
      messages: [{ role: 'user', content: 'hi' }],
    } as never)) { /* 跑完即可 */ }
  }

  it('积分为 0 的账号排在首位也不被选中（余额选号生效）', async () => {
    const adapter = await setup()
    balanceByToken['tok-1'] = { balance: 0, dailyBalance: 0 }
    balanceByToken['tok-2'] = { balance: 4795, dailyBalance: 0 }
    await runOnce(adapter)
    expect(chatAuth).toEqual(['Bearer tok-2'])
  })

  it('模型级限流标记参与候选筛选（modelId 透传生效）', async () => {
    const adapter = await setup()
    balanceByToken['tok-1'] = { balance: 0, dailyBalance: 0 }
    balanceByToken['tok-2'] = { balance: 4795, dailyBalance: 0 }
    // 有分的账号在该模型上被标记限流 —— 候选里只剩 0 分账号。
    await pool.updateModelRateLimit('loomy-acc2', 'qwen-3.8-max', Date.now() + 60_000)
    await runOnce(adapter)
    expect(chatAuth).toEqual(['Bearer tok-1'])
  })

  it('锁定永久积分且全部账号只剩永久积分时抛明确错误（不静默消耗永久积分）', async () => {
    const adapter = await setup()
    balanceByToken['tok-1'] = { balance: 0, dailyBalance: 0 }
    balanceByToken['tok-2'] = { balance: 100, dailyBalance: 0 }
    await pool.setLoomyPermanentLocked(true)
    await expect(runOnce(adapter)).rejects.toThrow(/锁定永久积分/)
    expect(chatAuth).toEqual([])
  })
})
