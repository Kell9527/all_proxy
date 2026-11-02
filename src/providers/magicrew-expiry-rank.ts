/**
 * Magicrew（超级麦吉 / MagiCrew）账号的**积分到期分档**与「临期优先」选号。
 *
 * 与 `officeace-expiry-rank.ts` / `officeace-expiry-selector.ts` 同构（同一套
 * 分档 / 稳定排序 / 60 秒 TTL 缓存 / 查询失败降级），差别只在**输入形状**：
 * OfficeAce 吃自己的 `creditGroups`，Magicrew 吃标准的 `CreditPackage[]`
 * （`fetchMagicrewBalance` 的产物）。
 *
 * ## 为什么需要它（2026-11-02 用户要求）
 *
 * 来源侧把这件事做在泛型化的 `BuddyBalanceSelector` 上（非 buddy product 必填
 * `fetchBalance`）。本项目没有那个泛型选号器，故按 OfficeAce 的既有范式
 * 单写一份 —— **判据必须逐格一致**，否则面板显示「临期 2000」却被永久账号
 * 抢走请求。
 *
 * ## 判据与面板**逐字同源**
 *
 * | 档位 | 判据 | 前端落桶 |
 * |---|---|---|
 * | 临期 | 有到期时间，且距到期 **< 窗口**（默认 15 天） | 红（`expiring`）+ 倒计时 |
 * | 长期 | 有到期时间，且距到期 **≥ 窗口** | 黄（`longTerm`） |
 * | 永久 | **没有**到期时间（合成的「永久积分」包） | 绿（`permanent`） |
 *
 * 三条口径对齐点（少一条就会与面板分家）：
 * 1. **窗口天数同值** —— {@link MAGICREW_EXPIRY_WINDOW_DAYS} 与后端
 *    `CREDIT_EXPIRY_WINDOW_DAYS`、前端 `credit-expiry.js` 的常量必须相同；
 * 2. **「已失效 / 剩余 ≤ 0 不计入」** —— 与前端 `splitCreditsByExpiry` 同判；
 * 3. **到期时间读 `expiredTime`（ISO 串）** —— 不是来源的 `deductionEndTime`。
 *
 * ## 只读，且不写任何状态
 *
 * 查询走 `fetchMagicrewBalance`（纯 GET）。选号发生在**推理请求路径**上，
 * 那条路径不该有写操作 —— 签到是独立的定时任务 / 手动按钮。
 */

import type { CreditBalance, CreditPackage } from './credits.js'
import type { MagicrewProduct } from './magicrew-product.js'

/**
 * 「长期 / 临期」分桶窗口天数。
 *
 * ⚠️ 与 `admin/credits-endpoint.ts` 的 `CREDIT_EXPIRY_WINDOW_DAYS`、
 * 前端 `plugin-src/client/credit-expiry.js` 的 `CREDIT_EXPIRY_WINDOW_DAYS`
 * **三者必须同值**（现在都是 15）。改一处不改其余处，症状是面板显示的口径
 * 与选号实际用的口径不一致 —— 用户看到「长期」的桶被当成「临期」优先消耗。
 */
export const MAGICREW_EXPIRY_WINDOW_DAYS = 15

/** 账号到期档位。数字越小越优先。 */
export const MAGICREW_EXPIRY_TIER = Object.freeze({
  /** 有临期余额（距到期不足窗口天数）—— 优先消耗它（不用就作废）。 */
  expiring: 0,
  /** 无临期，有长期余额。 */
  longTerm: 1,
  /** 只有永久余额（无到期时间的桶）。 */
  permanent: 2,
  /** 余额查询失败 —— 不知道有没有，但不是「确定为 0」。 */
  unknown: 3,
  /** 查到了，但可用余额为 0（或锁定永久积分时的 permanent-only）。 */
  empty: 4,
} as const)

export type MagicrewExpiryTier = (typeof MAGICREW_EXPIRY_TIER)[keyof typeof MAGICREW_EXPIRY_TIER]

