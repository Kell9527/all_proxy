/**
 * 按**积分包到期时间**分档 + 「临期优先」选号的**共享实现**。
 *
 * 取代原先只有 Magicrew 一家用的 `magicrew-expiry-rank.ts`（该文件现在是本模块的
 * 薄转发，导出名保持不变）。提到共享层的原因是本项目一条硬纪律：
 * **同一条判据只留一处实现** —— Qoder / TRAE 与本模块的分桶口径必须逐格一致，
 * 否则「面板显示临期 2000，选号却不认它」。
 *
 * ## 判据与面板**逐字同源**
 *
 * | 档位 | 判据 | 前端落桶 |
 * |---|---|---|
 * | 临期 | 有到期时间，且距到期 **< 窗口**（默认 15 天） | 红（`expiring`）+ 倒计时 |
 * | 长期 | 有到期时间，且距到期 **≥ 窗口** | 黄（`longTerm`） |
 * | 永久 | **没有**到期时间（或到期时间是不可解析的哨兵） | 绿（`permanent`） |
 *
 * 三条口径对齐点（少一条就会与面板分家）：
 * 1. **窗口天数同值** —— {@link CREDIT_EXPIRY_WINDOW_DAYS} 与后端
 *    `admin/credits-endpoint.ts` 的常量、前端 `credit-expiry.js` 的常量必须相同；
 * 2. **「已失效 / 剩余 ≤ 0 不计入」** —— 与前端 `splitCreditsByExpiry` 同判；
 * 3. **到期时间读 `expiredTime`（ISO 串）** —— 本项目的 `CreditPackage` 形状。
 *
 * ## 与来源 `deductionEndTime` 的关系（移植时的关键差异）
 *
 * 来源侧包里另有一个数值字段 `deductionEndTime`（毫秒），前端 `packageExpiryMs`
 * 对它做**两段回落**（先数值、再 `expiredTime` 字符串）。本项目只有
 * `expiredTime` 一个出口 ⇒ 各家在**归一化那一刻**就必须把到期时间写进
 * `expiredTime`（`trae-credits.ts` 把秒级 `expire_time` 转 ISO、`qoder-credits.ts`
 * 把同一份哨兵判据用在两条支路上）。写不进 `expiredTime` 的后果是本模块一律
 * 判成「永久」⇒ 锁定永久积分时该 provider **恒无可用账号**。
 */

import type { CreditBalance, CreditPackage } from './credits.js'

/**
 * 「长期 / 临期」分桶窗口天数。
 *
 * ⚠️ 与 `admin/credits-endpoint.ts` 的 `CREDIT_EXPIRY_WINDOW_DAYS`、
 * 前端 `plugin-src/client/credit-expiry.js` 的 `CREDIT_EXPIRY_WINDOW_DAYS`
 * **必须同值**（现在都是 15）。改一处不改其余处，症状是面板显示的口径
 * 与选号实际用的口径不一致 —— 用户看到「长期」的桶被当成「临期」优先消耗。
 *
 * ⚠️ 各家向自己模块转发这份常数（`MAGICREW_EXPIRY_WINDOW_DAYS` 等），
 * 转发而不是各写一遍 15，是为了让「改窗口」只改这一个字面量。
 */
export const CREDIT_EXPIRY_WINDOW_DAYS = 15

