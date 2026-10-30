/**
 * **入站 `image_url` 块的透传回归**（2026-10-29 真实缺陷）。
 *
 * ## 症状
 *
 * 用 `qodercn/dfmodel`（DeepSeek-Flash · 免费）从 DSH 发图片，模型回答
 * 「我看不到图片 / 没有收到图片」。HTTP 200、正文正常、上游**零报错**。
 *
 * ## 根因（两处同因，缺一不可）
 *
 * 网关把图片交成上游要的 `{type:'image_url', image_url:{url}}` 形态
 * （`/v1/messages` 由 `anthropic-protocol.ts` 翻译、OpenAI 原生请求本就如此），
 * 而共享序列化层只认 harness 原生的 `{type:'image', attachment}`：
 *
 * 1. `collectImages()` 对 `image_url` **零命中** ⇒ 适配器认为「本请求无图」⇒
 *    传给 `serializeMessages` 的 `imageUrls` 是 `undefined`；
 * 2. `serializeMessages` 又在 `imageUrls === undefined` 时**整段跳过**
 *    `userContentParts` ⇒ 那些块连兜底的 `[image unavailable]` 占位符都没有，
 *    直接静默消失。
 *
 * 两处**必须同修**：只修 ① 会让适配器去读一个不存在的附件；
 * 只修 ② 会因「有表才升级」的判据而仍然不生效。
 *
 * ⚠️ 这与插件侧 `analyzeImage` 那条已修缺陷（`9acddc7`）**完全同型**
 * —— 本项目移植时只搬了「附件块」那条腿。
 */
import { describe, expect, it } from 'vitest'
import { collectImages, serializeMessages, userContentParts } from '../../src/shared/openai-compat.js'
import { translateAnthropicRequest } from '../../src/gateway/anthropic-protocol.js'

const PNG = 'data:image/png;base64,iVBORw0KGgo='

/** 取第一条 user 消息的 content parts（断言用）。 */
function firstUserParts(wire: ReturnType<typeof serializeMessages>): unknown {
  const user = wire.find((m) => m.role === 'user')
  return user?.content
}

describe('serializeMessages：入站 image_url 块必须透传（不是静默丢弃）', () => {
  it('① OpenAI 原生形态：image_url 块进入多模态 parts', () => {
    const messages = [{
      role: 'user',
      content: [
        { type: 'text', text: '这张图里是什么？' },
        { type: 'image_url', image_url: { url: PNG } },
      ],
    }]
    // 网关路径**没有**附件 ref ⇒ 适配器传 undefined。
    const wire = serializeMessages(messages, undefined)
    expect(firstUserParts(wire), '图片块被整块丢弃了').toEqual([
      { type: 'text', text: '这张图里是什么？' },
      { type: 'image_url', image_url: { url: PNG } },
    ])
  })

  it('② Anthropic 形态：/v1/messages 翻译后的 image_url 同样透传', () => {
    const translated = translateAnthropicRequest({
      model: 'qodercn/dfmodel',
      max_tokens: 256,
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: '这张图里是什么？' },
          { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'iVBORw0KGgo=' } },
        ],
      }],
    })
    expect(translated.ok).toBe(true)
    const wire = serializeMessages(translated.value.messages, undefined)
    const parts = firstUserParts(wire) as Array<{ type: string; image_url?: { url?: string } }>
    expect(Array.isArray(parts), '图片消息退化成了纯文本').toBe(true)
    expect(parts.some((p) => p.type === 'image_url')).toBe(true)
    expect(parts.find((p) => p.type === 'image_url')?.image_url?.url).toBe(PNG)
  })

  it('③ 回归：纯文本消息仍是字符串形态（上游对字符串兼容性最好）', () => {
    const wire = serializeMessages([{ role: 'user', content: '你好' }], undefined)
    expect(wire).toEqual([{ role: 'user', content: '你好' }])
  })

  it('④ 回归：harness 原生附件块路径逐字节不变', () => {
    const wire = serializeMessages(
      [{
        role: 'user',
        content: [
          { type: 'text', text: 'hi' },
          { type: 'image', attachment: { attachmentId: 'a1' } },
        ],
      }],
      new Map([['a1', PNG]]),
    )
    expect(firstUserParts(wire)).toEqual([
      { type: 'text', text: 'hi' },
      { type: 'image_url', image_url: { url: PNG } },
    ])
  })

  it('⑤ 只有图片、没有文本时也不能丢（纯图消息）', () => {
    const wire = serializeMessages(
      [{ role: 'user', content: [{ type: 'image_url', image_url: { url: PNG } }] }],
      undefined,
    )
    expect(firstUserParts(wire)).toEqual([{ type: 'image_url', image_url: { url: PNG } }])
  })

  it('⑥ 畸形 image_url（缺 url / 空串）不产生空块，也不虚报有图', () => {
    const parts = userContentParts(
      [
        { type: 'image_url', image_url: {} },
        { type: 'image_url', image_url: { url: '' } },
      ],
      new Map(),
    )
    expect(parts, '畸形块被当成了真图片').toBeUndefined()
  })
})

describe('collectImages：附件 ref 与入站 image_url 是两条互不干扰的通路', () => {
  it('image_url 不产生附件 ref（它自带字节，无需 readImage）', () => {
    const refs = new Map<string, unknown>()
    collectImages(
      [
        { type: 'image_url', image_url: { url: PNG } },
        { type: 'image', attachment: { attachmentId: 'a1' } },
      ],
      refs,
    )
    expect([...refs.keys()]).toEqual(['a1'])
  })
})