/** 参与分档的账号到期信息（字段缺失表示查询失败）。 */
export interface MagicrewAccountExpiry {
  id: string
  /** 临期桶剩余合计；`undefined` = 查询失败。 */
  expiring?: number
  /** 长期桶剩余合计。 */
  longTerm?: number
  /** 永久桶剩余合计。 */
  permanent?: number
  /** 最早的临期到期时刻（毫秒）；无临期包时为 `null`（诊断/日志用）。 */
  earliestExpiringAt?: number | null
  /** 查询是否成功（`empty` 与 `unknown` 的分野）。 */
  ok?: boolean
}

/** 分档选项。 */
export interface MagicrewExpiryOptions {
  /** 是否允许消耗永久积分。默认 `true`（解锁）。 */
  allowPermanent?: boolean
  /** 「长期 / 临期」的分桶窗口天数，缺省 {@link MAGICREW_EXPIRY_WINDOW_DAYS}。 */
  windowDays?: number
}

/** 分桶结果。 */
export interface MagicrewExpirySplit {
  expiring: number
  longTerm: number
  permanent: number
  /** 最早的临期到期时刻（毫秒）；无临期包或临期包都已过期时为 `null`。 */
  earliestExpiringAt: number | null
}

/** 读一个包的到期时刻（毫秒）；无到期时间返回 `null`（= 永久）。 */
export function magicrewPackageExpiryMs(pkg: CreditPackage): number | null {
  const raw = pkg.expiredTime
  if (typeof raw !== 'string' || raw.length === 0) return null
  const parsed = Date.parse(raw)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null
}

/**
 * 把积分包按到期时间分成三档。
 *
 * 与前端 `splitCreditsByExpiry` 逐行同构（同一判据、同一窗口、同一条
 * 「`active !== true` / 剩余 ≤ 0 不计入」）—— 口径一致是硬要求：
 * 面板显示「临期 N」而选号不认它，用户会以为功能坏了。
 *
 * @param packages - `fetchMagicrewBalance` 返回的 `packages`。
 * @param windowDays - 「长期 / 临期」分界天数。
 * @param now - 当前时刻（测试注入）。
 */
export function splitMagicrewCreditPackages(
  packages: readonly CreditPackage[] | undefined,
  windowDays: number = MAGICREW_EXPIRY_WINDOW_DAYS,
  now: number = Date.now(),
): MagicrewExpirySplit {
  const windowMs = Math.max(0, Number(windowDays)) * 24 * 60 * 60 * 1000
  const split: MagicrewExpirySplit = { expiring: 0, longTerm: 0, permanent: 0, earliestExpiringAt: null }
  for (const pkg of packages ?? []) {
    if (!pkg || pkg.active !== true) continue
    const remaining = Number(pkg.remaining)
    if (!Number.isFinite(remaining) || remaining <= 0) continue
    const end = magicrewPackageExpiryMs(pkg)
    if (end === null) {
      split.permanent += remaining
    } else if (end - now < windowMs) {
      // ⚠️ 只统计**未过期**的临期包进 `earliestExpiringAt`：已过期的扣不到，
      //    它的时刻会让「最早临期」永久停在过去，倒计时显示器会一直说「已过期」。
      if (end > now) {
        split.expiring += remaining
        if (split.earliestExpiringAt === null || end < split.earliestExpiringAt) {
          split.earliestExpiringAt = end
        }
      }
    } else {
      split.longTerm += remaining
    }
  }
  return split
}

/** 读成一个有限正数；其余一律 0（档位判定只关心「有没有」）。 */
function positiveNumber(value: unknown): number {
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0
}

/**
 * 账号的到期档位。
 *
 * ⚠️ `unknown` 与 `empty` 的**判据是 `ok`**，不是「三个桶都是 0」：
 * 查询失败（`ok === false`）与「查到了但确实用光」在档位上都要排到末尾，
 * 但**锁定永久积分时的可用性判定不同**（见 {@link magicrewTierUsable}）。
 */
