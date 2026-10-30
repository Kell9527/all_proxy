/**
 * TRAE 错误分类单元测试。
 *
 * 覆盖 `src/trae-errors.ts` 的 `classifyTraeError` 判定顺序与三个策略函数。
 * 判定顺序是本模块的核心契约（对齐 Go 端 `Classify` + `SOLOStreamError.Kind`），
 * 顺序错了会让「配额耗尽」被误判成可重试错误而反复重试一个永远不会成功的账号。
 */

import { describe, expect, it } from 'vitest'
import {
  classifyTraeError,
  classifyTraeStreamCode,
  isRotatableTraeStreamCode,
  isTraeTerminalError,
  recordsTraeRateLimit,
  shouldRotateTraeAccount,
} from '../../src/providers/trae-errors.js'
import { traeCooldownFor } from '../../src/providers/trae-cooldown-table.js'

describe('TRAE 错误分类', () => {
  it('body 含 1005 + plan 判为 hard-plan（权益不足）', () => {
    expect(classifyTraeError(400, '{"code":1005,"msg":"plan limit reached"}')).toBe('hard-plan')
    expect(classifyTraeError(200, '1005 plan')).toBe('hard-plan')
  })

  it('仅出现 1005 但不含 plan 字样时不判 hard-plan', () => {
    // 避免把无关的 code 1005 误判成权益不足。
    expect(classifyTraeError(400, '{"code":1005}')).toBe('client')
  })

  it('body 含 4008 判为 quota-exceeded（ide_credits 耗尽）', () => {
    expect(classifyTraeError(400, '{"code":4008}')).toBe('quota-exceeded')
    expect(classifyTraeError(200, 'Your requests have exceeded the quota')).toBe('quota-exceeded')
  })

  it('body 含 4011 判为 soft-rate（请求频率超限）', () => {
    expect(classifyTraeError(400, '{"code":4011}')).toBe('soft-rate')
  })

  it('quota-exceeded 优先于 4011（4008 更严重）', () => {
    expect(classifyTraeError(400, '4008 4011')).toBe('quota-exceeded')
  })

  it('HTTP 401 判为 session-dead（需重新登录）', () => {
    expect(classifyTraeError(401, '')).toBe('session-dead')
    expect(classifyTraeError(401, 'token invalid')).toBe('session-dead')
    expect(classifyTraeError(401, 'please login again')).toBe('session-dead')
  })

  it('HTTP 429 判为 soft-rate', () => {
    expect(classifyTraeError(429, 'too many requests')).toBe('soft-rate')
  })

  it('HTTP 404 判为 not-found', () => {
    expect(classifyTraeError(404, '')).toBe('not-found')
  })

  it('5xx 判为 server', () => {
    expect(classifyTraeError(500, '')).toBe('server')
    expect(classifyTraeError(503, 'service unavailable')).toBe('server')
  })

  it('其他 4xx 判为 client', () => {
    expect(classifyTraeError(400, 'bad param')).toBe('client')
    expect(classifyTraeError(403, '')).toBe('client')
  })

  it('2xx/3xx 判为 none', () => {
    expect(classifyTraeError(200, '')).toBe('none')
    expect(classifyTraeError(204, '')).toBe('none')
  })

  it('body 关键词优先于状态码（上游用 400 + 文案表达配额耗尽）', () => {
    // 若先按状态码判，400 会落到 client，于是反复重试一个永远不会成功的账号。
    expect(classifyTraeError(400, '4008')).toBe('quota-exceeded')
    expect(classifyTraeError(400, '1005 plan')).toBe('hard-plan')
  })
})

describe('TRAE 换号策略', () => {
  it('除 none 外每一类都换号（对齐 Go 每个分支都以 continue 结尾）', () => {
    for (const kind of ['hard-plan', 'soft-rate', 'session-dead', 'quota-exceeded', 'not-found', 'server', 'client'] as const) {
      expect(shouldRotateTraeAccount(kind), kind).toBe(true)
    }
    expect(shouldRotateTraeAccount('none')).toBe(false)
  })

  it('只有真正需要冷却的类别才记限流标记', () => {
    // session-dead / server / client 不是限流，记徽章会显示虚假信息。
    expect(recordsTraeRateLimit('hard-plan')).toBe(true)
    expect(recordsTraeRateLimit('soft-rate')).toBe(true)
    expect(recordsTraeRateLimit('not-found')).toBe(true)
    expect(recordsTraeRateLimit('quota-exceeded')).toBe(true)
    expect(recordsTraeRateLimit('session-dead')).toBe(false)
    expect(recordsTraeRateLimit('server')).toBe(false)
    expect(recordsTraeRateLimit('client')).toBe(false)
    expect(recordsTraeRateLimit('none')).toBe(false)
  })

  it('只有 session-dead 是终态（重试无意义）', () => {
    // 用途：TraeAuth.refresh 据此抛 RefreshTokenExpiredError 停止续期。
    // 网络抖动/5xx 必须走可重试路径，否则一次瞬时故障就让用户重新登录。
    expect(isTraeTerminalError('session-dead')).toBe(true)
    for (const kind of ['hard-plan', 'soft-rate', 'quota-exceeded', 'not-found', 'server', 'client', 'none'] as const) {
      expect(isTraeTerminalError(kind), kind).toBe(false)
    }
  })
})

