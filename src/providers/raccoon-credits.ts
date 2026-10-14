/**
 * Raccoon Work 积分（余额 + 一次性登录奖励）。
 *
 * ## ⚠️ 三个来源的语义（关键）
 *
 * | 来源 | 金额 | 触发方式 | 本模块 |
 * |---|---|---|---|
 * | 新人注册礼包 | 3000 | 注册时服务端自动发放 | 不涉及（用户注册即有） |
 * | 桌面端登录奖励 | 3000 | `POST …/login/points/grant` | ✅ `claimRaccoonLoginReward` |
 * | 每日积分发放 | 300 | **服务端按日自动发放，无端点** | ❌ 不实现 |
 *
 * ⚠️ **每日 300 没有签到端点** —— 实测该账号 13:30 注册、13:31 就收到
 * `daily_grant` 账单（`biz_type: 'daily_grant'`）。故**不能**把它实现成
 * 签到按钮：不存在可调用的端点，按钮必然失败。
 *
 * ⚠️ **登录奖励是幂等一次性的**（已领过返回 `granted:false`），
 * 语义与 Loomy 的新手任务同构，故登记为 `onboardingTasks` 而**不是**
 * `dailyCheckin` —— 后者会让用户以为每天都真的加了额度。
 *
 * ## 只读优先
 *
 * 余额查询用 `GET /points/v1/balance`（**只读**）。在「打开面板」这类
 * 高频路径上**绝不**触碰写端点（Loomy 的 `first-login` 就踩过这个坑：
 * 打开面板即意外触发签到）。
 */

import {
  RACCOON_POINTS_PREFIX,
  RACCOON_DESKTOP_PREFIX,
  RACCOON_REQUEST_TIMEOUT_MS,
  raccoonHeaders,
  type RaccoonCredential,
} from './raccoon.js'
import { RACCOON, type RaccoonProduct } from './raccoon-product.js'
import type { ClaimOutcome, CreditBalance, CreditPackage } from './credits.js'

/** 保活候选端点。 */
export interface RaccoonKeepaliveCandidate {
  /** 端点标识（用于回传「哪个候选命中了」）。 */
  id: string
  /** 展示名（写进结果文案，便于用户与排查者理解）。 */
  label: string
}

/** 当天（UTC+8）的每日积分发放记录。 */
export interface RaccoonDailyGrantRecord {
  /** 发放日（服务端口径，形如 `2026-10-09T00:00:00+08:00`）。 */
  grantAt: string
  /**
   * 延长发生时刻。
   *
   * ⚠️ 这是判定「当天是否已登录」的**核心字段**：整点 `00:00:00` 表示
   * 纯服务端发放、未延长；真实时刻表示那一刻有客户端动作、已延长。
   */
  createdAt: string | undefined
  /** 有效期截止（已延长时为 7 天后）。 */
  expireAt: string | undefined
  /** 发放积分数。 */
  points: number | undefined
}

/** 单个候选端点的探测结果（诊断用，如实回传原始业务码）。 */
export interface RaccoonKeepaliveAttempt {
  /** 端点 id。 */
  id: string
  /** 端点展示名。 */
  label: string
  /** 是否 HTTP 2xx 且业务码 0（端点本身调用成功）。 */
  ok: boolean
  /** 上游业务码（`ok` 时为 0）。 */
  code: number
  /** 上游消息（失败时用于排查，如 `service_unavailable`）。 */
  message: string
}

