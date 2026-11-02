/**
 * Magicrew（超级麦吉 / MagiCrew）的**新人奖励（新手引导任务）**协议实现。
 *
 * ⚠️ **本文件只做 onboarding 域**。每日签到在 `magicrew-credits.ts` 里
 * （`claimMagicrewDailyCheckin` / `maybeClaimMagicrewDaily`）—— 那里已经有一套
 * 本项目自己的实现，且比来源多一个 `ineligible`（「当前账号暂不符合活动参与
 * 条件」）独立状态。**不要**把来源的 `claimMagicrewLoginGift` 也搬进来：
 * 一份语义两套实现必然漂移（来源自己就记录过 `magicrewPointsOf` 双份实现
 * 导致 `"0x10"` 在两处解释不同的实例）。
 *
 * ## 两套机制，别混（`credits` 域 vs `onboarding` 域）
 *
 * | 机制 | 端点 | 频率 | 归属域 |
 * |---|---|---|---|
 * | 每日登录积分（= 真正的「每日签到」） | `POST /api/v1/login-gift` | 每天一次 | `credits.claim` |
 * | 新手引导任务（=「新人奖励」） | `GET /api/v1/onboarding/tasks` + `PUT …/<code>/completion` | **每号一辈子一次** | `onboarding` |
 *
 * ⚠️ 别拿「今天领过没」的判据去判「领过没」—— 那是「一份语义两套判据」的典型形态。
 *
 * ## 新手引导任务（实测报文）
 *
 * ```json
 * GET /api/v1/onboarding/tasks
 * → {"code":1000,"data":{"participant_type":null,"tasks":[
 *      {"code":"…","title":"…","points":50,"status":"COMPLETED",
 *       "reward_status":"GRANTED","completed_at":"…"}]}}
 *
 * PUT /api/v1/onboarding/tasks/<code>/completion      （body `{}`）
 * → {"code":1000,"data":{"points":50}}
 * ```
 *
 * 国内站 8 项，其中 7 项 PUT 即完成（总分以 `tasks[].points` 现场累加，不写死）。
 *
 * ### ⚠️⚠️ 两条会让人报假账的坑
 *
 * 1. **`first_ai_work` 不支持手动完成** —— 服务端回 **`9303`**「该新人引导任务
 *    不支持手动完成」。它必须真发一条消息才置位（走话题 Socket.IO）。
 *    ⇒ 本实现**不发请求、直接归 `manualRequired`**（**不是** `skipped` ——
 *    那个字段的契约是「此前已完成」，而它既没完成也没领到分）。
 * 2. **国际站 `tasks` 恒为空数组** —— `{participant_type: null, tasks: []}` 是
 *    「该账号没被登记进引导计划」，**不是**「已经领完了」。
 *    ⇒ 0 项时如实报「无任务可领」，**不得**报「新手福利 0 项已全部完成」。
 *
 * ## ⚠️ 本文件不引 `node:*`
 *
 * 与 `magicrew-product.ts` 同因：它可能被客户端产物（esbuild）间接引用。
 */

import {
  MAGICREW,
  MAGICREW_ONBOARDING_TASKS_PATH,
  type MagicrewProduct,
} from './magicrew-product.js'
import { magicrewApiHeaders } from './magicrew-credits.js'
import { DECIMAL_LITERAL_RE, magicrewDecimalOf } from './magicrew-number.js'

/** 已知**不支持手动完成**的任务 code —— 别再白试（服务端回 9303）。 */
export const MAGICREW_NOT_MANUALLY_COMPLETABLE: readonly string[] = Object.freeze(['first_ai_work'])

/** `9303` = 该新人引导任务不支持手动完成（服务端业务码）。 */
const MAGICREW_CODE_TASK_NOT_SUPPORTED = 9303

/**
 * 相邻两次 `PUT …/completion` 之间的间隔（毫秒）。
 *
 * 参考实现（magpie `tasks.mjs:162`）逐项之间 `setTimeout(400)`，注释写明
 * 「服务端限流留点余地」。连发 7 个 PUT 撞上风控会让后面几项失败，
 * 而症状是「每次都只领到前面几项」—— 且下次重试时前面几项已领过，
 * 用户看起来像永久卡住。
 */
