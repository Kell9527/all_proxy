#!/usr/bin/env node
/**
 * 跨日实验：判定**哪个 API 请求**会触发 raccoon（商汤小浣熊）的
 * 「当日登录 → 每日积分有效期延长至 7 天」。
 *
 * ## 为什么需要这个实验
 *
 * 实测（2026-10-09）确认的既有事实：
 *
 * 1. 每日 300 积分由服务端**自动发放**（账单 `biz_type: 'daily_grant'`），
 *    没有签到端点 —— 故本项目登记 `onboardingTasks` 而非 `dailyCheckin` 是对的。
 * 2. 但「发放」与「保住」是两回事：不登录时 `expire_at` 就是**当天 23:59:59**，
 *    积分到手即废；只有「当日登录」才把有效期改成 **7 天**。
 * 3. 账单里 `daily_grant.created_at` 就是「延长发生时刻」：
 *    - 等于 `00:00:00`（整点）→ 纯服务端发放，**未延长**；
 *    - 是真实时刻（如 `09:40:56`）→ 该时刻有客户端动作，**已延长**。
 * 4. 本服务每小时的续期**不算登录**：`POST /auth/v1/refresh` 不带
 *    `Authorization` 头（见 `src/providers/raccoon-oauth.ts` 的 `postJson`）。
 *    实证：10-05 ~ 10-07 三天 all_proxy 每小时都在续期，积分照样当天清零。
 *
 * ## 实验设计（三个账号，三种策略，同日对照）
 *
 * | 账号 ref | 策略 | 动作 |
 * |---|---|---|
 * | `RACCOON_ACCOUNT_21026F85` | `balance` | 只调 `GET /api/web/points/v1/balance` |
 * | `RACCOON_ACCOUNT_2E83590D` | `setting` | 只调 `GET /api/web/office/v3/setting_info` |
 * | `RACCOON_ACCOUNT_9BB58E99` | `control` | **什么都不调**（对照组） |
 *
 * ## ⚠️ 必须先排除的混淆因素：读账单本身会不会触发延长？
 *
 * 每个账号的「实验前快照」都要调一次 `GET /bills`。若**这个读动作本身**
 * 就触发延长，那么后续看到的 `created_at` 变化会被错误归因给
 * `balance` / `setting_info`。
 *
 * 故在阶段 1b 对**对照组**连读两次账单：两次之间 `created_at` 若发生变化，
 * 说明触发源就是「读账单」，实验到此即可定论、无需再跑策略。
 *
 * ## 判定
 *
 * 实验前每个账号当天的 `daily_grant.created_at` 必须仍是 `00:00:00`
 * （即当天尚未延长）—— 否则实验无效，脚本会直接报告并退出。
 *
 * 调用后 `created_at` 变为真实时刻 ⇒ 该端点触发延长；
 * 保持不变 ⇒ 不触发。对照组全程不变是预期。
 *
 * ## ⚠️ 两次实测踩坑（脚本已按此修正，勿改回去）
 *
 * **1. 凭据必须每次实时重读。** all_proxy 每小时的静默续期会**轮换
 * `access_token`**；若脚本在启动时读一份快照，续期后旧 token 立即失效，
 * 后续请求全部 `401 code=200003`。2026-10-10 首次实验正是这样整批失效的
 * （00:07 启动、00:21 服务续期、之后三个账号全部 401）。现改为
 * `readCredential(ref)` 每次实时读 + 401 重试一次。
 *
 * **2. 不要「等记录出现」。** 实测当天的 `daily_grant` **并非 00:00 就存在**：
 * 2026-10-10 的 00:07~00:21 反复读 /bills 都查不到，直到当天首次有
 * 登录态动作（00:25）才出现。故「今天尚无记录」是**合法且干净的初始态**
 * （说明今天还没人登录过），不是「服务端还没发放、继续等」。首次实验在此
 * 空等 14 分钟，既拖长窗口撞上 token 轮换，又把因果搞乱。现改为只读一次快照，
 * 并把「记录从无到有」也算作**阳性**信号（阶段 4 的 `created` 分支）。
 *
 * ## 用法
 *
 * ```bash
 * node scripts/probe-raccoon-daily-extension.mjs --dry-run   # 只读，不发触发请求
 * node scripts/probe-raccoon-daily-extension.mjs             # 真实实验（会消耗当天延长机会）
 * ```
 *
 * 结果同时写入 `data/logs/raccoon-daily-extension-probe.json`（追加式），
 * 便于隔日复查。
 *
 * ⚠️ 实验**只读** `data/credentials.json`，绝不回写；也**不调用 refresh**
 * （raccoon 的 refresh_token 一次性轮换，乱刷会让账号失效）。
 */

import { appendFileSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const CREDENTIALS_PATH = join(ROOT, 'data', 'credentials.json')
const RESULT_PATH = join(ROOT, 'data', 'logs', 'raccoon-daily-extension-probe.json')

const API_BASE = 'https://xiaohuanxiong.com'
const POINTS_PREFIX = '/api/web/points/v1'
const OFFICE_PREFIX = '/api/web/office/v3'
const REQUEST_TIMEOUT_MS = 30_000

/** UTC+8 偏移（毫秒）。**写死**，不取本机时区 —— 与 `raccoon-credits.ts` 同约定。 */
const UTC8_OFFSET_MS = 8 * 60 * 60 * 1000

/** 策略表：账号 ref → 实验动作。 */
const STRATEGIES = {
  RACCOON_ACCOUNT_21026F85: 'balance',
  RACCOON_ACCOUNT_2E83590D: 'setting',
  RACCOON_ACCOUNT_9BB58E99: 'control',
}

const DRY_RUN = process.argv.includes('--dry-run')

/** 当前 UTC+8 日期（`YYYY-MM-DD`）。 */
function todayUtc8() {
  return new Date(Date.now() + UTC8_OFFSET_MS).toISOString().slice(0, 10)
}

/** 把 UTC+8 的 `YYYY-MM-DD` 转成该日 `00:00:00+08:00` 的判定用字符串。 */
function isMidnightUtc8(iso) {
  // 服务端格式：`2026-10-09T00:00:00+08:00`
  return typeof iso === 'string' && iso.includes('T00:00:00')
}

/** 读取凭据文件（**只读**）。 */
function readCredentials() {
  return JSON.parse(readFileSync(CREDENTIALS_PATH, 'utf-8'))
}

/**
 * 实时读取某账号的凭据。
 *
 * ⚠️ **必须每次请求前重读，不能用启动时的快照**（2026-10-10 实测踩坑）：
 * all_proxy 服务每小时的静默续期会**轮换 `access_token`**（raccoon 的
 * refresh 每次返回新 access_token），快照里的旧 token 在下一次续期后**立即
 * 失效**，后续请求全部 `401 code=200003`。首次实验因此整批失效 ——
 * 三个账号在 00:07 启动时快照、00:21 服务续期后全部 401。
 */
function readCredential(ref) {
  const all = readCredentials()
  const raw = all[ref]
  if (raw === undefined) throw new Error(`凭据文件里没有 ${ref}`)
  return JSON.parse(raw)
}

/** 是否 401/鉴权失败（用于触发「重读凭据重试」）。 */
function isAuthFailure(status, payload) {
  return status === 401 || payload?.code === 200003
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * 构造请求头。
 *
 * ⚠️ 只发**确实有值**的头：`X-Org-Code` 在个人账号下无值，
 * 早先脚本因 `?? ''` 把它发成空串而误判过 401（实为 token 取错字段）。
 */
function headersFor(credential) {
  const headers = {
    Accept: 'application/json',
    'Content-Type': 'application/json',
    Authorization: `Bearer ${credential.access_token}`,
  }
  if (typeof credential.office_identity === 'string' && credential.office_identity.length > 0) {
    headers['X-Org-Code'] = credential.office_identity
  }
  if (typeof credential.device_id === 'string' && credential.device_id.length > 0) {
    headers['X-Client-Device-ID'] = credential.device_id
  }
  return headers
}

/**
 * 取某账号**今天（UTC+8）**的 `daily_grant` 记录。
 *
 * ⚠️ 传 `ref` 而非凭据对象：内部**每次实时重读凭据**，以规避服务续期
 * 轮换 access_token 导致的 401（见 `readCredential` 的说明）。
 */
async function readTodayDailyGrant(ref) {
  const url = `${API_BASE}${POINTS_PREFIX}/bills?paging.limit=30&paging.offset=0`
  const response = await fetch(url, {
    headers: headersFor(readCredential(ref)),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  })
  const payload = await response.json()
  if (payload.code !== 0) {
    throw new Error(`bills 查询失败：code=${payload.code} message=${payload.message}`)
  }
  const items = Array.isArray(payload.data?.items) ? payload.data.items : []
  const today = todayUtc8()
  const record = items.find(
    (item) => item.biz_type === 'daily_grant' && String(item.grant_at ?? '').startsWith(today),
  )
  if (record === undefined) return undefined
  return {
    grantAt: record.grant_at,
    createdAt: record.created_at,
    expireAt: record.expire_at,
    points: record.points,
    // `client_type` 是服务端给这条账单标的来源端。实测 `daily_grant` 恒为
    // `"web"`（桌面端 LLM 消耗才是 `"desktop"`）—— 这条线索支持
    // 「延长由**带 Authorization 的 web 会话请求**触发」，而非桌面端专属。
    clientType: record.client_type,
  }
}

/**
 * 执行一个策略的请求。返回请求结果描述（不抛错）。
 *
 * ⚠️ 每次调用**实时重读凭据**；若首次返回 401（例如恰好撞上服务续期轮换），
 * 重读一次再试 —— 这正是首次实验整批失效的原因。
 */
async function runStrategy(strategy, ref) {
  if (strategy === 'control') return '（对照组，未发任何请求）'
  const path = strategy === 'balance'
    ? `${POINTS_PREFIX}/balance`
    : `${OFFICE_PREFIX}/setting_info`
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const response = await fetch(`${API_BASE}${path}`, {
        headers: headersFor(readCredential(ref)),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      })
      const payload = await response.json().catch(() => undefined)
      if (attempt === 0 && isAuthFailure(response.status, payload)) {
        // 凭据很可能已被服务续期轮换：重读后重试一次。
        await sleep(1_000)
        continue
      }
      return `GET ${path} → HTTP ${response.status} code=${payload?.code ?? '?'}`
    } catch (error) {
      return `GET ${path} → 失败：${error instanceof Error ? error.message : String(error)}`
    }
  }
  return `GET ${path} → 两次尝试均鉴权失败（凭据可能已过期，请重新登录）`
}

