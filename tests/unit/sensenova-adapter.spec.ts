import { afterEach, describe, expect, it } from 'vitest'
import type { GenerateOptions, StreamChunk } from '../../src/shared/llm.js'
import { SENSENOVA } from '../../src/providers/sensenova-product.js'
import { SensenovaAdapter } from '../../src/providers/sensenova-adapter.js'
import type { SensenovaCredential } from '../../src/providers/sensenova.js'
import type { AccountPool } from '../../src/pool/account-pool.js'
import { currentAccountIdFor } from '../../src/providers/current-account.js'

/**
 * SenseNova 适配器单测。
 *
 * 重点是**请求级换号**：正常情况钉住手动顺序的第一个账号；命中 429
 * （tpm/rpm 限流）就换下一把 key 重试 —— 这是用户明确要求的行为
 * （「K3 模型经常容易 429，遇到 429 就轮询，没遇到就继续」）。
 *
 * 2026-10-13 追加：429 冷却 5 秒；**全部账号都在冷却时不直接报错，而是等到
 * 最早一把解禁继续轮询**（「不通就一直轮询」）。
 */

const CRED: SensenovaCredential = { access_token: 'sk-primary' }

/** SSE 响应体。 */
function sseResponse(frames: string[]): Response {
  const body = frames.map((f) => `data: ${f}\n\n`).join('') + 'data: [DONE]\n\n'
  return new Response(body, { status: 200, headers: { 'Content-Type': 'text/event-stream' } })
}

const OK_SSE = [JSON.stringify({ choices: [{ delta: { content: 'ok' }, finish_reason: 'stop' }] })]

/**
 * 换号用的账号池替身：**模拟真实池语义**（限流标记会真的影响后续选号），
 * 否则测不出「等冷却结束再继续轮询」这条新逻辑。
 *
 * - `getAvailableAccount`：按数组顺序返回第一个「未被 exclude、未在冷却期」的账号；
 *   都没有则 null（触发适配器的等待-重试分支）。
 * - `updateModelRateLimit`：把标记写进对应账号（与真实池同形）。
 * - `listAccountsByProvider`：返回全部账号（含 enabled 与 modelRateLimits），
 *   供 `shortestCooldownMs` 计算最早解禁时刻。
 */
function failoverPool(accountDefs: Array<{ id: string; token: string }>) {
  const accounts = accountDefs.map((a) => ({ id: a.id, token: a.token, enabled: true, modelRateLimits: {} as Record<string, number> }))
  const marked: Array<{ accountId: string; modelId: string; resetAtMs: number }> = []
  let pickedCalls = 0
  const pool = {
    getAvailableAccount: async (_p: string, modelId: string, exclude?: ReadonlySet<string>) => {
      pickedCalls++
      const now = Date.now()
      const found = accounts.find((a) =>
        a.enabled
        && (exclude === undefined || !exclude.has(a.id))
        && (modelId.length === 0 || a.modelRateLimits[modelId] === undefined || a.modelRateLimits[modelId]! <= now))
      if (found === undefined) return null
      return { entry: { id: found.id }, credential: { access_token: found.token } as SensenovaCredential }
    },
    updateModelRateLimit: async (accountId: string, modelId: string, resetAtMs: number) => {
      marked.push({ accountId, modelId, resetAtMs })
      const target = accounts.find((a) => a.id === accountId)
      if (target !== undefined) target.modelRateLimits[modelId] = resetAtMs
    },
    listAccountsByProvider: (_p: string) => accounts.map((a) => ({
      id: a.id, provider: 'sensenova', nickname: a.id, enabled: a.enabled,
      credentialRef: a.id, createdAt: 0, refreshable: false,
      modelRateLimits: { ...a.modelRateLimits },
    })),
  }
  return { pool: pool as unknown as AccountPool, marked, pickedCalls: () => pickedCalls }
}

