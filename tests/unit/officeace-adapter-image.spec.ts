/**
 * `officeace-adapter-image.spec.ts` —— OfficeAce 图片输入（多模态）守卫。
 *
 * ## 背景（2026-10-13 实测）
 *
 * 「deepseek-v4.1-flash 发不了图片」：端点和模型都支持（1×1 PNG 探针 200 并
 * 正确描述图片），缺的是**适配器** —— 共享的 `serializeMessages` 把 content
 * 压成纯文本，图片块被静默丢弃。
 *
 * ## 守的不变量
 *
 * | # | 不变量 | 违反的后果 |
 * |---|--------|-----------|
 * | 1 | 多模态模型的带图请求含 `{type:'image_url'}` parts | 图片静默消失（原始缺陷） |
 * | 2 | 纯文本模型收到图片 → **早失败**、文案点名支持的模型 | 上游 400，整轮报废 |
 * | 3 | 字节读取失败 → `[image unavailable]` 占位符 | 静默吞图，用户以为模型看到了 |
 * | 4 | 目录 `inputModalities` 与实测表一致（闸门） | 误报 ⇒ 选错模型发图必 400 |
 * | 5 | 无图请求保持纯字符串 content | 不给纯文本请求强加 parts 形状 |
 *
 * ⚠️ 不发真实网络：`fetchImpl` 捕获请求体后回最小 SSE。
 */

import { describe, expect, it } from 'vitest'
import { OfficeAceAdapter } from '../../src/providers/officeace-adapter.js'
import { OFFICEACE_MODELS } from '../../src/providers/officeace-product.js'
import type { OfficeAceCredential } from '../../src/providers/officeace-auth.js'

const CREDENTIAL: OfficeAceCredential = {
  modelAppKey: 'k', modelAppSecret: 's', maasBaseUrl: 'https://officeace.example',
  access: 'ak', secret: 'sk', securityToken: 'tok', projectId: 'p',
  expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
  refreshToken: 'r', dpopPrivateJwk: {},
}

/** 最小 SSE 响应（捕获请求体后立即结束流）。 */
function sseResponse(): Response {
  return new Response('data: {"choices":[{"delta":{"content":"","role":"assistant","reasoning_content":""}}]}\n\ndata: [DONE]\n\n', {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  })
}

