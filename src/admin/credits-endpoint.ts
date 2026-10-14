/**
 * 管理 API 的积分端点：余额查询 / 每日签到 / 新手任务。
 *
 * ## 与来源的关系
 *
 * 分派逻辑移植自来源仓库的 `jet-hub-rpc.ts`（case `credits.balances` /
 * `credits.claimAll` / `onboarding.claim`），把「cordis auth 服务实例」换成
 * **协议层纯函数**（`fetchXxxCreditBalance` / `claimXxxDailyCheckin`，全部
 * 已随协议文件移植）。来源注释里的关键教训（预检开关、带原因的失败、
 * earned 的满分语义）全部保留。
 *
 * ## 能力矩阵（前端 `credits-capabilities.js` 是唯一真相源）
 *
 * 未在此实现 balance 的 provider（`loomy` 有、`raccoon` 有；`cline` 有）；
 * 无签到能力的（workbuddy / qodercn 见矩阵 / cline / raccoon）在 claimAll
 * 里显式返回可读错误，而不是「unsupported provider」的泛化文案。
 */

import type { AccountPool } from '../pool/account-pool.js'
import type { CredentialStore } from '../pool/types.js'
import type { RefreshCoordinator } from '../pool/refresh-coordinator.js'
import { refreshAccountOnce } from '../refresh/refresh-account.js'
import { claimCodeArtsDailyCheckin, fetchCodeArtsAccountInfoDetailed } from '../providers/codearts-credits.js'
import type { CodeArtsCredential } from '../providers/types.js'
import { claimDailyCheckin, fetchCheckinStatus, type CheckinStatus, type ClaimOutcome, type CreditBalance } from '../providers/credits.js'
import { CODEBUDDY, WORKBUDDY, productById, type BuddyProduct } from '../providers/product.js'
import type { BuddyCredential } from '../providers/types.js'
import { fetchCreditBalance } from '../providers/credits.js'
import { LOBSTERAI } from '../providers/lobsterai-product.js'
import { claimLobsteraiDailyCheckin, fetchLobsteraiCreditBalance } from '../providers/lobsterai-credits.js'
import type { LobsteraiCredential } from '../providers/lobsterai.js'
import { LobsteraiClientVersionResolver } from '../providers/lobsterai.js'
import { QODER, QODER_CN, type QoderProduct } from '../providers/qoder-product.js'
import { claimQoderDailyCheckin, fetchQoderCreditBalance } from '../providers/qoder-credits.js'
import type { QoderCredential } from '../providers/qoder.js'
import { TRAE } from '../providers/trae-product.js'
import { claimTraeDailyCheckin, fetchTraeCheckinStatus, fetchTraeCreditBalance } from '../providers/trae-credits.js'
import type { TraeCredential } from '../providers/trae.js'
import { CLINE } from '../providers/cline-product.js'
import { fetchClineCreditBalance } from '../providers/cline-credits.js'
import type { ClineCredential } from '../providers/cline.js'
import { LOOMY } from '../providers/loomy-product.js'
import { LOOMY_TASK_TITLES, claimAllLoomyOnboardingTasks } from '../providers/loomy-onboarding.js'
import { claimLoomyDailyQuota, fetchLoomyCreditBalance } from '../providers/loomy-credits.js'
import type { LoomyCredential } from '../providers/loomy.js'
import { RACCOON } from '../providers/raccoon-product.js'
import {
  claimRaccoonLoginReward,
  fetchRaccoonCreditBalanceDetailed,
  fetchRaccoonOnboardingStatus,
  keepAliveRaccoonDailyPoints,
  type RaccoonBalanceResult,
  type RaccoonKeepaliveOutcome,
} from '../providers/raccoon-credits.js'
import { isRaccoonExpired, type RaccoonCredential } from '../providers/raccoon.js'
import { credentialRef } from '../providers/credential-ref.js'
import type { ProviderAccountEntry } from '../providers/types.js'

