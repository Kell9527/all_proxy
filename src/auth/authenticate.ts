/**
 * 把 {@link ApiKeyStore} 接到网关的入站鉴权钩子上。
 *
 * ## 为什么单独一层
 *
 * 存储层（`auth/api-keys.ts`）只回答「这把 key 有效吗、超限了吗」，
 * 不懂 HTTP；网关只要求「给我一个 `AuthResult`」，不懂 key 的存储形态。
 * 这一层负责把失败原因翻译成**对外错误** —— 翻译规则本身就是安全策略，
 * 值得单独成文：
 *
 * | 失败原因 | 对外 | 为什么 |
 * |---|---|---|
 * | 缺凭据 | 401 `invalid_api_key` | 规格要求 |
 * | key 不存在 | 401 `invalid_api_key` | **不得**泄露「该 key 是否存在」 |
 * | key 已禁用 | 401 `invalid_api_key` | 同上：禁用与不存在对外不可区分 |
 * | 速率超限 | 429 `rate_limit_exceeded` | key 已被证实有效，提示重试不构成泄露 |
 * | 额度用尽 | 429 `quota_exceeded` | 同上，且客户端据此**停止**重试 |
 *
 * ⚠️ 前三条共用**完全一致**的文案与状态码。若「已禁用」回一条更具体的消息，
 * 攻击者就能拿一批候选 key 探出哪些曾经存在过（进而定向爆破）。
 */

import type { IncomingMessage } from 'node:http'
import type { AuthResult } from '../gateway/server.js'
import { gatewayError, gatewayErrorWithRetry } from '../gateway/errors.js'
import { ApiKeyStore, extractApiKey, type ApiKeyFailure } from './api-keys.js'

/** 三条「无效」失败共用的文案（刻意不含任何区分信息）。 */
const INVALID_MESSAGE = '无效的 API Key'

/** 把存储层的失败原因翻译为对外错误。 */
export function failureToAuthResult(failure: ApiKeyFailure): AuthResult {
  switch (failure.kind) {
    case 'missing':
    case 'invalid':
    case 'disabled':
      return { ok: false, error: gatewayError(401, 'invalid_api_key', INVALID_MESSAGE) }
    case 'rate_limited':
      return {
        ok: false,
        error: gatewayErrorWithRetry(
          429,
          'rate_limit_exceeded',
          `请求过于频繁，请 ${Math.ceil(failure.retryAfterMs / 1000)} 秒后重试`,
          failure.retryAfterMs,
        ),
      }
    case 'quota_exhausted':
      return {
        ok: false,
        error: gatewayError(429, 'quota_exceeded', '该 API Key 的额度已用尽'),
      }
  }
}

/**
 * 创建一个基于 API Key 的入站鉴权函数。
 *
 * 返回的函数会顺带**登记本次使用**（`markUsed`），使管理端能看到
 * 「这把 key 最近什么时候被用过」——那是判断 key 是否该作废的主要依据。
 */
export function createApiKeyAuthenticator(
  store: ApiKeyStore,
  logger?: { warn(message: string): void },
): (req: IncomingMessage) => AuthResult {
  return function authenticate(req: IncomingMessage): AuthResult {
    const plaintext = extractApiKey(req.headers)
    const result = store.authenticate(plaintext)
    if (!result.ok) return failureToAuthResult(result.failure)
    try {
      store.markUsed(result.context.id)
    } catch (error) {
      // 登记失败不该让请求失败：它只是诊断信息。
      logger?.warn(`[auth] 登记 key 使用失败 ${result.context.id}: ${String(error)}`)
    }
    return {
      ok: true,
      caller: {
        id: result.context.id,
        name: result.context.name,
        scope: { providers: result.context.record.providers, models: result.context.record.models },
      },
    }
  }
}
