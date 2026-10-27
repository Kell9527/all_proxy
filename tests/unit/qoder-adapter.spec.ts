import { describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import {
  QoderAdapter,
  QODER_QUEUE_MAX_ATTEMPTS,
  DEFAULT_QUEUE_TIMEOUT_MS,
  nextUtc8DayStartMs,
  parseQoderQueueError,
  qoderQueueDelayMs,
  resolveQueueTimeoutMs,
} from '../../src/providers/qoder-adapter.js'
import { QODER } from '../../src/providers/qoder-product.js'
import { buildQoderCredential, parseQoderTokenPayload, type QoderCredential } from '../../src/providers/qoder.js'

/** 源码级断言的路径基准（与 `jet-hub-rpc.spec.ts` 同款）。 */
const here = dirname(fileURLToPath(import.meta.url))

const cred: QoderCredential = buildQoderCredential(
  // ⚠️ `uid` 是**加密推理必需**的（`generate_runtime_auth_fields` 用它派生
  // `encrypt_user_info`）；缺了 WASM 会挂起。真实值来自设备码响应的 `user_id`。
  parseQoderTokenPayload({ token: 'tok', refresh_token: 'ref', user_id: 'uid-1' }),
  { machineId: 'm-1' })

/** 构造适配器（默认注入可用凭据与 noop refresh）。 */
function makeAdapter(overrides: Partial<ConstructorParameters<typeof QoderAdapter>[0]> = {}): QoderAdapter {
  return new QoderAdapter({
    credentialRef: { name: 'QODER_ACCESS_TOKEN' } as never,
    resolveCredential: async () => cred,
    refresh: async () => {},
    product: QODER,
    ...overrides,
  })
}

/** 一段标准 OpenAI 正文帧。 */
function textFrame(text: string): string {
  return JSON.stringify({ choices: [{ delta: { content: text }, index: 0 }] })
}

/** 一段标准 OpenAI 结束帧。 */
const finishFrame = JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })

/**
 * 构造**加密端点风格**的信封 SSE 响应。
 *
 * 真实形态（实测）：每帧多一层 `{headers, body, statusCode}` 包装，
 * 内层 `body` 是标准 OpenAI chunk 的 **JSON 字符串**（未加密）。
 */
function envelopeResponse(frames: string[]): Response {
  const body = frames
    .map((inner) => `data:${JSON.stringify({
      headers: { 'Content-Type': ['application/json'] },
      body: inner,
      statusCodeValue: 200,
      statusCode: 'OK',
    })}\n\n`)
    .join('')
  return new Response(body, { status: 200, headers: { 'Content-Type': 'text/event-stream' } })
}

/** 收集一次 stream 的全部 chunk。 */
async function collect(adapter: QoderAdapter, model = 'auto'): Promise<Array<Record<string, unknown>>> {
  return collectWith(adapter, {
    model,
    messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
  })
}

/** 用**自定义 options** 收集一次 stream 的全部 chunk。 */
async function collectWith(
  adapter: QoderAdapter,
  options: Record<string, unknown>,
): Promise<Array<Record<string, unknown>>> {
  const out: Array<Record<string, unknown>> = []
  for await (const chunk of adapter.stream(options as never)) {
    out.push(chunk as unknown as Record<string, unknown>)
  }
  return out
}

describe('QoderAdapter 模型目录', () => {
  it('未接线远端时 listModels 用兜底表（安全默认）', async () => {
    const models = await makeAdapter().listModels('qoder')
    // ⚠️ 断言必须**内容锚定**而不是 `toBe(fallbackModels.length)`：
    // 后者在兜底表被清空时是 `0 === 0` 的同义反复（审计实测 9 passed）。
    expect(models.length).toBeGreaterThan(0)
    expect(models.some((m) => m.id === 'auto')).toBe(true)
    expect(models.some((m) => m.id === 'dmodel')).toBe(true)
    expect(models.every((m) => m.provider === 'qoder')).toBe(true)
  })

  it('listModels 应用 Jet Hub 黑名单', async () => {
    const adapter = makeAdapter({
      accountPool: { disabledModelsFor: () => new Set(['auto']) } as never,
    })
    const models = await adapter.listModels('qoder')
    expect(models.some((m) => m.id === 'auto')).toBe(false)
    expect(models.some((m) => m.id === 'dmodel')).toBe(true)
  })

  // 目录门控：没有已登录账号时不显示该 provider 的任何模型。
  // 见 `providerCatalogVisible`（src/account-pool.ts）。
  // ⚠️ 来源的「无已登录账号 → 返回空数组」目录门控**在本项目中已移除**：
  // 本项目是独立服务，可见性由 GET /v1/models 与三层模型开关决定，
  // 硬拦截发生在网关的 ModelResolver（见 divergence-gating.spec.ts）。
  // 该 describe 块整体删除，避免断言一个本项目刻意不要的行为。

  it('providerInfo 返回 qoder', () => {
    expect(makeAdapter().providerInfo('qoder')).toEqual({ id: 'qoder', name: QODER.displayName })
  })

  // 计费倍率展示（目录 `price_factor`）。
  //
  // ⚠️ **必须写进 `name`，不是 `description`**：composer 的模型切换菜单只渲染
  // `name`（ModelSelect 的 `children: model.name`），`description` 仅用于
  // `/model` 弹窗。用户报障「消耗倍率没有显示在切换模型列表的后面」。
  describe('listModels 的计费倍率', () => {
    it('price_factor=0 显示为「免费」而非 x0', async () => {
      // 实测 Qwen3.8-Flash（qfmodel）的 price_factor 正是 0。
      const models = await makeAdapter().listModels('qoder')
      const flash = models.find((m) => m.id === 'qfmodel')
      expect(flash?.name).toBe('Qwen3.8-Flash · 免费')
    })

    it('其余模型显示 x 倍率（数值对照真实 catalog）', async () => {
      const models = await makeAdapter().listModels('qoder')
      // ⚠️ 早期用例断言的是 `x0.8` / `x3.2` —— 那是兜底表的**过期估值**，
      // 真实 catalog 为 0.5 / 8（用户报障后逐条校正，见 qoder-product.spec.ts）。
      expect(models.find((m) => m.id === 'dmodel')?.name).toBe('DeepSeek-V4-Pro · x0.5')
      expect(models.find((m) => m.id === 'gfmodel')?.name).toBe('GLM-5.3-Flash · x0.1')
      expect(models.find((m) => m.id === 'smodel')?.name).toBe('Sonus · x8')
    })

    // ⚠️ 角标**不再**由目录快照 `promotion.active` 决定 —— 那是采集时刻的值，
    // 会随错峰窗口切换而失真。真实判据是 `windowStart`/`windowEnd` 的本地推算
    // （边界用例见 qoder-product.spec.ts 的「错峰时段判定」）。
    // 这里只验证**无窗口字段时的回退行为**，与当前钟点无关、恒定可复现。
    it('无窗口字段时回退到 active：false 不显示角标、用原价', async () => {
      const product = {
        ...QODER,
        fallbackModels: [{
          id: 'promo', name: 'Promo', contextWindow: 1000,
          priceFactor: 0.2,
          promotion: { active: false, discountFactor: 0.4, beforePromotionPriceFactor: 0.5, badgeZh: '错峰 4 折' },
        }],
      }
      const adapter = makeAdapter({ product: product as never })
      const models = await adapter.listModels('qoder')
      // 窗口外 → 原价、无角标（避免用户按折扣价预期却被按原价计费）
      expect(models[0]?.name).toBe('Promo · x0.5')
      expect(models[0]?.name).not.toContain('折')
    })

    it('无窗口字段时回退到 active：true 显示 原价→折后价', async () => {
      const product = {
        ...QODER,
        fallbackModels: [{
          id: 'promo', name: 'Promo', contextWindow: 1000,
          priceFactor: 0.2,
          promotion: { active: true, discountFactor: 0.4, beforePromotionPriceFactor: 0.5, badgeZh: '错峰 4 折' },
        }],
      }
      const adapter = makeAdapter({ product: product as never })
      const models = await adapter.listModels('qoder')
      // 窗口内 → `原价→折后价`（0.5→0.2），与 TRAE / buddy 同形态。
      // ⚠️ 旧形态是 `x0.2 错峰 4 折`（只有折后价 + 角标），用户要求对齐 TRAE。
      expect(models[0]?.name).toBe('Promo · x0.5→x0.2')
    })

    it('无 priceFactor 时 name 保持原样（不编造倍率）', async () => {
      const product = {
        ...QODER,
        fallbackModels: [{ id: 'unknown', name: 'Unknown', contextWindow: 1000 }],
      }
      const adapter = makeAdapter({ product: product as never })
      expect((await adapter.listModels('qoder'))[0]?.name).toBe('Unknown')
    })

    // resolveModel 的 name 用于会话中的模型显示，**不带**价格后缀
    // （价格只属于选择列表这个语境）。
    it('resolveModel 的 name 不带倍率后缀', async () => {
      expect((await makeAdapter().resolveModel('qoder', 'qfmodel')).name).toBe('Qwen3.8-Flash')
    })
  })
})

