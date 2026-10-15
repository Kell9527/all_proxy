/**
 * OfficeAce 账号的**积分到期查询**与「临期优先」选号。
 *
 * 与 `loomy-balance-selector.ts` 同构（同一套缓存/TTL/失败降级模式），差别只
 * 在**排序依据**：Loomy 按「今日赠送 > 永久」，本项目按
 * 「临期 > 长期 > 永久」（2026-10-15 用户指定，理由见
 * `officeace-expiry-rank.ts` 的模块头）。
 *
 * ## 为什么是「选号前查一次」而不是「账号条目里存一个字段」
 *
 * 积分包的到期时间只存在于上游 `/v1/subscription`，账号池里没有这个信息。
 * 两种取法：
 *
 * | 方案 | 代价 |
 * |---|---|
 * | 选号前查（本模块） | N 个账号 = N 次只读请求，故加 60 秒 TTL |
 * | 查询结果落盘到账号条目 | 要动 state schema / sanitize / 备份兼容，且依赖「用户记得点刷新」才更新 |
 *
 * 选号的实时性比省一次请求更重要：**陈旧的到期分桶会直接导致临期积分作废**
 * （用户报障的原始形态）。OfficeAce 账号数通常个位数，60 秒 TTL 下同一轮
 * 对话不重复查。
 *
 * ## 只读，无副作用
 *
 * 查询走 `fetchOfficeAceCloudSubscription`（**只读**），**不是**
 * `fetchOfficeAceBalanceDetailed` —— 后者会在查询前顺带触发「自动领当日
 * 福利」的 POST。选号发生在**推理请求路径**上，那条路径不该有写操作；
 * 领福利由管理端面板拉余额时做（同一处、按 ref 每小时节流）。
 */

import type { OfficeAceCredential } from './officeace-auth.js'
import { fetchOfficeAceCloudSubscription } from './officeace-credits.js'
import {
  OFFICEACE_EXPIRY_WINDOW_DAYS,
  officeaceExpiryTier,
  officeaceTierUsable,
  rankOfficeAceAccountsByExpiry,
  splitOfficeAceCreditGroups,
  type OfficeAceAccountExpiry,
  type OfficeAceExpiryOptions,
  type OfficeAceExpiryTier,
} from './officeace-expiry-rank.js'

/** 到期分桶缓存 TTL（毫秒）。与 Loomy 的余额缓存同值：同一轮对话内不重复查。 */
export const OFFICEACE_EXPIRY_CACHE_TTL_MS = 60_000

/** 一条待选账号（调用方从账号池取出，顺序即手动优先级）。 */
export interface OfficeAceExpiryCandidate {
  id: string
  credentialRef: string
}

/** 一个账号的到期分桶（含查询失败标记）。 */
export interface OfficeAceAccountExpiryEntry extends OfficeAceAccountExpiry {
  /** 查询是否成功；false 时三个分桶字段均为 undefined。 */
  ok: boolean
  /** 查询失败原因（诊断用）。 */
  error?: string
}

/** 选号依赖（便于单测注入）。 */
export interface OfficeAceExpiryDeps {
  /** 解析某账号的凭据；返回 undefined 表示不可用。 */
  resolveCredential: (credentialRef: string) => Promise<unknown>
  /** 注入的 fetch（测试用）。 */
  fetcher?: typeof fetch
  /** 当前时间（测试用）。 */
  now?: () => number
  /** TTL 覆盖（测试用）。 */
  ttlMs?: number
  /** 「长期 / 临期」窗口天数覆盖（测试用）。 */
  windowDays?: number
  /** 日志（选号结果留痕：用户要能验证「是不是真的先用了临期」）。 */
  logger?: (message: string) => void
}

/** 一个账号的缓存条目。 */
interface CacheEntry {
  at: number
  value: OfficeAceAccountExpiryEntry
}

/**
 * 到期分桶缓存 + 选号器。
 *
 * 生命周期与适配器实例一致（每个 OfficeAceAdapter 一个），故不需要全局状态、
 * 也不会跨 provider 串味。
 */
export class OfficeAceExpirySelector {
  private readonly cache = new Map<string, CacheEntry>()

  constructor(private readonly deps: OfficeAceExpiryDeps) {}

  /** 清空缓存（账号增删、手动刷新后调用）。 */
  invalidate(accountId?: string): void {
    if (accountId === undefined) this.cache.clear()
    else this.cache.delete(accountId)
  }

  /**
   * 查一个账号的积分到期分桶（带 TTL 缓存）。
   *
   * ⚠️ **查询失败不抛错**：返回 `ok: false` 的条目，由分档逻辑归入 `unknown`
   * 档。让「一个号查不到」不至于让整个选号失败。
   */
  async expiryOf(account: OfficeAceExpiryCandidate): Promise<OfficeAceAccountExpiryEntry> {
    const now = this.deps.now?.() ?? Date.now()
    const ttl = this.deps.ttlMs ?? OFFICEACE_EXPIRY_CACHE_TTL_MS
    const cached = this.cache.get(account.id)
    if (cached !== undefined && now - cached.at < ttl) return cached.value

    const value = await this.fetchExpiry(account)
    this.cache.set(account.id, { at: now, value })
    return value
  }