/**
 * 流内 `event:error` 的**结构化码**判据（2026-10-24 真实报障，来源 `63a5c3f`）。
 *
 * ## 为什么必须与文案表分开测
 *
 * 上游用 HTTP 200 + SSE 下发 `code=1005` 且 `message` 为**空串**。旧实现把
 * `{code,message}` 序列化成 JSON 喂文案表 `classifyTraeError`，而它的
 * `hard-plan` 判据要求「`1005` 且含 `plan` 关键词」⇒ 判 `none` ⇒ 冷却 **0ms**
 * ⇒ 限流标记写在失败那一瞬间 ⇒ 下次选号立刻又选回同一个号。
 *
 * ⚠️ 这一组**不能**靠「改文案表」来通过：把 `plan` 关键词要求去掉，会让正文里
 * 恰好出现的数字 `1005` 被误判成权益不足（同仓 zcode 的裸子串判据就这么误伤过）。
 * 两条判据语义不同：文案表猜正文，结构化码表读上游枚举。
 */
describe('TRAE 流内结构化码（event:error）', () => {
  it('1005 即使 message 为空也判 hard-plan（这正是本次缺陷）', () => {
    // 文案表对同样的输入判 client / none —— 两者必须不同，见下面那条反向断言
    expect(classifyTraeStreamCode(1005)).toBe('hard-plan')
    expect(classifyTraeError(0, JSON.stringify({ code: 1005, message: '' }))).toBe('none')
  })

  it('三个可换号码各有正确类别', () => {
    expect(classifyTraeStreamCode(1005)).toBe('hard-plan')
    expect(classifyTraeStreamCode(4008)).toBe('quota-exceeded')
    expect(classifyTraeStreamCode(4011)).toBe('soft-rate')
  })

  it('表外码返回 undefined（不回落文案表）', () => {
    // 4001（模型不可调用）/ 4006（体积超限）刻意不在表内：换号无意义。
    expect(classifyTraeStreamCode(4001)).toBeUndefined()
    expect(classifyTraeStreamCode(4006)).toBeUndefined()
    expect(classifyTraeStreamCode(0)).toBeUndefined()
  })

  it('换号判据与类别表**共用同一张表**（不得各写一份）', () => {
    for (const code of [1005, 4008, 4011]) {
      expect(isRotatableTraeStreamCode(code), String(code)).toBe(true)
      expect(classifyTraeStreamCode(code), String(code)).toBeDefined()
    }
    for (const code of [4001, 4006, 0, 9999]) {
      expect(isRotatableTraeStreamCode(code), String(code)).toBe(false)
      expect(classifyTraeStreamCode(code), String(code)).toBeUndefined()
    }
  })

  it('流内 1005 的冷却必须 > 0（回归：曾经是 0ms，换号形同虚设）', () => {
    // ⚠️ 这条是本组的**要害**：类别判对但冷却为 0 的话，账号标记写在失败那一刻，
    // 选号立刻又选回它 —— 用户看到「换了号还是同一个号」而日志里一切正常。
    const kind = classifyTraeStreamCode(1005)!
    expect(traeCooldownFor(kind)).toBeGreaterThan(0)
    // 与 trae-credits 的 PlanLimit 同值（12h）：同一档位不能两处不同数
    expect(traeCooldownFor(kind)).toBe(12 * 3_600_000)
  })

  it('流内 4008 的冷却取 24h 档（不是兜底 1h）', () => {
    expect(traeCooldownFor(classifyTraeStreamCode(4008)!)).toBe(24 * 3_600_000)
  })

  it('流内 4011 的冷却取 60s 档（频率类不放大到小时级）', () => {
    expect(traeCooldownFor(classifyTraeStreamCode(4011)!)).toBe(60_000)
  })
})
