import { describe, expect, it } from 'vitest'
import type { GenerateOptions, StreamChunk } from '../../src/shared/llm.js'
import { RACCOON } from '../../src/providers/raccoon-product.js'
import { RaccoonAdapter } from '../../src/providers/raccoon-adapter.js'
import type { RaccoonCredential } from '../../src/providers/raccoon.js'
import { raccoonDisplayName } from '../../src/providers/raccoon.js'
import type { AccountPool } from '../../src/pool/account-pool.js'
import { currentAccountIdFor } from '../../src/providers/current-account.js'

const CRED: RaccoonCredential = { access_token: 'tok', refresh_token: 'r' }

/** 造一个远端模型条目（形状照抄真实 `model_catalog`）。 */
function remoteModel(patch: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name: 'sn-glm-5-3',
    description: 'GLM-5-3',
    visible: true,
    tags: ['general'],
    ability_level: 2,
    params: { context_window: 1_000_000, max_tokens: 100_000 },
    billing_multiplier: 0.75,
    billing_effective_multiplier: 0.75,
    billing_status: 'normal',
    ...patch,
  }
}

/** 造一个 adapter（默认：有凭据、有远端目录、无账号池）。 */
function makeAdapter(patch: {
  models?: Record<string, unknown>[]
  credential?: RaccoonCredential | undefined
  pool?: AccountPool
  fetcher?: typeof fetch
} = {}): RaccoonAdapter {
  const models = patch.models ?? [remoteModel()]
  return new RaccoonAdapter({
    resolveCredential: async () => ('credential' in patch ? patch.credential : CRED),
    refresh: async () => {},
    // ⚠️ 生产路径是 `RaccoonAuth.fetchModels` → `raccoonDisplayName`（含倍率）。
    // 替身必须复现这一点，否则测试会断言到「裸 description」这个**生产不会出现**
    // 的形状，从而既测不出倍率丢失、又让人误以为实现有问题。
    fetchRemoteModels: async () => models.map((m) => {
      const params = (m.params ?? {}) as Record<string, unknown>
      return {
        id: String(m.name),
        name: raccoonDisplayName({
          id: String(m.name),
          description: String(m.description),
          effectiveMultiplier: typeof m.billing_effective_multiplier === 'number'
            ? m.billing_effective_multiplier : Number.NaN,
          baseMultiplier: typeof m.billing_multiplier === 'number'
            ? m.billing_multiplier : Number.NaN,
          status: 'normal',
          statusNote: '',
        }),
        contextWindow: Number(params.context_window ?? 0),
        maxTokens: Number(params.max_tokens ?? 0),
        supportsImage: Array.isArray(m.tags) && (m.tags as string[]).includes('vision'),
      }
    }),
    ...patch.pool === undefined ? {} : { accountPool: patch.pool },
    ...patch.fetcher === undefined ? {} : { fetchImpl: patch.fetcher },
  })
}

/** SSE 响应体。 */
function sseResponse(frames: string[]): Response {
  const body = frames.map((f) => `data: ${f}\n\n`).join('') + 'data: [DONE]\n\n'
  return new Response(body, {
    status: 200,
    headers: { 'Content-Type': 'text/event-stream' },
  })
}

/** 收集 stream 的全部 chunk。 */
async function collect(adapter: RaccoonAdapter, options: Partial<GenerateOptions>): Promise<StreamChunk[]> {
  const full = {
    provider: 'raccoon',
    model: 'sn-glm-5-3',
    messages: [{ role: 'user', content: 'hi' }],
    ...options,
  } as GenerateOptions
  const chunks: StreamChunk[] = []
  for await (const c of adapter.stream(full)) chunks.push(c)
  return chunks
}

describe('providerInfo', () => {
  it('返回 id 与显示名', () => {
    const info = makeAdapter().providerInfo('raccoon')
    expect(info.id).toBe('raccoon')
    expect(info.name).toBe('Raccoon (商汤)')
  })

  it('provider 非字符串时回退到产品 id', () => {
    const info = makeAdapter().providerInfo(undefined as unknown as string)
    expect(info.id).toBe('raccoon')
  })
})

