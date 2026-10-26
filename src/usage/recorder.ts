/**
 * 把网关的 {@link RequestRecord} 转成 {@link UsageRecord} 并落盘。
 *
 * ## 为什么单独一层
 *
 * 网关只知道「这次请求发生了什么」，不知道「用量库长什么样」。这一层负责
 * **口径换算**，而换算规则里有两条容易搞错、且错了很难发现的地方：
 *
 * 1. **`prompt_tokens` 必须含缓存**（内部 `inputTokens` 是未缓存输入）。
 *    直接用 `inputTokens` 会让命中缓存的请求看起来 prompt 变小 —— 用户拿
 *    响应体里的 `prompt_tokens` 对不上用量页，会以为统计漏了。
 * 2. **`firstByteMs` 用 `null` 而不是 0**。0 会被 `AVG()` 当成「瞬时响应」
 *    拉低平均值，让「上游变慢了」这种问题被掩盖。
 *
 * 另外这里也负责**回填 API Key 的额度计数**（`recordUsage`），因为只有
 * 换算完成后才知道这次花了多少 token。
 */

import type { RequestRecord } from '../gateway/server.js'
import type { UsageStore, UsageRecord } from './store.js'
import type { Logger } from '../pool/store.js'
import type { ApiKeyStore } from '../auth/api-keys.js'

/** 记录器的依赖。 */
export interface UsageRecorderOptions {
  store: UsageStore
  /** API Key 存储（回填额度计数）；省略则不计额度。 */
  apiKeys?: ApiKeyStore
  logger?: Logger
  /** 时钟（测试注入）。 */
  now?: () => number
}

/**
 * 创建一个「请求完成」处理器。
 *
 * ⚠️ **保证不抛错**：它被网关在请求热路径上调用，任何异常都会变成用户的
 * 500 —— 而用量统计失败绝不该影响用户的请求。所有异常在此吞掉并记告警。
 */
export function createUsageRecorder(options: UsageRecorderOptions): (record: RequestRecord) => void {
  const { store, apiKeys, logger } = options
  const now = options.now ?? (() => Date.now())

  return function recordRequest(record: RequestRecord): void {
    try {
      const usage = toUsageRecord(record, now())
      store.record(usage)
      // 回填 key 的累计额度。只在有实际 token 消耗时写，避免每个请求都落盘
      // 一次 API Key 文档（那会把热路径变成磁盘写密集）。
      const tokens = usage.promptTokens + usage.completionTokens
      if (apiKeys !== undefined && tokens > 0 && record.callerId !== 'anonymous') {
        try {
          apiKeys.recordUsage(record.callerId, tokens)
        } catch (error) {
          logger?.warn(`[usage] 回填 key 额度失败 ${record.callerId}: ${String(error)}`)
        }
      }
    } catch (error) {
      logger?.warn(`[usage] 记录失败 ${record.requestId}: ${String(error)}`)
    }
  }
}

/**
 * 换算口径。
 *
 * ⚠️ `promptTokens` 含缓存（见文件头）。若改动这里，请同步
 * `tests/unit/usage.spec.ts` 里「与响应体 prompt_tokens 一致」的断言 ——
 * 那条断言就是防止这个口径被无意改回去的。
 */
export function toUsageRecord(record: RequestRecord, nowMs: number): UsageRecord {
  const cacheRead = record.cacheReadTokens
  const cacheWrite = record.cacheWriteTokens
  return {
    requestId: record.requestId,
    at: new Date(nowMs).toISOString(),
    keyId: record.callerId,
    keyName: record.callerName,
    provider: record.provider ?? '',
    model: record.model,
    upstreamModel: record.upstreamModel ?? '',
    // ⚠️ 规格明确：必须记**实际完成请求的账号**。适配器在轮换时会登记，
    // 故这里取的是登记值而不是「池里的第一个账号」。
    accountId: record.accountId ?? '',
    reasoningEffort: record.reasoningEffort ?? '',
    promptTokens: record.inputTokens + cacheRead + cacheWrite,
    completionTokens: record.outputTokens,
    cacheReadTokens: cacheRead,
    cacheWriteTokens: cacheWrite,
    stream: record.stream,
    durationMs: record.durationMs,
    // 用 null 而不是 0（见文件头）。
    firstByteMs: record.firstByteMs ?? null,
    finishReason: record.finishReason ?? '',
    status: record.status,
    errorCode: record.errorCode ?? '',
  }
}