/** 积分端点的依赖注入。 */
export interface CreditsEndpointDeps {
  pool: AccountPool
  credentials: CredentialStore
  fetcher?: typeof fetch
  /**
   * 单飞刷新协调器（**必须与定时任务/请求路径共用同一个实例**）。
   *
   * raccoon 的 `refresh_token` 一次性轮换：两条路径各持一个协调器等于没单飞，
   * 一次性 token 会被消费两次、后那次必然失败。省略时 raccoon 的「按需续期」
   * 自动降级为不续期（直接用现有凭据打上游，由上游 401 如实归类）。
   */
  coordinator?: RefreshCoordinator
  warn?(message: string): void
}

/** 单账号的余额条目（jet-hub 消费形状）。 */
export interface CreditBalanceItem {
  accountId: string
  nickname: string
  balance: CreditBalance | null
  error?: string
}

export interface CreditsBalancesResponse {
  accounts: CreditBalanceItem[]
}

/** 单账号的领取结果条目。 */
export interface ClaimResultItem {
  accountId: string
  nickname: string
  outcome: ClaimOutcome
}

export interface ClaimSummary {
  claimed: number
  totalCredit: number
  alreadyClaimed: number
  inactive: number
  failed: number
}

export interface ClaimAllResponse {
  summary: ClaimSummary
  results: ClaimResultItem[]
}

/** 解析凭据 ref 指向的 JSON；失败返回 undefined（由调用方给出可读错误）。 */
async function resolveJson(deps: CreditsEndpointDeps, entry: ProviderAccountEntry): Promise<Record<string, unknown> | undefined> {
  const resolved = await deps.credentials.resolve(credentialRef(entry.credentialRef))
  if (resolved === undefined) return undefined
  try {
    const parsed = JSON.parse(resolved.value) as unknown
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>
    }
    return undefined
  } catch {
    return undefined
  }
}

/**
 * 取 raccoon 账号「此刻最新」的凭据；**已过期则先续期**。
 *
 * ## 为什么面板路径也要续期
 *
 * 积分/保活是用户**主动点一下**的一次性动作。此时凭据若刚过期，直接拿它打上游
 * 只会拿到 401，而用户看到的是「查询失败」—— 上游其实是好的。续一次就好。
 *
 * ## 为什么必须走 `refreshAccountOnce`
 *
 * 它做的正是「锁内重读 → 单飞刷新 → 立即回写」三步（`refresh-account.ts`），
 * 与定时任务、请求路径**共用同一实现与同一个协调器**。raccoon 的
 * `refresh_token` 一次性轮换，绕过它自己打一发 `/refresh` 会把好账号刷死。
 *
 * ⚠️ **续期失败不抛出**：凭据也可能只是被服务端作废（续期同样救不回来），
 * 那时把原始凭据交出去，让上游的 401 被如实归类成「登录态已失效」——
 * 那才是用户该看到的结论，而不是一句「查询失败」。
 */
async function resolveRaccoonCredential(
  deps: CreditsEndpointDeps,
  entry: ProviderAccountEntry,
): Promise<Record<string, unknown> | undefined> {
  const current = await resolveJson(deps, entry)
  if (current === undefined) return undefined
  if (deps.coordinator === undefined) return current
  if (!isRaccoonExpired(current as unknown as RaccoonCredential)) return current

  try {
    await refreshAccountOnce({
      credentials: deps.credentials,
      pool: deps.pool,
      coordinator: deps.coordinator,
      logger: { info: () => {}, warn: (m) => deps.warn?.(m), error: (m) => deps.warn?.(m) },
      ...deps.fetcher === undefined ? {} : { fetcher: deps.fetcher },
    }, entry)
  } catch (error) {
    deps.warn?.(`[credits] raccoon 账号 ${entry.id} 按需续期失败: ${String(error)}`)
  }
  // 续期成功后凭据已写回存储，重读一次拿到新 token；读不到则退回原值。
  return (await resolveJson(deps, entry)) ?? current
}

// ───────────────────────── 余额查询 ─────────────────────────

