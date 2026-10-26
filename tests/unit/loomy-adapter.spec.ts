import { describe, expect, it, vi } from 'vitest'
import { credentialRef } from '../../src/providers/credential-ref.js'
import { LoomyAdapter, fetchLoomyRemoteModels, parseLoomyRemoteModels } from '../../src/providers/loomy-adapter.js'
import { currentAccountIdFor } from '../../src/providers/current-account.js'
import type { LoomyCredential } from '../../src/providers/loomy.js'
import { LOOMY } from '../../src/providers/loomy-product.js'

const CRED: LoomyCredential = {
  access_token: 'S'.repeat(32), userid: 'u1', phone: '13011112222',
}

/** 实测的远端模型条目（2026-09-26 GET /api/v1/models 的真实形状）。 */
function remoteEntry(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'MiniMax-M3',
    name: 'MiniMax M3 （x4.0）',
    object: 'model',
    type: 'chat',
    protocol: 'openai_chat',
    context_length: 1_048_576,
    max_output_tokens: 512_000,
    capabilities: {
      reasoning: true, vision: true, function_calling: true,
      input_modalities: ['text', 'image', 'video'], output_modalities: ['text'],
    },
    ...over,
  }
}

function makeAdapter(over: Partial<ConstructorParameters<typeof LoomyAdapter>[0]> = {}) {
  return new LoomyAdapter({
    credentialRef: credentialRef('LOOMY_ACCOUNT_TEST'),
    resolveCredential: async () => CRED,
    refresh: async () => {},
    ...over,
  })
}

describe('parseLoomyRemoteModels', () => {
  it('只保留 type=chat，并把倍率规范化进 name', () => {
    const models = parseLoomyRemoteModels({
      object: 'list',
      data: [
        remoteEntry(),
        remoteEntry({ id: 'Hy-Image-3.5-preview', name: 'Hy image 3.5 preview', type: 'image' }),
      ],
    })
    expect(models).toHaveLength(1)
    expect(models[0]!.id).toBe('MiniMax-M3')
    expect(models[0]!.name).toBe('MiniMax M3 · x4.0')
    expect(models[0]!.contextWindow).toBe(1_048_576)
    expect(models[0]!.supportsImage).toBe(true)
    expect(models[0]!.supportsThinking).toBe(true)
  })

  it('接受裸数组与 {data:[]} 两种形态', () => {
    expect(parseLoomyRemoteModels([remoteEntry()])).toHaveLength(1)
    expect(parseLoomyRemoteModels({ data: [remoteEntry()] })).toHaveLength(1)
  })

  it('畸形输入返回空数组（不抛）', () => {
    expect(parseLoomyRemoteModels(null)).toEqual([])
    expect(parseLoomyRemoteModels('x')).toEqual([])
    expect(parseLoomyRemoteModels({ data: 'x' })).toEqual([])
  })

  it('input_modalities 不含 image 时 supportsImage 为 false', () => {
    const models = parseLoomyRemoteModels({
      data: [remoteEntry({
        id: 'deepseek-v4-flash-0731',
        name: 'DeepSeek V4 Flash 0731（x3.0）',
        capabilities: { reasoning: true, input_modalities: ['text'] },
      })],
    })
    expect(models[0]!.supportsImage).toBe(false)
  })
})

describe('LoomyAdapter.listModels', () => {
  it('远端可用时用远端（带倍率）', async () => {
    const adapter = makeAdapter({
      fetchRemoteModels: async () => parseLoomyRemoteModels({
        data: [remoteEntry(), remoteEntry({ id: 'spark-x', name: 'Spark X2.5（x0.1）' })],
      }),
    })
    const models = await adapter.listModels('loomy')
    expect(models).toHaveLength(2)
    expect(models[0]!.provider).toBe('loomy')
    expect(models[0]!.name).toBe('MiniMax M3 · x4.0')
  })

  it('远端失败时回退兜底表（8 个，兜底表名已含倍率）', async () => {
    const adapter = makeAdapter({ fetchRemoteModels: async () => { throw new Error('boom') } })
    const models = await adapter.listModels('loomy')
    expect(models).toHaveLength(8)
    expect(models.map((m) => m.id)).toContain('qwen3.8-flash')
  })

  it('无账号池时目录可见（headless/单测保守放行）', async () => {
    const adapter = makeAdapter()
    expect((await adapter.listModels('loomy')).length).toBeGreaterThan(0)
  })

  it('**目录门控已移除**：有账号池但未登录也返回完整目录（本项目刻意分叉）', async () => {
    // ⚠️ 与来源不同：本项目是独立服务，可见性由 GET /v1/models 与三层模型开关
    // 决定，硬拦截在网关的 ModelResolver（见 divergence-gating.spec.ts）。
    const adapter = makeAdapter({
      accountPool: {
        disabledModelsFor: () => new Set<string>(),
        hasLoggedInAccount: async () => false,
      } as never,
    })
    expect((await adapter.listModels('loomy')).length).toBeGreaterThan(0)
  })

  it('黑名单里的模型被过滤', async () => {
    const adapter = makeAdapter({
      accountPool: {
        disabledModelsFor: () => new Set(['spark-x']),
        hasLoggedInAccount: async () => true,
      } as never,
    })
    const ids = (await adapter.listModels('loomy')).map((m) => m.id)
    expect(ids).not.toContain('spark-x')
    expect(ids.length).toBe(7)
  })
})