/**
 * 远端目录接线（2026-10-20 用户报障「上游 DeepSeek-Flash 已 0×，列表还显示 0.1」）。
 *
 * 守四件事：
 * 1. 远端优先（倍率/免费标记跟随上游）；
 * 2. 失败/空结果**静默回退兜底表**（菜单不能变空）；
 * 3. 20 分钟 TTL 内不重复拉；
 * 4. **能力/元数据判据取「远端 ∪ 静态表」** —— 目录按账号下发，一个只拿到
 *    少数模型的账号不能让静态表里已知的模型被判成「未知」（图片被硬拒）。
 */
describe('QoderAdapter 远端模型目录', () => {
  /** 上游响应里的 `dfmodel`（免费）与一条兜底表没有的模型。 */
  const remoteModel = (id: string, name: string, extra: Record<string, unknown> = {}) => ({
    id, name, contextWindow: 1_000_000, supportsImage: true, isFree: true, priceFactor: 0, ...extra,
  })

  it('远端优先：倍率与免费标记跟随上游', async () => {
    const adapter = makeAdapter({
      fetchRemoteModels: async () => [remoteModel('dfmodel', 'DeepSeek-Flash')],
    })
    const models = await adapter.listModels('qoder')
    expect(models.map((m) => m.id)).toEqual(['dfmodel'])
    // 兜底表里 dfmodel 的价格是 0.1；远端已免费 ⇒ 展示名必须是「免费」。
    expect(models[0]?.name).toContain('免费')
  })

  it('远端失败时静默回退兜底表，并留一条 warn 日志', async () => {
    const warnings: string[] = []
    const adapter = makeAdapter({
      fetchRemoteModels: async () => { throw new Error('目录接口挂了') },
      warn: (message) => { warnings.push(message) },
    })
    const models = await adapter.listModels('qoder')
    expect(models.length).toBeGreaterThan(0)
    expect(models.some((m) => m.id === 'dmodel')).toBe(true)
    // 回退是静默的，没有日志就没有任何证据（只剩「倍率不更新」这种无信息症状）。
    expect(warnings.join('\n')).toContain('目录接口挂了')
  })

  it('远端返回空数组同样回退兜底表（不把菜单变空）', async () => {
    const adapter = makeAdapter({ fetchRemoteModels: async () => [] })
    const models = await adapter.listModels('qoder')
    expect(models.some((m) => m.id === 'dmodel')).toBe(true)
  })

  it('TTL 内不重复拉远端（并发/连续调用只发一次）', async () => {
    let calls = 0
    const adapter = makeAdapter({
      fetchRemoteModels: async () => {
        calls += 1
        return [remoteModel('dfmodel', 'DeepSeek-Flash')]
      },
    })
    await adapter.listModels('qoder')
    await adapter.listModels('qoder')
    await adapter.resolveModel('qoder', 'dfmodel')
    expect(calls).toBe(1)
  })

  it('`refresh()` 强制重拉（无视 TTL）', async () => {
    let calls = 0
    const adapter = makeAdapter({
      fetchRemoteModels: async () => {
        calls += 1
        return [remoteModel('dfmodel', 'DeepSeek-Flash')]
      },
    })
    await adapter.listModels('qoder')
    expect(calls).toBe(1)
    await adapter.refresh()
    expect(calls).toBe(2)
  })

  it('⚠️ 能力判据取并集：远端只有少数模型时，静态表已知的模型仍保留图片能力', async () => {
    // 目录按账号下发 —— 一个免费额度号上游只给 2 条。
    const adapter = makeAdapter({
      fetchRemoteModels: async () => [remoteModel('dfmodel', 'DeepSeek-Flash')],
    })
    // 先让远端目录落地。
    await adapter.listModels('qoder')
    // `dmodel` 不在远端目录里，但静态表有它且 supportsImage=true。
    const resolved = await adapter.resolveModel('qoder', 'dmodel')
    expect(resolved.name).toBe('DeepSeek-V4-Pro')
    expect(resolved.inputModalities).toEqual(['text', 'image'])
    expect(resolved.context).toEqual({ contextWindow: 1_000_000 })
  })

  it('远端独有的模型能被 resolveModel 认识（冷缓存也要先拉目录）', async () => {
    const adapter = makeAdapter({
      fetchRemoteModels: async () => [remoteModel('fast', 'Fast', { isFree: undefined, priceFactor: 0.8 })],
    })
    // 不先调 listModels：resolveModel 自己必须先拉目录，否则名字会退化成裸 id。
    const resolved = await adapter.resolveModel('qoder', 'fast')
    expect(resolved.name).toBe('Fast')
  })
})

describe('QoderAdapter resolveModel', () => {  it('已知模型带 contextWindow 与展示名', async () => {
    // dmodel = DeepSeek-V4-Pro，实测 max_input_tokens=1000000
    const resolved = await makeAdapter().resolveModel('qoder', 'dmodel')
    expect(resolved.name).toBe('DeepSeek-V4-Pro')
    expect(resolved.context).toEqual({ contextWindow: 1_000_000 })
  })

  it('未知模型不编造 context（id 即 name）', async () => {
    const resolved = await makeAdapter().resolveModel('qoder', 'some-future-model')
    expect(resolved.name).toBe('some-future-model')
    expect(resolved.context).toBeUndefined()
  })

  it('inputModalities 按模型的 supportsImage 判定', async () => {
    const adapter = makeAdapter()
    // 实测 17 个目录模型 is_vl 全为 true
    expect((await adapter.resolveModel('qoder', 'dmodel')).inputModalities).toEqual(['text', 'image'])
    expect((await adapter.resolveModel('qoder', 'qmodel_38max')).inputModalities).toEqual(['text', 'image'])
    // 未知模型保守报 text（宁可少报能力）
    expect((await adapter.resolveModel('qoder', 'unknown-x')).inputModalities).toEqual(['text'])
  })
})

describe('QoderAdapter 请求构造（加密端点）', () => {
  it('URL 指向 api2.qoder.sh 的 agent_chat_generation（**不是** api2-v2）', async () => {
    const fetchImpl = vi.fn(async () => envelopeResponse([textFrame('hi'), finishFrame])) as unknown as typeof fetch
    await collect(makeAdapter({ fetchImpl }))
    const call = (fetchImpl as unknown as { mock: { calls: unknown[][] } }).mock.calls[0]!
    const url = String(call[0])
    // ⚠️ 加密端点与公开端点是**不同 host**：混用会 404
    expect(url.startsWith('https://api2.qoder.sh/algo/api/v2/service/pro/sse/agent_chat_generation')).toBe(true)
    expect(url).toContain('Encode=1')
    expect(url).not.toContain('api2-v2')
  })

  it('请求体是**加密**的（不是 JSON），且带 X-Model-Key 头', async () => {
    const fetchImpl = vi.fn(async () => envelopeResponse([textFrame('hi'), finishFrame])) as unknown as typeof fetch
    await collect(makeAdapter({ fetchImpl }))
    const call = (fetchImpl as unknown as { mock: { calls: unknown[][] } }).mock.calls[0]!
    const body = String((call[1] as { body: string }).body)
    // 加密体不是 JSON（朴素 JSON.parse 会失败）
    expect(() => JSON.parse(body)).toThrow()
    expect(body.length).toBeGreaterThan(0)
    // 模型 key 走独立头（服务端据此路由）
    const headers = (call[1] as { headers: Headers }).headers
    const get = (k: string): string | null => (headers instanceof Headers ? headers.get(k) : null)
    expect(get('X-Model-Key')).toBe('auto')
    expect(get('X-Model-Source')).toBe('system')
  })

  it('Authorization 是 WASM 生成的 COSY 签名，**不是**普通 Bearer token', async () => {
    // ⚠️ 用普通 `Bearer <token>` 覆盖会得到 403 Signature invalid。
    const fetchImpl = vi.fn(async () => envelopeResponse([textFrame('hi'), finishFrame])) as unknown as typeof fetch
    await collect(makeAdapter({ fetchImpl }))
    const call = (fetchImpl as unknown as { mock: { calls: unknown[][] } }).mock.calls[0]!
    const headers = (call[1] as { headers: Headers }).headers
    const get = (k: string): string | null => (headers instanceof Headers ? headers.get(k) : null)
    const auth = get('authorization')
    expect(auth).toContain('Bearer COSY.')
    expect(auth).not.toBe('Bearer tok')
    expect(get('accept')).toBe('text/event-stream')
  })

  it('请求体必须含 `business`（缺了服务端路由到坏节点）', async () => {
    // ⚠️ 真实缺陷（2026-09-20 定位）：
    //   `qfmodel`（Qwen3.8-Flash）在**不带 `business`** 时恒落到故障节点
    //   `oa_qwen-plus-2025-04-28` 并返回 `[FAIL]node:... msg:Execution failed`；
    //   补上 `business` 后立即正常（其余模型如 `qmodel_38max` 恰好不受影响，
    //   故极易误判为「该模型服务端故障」——IDE 里同一模型完全可用）。
    //
    // 源码依据：`MPi(A) { return A === 'sec_scan' ? 'security' : 'default' }`
    // —— 服务端按 `business.type` 选路由池。
    //
    // 请求体是加密的，单测无法直接读字段，故用**源码级断言**锁死
    // （与 `jet-hub-rpc.spec.ts` 的守卫同款做法）。
    const source = readFileSync(resolve(here, '../../src/providers/qoder-adapter.ts'), 'utf8')
    const code = source
      .split(/\r?\n/)
      .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
      .join('\n')
    expect(code).toContain('business: { type:')
  })

  it('system 提示与用户文本都进加密体（本地不可解，只校验非空）', async () => {
    const fetchImpl = vi.fn(async () => envelopeResponse([textFrame('hi'), finishFrame])) as unknown as typeof fetch
    const adapter = makeAdapter({ fetchImpl })
    for await (const _ of adapter.stream({
      model: 'auto',
      system: '你是助手',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
    } as never)) { /* drain */ }
    const call = (fetchImpl as unknown as { mock: { calls: unknown[][] } }).mock.calls[0]!
    const withSystem = String((call[1] as { body: string }).body)

    const fetchImpl2 = vi.fn(async () => envelopeResponse([textFrame('hi'), finishFrame])) as unknown as typeof fetch
    for await (const _ of makeAdapter({ fetchImpl: fetchImpl2 }).stream({
      model: 'auto',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
    } as never)) { /* drain */ }
    const call2 = (fetchImpl2 as unknown as { mock: { calls: unknown[][] } }).mock.calls[0]!
    const withoutSystem = String((call2[1] as { body: string }).body)

    // 有 system 时密文更长（内容确实进了请求）
    expect(withSystem.length).toBeGreaterThan(withoutSystem.length)
  })
})