/**
 * 逐账号查询积分余额（顺序执行，避免并发触发风控）。
 *
 * 失败保留原因（`error` 字段）：余额查不到时用户最需要知道「为什么」，
 * 降级成 null 会让卡片显示空白或误导性的 0。
 */
export async function fetchBalances(provider: string, deps: CreditsEndpointDeps): Promise<CreditsBalancesResponse> {
  const fetcher = deps.fetcher ?? fetch
  const accounts = await deps.pool.listAccounts(provider)
  const out: CreditBalanceItem[] = []

  /** 通用查询循环（余额函数按 provider 注入）。 */
  const collect = async (
    fetchBalance: (credential: Record<string, unknown>) => Promise<CreditBalance | null>,
  ): Promise<CreditsBalancesResponse> => {
    for (const entry of accounts) {
      let balance: CreditBalance | null = null
      let error: string | undefined
      try {
        const credential = await resolveJson(deps, entry)
        if (credential === undefined) {
          error = '凭据未配置或已损坏'
        } else {
          balance = await fetchBalance(credential)
          if (balance === null) error = '余额查询失败'
        }
      } catch (caught) {
        deps.warn?.(`[credits] balances 账号 ${entry.id} 失败: ${String(caught)}`)
        error = caught instanceof Error ? caught.message : String(caught)
        balance = null
      }
      out.push({ accountId: entry.id, nickname: entry.nickname, balance, ...(error === undefined ? {} : { error }) })
    }
    return { accounts: out }
  }

  // codearts：余额来自 statistics/plugin（与账户类型检测同一响应），
  // 非积分账户显示具体原因而不是「查询失败」。
  if (provider === 'codearts') {
    for (const entry of accounts) {
      let balance: CreditBalance | null = null
      let error: string | undefined
      try {
        const credential = await resolveJson(deps, entry) as unknown as CodeArtsCredential | undefined
        if (credential === undefined) {
          error = '凭据未配置或已损坏'
        } else {
          const result = await fetchCodeArtsAccountInfoDetailed(credential)
          if (!result.ok) {
            error = `账户信息查询失败：${result.message}`
          } else if (!result.info.isCreditPackage) {
            error = result.info.isTokenPackage ? 'Token 计费账户，无积分余额' : '非积分计费账户，无积分余额'
          } else if (result.info.credit === undefined) {
            error = '未返回积分数据'
          } else {
            balance = result.info.credit
          }
        }
      } catch (caught) {
        error = caught instanceof Error ? caught.message : String(caught)
      }
      out.push({ accountId: entry.id, nickname: entry.nickname, balance, ...(error === undefined ? {} : { error }) })
    }
    return { accounts: out }
  }

  if (provider === LOBSTERAI.id) {
    return collect((credential) => fetchLobsteraiCreditBalance(credential as unknown as LobsteraiCredential, LOBSTERAI, fetcher))
  }
  if (provider === 'qoder' || provider === 'qodercn') {
    const product: QoderProduct = provider === 'qoder' ? QODER : QODER_CN
    return collect((credential) => fetchQoderCreditBalance(credential as unknown as QoderCredential, product, fetcher))
  }
  if (provider === TRAE.id) {
    return collect((credential) => fetchTraeCreditBalance(credential as unknown as TraeCredential, TRAE, fetcher))
  }
  if (provider === CLINE.id) {
    // ⚠️ 必须用凭据里的 account_id（usr-…），不是 JWT 的 sub（user_…）。
    // fetchClineCreditBalance 返回带原因的 ClineBalanceResult(balance + error)。
    for (const entry of accounts) {
      let balance: CreditBalance | null = null
      let error: string | undefined
      try {
        const credential = await resolveJson(deps, entry) as unknown as ClineCredential | undefined
        if (credential === undefined) {
          error = '凭据未配置或已损坏'
        } else {
          const result = await fetchClineCreditBalance(credential, CLINE, fetcher)
          balance = result.balance
          if (result.balance === null) error = result.error ?? '积分查询失败（凭据失效或响应异常）'
        }
      } catch (caught) {
        deps.warn?.(`[credits] balances 账号 ${entry.id} 失败: ${String(caught)}`)
        error = caught instanceof Error ? caught.message : String(caught)
      }
      out.push({ accountId: entry.id, nickname: entry.nickname, balance, ...(error === undefined ? {} : { error }) })
    }
    return { accounts: out }
  }
  if (provider === LOOMY.id) {
    // 余额来自 GET /points/records（只读）。⚠️ 刻意不用 first-login：
    // 那是写端点，在「打开面板」的高频路径上会意外触发签到。
    return collect((credential) => fetchLoomyCreditBalance(credential as unknown as LoomyCredential, LOOMY, fetcher))
  }
  if (provider === RACCOON.id) {
    // ⚠️ 单独一个循环而不用上面的 `collect`：余额结果带**原因分类**，
    // 「登录态已失效」与「上游暂时不可用」要给用户完全不同的行动指令
    // （前者重新登录、后者稍后重试），压成同一句「查询失败」等于没说。
    for (const entry of accounts) {
      let balance: CreditBalance | null = null
      let error: string | undefined
      try {
        const credential = await resolveRaccoonCredential(deps, entry)
        if (credential === undefined) {
          error = '凭据未配置或已损坏'
        } else {
          const result = await fetchRaccoonCreditBalanceDetailed(
            RACCOON,
            credential as unknown as RaccoonCredential,
            fetcher,
          )
          if (result.kind === 'ok') {
            balance = result.balance
          } else {
            error = raccoonBalanceErrorMessage(result)
          }
        }
      } catch (caught) {
        deps.warn?.(`[credits] balances 账号 ${entry.id} 失败: ${String(caught)}`)
        error = caught instanceof Error ? caught.message : String(caught)
        balance = null
      }
      out.push({ accountId: entry.id, nickname: entry.nickname, balance, ...(error === undefined ? {} : { error }) })
    }
    return { accounts: out }
  }
  const product = productById(provider)
  if (product !== undefined) {
    return collect((credential) => fetchCreditBalance(credential as unknown as BuddyCredential, product, fetcher))
  }
  throw new Error(`provider ${provider} 不支持积分余额查询`)
}