/** 账号到期档位。数字越小越优先。 */
export const CREDIT_EXPIRY_TIER = Object.freeze({
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

export type CreditExpiryTier = (typeof CREDIT_EXPIRY_TIER)[keyof typeof CREDIT_EXPIRY_TIER]

/** 参与分档的账号到期信息（字段缺失表示查询失败）。 */
export interface AccountCreditExpiry {
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
export interface CreditExpiryOptions {
  /** 是否允许消耗永久积分。默认 `true`（解锁）。 */
  allowPermanent?: boolean
  /** 「长期 / 临期」的分桶窗口天数，缺省 {@link CREDIT_EXPIRY_WINDOW_DAYS}。 */
  windowDays?: number
}

/** 分桶结果。 */
export interface CreditExpirySplit {
  expiring: number
  longTerm: number
  permanent: number
  /** 最早的临期到期时刻（毫秒）；无临期包或临期包都已过期时为 `null`。 */
  earliestExpiringAt: number | null
}

/** 读一个包的到期时刻（毫秒）；无到期时间返回 `null`（= 永久）。 */
export function packageExpiryMs(pkg: CreditPackage): number | null {
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
 * ⚠️ **已过期的包不计入 `expiring`**，也不污染 `earliestExpiringAt`：
 * 那些额度扣不到，让「最早临期」停在过去会让倒计时永远显示「已过期」。
 *
 * @param packages - 各家余额归一化后的 `packages`。
 * @param windowDays - 「长期 / 临期」分界天数。
 * @param now - 当前时刻（测试注入）。
 */
export function splitCreditPackagesByExpiry(
  packages: readonly CreditPackage[] | undefined,
  windowDays: number = CREDIT_EXPIRY_WINDOW_DAYS,
  now: number = Date.now(),
): CreditExpirySplit {
  const windowMs = Math.max(0, Number(windowDays)) * 24 * 60 * 60 * 1000
  const split: CreditExpirySplit = { expiring: 0, longTerm: 0, permanent: 0, earliestExpiringAt: null }
  for (const pkg of packages ?? []) {
    if (!pkg || pkg.active !== true) continue
    const remaining = Number(pkg.remaining)
    if (!Number.isFinite(remaining) || remaining <= 0) continue
    const end = packageExpiryMs(pkg)
    if (end === null) {
      split.permanent += remaining
    } else if (end - now < windowMs) {
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
 * 但**锁定永久积分时的可用性判定不同**（见 {@link creditTierUsable}）。
 */
export function creditExpiryTier(expiry: AccountCreditExpiry): CreditExpiryTier {
  if (positiveNumber(expiry.expiring) > 0) return CREDIT_EXPIRY_TIER.expiring
  if (positiveNumber(expiry.longTerm) > 0) return CREDIT_EXPIRY_TIER.longTerm
  if (positiveNumber(expiry.permanent) > 0) return CREDIT_EXPIRY_TIER.permanent
  return expiry.ok === true ? CREDIT_EXPIRY_TIER.empty : CREDIT_EXPIRY_TIER.unknown
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
export function creditTierUsable(
  tier: CreditExpiryTier,
  options: CreditExpiryOptions = {},
): boolean {
  if (options.allowPermanent === false) {
    return tier === CREDIT_EXPIRY_TIER.expiring || tier === CREDIT_EXPIRY_TIER.longTerm
  }
  return tier !== CREDIT_EXPIRY_TIER.empty
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
export function rankAccountsByExpiry<T extends AccountCreditExpiry>(
  accounts: readonly T[],
  options: CreditExpiryOptions = {},
): T[] {
  return accounts
    .map((account, index) => ({ account, index, tier: creditExpiryTier(account) }))
    .sort((a, b) => (a.tier - b.tier) || (a.index - b.index))
    .map((entry) => entry.account)
}

/**
 * 把一次余额查询的结果折成 {@link AccountCreditExpiry}。
 *
 * @param balance - 各家余额查询的产物；`undefined` = 查询失败。
 */
export function creditExpiryOfBalance(
  id: string,
  balance: CreditBalance | undefined,
  windowDays: number = CREDIT_EXPIRY_WINDOW_DAYS,
  now: number = Date.now(),
): AccountCreditExpiry {
  if (balance === undefined) return { id, ok: false }
  const split = splitCreditPackagesByExpiry(balance.packages, windowDays, now)
  return {
    id,
    expiring: split.expiring,
    longTerm: split.longTerm,
    permanent: split.permanent,
    earliestExpiringAt: split.earliestExpiringAt,
    ok: true,
  }
}

/**
 * 到期分桶缓存 TTL（毫秒）。
 *
 * 与 OfficeAce / Loomy 的余额缓存同值（60 秒）：同一轮对话内不重复查。
 * 选号的实时性比省一次请求更重要 —— 陈旧的到期分桶会直接导致临期积分作废。
 */
export const CREDIT_EXPIRY_CACHE_TTL_MS = 60_000

/** 一条待选账号（调用方从账号池取出，顺序即手动优先级）。 */
export interface CreditExpiryCandidate {
  id: string
  credentialRef: string
}

/** 选号器依赖（便于单测注入）。 */
export interface CreditExpirySelectorDeps {
  /**
   * 查某账号的余额（**只读**）。
   *
   * ⚠️ 必须返回 `undefined`（不是抛错）表示「查不到」：选号发生在推理请求
   * 路径上，一次网络抖动不能让整个渠道硬失败。本类也会兜住异常。
   */
  fetchBalance: (candidate: CreditExpiryCandidate) => Promise<CreditBalance | undefined>
  /** 当前时间（测试用）。 */
  now?: () => number
  /** TTL 覆盖（测试用）。 */
  ttlMs?: number
  /** 「长期 / 临期」窗口天数覆盖（测试用）。 */
  windowDays?: number
  /** 日志（选号结果留痕：用户要能验证「是不是真的先用了临期」）。 */
  logger?: (message: string) => void
  /** 日志前缀（provider id）。 */
  label?: string
}

/** 一个账号的缓存条目。 */
interface CacheEntry {
  at: number
  value: AccountCreditExpiry
}

/**
 * 余额分档缓存 + 选号器。
 *
 * 生命周期与适配器实例一致（每个 provider 一个），故不需要全局状态、
 * 也不会跨 provider 串味（缓存键是账号 id，各 provider 的 id 前缀不同）。
 */
export class CreditExpirySelector {
  private readonly cache = new Map<string, CacheEntry>()

  constructor(private readonly deps: CreditExpirySelectorDeps) {}

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
  async expiryOf(account: CreditExpiryCandidate): Promise<AccountCreditExpiry> {
    const now = this.deps.now?.() ?? Date.now()
    const ttl = this.deps.ttlMs ?? CREDIT_EXPIRY_CACHE_TTL_MS
    const cached = this.cache.get(account.id)
    if (cached !== undefined && now - cached.at < ttl) return cached.value
    let value: AccountCreditExpiry
    try {
      const balance = await this.deps.fetchBalance(account)
      value = creditExpiryOfBalance(
        account.id,
        balance,
        this.deps.windowDays ?? CREDIT_EXPIRY_WINDOW_DAYS,
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
   *   （调用方据此决定是否报「锁定永久积分导致全不可用」）。
   */
  async select<T extends CreditExpiryCandidate>(
    candidates: readonly T[],
    options: CreditExpiryOptions = {},
  ): Promise<{ account: T, expiry: AccountCreditExpiry } | undefined> {
    if (candidates.length === 0) return undefined
    const expiries = await Promise.all(candidates.map(async (account) => ({
      account,
      expiry: await this.expiryOf(account),
    })))
    const ranked = rankAccountsByExpiry(
      expiries.map((entry) => ({ ...entry.expiry, account: entry.account })),
      options,
    )
    const usable = ranked.filter((entry) => creditTierUsable(creditExpiryTier(entry), options))
    const picked = usable[0]
    const label = this.deps.label ?? 'credits'
    if (picked === undefined) {
      this.deps.logger?.(
        `[${label}] 没有可用账号：`
        + expiries.map((entry) => `${entry.account.id}=${creditExpiryTier(entry.expiry)}`).join(' '),
      )
      return undefined
    }
    this.deps.logger?.(
      `[${label}] 选号 ${picked.account.id}（档位 ${creditExpiryTier(picked)}，`
      + `临期 ${picked.expiring ?? 0} / 长期 ${picked.longTerm ?? 0} / 永久 ${picked.permanent ?? 0}）`,
    )
    return { account: picked.account, expiry: picked }
  }
}

/**
 * 「锁定永久积分 + 没有可用账号」的**共享报错文案**。
 *
 * ## 四条硬要求
 *
 * 1. **必须与「查不到」分开报**：把一次网络抖动说成「额度用尽」会让用户去解锁，
 *    而解锁会**不可撤回地**消耗永久积分。
 * 2. **不得编造天数**：Qoder 拿不到逐包到期时刻（见 `qoder-credits.ts`），
 *    文案里写「N 天内到期的额度」会让用户以为「等几天就有临期额度可用」。
 *    故本函数**不出现任何天数**，只说「会近期作废 / 有到期时间的额度」。
 * 3. **必须给出唯一的下一步**：对「临期桶恒为 0」的渠道，等待是**不可能生效**的，
 *    必须明说「只能解锁」。
 * 4. **用普通 `Error`，不带 `LlmError.code`** —— 与 Loomy / OfficeAce 既有的
 *    「锁定后无可用账号」报错保持同形（那两处也是裸 `Error`）。规则上是
 *    `toGatewayError` 把非 `LlmError` 一律转成 **500 `internal_error`**：
 *    ⚠️ 这里**刻意不报 `QUOTA_EXCEEDED`**，因为那会被映射成 **429**，
 *    而 429 的语义是「稍后重试」；本条件是**确定性**的（解锁前重试永远同样失败），
 *    报 429 会让客户端白重试、让用户以为「过一会儿就好」。
 *
 * @param displayName - 渠道展示名（两站必须各自传自己的名字：账号不互通，
 *   用户要知道去哪个面板解锁）。
 * @param reason - 三选一，语义**不可混用**：
 *   - `unknown` = 有账号查不到余额（**可能仍有**额度）；
 *   - `exhausted` = 全部查到了，但没有任何会到期的额度（**解锁是唯一出路**）；
 *   - `broken-credential` = 分档选中了，但该账号的凭据读不出来。⚠️ 这一条
 *     单独成一支是因为它**绝不能回落池**（回落会跳过锁定、照样烧永久积分），
 *     而「查不到余额」那一支的文案（「请重试」）在这里是错的指令。
 * @param errors - 逐账号原因（会去重、折叠、截断）。
 */
export function creditLockedError(
  displayName: string,
  reason: 'unknown' | 'exhausted' | 'broken-credential',
  errors: readonly string[] = [],
): Error {
  if (reason === 'broken-credential') {
    return new Error(
      `${displayName}：已锁定永久积分，而分档选中的账号凭据读不出来`
      + `（${foldErrors(errors)}）。⚠️ 这里**不会**回落到「随便挑一个号」——`
      + '那样会跳过锁定、照样消耗永久积分。'
      + `请在管理端的 ${displayName} 面板检查该账号的凭据，或解锁永久积分后重试。`,
    )
  }
  if (reason === 'unknown') {
    return new Error(
      `${displayName}：无法确认是否有可用账号。已锁定永久积分，而有账号的余额查询失败`
      + `（${foldErrors(errors)}）。这些账号**可能仍有**会到期的额度 —— 请重试；`
      + `若反复如此，请在管理端的 ${displayName} 面板点「刷新积分」，`
      + '确认该账号的余额能否读到（本机登录态失效时要重新登录该账号）。',
    )
  }
  return new Error(
    `${displayName}：没有可用账号。已锁定永久积分，而所有账号的积分`
    + '**都拿不到「会近期作废」的证据**（只剩没有到期时间的额度，或余额已空）。'
    + '⚠️ 「拿不到证据」不等于「真的永不过期」：有的渠道余额接口只回聚合标量、'
    + '不给逐包到期时刻，那些额度其实也有有效期，只是本端看不到。'
    + '⚠️ 扣减顺序由服务端决定，本地无法干预 —— 锁定只能**拒绝**这类账号，'
    + '故这是该开关的预期效果，不是故障。'
    + `请在管理端的 ${displayName} 面板解锁永久积分后再重试`
    + '（该渠道若本来就拿不到逐包到期时间，解锁是唯一可行的下一步）。',
  )
}

/**
 * 折叠逐账号错误：**先去重、再折叠、后截断**。
 *
 * ⚠️ 顺序不可颠倒：同一类故障在每个账号上各产生一条**逐字相同**的串，
 * `slice(0, 2).join()` 会让第二条信息量为零、并挤掉唯一不同的线索。
 */
export function foldErrors(errors: readonly string[]): string {
  const unique = [...new Set(errors.map((line) => line.trim()).filter((line) => line.length > 0))]
  return unique.slice(0, 2).join('；') || '原因未知'
}
