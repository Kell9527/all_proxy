/**
 * 运行时辅助：serve 组装层用到的周期任务与选号包装。
 *
 * ⚠️ **续期只看 `refreshable`，不看 `enabled`**（AGENTS.md 来源约定 1）：
 * 停用只影响自动选号，与凭据是否需要保持新鲜无关。若按 enabled 过滤，
 * 停用期间的 refresh_token 会一路放到失效，用户重新启用时拿到的是死凭据。
 */

import type { AccountPool } from '../pool/account-pool.js'
import type { CredentialStore } from '../pool/types.js'
import type { Logger } from '../pool/store.js'
import { RefreshCoordinator } from '../pool/refresh-coordinator.js'
import { refreshAccountOnce } from './refresh-account.js'

/** 临期阈值：距过期不足该时长就触发静默刷新。 */
const REFRESH_AHEAD_MS = 24 * 60 * 60 * 1000

/**
 * 扫描全部账号，对**临期的可续期账号**执行静默刷新并立即回写。
 *
 * 刷新是按账号（而不是按 provider 的默认账号）：续期的是**这份凭据本身**，
 * 用池的默认账号会刷错对象 —— 那正是来源插件在 Qoder 上误标无辜账号的教训。
 *
 * ⚠️ 实际的「重读最新凭据 → 单飞 → 回写」三步在 {@link refreshAccountOnce}
 * 里，与请求路径（适配器的 401 重试 / 临期刷新）**共用同一份实现与同一个
 * 单飞协调器**：两条路径会在同一时刻碰到同一账号，各自单飞等于没单飞
 * （一次性 refresh_token 被消耗两次，后者必然失败）。
 *
 * ⚠️ 有意**并发**（而非逐个 await）：多个账号条目可能指向同一个凭据 ref
 * （共享凭据文件），只有并发才能让单飞把它们的刷新合并成**一次**上游请求。
 * 逐个 await 的话前一个已经结束、锁已释放，后一个会真的再刷一次 —— 把
 * 一次性 refresh_token 白轮换一次，正是本机制要消灭的事。
 */
export async function refreshDueAccounts(deps: {
  pool: AccountPool
  credentials: CredentialStore
  logger: Pick<Logger, 'info' | 'warn' | 'error'>
  /** 全局单飞协调器。省略则新建一个（仅适用于单次调用，如测试）。 */
  coordinator?: RefreshCoordinator
  /** 注入的 fetch（测试替身用）。 */
  fetcher?: typeof fetch
}): Promise<void> {
  const coordinator = deps.coordinator ?? new RefreshCoordinator()
  const accounts = await deps.pool.listAllAccounts()

  await Promise.all(accounts.map(async (entry) => {
    // ⚠️ 只看 refreshable，**不看 enabled**（见文件头）。
    if (!entry.refreshable) return
    if (entry.expiresAt !== undefined && entry.expiresAt - Date.now() > REFRESH_AHEAD_MS) return

    try {
      await refreshAccountOnce(
        { credentials: deps.credentials, pool: deps.pool, coordinator, logger: deps.logger, fetcher: deps.fetcher },
        entry,
      )
      deps.logger.info(`[refresh] ${entry.provider} 账号 ${entry.id} 续期成功`)
    } catch (error) {
      // 续期失败不致命：凭据仍可能未过期；终态（refresh_token 失效）由下次
      // 使用时的 401 如实暴露。这里只记录，绝不抛出中断其它账号。
      deps.logger.warn(`[refresh] ${entry.provider} 账号 ${entry.id} 续期失败: ${error instanceof Error ? error.message : String(error)}`)
    }
  }))
}

/** 用量保留策略的周期执行（保留策略本身在 UsageStore）。 */
export function sweepUsage(): void {
  // 保留策略在 startServe 里随定时器调用 usage.applyRetention()；
  // 本函数保留为显式调用点，便于将来加配置。
}