// ───────────────────────── Raccoon 余额错误文案 ─────────────────────────

/**
 * 把 raccoon 余额查询结果翻成**可行动**的错误文案。
 *
 * ⚠️ 关键是 `auth-expired` 不能跟其余几种混：它意味着「重新登录」，
 * 而 `unavailable` / `no-data` 意味着「稍后重试」或「服务端返回异常」。
 * 旧实现三种都显示「余额查询失败」，用户无从判断该做什么。
 */
function raccoonBalanceErrorMessage(result: Exclude<RaccoonBalanceResult, { kind: 'ok' }>): string {
  if (result.kind === 'auth-expired') {
    return `登录态已失效，请重新登录（${result.code} ${result.message}）—— 重试不会好转`
  }
  if (result.kind === 'unavailable') {
    return `上游暂时不可用（${result.code} ${result.message}），请稍后重试`
  }
  return `服务端未返回积分数据（${result.code} ${result.message}）`
}

// ───────────────────────── 每日签到 ─────────────────────────

/** 汇总领取结果（照抄来源 computeClaimSummary）。 */
function computeClaimSummary(outcomes: readonly ClaimOutcome[]): ClaimSummary {
  const summary: ClaimSummary = { claimed: 0, totalCredit: 0, alreadyClaimed: 0, inactive: 0, failed: 0 }
  for (const outcome of outcomes) {
    switch (outcome.kind) {
      case 'claimed':
        summary.claimed += 1
        summary.totalCredit += outcome.credit
        break
      case 'already-claimed':
        summary.alreadyClaimed += 1
        break
      case 'inactive':
        summary.inactive += 1
        break
      default:
        summary.failed += 1
        break
    }
  }
  return summary
}