describe('LoomyAdapter.listAllModels', () => {
  it('不套黑名单，且带最终展示名', () => {
    const adapter = makeAdapter({
      accountPool: {
        disabledModelsFor: () => new Set(['spark-x']),
        hasLoggedInAccount: async () => true,
      } as never,
    })
    const all = adapter.listAllModels()
    // 被关闭的 spark-x 也必须出现（否则用户无法重新打开）
    expect(all.map((m) => m.id)).toContain('spark-x')
    expect(all.find((m) => m.id === 'spark-x')!.name).toBe('Spark X2.5 · x0.1')
  })
})

describe('LoomyAdapter.resolveModel', () => {
  it('name 不带倍率（价格只属于选择列表语境）', async () => {
    const adapter = makeAdapter()
    const resolved = await adapter.resolveModel('loomy', 'spark-x')
    expect(resolved.name).toBe('Spark X2.5')
    expect(resolved.context?.contextWindow).toBe(1_048_576)
  })

  it('未知模型不编造 context', async () => {
    const adapter = makeAdapter()
    const resolved = await adapter.resolveModel('loomy', 'nope')
    expect(resolved.context).toBeUndefined()
  })
})

describe('LoomyAdapter.providerInfo', () => {
  it('返回产品 id 与展示名', () => {
    expect(makeAdapter().providerInfo('loomy')).toEqual({ id: 'loomy', name: 'Loomy (讯飞)' })
  })

  it('provider 非法时回退到产品 id（避免 undefined.toUpperCase 崩）', () => {
    expect(makeAdapter().providerInfo(undefined as never).id).toBe('loomy')
  })
})

/**
 * 出站请求体保真（真实缺陷回归，2026-09-29）。
 *
 * ## 真实故障
 *
 * 用户报障「访问 loomy/qwen-3.8-max 输入一直不变」：28 次请求的
 * `prompt_tokens` 逐字节恒定在 20617、`cache_read` 恒为 20480，而输出每次都变。
 * 根因是**发给上游的请求体每轮都相同** —— 客户端的工具调用历史在序列化时被
 * 整段丢弃，模型永远看不到自己上一轮做过什么，只能重复发起同一个调用。
 *
 * 两处成因（都是标准 OpenAI 入站形态）：
 * 1. assistant 的顶层 `tool_calls` 不被读取（只找 content 数组里的 `tool-call` 块）；
 * 2. 蛇形 `tool_call_id` 不被读取（只认驼峰 `toolCallId`）→ 配对全灭 →
 *    `resolveToolPairing` 把 `tool_calls` 与工具结果成对剔除。
 *
 * 本组断言落在**真实发往上游的 body** 上 —— 只有这一层能证明历史真的没丢。
 */
