/**
 * 腾讯系渠道适配在**适配器层**的接线回归。
 *
 * `tencent-channel.spec.ts` 锁的是辅助函数契约；本文件锁的是「适配器真的调用了
 * 它们」—— 一个没人调用的辅助函数是最典型的静默失效。
 *
 * 每个用例都走真实的 `prepareCall().stream()` 路径，只在 `fetchImpl` 处截获
 * 实际发出的请求（头与体），不 mock 适配器内部。
 */
import { credentialRef } from '../../src/providers/credential-ref.js'
import { describe, expect, it } from 'vitest'
import { BuddyAdapter } from '../../src/providers/buddy-adapter.js'
import type { BuddyCredential } from '../../src/providers/buddy.js'
import { WORKBUDDY } from '../../src/providers/product.js'

const CREDENTIAL_REF = credentialRef('BUDDY_ACCESS_TOKEN')
const CC_FB = 'To give feedback, users should report the issue at https://github.com/anthropics/claude-code/issues'
const CC_ID = "You are Claude Code, Anthropic's official CLI for Claude"

function makeCredential(): BuddyCredential {
  return {
    access_token: 'AT',
    refresh_token: 'RT',
    expires_at: String(Date.now() + 7_200_000),
    token_type: 'Bearer',
    scope: '',
    domain: 'www.workbuddy.ai',
  }
}

/** 一个最小可用的 SSE 响应（正文即结束，无工具调用）。 */
function sseResponse(): Response {
  return new Response('data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n', {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  })
}

interface Captured {
  headers: Headers
  body: Record<string, unknown>
}

/** 驱动真实适配器并把实际出站的「头 + 体」截获下来。 */
async function captureRequest(
  options: {
    messages: unknown[]
    system?: string
    model?: string
  },
): Promise<Captured> {
  let captured: Captured | undefined
  const adapter = new BuddyAdapter({
    credentialRef: CREDENTIAL_REF,
    resolveCredential: async () => makeCredential(),
    refresh: async () => {},
    product: WORKBUDDY,
    fetchRemoteModels: async () => [],
    fetchImpl: async (_url, init) => {
      captured = {
        headers: new Headers(init?.headers as HeadersInit),
        body: JSON.parse(String(init?.body)) as Record<string, unknown>,
      }
      return sseResponse()
    },
  } as never)

  const prepared = await adapter.prepareCall('workbuddy', options.model ?? 'fast-model')
  for await (const _chunk of prepared.stream({
    model: options.model ?? 'fast-model',
    messages: options.messages,
    ...(options.system !== undefined ? { system: options.system } : {}),
    signal: new AbortController().signal,
  } as never)) {
    // 只需把流消费完
  }

  if (captured === undefined) throw new Error('适配器没有发出请求')
  return captured
}

describe('腾讯系渠道：X-Conversation-* 三头必须齐全', () => {
  const CONV = ['X-Conversation-ID', 'X-Conversation-Request-ID', 'X-Conversation-Message-ID'] as const

  it('每次 chat 请求都带齐三枚非空头', async () => {
    const { headers } = await captureRequest({ messages: [{ role: 'user', content: 'hi' }] })
    for (const name of CONV) {
      const value = headers.get(name)
      expect(value, name).toBeTruthy()
      expect(value, name).not.toBe('')
    }
  })

  it('值是 32 位 hex（对齐官方客户端形态）', async () => {
    const { headers } = await captureRequest({ messages: [{ role: 'user', content: 'hi' }] })
    for (const name of CONV) {
      expect(headers.get(name), name).toMatch(/^[0-9a-f]{32}$/)
    }
  })

  it('逐请求换新值（三枚是一次性 id，不是会话身份）', async () => {
    const a = await captureRequest({ messages: [{ role: 'user', content: 'hi' }] })
    const b = await captureRequest({ messages: [{ role: 'user', content: 'hi' }] })
    expect(a.headers.get('X-Conversation-ID')).not.toBe(b.headers.get('X-Conversation-ID'))
  })
})

describe('腾讯系渠道：内容指纹改写必须覆盖 assistant 正文', () => {
  /** 从请求体里取出指定角色的正文（字符串或 blocks 都归一成文本）。 */
  function contentOfRole(body: Record<string, unknown>, role: string): string {
    const messages = body.messages as Array<{ role?: string; content?: unknown }> | undefined
    const message = messages?.find((m) => m.role === role)
    const content = message?.content
    if (typeof content === 'string') return content
    if (Array.isArray(content)) {
      return content
        .map((part) => (typeof part === 'object' && part !== null && typeof (part as { text?: unknown }).text === 'string'
          ? (part as { text: string }).text
          : ''))
        .join('')
    }
    return ''
  }

  it('assistant 历史里的反馈句被改写（否则整条会话每轮 400）', async () => {
    const { body } = await captureRequest({
      messages: [
        { role: 'user', content: 'read the doc' },
        { role: 'assistant', content: `The doc said: ${CC_FB}` },
        { role: 'user', content: 'now check the license' },
      ],
    })
    const assistant = contentOfRole(body, 'assistant')
    expect(assistant).toContain('project issue tracker')
    expect(assistant).not.toContain('https://github.com/anthropics/claude-code/issues')
  })

  it('system 消息里的身份句被改写（含非首位 system）', async () => {
    const { body } = await captureRequest({
      messages: [
        { role: 'system', content: `${CC_ID}. You are an interactive CLI tool.` },
        { role: 'user', content: 'hi' },
      ],
    })
    expect(contentOfRole(body, 'system')).not.toContain(CC_ID)
  })

  it('options.system 这个独立产出点也被改写（它绕过 serializeMessages）', async () => {
    const { body } = await captureRequest({
      messages: [{ role: 'user', content: 'hi' }],
      system: `Instructions:\n${CC_FB}`,
    })
    expect(contentOfRole(body, 'system')).toContain('project issue tracker')
  })

  it('user 消息保持原样（实测上游不拦，改了等于篡改用户原话）', async () => {
    const { body } = await captureRequest({
      messages: [{ role: 'user', content: CC_FB }],
    })
    expect(contentOfRole(body, 'user')).toBe(CC_FB)
  })
})