function makeAdapter(
  fetchBody: (body: unknown) => void,
  readImage?: () => Promise<{ data: Uint8Array; mediaType: string } | undefined>,
) {
  return new OfficeAceAdapter({
    resolveCredential: async () => CREDENTIAL,
    // ⚠️ 按 URL 分流：`listModels` 的 probe 要求 models 路径回 **JSON**，
    //    chat 路径回 SSE —— 一个桩应付两种 content-type。
    fetchImpl: (async (url: string | URL | Request, init?: RequestInit) => {
      const u = String(url)
      if (u.includes('/v2/models')) {
        return new Response(JSON.stringify({ data: OFFICEACE_MODELS.map((m) => ({ id: m.id })) }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      }
      fetchBody(JSON.parse(String(init?.body ?? '{}')))
      return sseResponse()
    }) as typeof fetch,
    readImage: readImage ?? (async () => ({ data: new Uint8Array([1, 2, 3]), mediaType: 'image/png' })),
  })
}

function imageMessage(model: string) {
  return {
    model,
    messages: [{
      role: 'user' as const,
      content: [
        { type: 'text', text: '图里是什么？' },
        { type: 'image' as const, attachment: { attachmentId: 'att-1' } },
      ],
    }],
  }
}

async function drain(gen: AsyncGenerator<unknown>): Promise<void> {
  for await (const _ of gen) { /* 消费到结束 */ }
}

describe('OfficeAce 图片输入', () => {
  it('① 多模态模型的带图请求升级为 image_url parts（原始缺陷：图片被压成纯文本）', async () => {
    let captured: Record<string, unknown> | undefined
    const adapter = makeAdapter((b) => { captured = b as Record<string, unknown> })
    await drain(adapter.stream(imageMessage('deepseek-v4.1-flash') as never))

    const messages = captured?.messages as Array<{ role: string; content: unknown }>
    const user = messages.find((m) => m.role === 'user')
    expect(Array.isArray(user?.content), '带图 user 消息仍是字符串 ⇒ 图片被丢弃（原始缺陷复现）').toBe(true)
    const parts = user?.content as Array<Record<string, unknown>>
    expect(parts.some((p) => p.type === 'image_url')).toBe(true)
    expect(parts.some((p) => p.type === 'text' && p.text === '图里是什么？')).toBe(true)
    // data URL 形态（MaaS 实测接受的形态）
    const img = parts.find((p) => p.type === 'image_url') as { image_url?: { url?: string } }
    expect(img.image_url?.url).toMatch(/^data:image\/png;base64,/)
  })

  it('② 纯文本模型收到图片 → 早失败且文案点名支持的模型（不让上游 400 报废整轮）', async () => {
    let called = 0
    const adapter = makeAdapter(() => { called += 1 })
    await expect(drain(adapter.stream(imageMessage('qwen3-32b') as never)))
      .rejects.toThrow(/不支持图片输入.*DeepSeek-V4\.1-Flash/)
    expect(called, '闸门拦截后仍发了请求 ⇒ 上游会 400').toBe(0)
  })

  it('③ 字节读取失败 → 占位符而不是静默吞图', async () => {
    let captured: Record<string, unknown> | undefined
    const adapter = makeAdapter(
      (b) => { captured = b as Record<string, unknown> },
      async () => undefined,
    )
    await drain(adapter.stream(imageMessage('deepseek-v4.1-flash') as never))
    const messages = captured?.messages as Array<{ role: string; content: Array<Record<string, unknown>> }>
    const user = messages.find((m) => m.role === 'user')!
    expect(
      user.content.some((p) => p.type === 'text' && p.text === '[image unavailable]'),
      '读取失败时既没有 image_url 也没有占位符 ⇒ 图片被静默吞掉',
    ).toBe(true)
  })

  it('④ 目录 inputModalities 与实测表一致（闸门）', async () => {
    const adapter = makeAdapter(() => {})
    const models = await adapter.listModels('officeace')
    const multimodal = models.filter((m) => m.inputModalities?.includes('image')).map((m) => m.id)
    const expected = OFFICEACE_MODELS.filter((m) => (m as { multimodal?: boolean }).multimodal === true).map((m) => m.id)
    expect(multimodal, '目录声明与实测表不一致 ⇒ 闸门误报/漏报').toEqual(expected)
    // 实测过支持的模型必须在列
    expect(multimodal).toContain('deepseek-v4.1-flash')
    expect(multimodal).toContain('kimi-k2.6')
    // 实测过不支持的必须在门外
    expect(multimodal).not.toContain('qwen3-32b')
    expect(multimodal).not.toContain('glm-5.3')
  })

  it('⑤ 无图请求保持纯字符串 content（不给纯文本请求强加 parts 形状）', async () => {
    let captured: Record<string, unknown> | undefined
    const adapter = makeAdapter((b) => { captured = b as Record<string, unknown> })
    await drain(adapter.stream({
      model: 'glm-5.3',
      messages: [{ role: 'user', content: '你好' }],
    } as never))
    const messages = captured?.messages as Array<{ role: string; content: unknown }>
    const user = messages.find((m) => m.role === 'user')
    expect(user?.content).toBe('你好')
  })

  it('⑥ max_tokens 低于 4096 被丢弃（防思考链烧光预算、正文零产出）', async () => {
    let captured: Record<string, unknown> | undefined
    const adapter = makeAdapter((b) => { captured = b as Record<string, unknown> })
    await drain(adapter.stream({
      model: 'deepseek-v4.1-flash',
      messages: [{ role: 'user', content: 'hi' }],
      maxTokens: 64,
    } as never))
    expect(captured).not.toHaveProperty('max_tokens')

    let captured2: Record<string, unknown> | undefined
    const adapter2 = makeAdapter((b) => { captured2 = b as Record<string, unknown> })
    await drain(adapter2.stream({
      model: 'deepseek-v4.1-flash',
      messages: [{ role: 'user', content: 'hi' }],
      maxTokens: 8192,
    } as never))
    expect(captured2?.max_tokens).toBe(8192)
  })
})