describe('listModels', () => {
  it('无账号池时返回全部模型', async () => {
    const models = await makeAdapter().listModels('raccoon')
    expect(models.map((m) => m.id)).toEqual(['sn-glm-5-3'])
    expect(models[0]?.name).toBe('GLM-5-3 · x0.75')
  })

  it('应用黑名单', async () => {
    const pool = { disabledModelsFor: () => new Set(['sn-glm-5-3']) } as unknown as AccountPool
    const models = await makeAdapter({ pool }).listModels('raccoon')
    expect(models).toEqual([])
  })

  it('远端失败时回退兜底表（6 个模型）', async () => {
    const adapter = new RaccoonAdapter({
      resolveCredential: async () => CRED,
      refresh: async () => {},
      fetchRemoteModels: async () => { throw new Error('down') },
    })
    const models = await adapter.listModels('raccoon')
    expect(models).toHaveLength(6)
    expect(models.map(m => m.id)).toContain('sn-glm-5-3')
  })
})

describe('listAllModels', () => {
  it('**不套黑名单**（管理端要显示被关闭的模型）', async () => {
    const pool = { disabledModelsFor: () => new Set(['sn-glm-5-3']) } as unknown as AccountPool
    const adapter = makeAdapter({ pool })
    // 远端目录是**惰性加载**的，故先触发一次加载。
    await adapter.listModels('raccoon')
    const all = adapter.listAllModels()
    expect(all.map((m) => m.id)).toEqual(['sn-glm-5-3'])
    // 且带**最终展示名（含倍率）**，不是裸 id —— 这正是 listAllModels 的价值。
    expect(all[0]?.name).toBe('GLM-5-3 · x0.75')
  })
})

describe('resolveModel', () => {
  it('**name 不带倍率**（价格只属于选择列表语境）', async () => {
    const resolved = await makeAdapter().resolveModel('raccoon', 'sn-glm-5-3')
    expect(resolved.name).toBe('GLM-5-3')
  })

  it('声明 contextWindow 与 defaultMaxTokens', async () => {
    const resolved = await makeAdapter().resolveModel('raccoon', 'sn-glm-5-3')
    expect(resolved.context?.contextWindow).toBe(1_000_000)
    expect(resolved.defaultMaxTokens).toBe(100_000)
  })

  it('未知模型不编造 context', async () => {
    const resolved = await makeAdapter().resolveModel('raccoon', 'nope')
    expect(resolved.context).toBeUndefined()
    expect(resolved.defaultMaxTokens).toBeUndefined()
  })

  it('**远端非法 max_tokens 被过滤**（0/负数/NaN/小数）', async () => {
    for (const bad of [0, -1, Number.NaN, 1.5]) {
      const adapter = makeAdapter({
        models: [remoteModel({ params: { context_window: 1000, max_tokens: bad } })],
      })
      const resolved = await adapter.resolveModel('raccoon', 'sn-glm-5-3')
      expect(resolved.defaultMaxTokens, `max_tokens=${String(bad)} 应被过滤`).toBeUndefined()
    }
  })

  it('图片模态按 tags 含 vision 判定', async () => {
    const withVision = makeAdapter({ models: [remoteModel({ tags: ['general', 'vision'] })] })
    expect((await withVision.resolveModel('raccoon', 'sn-glm-5-3')).inputModalities).toEqual(['text', 'image'])
    const withoutVision = makeAdapter({ models: [remoteModel({ tags: ['general'] })] })
    expect((await withoutVision.resolveModel('raccoon', 'sn-glm-5-3')).inputModalities).toEqual(['text'])
  })
})