/** 每日积分保活的结果。 */
export type RaccoonKeepaliveOutcome =
  | {
    kind: 'already-extended'
    createdAt: string | undefined
    expireAt: string | undefined
    points: number | undefined
    /**
     * ⚠️ 如实说明：**本函数未发任何请求**，只是探测到「今天已有非整点的
     * `daily_grant` 记录」。
     *
     * 该记录可能来自**用户自己打开官方客户端**（客户端登录即会触发延长），
     * 也可能是本函数或用户此前手动点过保活。前端必须据此区分，**不能**
     * 把它显示成「本次保活成功」—— 那会让用户误以为本功能生效了。
     */
    note: string
  }
  | {
    kind: 'extended'
    /** 命中的候选端点 id（**自证**哪个端点真正有效）。 */
    trigger: string
    triggerLabel: string
    expireAt: string | undefined
    points: number | undefined
  }
  | {
    /**
     * 候选端点**都调用成功了，但账单没有变化** —— 说明「触发条件不止于这些
     * 端点」（真正的触发源可能是客户端特有的握手/设备绑定）。
     *
     * ⚠️ 与 `unavailable` **必须分开**：前者是我们「试了但没用」，后者是
     * 「压根没试成（上游报错）」。
     */
    kind: 'not-extended'
    /** 已尝试过的候选端点 id。 */
    tried: string[]
    /** 逐端点的原始结果（诊断用）。 */
    attempts: RaccoonKeepaliveAttempt[]
    message: string
  }
  | {
    /**
     * 候选端点**全部因服务级错误失败**（如上游整体 `HTTP 503`
     * `code=200903 service_unavailable`），延长**从未有机会发生**。
     *
     * ⚠️ 这**不是**「端点无效」的证据，而是**上游暂时不可用** —— 用户应稍后
     * 重试，而不是以为该功能坏了。此前这种情形被错误地并入 `not-extended`
     * 并显示成「候选端点均未触发延长」，把服务端故障说成了功能结论。
     */
    kind: 'unavailable'
    tried: string[]
    attempts: RaccoonKeepaliveAttempt[]
    /** 最后一次错误（含业务码），便于用户/排查者识别。 */
    lastError: string
    message: string
  }

/** 登录奖励的默认额度（服务端未在 popup 里给出时兜底）。 */
export const RACCOON_LOGIN_REWARD_POINTS = 3000

/** 登录奖励在账单里的 `event_name`（用于判定是否已领）。 */
export const RACCOON_LOGIN_REWARD_EVENT_NAME = '桌面端登录奖励'

/** 业务响应信封。 */
interface Envelope {
  ok: boolean
  code: number
  message: string
  data: Record<string, unknown> | undefined
}

/** 解析信封；`code === 0` 为成功。 */
function parseEnvelope(payload: unknown, status: number): Envelope {
  const record = typeof payload === 'object' && payload !== null && !Array.isArray(payload)
    ? payload as Record<string, unknown>
    : {}
  const code = typeof record.code === 'number' ? record.code : (status >= 400 ? status : 0)
  const message = typeof record.message === 'string' && record.message.length > 0
    ? record.message
    : (typeof record.details === 'string' ? record.details : '')
  const data = typeof record.data === 'object' && record.data !== null && !Array.isArray(record.data)
    ? record.data as Record<string, unknown>
    : undefined
  return { ok: code === 0, code, message, data }
}

/** 读成有限数字；非法返回 undefined（**不编造 0**）。 */
function readNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

/**
 * 发一次业务请求并拆信封。
 *
 * ⚠️ 不抛错 —— 调用方按 `ok` 分支处理。积分查询/领取属「尽力而为」，
 * 批量操作时单个账号失败不应中断其余账号。
 */
async function requestJson(
  url: string,
  credential: RaccoonCredential,
  product: RaccoonProduct,
  init: { method: string; body?: string },
  fetcher: typeof fetch,
): Promise<Envelope> {
  try {
    const response = await fetcher(url, {
      method: init.method,
      headers: raccoonHeaders(credential, {
        platform: product.clientPlatform,
        version: product.clientVersion,
      }),
      ...init.body === undefined ? {} : { body: init.body },
      signal: AbortSignal.timeout(RACCOON_REQUEST_TIMEOUT_MS),
    })
    const parsed: unknown = await response.json()
    return parseEnvelope(parsed, response.status)
  } catch (error) {
    return {
      ok: false,
      code: -1,
      message: error instanceof Error ? error.message : String(error),
      data: undefined,
    }
  }
}

/** 构造一个资源包条目。 */
function makePackage(name: string, remaining: number): CreditPackage {
  return {
    name,
    unit: '积分',
    remaining,
    total: remaining,
    used: 0,
    active: true,
    cycleStartTime: '',
    cycleEndTime: '',
    expiredTime: '',
  }
}

/**
 * 查询积分余额（映射成既有的 `CreditBalance` 形状）。
 *
 * ⚠️ 各池**分开作 package**，让用户看出「注册礼包 / 每日 / 充值」是独立来源
 * —— 它们的有效期与回补规则都不同（每日积分每日刷新、充值积分长期有效）。
 *
 * @returns 查不到时返回 `null`（卡片显示原因，**不是** 0）。
 */