const MAGICREW_PUT_GAP_MS = 400

/** 请求参数（三处共用）。 */
export interface MagicrewCheckinParams {
  readonly jwt: string
  readonly organizationCode: string
  readonly product?: MagicrewProduct
  readonly fetchImpl?: typeof fetch
  /**
   * 两次 PUT 之间的间隔（毫秒）。缺省 {@link MAGICREW_PUT_GAP_MS}。
   *
   * ⚠️ 单测传 `0` 免等待 —— 否则一条用例要真等 2.4 秒（7 项 × 400ms）。
   */
  readonly throttleMs?: number
}

/** 一条新手任务（上游原样的子集）。 */
export interface MagicrewOnboardingTask {
  readonly code: string
  readonly title: string
  readonly points: number
  readonly status: string
  readonly rewardStatus: string
  readonly completedAt?: string
}

/**
 * 新手任务的**状态**（只读查询的结果）。
 *
 * 与来源 `RpcOnboardingStatusResponse` 同形：本项目不引那个类型（它在来源是
 * RPC 契约层），故在本地定义一份、字段逐字一致。
 */
export interface MagicrewOnboardingStatus {
  /** code → 是否已完成（拿到分）。 */
  tasks: Record<string, boolean>
  /** **累计**已领积分（`status === 'COMPLETED'` 或 `reward_status === 'GRANTED'` 的合计）。 */
  earned: number
  /** 任务积分合计（**现场累加**，不写死）。 */
  total: number
  /** code → 中文标题（供前端渲染清单）。 */
  titles: Record<string, string>
  /** code → 积分。 */
  points: Record<string, number>
}

/**
 * 一次「领取全部新手任务」的结果。
 *
 * ⚠️ 四个数组**语义各不相同，不得混用**（这正是来源补 `errors` 与
 * `manualRequired` 的原因）：
 * - `skipped` = 「**此前已完成**」
 * - `claimed` = 本次真的领到（含幂等重放）
 * - `errors` = 本次做了但失败（用户需要知道并可能重试）
 * - `manualRequired` = 服务端拒自动完成，必须用户自己发一条消息
 */
export interface MagicrewOnboardingClaim {
  claimed: Array<{ key: string; title: string; points: number }>
  skipped: string[]
  earned: number
  total: number
  /** 本次尝试了但失败的任务（`"<key>: <原因>"`）。 */
  errors?: string[]
  /** 需要用户手动操作才能完成的任务 key（服务端 9303）。 */
  manualRequired?: string[]
}

/** 读信封：成功返回 `data`，失败返回 `{ error }`（**不抛**）。 */
interface MagicrewEnvelope {
  readonly data?: Record<string, unknown>
  readonly code?: unknown
  readonly message?: string
}

/**
 * 发一次业务 API 请求并解析信封。
 *
 * ⚠️ **永不抛** —— 网络异常/非 JSON 一律折成 `{ error }`：
 * 这两条路径的上层（`credits.claim` / `onboarding.status`）契约是
 * 「回一个带原因的结果」，抛出去会让整轮 RPC 变成 `ok:false` 的笼统错误，
 * 用户看不到是哪一步失败（与 `raccoon-credits.ts` 的 `requestJson` 同纪律）。
 */
