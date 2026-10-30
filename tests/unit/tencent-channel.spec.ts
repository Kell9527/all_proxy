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

/**
 * DSH 自己注入的三条（**不是**外部客户端泄漏）。
 *
 * ⚠️ 与前三家 Claude Code / ZCode 的本质差别：那三家是**概率性**命中
 * （要客户端把默认 system 整份发过来），而这三条是 DSH **每轮必带** ⇒
 * 漏登记 = 必然 400，且无法靠「换会话 / 清历史」规避。
 */
const DSH_IDENTITY = 'You are an AI agent powered by DeepSeek Harness'
const DSH_WEB_SURFACE = 'You are interacting with the user through the DeepSeek Harness Web GUI '
  + 'whose URL the runtime context names. When the user refers to "this page", "this GUI", '
  + 'or "this app" without naming another target, they mean this GUI.'
const DSH_FILE_REFERENCE = 'Tokens prefixed with @ are paths the user explicitly referenced. '
  + 'Relative paths resolve from the workspace root'

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
/**
 * DSH 自己注入的三条指纹（2026-10-30 从来源补齐）。
 *
 * 这组与上面那组**分开写**，因为它们锁的是另一件事：「DSH 每轮必带的句子是否
 * 都在表里」。上面那组只证明「表里的条目都被应用」—— 表里**没有**某一条时
 * 那组照样全绿，这正是这三条被漏了五轮的原因。
 */
describe('DSH 自身模板句（每轮必带，漏登记 = 必然 400）', () => {
  it('登记了身份首句', () => {
    expect(TENCNET_CONTENT_FINGERPRINTS_FOR_TESTS.some((r) => r.find === DSH_IDENTITY)).toBe(true)
  })

  it('登记了 Web 运行面两句（221 字符，切半会空跑）', () => {
    const rule = TENCNET_CONTENT_FINGERPRINTS_FOR_TESTS.find((r) => r.find === DSH_WEB_SURFACE)
    expect(rule).toBeDefined()
    // ⚠️ 长度本身就是判据：前缀二分实测 220 放行 / 221 拦，且切开后两半各自放行
    // ⇒ 这个 find 少一个字符就会静默空跑。
    expect(rule?.find.length).toBe(221)
  })

  it('登记了 @ 文件引用说明句（111 字符，且不含品牌词）', () => {
    const rule = TENCNET_CONTENT_FINGERPRINTS_FOR_TESTS.find((r) => r.find === DSH_FILE_REFERENCE)
    expect(rule).toBeDefined()
    expect(rule?.find.length).toBe(111)
    // ⚠️ 这条不含 DeepSeek Harness / dsh / DeepSeek —— 按品牌名普查必然漏掉。
    // 把「不含品牌词」写成断言，是为了让后人别再拿品牌名当筛选判据。
    expect(rule?.find.toLowerCase()).not.toContain('deepseek')
    expect(rule?.find.toLowerCase()).not.toContain('dsh')
  })

  it('三条都能被真实改写（不只「在表里」）', () => {
    for (const literal of [DSH_IDENTITY, DSH_WEB_SURFACE, DSH_FILE_REFERENCE]) {
      const out = rewriteTencentContentFingerprints(`head\n${literal}\ntail`, 'buddy')
      expect(out, literal.slice(0, 40)).not.toContain(literal)
    }
  })

  it('改写后出站文本里不再出现 DeepSeek Harness 品牌串', () => {
    // 身份句与 Web 面两句是本条改写的**真正收益**：不只是躲开字面量，
    // 而是让出站 system 里彻底没有自家 token（上游若把名单放宽成关键词就仍有效）。
    const payload = `${DSH_IDENTITY}\n\n${DSH_WEB_SURFACE}\n\n${DSH_FILE_REFERENCE}`
    const out = rewriteTencentContentFingerprints(payload, 'buddy')
    expect(out).not.toContain('DeepSeek Harness')
    // 但「@ 路径引用」这个功能说明本身必须保留（那是模型读文件的行为约束）
    expect(out).toContain('Tokens prefixed with @ are paths the user explicitly referenced.')
  })

  it('Web 面两句的 replace 只去品牌串，其余逐字不动', () => {
    const rule = TENCNET_CONTENT_FINGERPRINTS_FOR_TESTS.find((r) => r.find === DSH_WEB_SURFACE)
    // 除品牌串外必须完全一致 —— 后半句是「this page / this GUI」的指代约定，
    // 改一个字都可能让模型误解用户的指代。
    expect(rule?.replace).toBe(rule?.find.replace('the DeepSeek Harness Web GUI', 'the harness Web GUI'))
    expect(rule?.replace.length).toBe((rule?.find.length ?? 0) - 'DeepSeek '.length)
  })

  it('@ 引用句的 replace 只调整语序，后半段逐字不动', () => {
    const rule = TENCNET_CONTENT_FINGERPRINTS_FOR_TESTS.find((r) => r.find === DSH_FILE_REFERENCE)
    // 前半句（@ 语法说明）必须原样保留 —— 少了它模型不知道 @ 是什么
    expect(rule?.replace.startsWith('Tokens prefixed with @ are paths the user explicitly referenced. ')).toBe(true)
    // ⚠️ 后半段是防模型编造文件内容的核心约束（目录 list / 用 read /
    // 不得声称已读过 / 引号语法），一个字都不许删。
    expect(rule?.replace).toContain('Paths resolve relative to the workspace root')
  })
})
})

