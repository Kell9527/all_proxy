/**
 * Magicrew（超级麦吉 / MagiCrew）的积分到期分档与选号 —— **共享实现的薄封装**。
 *
 * ## 为什么现在只剩一层转发（2026-11-02 重构）
 *
 * 原先本文件是**唯一**一份分档实现（OfficeAce 另有一份吃自己 `creditGroups`
 * 的）。把「锁定永久积分」扩展到 Qoder / TRAE 时出现了**第三、第四份同样判据**
 * 的苗头 —— 这正是本仓库首条红线（同一条判据不得有两处实现）要禁止的形态：
 * 任何一处改了窗口 / 边界方向，其余几家就静默分家，症状是「面板显示临期 N，
 * 选号却不认它」。
 *
 * 故真正的实现在 `credit-expiry-rank.ts`，本文件只保留：
 *
 * 1. **历史导出名**（`MAGICREW_EXPIRY_TIER` 等）—— 测试与 `wiring.ts` 早已按
 *    这些名字引用，改名会让引用面凭空扩大，收益为零；
 * 2. **`MagicrewExpirySelector` 这一层壳**：它比共享选择器多一个 `product`
 *    维度（两站的 host / 组织码要求不同，查余额必须按站取数）。壳只做
 *    「补上 `product` 再委派」，判据一律留在共享层。
 *
 * ⚠️ **不要在壳里再写一份判据**：任何落在本文件的 `if` 都会立刻成为第二份口径。
 */

import type { CreditBalance } from './credits.js'
import type { MagicrewProduct } from './magicrew-product.js'
import {
  CREDIT_EXPIRY_CACHE_TTL_MS,
  CREDIT_EXPIRY_TIER,
  CREDIT_EXPIRY_WINDOW_DAYS,
  CreditExpirySelector,
  creditExpiryOfBalance,
  creditExpiryTier,
  creditTierUsable,
  rankAccountsByExpiry,
  splitCreditPackagesByExpiry,
  type AccountCreditExpiry,
  type CreditExpiryCandidate,
  type CreditExpiryOptions,
  type CreditExpirySplit,
  type CreditExpiryTier,
} from './credit-expiry-rank.js'

/**
 * 「长期 / 临期」分桶窗口天数。
 *
 * ⚠️ 转发共享常量（不再写一份 15）：与后端 `CREDIT_EXPIRY_WINDOW_DAYS`、
 * 前端 `credit-expiry.js` 的常量必须同值 —— 改一处不改其余处，症状是面板
 * 显示的口径与选号实际用的口径不一致。
 */
export const MAGICREW_EXPIRY_WINDOW_DAYS = CREDIT_EXPIRY_WINDOW_DAYS

/** 账号到期档位（转发 {@link CREDIT_EXPIRY_TIER}）。 */
export const MAGICREW_EXPIRY_TIER = CREDIT_EXPIRY_TIER

export type MagicrewExpiryTier = CreditExpiryTier

/** 参与分档的账号到期信息。 */
export type MagicrewAccountExpiry = AccountCreditExpiry

/** 分档选项。 */
export type MagicrewExpiryOptions = CreditExpiryOptions

/** 分桶结果。 */
export type MagicrewExpirySplit = CreditExpirySplit

export { packageExpiryMs as magicrewPackageExpiryMs } from './credit-expiry-rank.js'

/**
 * 把积分包按到期时间分成三档。
 *
 * 见 `credit-expiry-rank.ts` 的 `splitCreditPackagesByExpiry`（含边界方向
 * `end - now < windowMs`、含「已过期不计入临期」）。
 */
export const splitMagicrewCreditPackages = splitCreditPackagesByExpiry

/** 账号的到期档位（临期 > 长期 > 永久 > 未知 > 空）。 */
export const magicrewExpiryTier = creditExpiryTier

/** 该档位在本次选项下是否可用（锁定永久积分时 permanent/unknown/empty 全不可用）。 */
export const magicrewTierUsable = creditTierUsable

/** 按到期档位排序账号（档内保持手动顺序）。 */
export const rankMagicrewAccountsByExpiry = rankAccountsByExpiry

/** 把一次余额查询的结果折成到期分档。 */
export const magicrewExpiryOfBalance = creditExpiryOfBalance

/** 到期分桶缓存 TTL（毫秒）。 */
export const MAGICREW_EXPIRY_CACHE_TTL_MS = CREDIT_EXPIRY_CACHE_TTL_MS

/** 选号器依赖（在共享依赖上多一个「按站查余额」的入口）。 */
export interface MagicrewExpirySelectorDeps {
  /**
   * 查某账号的余额。
   *
   * ⚠️ **必须按 `product` 取数**：两站的 host 与组织码要求不同，写死国内站会让
   * 国际站账号一律查不到余额 ⇒ 选号归 `unknown`、锁定时永远报「没有可用账号」。
   */
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

/**
 * 带 `product` 维度的选号器。
 *
 * 内部按 product id 各持一个共享 {@link CreditExpirySelector}（缓存互不污染），
 * `select` 时把 `product` 绑进查余额闭包再委派。
 */
export class MagicrewExpirySelector {
  private readonly deps: MagicrewExpirySelectorDeps
  /** product id → 共享选择器（每个站各自的缓存）。 */
  private readonly selectors = new Map<string, CreditExpirySelector>()

  constructor(deps: MagicrewExpirySelectorDeps) {
    this.deps = deps
  }

  /** 清空缓存（账号增删、手动刷新后调用）。 */
  invalidate(accountId?: string): void {
    for (const selector of this.selectors.values()) selector.invalidate(accountId)
    if (accountId === undefined) this.selectors.clear()
  }

  private selectorFor(product: MagicrewProduct): CreditExpirySelector {
    const existing = this.selectors.get(product.id)
    if (existing !== undefined) return existing
    const created = new CreditExpirySelector({
      label: product.id,
      fetchBalance: (candidate: CreditExpiryCandidate) =>
        this.deps.fetchBalance({ product, credentialRef: candidate.credentialRef }),
      ...(this.deps.now === undefined ? {} : { now: this.deps.now }),
      ...(this.deps.ttlMs === undefined ? {} : { ttlMs: this.deps.ttlMs }),
      ...(this.deps.windowDays === undefined ? {} : { windowDays: this.deps.windowDays }),
      ...(this.deps.logger === undefined ? {} : { logger: this.deps.logger }),
    })
    this.selectors.set(product.id, created)
    return created
  }

  /** 查一个账号的到期分档（带 TTL 缓存）。 */
  async expiryOf(
    account: CreditExpiryCandidate,
    product: MagicrewProduct,
  ): Promise<AccountCreditExpiry> {
    return await this.selectorFor(product).expiryOf(account)
  }

  /** 选一个账号（按到期档位 + 手动顺序）；无可用账号返回 `undefined`。 */
  async select<T extends CreditExpiryCandidate>(
    candidates: readonly T[],
    product: MagicrewProduct,
    options: CreditExpiryOptions = {},
  ): Promise<{ account: T, expiry: AccountCreditExpiry } | undefined> {
    return await this.selectorFor(product).select(candidates, options)
  }
}