describe('LoomyAdapter 出站请求体保真', () => {
  /** 用假 fetch 驱动 stream，返回捕获到的出站 body。 */
  async function captureBody(messages: Array<Record<string, unknown>>): Promise<Record<string, unknown>> {
    const bodies: string[] = []
    const sse = 'data: {"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n'
    const adapter = makeAdapter({
      fetchImpl: (async (_url: unknown, init?: RequestInit) => {
        bodies.push(String(init?.body ?? ''))
        return new Response(sse, { status: 200, headers: { 'Content-Type': 'text/event-stream' } })
      }) as unknown as typeof fetch,
    })
    for await (const _chunk of adapter.stream({
      provider: 'loomy',
      model: 'qwen-3.8-max',
      messages: messages as never,
    } as never)) { /* 跑完即可 */ }
    return JSON.parse(bodies[0]!) as Record<string, unknown>
  }

  it('把标准 OpenAI 形态的工具往返下发到上游（不再整段丢失）', async () => {
    const body = await captureBody([
      { role: 'system', content: 'SYS' },
      { role: 'user', content: '读文件' },
      {
        role: 'assistant',
        content: null,
        tool_calls: [
          { id: 'call_1', type: 'function', function: { name: 'read', arguments: '{"p":"a.ts"}' } },
        ],
      },
      { role: 'tool', tool_call_id: 'call_1', content: 'FILE A' },
      { role: 'user', content: '继续' },
    ])

    const outbound = body['messages'] as Array<Record<string, unknown>>
    // 1) assistant 的工具调用必须在 wire 上（这正是「输入恒定」的直接原因）。
    const assistant = outbound.find(m => m['role'] === 'assistant')!
    expect(assistant['tool_calls']).toEqual([
      { id: 'call_1', type: 'function', function: { name: 'read', arguments: '{"p":"a.ts"}' } },
    ])
    // 2) 工具结果必须在，且 id 与调用一致（配对成立）。
    const tool = outbound.find(m => m['role'] === 'tool')!
    expect(tool).toMatchObject({ tool_call_id: 'call_1', content: 'FILE A' })
  })

  it('保留 assistant 的字符串正文历史（纯文本会话也受影响）', async () => {
    const body = await captureBody([
      { role: 'system', content: 'SYS' },
      { role: 'user', content: 'Q1' },
      { role: 'assistant', content: 'A1' },
      { role: 'user', content: 'Q2' },
    ])
    const outbound = body['messages'] as Array<Record<string, unknown>>
    const assistant = outbound.find(m => m['role'] === 'assistant')!
    // 早期实现会把它序列化成空串，模型看不到自己说过什么。
    expect(assistant['content']).toBe('A1')
  })

  it('多轮工具历史逐轮增长（锁死「输入恒定」这一症状）', async () => {
    /** 构造含 n 轮工具往返的历史。 */
    const historyAt = (rounds: number): Array<Record<string, unknown>> => {
      const messages: Array<Record<string, unknown>> = [
        { role: 'system', content: 'SYS' },
        { role: 'user', content: '任务' },
      ]
      for (let i = 0; i < rounds; i++) {
        messages.push({
          role: 'assistant',
          content: null,
          tool_calls: [
            { id: `call_${i}`, type: 'function', function: { name: 'read', arguments: `{"f":"f${i}"}` } },
          ],
        })
        messages.push({ role: 'tool', tool_call_id: `call_${i}`, content: `结果${i}` })
      }
      return messages
    }

    const wireLengths: number[] = []
    for (const rounds of [1, 2, 3]) {
      const body = await captureBody(historyAt(rounds))
      wireLengths.push(JSON.stringify(body['messages']).length)
    }
    // 严格递增：历史真的在累积，而不是每轮都发同一个前缀。
    expect(wireLengths[1]!).toBeGreaterThan(wireLengths[0]!)
    expect(wireLengths[2]!).toBeGreaterThan(wireLengths[1]!)
  })
})

/**
 * 请求级换号（真实缺陷回归，2026-09-29 用户报障）。
 *
 * ## 真实故障
 *
 * 账号按手动顺序选取：账号 1 积分为 0 排在首位，每次请求都被选中并失败
 * （上游 400「积分余额不足，请获取积分后再试」），永远轮不到有积分的账号 2。
 * 现在账号级失败会写标记并换下一个账号，试完所有候选才报错。
 */