  /** 真正发请求查一次（凭据解析 → 形状校验 → 云侧直读 → 分桶）。 */
  private async fetchExpiry(account: OfficeAceExpiryCandidate): Promise<OfficeAceAccountExpiryEntry> {
    let raw: unknown
    try {
      raw = await this.deps.resolveCredential(account.credentialRef)
    } catch (error) {
      return {
        id: account.id,
        ok: false,
        error: `读取凭据失败：${error instanceof Error ? error.message : String(error)}`,
      }
    }
    const credential = asOfficeAceCredential(raw)
    if (credential === undefined) {
      return { id: account.id, ok: false, error: '凭据未配置或字段不完整' }
    }

    const summary = await fetchOfficeAceCloudSubscription(credential, this.deps.fetcher ?? fetch)
    if (summary === undefined) {
      return { id: account.id, ok: false, error: '积分查询失败（凭据失效或上游暂不可用）' }
    }
    const split = splitOfficeAceCreditGroups(
      summary.creditGroups,
      this.deps.windowDays ?? OFFICEACE_EXPIRY_WINDOW_DAYS,
      this.deps.now?.() ?? Date.now(),
    )
    return { id: account.id, ok: true, ...split }
  }

  /**
   * 从候选账号中按**到期优先**选一个。
   *
   * 排序规则见 `officeace-expiry-rank.ts`：临期 → 长期 → 永久 → 查不到 →
   * 已用光。**档内保持传入顺序**（= 用户手动顺序）。
   *
   * ⚠️ 返回的是**第一个**候选（而不是随机），因为档内顺序 = 用户手动顺序。
   *
   * ⚠️ **锁定永久积分时（`allowPermanent: false`）**：只剩永久桶（或查不到）
   * 的账号一律不可用。若**全部候选都不可用**，本方法返回 `undefined` ——
   * 调用方据此报「无可用账号」的明确错误（用户要求），而不是硬着头皮烧永久
   * 积分。未锁定时「所有号的余额都是 0」仍返回第一个候选：让上游去报余额
   * 不足，错误信息比「没有可用账号」更准确。
   *
   * @param candidates - 已按 `enabled` 过滤过的候选（顺序即手动优先级）。
   * @param options - `allowPermanent` 为 false 时禁止消耗永久积分。
   * @returns 选中的账号 + 其到期分桶；**锁定永久积分且无可用账号**时
   *   返回 undefined。
   */
  async select(
    candidates: readonly OfficeAceExpiryCandidate[],
    options: OfficeAceExpiryOptions = {},
  ): Promise<{ account: OfficeAceExpiryCandidate; expiry: OfficeAceAccountExpiryEntry; tier: OfficeAceExpiryTier } | undefined> {
    if (candidates.length === 0) return undefined

    // 并发查询：账号数通常个位数，并发比串行快得多。
    const expiries = await Promise.all(candidates.map((c) => this.expiryOf(c)))
    const byId = new Map(candidates.map((c, i) => [c.id, { account: c, expiry: expiries[i]! }]))

    const ranked = rankOfficeAceAccountsByExpiry(expiries, options)
    const first = ranked[0]
    if (first === undefined) return undefined
    const tier = officeaceExpiryTier(first, options)

    // ⚠️ 仅在**锁定永久积分**时才把「全部不可用」判成无可用账号 ——
    //    理由见方法注释（未锁定时让上游去报错，错误更准确）。
    if (options.allowPermanent === false && !officeaceTierUsable(tier, options)) {
      return undefined
    }

    const picked = byId.get(first.id)
    if (picked === undefined) return undefined
    this.deps.logger?.(
      `[officeace] 按积分到期选号：${picked.account.id}（档位 ${tier}，`
      + `临期 ${picked.expiry.expiring ?? '?'} / 长期 ${picked.expiry.longTerm ?? '?'} / `
      + `永久 ${picked.expiry.permanent ?? '?'}）`,
    )
    return { account: picked.account, expiry: picked.expiry, tier }
  }
}

/**
 * 把账号池解析出来的**未知形状**对象收窄成 OfficeAce 凭据。
 *
 * ⚠️ 必须先校验再交给 `fetchOfficeAceCloudSubscription`：那个函数内部直接读
 * `credential.access.length`，而池里的凭据是 `JSON.parse` 出来的
 * `Record<string, unknown>` —— 缺字段时 `.length` 会抛 TypeError，把一次
 * 「查不到余额」升级成选号崩溃。
 */
function asOfficeAceCredential(raw: unknown): OfficeAceCredential | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined
  const c = raw as Partial<OfficeAceCredential>
  if (typeof c.access !== 'string' || c.access.length === 0) return undefined
  if (typeof c.securityToken !== 'string' || c.securityToken.length === 0) return undefined
  return c as OfficeAceCredential
}