export async function fetchRaccoonCreditBalance(
  product: RaccoonProduct,
  credential: RaccoonCredential,
  fetcher: typeof fetch = fetch,
): Promise<CreditBalance | null> {
  const envelope = await requestJson(
    `${product.apiBase}${RACCOON_POINTS_PREFIX}/balance`,
    credential,
    product,
    { method: 'GET' },
    fetcher,
  )
  if (!envelope.ok || envelope.data === undefined) return null

  const available = readNumber(envelope.data.available_points)
  // `available_points` 是核心字段：没有它就说明响应形状不对，不编造数字。
  if (available === undefined) return null

  const packages: CreditPackage[] = []
  const reward = readNumber(envelope.data.reward_points)
  const daily = readNumber(envelope.data.daily_points)
  const topup = readNumber(envelope.data.topup_points)
  const monthly = readNumber(envelope.data.monthly_points)
  if (reward !== undefined) packages.push(makePackage('奖励积分', reward))
  if (daily !== undefined) packages.push(makePackage('每日积分', daily))
  if (monthly !== undefined && monthly > 0) packages.push(makePackage('会员积分', monthly))
  if (topup !== undefined) packages.push(makePackage('充值积分', topup))

  return {
    total: available,
    // 极端情形（服务端只给 total 不给分项）也要有至少一个包，否则 UI 空列表
    packages: packages.length > 0 ? packages : [makePackage('可用积分', available)],
    expiredTotal: 0,
  }
}

/**
 * 领取「桌面端登录奖励」（一次性，幂等）。
 *
 * ⚠️ **不是每日签到**：实测该端点是幂等一次性的（已领过返回 `granted:false`
 * 且账单里能看到上一次的记录）。映射到 `onboardingTasks` 能力。
 *
 * ⚠️ 需要 `X-Client-Platform` 头（值见 `product.clientPlatform`）——
 * 它标识「来自桌面端」，缺了会被拒。见 `raccoonHeaders`。
 *
 * 本函数**不抛错**（失败也返回 `failed`），保证批量领取不会因单个账号中断。
 */
export async function claimRaccoonLoginReward(
  product: RaccoonProduct,
  credential: RaccoonCredential,
  fetcher: typeof fetch = fetch,
): Promise<ClaimOutcome> {
  const envelope = await requestJson(
    `${product.apiBase}${RACCOON_DESKTOP_PREFIX}/login/points/grant`,
    credential,
    product,
    { method: 'POST' },
    fetcher,
  )

  if (!envelope.ok) {
    return {
      kind: 'failed',
      code: envelope.code,
      message: envelope.message.length > 0 ? envelope.message : '领取登录奖励失败',
    }
  }

  // ⚠️ 幂等判据是 `granted`（重复领取同样返回 HTTP 200 + `granted:false`），
  // 故映射成 `already-claimed` 而**不是** `claimed` ——
  // 后者会让用户以为每天都真的加了额度。
  if (envelope.data?.granted !== true) {
    return {
      kind: 'already-claimed',
      message: '该账号已领取过桌面端登录奖励（每号一次）',
    }
  }

  const popup = typeof envelope.data.popup === 'object' && envelope.data.popup !== null
    ? envelope.data.popup as Record<string, unknown>
    : undefined
  const points = readNumber(popup?.points) ?? RACCOON_LOGIN_REWARD_POINTS
  return { kind: 'claimed', credit: points, streakDays: 0, isStreakDay: false }
}

/**
 * 查询「桌面端登录奖励」是否已领（供 `onboarding.status` 用）。
 *
 * 判据：`GET /points/v1/bills` 里是否已有
 * `biz_type === 'reward_grant'` 且 `event_name === '桌面端登录奖励'` 的记录。
 *
 * ⚠️ **不能靠 `balance` 推断** —— 余额是多个来源（注册礼包/每日/充值）的
 * 合计，无法区分某一项是否已领。
 * ⚠️ **不能只按 `biz_type === 'reward_grant'` 判定** —— 「新人注册礼包」
 * 也是 `reward_grant`，把它算作登录奖励会让新用户一开始就显示「已领取」。
 * ⚠️ **服务端没有单独的奖励状态端点**（实测），故只能查账单明细。
 * ⚠️ 查询失败时保守返回 `claimed: false` —— 宁可让用户多点一次
 * （服务端幂等，无害），也不要误报「已领」而让他真的错过。
 */
