/**
 * 腾讯系渠道适配的回归用例（移植自 `deepseek-harness-codearts`）。
 *
 * 治的是 `HTTP 400` + `code 11128` 的**两个不同子原因**：
 *
 * 1. `msg:"request illegal"` —— 网关对**部分账号**做「渠道校验」：三枚
 *    `X-Conversation-*` 必须同时存在且非空；
 * 2. `msg:"Illegal API invocation from an unapproved channel"` —— 内容级风控，
 *    拦 `system` / **`assistant` 正文**里的客户端模板句。
 *
 * 这些用例只锁「代码按这个范围做」，**锁不住范围本身对不对**（那只有真实请求能证）。
 */
import { describe, expect, it } from 'vitest'
import {
  TENCNET_CONTENT_FINGERPRINTS_FOR_TESTS,
  isTencentContentFingerprintProvider,
  rewriteTencentContentFingerprints,
} from '../../src/providers/tencent-fingerprint.js'
import {
  TENCENT_CONVERSATION_HEADERS,
  applyTencentConversationHeaders,
} from '../../src/providers/tencent-conversation-headers.js'

const CC_ID = "You are Claude Code, Anthropic's official CLI for Claude"
const CC_FB = 'To give feedback, users should report the issue at https://github.com/anthropics/claude-code/issues'
const ZCODE = 'Main branch (you will usually use this for PRs)'

describe('tencent conversation headers', () => {
  it('writes all three official headers', () => {
    const headers = new Headers()
    applyTencentConversationHeaders(headers)
    for (const name of TENCENT_CONVERSATION_HEADERS) {
      expect(headers.get(name), name).toBeTruthy()
    }
  })

  it('uses 32-char hex values (official client shape)', () => {
    const headers = new Headers()
    applyTencentConversationHeaders(headers)
    for (const name of TENCENT_CONVERSATION_HEADERS) {
      expect(headers.get(name), name).toMatch(/^[0-9a-f]{32}$/)
    }
  })

  it('issues fresh values per request (they are one-shot ids, not session identity)', () => {
    const a = new Headers()
    const b = new Headers()
    applyTencentConversationHeaders(a)
    applyTencentConversationHeaders(b)
    expect(a.get('X-Conversation-ID')).not.toBe(b.get('X-Conversation-ID'))
  })
})

describe('tencent content fingerprints', () => {
  it('only applies to the two Tencent providers', () => {
    expect(isTencentContentFingerprintProvider('buddy')).toBe(true)
    expect(isTencentContentFingerprintProvider('workbuddy')).toBe(true)
    expect(isTencentContentFingerprintProvider('qoder')).toBe(false)
    // 非腾讯系必须原样返回（同一份字符串内容）
    expect(rewriteTencentContentFingerprints(CC_FB, 'qoder')).toBe(CC_FB)
  })

  it('rewrites each registered literal to its meaning-preserving replacement', () => {
    for (const { find, replace } of TENCNET_CONTENT_FINGERPRINTS_FOR_TESTS) {
      expect(rewriteTencentContentFingerprints(`prefix ${find} suffix`, 'workbuddy'))
        .toBe(`prefix ${replace} suffix`)
    }
  })

  it('matches case-insensitively (the upstream filter does)', () => {
    const out = rewriteTencentContentFingerprints(CC_FB.toUpperCase(), 'buddy')
    expect(out).not.toContain('https://github.com/anthropics')
  })

  it('rewrites every occurrence, not just the first', () => {
    const out = rewriteTencentContentFingerprints(`${CC_ID} / ${CC_ID}`, 'buddy')
    expect(out).not.toContain(CC_ID)
    expect(out.match(/Anthropic's CLI for Claude/g)).toHaveLength(2)
  })

  it('returns fingerprint-free text byte-identical (prefix-cache safety)', () => {
    const clean = 'You are a helpful assistant.\n\nDo the thing.'
    expect(rewriteTencentContentFingerprints(clean, 'workbuddy')).toBe(clean)
  })

  it('does not generalise: a one-word variant passes through untouched', () => {
    // 实测上游是逐字符字面量匹配 ⇒ 改写变体会篡改用户文本，必须不做。
    const variant = 'To give feedback, users should report the issue at our own tracker'
    expect(rewriteTencentContentFingerprints(variant, 'workbuddy')).toBe(variant)
  })

  it('keeps the whole ZCode sentence registered (a shorter find would be a no-op)', () => {
    // 实测：砍掉前半/后半即放行 ⇒ find 必须写整句。
    const find = TENCNET_CONTENT_FINGERPRINTS_FOR_TESTS
      .find((rule) => rule.find === ZCODE)?.find
    expect(find).toBe(ZCODE)
  })
})

