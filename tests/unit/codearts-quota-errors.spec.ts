/**
 * CodeArts 的**配额/权益错误**分类与换号（2026-10-28 真机取证后补）。
 *
 * ## 为什么需要这个文件
 *
 * 探测时实测到上游对「该账号套餐没有这个模型的权益」回
 * **HTTP 403 + `TM.000010051`「…使用权益已耗尽…」**，而修前的实现：
 *
 * | 环节 | 修前行为 |
 * |---|---|
 * | `isAuthError(403)` | **恒 true** ⇒ 白刷一次凭据（真实 STS 网络往返） |
 * | `httpErrorCode(403)` | `'AUTH'` ⇒ 对外报 **401 authentication_error**（客户端提示「密钥无效」） |
 * | 换号 | **不发生** —— 而报文自己就列出了 5 个当前可用的模型 |
 * | 排队探测 | 对确定性错误白打一次上游请求 |
 *
 * 另有一条同族的**静默**缺陷（来源实测）：`isSseQueueErrorCode` 里 `429` 是裸子串，
 * 额度码 `InferHub.4291.200` 命中它 ⇒ 被当排队、静默重试 30 分钟、界面零输出。
 *
 * 本文件锁四组：
 * 1. 判据（403 权益耗尽 / SSE `4291` / 429 边界锚定）；
 * 2. HTTP 通道：写「UTC+8 当日 24:00」限流标记 + 换号 + 对外码是 `QUOTA_EXCEEDED`；
 * 3. SSE 通道：同语义（**两条通道各一份**，只测一条会让另一条潜伏）；
 * 4. 全部账号都受限时抛额度错误（不无限循环）。
 */

import { describe, expect, it, vi } from 'vitest'
import { credentialRef } from '../../src/providers/credential-ref.js'
import {
  __isSseQueueErrorCodeForTest, CHAT_API_BASE, CodeArtsAdapter, formatResetIn, isCodeArtsQuotaExhausted,
} from '../../src/providers/llm-adapter.js'
import type { CodeArtsCredential } from '../../src/providers/types.js'

const CREDENTIAL_REF = credentialRef('CODEARTS_ACCESS_TOKEN')

const CREDENTIAL: CodeArtsCredential = {
  access_key_id: 'AK', secret_access_key: 'SK', security_token: 'ST',
  expires_at: '2099-01-01T00:00:00Z',
}

/** 上游真实报文（2026-10-28 本机实测，逐字）。 */
const QUOTA_403_BODY = JSON.stringify({
  error_code: 'TM.000010051',
  error_msg: '多模态功能或当前所选模型的使用权益已耗尽，可选择如下模型: '
    + '[GLM-5.2, GLM-5.2-ArkTS-SPARK, glm-5.2-sft-harmony, openpangu-2.0-pro, openpangu-2.0-flash]。 '
    + '可免费升级到积分套餐获取更多权益。',
})

const streamOptions = {
  model: 'deepseek-v4.1-flash',
  messages: [],
  signal: new AbortController().signal,
} as never

/**
 * 构造适配器。
 *
 * @param responses - 依次返回的 chat 响应（用完后重复最后一个）。
 * @param pool - 账号池替身：`getAvailableAccount` 与 `updateModelRateLimit` 均记录调用。
 */
function makeAdapter(
  responses: Response[],
  pool?: {
    next?: { entry: { id: string }; credential: unknown }
    markCalls?: Array<{ accountId: string; modelId: string; resetAtMs: number }>
    getCalls?: Array<{ provider: string; modelId: string }>
  },
) {
  let index = 0
  const fetchImpl = (async () => {
    const response = responses[Math.min(index, responses.length - 1)]!
    index += 1
    return response
  }) as unknown as typeof fetch
  const markCalls = pool?.markCalls ?? []
  const getCalls = pool?.getCalls ?? []
  const accountPool = {
    async findAccountIdByCredential() { return 'acc-A' },
    async updateModelRateLimit(accountId: string, modelId: string, resetAtMs: number) {
      markCalls.push({ accountId, modelId, resetAtMs })
    },
    async getAvailableAccount(provider: string, modelId: string) {
      getCalls.push({ provider, modelId })
      const next = pool?.next
      if (next === undefined) return null
      // 只返回一次：下一个账号也受限时上层应据 tried 集合判定「全部受限」。
      pool!.next = undefined
      return next
    },
  }
  const adapter = new CodeArtsAdapter({
    credentialRef: CREDENTIAL_REF,
    resolveCredential: async () => CREDENTIAL,
    refresh: async () => {},
    fetchImpl,
    accountPool: accountPool as never,
  })
  return { adapter, markCalls, getCalls, fetchCount: () => index }
}