describe('QoderAdapter 鉴权与重试', () => {
  it('401 时刷新一次凭据后重试', async () => {
    let calls = 0
    const fetchImpl = vi.fn(async () => {
      calls += 1
      if (calls === 1) return new Response('unauthorized', { status: 401 })
      return envelopeResponse([textFrame('你好'), finishFrame])
    }) as unknown as typeof fetch
    const refresh = vi.fn(async () => {})
    const chunks = await collect(makeAdapter({ fetchImpl, refresh }))
    expect(refresh).toHaveBeenCalledTimes(1)
    expect(chunks.some((c) => c.type === 'text-delta')).toBe(true)
  })

  it('无凭据时报 MISSING_CREDENTIAL', async () => {
    const adapter = makeAdapter({ resolveCredential: async () => undefined })
    await expect(collect(adapter)).rejects.toThrow(/log in|凭据|credential/i)
  })
})

describe('QoderAdapter SSE 解析', () => {
  it('解析正文与 reasoning_content', async () => {
    const fetchImpl = vi.fn(async () => envelopeResponse([
      JSON.stringify({ choices: [{ delta: { reasoning_content: '想' } }] }),
      textFrame('你好'),
      finishFrame,
    ])) as unknown as typeof fetch
    const chunks = await collect(makeAdapter({ fetchImpl }))
    expect(chunks.some((c) => c.type === 'reasoning-delta')).toBe(true)
    expect(chunks.some((c) => c.type === 'text-delta')).toBe(true)
    const finish = chunks.find((c) => c.type === 'finish')
    expect(finish).toBeDefined()
  })

  it('delta.content 显式为 null 时不崩溃（真实形态）', async () => {
    // 实测：一个模型要么走 content、要么走 reasoning_content，另一侧恒为 null
    const fetchImpl = vi.fn(async () => envelopeResponse([
      JSON.stringify({ choices: [{ delta: { content: null, reasoning_content: 'r' } }] }),
      finishFrame,
    ])) as unknown as typeof fetch
    await expect(collect(makeAdapter({ fetchImpl }))).resolves.toBeDefined()
  })

  it('工具调用分片合并', async () => {
    const fetchImpl = vi.fn(async () => envelopeResponse([
      JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'c1',
        function: { name: 'read', arguments: '{"p"' } }] } }] }),
      JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0,
        function: { arguments: ':"x"}' } }] } }] }),
      JSON.stringify({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] }),
    ])) as unknown as typeof fetch
    const chunks = await collect(makeAdapter({ fetchImpl }))
    const end = chunks.find((c) => c.type === 'block-end'
      && (c.block as { type?: string } | undefined)?.type === 'tool-call')
    expect(end).toBeDefined()
    const block = end!.block as { name: string; arguments: string }
    expect(block.name).toBe('read')
    expect(block.arguments).toBe('{"p":"x"}')
  })
})

describe('QoderAdapter SSE 错误帧（真实缺陷：报错被静默吞掉）', () => {
  /**
   * 真实缺陷（用户报障）：「向 qwen3.8-flash 发消息后没收到回复就终止了」。
   *
   * 服务端对无效模型的真实响应（实测 2026-09-19）：
   * ```
   * event: error
   * data: {"code":"invalid_model_error","message":"Unsupported model \"qfmodel\"",
   *        "request_id":"...","type":"invalid_model_error"}
   * ```
   *
   * ⚠️ 两处与 OpenAI 标准不同，早期实现因此**整帧丢弃**：
   * 1. 有独立的 `event: error` 行（我们的解析器只处理 `data:` 行）；
   * 2. 错误信息在**顶层 `code`/`message`**，而非 `{error: {message}}`。
   *
   * 后果：错误被当成「正常结束、无内容」→ 只产出
   * `[{type:'finish', reason:{kind:'stop'}}]`，UI 表现为
   * 「没回复就干净地停止」，用户看不到任何原因。
   */
  const errorFrame = 'event: error\ndata: {"code":"invalid_model_error","message":"Unsupported model \\"qfmodel\\"","request_id":"abc","type":"invalid_model_error"}\n\n'

  it('顶层 code/message 的错误帧必须抛错，而不是静默 finish', async () => {
    const fetchImpl = vi.fn(async () => new Response(errorFrame, {
      status: 200, headers: { 'Content-Type': 'text/event-stream' },
    })) as unknown as typeof fetch
    await expect(collect(makeAdapter({ fetchImpl }))).rejects.toThrow(/Unsupported model/)
  })

  it('错误必须带上服务端 message，便于用户定位', async () => {
    const fetchImpl = vi.fn(async () => new Response(errorFrame, {
      status: 200, headers: { 'Content-Type': 'text/event-stream' },
    })) as unknown as typeof fetch
    const error = await collect(makeAdapter({ fetchImpl })).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(Error)
    expect((error as Error).message).toContain('invalid_model_error')
    expect((error as Error).message).toContain('qfmodel')
  })

  it('标准 OpenAI 形态 {error:{message}} 仍要抛错（不回归）', async () => {
    const frame = 'data: {"error":{"message":"boom"}}\n\n'
    const fetchImpl = vi.fn(async () => new Response(frame, {
      status: 200, headers: { 'Content-Type': 'text/event-stream' },
    })) as unknown as typeof fetch
    await expect(collect(makeAdapter({ fetchImpl }))).rejects.toThrow(/boom/)
  })

  it('正常帧不受影响（event: 行被忽略，data 帧照常解析）', async () => {
    const frame = `event: message\ndata: ${textFrame('你好')}\ndata: ${finishFrame}\ndata: [DONE]\n\n`
    const fetchImpl = vi.fn(async () => new Response(frame, {
      status: 200, headers: { 'Content-Type': 'text/event-stream' },
    })) as unknown as typeof fetch
    const chunks = await collect(makeAdapter({ fetchImpl }))
    expect(chunks.some((c) => c.type === 'text-delta')).toBe(true)
  })
})

describe('QoderAdapter 图片输入', () => {
  it('不支持图片的模型收到图片时报 UNSUPPORTED_CONTENT', async () => {
    // 实测真实模型 is_vl 全为 true，故用**未知模型**测「保守报 text」这条路径
    const fetchImpl = vi.fn(async () => envelopeResponse([textFrame('你好'), finishFrame])) as unknown as typeof fetch
    const adapter = makeAdapter({ fetchImpl, readImage: async () => undefined })
    const iterate = async (): Promise<void> => {
      for await (const _ of adapter.stream({
        model: 'text-only-unknown',
        messages: [{
          role: 'user',
          content: [
            { type: 'text', text: 'hi' },
            { type: 'image', attachment: { attachmentId: 'a1' } },
          ],
        }],
      } as never)) { /* drain */ }
    }
    await expect(iterate()).rejects.toThrow(/不支持图片/)
  })

  it('支持图片的模型接受图片并真的读取了附件', async () => {
    // ⚠️ 请求体已加密，无法再断言明文 image_url 形态
    // （那是公开端点的形态）。且加密体长度因分块填充而**不单调**，
    // 也不能用长度断言。这里验证真正可观察的行为：
    //   1. 不抛 UNSUPPORTED_CONTENT（图片被接受）
    //   2. readImage 被调用（附件确实被读取，而非静默丢弃）
    const readImage = vi.fn(async (): Promise<{ data: Uint8Array; mediaType: string }> =>
      ({ data: new Uint8Array([1, 2, 3]), mediaType: 'image/png' }))

    const fetchImpl = vi.fn(async () => envelopeResponse([textFrame('你好'), finishFrame])) as unknown as typeof fetch
    const chunks = await collectWith(makeAdapter({ fetchImpl, readImage }), {
      model: 'dmodel',
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: 'hi' },
          { type: 'image', attachment: { attachmentId: 'a1' } },
        ],
      }],
    })

    expect(readImage).toHaveBeenCalledTimes(1)
    expect(chunks.some((c) => c.type === 'text-delta')).toBe(true)
  })
})

