/**
 * 单账号凭据续期的统一实现。
 *
 * ## 为什么抽成独立模块
 *
 * 续期有**两条生产调用路径**，它们的语义必须完全一致：
 *
 * | 路径 | 触发时机 |
 * |---|---|
 * | `src/index.ts` 的 `wiringRefresh` | 适配器在读请求前发现凭据临期，或遇 401/403 |
 * | `src/refresh/runtime-helpers.ts` 的 `refreshDueAccounts` | 启动时 + 每小时的定时任务 |
 *
 * 早前这两处各写了一份，于是三件事容易只在一处做对：**读取最新凭据、单飞、
 * 回写新凭据**。抽到这里后两处共用同一条正确路径。
 *
 * ## 三步顺序不可颠倒（针对一次性轮换的 refresh_token）
 *
 * 1. **锁内重读凭据** —— 必须用**此刻文件里的最新** `refresh_token`。任何缓存
 *    的副本都可能已被别的消费者（官方客户端 / 其它网关 / 本服务另一条路径）
 *    消耗掉，用它去刷只会得到「refresh token 已被使用」。
 * 2. **单飞刷新** —— 同一凭据文件的并发刷新会互抢（见 `refresh-coordinator.ts`）。
 * 3. **立即回写** —— 新 `refresh_token` 只出现在响应里，不回写等于让该账号
 *    只能重新登录（AGENTS.md 约定 3）。
 *
 * 第 3 步对**文件引用**尤其重要：写回的是那个共享文件，于是其它消费者下次读取
 * 就能拿到新 token —— 这正是「不再互相作废」的实现。
 */

import type { AccountPool } from '../pool/account-pool.js'
import type { RefreshCoordinator } from '../pool/refresh-coordinator.js'
import type { CredentialStore, ProviderAccountEntry } from '../pool/types.js'
import type { Logger } from '../pool/store.js'
import { refreshProviderCredential } from './provider-refresher.js'

/** {@link refreshAccountOnce} 的依赖。 */
export interface RefreshAccountDeps {
  credentials: CredentialStore
  pool: AccountPool
  /** 全局单飞协调器（调用方持有单例，两条路径共用）。 */
  coordinator: RefreshCoordinator
  logger?: Pick<Logger, 'info' | 'warn' | 'error'>
  /** 注入的 fetch（测试替身用）。 */
  fetcher?: typeof fetch
}/**
 * 把字段值解析成毫秒时间戳：数字、纯数字字符串、ISO 字符串都认。
 *
 * ⚠️ ISO 字符串这一支不是锦上添花：raccoon 等服务端会下发
 * `'2099-01-01T00:00:00Z'`，只认 `Number()` 会让「续期成功但有效期不更新」
 * （表现为界面上一直显示旧日期，甚至被判成已过期而反复续期）。
 */
export function parseExpiresAt(value: unknown): number | undefined {
  if (typeof value === 'number') return Number.isFinite(value) && value > 0 ? value : undefined
  if (typeof value === 'string') {
    const asNum = Number(value)
    if (Number.isFinite(asNum) && asNum > 0) return asNum
    const parsed = Date.parse(value)
    if (!Number.isNaN(parsed)) return parsed
  }
  return undefined
}

/** 从凭据对象里提取过期毫秒时间戳（各 provider 字段名不一）。 */
export function expiresAtOfCredential(credential: Record<string, unknown>): number | undefined {
  for (const key of ['expires_at', 'expiresAt', 'expire_time', 'expireTime']) {
    const parsed = parseExpiresAt(credential[key])
    if (parsed !== undefined) return parsed
  }
  return undefined
}

/**
 * 续期一个账号的凭据并写回。
 *
 * ⚠️ **返回值经单飞共享**：多个账号条目可以指向同一个凭据 ref（尤其是共享
 * 凭据文件）。此时只有「领跑者」真的打了上游并写回，其余条目拿到**同一个**
 * 刷新结果，各自更新自己的 `expiresAt`。若在单飞体内直接更新池，后到的条目
 * 就会漏掉 `expiresAt`（界面上显示旧有效期，甚至被判成仍临期而反复续期）。
 *
 * @throws 凭据缺失、refresh_token 失效（终态，消息含「请重新登录」）、
 *   网络/上游瞬态失败。调用方决定是吞掉（定时任务）还是上抛（请求路径）。
 */
export async function refreshAccountOnce(
  deps: RefreshAccountDeps,
  entry: ProviderAccountEntry,
): Promise<void> {
  const refreshed = await deps.coordinator.run(entry.credentialRef, async () => {
    // 1) 锁内重读：拿到此刻最新的 refresh_token（文件引用会实时读盘）。
    const resolved = await deps.credentials.resolve(entry.credentialRef)
    if (resolved === undefined) {
      throw new Error(`账号 ${entry.id} 的凭据不可读（${entry.credentialRef}）`)
    }
    let credential: Record<string, unknown>
    try {
      credential = JSON.parse(resolved.value) as Record<string, unknown>
    } catch (error) {
      throw new Error(`账号 ${entry.id} 的凭据不是合法 JSON: ${String(error)}`)
    }

    // 2) 刷新（provider 各自实现）。
    const next = await refreshProviderCredential(entry.provider, credential, deps.fetcher)

    // 3) 立即回写：一次性 refresh_token 只在这里被保存。
    await deps.credentials.set(entry.credentialRef, JSON.stringify(next))
    return next
  })

  // 4) 有效期回填（每个条目各自更新，见函数头）。
  const expiresAt = expiresAtOfCredential(refreshed)
  if (expiresAt !== undefined) {
    await deps.pool.updateAccount(entry.id, { expiresAt })
  }
}
