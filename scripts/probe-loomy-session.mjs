#!/usr/bin/env node
/**
 * Loomy 凭据有效期探测（**只读**）。
 *
 * ## 目的
 *
 * 回答两个问题：
 *  1. 卡片上「已过期」的账号，其 session 在服务端是否**真的**失效了？
 *     （`expires_at` 是本地按登录时刻 + 14 天**推算**的，服务端响应里不带
 *     到期时间戳 —— 所以本地标记过期 ≠ 服务端一定踢了。）
 *  2. Loomy 是否存在任何**续签/续期**端点（让已过期的 session 免重登复活）？
 *
 * ## ⚠️ 安全边界（勿改）
 *
 * - **只读**：只调 `/models`、`/points/*` 这类查询接口，**绝不**调用任何
 *   登录 / 发验证码 / checkCode 接口 —— 那会消耗用户的短信或触发风控。
 * - **不回写** `data/credentials.json`。
 * - **不打印凭据明文**：只打印账号 ref、手机号（脱敏）、过期时刻、HTTP 状态
 *   与业务码。`access_token` / `userid` 一律不输出。
 */

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const CREDENTIALS_PATH = join(ROOT, 'data', 'credentials.json')

const API_BASE = 'https://loomyad.xunfei.cn/api/v1'
const ACCOUNT_BASE = 'https://account.xfinfr.com'
const TIMEOUT_MS = 20_000

/** 手机号脱敏（仅本脚本输出用，保留头尾便于识别）。 */
function maskPhone(phone) {
  if (typeof phone !== 'string' || phone.length < 7) return '(无手机号)'
  return `${phone.slice(0, 3)}****${phone.slice(-4)}`
}

function readCredentials() {
  return JSON.parse(readFileSync(CREDENTIALS_PATH, 'utf-8'))
}

/** Loomy 两套认证头（/chat 用 Bearer，/points|/models 用 token）。 */
function headersFor(cred, kind) {
  const h = { 'Content-Type': 'application/json' }
  const token = typeof cred.access_token === 'string' ? cred.access_token : ''
  h.Authorization = `Bearer ${token}`
  h.token = token
  return h
}

/** 调一个只读端点，返回 { http, code, desc, data } （不抛错）。 */
async function probe(url, cred, kind) {
  try {
    const res = await fetch(url, {
      method: 'GET',
      headers: headersFor(cred, kind),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
    const text = await res.text().catch(() => '')
    let json
    try { json = JSON.parse(text) } catch { json = undefined }
    return {
      http: res.status,
      code: json?.code ?? json?.statusCodeValue ?? null,
      desc: json?.desc ?? json?.message ?? (text ? text.slice(0, 120) : ''),
      ok: json?.code === '000000' || json?.code === 0 || res.ok,
      raw: json,
    }
  } catch (error) {
    return { http: 0, code: null, desc: error instanceof Error ? error.message : String(error), ok: false, raw: undefined }
  }
}

/** 候选续签端点（只做 GET 探测，看是否「不是 404/405/缺少参数」）。 */
const RENEW_CANDIDATES = [
  `${ACCOUNT_BASE}/login/refresh`,
  `${ACCOUNT_BASE}/login/renew`,
  `${ACCOUNT_BASE}/login/session/renew`,
  `${ACCOUNT_BASE}/login/keepAlive`,
  `${ACCOUNT_BASE}/user/renew`,
  `${API_BASE}/auth/refresh`,
  `${API_BASE}/user/session/refresh`,
  `${API_BASE}/session/renew`,
]

async function main() {
  const credentials = readCredentials()
  const loomyRefs = Object.keys(credentials).filter((r) => /^LOOMY_ACCOUNT_/.test(r))
  if (loomyRefs.length === 0) {
    console.log('凭据文件里没有 LOOMY_ACCOUNT_* 账号，退出。')
    return
  }

  console.log(`=== Loomy 凭据探测 ${new Date().toISOString()} ===`)
  console.log('（只读：不调用登录/发码接口，不回写凭据，不打印凭据明文）\n')

  for (const ref of loomyRefs) {
    let cred
    try { cred = JSON.parse(credentials[ref]) } catch { console.log(`${ref}: 凭据不是 JSON，跳过`); continue }
    const expiresAt = Number(cred.expires_at)
    const expiredLocally = Number.isFinite(expiresAt) && expiresAt <= Date.now()
    console.log(`── ${ref}`)
    console.log(`   手机号(脱敏): ${maskPhone(cred.phone)}`)
    console.log(`   本地 expires_at: ${Number.isFinite(expiresAt) ? new Date(expiresAt).toISOString() : '(无)'} → 本地判定 ${expiredLocally ? '已过期' : '未过期'}`)
    console.log(`   有 refresh_token: ${'refresh_token' in cred ? '是' : '否'}`)

    // 1) 真的失效了吗？—— /models 与 /points/user 是只读查询
    const models = await probe(`${API_BASE}/models`, cred, 'models')
    console.log(`   GET /models → HTTP ${models.http} code=${models.code} ${models.desc ? `desc=${models.desc}` : ''} ${models.ok ? '✅ 仍可用(session 未真失效)' : '❌ 失败'}`)
    const points = await probe(`${API_BASE}/points/user`, cred, 'points')
    console.log(`   GET /points/user → HTTP ${points.http} code=${points.code} ${points.desc ? `desc=${points.desc}` : ''} ${points.ok ? '✅' : '❌'}`)

    // 2) 续签端点是否存在？
    let renewHit = null
    for (const url of RENEW_CANDIDATES) {
      const r = await probe(url, cred, 'account')
      // 「值得注意」= 不是纯 404/405/空，也返回了业务码（说明端点存在但缺参数等）
      const interesting = r.http !== 404 && r.http !== 405 && r.code !== null && r.http !== 0
      if (interesting) { renewHit = { url, ...r }; break }
    }
    console.log(`   续签端点探测: ${renewHit ? `⚠️ ${renewHit.url} → HTTP ${renewHit.http} code=${renewHit.code} desc=${renewHit.desc}（端点可能存在，需人工确认）` : '未发现可用续签端点（均 404/405/无业务码）'}`)
    console.log('')
  }
}

main().catch((e) => { console.error('探测失败:', e); process.exitCode = 1 })