/**
 * 对指定 provider 的全部账号执行每日签到。
 *
 * `precheckStatus`：CodeBuddy 系需要先查状态（活动未开启/今日已领则跳过
 * 领取请求）；领取流程自带状态判断的（lobsterai / codearts / qoder / loomy）
 * 显式关闭，避免重复发一次请求。
 */
export async function claimAll(provider: string, deps: CreditsEndpointDeps): Promise<ClaimAllResponse> {
  const fetcher = deps.fetcher ?? fetch
  const accounts = await deps.pool.listAccounts(provider)

  const collect = async (
    claim: (credential: Record<string, unknown>, entry: ProviderAccountEntry) => Promise<ClaimOutcome>,
  ): Promise<ClaimAllResponse> => {
    const results: ClaimResultItem[] = []
    const outcomes: ClaimOutcome[] = []
    for (const entry of accounts) {
      let outcome: ClaimOutcome
      try {
        const credential = await resolveJson(deps, entry)
        if (credential === undefined) {
          outcome = { kind: 'failed', code: -1, message: '凭据未配置或已损坏' }
        } else {
          outcome = await claim(credential, entry)
        }
      } catch (error) {
        deps.warn?.(`[credits] claimAll 账号 ${entry.id} 失败: ${String(error)}`)
        outcome = { kind: 'failed', code: -1, message: error instanceof Error ? error.message : String(error) }
      }
      outcomes.push(outcome)
      results.push({ accountId: entry.id, nickname: entry.nickname, outcome })
    }
    return { summary: computeClaimSummary(outcomes), results }
  }

  // CodeBuddy 系：先查状态（活动未开启/今日已领则跳过），减少无效调用。
  if (provider === 'buddy' || provider === 'workbuddy') {
    const product: BuddyProduct = provider === 'buddy' ? CODEBUDDY : WORKBUDDY
    return collect(async (credential) => {
      const status: CheckinStatus | null = await fetchCheckinStatus(credential as unknown as BuddyCredential, product, fetcher)
      if (status !== null && !status.active) return { kind: 'inactive', message: '签到活动未开启' }
      if (status !== null && status.todayCheckedIn) return { kind: 'already-claimed', message: '今天已签到' }
      // 状态查询失败（null）时仍尝试领取：无法确认不代表不能领。
      return claimDailyCheckin(credential as unknown as BuddyCredential, product, fetcher)
    })
  }
  if (provider === 'qoder' || provider === 'qodercn') {
    // Qoder 的领取流程自带活动列表查询（幂等判据是响应体 replayed:true）。
    const product: QoderProduct = provider === 'qoder' ? QODER : QODER_CN
    return collect((credential) => claimQoderDailyCheckin(credential as unknown as QoderCredential, product, fetcher))
  }
  if (provider === 'codearts') {
    // 领取流程自带「账户类型 + 活动列表」预检（华为签名协议）。
    return collect((credential) => claimCodeArtsDailyCheckin(credential as unknown as CodeArtsCredential, fetcher))
  }
  if (provider === LOBSTERAI.id) {
    // clientVersion 是签到必填参数，动态解析（带缓存）。
    const resolver = new LobsteraiClientVersionResolver({ fetcher })
    const { version: clientVersion } = await resolver.resolve(LOBSTERAI)
    return collect((credential) => claimLobsteraiDailyCheckin(credential as unknown as LobsteraiCredential, LOBSTERAI, clientVersion, fetcher))
  }
  if (provider === TRAE.id) {
    return collect(async (credential, entry) => {
      // ⚠️ TRAE 的 claim 对「今天已签到」是幂等的（无法区分），必须先查状态。
      const status = await fetchTraeCheckinStatus(credential as unknown as TraeCredential, TRAE, fetcher)
      if (status !== null && !status.active) return { kind: 'inactive', message: '签到活动未开启' }
      if (status !== null && status.todayCheckedIn) return { kind: 'already-claimed', message: '今天已签到' }
      return claimTraeDailyCheckin(
        credential as unknown as TraeCredential,
        TRAE,
        fetcher,
        // 签到限流的范围是 device_id 而非账号：命中后代次 +1 派生新设备号。
        deps.pool.traeCheckinDeviceGenerationFor(entry.id),
        (next) => deps.pool.updateTraeCheckinDeviceGeneration(entry.id, next),
      )
    })
  }
  if (provider === LOOMY.id) {
    // Loomy 的「签到」= 触发每日赠送额度（自带幂等判据，不做额外预检）。
    return collect((credential) => claimLoomyDailyQuota(credential as unknown as LoomyCredential, LOOMY, fetcher))
  }
  if (provider === CLINE.id) {
    throw new Error('Cline 不支持每日签到（其后端没有签到接口）')
  }
  if (provider === RACCOON.id) {
    throw new Error('Raccoon Work 不支持每日签到（每日积分由服务端自动发放；登录奖励请在「新手任务」中领取）')
  }
  throw new Error(`provider ${provider} 不支持每日签到`)
}