async function magicrewRequest(
  params: MagicrewCheckinParams,
  path: string,
  init: { method: string, body?: string },
): Promise<{ envelope?: MagicrewEnvelope, error?: string }> {
  const product = params.product ?? MAGICREW
  /**
   * ⚠️ **国际站缺 org 要在本地就拦下**。
   *
   * | 端点 | 缺 `organization-code` 时的真实响应 |
   * |---|---|
   * | **业务 API** `/api/v1/*`（本函数打的这些） | `{"code":2182,"message":"用户所在组织不存在"}`（**2026-11-01 真实凭据实测确认**） |
   * | **聊天网关** `/v1/*`（`magicrew-adapter.ts` 那条腿） | ⚠️ **形态未定** |
   *
   * ⚠️⚠️ **不要在用户文案里写死「网关会回 500」** —— 那一条在「完整 apiKey +
   * 缺 org」的形态下**复现不出来**。业务 API 的 `code 2182` 是**实测**的，可以写。
   *
   * ⚠️ 只对 `needsOrgOnGateway` 的站生效：国内站不强制（缺了仍 200），
   *    在这里拦会让本来能用的国内账号也失败（回归）。
   */
  if (product.needsOrgOnGateway && params.organizationCode.length === 0) {
    return {
      error: `${product.displayName}缺少组织码（organizationCode）—— 请在网页端选中一个组织后重新登录；`
        + '该站的业务 API 会回「用户所在组织不存在」',
    }
  }
  const fetchImpl = params.fetchImpl ?? fetch
  let response: Response
  try {
    response = await fetchImpl(`${product.host}${path}`, {
      method: init.method,
      // ⚠️ 超时必带：零超时会让签到按钮转圈到 undici 默认 ~300s
      //    （本文件是「用户点一下就等」的主路径，与积分面板同因）。
      signal: AbortSignal.timeout(product.requestTimeoutMs),
      headers: magicrewApiHeaders({
        jwt: params.jwt,
        organizationCode: params.organizationCode,
        product,
      }),
      ...init.body === undefined ? {} : { body: init.body },
    })
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) }
  }
  const text = await response.text().catch(() => '')
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    /**
     * ⚠️ 非 JSON 响应必须把 **HTTP 状态码**浮出来：网关故障时回的常是
     * HTML 错误页或裸文本，只报「解析失败」会让用户以为插件坏了。
     */
    const snippet = text.trim().slice(0, 120)
    return {
      error: snippet.length > 0
        ? `HTTP ${response.status}（响应不是 JSON：${snippet}）`
        : `HTTP ${response.status}（空响应）`,
    }
  }
  if (typeof parsed !== 'object' || parsed === null) {
    return { error: `HTTP ${response.status}（响应不是对象）` }
  }
  const envelope = parsed as MagicrewEnvelope
  /**
   * ## 判失败要**三条腿**，缺一条都会静默出错
   *
   * ① **数字业务码**：上游成功码是 **1000**，而错误也可能是 HTTP 200 + `code: 403`
   *   （「token无效」这类藏在 body 里的错误）⇒ 只看 `response.ok` 会把这类错误判成功。
   * ③ **字符串业务码**：`{"code":"403","message":"…"}` 也是真实形态
   *   ⇒ 既不过 ① 也不过 ②（HTTP 是 200）⇒ 一路判成功 ⇒
   *   签到因 `granted !== true` 落进 `already-claimed`「今日已领取登录积分」
   *   ⇒ **静默漏领 200/50 分且零报错**（用户以为今天领过了）。
   * ② **HTTP 状态码**：上游回 4xx/5xx 且 body 是**没有可用 `code` 的 JSON** 时，
   *   ①③ 完全无牙 ⇒ 会把**网关故障判成成功**。
   *
   * ⚠️ 顺序不可颠倒：② **必须放在 ① 之后**。理由：`claimMagicrewOnboardingTasks`
   *    要靠 `envelope.code === 9303` 区分「该项不支持手动完成」—— 若 ② 在前，
   *    9303 若以非 2xx 下发就会被 ② 先截胡，`first_ai_work` 从此被误判成硬失败。
   *
   * ⚠️ 用 `DECIMAL_LITERAL_RE` 而不是裸 `Number()`：`Number('0x3E8') === 1000`
   *    —— 十六进制的 `"0x3E8"` 会被当成**成功码**放行。上游不会这么给，但
   *    「拒绝畸形」比「猜对」更安全（与 `magicrewDecimalOf` 同纪律）。
   */
  if (typeof envelope.code === 'number' && envelope.code !== 1000) {
    const message = typeof envelope.message === 'string' && envelope.message.length > 0
      ? envelope.message
      : `业务码 ${envelope.code}`
    return { envelope, error: message }
  }
  if (typeof envelope.code === 'string') {
    const rawCode = envelope.code.trim()
    if (rawCode !== '' && DECIMAL_LITERAL_RE.test(rawCode)) {
      const numericCode = Number(rawCode)
      if (Number.isFinite(numericCode) && numericCode !== 1000) {
        const message = typeof envelope.message === 'string' && envelope.message.length > 0
          ? envelope.message
          : `业务码 ${envelope.code}`
        return { envelope, error: message }
      }
    }
  }
  if (!response.ok) {
    // ⚠️ 保留 `envelope` 只是**顺手**（成本为零）：走到这条腿时 body 里本来就没有
    //    可用的 `code`，故这里取不到 9303 —— 9303 走的是上面两条码值腿。
    const message = typeof envelope.message === 'string' && envelope.message.length > 0
      ? envelope.message
      : `HTTP ${response.status}`
    return { envelope, error: message }
  }
  return { envelope }
}

