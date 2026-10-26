import { describe, expect, it } from 'vitest'
import type { GenerateOptions, StreamChunk } from '../../src/shared/llm.js'
import { LoomyAdapter, LOOMY_REASONING_EFFORTS } from '../../src/providers/loomy-adapter.js'
import { RaccoonAdapter, RACCOON_REASONING_EFFORTS } from '../../src/providers/raccoon-adapter.js'
import { SensenovaAdapter, SENSENOVA_REASONING_EFFORTS } from '../../src/providers/sensenova-adapter.js'
import { OfficeAceAdapter, OFFICEACE_REASONING_EFFORTS } from '../../src/providers/officeace-adapter.js'
import type { LoomyCredential } from '../../src/providers/loomy.js'
import type { RaccoonCredential } from '../../src/providers/raccoon.js'
import type { SensenovaCredential } from '../../src/providers/sensenova.js'
import type { OfficeAceCredential } from '../../src/providers/officeace-auth.js'

/**
 * 思考等级（`reasoning_effort`）透传。
 *
 * ## 为什么每个 provider 都要单独验一遍
 *
 * 这四个适配器此前**整段丢弃**该参数（`grep reasoningEffort` 零命中），
 * 于是「用户选了 max、实际按默认档跑」且日志与用量都看不出来 —— 记录的是
 * **入参**（网关如实记下 max），不是上游实际生效的档位，两者分叉时无声无息。
 *
 * ## 白名单不是洁癖，是硬需求
 *
 * 四个上游的合法取值**各不相同**，且非法值一律 400（不是忽略）：
 *
 * | provider | 合法档位 | 依据 |
 * |---|---|---|
 * | sensenova | none/minimal/low/medium/high/xhigh/max/**ultra** | 上游报错文案 |
 * | officeace | none/minimal/low/medium/high/xhigh/max（**无 ultra**） | 上游报错文案 |
 * | raccoon   | **仅 low/high/max** | 上游报错文案 |
 * | loomy     | low/medium/high/max/xhigh（无 minimal/none） | 上游报错文案 |
 *
 * 故白名单外的值必须**静默丢弃**：档位不是请求的必要条件，为它把整条请求打成
 * 400 是明确的优先级倒置。
 */

/** 最小可用 SSE（一个正文块 + 结束）。 */
function sseResponse(): Response {
  const frames = [
    JSON.stringify({ choices: [{ delta: { content: 'ok' }, finish_reason: 'stop' }] }),
  ]
  return new Response(frames.map(f => `data: ${f}\n\n`).join('') + 'data: [DONE]\n\n', {
    status: 200,
    headers: { 'Content-Type': 'text/event-stream' },
  })
}

/**
 * 起一个会捕获请求体的 fetch。
 *
 * @returns 捕获数组：每次请求的 `body` 解析结果。
 */
function capturingFetch(): { fetcher: typeof fetch; bodies: Record<string, unknown>[] } {
  const bodies: Record<string, unknown>[] = []
  const fetcher = (async (_url: unknown, init?: RequestInit) => {
    bodies.push(JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>)
    return sseResponse()
  }) as unknown as typeof fetch
  return { fetcher, bodies }
}

/** 把适配器的一次调用跑完（吃掉整条流，确保请求已发出）。 */
async function drain(iterable: AsyncIterable<StreamChunk>): Promise<void> {
  for await (const _chunk of iterable) { /* 消费即可 */ }
}

/** 构造一次 generate 调用。 */
function options(patch: Partial<GenerateOptions>): GenerateOptions {
  return {
    provider: 'x',
    model: 'm',
    messages: [{ role: 'user', content: 'hi' }],
    ...patch,
  } as GenerateOptions
}

// ───────────────────────── loomy ─────────────────────────

describe('loomy 的思考等级透传', () => {
  const cred: LoomyCredential = { access_token: 'tok', userid: 'u', phone: 'p' } as LoomyCredential

  function make(fetcher: typeof fetch): LoomyAdapter {
    return new LoomyAdapter({
      resolveCredential: async () => cred,
      refresh: async () => {},
      fetchRemoteModels: async () => [],
      fetchImpl: fetcher,
    })
  }

  it('白名单与上游一致（无 minimal / none / ultra）', () => {
    expect([...LOOMY_REASONING_EFFORTS].sort()).toEqual(['high', 'low', 'max', 'medium', 'xhigh'])
  })

  it('显式传入的档位真的进了请求体', async () => {
    const { fetcher, bodies } = capturingFetch()
    await drain(make(fetcher).stream(options({ model: 'DeepSeek-V4.1-Flash', reasoningEffort: 'high' as never })))
    expect(bodies[0]!['reasoning_effort']).toBe('high')
  })

  it('xhigh 归一成 max（与参考实现 loomy-gateway.js 一致）', async () => {
    const { fetcher, bodies } = capturingFetch()
    await drain(make(fetcher).stream(options({ model: 'DeepSeek-V4.1-Flash', reasoningEffort: 'xhigh' as never })))
    expect(bodies[0]!['reasoning_effort']).toBe('max')
  })

  it('白名单外的档位被丢弃（不炸成 400），其余字段照常', async () => {
    const { fetcher, bodies } = capturingFetch()
    await drain(make(fetcher).stream(options({ model: 'DeepSeek-V4.1-Flash', reasoningEffort: 'ultra' as never, temperature: 0.3 })))
    expect(bodies[0]).not.toHaveProperty('reasoning_effort')
    expect(bodies[0]!['temperature']).toBe(0.3)
  })

  it('未指定时不发该字段（不臆造默认档）', async () => {
    const { fetcher, bodies } = capturingFetch()
    await drain(make(fetcher).stream(options({ model: 'DeepSeek-V4.1-Flash' })))
    expect(bodies[0]).not.toHaveProperty('reasoning_effort')
  })
})