export async function fetchRaccoonOnboardingStatus(
  product: RaccoonProduct,
  credential: RaccoonCredential,
  fetcher: typeof fetch = fetch,
): Promise<{ claimed: boolean; points: number }> {
  const envelope = await requestJson(
    `${product.apiBase}${RACCOON_POINTS_PREFIX}/bills?paging.limit=50&paging.offset=0`,
    credential,
    product,
    { method: 'GET' },
    fetcher,
  )
  if (!envelope.ok || envelope.data === undefined) {
    return { claimed: false, points: RACCOON_LOGIN_REWARD_POINTS }
  }

  const items = Array.isArray(envelope.data.items) ? envelope.data.items : []
  let claimed = false
  let points = RACCOON_LOGIN_REWARD_POINTS
  for (const raw of items) {
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) continue
    const item = raw as Record<string, unknown>
    if (item.biz_type !== 'reward_grant') continue
    if (item.event_name !== RACCOON_LOGIN_REWARD_EVENT_NAME) continue
    claimed = true
    const billPoints = readNumber(item.points)
    if (billPoints !== undefined && billPoints > 0) points = billPoints
    break
  }
  return { claimed, points }
}

/** 默认产品配置下的便捷包装（供 `RaccoonAuth` 调用）。 */
export const raccoonCreditsForDefaultProduct = {
  fetchBalance: (credential: RaccoonCredential, fetcher?: typeof fetch) =>
    fetchRaccoonCreditBalance(RACCOON, credential, fetcher),
  claimLoginReward: (credential: RaccoonCredential, fetcher?: typeof fetch) =>
    claimRaccoonLoginReward(RACCOON, credential, fetcher),
  fetchOnboardingStatus: (credential: RaccoonCredential, fetcher?: typeof fetch) =>
    fetchRaccoonOnboardingStatus(RACCOON, credential, fetcher),
  keepAliveDailyPoints: (credential: RaccoonCredential, fetcher?: typeof fetch) =>
    keepAliveRaccoonDailyPoints(RACCOON, credential, fetcher),
}

// ───────────────────────── 每日积分保活 ─────────────────────────

/**
 * 「每日积分保活」：把当天到账的 300 积分有效期从「当天 24:00」延长到 7 天。
 *
 * ## 为什么需要它（用户报障的真实形态）
 *
 * 每日 300 积分由服务端**自动发放**（见本文件顶部表格），但**不登录就当天作废**。
 * 官方客户端文案把规则写得很清楚（`dailyGrantRule`）：
 *
 * > 每日积分每天 00:00 发放，默认当日 24:00 清零，当天登录后有效期延长至 7 天。
 *
 * 于是「半夜电脑没开机」的用户，第二天醒来看到的每日积分已经清零 —— 白给。
 *
 * ## ✅ 已确证的触发端点：`GET /api/web/office/v3/setting_info`（2026-10-11）
 *
 * 由一次干净的跨日对照实验定论（脚本 `scripts/probe-raccoon-daily-extension.mjs`，
 * 结果存档 `data/logs/raccoon-daily-extension-probe.json` 第 3 条）。三个账号
 * 在同一自然日、同一分钟窗口内，各只执行一个动作：
 *
 * | 账号 | 动作 | 结果 |
 * |---|---|---|
 * | `…21026F85` | 只调 `GET /points/v1/balance` | ❌ 未触发（当日始终无记录） |
 * | `…2E83590D` | 只调 `GET /office/v3/setting_info` | ✅ **触发**（记录从无到有，`created_at` 为真实时刻） |
 * | `…9BB58E99` | 对照组，不发任何请求 | ❌ 未触发（当日始终无记录） |
 *
 * 2 分钟后复查，另外两组仍无记录 —— 排除了「只是时间差」的解释。
 *
 * 两条**已被实验否定**的假设（勿再回头尝试）：
 * - ❌ **读账单不触发**：对照组只读 `/bills`（阶段 1 快照 + 阶段 1b 双读），
 *   状态始终不变。2026-10-10 更有一轮反证：带鉴权反复读 `/bills` 共 14 分钟，
 *   当日记录始终不存在。
 * - ❌ **续期不算登录**：`POST /auth/v1/refresh` 不带 `Authorization` 头
 *   （见 `raccoon-oauth.ts` 的 `postJson`）。实证 2026-10-05 ~ 10-07 三天
 *   all_proxy 每小时都在续期，积分照样当天清零。
 *
 * 另一条实测事实：**当天的 `daily_grant` 记录并非 00:00 就存在**，而是在
 * 「当天首次登录态动作」时才由服务端创建（`created_at` 即那一刻）。故
 * 「今天尚无记录」是**干净初始态**，不是「服务端还没发放」。
 *
 * ## 为什么仍保留候选链（而非只调 setting_info）
 *
 * 判定依据是**账单前后对比**（`daily_grant.created_at` 由整点/无记录变为
 * 真实时刻），而不是「我调了某个端点」。这个自验证设计的好处是：
 * 服务端将来若改判定口径，函数会**如实返回 `not-extended`**，而不是谎报成功。
 * 候选表把已确证的 `setting_info` 排在首位，正常路径第一次尝试即命中，
 * `balance` 仅作为「万一口径变化」的兜底。
 *
 * ## 只读性
 *
 * 除候选端点本身外不写任何数据；候选均为 GET（见候选表说明）。
 *
 * @returns 四种结果：已延长 / 本次延长成功（带命中的端点）/ 端点调用成功但
 *   未触发 / **端点因服务级错误全部失败**。**不抛错** —— 失败也返回结果对象，
 *   保证批量调用不因单账号中断。
 */