/**
 * 把上游的 `points` 读成数字；**读不到返回 0**（宁可少算也不编造）。
 *
 * ⚠️ 判据与积分侧共用 `magicrew-number.ts` 的 `magicrewDecimalOf`：
 * 两处各写一份同义实现会漂移 —— 来源实测修前 `"0x10"` 在签到侧得 0、
 * 在积分侧得 **16**，`"1e3"` 在签到侧 0、在积分侧 **1000**。
 */
function magicrewPointsOf(raw: unknown): number {
  return magicrewDecimalOf(raw) ?? 0
}

/**
 * 把信封里的业务码统一读成数字（**数字与十进制字符串两种形态都认**）。
 *
 * 与 `magicrewRequest` 的三腿同口径：只认数字会让 `{"code":"9303"}` 这种
 * 字符串形态漏判，从而把「该任务不支持手动完成」错归到 `errors` 而不是
 * `manualRequired`。读不到返回 `undefined`（**不猜**）。
 */
function codeOf(envelope: MagicrewEnvelope | undefined): number | undefined {
  const raw = envelope?.code
  if (typeof raw === 'number') return Number.isFinite(raw) ? raw : undefined
  if (typeof raw !== 'string') return undefined
  const trimmed = raw.trim()
  if (trimmed === '' || !DECIMAL_LITERAL_RE.test(trimmed)) return undefined
  const parsed = Number(trimmed)
  return Number.isFinite(parsed) ? parsed : undefined
}

/** 把上游 `tasks` 数组安全地取出来（任何一层不合形状都折成空数组）。 */
function magicrewTasksOf(data: Record<string, unknown> | undefined): MagicrewOnboardingTask[] {
  const raw = data?.tasks
  if (!Array.isArray(raw)) return []
  const out: MagicrewOnboardingTask[] = []
  for (const item of raw) {
    if (typeof item !== 'object' || item === null) continue
    const entry = item as Record<string, unknown>
    if (typeof entry.code !== 'string' || entry.code.length === 0) continue
    out.push({
      code: entry.code,
      title: typeof entry.title === 'string' && entry.title.length > 0 ? entry.title : entry.code,
      /**
       * ⚠️ `points` **不要只用 `typeof === 'number'`**：上游这套 Go 服务在别的
       * 积分接口里确实会下发**字符串**（`"80"`）。只认 number 会把
       * `points:"80"` 记成 **0** ⇒ UI 显示「本次领取 0 积分」，而用户实际拿到了 80。
       *
       * ⚠️⚠️ **刻意比参考实现保守**：参考实现 `parsePointsValue` 会去千分位、
       * 统一 Unicode 负号、读会计括号负数、剥 `¥$￥` ⇒ `"1,234 积分"` 得 1234。
       * 本仓只接受**纯十进制字面量**：`"1,234 积分"` ⇒ **0**。
       * 理由：正常的积分字段是 number，出现带千分位/单位的字符串本身就说明
       * **响应形态已经变了**；把它「猜」成一个数字会让一次上游改版变成
       * 「数字看起来对、其实错」的静默错误。宁可少算。
       */
      points: magicrewPointsOf(entry.points),
      status: typeof entry.status === 'string' ? entry.status : '',
      rewardStatus: typeof entry.reward_status === 'string' ? entry.reward_status : '',
      ...typeof entry.completed_at === 'string' && entry.completed_at.length > 0
        ? { completedAt: entry.completed_at } : {},
    })
  }
  return out
}