describe('LoomyAdapter 请求级换号', () => {
  const OK_SSE = 'data: {"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n'

  /** 造一个换号用的账号池替身：记录标记调用，按脚本吐出「下一个账号」。 */
  function failoverPool(script: {
    initialId?: string
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
          credential: { access_token: `tok-${item.id}`, userid: item.id, phone: '13000000000' },
        }
      },
      updateModelRateLimit: async (accountId: string, modelId: string, resetAtMs: number) => {
        marked.push({ accountId, modelId, resetAtMs })
      },
      resolveCredentialForAccount: async (id: string) => ({ access_token: `tok-${id}`, userid: id, phone: '13000000000' }),
    }
    return { pool: pool as unknown as import('../../src/pool/account-pool.js').AccountPool, marked, pickedCalls: () => pickedCalls }
  }

  it('HTTP 400 + 「积分余额不足」时换下一个账号，并把失败账号标记到 UTC+8 当日 24:00', async () => {
    const { pool, marked } = failoverPool({ initialId: 'acc-1', next: [{ id: 'acc-2' }] })
    const sent: string[] = []
    let call = 0
    const fetchImpl = (async (_url: unknown, init?: RequestInit) => {
      sent.push(String((init?.headers as Record<string, string>)?.Authorization ?? ''))
      call++
      if (call === 1) return new Response('积分余额不足，请获取积分后再试', { status: 400 })
      return new Response(OK_SSE, { status: 200, headers: { 'Content-Type': 'text/event-stream' } })
    }) as unknown as typeof fetch
    const adapter = makeAdapter({ accountPool: pool, fetchImpl })
    const chunks: unknown[] = []
    for await (const chunk of adapter.stream({
      provider: 'loomy', model: 'qwen-3.8-max',
      messages: [{ role: 'user', content: 'hi' }],
    } as never)) chunks.push(chunk)
    // 第二次请求带的是换上的账号的 token。
    expect(sent[1]).toBe('Bearer tok-acc-2')
    expect(chunks.length).toBeGreaterThan(0)
    // 失败账号被标记为额度耗尽（当天锁），选号自动跳过。
    expect(marked).toHaveLength(1)
    expect(marked[0]).toMatchObject({ accountId: 'acc-1', modelId: 'qwen-3.8-max' })
    // UTC+8 零点 = UTC 16:00：平移 8 小时后应与自然日界对齐。
    expect((marked[0]!.resetAtMs + 8 * 3_600_000) % 86_400_000).toBe(0)
    // 用量归属与定向续期指向实际用上的账号。
    expect(currentAccountIdFor('loomy')).toBe('acc-2')
  })

  it('HTTP 429 时写入短冷却标记并换号', async () => {
    const { pool, marked } = failoverPool({ initialId: 'acc-1', next: [{ id: 'acc-2' }] })
    let call = 0
    const fetchImpl = (async () => {
      call++
      if (call === 1) return new Response('too many requests', { status: 429 })
      return new Response(OK_SSE, { status: 200, headers: { 'Content-Type': 'text/event-stream' } })
    }) as unknown as typeof fetch
    const before = Date.now()
    const adapter = makeAdapter({ accountPool: pool, fetchImpl })
    for await (const _chunk of adapter.stream({
      provider: 'loomy', model: 'qwen-3.8-max',
      messages: [{ role: 'user', content: 'hi' }],
    } as never)) { /* 跑完即可 */ }
    expect(marked).toHaveLength(1)
    expect(marked[0]!.resetAtMs).toBeGreaterThan(before + 25_000)
    expect(marked[0]!.resetAtMs).toBeLessThanOrEqual(Date.now() + 35_000)
  })

  it('所有账号都额度不足时报 QUOTA_EXCEEDED（试完全部候选才下结论）', async () => {
    const { pool, pickedCalls } = failoverPool({ initialId: 'acc-1', next: [{ id: 'acc-2' }, null] })
    const fetchImpl = (async () => new Response('积分余额不足，请获取积分后再试', { status: 400 })) as unknown as typeof fetch
    const adapter = makeAdapter({ accountPool: pool, fetchImpl })
    await expect((async () => {
      for await (const _chunk of adapter.stream({
        provider: 'loomy', model: 'qwen-3.8-max',
        messages: [{ role: 'user', content: 'hi' }],
      } as never)) { /* 必然抛错 */ }
    })()).rejects.toMatchObject({ code: 'QUOTA_EXCEEDED' })
    expect(pickedCalls()).toBe(2)
  })

  it('HTTP 400 无额度文案时不换号（与账号无关的请求错误）', async () => {
    const { pool, pickedCalls } = failoverPool({ initialId: 'acc-1', next: [{ id: 'acc-2' }] })
    const fetchImpl = (async () => new Response('bad request', { status: 400 })) as unknown as typeof fetch
    const adapter = makeAdapter({ accountPool: pool, fetchImpl })
    await expect((async () => {
      for await (const _chunk of adapter.stream({
        provider: 'loomy', model: 'qwen-3.8-max',
        messages: [{ role: 'user', content: 'hi' }],
      } as never)) { /* 必然抛错 */ }
    })()).rejects.toThrow(/bad request/)
    expect(pickedCalls()).toBe(0)
  })

  it('无账号池时保持单账号行为（额度错误原样抛出）', async () => {
    const fetchImpl = (async () => new Response('积分余额不足', { status: 400 })) as unknown as typeof fetch
    const adapter = makeAdapter({ fetchImpl })
    await expect((async () => {
      for await (const _chunk of adapter.stream({
        provider: 'loomy', model: 'qwen-3.8-max',
        messages: [{ role: 'user', content: 'hi' }],
      } as never)) { /* 必然抛错 */ }
    })()).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
  })
})

