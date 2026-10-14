/**
 * 账号池「有效期」的共享回写与 lead-time 判据。
 *
 * ## 为什么需要这个模块
 *
 * UI 账号卡片的「有效期：已过期」读的是**账号池的 `expiresAt`**，而不是凭据里
 * access_token 的真实 `exp`。于是只要凭据被更新过而**索引没跟上**，就会出现
 * 「显示已过期、但发消息完全正常」的数据源分叉。
 *
 * 本模块把「按需续期后回写池值」与「不需要续期时也对账池值」抽成一份实现，
 * 供各 provider 共用。
 */

import type { ProviderAccountEntry } from './types.js'
import { REFRESH_LEAD_MS } from './refresh.js'

/** 池内条目的现值（用于「变了才写盘」的短路）。 */
export interface ExpiryCurrentValue {
  expiresAt?: number
  refreshable?: boolean
}

/**
 * 回写有效期所需的**最小**账号池能力。
 *
 * 刻意不依赖整个 `AccountPool` 类：本模块只做「反查 + 打补丁」两件事，
 * 与账号池的缓存、落盘、模型黑名单等无关。收窄到接口也让单测可以直接
 * 传一个结构替身，而不必先构造真池。
 */
export interface ExpirySyncPool {
  updateAccount(
    id: string,
    patch: Partial<Pick<ProviderAccountEntry, 'expiresAt' | 'refreshable'>>,
  ): Promise<void>
  findAccountIdByCredential(provider: string, identity: string): Promise<string>
}

/** 从各家凭据取过期信息的能力（各 provider 凭据类型不同，故以提取器注入）。 */
export interface ExpiryAccessors<TCredential> {
  /** access_token 的过期时刻（毫秒）；`undefined` 表示凭据里读不到。 */
  expiresAtOf: (credential: TCredential) => number | undefined
  /**
   * 凭据是否仍可续期。
   *
   * ⚠️ **不提供时只同步 `expiresAt`、绝不碰 `refreshable`**。Loomy 必须走这条：
   * 它的 `isLoomyRefreshable` **恒为 `false`**（服务端没有任何 refresh 端点，
   * 这是诚实标记），若让共享实现据此把池里写 `false`，反而会把账号池改成
   * 与该产品实际行为不符的状态。
   */
  refreshableOf?: (credential: TCredential) => boolean
  /**
   * `AccountPool.findAccountIdByCredential` 的凭据身份。
   *
   * ⚠️ 该参数的语义是「**凭据内容**」（通常是 access_token）而**不是 ref 名**，
   * 传 ref 名会恒匹配失败且**静默无报错**。
   */
  identityOf: (credential: TCredential) => string
}

/** 容差：毫秒时间戳来自 JWT 的秒级 `exp`，换算后可能有 1 秒内的舍入。 */
const EXPIRY_TOLERANCE_MS = 1000

/**
 * 本轮是否需要为该凭据发一次续期请求（lead-time 语义）。
 *
 * 判据：**距过期不足 1 小时（或已过期、或读不到过期时间）才刷**。
 *
 * ## 为什么判据用**凭据的**过期时间而不是账号池的 `expiresAt`
 *
 * 池值正是本缺陷里可能陈旧的那份数据（按需续期不回写、老版本从未回写）。
 * 拿它当判据会让「凭据其实快过期」的账号被跳过；而凭据本体是权威值，
 * 读它只是一次本地存储访问，不花网络也不花模型额度。
 *
 * @param expiresAtMs 凭据 access_token 的过期时刻；`undefined` 一律视为需要刷。
 */
export function shouldRefreshNow(expiresAtMs: number | undefined, nowMs = Date.now()): boolean {
  if (expiresAtMs === undefined || !Number.isFinite(expiresAtMs)) return true
  return expiresAtMs - nowMs <= REFRESH_LEAD_MS
}

/**
 * 把凭据的过期信息同步回账号池（UI 读的就是这里）。
 *
 * 三条硬规矩：
 *
 * 1. **失败只记日志、绝不上抛**：调用点是「凭据已经续期成功」之后，
 *    此时因为写索引失败而报错，会让用户以为续期失败、甚至触发无谓的重新登录。
 * 2. **优先用调用方给的 `accountId`**：`refreshAll` 手里本来就有 entry，
 *    无需反查；只有在缺失时才退化为按凭据身份遍历账号池比对。
 * 3. **现值一致时不写盘**：账号列表是整体落盘的，否则定时器每轮会把全部
 *    记录重写一遍，白耗 I/O。
 *
 * ⚠️ `expiresAt` 取不到时**不覆盖**池内旧值：`updateAccount` 做的是
 * `{ ...entry, ...patch }`，把字段写成 `undefined` 后落盘会被 `JSON.stringify`
 * 整个丢弃，UI 于是显示「未知」—— 保留旧信息比抹掉它更有价值。
 */