/** 造 adapter（默认：有凭据、无远端目录（走兜底表）、无账号池）。 */
function makeAdapter(patch: {
  credential?: SensenovaCredential | undefined
  pool?: AccountPool
  fetcher?: typeof fetch
  models?: Array<Record<string, unknown>>
} = {}): SensenovaAdapter {
  return new SensenovaAdapter({
    resolveCredential: async () => ('credential' in patch ? patch.credential : CRED),
    ...patch.pool === undefined ? {} : { accountPool: patch.pool },
    ...patch.models === undefined ? {} : { fetchRemoteModels: async () => patch.models as never },
    ...patch.fetcher === undefined ? {} : { fetchImpl: patch.fetcher },
  })
}

/** 按脚本返回响应的 fetch（seq 依次取用，耗尽后重复最后一个）。 */
function scriptedFetcher(
  seq: Array<{ status: number; body?: string } | { sse: true }>,
  sent: string[] = [],
): typeof fetch {
  let call = 0
  return (async (_url: unknown, init?: RequestInit) => {
    sent.push(String((init?.headers as Record<string, string>)?.Authorization ?? ''))
    const item = seq[Math.min(call, seq.length - 1)]!
    call++
    if ('sse' in item) return sseResponse(OK_SSE)
    return new Response(item.body ?? '', { status: item.status })
  }) as unknown as typeof fetch
}

/** 收集 stream 的全部 chunk。 */
async function collect(adapter: SensenovaAdapter, options: Partial<GenerateOptions> = {}): Promise<StreamChunk[]> {
  const full = {
    provider: 'sensenova',
    model: 'kimi-k3',
    messages: [{ role: 'user', content: 'hi' }],
    ...options,
  } as GenerateOptions
  const chunks: StreamChunk[] = []
  for await (const c of adapter.stream(full)) chunks.push(c)
  return chunks
}

describe('SensenovaAdapter 基本属性', () => {
  it('providerInfo 返回展示名', () => {
    const info = makeAdapter().providerInfo('sensenova')
    expect(info.id).toBe('sensenova')
    expect(info.name).toBe('SenseNova (商汤)')
  })

  it('provider 非字符串时回退到产品 id', () => {
    expect(makeAdapter().providerInfo(undefined as unknown as string).id).toBe('sensenova')
  })

  it('chat 请求带 Bearer 头，URL 指向 sensenova 端点', async () => {
    const seen: Array<{ url: string; auth: string }> = []
    const fetcher = (async (url: unknown, init?: RequestInit) => {
      seen.push({ url: String(url), auth: String((init?.headers as Record<string, string>)?.Authorization ?? '') })
      return sseResponse(OK_SSE)
    }) as unknown as typeof fetch
    await collect(makeAdapter({ fetcher }))
    expect(seen[0]?.url).toBe('https://token.sensenova.cn/v1/chat/completions')
    expect(seen[0]?.auth).toBe('Bearer sk-primary')
  })

  it('tools 必须下发到请求体顶层（Qoder/TRAE 的坑）', async () => {
    let body: Record<string, unknown> = {}
    const fetcher = (async (_url: unknown, init?: RequestInit) => {
      body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>
      return sseResponse(OK_SSE)
    }) as unknown as typeof fetch
    await collect(makeAdapter({ fetcher }), {
      tools: [{ name: 'foo', description: 'd', parameters: { type: 'object' } }],
    })
    expect(Array.isArray(body.tools)).toBe(true)
    expect((body.tools as Array<Record<string, unknown>>)[0]).toMatchObject({ type: 'function' })
  })

  it('**流式请求必须带 stream_options.include_usage**（否则上游不发 usage 帧 → 用量恒 0）', async () => {
    let body: Record<string, unknown> = {}
    const fetcher = (async (_url: unknown, init?: RequestInit) => {
      body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>
      return sseResponse(OK_SSE)
    }) as unknown as typeof fetch
    await collect(makeAdapter({ fetcher }))
    expect(body.stream).toBe(true)
    expect(body.stream_options).toEqual({ include_usage: true })
  })

  it('上游 usage 帧被解析为 usage chunk（Token 记账生效）', async () => {
    // 复现真实上游尾部：正常帧 + 空 choices 的 usage 帧。
    const usageFrame = JSON.stringify({
      id: 'x', model: 'kimi-k3', object: 'chat.completion.chunk', choices: [],
      usage: { prompt_tokens: 17, completion_tokens: 20, total_tokens: 37, completion_tokens_details: { reasoning_tokens: 20 } },
    })
    const fetcher = (async () => sseResponse([...OK_SSE, usageFrame])) as unknown as typeof fetch
    const chunks = await collect(makeAdapter({ fetcher }))
    const usage = chunks.find(c => c.type === 'usage')
    expect(usage).toBeDefined()
    if (usage?.type === 'usage') {
      expect(usage.usage.inputTokens).toBe(17)
      expect(usage.usage.outputTokens).toBe(20)
      expect(usage.usage.reasoningTokens).toBe(20)
    }
  })
})