export function magicrewExpiryTier(expiry: MagicrewAccountExpiry): MagicrewExpiryTier {
  if (positiveNumber(expiry.expiring) > 0) return MAGICREW_EXPIRY_TIER.expiring
  if (positiveNumber(expiry.longTerm) > 0) return MAGICREW_EXPIRY_TIER.longTerm
  if (positiveNumber(expiry.permanent) > 0) return MAGICREW_EXPIRY_TIER.permanent
  return expiry.ok === true ? MAGICREW_EXPIRY_TIER.empty : MAGICREW_EXPIRY_TIER.unknown
}

/**
 * 该档位是否「可用」（可承载请求）。
 *
 * - 未锁定：只有 `empty`（确定为 0）不可用；`unknown` 仍可用 —— 查询失败可能
 *   是暂时的，账号其实还有额度，排进候选让上游去报错比直接说「没有账号」
 *   更诚实（与 OfficeAce / Loomy 的既有取舍一致）。
 * - **锁定永久积分**（`allowPermanent: false`）：只有 `expiring` / `longTerm`
 *   可用。`permanent` / `unknown` / `empty` 一律不可用 —— 用户要的是「永久
 *   积分不参与」，不确定的账号若可用，锁定就成了一次网络抖动即可绕过的装饰。
 */
export function magicrewTierUsable(
  tier: MagicrewExpiryTier,
  options: MagicrewExpiryOptions = {},
): boolean {
  if (options.allowPermanent === false) {
    return tier === MAGICREW_EXPIRY_TIER.expiring || tier === MAGICREW_EXPIRY_TIER.longTerm
  }
  return tier !== MAGICREW_EXPIRY_TIER.empty
}

/**
 * 按到期档位排序账号（**稳定排序**：档内保持传入顺序 = 用户手动拖拽顺序）。
 *
 * 用「装饰 - 排序 - 解装饰」而不是直接比较档位：`Array.prototype.sort` 在 V8
 * 里虽已稳定，但显式带原始下标可让意图自明、且不受引擎实现影响。
 *
 * ⚠️ **档内不重排**是硬要求：用户拖拽调整的顺序必须仍然生效，否则
 * 「手动排序」在这个 provider 上形同虚设（本仓库记录过同类缺陷）。
 *
 * @param accounts - 待排序账号（顺序即手动优先级）。
 * @param options - 分档选项。
 * @returns **新数组**（不修改入参）。
 */
export function rankMagicrewAccountsByExpiry<T extends MagicrewAccountExpiry>(
  accounts: readonly T[],
  options: MagicrewExpiryOptions = {},
): T[] {
  return accounts
    .map((account, index) => ({ account, index, tier: magicrewExpiryTier(account) }))
    .sort((a, b) => (a.tier - b.tier) || (a.index - b.index))
    .map((entry) => entry.account)
}

/**
 * 把一次余额查询的结果折成 {@link MagicrewAccountExpiry}。
 *
 * @param balance - `fetchMagicrewBalance` 的产物；`undefined` = 查询失败。
 */
export function magicrewExpiryOfBalance(
  id: string,
  balance: CreditBalance | undefined,
  windowDays: number = MAGICREW_EXPIRY_WINDOW_DAYS,
  now: number = Date.now(),
): MagicrewAccountExpiry {
  if (balance === undefined) return { id, ok: false }
  const split = splitMagicrewCreditPackages(balance.packages, windowDays, now)
  return {
    id,
    expiring: split.expiring,
    longTerm: split.longTerm,
    permanent: split.permanent,
    earliestExpiringAt: split.earliestExpiringAt,
    ok: true,
  }
}

/** 选号器依赖（便于单测注入）。 */
export interface MagicrewExpirySelectorDeps {
  /** 查某账号的余额（注入点；缺省由调用方在 wiring 里接 `fetchMagicrewBalance`）。 */
  fetchBalance: (params: { product: MagicrewProduct, credentialRef: string }) => Promise<CreditBalance | undefined>
  /** 当前时间（测试用）。 */
  now?: () => number
  /** TTL 覆盖（测试用）。 */
  ttlMs?: number
  /** 「长期 / 临期」窗口天数覆盖（测试用）。 */
  windowDays?: number
  /** 日志（选号结果留痕：用户要能验证「是不是真的先用了临期」）。 */
  logger?: (message: string) => void
}