/** 消费一次 stream()，返回抛出的错误（成功则 undefined）。 */
async function drain(adapter: CodeArtsAdapter): Promise<unknown> {
  try {
    for await (const _chunk of adapter.stream(streamOptions)) {
      // 丢弃
    }
    return undefined
  } catch (error) {
    return error
  }
}

/** 一个最小的合法 SSE 响应（含正文，便于断言「换号后成功」）。 */
function okSse(text = 'hello'): Response {
  return new Response(
    `data: ${JSON.stringify({ choices: [{ delta: { content: text }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`,
    { status: 200, headers: { 'content-type': 'text/event-stream' } },
  )
}

/** HTTP 200 + SSE 内嵌额度错误（`InferHub.4291.200`）。 */
function quotaSse(): Response {
  return new Response(
    `data: ${JSON.stringify({ error_code: 'InferHub.4291.200', error_msg: 'insufficient quota' })}\n\n`,
    { status: 200, headers: { 'content-type': 'text/event-stream' } },
  )
}

describe('isSseQueueErrorCode（429 必须锚定为独立数字）', () => {
  it('★ 4291（额度耗尽）**不得**被判成可重试排队', () => {
    // 修前是裸子串 `429` ⇒ `4291` 命中 ⇒ 静默重试 30 分钟且界面零输出。
    expect(__isSseQueueErrorCodeForTest('InferHub.4291.200')).toBe(false)
    expect(__isSseQueueErrorCodeForTest('4291')).toBe(false)
  })

  it('真正的 429 限流仍必须命中（锚定不得过窄）', () => {
    expect(__isSseQueueErrorCodeForTest('InferHub.ModelArts.81111.429')).toBe(true)
    expect(__isSseQueueErrorCodeForTest('429 Too Many Requests')).toBe(true)
    expect(__isSseQueueErrorCodeForTest('HTTP 429')).toBe(true)
    expect(__isSseQueueErrorCodeForTest('TM.00001041')).toBe(true)
  })
})

describe('isCodeArtsQuotaExhausted（判据）', () => {
  it('认 HTTP 403 + TM.000010051（权益耗尽）', () => {
    expect(isCodeArtsQuotaExhausted(403, QUOTA_403_BODY)).toBe(true)
  })

  it('认 SSE 额度码 InferHub.4291.200 与 insufficient quota 文案', () => {
    expect(isCodeArtsQuotaExhausted(200, JSON.stringify({ error_code: 'InferHub.4291.200' }))).toBe(true)
    expect(isCodeArtsQuotaExhausted(200, JSON.stringify({ error_msg: 'insufficient quota' }))).toBe(true)
  })

  it('不把真正的认证失败误判成配额（APIG.0602 / invalid token）', () => {
    expect(isCodeArtsQuotaExhausted(401, JSON.stringify({ error_code: 'APIG.0602', error_msg: 'Invalid token' })))
      .toBe(false)
    expect(isCodeArtsQuotaExhausted(403, JSON.stringify({ error_msg: 'verify ak sk signature fail' })))
      .toBe(false)
  })

  it('不把普通 400 / 5xx 误判成配额', () => {
    expect(isCodeArtsQuotaExhausted(400, JSON.stringify({ error_code: 'ModelArts.81001' }))).toBe(false)
    expect(isCodeArtsQuotaExhausted(500, 'internal error')).toBe(false)
  })
})