/**
 * 一条任务是否**已经拿过分**。
 *
 * ⚠️ 判据是 `status === 'COMPLETED'` **或** `reward_status === 'GRANTED'`：
 * 两者在上游是**独立**字段（实测存在 `COMPLETED` 但 `reward_status` 为空的样本），
 * 只判一个会重复 PUT 已领过的任务。
 */
export function magicrewTaskIsDone(task: MagicrewOnboardingTask): boolean {
  return task.status === 'COMPLETED' || task.rewardStatus === 'GRANTED'
}

/**
 * **新人奖励状态**（只读）—— `GET /api/v1/onboarding/tasks`。
 *
 * ⚠️ **只读：不得**在此触发任何 `completion`（面板挂载时会调用它）。
 * ⚠️ 0 项时如实回 `total: 0`，调用侧据此显示「无任务可领」而不是「已全部完成」。
 */
export async function fetchMagicrewOnboardingStatus(
  params: MagicrewCheckinParams,
): Promise<MagicrewOnboardingStatus> {
  const { envelope, error } = await magicrewRequest(params, MAGICREW_ONBOARDING_TASKS_PATH, {
    method: 'GET',
  })
  if (error !== undefined) throw new Error(error)
  const tasks = magicrewTasksOf(envelope?.data)
  const state: Record<string, boolean> = {}
  const titles: Record<string, string> = {}
  const points: Record<string, number> = {}
  let earned = 0
  let total = 0
  for (const task of tasks) {
    const done = magicrewTaskIsDone(task)
    state[task.code] = done
    titles[task.code] = task.title
    points[task.code] = task.points
    total += task.points
    // `earned` 回答的是「**累计**已领多少」，与「本次是否新增」无关。
    if (done) earned += task.points
  }
  return { tasks: state, earned, total, titles, points }
}

/**
 * **领取新人奖励** —— 对每个未完成任务 `PUT …/<code>/completion`。
 *
 * ⚠️ `first_ai_work` **不发 PUT**：服务端固定回 `9303`，白试一轮还会让用户看到
 * 一条假的失败。它归入 `manualRequired`（**不是** `skipped`）—— 后者在前端被
 * 渲染成「N 个此前已完成」，而这一项**既没完成也没领到分**，混进去就是把
 * "没做"写成"做过"。
 *
 * ⚠️ **单项失败不中断整轮**：其余项照领，失败项收进 `errors`。
 * 中断会让「8 项里有 1 项抖动」变成「一项都没领到」，而下一轮重试时前面几项
 * 已经领过，用户看起来像卡住了。
 * - **零成功 + 有失败** ⇒ **上抛**（否则上层会包成「成功但没领到」）
 * - **有成功 + 有失败** ⇒ 返回并带上 `errors`（上抛会让用户以为整轮失败，
 *   而实际已经领到了大部分分）
 *
 * ## ⚠️ 能力上限（**如实说明，不要以为只差一项**）
 *
 * 国内站 8 项里 7 项 PUT 即完成，第 8 项 `first_ai_work` 必须**真发一条消息**
 * （走话题 Socket.IO）才会置位；国际站的首对话任务同理。而它**同时是邀请奖励
 * 的触发条件**（被邀请人完成首个任务/对话后，邀请人才 +200 分）。
 *
 * 本实现**不做**发消息那条腿（协议是另一套 Socket.IO 通道），故：该项分 +
 * 国际站首对话 + 邀请奖励**都拿不到**。这是**已知取舍**，已通过
 * `manualRequired` 如实告知用户，不是"已全部领完"。
 *
 * ⚠️ 相邻两次 PUT 之间留 **400ms**：连发 7 个 PUT 撞上风控会让后面几项失败，
 * 而症状是「每次都只领到前面几项」。
 */