/** 一条待选账号（调用方从账号池取出，顺序即手动优先级）。 */
export interface MagicrewExpiryCandidate {
  id: string
  credentialRef: string
}

/** 到期分桶缓存 TTL（毫秒）。与 OfficeAce / Loomy 的余额缓存同值：同一轮对话内不重复查。 */
export const MAGICREW_EXPIRY_CACHE_TTL_MS = 60_000

/** 一个账号的缓存条目。 */
interface CacheEntry {
  at: number
  value: MagicrewAccountExpiry
}

/**
 * 到期分档缓存 + 选号器。
 *
 * 生命周期与适配器实例一致（每个 provider 一个），故不需要全局状态、
 * 也不会跨 provider 串味。
 */
export class MagicrewExpirySelector {
  private readonly cache = new Map<string, CacheEntry>()

  constructor(private readonly deps: MagicrewExpirySelectorDeps) {}

  /** 清空缓存（账号增删、手动刷新后调用）。 */
  invalidate(accountId?: string): void {
    if (accountId === undefined) this.cache.clear()
    else this.cache.delete(accountId)
  }

  /**
   * 查一个账号的到期分档（带 TTL 缓存）。
   *
   * ⚠️ **查询失败不抛错**：返回 `ok: false` 的条目，由分档逻辑归入 `unknown`
   * 档。让「一个号查不到」不至于让整个选号失败。
   */
  async expiryOf(
    account: MagicrewExpiryCandidate,
    product: MagicrewProduct,
  ): Promise<MagicrewAccountExpiry> {
    const now = this.deps.now?.() ?? Date.now()
    const ttl = this.deps.ttlMs ?? MAGICREW_EXPIRY_CACHE_TTL_MS
    const cached = this.cache.get(account.id)
    if (cached !== undefined && now - cached.at < ttl) return cached.value
    let value: MagicrewAccountExpiry
    try {
      const balance = await this.deps.fetchBalance({ product, credentialRef: account.credentialRef })
      value = magicrewExpiryOfBalance(
        account.id,
        balance,
        this.deps.windowDays ?? MAGICREW_EXPIRY_WINDOW_DAYS,
        now,
      )
    } catch {
      // ⚠️ 查询异常归 `unknown`（不是 empty）：让池去报错比直接说「没有账号」更诚实。
      value = { id: account.id, ok: false }
    }
    this.cache.set(account.id, { at: now, value })
    return value
  }

  /**
   * 选一个账号（按到期档位 + 手动顺序）。
   *
   * @returns 选中的候选；**没有可用账号**返回 `undefined`
   *   （调用方据此决定报错文案 —— 尤其是「锁定永久积分导致全不可用」那条）。
   */
  async select<T extends MagicrewExpiryCandidate>(
    candidates: readonly T[],
    product: MagicrewProduct,
    options: MagicrewExpiryOptions = {},
  ): Promise<{ account: T, expiry: MagicrewAccountExpiry } | undefined> {
    if (candidates.length === 0) return undefined
    const expiries = await Promise.all(candidates.map(async (account) => ({
      account,
      expiry: await this.expiryOf(account, product),
    })))
    const ranked = rankMagicrewAccountsByExpiry(
      expiries.map((entry) => ({ ...entry.expiry, account: entry.account })),
      options,
    )
    const usable = ranked.filter((entry) => magicrewTierUsable(magicrewExpiryTier(entry), options))
    const picked = usable[0]
    if (picked === undefined) {
      this.deps.logger?.(
        `[${product.id}] 没有可用账号：`
        + expiries.map((entry) => `${entry.account.id}=${magicrewExpiryTier(entry.expiry)}`).join(' '),
      )
      return undefined
    }
    this.deps.logger?.(
      `[${product.id}] 选号 ${picked.account.id}（档位 ${magicrewExpiryTier(picked)}，`
      + `临期 ${picked.expiring ?? 0} / 长期 ${picked.longTerm ?? 0} / 永久 ${picked.permanent ?? 0}）`,
    )
    return { account: picked.account, expiry: picked }
  }
}