export async function syncAccountExpiry<TCredential>(params: {
  /** 账号池；未提供时静默跳过（兼容不传 pool 的既有调用方）。 */
  pool: ExpirySyncPool | undefined
  /** 账号池里该 provider 的 id，如 `'cline'` / `'codearts'`。 */
  provider: string
  /** 已从凭据算好的过期信息。 */
  credential: TCredential
  accessors: ExpiryAccessors<TCredential>
  /** 调用方已知的账号 id；缺失时按凭据身份反查。 */
  accountId?: string
  /** 池内现值，提供时启用「变了才写盘」短路。 */
  current?: ExpiryCurrentValue
  /** 日志前缀，如 `'[cline]'`。 */
  tag: string
  warn?: (message: string) => void
}): Promise<void> {
  const { pool, provider, credential, accessors, accountId, current, tag } = params
  if (pool === undefined) return
  try {
    let id = accountId
    if (id === undefined || id.length === 0) {
      id = await pool.findAccountIdByCredential(provider, accessors.identityOf(credential))
    }
    if (id === undefined || id.length === 0) return

    const expiresAt = accessors.expiresAtOf(credential)
    const refreshable = accessors.refreshableOf?.(credential)
    if (expiresAt === undefined && refreshable === undefined) return
    const expiryChanged = expiresAt !== undefined
      && (current?.expiresAt === undefined
        || Math.abs(current.expiresAt - expiresAt) > EXPIRY_TOLERANCE_MS)
    const refreshableChanged = refreshable !== undefined
      && (current === undefined || current.refreshable !== refreshable)
    if (!expiryChanged && !refreshableChanged) return

    await pool.updateAccount(id, {
      ...(expiresAt === undefined ? {} : { expiresAt }),
      ...(refreshable === undefined ? {} : { refreshable }),
    })
  } catch (error) {
    params.warn?.(
      `${tag} 凭据处理成功但回写账号池的有效期失败（不影响使用）：`
      + `${error instanceof Error ? error.message : String(error)}`,
    )
  }
}

/**
 * `refreshAll` 的单账号编排：需要刷就刷、不需要就把池值对账。
 *
 * 「不需要续期」的分支**不是**一句 `continue` 就完事 —— 存量账号的凭据早已在
 * 别处续好了，只有池里还是旧值；若跳过时对账缺失，UI 会**永远**显示「已过期」。
 *
 * @returns 是否真的发了一次续期请求（供调用方计数/日志）。
 */
export async function refreshAccountWithReconcile<TCredential>(params: {
  pool: ExpirySyncPool
  provider: string
  tag: string
  accountId: string
  credential: TCredential
  accessors: ExpiryAccessors<TCredential>
  /** 池内现值（通常就是 `entry` 本身）。 */
  current?: ExpiryCurrentValue
  /** 执行真正的续期并**落盘凭据**；失败应抛错。 */
  refresh: (credential: TCredential) => Promise<TCredential>
  /** 续期成功后写回凭据存储。 */
  save: (credential: TCredential) => Promise<void>
  warn?: (message: string) => void
  info?: (message: string) => void
}): Promise<boolean> {
  const { pool, provider, tag, accountId, credential, accessors, current, refresh, save } = params
  const expiresAt = accessors.expiresAtOf(credential)

  if (!shouldRefreshNow(expiresAt)) {
    // 凭据仍在有效期内：只把池值对账，不发请求。
    await syncAccountExpiry({
      pool,
      provider,
      credential,
      accessors,
      accountId,
      current,
      tag,
      warn: params.warn,
    })
    return false
  }

  const refreshed = await refresh(credential)
  // ⚠️ 续期响应缺访问令牌时**绝不能**把 `undefined` 落盘：那会把一份好凭据
  // 覆盖成 `"undefined"` 字符串，账号直接报废（只能重新登录）。
  if (refreshed === undefined) {
    throw new Error(`${tag} 续期响应缺少访问令牌，凭据未更新`)
  }
  await save(refreshed)
  await syncAccountExpiry({
    pool,
    provider,
    credential: refreshed,
    accessors,
    accountId,
    current,
    tag,
    warn: params.warn,
  })
  params.info?.(`${tag} 账号 ${accountId} 已续期`)
  return true
}
