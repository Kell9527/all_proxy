#!/usr/bin/env node
/**
 * 只读诊断：Raccoon「保活今日积分」为何未触发（`code=200903 service_unavailable`）。
 *
 * ## 背景（用户报障）
 *
 * 「保活今日积分」对 3 个账号执行后：1 个报「今日已延长」（用户自述**他登录了
 * 客户端**），另 2 个报：
 *
 * ```
 * raccoon：未能延长 — 候选端点均未触发延长（最后一次错误：code=200903 service_unavailable）
 * ```
 *
 * ## 要回答的两个问题
 *
 * **Q1：`200903` 到底是「端点报错」还是「端点成功但账单没变」？**
 * 生产代码里 `callKeepaliveCandidate` 只把「业务码非 0」拼成 `code=…`，
 * 所以带 `code=200903` 一定是**端点返回了非 0 业务码**（请求被拒）。
 *
 * **Q2：200903 是「会话/客户端身份不足」还是「瞬时不可用」？**
 * 对**同一账号**用不同请求头打同一个 `setting_info`，看哪种组合能拿到 200：
 *
 * | 变体 | 与生产 `raccoonHeaders` 的差异 |
 * |---|---|
 * | `prod` | 生产头原样（含空串 `X-Org-Code`、有 device_id 才发） |
 * | `no-org` | **不发** `X-Org-Code`（对齐 `probe-raccoon-daily-extension.mjs`） |
 * | `device` | 补一个 32 位 hex 的 `X-Client-Device-ID` |
 * | `both` | `no-org` + `device` |
 *
 * 若某变体把 200903 变成 200 → 根因是**请求头**（补头即可修）；
 * 若全变体恒 200903 → 根因是**会话**（服务端凭据无法触发，需改设计前提）。
 *
 * ## 安全
 *
 * - **只读**：绝不调用任何写端点、绝不调用 refresh（refresh_token 一次性轮换，
 *   乱刷会让账号失效）。
 * - **凭据每次实时重读**：服务端每小时续期会轮换 access_token，用启动快照会
 *   整批 401（`probe-raccoon-daily-extension.mjs` 的实测教训）。
 * - **绝不回写** `data/credentials.json`。
 *
 * 用法：
 * ```bash
 * node scripts/probe-raccoon-keepalive-200903.mjs
 * ```
 */

import { appendFileSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const CREDENTIALS_PATH = join(ROOT, 'data', 'credentials.json')
const STATE_PATH = join(ROOT, 'data', 'state.json')
const RESULT_PATH = join(ROOT, 'data', 'logs', 'raccoon-keepalive-200903-probe.json')

const API_BASE = 'https://xiaohuanxiong.com'
const POINTS_PREFIX = '/api/web/points/v1'
const OFFICE_PREFIX = '/api/web/office/v3'
const REQUEST_TIMEOUT_MS = 30_000

/** UTC+8 偏移（毫秒）。写死，不取本机时区。 */
const UTC8_OFFSET_MS = 8 * 60 * 60 * 1000

/** 读取凭据文件（**只读**）。 */
function readCredentials() {
  return JSON.parse(readFileSync(CREDENTIALS_PATH, 'utf-8'))
}

/** 实时读取某账号的凭据（**必须每次重读**，见文件头）。 */
function readCredential(ref) {
  const all = readCredentials()
  const raw = all[ref]
  if (raw === undefined) throw new Error(`凭据文件里没有 ${ref}`)
  return JSON.parse(raw)
}

/** 当前 UTC+8 日期（`YYYY-MM-DD`）。 */
function todayUtc8() {
  return new Date(Date.now() + UTC8_OFFSET_MS).toISOString().slice(0, 10)
}

/** 判定「未延长」：created_at 含整点 T00:00:00。 */
function isMidnightUtc8(iso) {
  return typeof iso === 'string' && iso.includes('T00:00:00')
}

/** 生产头（对齐 `raccoonHeaders`：个人账号发**空串** X-Org-Code）。 */
function prodHeaders(credential) {
  const headers = {
    Accept: 'application/json',
    'Content-Type': 'application/json',
    Authorization: `Bearer ${credential.access_token}`,
    'X-Org-Code': credential.office_identity ?? '',
    'X-Raccoon-Language': 'zh',
    'X-Client-Platform': 'desktop-windows',
    'X-Client-Version': 'v1.0.35',
  }
  if (typeof credential.device_id === 'string' && credential.device_id.length > 0) {
    headers['X-Client-Device-ID'] = credential.device_id
  }
  return headers
}

/** 造一个 32 位 hex 设备号（仅诊断用，不持久化）。 */
function syntheticDeviceId() {
  let s = ''
  while (s.length < 32) s += Math.floor(Math.random() * 16).toString(16)
  return s
}

/** 四个头变体。 */
function headerVariants(credential) {
  const prod = prodHeaders(credential)
  const noOrg = { ...prod }
  delete noOrg['X-Org-Code']
  const device = { ...prod, 'X-Client-Device-ID': credential.device_id || syntheticDeviceId() }
  const both = { ...device }
  delete both['X-Org-Code']
  return { prod, 'no-org': noOrg, device, both }
}

/** 发一次 GET，返回 `{ status, code, message }`（不抛错）。 */
async function getJson(path, headers) {
  try {
    const response = await fetch(`${API_BASE}${path}`, {
      headers,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    })
    const payload = await response.json().catch(() => undefined)
    return {
      status: response.status,
      code: payload?.code ?? null,
      message: typeof payload?.message === 'string' ? payload.message : '',
    }
  } catch (error) {
    return { status: 0, code: null, message: error instanceof Error ? error.message : String(error) }
  }
}

/** 读今天（UTC+8）的 daily_grant 记录。 */
async function readTodayDailyGrant(headers) {
  const result = await getJson(`${POINTS_PREFIX}/bills?paging.limit=30&paging.offset=0`, headers)
  if (result.code !== 0) return { ...result, record: undefined }
  // 上面 getJson 不返回 items，这里单独再取一次（诊断脚本，多一次只读无妨）。
  const response = await fetch(`${API_BASE}${POINTS_PREFIX}/bills?paging.limit=30&paging.offset=0`, {
    headers,
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  })
  const payload = await response.json()
  const items = Array.isArray(payload?.data?.items) ? payload.data.items : []
  const today = todayUtc8()
  const record = items.find(
    (item) => item.biz_type === 'daily_grant' && String(item.grant_at ?? '').startsWith(today),
  )
  return {
    ...result,
    record: record === undefined
      ? undefined
      : {
        grantAt: record.grant_at,
        createdAt: record.created_at,
        expireAt: record.expire_at,
        points: record.points,
        clientType: record.client_type,
      },
  }
}

/** 列出本地账号池里的 raccoon 账号（只读 state.json）。 */
function raccoonAccountRefs() {
  const credentials = readCredentials()
  const refs = Object.keys(credentials).filter((key) => key.startsWith('RACCOON_ACCOUNT_'))
  let nicknameById = {}
  try {
    const state = JSON.parse(readFileSync(STATE_PATH, 'utf-8'))
    const accounts = Array.isArray(state?.accounts) ? state.accounts : []
    for (const entry of accounts) {
      if (entry?.provider === 'raccoon' && typeof entry.credentialRef === 'string') {
        nicknameById[entry.credentialRef] = entry.nickname ?? entry.id
      }
    }
  } catch { /* state 不存在或损坏：昵称退回 ref */ }
  return refs.map((ref) => ({ ref, nickname: nicknameById[ref] ?? '(未在账号池中)' }))
}

async function main() {
  const lines = []
  const log = (text) => { lines.push(text); console.log(text) }

  log(`=== raccoon 保活 200903 诊断 ${new Date().toISOString()}（UTC+8 当日 ${todayUtc8()}）===`)
  const accounts = raccoonAccountRefs()
  log(`账号池中的 raccoon 账号：${accounts.length} 个`)
  if (accounts.length === 0) {
    log('❌ 没有 RACCOON_ACCOUNT_* 凭据，退出')
    return
  }

  const results = []
  for (const { ref, nickname } of accounts) {
    log(`\n── ${ref}（${nickname}）──`)
    let credential
    try {
      credential = readCredential(ref)
    } catch (error) {
      log(`  ⚠️ 读取凭据失败：${error instanceof Error ? error.message : String(error)}`)
      continue
    }
    const hasDeviceId = typeof credential.device_id === 'string' && credential.device_id.length > 0
    const hasOrgCode = typeof credential.office_identity === 'string' && credential.office_identity.length > 0
    log(`  凭据字段：device_id=${hasDeviceId ? '有' : '无'}  office_identity=${hasOrgCode ? '有' : '无'}`)

    const variants = headerVariants(credential)
    const probe = { ref, nickname, hasDeviceId, hasOrgCode, variants: {}, bills: undefined }

    // ① 对照：balance（只读，确认 token 本身有效）。
    const balance = await getJson(`${POINTS_PREFIX}/balance`, variants.prod)
    log(`  [对照] GET ${POINTS_PREFIX}/balance          → HTTP ${balance.status} code=${balance.code} ${balance.message}`)
    probe.balance = balance

    // ② setting_info 四个头变体。
    for (const [name, headers] of Object.entries(variants)) {
      const r = await getJson(`${OFFICE_PREFIX}/setting_info`, headers)
      const verdict = r.status === 200 && r.code === 0 ? '✅ 200' : `❌ code=${r.code}`
      log(`  [${name.padEnd(7)}] GET ${OFFICE_PREFIX}/setting_info → HTTP ${r.status} ${verdict} ${r.message}`)
      probe.variants[name] = r
    }

    // ③ 今天的 daily_grant（判定「是否已延长」）。
    const bills = await readTodayDailyGrant(variants.prod)
    if (bills.record === undefined) {
      log(`  [账单] 今天无 daily_grant 记录（干净初始态：今天还没有登录态动作）`)
    } else {
      const state = isMidnightUtc8(bills.record.createdAt) ? '未延长（created_at 为整点）' : '⚠️ 已延长（created_at 为真实时刻）'
      log(`  [账单] created_at=${bills.record.createdAt} expire_at=${bills.record.expireAt} client_type=${bills.record.clientType} → ${state}`)
    }
    probe.bills = bills

    results.push(probe)
  }

  // ── 结论 ──
  log('\n── 结论 ──')
  const anySuccess = results.some((p) =>
    Object.values(p.variants).some((v) => v.status === 200 && v.code === 0))
  const allServiceUnavailable = results.every((p) =>
    Object.values(p.variants).every((v) => v.code === 200903))
  const tokenValid = results.every((p) => p.balance.status === 200 && p.balance.code === 0)

  if (anySuccess) {
    const winner = results
      .flatMap((p) => Object.entries(p.variants).filter(([, v]) => v.status === 200 && v.code === 0).map(([name]) => name))
    log(`✅ 有变体成功（${[...new Set(winner)].join(', ')}）→ 根因是**请求头**：`)
    log('   → 修 `raccoonHeaders`：个人账号不发空 X-Org-Code；补齐 X-Client-Device-ID。')
  } else if (allServiceUnavailable && tokenValid) {
    log('❌ 全部变体恒 `200903 service_unavailable`，而 balance 正常 ⇒ **不是 token 失效、也与请求头无关**。')
    log('   → 根因是**会话**：服务端凭据（refresh 换来的 access_token）拿不到 office 会话。')
    log('   → 结论：`setting_info` 只在「真实客户端登录态」下可用，保活功能的设计前提**不成立**。')
    log('   → 建议：改设计前提 —— 如实降级为「检测/提醒」，文案区分「本次真延长」与「检测到客户端已延长」。')
  } else {
    log('⚠️ 结果不一致，需人工判读上面的逐条输出。')
  }

  try {
    mkdirSync(dirname(RESULT_PATH), { recursive: true })
    appendFileSync(RESULT_PATH, `${JSON.stringify({
      ranAt: new Date().toISOString(), utc8Date: todayUtc8(), results,
    })}\n`, 'utf-8')
    log(`\n结果已追加写入：${RESULT_PATH}`)
  } catch (error) {
    log(`\n⚠️ 结果落盘失败：${error instanceof Error ? error.message : String(error)}`)
  }
}

await main()