describe('SensenovaAdapter 模型目录', () => {
  it('无远端时用兜底表，含 kimi-k3', async () => {
    const models = await makeAdapter().listModels('sensenova')
    expect(models.map((m) => m.id)).toContain('kimi-k3')
  })

  it('resolveModel 声明 kimi-k3 的上下文与输出上限', async () => {
    const resolved = await makeAdapter().resolveModel('sensenova', 'kimi-k3')
    expect(resolved.context?.contextWindow).toBe(1_048_576)
    expect(resolved.defaultMaxTokens).toBe(65_536)
    expect(resolved.name).toBe('Kimi-K3')
  })

  it('listAllModels 不套黑名单（管理端可见被关闭模型）', async () => {
    const pool = { disabledModelsFor: () => new Set(['kimi-k3']) } as unknown as AccountPool
    const adapter = makeAdapter({ pool })
    const listed = await adapter.listModels('sensenova')
    expect(listed.map((m) => m.id)).not.toContain('kimi-k3')
    expect(adapter.listAllModels().map((m) => m.id)).toContain('kimi-k3')
  })
})

describe('SensenovaAdapter 请求级换号（用户核心诉求）', () => {
  // 轮询测试要控制冷却与预算，避免真的等 5 秒；afterEach 复原。
  const ORIG = { cooldown: process.env.ALL_PROXY_SENSENOVA_RATE_LIMIT_COOLDOWN_MS, budget: process.env.ALL_PROXY_SENSENOVA_ROTATE_BUDGET_MS }
  afterEach(() => {
    if (ORIG.cooldown === undefined) delete process.env.ALL_PROXY_SENSENOVA_RATE_LIMIT_COOLDOWN_MS
    else process.env.ALL_PROXY_SENSENOVA_RATE_LIMIT_COOLDOWN_MS = ORIG.cooldown
    if (ORIG.budget === undefined) delete process.env.ALL_PROXY_SENSENOVA_ROTATE_BUDGET_MS
    else process.env.ALL_PROXY_SENSENOVA_ROTATE_BUDGET_MS = ORIG.budget
  })

  it('**正常情况钉住第一个账号**（无错误不换号）', async () => {
    const { pool, pickedCalls } = failoverPool([{ id: 'acc-1', token: 'sk-a' }])
    const sent: string[] = []
    const fetcher = scriptedFetcher([{ sse: true }], sent)
    const chunks = await collect(makeAdapter({ pool, fetcher }))
    expect(chunks.some(c => c.type === 'text-delta')).toBe(true)
    expect(sent).toEqual(['Bearer sk-a'])
    // 只取号一次 —— 没有触发换号。
    expect(pickedCalls()).toBe(1)
  })

  it('**HTTP 429 换下一把 key 重试**，并给失败账号写 5 秒冷却标记', async () => {
    const { pool, marked } = failoverPool([
      { id: 'acc-1', token: 'sk-a' }, { id: 'acc-2', token: 'sk-b' },
    ])
    const sent: string[] = []
    const before = Date.now()
    const fetcher = scriptedFetcher([
      { status: 429, body: '{"error":{"code":"ModelAccountTpmRateLimitExceeded"}}' },
      { sse: true },
    ], sent)
    const chunks = await collect(makeAdapter({ pool, fetcher }))
    // 第二次请求带的是**换上的那把 key**。
    expect(sent).toEqual(['Bearer sk-a', 'Bearer sk-b'])
    expect(chunks.some(c => c.type === 'text-delta')).toBe(true)
    // 429 是 5 秒短冷却（不是当天锁、也不是 30 秒）。
    expect(marked).toHaveLength(1)
    expect(marked[0]).toMatchObject({ accountId: 'acc-1', modelId: 'kimi-k3' })
    expect(marked[0]!.resetAtMs).toBeGreaterThan(before + 3_000)
    expect(marked[0]!.resetAtMs).toBeLessThanOrEqual(Date.now() + 6_000)
    // 用量归属指向最终用上的账号。
    expect(currentAccountIdFor('sensenova')).toBe('acc-2')
  })

  it('非首个 key 正常时也能成功（首号 429、次号 200）', async () => {
    const { pool } = failoverPool([
      { id: 'acc-1', token: 'sk-a' }, { id: 'acc-2', token: 'sk-b' },
    ])
    const fetcher = scriptedFetcher([
      { status: 429, body: 'rate limited' },
      { sse: true },
    ])
    const chunks = await collect(makeAdapter({ pool, fetcher }))
    expect(chunks.some(c => c.type === 'text-delta')).toBe(true)
  })

  it('**全部 key 都在冷却时不报错，等到最早解禁继续轮询直到成功**', async () => {
    // 冷却设很短，让「等待-重试」在测试里可跑完。
    process.env.ALL_PROXY_SENSENOVA_RATE_LIMIT_COOLDOWN_MS = '40'
    process.env.ALL_PROXY_SENSENOVA_ROTATE_BUDGET_MS = '3000'
    const { pool } = failoverPool([
      { id: 'acc-1', token: 'sk-a' }, { id: 'acc-2', token: 'sk-b' },
    ])
    const sent: string[] = []
    // 前两次全 429（两把都进冷却）→ 适配器应等待后**再次**发请求并成功。
    const fetcher = scriptedFetcher([
      { status: 429, body: 'rate limited' },
      { status: 429, body: 'rate limited' },
      { sse: true },
    ], sent)
    const chunks = await collect(makeAdapter({ pool, fetcher }))
    expect(chunks.some(c => c.type === 'text-delta')).toBe(true)
    // 关键：发出了**第三次**请求（等待冷却后重试），而不是第二次就报错。
    expect(sent.length).toBe(3)
  })

  it('配额类错误（402/403）也换号，并锁到 UTC+8 当日 24:00', async () => {
    const { pool, marked } = failoverPool([
      { id: 'acc-1', token: 'sk-a' }, { id: 'acc-2', token: 'sk-b' },
    ])
    const fetcher = scriptedFetcher([{ status: 402, body: 'quota exhausted' }, { sse: true }])
    await collect(makeAdapter({ pool, fetcher }))
    expect(marked).toHaveLength(1)
    // UTC+8 零点对齐（平移 8 小时后落在自然日界）。
    expect((marked[0]!.resetAtMs + 8 * 3_600_000) % 86_400_000).toBe(0)
  })

  it('401（静态 key 失效）换下一把，且不写限流标记', async () => {
    const { pool, marked } = failoverPool([
      { id: 'acc-1', token: 'sk-a' }, { id: 'acc-2', token: 'sk-b' },
    ])
    const sent: string[] = []
    const fetcher = scriptedFetcher([{ status: 401, body: 'invalid api key' }, { sse: true }], sent)
    const chunks = await collect(makeAdapter({ pool, fetcher }))
    expect(sent[1]).toBe('Bearer sk-b')
    expect(chunks.some(c => c.type === 'text-delta')).toBe(true)
    expect(marked).toHaveLength(0)
  })

  it('预算耗尽仍全 429 时才报 RATE_LIMIT（不会无限挂住）', async () => {
    process.env.ALL_PROXY_SENSENOVA_RATE_LIMIT_COOLDOWN_MS = '40'
    // 预算给得比一轮冷却略大、但不足以等完很多轮。
    process.env.ALL_PROXY_SENSENOVA_ROTATE_BUDGET_MS = '120'
    const { pool } = failoverPool([
      { id: 'acc-1', token: 'sk-a' }, { id: 'acc-2', token: 'sk-b' },
    ])
    const fetcher = scriptedFetcher([{ status: 429, body: 'rate limited' }])
    await expect(collect(makeAdapter({ pool, fetcher })))
      .rejects.toMatchObject({ code: 'RATE_LIMIT' })
  })

  it('配额锁到明天（远超预算）时直接报 QUOTA_EXCEEDED', async () => {
    process.env.ALL_PROXY_SENSENOVA_RATE_LIMIT_COOLDOWN_MS = '40'
    process.env.ALL_PROXY_SENSENOVA_ROTATE_BUDGET_MS = '3000'
    const { pool } = failoverPool([
      { id: 'acc-1', token: 'sk-a' }, { id: 'acc-2', token: 'sk-b' },
    ])
    const fetcher = scriptedFetcher([{ status: 402, body: 'quota exhausted' }])
    await expect(collect(makeAdapter({ pool, fetcher })))
      .rejects.toMatchObject({ code: 'QUOTA_EXCEEDED' })
  })

  it('全部账号 401（无标记，无从等待）时直接报 AUTH', async () => {
    process.env.ALL_PROXY_SENSENOVA_ROTATE_BUDGET_MS = '3000'
    const { pool, marked } = failoverPool([
      { id: 'acc-1', token: 'sk-a' }, { id: 'acc-2', token: 'sk-b' },
    ])
    const fetcher = scriptedFetcher([{ status: 401, body: 'invalid api key' }])
    await expect(collect(makeAdapter({ pool, fetcher })))
      .rejects.toMatchObject({ code: 'AUTH' })
    expect(marked).toHaveLength(0)
  })

  it('HTTP 400 无额度文案时不换号（与账号无关的请求错误）', async () => {
    const { pool, pickedCalls } = failoverPool([{ id: 'acc-1', token: 'sk-a' }, { id: 'acc-2', token: 'sk-b' }])
    const fetcher = scriptedFetcher([{ status: 400, body: 'bad request' }])
    await expect(collect(makeAdapter({ pool, fetcher }))).rejects.toThrow(/bad request/)
    // 只发了一次、没有取下一个号。
    expect(pickedCalls()).toBe(1)
  })

  it('5xx 与账号无关，原样抛出（不换号）', async () => {
    const { pool, pickedCalls } = failoverPool([{ id: 'acc-1', token: 'sk-a' }, { id: 'acc-2', token: 'sk-b' }])
    const fetcher = scriptedFetcher([{ status: 500, body: 'server error' }])
    await expect(collect(makeAdapter({ pool, fetcher }))).rejects.toMatchObject({ code: 'SERVER' })
    expect(pickedCalls()).toBe(1)
  })

  it('无账号池时用 resolveCredential 走单凭据路径', async () => {
    const sent: string[] = []
    const fetcher = scriptedFetcher([{ sse: true }], sent)
    await collect(makeAdapter({ fetcher }))
    expect(sent).toEqual(['Bearer sk-primary'])
  })

  it('没有任何账号时抛 MISSING_CREDENTIAL', async () => {
    const { pool } = failoverPool([])
    await expect(collect(makeAdapter({ pool })))
      .rejects.toMatchObject({ code: 'MISSING_CREDENTIAL' })
  })

  it('凭据缺 key 时抛 MISSING_CREDENTIAL（不静默发空 Bearer）', async () => {
    await expect(collect(makeAdapter({ credential: { access_token: '' } })))
      .rejects.toMatchObject({ code: 'MISSING_CREDENTIAL' })
  })
})

describe('SensenovaAdapter 图片判定', () => {
  it('不支持图片的模型（kimi-k3）收到图片时报错', async () => {
    const fetcher = scriptedFetcher([{ sse: true }])
    await expect(collect(makeAdapter({ fetcher }), {
      messages: [{ role: 'user', content: [{ type: 'image', attachment: { attachmentId: 'a1' } }] }],
    })).rejects.toMatchObject({ code: 'UNSUPPORTED_CONTENT' })
  })

  it('支持图片的模型（sensenova-6.8-flash-lite）需要附件服务', async () => {
    const fetcher = scriptedFetcher([{ sse: true }])
    await expect(collect(makeAdapter({ fetcher }), {
      model: 'sensenova-6.8-flash-lite',
      messages: [{ role: 'user', content: [{ type: 'image', attachment: { attachmentId: 'a1' } }] }],
    })).rejects.toThrow(/附件服务/)
  })
})