export async function keepAliveRaccoonDailyPoints(
  product: RaccoonProduct,
  credential: RaccoonCredential,
  fetcher: typeof fetch = fetch,
  options: { now?: number } = {},
): Promise<RaccoonKeepaliveOutcome> {
  const now = options.now ?? Date.now()

  const before = await readTodayRaccoonDailyGrant(product, credential, fetcher, now)
  if (before !== undefined && !isUtc8MidnightGrant(before.createdAt)) {
    // 当天已经延长过（**可能来自用户自己打开官方客户端**，或本函数之前跑过）
    // —— 延长每天只发生一次且幂等，无需再发任何请求。
    //
    // ⚠️ 这里**必须如实说明「本函数没做任何事」**：该记录若来自用户登录客户端，
    // 把它显示成「保活成功」是假阳性（用户会以为本功能生效了）。前端据 `note`
    // 区分展示。
    return {
      kind: 'already-extended',
      createdAt: before.createdAt,
      expireAt: before.expireAt,
      points: before.points,
      note: '今天已有非整点的每日积分发放记录（可能来自你打开官方客户端，或此前已保活过）；本次未发任何请求',
    }
  }

  const tried: string[] = []
  const attempts: RaccoonKeepaliveAttempt[] = []
  for (const candidate of RACCOON_DAILY_KEEPALIVE_CANDIDATES) {
    tried.push(candidate.id)
    const attempt = await callKeepaliveCandidate(candidate.id, candidate.label, product, credential, fetcher)
    attempts.push(attempt)
    // 端点调用失败（服务级错误）：换下一个候选继续试。
    if (!attempt.ok) continue
    const after = await readTodayRaccoonDailyGrant(product, credential, fetcher, now)
    if (after !== undefined && !isUtc8MidnightGrant(after.createdAt)) {
      return {
        kind: 'extended',
        trigger: candidate.id,
        triggerLabel: candidate.label,
        expireAt: after.expireAt,
        points: after.points,
      }
    }
  }

  // 区分两种「没延长」：
  // - **unavailable**：所有候选端点都**因服务级错误失败**（如上游整体 503 /
  //   code=200903）⇒ 延长**从未有机会发生**，属上游暂时不可用，用户应稍后重试。
  // - **not-extended**：至少有一个候选端点**调用成功**但账单没变 ⇒ 触发条件
  //   不止于这些端点（真正的触发源可能是客户端特有的握手/设备绑定）。
  //
  // ⚠️ 混为一谈会把「服务端故障」说成「功能结论」—— 用户报障的
  // `code=200903 service_unavailable` 正是这种情形。
  const allFailed = attempts.length > 0 && attempts.every((a) => !a.ok)
  if (allFailed) {
    const last = attempts[attempts.length - 1]!
    const lastError = `code=${last.code} ${last.message}`.trim()
    return {
      kind: 'unavailable',
      tried,
      attempts,
      lastError,
      message: `上游服务暂时不可用（${lastError}）—— 延长从未有机会发生，请稍后重试；`
        + '这不是「端点无效」的证据，也不代表今天一定保不住',
    }
  }

  return {
    kind: 'not-extended',
    tried,
    attempts,
    message: '候选端点均调用成功但未触发延长；该账号可能已被服务端判定为「今天已登录」，'
      + '或触发条件不止于这些端点（例如客户端特有的握手/设备绑定）',
  }
}