// ───────────────────────── sensenova ─────────────────────────

describe('sensenova 的思考等级透传', () => {
  const cred: SensenovaCredential = { access_token: 'sk-test' } as SensenovaCredential

  function make(fetcher: typeof fetch): SensenovaAdapter {
    return new SensenovaAdapter({
      resolveCredential: async () => cred,
      refresh: async () => {},
      fetchRemoteModels: async () => [],
      fetchImpl: fetcher,
    })
  }

  it('白名单含 ultra、不含 none-prefixed 之外的臆造值', () => {
    expect(SENSENOVA_REASONING_EFFORTS.has('ultra')).toBe(true)
    expect(SENSENOVA_REASONING_EFFORTS.has('none')).toBe(true)
    expect(SENSENOVA_REASONING_EFFORTS.has('bogus')).toBe(false)
  })

  it('透传 high / max / ultra', async () => {
    for (const level of ['high', 'max', 'ultra']) {
      const { fetcher, bodies } = capturingFetch()
      await drain(make(fetcher).stream(options({ model: 'deepseek-flash', reasoningEffort: level as never })))
      expect(bodies[0]!['reasoning_effort']).toBe(level)
    }
  })

  it('白名单外丢弃，且 stream_options 等既有字段不受影响', async () => {
    const { fetcher, bodies } = capturingFetch()
    await drain(make(fetcher).stream(options({ model: 'deepseek-flash', reasoningEffort: 'bogus' as never })))
    expect(bodies[0]).not.toHaveProperty('reasoning_effort')
    // 回归：include_usage 是独立缺陷的修复，不能被本次改动带掉。
    expect(bodies[0]!['stream_options']).toEqual({ include_usage: true })
  })
})

// ───────────────────────── raccoon ─────────────────────────

describe('raccoon 的思考等级透传', () => {
  const cred: RaccoonCredential = { access_token: 'tok', refresh_token: 'r' }

  function make(fetcher: typeof fetch): RaccoonAdapter {
    return new RaccoonAdapter({
      resolveCredential: async () => cred,
      refresh: async () => {},
      fetchRemoteModels: async () => [],
      fetchImpl: fetcher,
    })
  }

  it('白名单**只有三档**（上游原文：must be one of low, high, or max）', () => {
    expect([...RACCOON_REASONING_EFFORTS].sort()).toEqual(['high', 'low', 'max'])
  })

  it('透传 low / high / max', async () => {
    for (const level of ['low', 'high', 'max']) {
      const { fetcher, bodies } = capturingFetch()
      await drain(make(fetcher).stream(options({ model: 'sn-glm-5-3', reasoningEffort: level as never })))
      expect(bodies[0]!['reasoning_effort']).toBe(level)
    }
  })

  it('medium / xhigh 被丢弃（上游会 400，故不能照发）', async () => {
    for (const level of ['medium', 'xhigh']) {
      const { fetcher, bodies } = capturingFetch()
      await drain(make(fetcher).stream(options({ model: 'sn-glm-5-3', reasoningEffort: level as never })))
      expect(bodies[0]).not.toHaveProperty('reasoning_effort')
    }
  })
})

// ───────────────────────── officeace ─────────────────────────

describe('officeace 的思考等级透传', () => {
  const cred: OfficeAceCredential = {
    modelAppKey: 'k',
    modelAppSecret: 's',
    maasBaseUrl: 'https://maas.example.invalid',
    access: 'a',
    secret: 's',
    securityToken: 'st',
    projectId: 'p',
    expiresAt: Date.now() + 3_600_000,
    refreshToken: 'r',
    dpopPrivateJwk: {} as never,
    accountId: 'acc',
  } as OfficeAceCredential

  function make(fetcher: typeof fetch): OfficeAceAdapter {
    return new OfficeAceAdapter({
      resolveCredential: async () => cred,
      refresh: async () => {},
      fetchRemoteModels: async () => [],
      fetchImpl: fetcher,
    } as never)
  }

  it('白名单**不含 ultra**（同属商汤系但能力表与 sensenova 不同）', () => {
    expect(OFFICEACE_REASONING_EFFORTS.has('ultra')).toBe(false)
    expect(OFFICEACE_REASONING_EFFORTS.has('xhigh')).toBe(true)
    expect(OFFICEACE_REASONING_EFFORTS.has('none')).toBe(true)
  })

  it('透传 high / max', async () => {
    for (const level of ['high', 'max']) {
      const { fetcher, bodies } = capturingFetch()
      await drain(make(fetcher).stream(options({ model: 'glm-5.3', maxTokens: 8192, reasoningEffort: level as never })))
      expect(bodies[0]!['reasoning_effort']).toBe(level)
    }
  })

  it('白名单外丢弃，且 max_tokens 下限保护不受影响', async () => {
    const { fetcher, bodies } = capturingFetch()
    // max_tokens=100 < 4096 ⇒ 必须被丢掉（既有约束），档位越界同样丢弃。
    await drain(make(fetcher).stream(options({ model: 'glm-5.3', maxTokens: 100, reasoningEffort: 'ultra' as never })))
    expect(bodies[0]).not.toHaveProperty('reasoning_effort')
    expect(bodies[0]).not.toHaveProperty('max_tokens')
  })
})
