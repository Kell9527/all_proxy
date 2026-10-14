/**
 * `accio-adapter.spec.ts` —— Accio 适配器的本实现守卫。
 *
 * ## 为什么另写而不照搬来源 1247 行的 spec
 *
 * 来源的 `accio-adapter.spec.ts` 大量断言 `createModelCatalog` 共享骨架、
 * `RemoteCatalogGate`、`canonical-models` 聚合补丁等**本项目没有的机器**
 * （本项目无跨渠道聚合）。本文件只锁**本实现真正承担**的判据：
 *
 * | # | 不变量 | 违反的后果 |
 * |---|--------|-----------|
 * | 1 | 对外 id 是「人话」slug、上行 body 用上游 `modelCode` | 发 slug ⇒ 模型不回复（误导性） |
 * | 2 | 图片通路未实测 ⇒ 收到图片显式 `UNSUPPORTED_CONTENT` | 静默丢图 |
 * | 3 | `token` 在 body（不在 Authorization 头） | 恒流内 402 |
 * | 4 | `system_instruction` 是**字符串** | 对象形态恒 HTTP 200 + 流内 400 |
 * | 5 | HTTP 200 + 非 event-stream（风控 HTML）显式报错 | 报「模型未返回内容」，真因被掩盖 |
 * | 6 | 401 刷新后**把新 token 写回 body** 再重试 | 重发旧 token，分支结构性失效 |
 * | 7 | 工具调用分片合并成**一次调用一帧** | harness 执行同一工具 N 次 |
 *
 * ⚠️ 不发真实网络：`fetchImpl` 捕获请求后回最小 SSE。
 */

import { describe, expect, it, vi } from 'vitest'
import {
  AccioAdapter,
  accioModelCodeOf,
  accioModelIdOf,
  mergeAccioToolArgs,
} from '../../src/providers/accio-adapter.js'
import { normalizeAccioModel } from '../../src/providers/accio-auth.js'
import type { AccioCredential } from '../../src/providers/accio.js'
import type { AccioFallbackModel } from '../../src/providers/accio-product.js'

const CREDENTIAL: AccioCredential = {
  access_token: 'at-old',
  refresh_token: 'rt',
  expires_at: Date.now() + 3_600_000,
  region: 'cn',
}

/** 一条兜底模型（含不可读的 modelCode）。 */
const MODEL: AccioFallbackModel = {
  id: '1Drift-F8hS3mK7pL2n',
  name: 'Qwen 3.8 Flash',
  contextWindow: 1_000_000,
  supportsImage: true,
  multiple: 0.03,
  efforts: ['low', 'high', 'max'],
  defaultEffort: 'high',
}

function sseResponse(body: string, contentType = 'text/event-stream'): Response {
  return new Response(body, { status: 200, headers: { 'content-type': contentType } })
}

/** 最小成功 SSE：一帧正文 + done。 */
const OK_SSE = 'data: {"content":{"role":"model","parts":[{"text":"ok"}]}}\ndata: [DONE]\n\n'

async function drain(gen: AsyncIterable<unknown>): Promise<void> {
  for await (const _ of gen) { /* consume */ }
}

function makeAdapter(options: {
  credential?: AccioCredential | null
  responses?: Array<Response | ((url: string, init?: RequestInit) => Response)>
  models?: AccioFallbackModel[]
  refresh?: () => Promise<void>
} = {}) {
  const credential = options.credential === undefined ? CREDENTIAL : options.credential ?? undefined
  const responses = [...(options.responses ?? [])]
  const fetched: Array<{ url: string; init?: RequestInit }> = []
  const fetcher = vi.fn(async (url: string, init?: RequestInit) => {
    fetched.push({ url, init })
    const next = responses.shift()
    if (next === undefined) throw new Error(`unexpected fetch: ${url}`)
    return typeof next === 'function' ? next(url, init) : next
  })
  const adapter = new AccioAdapter({
    resolveCredential: async () => credential,
    refresh: options.refresh ?? (async () => {}),
    fetchImpl: fetcher as unknown as typeof fetch,
    utdid: 'test-utdid',
    ...options.models === undefined ? {} : { fetchRemoteModels: async () => options.models! },
  })
  return { adapter, fetched, fetcher }
}

describe('Accio slug ↔ modelCode 映射', () => {
  it('对外 id 是展示名归一后的 slug', () => {
    expect(accioModelIdOf(MODEL)).toBe('qwen-3-8-flash')
  })

  it('⚠️ 上行反查回上游 modelCode（发 slug 会让模型不回复）', () => {
    expect(accioModelCodeOf([MODEL], 'qwen-3-8-flash')).toBe('1Drift-F8hS3mK7pL2n')
  })

  it('未知 slug 原样返回（不静默改成空模型名）', () => {
    expect(accioModelCodeOf([MODEL], 'unknown-model')).toBe('unknown-model')
  })
})

describe('Accio 适配器 · 目录', () => {
  it('兜底表：listModels 返回 slug id + 倍率拼进 name', async () => {
    const { adapter } = makeAdapter()
    const models = await adapter.listModels('accio')
    const flash = models.find((m) => m.id === 'qwen-3-8-flash')
    expect(flash?.name).toBe('Qwen 3.8 Flash · x0.03')
    // ⚠️ 图片通路未实测 ⇒ 省略 inputModalities（三态里的「未知」）。
    expect(flash).not.toHaveProperty('inputModalities')
  })

  it('resolveModel 用**不带倍率**的裸名', async () => {
    const { adapter } = makeAdapter()
    const resolved = await adapter.resolveModel('accio', 'qwen-3-8-flash')
    expect(resolved.name).toBe('Qwen 3.8 Flash')
    expect(resolved.context?.contextWindow).toBe(1_000_000)
  })

  it('listAllModels 同步（不 await 远端）', () => {
    const { adapter } = makeAdapter()
    const all = adapter.listAllModels()
    expect(all.some((m) => m.id === 'qwen-3-8-flash')).toBe(true)
  })
})