/**
 * 一次保活的候选端点（顺序即尝试顺序）。
 *
 * `setting_info` 排第一是**已确证的结论**（2026-10-11 跨日对照实验）：只调它的
 * 账号触发了延长，只调 `balance` 的账号与不发请求的对照组都没有。正常路径
 * 第一次尝试即命中。
 *
 * `balance` 保留为兜底：本函数的判定依据是**账单前后对比**而非「我调了谁」，
 * 故万一服务端将来改变判定口径、`setting_info` 不再触发，这里会自动继续尝试
 * 下一个候选并如实回报结果 —— 而不是静默失效。
 *
 * 官方客户端在启动与「发送消息后刷新配额」等多处都会调 `setting_info`
 * （见 app.asar 模块 42192 / 128331311），是登录态下的**高频活跃路径**，
 * 这与其成为「当日登录」判据的观察一致。
 *
 * ⚠️ 全部是 **GET 只读**端点：保活绝不能用写端点（Loomy 的 `first-login`
 * 就踩过「打开面板即意外触发签到」的坑，见本文件顶部「只读优先」）。
 */
export const RACCOON_DAILY_KEEPALIVE_CANDIDATES: readonly RaccoonKeepaliveCandidate[] = [
  { id: 'setting_info', label: '读取用户设置（setting_info）' },
  { id: 'balance', label: '查询积分余额（balance）' },
]

/**
 * 发一个候选端点的 GET 请求，返回**结构化的探测结果**（不抛错）。
 *
 * ⚠️ 返回原始业务码而不是抛错：调用方需要区分「端点调用成功但没触发延长」
 * 与「端点因服务级错误失败」—— 前者是功能结论，后者是上游不可用。
 */
async function callKeepaliveCandidate(
  id: string,
  label: string,
  product: RaccoonProduct,
  credential: RaccoonCredential,
  fetcher: typeof fetch,
): Promise<RaccoonKeepaliveAttempt> {
  const path = id === 'setting_info'
    ? `${product.officeApiPrefix}/setting_info`
    : `${product.pointsApiPrefix}/balance`
  const envelope = await requestJson(`${product.apiBase}${path}`, credential, product, { method: 'GET' }, fetcher)
  return {
    id,
    label,
    ok: envelope.ok,
    code: envelope.code,
    message: envelope.message,
  }
}

/**
 * 读取**今天（UTC+8）**的 `daily_grant` 记录。
 *
 * 判据是 `grant_at` 以 UTC+8 当日日期开头 —— **不能**用 `created_at`：
 * 后者是「延长发生时刻」，发放日的判定要用 `grant_at`。
 *
 * @returns 查不到（无记录 / 请求失败 / 响应形状不对）时返回 `undefined`，
 *   **不编造**。
 */
export async function readTodayRaccoonDailyGrant(
  product: RaccoonProduct,
  credential: RaccoonCredential,
  fetcher: typeof fetch = fetch,
  nowMs: number = Date.now(),
): Promise<RaccoonDailyGrantRecord | undefined> {
  const envelope = await requestJson(
    `${product.apiBase}${product.pointsApiPrefix}/bills?paging.limit=30&paging.offset=0`,
    credential,
    product,
    { method: 'GET' },
    fetcher,
  )
  if (!envelope.ok || envelope.data === undefined) return undefined

  const items = Array.isArray(envelope.data.items) ? envelope.data.items : []
  const today = utc8DateString(nowMs)
  for (const raw of items) {
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) continue
    const item = raw as Record<string, unknown>
    if (item.biz_type !== 'daily_grant') continue
    const grantAt = typeof item.grant_at === 'string' ? item.grant_at : ''
    if (!grantAt.startsWith(today)) continue
    return {
      grantAt,
      createdAt: typeof item.created_at === 'string' ? item.created_at : undefined,
      expireAt: typeof item.expire_at === 'string' ? item.expire_at : undefined,
      points: readNumber(item.points),
    }
  }
  return undefined
}

/**
 * 该发放记录是否**未被延长**（即 `created_at` 落在整点 00:00:00）。
 *
 * ⚠️ 判据是「`created_at` 含 `T00:00:00`」而不是「等于当天零点」：
 * 服务端实测下发的是 `2026-10-09T00:00:00+08:00` 这种**带时区**的字面量，
 * 用 `Date` 解析再比较会引入本机时区依赖（与 `nextUtc8DayStartMs` 的
 * 注释同一条理由：写死字面量比换算可预测）。
 */
function isUtc8MidnightGrant(createdAt: string | undefined): boolean {
  return typeof createdAt === 'string' && createdAt.includes('T00:00:00')
}

/** UTC+8 的当日日期（`YYYY-MM-DD`）。写死偏移量，不取本机时区。 */
function utc8DateString(nowMs: number): string {
  return new Date(nowMs + 8 * 3_600_000).toISOString().slice(0, 10)
}