export async function claimMagicrewOnboardingTasks(
  params: MagicrewCheckinParams,
): Promise<MagicrewOnboardingClaim> {
  const status = await fetchMagicrewOnboardingStatus(params)
  const claimed: Array<{ key: string, title: string, points: number }> = []
  const skipped: string[] = []
  const errors: string[] = []
  const manualRequired: string[] = []
  /** PUT 之间的限流间隔（参考实现同值）。0 表示不等待（单测用）。 */
  const gapMs = params.throttleMs ?? MAGICREW_PUT_GAP_MS
  let putCount = 0
  for (const code of Object.keys(status.tasks)) {
    if (status.tasks[code] === true) {
      // 真正「此前已完成」的才进 skipped。
      skipped.push(code)
      continue
    }
    if (MAGICREW_NOT_MANUALLY_COMPLETABLE.includes(code)) {
      // 不白试：服务端固定回 9303。⚠️ 归 manualRequired，**不是** skipped。
      manualRequired.push(code)
      continue
    }
    if (putCount > 0 && gapMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, gapMs))
    }
    putCount += 1
    const path = `${MAGICREW_ONBOARDING_TASKS_PATH}/${encodeURIComponent(code)}/completion`
    const { envelope, error } = await magicrewRequest(params, path, { method: 'PUT', body: '{}' })
    if (error !== undefined) {
      /**
       * 9303 即便漏进这里（例如名单漏登记了新 code）也不应该让整轮失败
       * ⇒ 归 `manualRequired`，与上面那条同语义。
       *
       * ⚠️ 判据必须**两条腿**（数字 + 十进制字符串），与 `magicrewRequest` 的
       *    三条腿同口径：只认数字时，上游若下发 `{"code":"9303"}`，字符串腿会
       *    先把它判成失败 ⇒ 落 `errors` 而不是 `manualRequired`。
       */
      const code9303 = codeOf(envelope) === MAGICREW_CODE_TASK_NOT_SUPPORTED
      if (code9303) manualRequired.push(code)
      else errors.push(`${code}: ${error}`)
      continue
    }
    /**
     * ⚠️ `data.points` 缺失**或为 0** 时回退任务表：上游成功响应里
     * `data.points` 偶有 0，直接用 0 会让 `earned` 少算。
     *
     * ⚠️ 用 `magicrewPointsOf` 而**不是**裸 `typeof === 'number'`：上游同一套
     * 服务在别处会下发**字符串**形态的积分数，只认 number 会把 `points:"80"`
     * 当成「读不到」而回退到任务表 —— 那两份数字不一定相等。
     */
    const putPoints = magicrewPointsOf(envelope?.data?.points)
    const points = putPoints > 0 ? putPoints : status.points[code] ?? 0
    claimed.push({ key: code, title: status.titles[code] ?? code, points })
  }
  if (claimed.length === 0 && errors.length > 0) {
    // 一项都没领到且有失败 ⇒ 必须上抛（否则上层会包成「成功但没领到」）。
    throw new Error(`新人奖励领取失败：${errors.join('；')}`)
  }
  /**
   * ⚠️ `earned` 用「领之前的累计 + 本次新增」而不是重新 GET 一次：
   * 重新 GET 会在服务端有延迟写时少算，让 UI 出现「刚领完却显示 0」。
   */
  const claimedPoints = claimed.reduce((sum, item) => sum + item.points, 0)
  const earnedAfter = status.earned + claimedPoints
  return {
    claimed,
    skipped,
    earned: earnedAfter,
    /**
     * ⚠️ `total` 用 `max(读到的合计, earned)` 只为**不让进度条超过 100%**；
     * 它不是在修根因 —— 若上游某天只下发未完成项，`status.total` 会凭空缩小。
     * 保住下界即可，不要在这里编造「总分常量」（上游没给）。
     */
    total: Math.max(status.total, earnedAfter),
    ...errors.length > 0 ? { errors } : {},
    ...manualRequired.length > 0 ? { manualRequired } : {},
  }
}