/**
 * ## 真实缺陷（用户报障，2026-09-27）：Qoder 的**排队错误**被当成认证失败
 *
 * 用户给的两条真实错误（都是 HTTP 403 + 业务码 `10605`）：
 *
 * ```
 * 国际版: {"code":"10605","message":"{\"isQueued\":true,…,\"retryAfterSeconds\":30,
 *          \"serviceAvailable\":false,\"waitTime\":30}"}      → 真排队 30s
 * 中国版: {"code":"10605","message":"{\"isQueued\":false,…,\"retryAfterSeconds\":2,
 *          \"serviceAvailable\":true,\"waitTime\":0}"}        → 瞬时，等 2s 即成功
 * ```
 *
 * ⚠️ **关键结构**：`message` 是**一个 JSON 字符串**（不是对象），必须**二次解析**。
 * 客户端 `lFc()` 为此递归遍历 `data`/`result`/`message`/`body`，字符串则
 * `JSON.parse`。旧实现只读顶层 `code`，因此从未识别出排队。
 *
 * 客户端的权威算法（obf 产物取证，`scripts/probe-qoder-queue-error.mjs`）：
 * - 排队码 `mRA="10605"` → `model_queued`；认证码 `MF="105"` → `auth_error`
 *   —— **两者互相独立**（`rJc()`），不能都归为 AUTH；
 * - 延迟优先序（`kJa()`/`EV()`/`IRA()`）：`retry_after_ms` → `retryAfterMs`
 *   → `queue.retryAfterSeconds×1000` → 兜底 `Retry-After` 响应头；
 * - 决策（`W7c()`）：**有 `retryAfterMs` 就精确等它**，没有才退避。
 */