describe('stream', () => {
  it('**把 options.tools 真的下发到请求体顶层 tools**', async () => {
    // Qoder/TRAE 都因漏发而让模型在正文里臆造 XML 工具调用。
    let body: Record<string, unknown> | undefined
    const fetcher = (async (_url: string, init: RequestInit) => {
      body = JSON.parse(String(init.body)) as Record<string, unknown>
      return sseResponse([JSON.stringify({ choices: [{ delta: { content: 'ok' }, finish_reason: 'stop' }] })])
    }) as unknown as typeof fetch
    const adapter = makeAdapter({ fetcher })
    await collect(adapter, {
      tools: [{ name: 'read', description: 'read a file', parameters: { type: 'object', properties: {} } }],
    })
    expect(body?.['tools']).toEqual([
      { type: 'function', function: { name: 'read', description: 'read a file', parameters: { type: 'object', properties: {} } } },
    ])
  })

  it('无 tools 时不下发空数组', async () => {
    let body: Record<string, unknown> | undefined
    const fetcher = (async (_url: string, init: RequestInit) => {
      body = JSON.parse(String(init.body)) as Record<string, unknown>
      return sseResponse([JSON.stringify({ choices: [{ delta: { content: 'ok' }, finish_reason: 'stop' }] })])
    }) as unknown as typeof fetch
    await collect(makeAdapter({ fetcher }), {})
    expect('tools' in (body ?? {})).toBe(false)
  })

  it('请求体含 model / messages / stream:true，且请求到正确端点', async () => {
    let url = ''
    let body: Record<string, unknown> | undefined
    const fetcher = (async (u: string, init: RequestInit) => {
      url = String(u)
      body = JSON.parse(String(init.body)) as Record<string, unknown>
      return sseResponse([JSON.stringify({ choices: [{ delta: { content: 'ok' }, finish_reason: 'stop' }] })])
    }) as unknown as typeof fetch
    await collect(makeAdapter({ fetcher }), {})
    expect(url).toBe(`${RACCOON.apiBase}${RACCOON.llmApiPrefix}/chat/completions`)
    expect(body?.['model']).toBe('sn-glm-5-3')
    expect(body?.['stream']).toBe(true)
    expect(Array.isArray(body?.['messages'])).toBe(true)
  })

  it('system 被前置为第一条消息', async () => {
    let body: Record<string, unknown> | undefined
    const fetcher = (async (_u: string, init: RequestInit) => {
      body = JSON.parse(String(init.body)) as Record<string, unknown>
      return sseResponse([JSON.stringify({ choices: [{ delta: { content: 'ok' }, finish_reason: 'stop' }] })])
    }) as unknown as typeof fetch
    await collect(makeAdapter({ fetcher }), { system: 'be terse' })
    const messages = body?.['messages'] as Array<Record<string, unknown>>
    expect(messages[0]).toEqual({ role: 'system', content: 'be terse' })
  })

  it('请求头带 Bearer 与 X-Org-Code', async () => {
    let headers: Headers | undefined
    const fetcher = (async (_u: string, init: RequestInit) => {
      headers = new Headers(init.headers as HeadersInit)
      return sseResponse([JSON.stringify({ choices: [{ delta: { content: 'ok' }, finish_reason: 'stop' }] })])
    }) as unknown as typeof fetch
    const adapter = new RaccoonAdapter({
      resolveCredential: async () => ({ access_token: 'tok', refresh_token: 'r', office_identity: 'org-1' }),
      refresh: async () => {},
      fetchRemoteModels: async () => [],
      fetchImpl: fetcher,
    })
    await collect(adapter, {})
    expect(headers?.get('Authorization')).toBe('Bearer tok')
    expect(headers?.get('X-Org-Code')).toBe('org-1')
  })

  it('解析标准 OpenAI SSE（content 成块）', async () => {
    const fetcher = (async () => sseResponse([
      JSON.stringify({ choices: [{ delta: { content: 'Hel' } }] }),
      JSON.stringify({ choices: [{ delta: { content: 'lo' }, finish_reason: 'stop' }] }),
    ])) as unknown as typeof fetch
    const chunks = await collect(makeAdapter({ fetcher }), {})
    const text = chunks.filter(c => c.type === 'text-delta').map(c => (c as { text: string }).text).join('')
    expect(text).toBe('Hello')
  })

  it('解析 reasoning_content（思考内容）', async () => {
    const fetcher = (async () => sseResponse([
      JSON.stringify({ choices: [{ delta: { reasoning_content: 'thinking...' } }] }),
      JSON.stringify({ choices: [{ delta: { content: 'answer' }, finish_reason: 'stop' }] }),
    ])) as unknown as typeof fetch
    const chunks = await collect(makeAdapter({ fetcher }), {})
    const reasoning = chunks.filter(c => c.type === 'reasoning-delta').map(c => (c as { text: string }).text).join('')
    expect(reasoning).toContain('thinking')
  })

  it('解析工具调用（finish_reason: tool_calls）', async () => {
    const fetcher = (async () => sseResponse([
      JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_1', function: { name: 'read', arguments: '{"p":1}' } }] } }] }),
      JSON.stringify({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] }),
    ])) as unknown as typeof fetch
    const chunks = await collect(makeAdapter({ fetcher }), {})
    const finish = chunks.find(c => c.type === 'finish')
    expect((finish as { reason: { kind: string } }).reason.kind).toBe('tool-calls')
    const toolDeltas = chunks.filter(c => c.type === 'tool-call-delta')
    expect(toolDeltas.length).toBeGreaterThan(0)
  })

  it('无凭据时抛 MISSING_CREDENTIAL', async () => {
    const adapter = makeAdapter({ credential: undefined })
    await expect(collect(adapter, {})).rejects.toThrow(/no usable credential/)
  })

  it('给不支持图片的模型传图片时抛 UNSUPPORTED_CONTENT', async () => {
    const adapter = makeAdapter({ models: [remoteModel({ tags: ['general'] })] })
    await expect(collect(adapter, {
      messages: [{
        role: 'user',
        content: [{ type: 'image', attachment: { attachmentId: 'img-1' } }],
      }],
    })).rejects.toThrow(/不支持图片输入/)
  })

  it('HTTP 401 时刷新一次再重试', async () => {
    let calls = 0
    let refreshed = 0
    const fetcher = (async () => {
      calls++
      if (calls === 1) return new Response('unauthorized', { status: 401 })
      return sseResponse([JSON.stringify({ choices: [{ delta: { content: 'ok' }, finish_reason: 'stop' }] })])
    }) as unknown as typeof fetch
    const adapter = new RaccoonAdapter({
      resolveCredential: async () => CRED,
      refresh: async () => { refreshed++ },
      fetchRemoteModels: async () => [],
      fetchImpl: fetcher,
    })
    const chunks = await collect(adapter, {})
    expect(refreshed).toBe(1)
    expect(calls).toBe(2)
    expect(chunks.some(c => c.type === 'text-delta')).toBe(true)
  })

  it('非 2xx（非 401/403）时抛出带状态码的错误', async () => {
    const fetcher = (async () => new Response('{"error":{"message":"bad"}}', { status: 400 })) as unknown as typeof fetch
    await expect(collect(makeAdapter({ fetcher }), {})).rejects.toThrow()
  })
})