async function main() {
  const credentials = readCredentials()
  const lines = []
  const log = (text) => { lines.push(text); console.log(text) }

  log(`=== raccoon 每日积分延长实验 ${new Date().toISOString()}（UTC+8 当日 ${todayUtc8()}）===`)
  log(DRY_RUN ? '模式：dry-run（只读，不发触发请求）' : '模式：真实实验')

  const accounts = Object.keys(STRATEGIES).filter((ref) => credentials[ref] !== undefined)
  if (accounts.length === 0) {
    log('❌ 凭据文件中没有实验涉及的账号，退出')
    return
  }

  // ── 阶段 1：实验前快照 ──
  //
  // ⚠️ **不要等记录出现**（2026-10-10 的教训）：实测当天的 `daily_grant`
  // 记录**并非 00:00 就存在** —— 00:07~00:21 反复读 /bills 都查不到，
  // 直到当天首次有「登录态动作」时才出现。所以「记录尚不存在」本身就是一个
  // **合法且干净**的初始态（说明今天还没人登录过），而不是「服务端还没发放、
  // 继续等」。首次实验正是在这里空等了 14 分钟，结果撞上服务 00:21 的 token
  // 轮换而整批 401 失效。
  //
  // 故这里只读**一次**快照，记录三种初始态：
  //   - 无记录          → 干净（今天尚无登录态动作）
  //   - created_at 整点 → 干净（服务端纯发放，未延长）
  //   - created_at 真实 → 无效（今天已延长，实验做不了）
  log('\n── 阶段 1：实验前快照 ──')
  const startedAt = Date.now()
  const before = {}
  for (const ref of accounts) {
    try {
      const record = await readTodayDailyGrant(ref)
      before[ref] = record
      if (record === undefined) {
        log(`  ${ref}: 今天尚无 daily_grant 记录 → 干净初始态（今天还没有登录态动作）`)
      } else {
        const state = isMidnightUtc8(record.createdAt) ? '未延长' : '⚠️ 已延长'
        log(`  ${ref}: created_at=${record.createdAt} expire_at=${record.expireAt} → ${state}`)
      }
    } catch (error) {
      before[ref] = undefined
      log(`  ${ref}: 查询失败：${error instanceof Error ? error.message : String(error)}`)
    }
  }

  const alreadyExtended = accounts.filter(
    (ref) => before[ref] !== undefined && !isMidnightUtc8(before[ref].createdAt),
  )
  if (alreadyExtended.length > 0) {
    log(`\n❌ 实验无效：${alreadyExtended.join(', ')} 当天已经延长过（created_at 非 00:00:00）。`)
    // 关键诊断：把 created_at 与脚本启动时刻对比。若两者只差几十秒，
    // 那更可能是**本脚本自己的第一次 /bills 读取**触发的延长，
    // 而不是桌面端登录 —— 这两种成因必须区分，否则会把归因搞反。
    //
    // ⚠️ 注意 dry-run 与正式跑**都**要读 /bills，故「先跑 dry-run 看初始态」
    // 并不能规避这一混淆 —— 恰恰相反：**dry-run 跑完就变成「已延长」本身
    // 就是「读账单触发延长」的证据**。真正的干净做法是换一个自然日重跑。
    const near = alreadyExtended.filter((ref) => {
      const delta = Math.abs(new Date(before[ref].createdAt).getTime() - startedAt)
      return delta < 120_000
    })
    if (near.length > 0) {
      log(`   ⚠️ ${near.join(', ')} 的 created_at 距脚本启动不足 2 分钟 ——`)
      log('      高度疑似「**读取 /bills 本身**就会触发延长」（本脚本的首次读取所致）。')
      log('      验证法：换一个自然日，只跑一次 `--dry-run`；')
      log('      若跑完 created_at 就从 00:00:00 变成真实时刻，即可确认。')
    } else {
      log('   延长发生在更早时刻，说明是**桌面端客户端**当天的登录所致（或本服务未察觉的其他触发源）。')
    }
    log('   延长每天只发生一次且幂等，请在**新的 UTC+8 自然日**重跑。')
    return
  }

  if (DRY_RUN) {
    log('\n✅ dry-run 完成：所有账号当天均未延长，脚本可在新的一天正常实验。')
    return
  }

  // ── 阶段 1b：排除「读 /bills 本身触发延长」──
  // 对照组的 before 快照已经读过一次账单。这里**再读一次**：
  // 若状态在两次只读之间就变了（无记录→有记录，或 created_at 变化），
  // 说明触发源是「读账单」这个动作本身，后续对 balance / setting_info
  // 的归因全部无效，直接定论退出。
  //
  // ⚠️ 首次实验（2026-10-10）已给出**否定证据**：阶段 1 在 00:07~00:21
  // 反复读 /bills 共 14 分钟，10-10 记录始终不存在 —— 故「读账单触发」的
  // 可能性很低。本阶段保留是为了让脚本**自证**这一点，而非依赖既往结论。
  log('\n── 阶段 1b：检验「读账单本身是否触发延长」（仅对照组）──')
  await sleep(3_000)
  const controlRef = accounts.find((ref) => STRATEGIES[ref] === 'control')
  if (controlRef !== undefined) {
    try {
      const reread = await readTodayDailyGrant(controlRef)
      const beforeControl = before[controlRef]
      const changedByRead = beforeControl === undefined
        ? reread !== undefined // 无记录 → 有记录
        : (reread !== undefined && reread.createdAt !== beforeControl.createdAt)
      if (changedByRead) {
        log(`  ${controlRef}: ${beforeControl?.createdAt ?? '(无记录)'} → ${reread?.createdAt ?? '(仍无记录)'}`)
        log('\n❌ 定论：**读取 /bills 本身**就会触发延长。')
        log('   两次只读请求之间状态就变了，与 balance / setting_info 无关。')
        log('   → 实现上只需每日调一次 `GET /points/v1/bills` 即可保住每日积分。')
        return
      }
      log(`  ${controlRef}: 状态未变（${reread?.createdAt ?? '仍无记录'}）→ 读账单**不**触发延长`)
    } catch (error) {
      log(`  ${controlRef}: 复查失败：${error instanceof Error ? error.message : String(error)}`)
    }
  }

  // ── 阶段 2：执行策略 ──
  log('\n── 阶段 2：执行策略 ──')
  const strategyOk = {}
  for (const ref of accounts) {
    const strategy = STRATEGIES[ref]
    const result = await runStrategy(strategy, ref)
    // 只有「HTTP 2xx 且业务码 0」才算策略真正送达；否则该账号本轮结论无效。
    strategyOk[ref] = strategy === 'control' ? true : /→ HTTP 2\d\d code=0\b/.test(result)
    log(`  ${ref} [${strategy}] ${result}${strategyOk[ref] ? '' : '  ⚠️ 该请求未成功送达，本轮结论无效'}`)
  }

  // ── 阶段 3：等待服务端落账后复查 ──
  log('\n── 阶段 3：等待 6 秒后复查 ──')
  await sleep(6_000)
  const after = {}
  for (const ref of accounts) {
    try {
      after[ref] = await readTodayDailyGrant(ref)
    } catch (error) {
      after[ref] = undefined
      log(`  ${ref}: 复查失败：${error instanceof Error ? error.message : String(error)}`)
    }
  }

  // ── 阶段 4：判定 ──
  //
  // ⚠️ 判定要同时覆盖「记录从无到有」：当天首次登录态动作会让服务端**创建**
  // 这条 daily_grant 记录（created_at = 真实时刻）。故 before 为 undefined
  // 而 after 存在且非整点，同样是**阳性**信号。
  log('\n── 阶段 4：判定 ──')
  const verdicts = []
  for (const ref of accounts) {
    const b = before[ref]
    const a = after[ref]
    const strategy = STRATEGIES[ref]
    // ⚠️ 策略请求没成功送达（401/网络错）时，无论记录变没变都**不能**下结论：
    // 记录没变可能只是因为我们根本没打通上游。首次实验整批 401 正是这一情形。
    if (strategyOk[ref] !== true) {
      const verdict = '⚪ 无法判定（策略请求未成功送达，需重跑）'
      verdicts.push({ ref, strategy, verdict, beforeCreatedAt: b?.createdAt ?? null, afterCreatedAt: a?.createdAt ?? null })
      log(`  ${ref} [${strategy}] → ${verdict}`)
      continue
    }
    if (a === undefined) {
      const verdict = b === undefined ? '❌ 未触发延长（今天始终无记录）' : '❌ 未触发延长（记录未变）'
      verdicts.push({ ref, strategy, verdict, beforeCreatedAt: b?.createdAt ?? null, afterCreatedAt: undefined })
      log(`  ${ref} [${strategy}] → ${verdict}`)
      continue
    }
    const extended = !isMidnightUtc8(a.createdAt)
    const created = b === undefined
    const changed = b !== undefined && b.createdAt !== a.createdAt
    let verdict
    if (!extended) {
      verdict = '❌ 未触发延长（created_at 仍是整点）'
    } else if (created) {
      verdict = '✅ 触发延长（记录从无到有，created_at 为真实时刻）'
    } else if (changed) {
      verdict = '✅ 触发延长（created_at 变为真实时刻）'
    } else {
      verdict = '⚠️ 已延长但 created_at 未变（需人工核对）'
    }
    verdicts.push({
      ref, strategy, verdict,
      beforeCreatedAt: b?.createdAt ?? null,
      afterCreatedAt: a.createdAt,
      expireAt: a.expireAt,
    })
    log(`  ${ref} [${strategy}] → ${verdict}`)
    log(`      before=${b?.createdAt ?? '(无记录)'}  after=${a.createdAt}  expire=${a.expireAt}`)
  }

  log('\n── 结论 ──')
  const undetermined = verdicts.filter((v) => v.verdict.startsWith('⚪'))
  const triggered = verdicts.filter((v) => v.verdict.startsWith('✅')).map((v) => v.strategy)
  const control = verdicts.find((v) => v.strategy === 'control')
  if (triggered.length > 0) {
    log(`触发延长的策略：${triggered.join(', ')}`)
    log('→ 实现上可在每日首次任务里调用该端点，即可把每日 300 积分保住 7 天。')
  } else if (undetermined.length > 0) {
    log(`⚠️ 本轮**无法判定**：${undetermined.map((v) => v.strategy).join(', ')} 的策略请求未成功送达。`)
    log('   这**不是**「端点无效」的证据 —— 请在下一个自然日重跑。')
  } else {
    log('没有任何策略触发延长 —— 说明「当日登录」由更完整的客户端会话判定，')
    log('需要回到 app.asar 继续挖（例如 device bind 或客户端握手）。')
  }
  if (control !== undefined && control.verdict.startsWith('✅')) {
    log('⚠️ 对照组也延长了：说明存在**本服务未察觉的**触发源（例如小时级续期），需重新设计对照。')
  }

  // ── 落盘（追加，便于隔日复查）──
  try {
    mkdirSync(dirname(RESULT_PATH), { recursive: true })
    appendFileSync(RESULT_PATH, `${JSON.stringify({
      ranAt: new Date().toISOString(),
      utc8Date: todayUtc8(),
      dryRun: DRY_RUN,
      before,
      after,
      verdicts,
    })}\n`, 'utf-8')
    log(`\n结果已追加写入：${RESULT_PATH}`)
  } catch (error) {
    log(`\n⚠️ 结果落盘失败：${error instanceof Error ? error.message : String(error)}`)
  }
}

await main()