describe('QoderAdapter 排队错误（10605 model_queued）', () => {
  /** 构造一条真实的 403 排队响应（`message` 是 JSON 字符串）。 */
  function queueResponse(info: Record<string, unknown>): Response {
    return new Response(
      JSON.stringify({ code: '10605', message: JSON.stringify(info) }),
      { status: 403, headers: { 'Content-Type': 'application/json' } },
    )
  }

  /** 国际版真排队：等 30s。 */
  const REAL_QUEUED = {
    isQueued: true, modelKey: 'qfmodel', queueCount: 0, queueType: 'p3',
    retryAfterSeconds: 30, serviceAvailable: false, waitTime: 30,
  }
  /** 中国版瞬时排队：等 2s，重试即成功。 */
  const REAL_TRANSIENT = {
    isQueued: false, modelKey: 'qfmodel', queueCount: 0, queueType: 'p3',
    retryAfterSeconds: 2, serviceAvailable: true, waitTime: 0,
  }

  describe('parseQoderQueueError（纯函数：二次解析 message）', () => {
    it('解析出排队信息（message 是 JSON 字符串，必须二次解析）', () => {
      const info = parseQoderQueueError(JSON.stringify({ code: '10605', message: JSON.stringify(REAL_QUEUED) }))
      expect(info).toEqual(REAL_QUEUED)
    })

    it('中国版瞬时排队同样解析出来', () => {
      const info = parseQoderQueueError(JSON.stringify({ code: '10605', message: JSON.stringify(REAL_TRANSIENT) }))
      expect(info).toEqual(REAL_TRANSIENT)
    })

    it('非 10605 的 403（真认证失败）不算排队', () => {
      // 认证失败的业务码是 105，不是 10605 —— 两者**必须分开**（客户端 rJc()）。
      expect(parseQoderQueueError(JSON.stringify({ code: '105', message: 'login expired' }))).toBeUndefined()
      expect(parseQoderQueueError(JSON.stringify({ code: '10605', message: 'not json' }))).toBeUndefined()
      expect(parseQoderQueueError('not json at all')).toBeUndefined()
      expect(parseQoderQueueError('')).toBeUndefined()
    })

    it('message 是对象而非字符串时也能取到（上游形态变化时更鲁棒）', () => {
      const info = parseQoderQueueError(JSON.stringify({ code: '10605', message: REAL_QUEUED }))
      expect(info).toEqual(REAL_QUEUED)
    })

    it('code 兼容字符串与数字两种编码', () => {
      expect(parseQoderQueueError(JSON.stringify({ code: 10605, message: JSON.stringify(REAL_TRANSIENT) })))
        .toEqual(REAL_TRANSIENT)
    })
  })

  describe('qoderQueueDelayMs（纯函数：延迟换算与封顶）', () => {
    it('小于 10 秒按服务端的值（2s → 2000ms）', () => {
      expect(qoderQueueDelayMs({ retryAfterSeconds: 2 })).toBe(2000)
      expect(qoderQueueDelayMs({ retryAfterSeconds: 0 })).toBe(0)
      expect(qoderQueueDelayMs({ retryAfterSeconds: 9 })).toBe(9000)
    })

    it('≥ 10 秒封顶到 10 秒（30s → 10000ms）', () => {
      // 用户明确要求：大于 10 秒就按 10 秒排队（避免一次阻塞 30 秒，
      // 分多次尝试更稳 —— 后端可能提前放行）。
      expect(qoderQueueDelayMs({ retryAfterSeconds: 10 })).toBe(10_000)
      expect(qoderQueueDelayMs({ retryAfterSeconds: 30 })).toBe(10_000)
      expect(qoderQueueDelayMs({ retryAfterSeconds: 3600 })).toBe(10_000)
    })

    it('优先用 retry_after_ms / retryAfterMs（毫秒口径，同样封顶）', () => {
      // 客户端 kJa() 的优先序：retry_after_ms → retryAfterMs → retryAfterSeconds×1000
      expect(qoderQueueDelayMs({ retry_after_ms: 1500, retryAfterSeconds: 30 })).toBe(1500)
      expect(qoderQueueDelayMs({ retryAfterMs: 2500 })).toBe(2500)
      // 毫秒值超上限同样封顶
      expect(qoderQueueDelayMs({ retry_after_ms: 99_999 })).toBe(10_000)
    })

    it('非法值被忽略，退回退避（而不是等 NaN 毫秒）', () => {
      // 客户端 W7c() 对非有限/负值直接判 fail；我们取保守：退回退避。
      expect(qoderQueueDelayMs({ retryAfterSeconds: -5 })).toBeUndefined()
      expect(qoderQueueDelayMs({ retryAfterSeconds: Number.NaN })).toBeUndefined()
      expect(qoderQueueDelayMs({})).toBeUndefined()
      expect(qoderQueueDelayMs({ retryAfterSeconds: '2' as never })).toBeUndefined()
    })

    it('非排队错误不产生延迟', () => {
      expect(qoderQueueDelayMs(undefined)).toBeUndefined()
    })
  })

  describe('stream 行为：排队时内部等待并重试', () => {
    it('瞬时排队（2s）等待后重试即成功，且**不刷新凭据**', async () => {
      const refresh = vi.fn(async () => {})
      let call = 0
      const fetchImpl = vi.fn(async () => {
        call += 1
        // 第 1 次排队，第 2 次成功（与用户观察一致：一次重试就能过）
        return call === 1
          ? queueResponse(REAL_TRANSIENT)
          : envelopeResponse([textFrame('好了'), finishFrame])
      }) as unknown as typeof fetch

      const sleeps: number[] = []
      const pending = collectWith(makeAdapter({
        fetchImpl, refresh, sleep: async (ms) => { sleeps.push(ms) },
      }), { model: 'qfmodel', messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }] })

      const chunks = await pending
      expect(sleeps, '应按服务端给的 2s 等待').toEqual([2000])
      // ⚠️ 排队不是认证问题：绝不能刷新凭据（旧实现会先 refresh 再重试）
      expect(refresh, '排队期间不应刷新凭据').not.toHaveBeenCalled()
      expect(chunks.some((c) => c.type === 'text-delta')).toBe(true)
    })

    it('真排队（30s）按 10s 封顶等待，多次重试直到成功', async () => {
      const refresh = vi.fn(async () => {})
      let call = 0
      const fetchImpl = vi.fn(async () => {
        call += 1
        if (call <= 3) return queueResponse(REAL_QUEUED)
        return envelopeResponse([textFrame('排到了'), finishFrame])
      }) as unknown as typeof fetch

      const sleeps: number[] = []
      const chunks = await collectWith(makeAdapter({
        fetchImpl, refresh, sleep: async (ms) => { sleeps.push(ms) },
      }), { model: 'qfmodel', messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }] })

      // 30s 被压到 10s（用户要求：>10s 按 10s 排）
      expect(sleeps).toEqual([10_000, 10_000, 10_000])
      expect(refresh).not.toHaveBeenCalled()
      expect(chunks.some((c) => c.type === 'text-delta')).toBe(true)
    })

    it('排队次数超过上限后抛错（不无限阻塞）', async () => {
      const fetchImpl = vi.fn(async () => queueResponse(REAL_QUEUED)) as unknown as typeof fetch
      const sleeps: number[] = []
      const adapter = makeAdapter({
        fetchImpl,
        sleep: async (ms) => { sleeps.push(ms); if (sleeps.length > QODER_QUEUE_MAX_ATTEMPTS + 5) throw new Error('sleep 未收敛') },
      })

      await expect(collectWith(adapter, {
        model: 'qfmodel', messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
      })).rejects.toThrow(/排队|queue/i)

      // 精确上限：不多不少
      expect(sleeps.length).toBe(QODER_QUEUE_MAX_ATTEMPTS)
      expect(QODER_QUEUE_MAX_ATTEMPTS).toBe(180)
    })

    it('等待期间 signal 中止则立即停止（不再重试）', async () => {
      const controller = new AbortController()
      const fetchImpl = vi.fn(async () => queueResponse(REAL_QUEUED)) as unknown as typeof fetch
      const adapter = makeAdapter({
        fetchImpl,
        sleep: async () => { controller.abort() },
      })

      await expect(collectWith(adapter, {
        model: 'qfmodel',
        signal: controller.signal,
        messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
      })).rejects.toThrow()
    })

    it('真认证失败（非 10605 的 403）仍走 refresh + AUTH（不误判为排队）', async () => {
      const refresh = vi.fn(async () => {})
      const fetchImpl = vi.fn(async () => new Response(
        JSON.stringify({ code: '105', message: 'login expired' }),
        { status: 403, headers: { 'Content-Type': 'application/json' } },
      )) as unknown as typeof fetch

      const sleeps: number[] = []
      await expect(collectWith(makeAdapter({
        fetchImpl, refresh, sleep: async (ms) => { sleeps.push(ms) },
      }), { model: 'qfmodel', messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }] }))
        .rejects.toThrow()

      expect(sleeps, '认证失败不该走排队等待').toEqual([])
      expect(refresh, '认证失败应触发续期').toHaveBeenCalled()
    })

    it('排队总时长上限可用 DSH_QODER_QUEUE_TIMEOUT_MS 覆盖', async () => {
      // ⚠️ 上限判定是**时间**驱动（默认 1 分钟），单测不能真等 —— 这里设 0，
      // 语义是「立即判超时 → 立刻换号」，从而在毫秒级验证该开关确实生效且
      // **不被 180 次次数上限抢先命中**（两者的判定顺序是实现细节，此用例锁住它）。
      process.env.DSH_QODER_QUEUE_TIMEOUT_MS = '0'
      try {
        const fetchImpl = vi.fn(async () => queueResponse(REAL_QUEUED)) as unknown as typeof fetch
        const sleeps: number[] = []
        await expect(collectWith(makeAdapter({
          fetchImpl, sleep: async (ms) => { sleeps.push(ms) },
        }), { model: 'qfmodel', messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }] }))
          .rejects.toThrow(/排队/)

        // 上限为 0 → 第一次排队即判超时，**一次都不等**（而不是把 180 次耗完）。
        // 无账号池 ⇒ 换不到号 ⇒ 如实报错（这正是「所有账号都排不上」的形态）。
        expect(sleeps).toEqual([])
      } finally {
        delete process.env.DSH_QODER_QUEUE_TIMEOUT_MS
      }
    })

    it('单账号排队上限默认 1 分钟（2026-10-27 用户要求）', () => {
      // 用户要求：「排队超过 1 分钟就自动切账号，全部都要超过 1 分钟就直接报错」。
      // ⚠️ 断言默认值本身（而非只测可覆盖）：否则日后有人改回大值不会有任何
      // 用例失败。环境变量未设时才走默认分支。
      const saved = process.env.DSH_QODER_QUEUE_TIMEOUT_MS
      delete process.env.DSH_QODER_QUEUE_TIMEOUT_MS
      try {
        expect(DEFAULT_QUEUE_TIMEOUT_MS).toBe(60_000)
        expect(resolveQueueTimeoutMs()).toBe(60_000)
      } finally {
        if (saved === undefined) delete process.env.DSH_QODER_QUEUE_TIMEOUT_MS
        else process.env.DSH_QODER_QUEUE_TIMEOUT_MS = saved
      }
    })

    /**
     * ## 排队换号（2026-10-27 用户要求）
     *
     * > 排队超过 1 分钟就自动切账号，全部都要超过 1 分钟就直接报错
     *
     * ⚠️ 与额度受限的**关键差异**：排队是**暂时**状态，换号时**不写限流标记**
     * （写标记会把好账号锁掉一整天）。
     *
     * 单测用**可控时钟**（mock `Date.now` + `sleep` 推进时间）在毫秒级验证，
     * 不真等 1 分钟。
     */
    function makeQueuePoolStub(accounts: Array<{ id: string; token: string }>) {
      const marks: Array<{ accountId: string; modelId: string }> = []
      const picks: Array<ReadonlySet<string> | undefined> = []
      let index = 0
      const pool = {
        updateModelRateLimit: async (accountId: string, modelId: string) => {
          marks.push({ accountId, modelId })
        },
        getAvailableAccount: async (_provider: string, _model: string, exclude?: ReadonlySet<string>) => {
          picks.push(exclude)
          while (index < accounts.length && exclude?.has(accounts[index].id) === true) index += 1
          if (index >= accounts.length) return null
          const a = accounts[index]
          return {
            entry: { id: a.id },
            credential: buildQoderCredential(
              parseQoderTokenPayload({ token: a.token, refresh_token: 'r', user_id: `uid-${a.id}` }),
              { machineId: 'm-1' },
            ),
          }
        },
      }
      return { pool, marks, picks }
    }

    it('单账号排队超预算 ⇒ 换下一个账号（第二个成功）', async () => {
      // 可控时钟：sleep 推进 `now`，从而在毫秒级逼近「排队累计超预算」。
      let now = 1_000_000
      const nowSpy = vi.spyOn(Date, 'now').mockImplementation(() => now)
      process.env.DSH_QODER_QUEUE_TIMEOUT_MS = '1000' // 1 秒预算（便于测试）
      try {
        const { pool, marks, picks } = makeQueuePoolStub([
          { id: 'acct-A', token: 'tokA' },
          { id: 'acct-B', token: 'tokB' },
        ])
        let call = 0
        const fetchImpl = vi.fn(async () => {
          call += 1
          // call 1、2 是 acct-A 的两次排队（第二次时预算已耗尽 ⇒ 触发换号）；
          // call 3 是 acct-B 的请求 ⇒ 正常返回内容。
          if (call <= 2) return queueResponse(REAL_QUEUED)
          return envelopeResponse([textFrame('B 可用'), finishFrame])
        }) as unknown as typeof fetch

        const chunks = await collectWith(makeAdapter({
          fetchImpl,
          accountPool: pool as never,
          currentAccountId: () => 'acct-A',
          sleep: async (ms) => { now += ms },
        }), { model: 'qfmodel', messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }] })

        // ① acct-A 排队累计超预算后换到了 acct-B，且 B 的请求成功
        expect(call, '应在 A 排不上后换号重发').toBe(3)
        expect(chunks.some((c) => c.type === 'text-delta')).toBe(true)
        // ② 取号时传了 tried（含 A），否则会拿回同一个账号
        expect(picks.some((p) => p?.has('acct-A') === true), 'tried 必须含排队超时的账号').toBe(true)
        // ③ ⚠️ **不写限流标记**：排队是暂时的，标记会把好账号锁一整天
        expect(marks, '排队换号不得标记限流').toEqual([])
      } finally {
        nowSpy.mockRestore()
        delete process.env.DSH_QODER_QUEUE_TIMEOUT_MS
      }
    })

    it('所有账号都排队超预算 ⇒ 报错（不无限换）', async () => {
      let now = 1_000_000
      const nowSpy = vi.spyOn(Date, 'now').mockImplementation(() => now)
      process.env.DSH_QODER_QUEUE_TIMEOUT_MS = '1000'
      try {
        const { pool, marks } = makeQueuePoolStub([
          { id: 'acct-A', token: 'tokA' },
          { id: 'acct-B', token: 'tokB' },
        ])
        // 永远排队：两个账号都会被换到，然后无号可换 ⇒ 报错
        const fetchImpl = vi.fn(async () => queueResponse(REAL_QUEUED)) as unknown as typeof fetch

        await expect(collectWith(makeAdapter({
          fetchImpl,
          accountPool: pool as never,
          currentAccountId: () => 'acct-A',
          sleep: async (ms) => { now += ms },
        }), { model: 'qfmodel', messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }] }))
          .rejects.toMatchObject({ code: 'QUEUE' })

        // 排队换号**全程不写限流标记**（与额度受限的本质区别）
        expect(marks, '排队路径不得写限流标记').toEqual([])
      } finally {
        nowSpy.mockRestore()
        delete process.env.DSH_QODER_QUEUE_TIMEOUT_MS
      }
    })

    it('无账号池时排队超预算仍如实报错（不吞错）', async () => {
      process.env.DSH_QODER_QUEUE_TIMEOUT_MS = '0'
      try {
        const fetchImpl = vi.fn(async () => queueResponse(REAL_QUEUED)) as unknown as typeof fetch
        await expect(collectWith(makeAdapter({
          fetchImpl, sleep: async () => {},
        }), { model: 'qfmodel', messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }] }))
          .rejects.toMatchObject({ code: 'QUEUE' })
      } finally {
        delete process.env.DSH_QODER_QUEUE_TIMEOUT_MS
      }
    })
  })

  /**
   * ## 真实缺陷（用户报障 2026-09-27 的**第二次**回归）：排队走 SSE 通道
   *
   * 第一版修复只覆盖了 **HTTP 403** 形态，但 Qoder 的排队错误还有**第二种**下发：
   * **HTTP 200 + SSE 内嵌 `{code:"10605",…}` 帧**。
   *
   * 用户症状：`失败原因：qoder: {"code":"10605",…}` + harness 以
   * `500/1000/2000/4000/8000`（约 15.5 秒）重试 5 次，而服务端要求等 30 秒
   * —— **永远等不到**。会话证据：`failure.code = "SERVER"`，而
   * `httpErrorCode(403) = "AUTH"` ⇒ 错误来自 SSE 消费器，不是 HTTP 状态层。
   *
   * ⚠️ 这条通道还踩过一个**更隐蔽**的坑：`unwrapQoderEnvelopeStream` 原先把内层
   * `{code, message}` **降级重组**为 `{error:{message:"… (10605)"}}` —— 把 `code`
   * 拼成文案后缀并**丢掉字段**，导致 `consumeOpenAiSse` 的排队识别
   * （依赖顶层 `code === '10605'`）**永远不命中**。
   * 故这条用例同时守住「信封保真转发」与「SSE 层识别排队」两件事。
   */
  describe('SSE 通道的排队（HTTP 200 + 内嵌 10605 帧）', () => {
    /** 构造 HTTP 200 + **加密信封** SSE 的错误帧（真实形态）。 */
    function sseQueueResponse(innerBody: string): Response {
      const payload = `data:${JSON.stringify({
        headers: { 'Content-Type': ['application/json'] },
        body: innerBody,
        statusCodeValue: 200,
        statusCode: 'OK',
      })}\n\n`
      return new Response(payload, { status: 200, headers: { 'Content-Type': 'text/event-stream' } })
    }

    const INNER_ERROR = JSON.stringify({ code: '10605', message: JSON.stringify(REAL_QUEUED) })

    it('SSE 内嵌排队被识别：内部等待后重试，且不刷新凭据', async () => {
      let call = 0
      const refresh = vi.fn(async () => {})
      const fetchImpl = vi.fn(async () => {
        call += 1
        // 第 1 次回 HTTP 200 + 排队帧，第 2 次回正常内容
        return call === 1
          ? sseQueueResponse(INNER_ERROR)
          : envelopeResponse([textFrame('好了'), finishFrame])
      }) as unknown as typeof fetch

      const sleeps: number[] = []
      const chunks = await collectWith(makeAdapter({
        fetchImpl, refresh, sleep: async (ms) => { sleeps.push(ms) },
      }), { model: 'qfmodel', messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }] })

      // ⚠️ 这是本用例的核心：SSE 通道也按服务端延迟（30s→10s 封顶）等待
      expect(sleeps, 'SSE 通道的排队未被识别（第一版修复的漏洞）').toEqual([10_000])
      expect(refresh, '排队不应刷新凭据').not.toHaveBeenCalled()
      expect(chunks.some((c) => c.type === 'text-delta')).toBe(true)
    })

    it('信封必须保真转发 code（丢掉它会让排队识别永远失效）', async () => {
      // 直接断言信封剥离后的帧仍带 `code`，而不是被拼成 `message (code)` 后缀。
      const { unwrapQoderEnvelopeStream } = await import('../../src/providers/qoder-envelope.js')
      const stripped = unwrapQoderEnvelopeStream(sseQueueResponse(INNER_ERROR), 'qoder')
      const text = await stripped.text()
      expect(text, '内层 code 被丢掉了').toContain('10605')
      // 旧实现会产出 `{"error":{"message":"… (10605)"}}` 这种丢字段的形态
      expect(text, '不应降级成无 code 的 error 包装').not.toContain('"error"')
    })

    it('SSE 排队同样受次数上限约束（不无限阻塞）', async () => {
      const fetchImpl = vi.fn(async () => sseQueueResponse(INNER_ERROR)) as unknown as typeof fetch
      const sleeps: number[] = []
      const adapter = makeAdapter({
        fetchImpl,
        sleep: async (ms) => {
          sleeps.push(ms)
          if (sleeps.length > QODER_QUEUE_MAX_ATTEMPTS + 5) throw new Error('sleep 未收敛')
        },
      })

      await expect(collectWith(adapter, {
        model: 'qfmodel', messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
      })).rejects.toThrow(/排队|queue/i)
      expect(sleeps.length).toBe(QODER_QUEUE_MAX_ATTEMPTS)
    })

    it('SSE 里的**瞬时**排队（2s）按 2s 等待，不是 10s', async () => {
      const inner = JSON.stringify({ code: '10605', message: JSON.stringify(REAL_TRANSIENT) })
      let call = 0
      const fetchImpl = vi.fn(async () => {
        call += 1
        return call === 1
          ? sseQueueResponse(inner)
          : envelopeResponse([textFrame('ok'), finishFrame])
      }) as unknown as typeof fetch

      const sleeps: number[] = []
      await collectWith(makeAdapter({
        fetchImpl, sleep: async (ms) => { sleeps.push(ms) },
      }), { model: 'qfmodel', messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }] })

      expect(sleeps).toEqual([2000])
    })

    /**
     * ⚠️ **SSE 通道的排队换号**必须单独测。
     *
     * 真实缺陷的教训：排队有**两条**下发通道（HTTP 403 与 HTTP 200 + SSE 内嵌帧），
     * 早期修复只覆盖一条就以为修好了。换号同理 —— 只测 HTTP 形态会让 SSE 分支
     * 的缺陷潜伏（本次改动**反向验证时实测到**：只留 HTTP 用例时，删掉 SSE 换号
     * 分支全部用例仍通过）。
     */
    it('SSE 通道排队超预算也换号（不是只顾着 HTTP 那条）', async () => {
      let now = 1_000_000
      const nowSpy = vi.spyOn(Date, 'now').mockImplementation(() => now)
      process.env.DSH_QODER_QUEUE_TIMEOUT_MS = '1000'
      try {
        const marks: Array<{ accountId: string }> = []
        let index = 0
        const accounts = [{ id: 'acct-A', token: 'tokA' }, { id: 'acct-B', token: 'tokB' }]
        const pool = {
          updateModelRateLimit: async (accountId: string) => { marks.push({ accountId }) },
          getAvailableAccount: async (_p: string, _m: string, exclude?: ReadonlySet<string>) => {
            while (index < accounts.length && exclude?.has(accounts[index].id) === true) index += 1
            if (index >= accounts.length) return null
            const a = accounts[index]
            return {
              entry: { id: a.id },
              credential: buildQoderCredential(
                parseQoderTokenPayload({ token: a.token, refresh_token: 'r', user_id: `uid-${a.id}` }),
                { machineId: 'm-1' },
              ),
            }
          },
        }
        let call = 0
        const fetchImpl = vi.fn(async () => {
          call += 1
          // A 的两次排队（第 2 次时预算耗尽 ⇒ 换号），B 的请求正常返回。
          if (call <= 2) return sseQueueResponse(INNER_ERROR)
          return envelopeResponse([textFrame('B 可用'), finishFrame])
        }) as unknown as typeof fetch

        const chunks = await collectWith(makeAdapter({
          fetchImpl,
          accountPool: pool as never,
          currentAccountId: () => 'acct-A',
          sleep: async (ms) => { now += ms },
        }), { model: 'qfmodel', messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }] })

        expect(call, 'SSE 通道也应在排不上时换号').toBe(3)
        expect(chunks.some((c) => c.type === 'text-delta')).toBe(true)
        expect(marks, '排队换号不得写限流标记').toEqual([])
      } finally {
        nowSpy.mockRestore()
        delete process.env.DSH_QODER_QUEUE_TIMEOUT_MS
      }
    })

    it('网关形态（无 code，只有 message + type）的排队也被识别', async () => {
      // ⚠️ 信封剥离把这种帧变成 `{message, type:'model_error'}`（`statusCodeValue`
      // 被信封吃掉）—— 若只判 `statusCodeValue >= 400`，整帧会被**静默丢弃**，
      // 既识别不出排队、连报错都没有（真实缺陷的又一变体）。
      const inner = JSON.stringify({ statusCodeValue: 403, message: JSON.stringify(REAL_QUEUED) })
      let call = 0
      const fetchImpl = vi.fn(async () => {
        call += 1
        return call === 1
          ? sseQueueResponse(inner)
          : envelopeResponse([textFrame('ok'), finishFrame])
      }) as unknown as typeof fetch

      const sleeps: number[] = []
      await collectWith(makeAdapter({
        fetchImpl, sleep: async (ms) => { sleeps.push(ms) },
      }), { model: 'qfmodel', messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }] })

      expect(sleeps, '网关形态的排队被静默丢弃了').toEqual([10_000])
    })

    it('非排队的网关错误仍抛错（不因新增判据而静默吞掉）', async () => {
      // 防回归：新增的 `type === 'model_error'` 判据不能把普通错误也吞掉。
      const inner = JSON.stringify({ statusCodeValue: 500, message: '[FAIL]node:xxx msg:Execution failed' })
      const fetchImpl = vi.fn(async () => sseQueueResponse(inner)) as unknown as typeof fetch

      await expect(collectWith(makeAdapter({
        fetchImpl, sleep: async () => {},
      }), { model: 'qfmodel', messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }] }))
        .rejects.toThrow(/Execution failed/)
    })

    /**
     * ## 真实缺陷（第三次回归，用户报障 2026-09-27 13:15）
     *
     * 用户贴出的错误后缀是 **`(403/model_error)`** —— 该后缀由
     * `[String(data.code), data.type].join('/')` 产出，据此反推出消费器收到的帧：
     *
     * ```json
     * { "code": 403,
     *   "message": "{\"code\":\"10605\",\"message\":\"{\\\"isQueued\\\":…}\"}",
     *   "type": "model_error" }
     * ```
     *
     * ⚠️ **业务码嵌了两层**：顶层 `code` 是 **403**，`10605` 在 `message` 里。
     * 上一版判据写成 `isQueueBusinessCode(data.code)` —— 拿 403 比 10605
     * **必然不命中**，于是又落到 `SERVER`（这正是「修了两次仍失败」的原因）。
     *
     * 判据必须是「**直接尝试解析 `message`**」，而不是用顶层 `code` 当门禁。
     */
    it('业务码嵌套两层（顶层 code=403，10605 在内层）也要识别', async () => {
      const nested = JSON.stringify({ code: 403, message: INNER_ERROR, type: 'model_error' })
      let call = 0
      const fetchImpl = vi.fn(async () => {
        call += 1
        return call === 1
          ? sseQueueResponse(nested)
          : envelopeResponse([textFrame('ok'), finishFrame])
      }) as unknown as typeof fetch

      const sleeps: number[] = []
      await collectWith(makeAdapter({
        fetchImpl, sleep: async (ms) => { sleeps.push(ms) },
      }), { model: 'qfmodel', messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }] })

      // ⚠️ 断言精确的 10s（而非「有等待」）：它同时证明**穿透了两层**拿到
      // `retryAfterSeconds:30` —— 若只识别出排队却取不到延迟，会是 1000ms 兜底。
      expect(sleeps, '业务码嵌套两层时未穿透解析').toEqual([10_000])
    })

    it('嵌套两层且内层是**瞬时**排队（2s）时取 2s', async () => {
      const nested = JSON.stringify({
        code: 403,
        message: JSON.stringify({ code: '10605', message: JSON.stringify(REAL_TRANSIENT) }),
        type: 'model_error',
      })
      let call = 0
      const fetchImpl = vi.fn(async () => {
        call += 1
        return call === 1
          ? sseQueueResponse(nested)
          : envelopeResponse([textFrame('ok'), finishFrame])
      }) as unknown as typeof fetch

      const sleeps: number[] = []
      await collectWith(makeAdapter({
        fetchImpl, sleep: async (ms) => { sleeps.push(ms) },
      }), { model: 'qfmodel', messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }] })

      expect(sleeps).toEqual([2000])
    })
  })

  /**
   * ## 真实缺陷（用户报障 2026-09-27）：额度用尽被当成可重试的 `SERVER`
   *
   * 排队修好后，会话继续自动执行目标时出现**新错误**：
   * ```
   * 重试延迟：7220毫秒
   * 失败原因：qoder: Billing daily count exceeded (110/model_error)
   * ```
   *
   * ⚠️ 后缀 **`(110/model_error)`** 与排队那次那个 `(403/model_error)` **同源**，
   * 由 `openai-compat.ts` 的「顶层 code + message」分支产出 —— 即帧是
   * `{ code: 110, message: 'Billing daily count exceeded', type: 'model_error' }`。
   * 它被归成 **`SERVER`**，而 `SERVER` **在** harness 的
   * `DEFAULT_RETRYABLE_CODES` 里 → **白重试 5 次**（500…8000ms ≈ 15.5 秒，
   * 用户看到的 `7220毫秒` 就是其中一步）。
   *
   * ## 客户端权威依据（obf 产物原文）
   *
   * ```js
   * function vpt(e){
   *   let t = e === "authentication_failed" || e === "billing_error" ? "permission"
   *         : e === "rate_limit"      ? "rate_limited"
   *         : e === "invalid_request" ? "invalid_request"
   *         : "unavailable";
   *   return new Tt(t, `Qoder assistant failed: ${e}`)
   * }
   * ```
   * **`billing_error` 被归为 `permission`** —— 与 `rate_limit`（可重试）**明确分开**，
   * 属**不可重试**。故我们必须返回不可重试的错误码（`QUOTA_EXCEEDED`）。
   *
   * ⚠️ 与 `10605`（排队）的区别：排队是**暂时**的（等待即可通过），
   * 额度是**当天耗尽**（等到明天）。两者绝不能用同一套处理。
   */
  describe('额度用尽（110 billing）归为不可重试', () => {
    /** 构造 HTTP 200 + 信封的 110 错误帧。 */
    function billingFrame(inner) {
      return () => new Response(
        `data:${JSON.stringify({
          headers: { 'Content-Type': ['application/json'] },
          body: inner,
          statusCodeValue: 200,
          statusCode: 'OK',
        })}\n\n`,
        { status: 200, headers: { 'Content-Type': 'text/event-stream' } },
      )
    }

    it('SSE 帧里的 110 抛 QUOTA_EXCEEDED（而不是可重试的 SERVER）', async () => {
      const inner = JSON.stringify({ code: 110, message: 'Billing daily count exceeded', type: 'model_error' })
      const fetchImpl = vi.fn(billingFrame(inner)) as unknown as typeof fetch

      const sleeps: number[] = []
      let thrown
      try {
        await collectWith(makeAdapter({
          fetchImpl, sleep: async (ms) => { sleeps.push(ms) },
        }), { model: 'qfmodel', messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }] })
      } catch (error) { thrown = error }

      // ⚠️ 核心断言：**不可重试** —— 不能让 harness 白退避 5 次
      expect(thrown?.code, '110 必须归为不可重试的额度错误').toBe('QUOTA_EXCEEDED')
      expect(sleeps, '额度用尽不该在适配器内部等待').toEqual([])
      expect(String(thrown?.message)).toContain('Billing daily count exceeded')
    })

    it('业务码是字符串 "110" 同样识别', async () => {
      const inner = JSON.stringify({ code: '110', message: 'Billing daily count exceeded', type: 'model_error' })
      const fetchImpl = vi.fn(billingFrame(inner)) as unknown as typeof fetch

      await expect(collectWith(makeAdapter({
        fetchImpl, sleep: async () => {},
      }), { model: 'qfmodel', messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }] }))
        .rejects.toMatchObject({ code: 'QUOTA_EXCEEDED' })
    })

    it('客户端把 billing 归 permission 的**判据**用测试锁住（防被改回 SERVER）', async () => {
      // 这条是「文档即测试」：把客户端权威映射写成可执行断言，
      // 避免后人只看到注释而误以为 110 属可重试类。
      const CLIENT_MAPPING = (e) => (
        e === 'authentication_failed' || e === 'billing_error' ? 'permission'
          : e === 'rate_limit' ? 'rate_limited'
            : e === 'invalid_request' ? 'invalid_request'
              : 'unavailable'
      )
      expect(CLIENT_MAPPING('billing_error')).toBe('permission')
      // ⚠️ 与排队**不同类**：排队是 rate_limit（可重试），额度是 permission（不可重试）
      expect(CLIENT_MAPPING('rate_limit')).toBe('rate_limited')
      expect(CLIENT_MAPPING('billing_error')).not.toBe(CLIENT_MAPPING('rate_limit'))
    })
  })

  /**
   * ## 用户要求（2026-09-27）：额度受限要**切账号**，与 buddy/workbuddy 一致
   *
   * 原话：「qoder 碰到当日额度受限应该像 workbuddy/codebuddy 一样，设置一个模型
   * 受限时间（他们是返回错误中带时间，qoder 和 qodercn 需要自己设置当日 24:00
   * 受限）然后切换账号池中的下一个可用模型」。
   *
   * ⚠️ **与 buddy/CodeArts 的关键差异**：它们的错误文案里**带重置时间**
   * （`parseRateLimitError` 从中解析），Qoder **不带** —— 故必须自己算
   * 「当日 24:00」。这也是本组用例的重点。
   */
  describe('额度受限：标记当日 24:00 + 切换账号', () => {
    it('nextUtc8DayStartMs 算出 UTC+8 的当日 24:00（不是本机时区）', () => {
      // 2026-09-27 12:00:00 UTC+8 = 04:00:00 UTC
      const noon = Date.UTC(2026, 8, 27, 4, 0, 0)
      const end = nextUtc8DayStartMs(noon)
      // 期望 = 2026-09-28 00:00:00 UTC+8 = 2026-09-27 16:00:00 UTC
      expect(new Date(end).toISOString()).toBe('2026-09-27T16:00:00.000Z')
      // 12:00 → 次日 00:00 恰好 12 小时
      expect(end - noon).toBe(12 * 3_600_000)
    })

    it('接近 UTC+8 日界时，剩余时间收敛到 0（不会算到后天）', () => {
      // 2026-09-27 23:59:59 UTC+8 = 15:59:59 UTC
      const nearEnd = Date.UTC(2026, 8, 27, 15, 59, 59)
      const end = nextUtc8DayStartMs(nearEnd)
      expect(new Date(end).toISOString()).toBe('2026-09-27T16:00:00.000Z')
      expect(end - nearEnd).toBe(1000)
    })

    it('刚过 UTC+8 日界时，得到的是**下一个**日界（满 24 小时）', () => {
      // 2026-09-27 00:00:00 UTC+8 = 2026-09-26 16:00:00 UTC
      const justAfter = Date.UTC(2026, 8, 26, 16, 0, 0)
      const end = nextUtc8DayStartMs(justAfter)
      // 应是 2026-09-28 00:00:00 UTC+8（即 24 小时后），不是同一时刻
      expect(new Date(end).toISOString()).toBe('2026-09-27T16:00:00.000Z')
      expect(end - justAfter).toBe(24 * 3_600_000)
    })

    it('结果恒严格大于入参（标记不会“立刻失效”）', () => {
      for (const h of [0, 3, 8, 12, 16, 20, 23]) {
        const t = Date.UTC(2026, 8, 27, h, 30, 15)
        expect(nextUtc8DayStartMs(t), `h=${h}`).toBeGreaterThan(t)
      }
    })

    /**
     * 切账号的**行为**验证（不只看纯函数）。
     *
     * 用桩账号池记录「标记了什么、取了哪个账号」，从而断言：
     * ① 受限时**标记当前账号 + 该模型**到 UTC+8 当日 24:00；
     * ② 取号时**传了 tried**（否则会拿回同一个账号、切换静默失效）；
     * ③ 切到新账号后用**新凭据**重发；
     * ④ 全部账号都受限时如实抛 `QUOTA_EXCEEDED`（不无限切）。
     */
    function makePoolStub(accounts: Array<{ id: string; token: string }>) {
      const marks: Array<{ accountId: string; modelId: string; resetAtMs: number }> = []
      const picks: Array<ReadonlySet<string> | undefined> = []
      let index = 0
      const pool = {
        updateModelRateLimit: async (accountId: string, modelId: string, resetAtMs: number) => {
          marks.push({ accountId, modelId, resetAtMs })
        },
        getAvailableAccount: async (_provider: string, _model: string, exclude?: ReadonlySet<string>) => {
          picks.push(exclude)
          while (index < accounts.length && exclude?.has(accounts[index].id) === true) index += 1
          if (index >= accounts.length) return null
          const a = accounts[index]
          return {
            entry: { id: a.id },
            credential: buildQoderCredential(
              parseQoderTokenPayload({ token: a.token, refresh_token: 'r', user_id: `uid-${a.id}` }),
              { machineId: 'm-1' },
            ),
          }
        },
      }
      return { pool, marks, picks }
    }

    it('额度受限：标记当前账号该模型到 UTC+8 当日 24:00，并切到下一个账号', async () => {
      const { pool, marks, picks } = makePoolStub([
        { id: 'acct-A', token: 'tokA' },
        { id: 'acct-B', token: 'tokB' },
      ])

      // 第一次（acct-A）回额度错误，第二次（acct-B）回正常内容。
      // 用 Authorization 头区分是哪个账号发的请求。
      let call = 0
      const seenAuth: string[] = []
      const fetchImpl = vi.fn(async (_url: string, init: RequestInit) => {
        call += 1
        seenAuth.push(String((init.headers as Headers)?.get?.('Authorization') ?? ''))
        if (call === 1) {
          const inner = JSON.stringify({ code: 110, message: 'Billing daily count exceeded', type: 'model_error' })
          return new Response(
            `data:${JSON.stringify({ headers: {}, body: inner, statusCodeValue: 200 })}\n\n`,
            { status: 200, headers: { 'Content-Type': 'text/event-stream' } },
          )
        }
        return envelopeResponse([textFrame('新账号可用'), finishFrame])
      }) as unknown as typeof fetch

      const chunks = await collectWith(makeAdapter({
        fetchImpl,
        accountPool: pool as never,
        currentAccountId: () => 'acct-A',
      }), { model: 'qfmodel', messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }] })

      // ① 标记了 acct-A 的 qfmodel，时间落在未来（UTC+8 当日 24:00）
      expect(marks.length, '应标记一次额度受限').toBe(1)
      expect(marks[0].accountId).toBe('acct-A')
      expect(marks[0].modelId).toBe('qfmodel')
      expect(marks[0].resetAtMs).toBeGreaterThan(Date.now())

      // ② 取号时**传了 tried**（含刚失败的 acct-A），否则会拿回同一个账号
      expect(picks.length).toBeGreaterThan(0)
      expect(picks[0]?.has('acct-A'), 'tried 必须含刚失败的账号').toBe(true)

      // ③ 确实换账号重发（第二次请求存在）并拿到内容
      expect(call, '应换账号重发').toBe(2)
      expect(chunks.some((c) => c.type === 'text-delta')).toBe(true)
    })

    it('所有账号都受限时抛 QUOTA_EXCEEDED（不无限切换）', async () => {
      const { pool, marks } = makePoolStub([
        { id: 'acct-A', token: 'tokA' },
        { id: 'acct-B', token: 'tokB' },
      ])

      // 永远回额度错误 —— 两个账号都会被标记，然后如实失败
      const billingInner = JSON.stringify({ code: 110, message: 'Billing daily count exceeded', type: 'model_error' })
      const fetchImpl = vi.fn(async () => new Response(
        `data:${JSON.stringify({ headers: {}, body: billingInner, statusCodeValue: 200 })}\n\n`,
        { status: 200, headers: { 'Content-Type': 'text/event-stream' } },
      )) as unknown as typeof fetch

      await expect(collectWith(makeAdapter({
        fetchImpl,
        accountPool: pool as never,
        currentAccountId: () => 'acct-A',
      }), { model: 'qfmodel', messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }] }))
        .rejects.toMatchObject({ code: 'QUOTA_EXCEEDED' })

      // 两个账号都被标记（A 由 currentAccountId 标记，B 由切号后标记）
      expect(marks.map((m) => m.accountId)).toEqual(['acct-A', 'acct-B'])
    })

    it('无账号池时不切号，但仍如实抛 QUOTA_EXCEEDED（不吞错）', async () => {
      const inner = JSON.stringify({ code: 110, message: 'Billing daily count exceeded', type: 'model_error' })
      const fetchImpl = vi.fn(async () => new Response(
        `data:${JSON.stringify({ headers: {}, body: inner, statusCodeValue: 200 })}\n\n`,
        { status: 200, headers: { 'Content-Type': 'text/event-stream' } },
      )) as unknown as typeof fetch

      await expect(collectWith(makeAdapter({ fetchImpl, sleep: async () => {} }),
        { model: 'qfmodel', messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }] }))
        .rejects.toMatchObject({ code: 'QUOTA_EXCEEDED' })
    })

    it('标记时间恰为 UTC+8 次日 00:00（而非「1 小时后」这种错误兜底）', async () => {
      const { pool, marks } = makePoolStub([]) // 无候选 → 只标记、不切
      const inner = JSON.stringify({ code: 110, message: 'Billing daily count exceeded', type: 'model_error' })
      const fetchImpl = vi.fn(async () => new Response(
        `data:${JSON.stringify({ headers: {}, body: inner, statusCodeValue: 200 })}\n\n`,
        { status: 200, headers: { 'Content-Type': 'text/event-stream' } },
      )) as unknown as typeof fetch

      await expect(collectWith(makeAdapter({
        fetchImpl, accountPool: pool as never, currentAccountId: () => 'acct-A',
      }), { model: 'qfmodel', messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }] }))
        .rejects.toMatchObject({ code: 'QUOTA_EXCEEDED' })

      expect(marks.length).toBe(1)
      // ⚠️ 必须是 UTC+8 的整点日界（分钟/秒/毫秒为 0），
      // 而不是 `Date.now() + 1h` —— 后者带任意零头，且对按自然日结算的额度是错的。
      const marked = new Date(marks[0].resetAtMs + 8 * 3_600_000)
      expect(marked.getUTCMinutes(), '应为整点日界').toBe(0)
      expect(marked.getUTCSeconds()).toBe(0)
      expect(marked.getUTCMilliseconds()).toBe(0)
      expect(marked.getUTCHours()).toBe(0)
    })

    /**
     * 回归：**选号必须带上 `options.model`**。
     *
     * 真实缺陷（2026-10-26 实测）：`wiring.ts` 的接线是
     * `resolveCredential: () => ctx.resolveCredential(product.id)` —— 没有
     * modelId。而 `AccountPool.getAvailableAccount` 对空串**整体短路**限流过滤
     * （`if (modelId.length === 0) return true`），于是「额度已用尽的账号」
     * 在每个新请求里仍被优先选中：每次请求都先打一次必然失败的账号再换号，
     * 换号形同虚设（用户体感是「用完额度不会自动换号」）。
     *
     * 本用例锁死「适配器把 model 传下去」这一环：`resolveCredential` 收到的
     * 实参必须等于本次请求的模型。
     */
    it('resolveCredential 必须收到本次请求的 model（否则限流过滤被短路）', async () => {
      const seen: Array<string | undefined> = []
      const fetchImpl = vi.fn(async () => envelopeResponse([textFrame('ok'), finishFrame])) as unknown as typeof fetch

      await collectWith(makeAdapter({
        fetchImpl,
        resolveCredential: async (modelId?: string) => {
          seen.push(modelId)
          return cred
        },
      }), { model: 'dfmodel', messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }] })

      expect(seen.length, '应至少调用一次').toBeGreaterThan(0)
      // ⚠️ 空串 / undefined 都会让池的限流过滤短路，必须是模型 id 本身。
      expect(seen[0], 'resolveCredential 收到的 model 不能为空').toBe('dfmodel')
    })
  })
})
