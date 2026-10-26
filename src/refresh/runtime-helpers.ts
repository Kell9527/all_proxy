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
import { isExpiring, type OfficeAceCredential } from '../providers/officeace-auth.js'
import { maybeClaimOfficeAceBonus } from '../providers/officeace-credits.js'

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

// ───────────────────── OfficeAce 每日福利的周期领取 ─────────────────────

/** {@link claimOfficeAceDailyBonuses} 的依赖。 */
export interface OfficeAceBonusSweepDeps {
  pool: AccountPool
  credentials: CredentialStore
  logger: Pick<Logger, 'info' | 'warn' | 'error'>
  /** 全局单飞协调器（必须与续期定时任务/请求路径共用同一个实例）。 */
  coordinator?: RefreshCoordinator
  /** 注入的 fetch（测试替身用）。 */
  fetcher?: typeof fetch
  /** 当前时间（测试用）。 */
  now?: () => number
  /**
   * **手动补领**：跳过「今天已领」与失败冷却两道闸门。
   *
   * 定时任务应当省略（去重是它的正常行为）；管理端按钮置 true —— 用户点一下
   * 就是明确要求「现在就试一次」，被去重表静默忽略会让人以为按钮坏了。
   */
  force?: boolean
}

/** 单账号的领取结果（面板按它逐条显示，不只给汇总）。 */
export interface OfficeAceBonusAccountResult {
  accountId: string
  nickname: string
  /** `claimed` 本次领到；`already-claimed` 今天早已领过；`failed` 失败；`skipped` 未参与。 */
  kind: 'claimed' | 'already-claimed' | 'failed' | 'skipped'
  /** 本次新领到的积分（`kind==='claimed'` 时 > 0）。 */
  points: number
  /** 活动名（`kind==='claimed'` 时有值），供面板显示「+100 分（每日签到有礼）」。 */
  activities?: string[]
  /** 失败/跳过的原因（可读文案）。 */
  error?: string
}

/** 一轮「全员领当日福利」的汇总（供日志与面板显示）。 */
export interface OfficeAceBonusSweepResult {
  /** 本次**真的领到分**的账号数。 */
  claimed: number
  /** 本次新领到的积分合计（跨账号，仅统计 `claimed` 的账号）。 */
  totalPoints: number
  /** 上游确认「今天早已领过」的账号数。 */
  alreadyClaimed: number
  /** 请求失败（网络/上游）的账号数 —— 下一轮会重试。 */
  failed: number
  /** 跳过的账号数（停用 / 凭据不可用 / 被去重表挡住）。 */
  skipped: number
  /** 逐账号明细（面板呈现用；定时任务也会记录它便于排查）。 */
  results: OfficeAceBonusAccountResult[]
}

/**
 * 为全部 **启用中** 的 OfficeAce 账号领取当日福利。
 *
 * ## 为什么必须有这一支（用户报障的原始形态）
 *
 * 领取逻辑早就写好了（`claimOfficeAceDailyBonus`），但唯一调用点是**管理端
 * 拉积分余额时**（`fetchOfficeAceBalanceDetailed`）—— 也就是「用户打开面板」
 * 的那一刻才领。用户不开面板、服务自己在跑，当天那 100 分照样在 23:59:59
 * 作废。用户的原话是「刚刚我在客户端打开了，然后登录领了 100 分」：**是打开
 * 客户端这个动作领取的**，不是服务自己领的。
 *
 * 果办官方客户端的语义就是「订阅页一挂载就自动领」；本服务替代它的方式只能是
 * 定时器，因为服务进程可能整周没人看面板。
 *
 * ## 定时 + 手动两条入口共用本函数
 *
 * 定时任务（`src/index.ts` 每小时）与面板「补领今日福利」按钮走同一条实现，
 * 差别只有 `force`：手动跳过去重闸门（用户点了就该真的试一次），定时不跳。
 * 共用实现是为了不让「手动能领到、定时领不到」这种漂移出现。
 *
 * ## 三条取舍（每条都能踩坑）
 *
 * 1. **只领 `enabled` 的账号**。与续期刻意相反（续期不看 `enabled`，因为
 *    refresh_token 会一路放到失效，那是**不可逆**损失）。而福利不发请求的
 *    唯一后果是「这个用户已停用的账号当天少一份额度」，可接受；反过来对用户
 *    明确弃用的账号发**写请求**则是越界。
 * 2. **串行而非并发**。与 `fetchBalancesInner` 同款理由：并发打同一个上游容易
 *    触发风控。账号数是个位数，串行的总耗时可以接受。
 * 3. **先按需续期**。V11 签名用的是 STS 临时凭据（寿命约 2 小时），过期的凭据
 *    打 claim 必失败。续期走 `refreshAccountOnce`（锁内重读 → 单飞 → 立即回写），
 *    与定时续期任务共用同一协调器 —— 确保一次性 refresh_token 不被消费两次。
 *
 * 失败一律「记录 + 继续」，绝不抛错：一个账号的凭据坏掉不该让其余账号错过
 * 当天额度（这一点与 `refreshDueAccounts` 同构）。
 */