describe('HTTP 通道：403 权益耗尽 → 标记 + 换号', () => {
  it('★ 写「UTC+8 当日 24:00」限流标记，并换到下一个账号成功', async () => {
    const pool = {
      next: { entry: { id: 'acc-B' }, credential: CREDENTIAL },
    }
    const { adapter, markCalls, getCalls } = makeAdapter(
      [new Response(QUOTA_403_BODY, { status: 403 }), okSse()],
      pool,
    )
    const error = await drain(adapter)
    expect(error, '换号后应当成功，不抛错').toBeUndefined()

    // ① 写了限流标记，且**按 UTC+8 自然日**（不是「1 小时后」）
    expect(markCalls).toHaveLength(1)
    const marked = markCalls[0]!
    expect(marked.accountId).toBe('acc-A')
    expect(marked.modelId).toBe('deepseek-v4.1-flash')
    const resetAt = new Date(marked.resetAtMs)
    // UTC+8 当日 24:00 == UTC 当日 16:00
    expect(resetAt.getUTCHours(), '按 UTC+8 自然日结算 ⇒ 解禁在 UTC 16:00').toBe(16)
    expect(resetAt.getUTCMinutes()).toBe(0)
    expect(marked.resetAtMs).toBeGreaterThan(Date.now())
    expect(marked.resetAtMs - Date.now(), '不超过 24 小时').toBeLessThanOrEqual(24 * 3_600_000)

    // ② 换号时**必须传 modelId**（不传会让模型级限流过滤整体短路，见 AGENTS.md 约定 13）
    expect(getCalls[0]).toEqual({ provider: 'codearts', modelId: 'deepseek-v4.1-flash' })
  })

  it('★ 不能白刷一次凭据（isAuthError 已排除配额），也不做排队探测', async () => {
    const refresh = vi.fn(async () => {})
    const adapter = new CodeArtsAdapter({
      credentialRef: CREDENTIAL_REF,
      resolveCredential: async () => CREDENTIAL,
      refresh,
      fetchImpl: (async () => new Response(QUOTA_403_BODY, { status: 403 })) as unknown as typeof fetch,
    })
    const error = await drain(adapter)
    expect(refresh, '配额错误与凭据无关，不得触发续期').not.toHaveBeenCalled()
    expect((error as { code?: string }).code).toBe('QUOTA_EXCEEDED')
  })

  it('★ 对外错误码是 QUOTA_EXCEEDED（不是 AUTH），文案带解禁时间与上游原文', async () => {
    const { adapter } = makeAdapter([new Response(QUOTA_403_BODY, { status: 403 })])
    const error = await drain(adapter) as { code: string; message: string }
    // ⚠️ 必须是字面量 `QUOTA_EXCEEDED`：共享常量是 `'QUOTA'`，客户端会把它替换成
    // 一句通用文案（我们写的解禁时间就没了），且本项目 gateway 的映射表不认 `'QUOTA'`。
    expect(error.code).toBe('QUOTA_EXCEEDED')
    expect(error.message).toContain('权益/额度已用尽')
    expect(error.message, '文案必须给出解禁时间').toMatch(/预计 .*后重置/)
    expect(error.message, '必须讲清按自然日结算').toContain('UTC+8')
    expect(error.message, '透出上游原文，用户才知道哪些模型可用').toContain('GLM-5.2')
  })
})

describe('SSE 通道：4291 额度耗尽 → 标记 + 换号', () => {
  it('★ 与 HTTP 通道同语义：写标记 + 换号成功', async () => {
    const pool = { next: { entry: { id: 'acc-B' }, credential: CREDENTIAL } }
    const { adapter, markCalls, getCalls } = makeAdapter([quotaSse(), okSse()], pool)
    const error = await drain(adapter)
    expect(error).toBeUndefined()
    expect(markCalls).toHaveLength(1)
    expect(markCalls[0]?.modelId).toBe('deepseek-v4.1-flash')
    expect(getCalls[0]?.modelId).toBe('deepseek-v4.1-flash')
  })

  it('★ 不得被当成排队：只发 1 次 chat（修前的裸 429 子串会命中 4291 ⇒ 重试 30 分钟）', async () => {
    const { adapter, fetchCount } = makeAdapter([quotaSse()])
    const error = await drain(adapter) as { code?: string }
    expect(error.code).toBe('QUOTA_EXCEEDED')
    // 排队路径会每 10 秒重发一次 chat + 探测状态端点；额度路径必须**立即**失败。
    expect(fetchCount(), '额度是确定性错误，不得重试').toBe(1)
  })
})

describe('全部账号都受限', () => {
  it('★ 抛 QUOTA_EXCEEDED 而不是继续循环', async () => {
    const { adapter, getCalls, fetchCount } = makeAdapter([new Response(QUOTA_403_BODY, { status: 403 })])
    const error = await drain(adapter) as { code?: string }
    expect(error.code).toBe('QUOTA_EXCEEDED')
    expect(getCalls, '没有可用账号时仍会问一次池子，但不会无限重试').toHaveLength(1)
    expect(fetchCount(), '只有一个账号 ⇒ 只发一次请求').toBe(1)
  })
})

describe('formatResetIn', () => {
  it('按量级给出人话（分钟 / 小时，保留一位小数）', () => {
    const now = Date.parse('2026-10-28T10:00:00+08:00')
    expect(formatResetIn(now, now)).toBe('即将重置')
    expect(formatResetIn(now + 30_000, now)).toBe('不到 1 分钟')
    expect(formatResetIn(now + 25 * 60_000, now)).toBe('25 分钟')
    expect(formatResetIn(now + 5.5 * 3_600_000, now)).toBe('5.5 小时')
    expect(formatResetIn(now + 14 * 3_600_000, now)).toBe('14 小时')
  })
})