// ───────────────────────── 新手任务（一次性） ─────────────────────────

/**
 * 领取新手任务（raccoon 登录奖励 / loomy 新手任务，两者一次性）。
 *
 * ⚠️ **已领时 earned 必须报满分**（来源真实缺陷）：earned 回答的是
 * 「该项目累计领到多少」，与「本次是否新增」无关。
 */
export async function claimOnboarding(
  provider: string,
  accountId: string,
  deps: CreditsEndpointDeps,
): Promise<{ claimed: Array<{ key: string; title: string; points: number }>; skipped: string[]; earned: number; total: number }> {
  const fetcher = deps.fetcher ?? fetch
  if (provider !== LOOMY.id && provider !== RACCOON.id) {
    throw new Error(`provider ${provider} 没有新手任务`)
  }
  const account = deps.pool.findAccount(accountId)
  if (account === undefined) throw new Error('账号不存在')
  const credential = await (provider === RACCOON.id
    ? resolveRaccoonCredential(deps, account)
    : resolveJson(deps, account))
  if (credential === undefined) throw new Error('凭据未配置或已损坏')

  if (provider === RACCOON.id) {
    // 领取端点幂等：已领过返回 granted:false。
    const outcome = await claimRaccoonLoginReward(RACCOON, credential as unknown as RaccoonCredential, fetcher)
    if (outcome.kind === 'failed') throw new Error(outcome.message)
    const claimed = outcome.kind === 'claimed'
      ? [{ key: 'desktop_login_reward', title: '桌面端登录奖励', points: outcome.credit }]
      : []
    const points = outcome.kind === 'claimed'
      ? outcome.credit
      : (await fetchRaccoonOnboardingStatus(RACCOON, credential as unknown as RaccoonCredential, fetcher)).points
    return {
      claimed,
      skipped: outcome.kind === 'already-claimed' ? ['desktop_login_reward'] : [],
      earned: points,
      total: points,
    }
  }

  // Loomy 新手任务：逐个补差额领取。
  const result = await claimAllLoomyOnboardingTasks(credential as unknown as LoomyCredential, LOOMY, fetcher)
  return {
    claimed: result.claimed.map(item => ({
      key: item.key,
      title: LOOMY_TASK_TITLES[item.key] ?? item.key,
      points: item.points,
    })),
    skipped: result.skipped,
    earned: result.earned,
    total: result.total,
  }
}

// ───────────────────────── 每日积分保活（仅 raccoon）─────────────────────────

/** 单账号的保活结果。 */
export interface KeepaliveResultItem {
  accountId: string
  nickname: string
  outcome: RaccoonKeepaliveOutcome | null
  /** 失败原因（凭据损坏 / 请求异常）；成功时为 undefined。 */
  error?: string
}