/**
 * 请求级换号（真实缺陷回归，2026-09-29）。
 *
 * ## 真实故障
 *
 * Loomy 报障「积分余额不足不切号」暴露了通用问题：账号按手动顺序选取，
 * 排首位的耗尽账号**每次**都被选中并失败。Raccoon 按用户自写的
 * `xiaohuanxiong2api/raccoon-gateway.js`（在线实测的判据）补上故障转移：
 * 402/403 与额度文案 → 当天锁标记 + 换号；429 → 短冷却 + 换号；
 * 401 → 刷新失败后弃用换号；其余错误与账号无关，原样抛出。
 */
describe('RaccoonAdapter 请求级换号', () => {
  const OK_SSE = [JSON.stringify({ choices: [{ delta: { content: 'ok' }, finish_reason: 'stop' }] })]

  /** 造一个换号用的账号池替身：记录标记调用，按脚本吐出「下一个账号」。 */
  function failoverPool(script: {
    /** findAccountIdByCredential 的返回（首选号反查）。 */
    initialId?: string
    /** getAvailableAccount 按调用次序依次返回；耗尽后返回 null。 */
    next: Array<{ id: string } | null>
  }) {
    const marked: Array<{ accountId: string; modelId: string; resetAtMs: number }> = []
    let pickedCalls = 0
    const pool = {
      findAccountIdByCredential: async () => script.initialId ?? '',
      getAvailableAccount: async (_p: string, _m: string, exclude?: ReadonlySet<string>) => {
        pickedCalls++
        const item = script.next[pickedCalls - 1] ?? null
        if (item === null) return null
        if (exclude?.has(item.id)) return null
        return {
          entry: { id: item.id },
          credential: { access_token: `tok-${item.id}`, refresh_token: 'r' },
        }
      },
      updateModelRateLimit: async (accountId: string, modelId: string, resetAtMs: number) => {
        marked.push({ accountId, modelId, resetAtMs })
      },
      resolveCredentialForAccount: async (id: string) => ({ access_token: `tok-${id}`, refresh_token: 'r' }),
    }
    return { pool: pool as unknown as AccountPool, marked, pickedCalls: () => pickedCalls }
  }

  /** 按脚本返回响应的 fetch（seq 依次取用，耗尽后重复最后一个）。 */
  function scriptedFetcher(seq: Array<{ status: number; body?: string } | { sse: true }>, sent: string[] = []): typeof fetch {
    let call = 0
    return (async (_url: unknown, init?: RequestInit) => {
      sent.push(String((init?.headers as Record<string, string>)?.Authorization ?? ''))
      const item = seq[Math.min(call, seq.length - 1)]!
      call++
      if ('sse' in item) return sseResponse(OK_SSE)
      return new Response(item.body ?? '', { status: item.status })
    }) as unknown as typeof fetch
  }

  it('HTTP 402（额度错误）时换下一个账号重试，并把失败账号标记到 UTC+8 当日 24:00', async () => {
    const { pool, marked } = failoverPool({ initialId: 'acc-1', next: [{ id: 'acc-2' }] })
    const sent: string[] = []
    const fetcher = scriptedFetcher([{ status: 402, body: 'insufficient_points' }, { sse: true }], sent)
    const chunks = await collect(makeAdapter({ pool, fetcher }), {})
    // 第二次请求带的是**换上的账号**的 token。
    expect(sent[1]).toBe('Bearer tok-acc-2')
    expect(chunks.some(c => c.type === 'text-delta')).toBe(true)
    // 失败账号被标记（选号自动跳过），且对齐 UTC+8 的自然日界。
    expect(marked).toHaveLength(1)
    expect(marked[0]).toMatchObject({ accountId: 'acc-1', modelId: 'sn-glm-5-3' })
    // UTC+8 零点 = UTC 16:00：平移 8 小时后应与自然日界对齐。
    expect((marked[0]!.resetAtMs + 8 * 3_600_000) % 86_400_000).toBe(0)
    // 用量归属与定向续期指向实际用上的账号。
    expect(currentAccountIdFor('raccoon')).toBe('acc-2')
  })

  it('HTTP 400 + 「积分余额不足」文案时换号（Loomy 同款实测形态）', async () => {
    const { pool } = failoverPool({ initialId: 'acc-1', next: [{ id: 'acc-2' }] })
    const fetcher = scriptedFetcher([
      { status: 400, body: '积分余额不足，请获取积分后再试' },
      { sse: true },
    ])
    const chunks = await collect(makeAdapter({ pool, fetcher }), {})
    expect(chunks.some(c => c.type === 'text-delta')).toBe(true)
  })

  it('HTTP 403 时按额度错误换号（xiaohuanxiong2api 实测：402/403 = 额度错误）', async () => {
    const { pool } = failoverPool({ initialId: 'acc-1', next: [{ id: 'acc-2' }] })
    const fetcher = scriptedFetcher([{ status: 403, body: 'forbidden' }, { sse: true }])
    const chunks = await collect(makeAdapter({ pool, fetcher }), {})
    expect(chunks.some(c => c.type === 'text-delta')).toBe(true)
  })

  it('HTTP 429 时写入短冷却标记并换号', async () => {
    const { pool, marked } = failoverPool({ initialId: 'acc-1', next: [{ id: 'acc-2' }] })
    const before = Date.now()
    const fetcher = scriptedFetcher([{ status: 429, body: 'rate limited' }, { sse: true }])
    await collect(makeAdapter({ pool, fetcher }), {})
    expect(marked).toHaveLength(1)
    // 短冷却（30 秒量级），而不是当天锁。
    expect(marked[0]!.resetAtMs).toBeGreaterThan(before + 25_000)
    expect(marked[0]!.resetAtMs).toBeLessThanOrEqual(Date.now() + 35_000)
  })

  it('所有账号都额度不足时报 QUOTA_EXCEEDED（试完全部候选才下结论）', async () => {
    const { pool, pickedCalls } = failoverPool({ initialId: 'acc-1', next: [{ id: 'acc-2' }, { id: 'acc-3' }, null] })
    const fetcher = scriptedFetcher([{ status: 402, body: 'insufficient_points' }])
    await expect(collect(makeAdapter({ pool, fetcher }), {}))
      .rejects.toMatchObject({ code: 'QUOTA_EXCEEDED' })
    // 首选 + 2 个候选 = 3 次请求、3 次取号。
    expect(pickedCalls()).toBe(3)
  })

  it('HTTP 400 无额度文案时不换号（与账号无关的请求错误）', async () => {
    const { pool, pickedCalls } = failoverPool({ initialId: 'acc-1', next: [{ id: 'acc-2' }] })
    const fetcher = scriptedFetcher([{ status: 400, body: 'bad request' }])
    await expect(collect(makeAdapter({ pool, fetcher }), {})).rejects.toThrow(/bad request/)
    expect(pickedCalls()).toBe(0)
  })

  it('401 刷新失败时弃用该号换下一个（不写限流标记）', async () => {
    const { pool, marked } = failoverPool({ initialId: 'acc-1', next: [{ id: 'acc-2' }] })
    let refreshed = 0
    const sent: string[] = []
    let call = 0
    const fetcher = (async (_url: unknown, init?: RequestInit) => {
      sent.push(String((init?.headers as Record<string, string>)?.Authorization ?? ''))
      call++
      if (call === 1) return new Response('unauthorized', { status: 401 })
      return sseResponse(OK_SSE)
    }) as unknown as typeof fetch
    const adapter = new RaccoonAdapter({
      resolveCredential: async () => CRED,
      refresh: async () => { refreshed++; throw new Error('refresh failed') },
      accountPool: pool,
      fetchRemoteModels: async () => [],
      fetchImpl: fetcher,
    })
    const chunks = await collect(adapter, {})
    expect(refreshed).toBe(1)
    expect(sent[1]).toBe('Bearer tok-acc-2')
    expect(chunks.some(c => c.type === 'text-delta')).toBe(true)
    // token 过期与限流/额度语义不同，不写标记。
    expect(marked).toHaveLength(0)
  })

  it('无账号池时保持单账号行为（额度错误原样抛出）', async () => {
    const fetcher = scriptedFetcher([{ status: 400, body: '积分余额不足' }])
    await expect(collect(makeAdapter({ fetcher }), {}))
      .rejects.toMatchObject({ code: 'INVALID_REQUEST' })
  })
})