describe('Accio 适配器 · 请求构造', () => {
  it('⚠️ token 在 body（不在 Authorization 头），上行用 modelCode', async () => {
    const { adapter, fetched } = makeAdapter({ responses: [sseResponse(OK_SSE)] })
    await drain(adapter.stream({ model: 'qwen-3-8-flash', messages: [{ role: 'user', content: 'hi' }] } as never))
    const call = fetched.find((f) => f.url.includes('/api/adk/llm/generateContent'))!
    const body = JSON.parse(String(call.init?.body)) as Record<string, unknown>
    expect(body.token).toBe('at-old')
    expect(body.model).toBe('1Drift-F8hS3mK7pL2n')
    const headers = call.init?.headers as Record<string, string>
    expect(headers.Authorization).toBeUndefined()
    // sg_k = md5(requestId)
    expect(call.url).toContain('sg_k=')
  })

  it('⚠️ system_instruction 是**字符串**（对象形态恒流内 400）', async () => {
    const { adapter, fetched } = makeAdapter({ responses: [sseResponse(OK_SSE)] })
    await drain(adapter.stream({
      model: 'qwen-3-8-flash',
      messages: [{ role: 'user', content: 'hi' }],
      system: '你是助手',
    } as never))
    const body = JSON.parse(String(fetched[0]!.init?.body)) as Record<string, unknown>
    expect(typeof body.system_instruction).toBe('string')
    expect(body.system_instruction).toBe('你是助手')
  })
})

describe('Accio 适配器 · 守卫', () => {
  it('⚠️ 图片未实测 ⇒ 显式 UNSUPPORTED_CONTENT（不静默丢图）', async () => {
    const { adapter } = makeAdapter()
    const error = await drain(adapter.stream({
      model: 'qwen-3-8-flash',
      messages: [{ role: 'user', content: [{ type: 'image', attachment: { attachmentId: 'a1' } }] }],
    } as never)).catch((e: unknown) => e)
    expect((error as { code?: string }).code).toBe('UNSUPPORTED_CONTENT')
  })

  it('⚠️ HTTP 200 + HTML（风控拦截页）显式报错，不报「模型没返回内容」', async () => {
    const { adapter } = makeAdapter({ responses: [sseResponse('<html>deny</html>', 'text/html')] })
    const error = await drain(adapter.stream({ model: 'qwen-3-8-flash', messages: [{ role: 'user', content: 'hi' }] } as never))
      .catch((e: unknown) => e)
    expect(String((error as Error).message)).toContain('未返回事件流')
    expect((error as { code?: string }).code).toBe('SERVER')
  })

  it('⚠️ 401 刷新后把**新 token** 写回 body 再重试', async () => {
    let refreshes = 0
    const { adapter, fetched } = makeAdapter({
      responses: [
        new Response('{}', { status: 401 }),
        sseResponse(OK_SSE),
      ],
      refresh: async () => { refreshes += 1; CREDENTIAL.access_token = 'at-new' },
    })
    await drain(adapter.stream({ model: 'qwen-3-8-flash', messages: [{ role: 'user', content: 'hi' }] } as never))
    expect(refreshes).toBe(1)
    const sendCalls = fetched.filter((f) => f.url.includes('/generateContent'))
    expect(sendCalls).toHaveLength(2)
    const retryBody = JSON.parse(String(sendCalls[1]!.init?.body)) as Record<string, unknown>
    expect(retryBody.token).toBe('at-new')
    expect(retryBody.request_id).toBe(
      (JSON.parse(String(sendCalls[0]!.init?.body)) as Record<string, unknown>).request_id,
    )
    // 复原，避免影响其它用例
    CREDENTIAL.access_token = 'at-old'
  })
})

describe('mergeAccioToolArgs（分片合并）', () => {
  it('累积式（后一份以前一份为前缀）⇒ 取最后一份', () => {
    expect(mergeAccioToolArgs(['{"a":1', '{"a":1,"b":2}'])).toBe('{"a":1,"b":2}')
  })

  it('增量式（非前缀）⇒ 依次拼接', () => {
    expect(mergeAccioToolArgs(['{"a":', '1}'])).toBe('{"a":1}')
  })

  it('全空 ⇒ 空串（不编造）', () => {
    expect(mergeAccioToolArgs(['', ''])).toBe('')
  })
})

describe('normalizeAccioModel（目录条目归一化）', () => {
  it('visible!==true 剔除', () => {
    expect(normalizeAccioModel({ modelCode: 'x', visible: false })).toBeUndefined()
  })

  it('档位：数组为空但 default 有值 ⇒ 单档', () => {
    const model = normalizeAccioModel({
      modelCode: 'x', modelDisplayName: 'X', visible: true,
      reasoningEfforts: null, defaultReasoningEffort: 'max',
    })
    expect(model?.efforts).toBeUndefined()
    expect(model?.defaultEffort).toBe('max')
  })

  it('multimodal 是二值投影（表达不了「未知」）', () => {
    expect(normalizeAccioModel({ modelCode: 'x', visible: true, multimodal: true })?.supportsImage).toBe(true)
    expect(normalizeAccioModel({ modelCode: 'x', visible: true })?.supportsImage).toBe(false)
  })
})