export interface KeepaliveSummary {
  /** 本次真正触发延长（`kind === 'extended'`）的账号数。 */
  extended: number
  /** 当天早已延长（官方客户端登录过，或本操作之前跑过）的账号数。 */
  alreadyExtended: number
  /** 候选端点**调用成功**但都没触发延长的账号数。 */
  notExtended: number
  /**
   * 候选端点**全部因服务级错误失败**（如上游整体 503 / `code=200903`）的账号数。
   *
   * ⚠️ 与 `notExtended` **必须分开**：这不是「端点无效」，而是**上游暂时不可用**，
   * 用户应稍后重试。混为一谈会把服务端故障说成功能结论。
   */
  unavailable: number
  /**
   * **登录态已失效**（上游 401 / `code=200003 authorization_verify_error`）的账号数。
   *
   * ⚠️ 与 `unavailable` **必须分开**：两者都表现为「候选端点都调不通」，但
   * 这一个的根因是凭据被服务端作废，**重试永远不会好**，只能重新登录。
   * 旧实现把它并进 `unavailable` 并提示「请稍后重试」—— 用户照做无数次
   * 依旧失败，还误以为功能坏了（2026-10-14 用户报障的真实形态）。
   */
  authExpired: number
  failed: number
}

export interface KeepaliveResponse {
  summary: KeepaliveSummary
  results: KeepaliveResultItem[]
}

/**
 * 对 raccoon 的全部账号执行「每日积分保活」。
 *
 * ## 它解决什么
 *
 * 每日 300 积分由服务端自动发放，但**不登录就当天 24:00 清零**。用户
 * 「半夜电脑没开机」时，第二天醒来积分已经作废。本操作模拟一次「当日登录」
 * 把有效期延长到 7 天 —— 供用户在方便的时候手动点一下。
 *
 * ## 为什么需要手动按钮而不是定时任务
 *
 * 定时任务在服务进程里跑，而用户常关机；**手动按钮不依赖机器整夜开机**，
 * 且语义明确（用户点一下 = 我知道现在要保活）。将来若确证了触发端点，
 * 可在此之上再加定时器，本函数即为那层的现成实现。
 *
 * ## 为什么逐个账号串行 + 不抛错
 *
 * 与 `claimAll` 同构：单账号失败（凭据过期、网络抖动）不应中断整批，
 * 且失败要带**可读原因**——用户需要区分「凭据坏了」与「端点没触发」。
 *
 * ## 为什么先按需续期
 *
 * 见 {@link resolveRaccoonCredential}：用户点按钮的那一刻凭据可能刚过期，
 * 不续期就只能拿到一句 401，而服务端其实是好的。
 */
export async function keepAliveDailyPoints(provider: string, deps: CreditsEndpointDeps): Promise<KeepaliveResponse> {
  const fetcher = deps.fetcher ?? fetch
  if (provider !== RACCOON.id) {
    throw new Error(`provider ${provider} 不支持每日积分保活（目前仅 Raccoon Work）`)
  }
  const accounts = await deps.pool.listAccounts(provider)
  const results: KeepaliveResultItem[] = []
  const summary: KeepaliveSummary = {
    extended: 0, alreadyExtended: 0, notExtended: 0, unavailable: 0, authExpired: 0, failed: 0,
  }

  for (const entry of accounts) {
    try {
      const credential = await resolveRaccoonCredential(deps, entry)
      if (credential === undefined) {
        summary.failed += 1
        results.push({ accountId: entry.id, nickname: entry.nickname, outcome: null, error: '凭据未配置或已损坏' })
        continue
      }
      const outcome = await keepAliveRaccoonDailyPoints(
        RACCOON,
        credential as unknown as RaccoonCredential,
        fetcher,
      )
      switch (outcome.kind) {
        case 'extended': summary.extended += 1; break
        case 'already-extended': summary.alreadyExtended += 1; break
        case 'unavailable': summary.unavailable += 1; break
        case 'auth-expired': summary.authExpired += 1; break
        default: summary.notExtended += 1
      }
      results.push({ accountId: entry.id, nickname: entry.nickname, outcome })
    } catch (error) {
      deps.warn?.(`[credits] keepalive 账号 ${entry.id} 失败: ${String(error)}`)
      summary.failed += 1
      results.push({
        accountId: entry.id,
        nickname: entry.nickname,
        outcome: null,
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }
  return { summary, results }
}