/**
 * `fetchLoomyRemoteModels` —— Loomy 的远端目录拉取（2026-10-23 新接线）。
 *
 * ## 它补的是什么缺陷
 *
 * 此前 Loomy **从未接过远端目录**：`wiring.ts` 注册适配器时没传
 * `fetchRemoteModels`，`loadModels()` 永远走 `loomy-product.ts` 里
 * 2026-09-26 写死的 8 条兜底表。上游后来上架的 `spark-x2.6` / `auto`
 * 一律看不到，而点「刷新模型目录」还会得到**误导性**的
 * 「远端未返回目录，仍显示本地缓存」—— 不是远端挂了，而是根本没有远端请求。
 *
 * 与 CodeArts 漏接 `glm-5.3`、Raccoon 漏接 `sn-deepseek-v4-1-flash-1017`
 * 是同一类缺陷（这是第 4 次重演），故用测试锁死接线本身。
 */
describe('fetchLoomyRemoteModels', () => {
  it('打到 {apiBase}/models 且**只发 token 头**（不能带 Authorization）', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = []
    const fetcher = vi.fn(async (url: string, init: RequestInit) => {
      calls.push({ url, init })
      return new Response(JSON.stringify({ data: [remoteEntry()] }), { status: 200 })
    }) as unknown as typeof fetch

    const models = await fetchLoomyRemoteModels(CRED, LOOMY, fetcher)
    expect(models.map((m) => m.id)).toEqual(['MiniMax-M3'])

    expect(calls).toHaveLength(1)
    expect(calls[0]!.url).toBe(`${LOOMY.apiBase}/models`)
    const headers = calls[0]!.init.headers as Record<string, string>
    // `/models` 只认小写 token 头；带 Authorization 会被判「缺少 token」。
    expect(headers['token']).toBe(CRED.access_token)
    expect(headers['Authorization']).toBeUndefined()
  })

  it('非 2xx 抛错（交由 fetchRemoteCatalog 转成失败冷却 + 回退快照）', async () => {
    const fetcher = (async () => new Response('', { status: 401 })) as unknown as typeof fetch
    await expect(fetchLoomyRemoteModels(CRED, LOOMY, fetcher)).rejects.toThrow(/HTTP 401/)
  })

  it('远端返回空目录时抛错（不把空表当成功，否则会把兜底表覆盖成空）', async () => {
    const fetcher = (async () => new Response(JSON.stringify({ data: [] }), { status: 200 })) as unknown as typeof fetch
    await expect(fetchLoomyRemoteModels(CRED, LOOMY, fetcher)).rejects.toThrow(/为空/)
  })

  it('只保留 type=chat（生图等多模态条目不算对话模型）', async () => {
    const fetcher = (async () => new Response(JSON.stringify({
      data: [
        remoteEntry({ id: 'chat-model', type: 'chat' }),
        remoteEntry({ id: 'image-model', type: 'image' }),
      ],
    }), { status: 200 })) as unknown as typeof fetch
    const models = await fetchLoomyRemoteModels(CRED, LOOMY, fetcher)
    expect(models.map((m) => m.id)).toEqual(['chat-model'])
  })

  it('适配器接上 fetchRemoteModels 后播报远端目录（含兜底表没有的新模型）', async () => {
    const adapter = makeAdapter({
      fetchRemoteModels: async () => [
        { id: 'spark-x2.6', name: 'Spark-X2.6 · x0.0', contextWindow: 1_048_576, supportsImage: false, supportsThinking: true },
        { id: 'auto', name: '自动 · 均衡', contextWindow: 0, supportsImage: false, supportsThinking: false },
      ],
    })
    const listed = await adapter.listModels('loomy')
    expect(listed.map((m) => m.id)).toEqual(['spark-x2.6', 'auto'])
  })

  it('远端失败时仍回退兜底表（目录读不到不该让 provider 报错）', async () => {
    const adapter = makeAdapter({
      fetchRemoteModels: async () => { throw new Error('network down') },
    })
    const listed = await adapter.listModels('loomy')
    expect(listed.length).toBeGreaterThan(0)
  })
})