export async function claimOfficeAceDailyBonuses(deps: OfficeAceBonusSweepDeps): Promise<OfficeAceBonusSweepResult> {
  const summary: OfficeAceBonusSweepResult = {
    claimed: 0, totalPoints: 0, alreadyClaimed: 0, failed: 0, skipped: 0, results: [],
  }
  const fetcher = deps.fetcher ?? fetch
  const now = deps.now ?? Date.now
  const force = deps.force === true
  const accounts = (await deps.pool.listAllAccounts()).filter((entry) => entry.provider === 'officeace')
  // 停用账号不参与（见函数头取舍 1）。
  const targets = accounts.filter((entry) => entry.enabled)
  summary.skipped += accounts.length - targets.length
  for (const entry of accounts) {
    if (!entry.enabled) {
      summary.results.push({ accountId: entry.id, nickname: entry.nickname, kind: 'skipped', points: 0, error: '账号已停用' })
    }
  }

  for (const entry of targets) {
    try {
      // ① 按需续期：STS 过期则 claim 必失败，续期走统一的单飞路径。
      let resolved = await deps.credentials.resolve(entry.credentialRef)
      if (resolved === undefined) {
        summary.skipped += 1
        summary.results.push({ accountId: entry.id, nickname: entry.nickname, kind: 'skipped', points: 0, error: '凭据不可读' })
        deps.logger.warn(`[officeace] 账号 ${entry.id} 领取当日福利跳过：凭据不可读（${entry.credentialRef}）`)
        continue
      }
      let credential = parseOfficeAceCredential(resolved.value)
      if (credential === undefined) {
        summary.skipped += 1
        summary.results.push({ accountId: entry.id, nickname: entry.nickname, kind: 'skipped', points: 0, error: '凭据不是合法 JSON' })
        deps.logger.warn(`[officeace] 账号 ${entry.id} 领取当日福利跳过：凭据不是合法 JSON`)
        continue
      }
      if (isExpiring(credential)) {
        try {
          await refreshAccountOnce({
            credentials: deps.credentials,
            pool: deps.pool,
            coordinator: deps.coordinator ?? new RefreshCoordinator(),
            logger: deps.logger,
            fetcher,
          }, entry)
        } catch (error) {
          // 续期失败仍用原凭据试一次：它可能只是临期而非已过期。
          deps.logger.warn(`[officeace] 账号 ${entry.id} 领取前续期失败: ${error instanceof Error ? error.message : String(error)}`)
        }
        resolved = await deps.credentials.resolve(entry.credentialRef)
        const refreshed = resolved === undefined ? undefined : parseOfficeAceCredential(resolved.value)
        if (refreshed !== undefined) credential = refreshed
      }

      // ② 领取（去重表按 ref + UTC+8 自然日；手动 force 跳过闸门）。
      const result = await maybeClaimOfficeAceBonus(credential, entry.credentialRef, fetcher, now, { force })
      if (result === undefined) {
        summary.skipped += 1
        summary.results.push({
          accountId: entry.id, nickname: entry.nickname, kind: 'skipped', points: 0,
          error: '今天已领过（未重复请求上游）',
        })
        continue
      }
      if (result.kind === 'claimed') {
        const points = result.claimed.reduce((sum, item) => sum + item.points, 0)
        const activities = result.claimed.map((i) => i.activityName)
        summary.claimed += 1
        summary.totalPoints += points
        summary.results.push({ accountId: entry.id, nickname: entry.nickname, kind: 'claimed', points, activities })
        deps.logger.info(`[officeace] 账号 ${entry.id} 领取当日福利成功：+${points} 分（${activities.join('、')}）`)
      } else if (result.kind === 'empty') {
        summary.alreadyClaimed += 1
        summary.results.push({
          accountId: entry.id, nickname: entry.nickname, kind: 'already-claimed', points: 0,
          error: '上游回空桶：今天的福利已经领过',
        })
      } else {
        summary.failed += 1
        summary.results.push({
          accountId: entry.id, nickname: entry.nickname, kind: 'failed', points: 0,
          error: '请求失败（网络或上游异常）',
        })
        deps.logger.warn(`[officeace] 账号 ${entry.id} 领取当日福利失败（下一轮重试）`)
      }
    } catch (error) {
      summary.failed += 1
      const message = error instanceof Error ? error.message : String(error)
      summary.results.push({ accountId: entry.id, nickname: entry.nickname, kind: 'failed', points: 0, error: message })
      deps.logger.warn(`[officeace] 账号 ${entry.id} 领取当日福利异常: ${message}`)
    }
  }

  if (summary.claimed > 0) {
    deps.logger.info(`[officeace] 本轮领取当日福利：${summary.claimed} 个账号共 +${summary.totalPoints} 分`)
  }
  return summary
}

/** 把凭据存储里的 JSON 文本解析成 OfficeAce 凭据；不合形返回 undefined。 */
function parseOfficeAceCredential(raw: string): OfficeAceCredential | undefined {
  try {
    const parsed = JSON.parse(raw) as unknown
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return undefined
    const candidate = parsed as Partial<OfficeAceCredential>
    if (typeof candidate.access !== 'string' || typeof candidate.securityToken !== 'string') return undefined
    return candidate as OfficeAceCredential
  } catch {
    return undefined
  }
}
