#!/usr/bin/env node
/**
 * 配对实验：核实 raccoon（商汤小浣熊）的**思考档位到底能不能调**（A12）。
 *
 * ## 要核实的来源结论（来源 2026-09-28 实测，commit 05873c1）
 *
 * | 通道 | 来源结论 |
 * |---|---|
 * | 顶层 `reasoning_effort`（8 个枚举） | **被服务端 JSON schema 接受，但无任何可观测效果** |
 * | `extra_body.thinking.type`（`adaptive`/`enabled`/`disabled`） | **唯一有效通道**：`disabled` 真关闭 |
 *
 * 用户要求「用 GLM-5-3-FLASH 测试」——即 raccoon 的 `sn-glm-5-3-flash`。
 *
 * ## 实验设计（配对 + 符号检验，温度 0）
 *
 * 对**同一提示词**重复 N 轮，逐条件记录服务端上报的 `reasoning_tokens`
 * 与 `reasoning_content` 长度：
 *
 * - `baseline`（不发任何档位字段，取服务端默认）
 * - `reasoning_effort=max` / `=minimal` / `=none`（顶层字段）
 * - `extra_body.thinking.type=disabled` / `=enabled`
 *
 * 判定：
 * - 若 `reasoning_effort` 的 max/minimal 逐轮差值**正负各半**（符号检验不显著）
 *   ⇒ 证实「被接受但无效果」；
 * - 若 `extra_body.thinking.type=disabled` 的 `reasoning_tokens` **恒为 0**
 *   ⇒ 证实「唯一有效通道」。
 *
 * ⚠️ **必须用配对实验 + 符号检验**，不能只看均值趋势：来源记录里 8 轮配对
 * 的 `max - minimal` 正是正 4 / 负 4（纯随机）。
 *
 * ## 安全
 *
 * - **只读**凭据（每次实时重读，绝不 refresh、绝不回写）。
 * - 会消耗少量积分（每轮几十~几百 token）。
 *
 * 用法：
 * ```bash
 * node scripts/probe-raccoon-thinking.mjs                 # 默认 6 轮 × 6 条件
 * node scripts/probe-raccoon-thinking.mjs --rounds 8
 * node scripts/probe-raccoon-thinking.mjs --model sn-glm-5-3-flash
 * ```
 */

import { appendFileSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const CREDENTIALS_PATH = join(ROOT, 'data', 'credentials.json')
const STATE_PATH = join(ROOT, 'data', 'state.json')
const RESULT_PATH = join(ROOT, 'data', 'logs', 'raccoon-thinking-probe.json')

const API_BASE = 'https://xiaohuanxiong.com'
const LLM_PREFIX = '/api/web/llm/v2'
const REQUEST_TIMEOUT_MS = 120_000

/** 参数解析。 */
function argValue(name, fallback) {
  const idx = process.argv.indexOf(name)
  return idx >= 0 && process.argv[idx + 1] !== undefined ? process.argv[idx + 1] : fallback
}
const ROUNDS = Number.parseInt(argValue('--rounds', '6'), 10)
const MODEL = argValue('--model', 'sn-glm-5-3-flash')

/** 提示词：固定、温度 0，减少噪声。 */
const PROMPT = '一个农场有 17 只鸡和 9 只羊，共有多少条腿？请只回答数字。'

/** 六个实验条件。 */
const CONDITIONS = [
  { id: 'baseline', body: {} },
  { id: 'effort=max', body: { reasoning_effort: 'max' } },
  { id: 'effort=minimal', body: { reasoning_effort: 'minimal' } },
  { id: 'effort=none', body: { reasoning_effort: 'none' } },
  { id: 'thinking=disabled', body: { extra_body: { thinking: { type: 'disabled' } } } },
  { id: 'thinking=enabled', body: { extra_body: { thinking: { type: 'enabled' } } } },
]

/** 读取凭据（**只读**）。 */
function readCredentials() {
  return JSON.parse(readFileSync(CREDENTIALS_PATH, 'utf-8'))
}

/** 实时读取某账号凭据（每次重读，规避续期轮换 access_token）。 */
function readCredential(ref) {
  const all = readCredentials()
  const raw = all[ref]
  if (raw === undefined) throw new Error(`凭据文件里没有 ${ref}`)
  return JSON.parse(raw)
}

/** 从本地账号池取第一个启用的 raccoon 账号 ref。 */
function firstRaccoonRef() {
  try {
    const state = JSON.parse(readFileSync(STATE_PATH, 'utf-8'))
    const entry = (state.accounts || []).find((a) => a.provider === 'raccoon' && a.enabled)
    if (entry?.credentialRef) return entry.credentialRef
  } catch { /* 退回下面 */ }
  const ref = Object.keys(readCredentials()).find((k) => k.startsWith('RACCOON_ACCOUNT_'))
  if (ref === undefined) throw new Error('找不到 raccoon 账号')
  return ref
}

/** 发一次非流式 chat，返回 `{ ok, reasoningTokens, reasoningChars, contentChars, code, message }`。 */
async function chat(ref, condition) {
  const credential = readCredential(ref)
  const body = {
    model: MODEL,
    messages: [{ role: 'user', content: PROMPT }],
    stream: false,
    temperature: 0,
    max_tokens: 2048,
    ...condition.body,
  }
  try {
    const response = await fetch(`${API_BASE}${LLM_PREFIX}/chat/completions`, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        Authorization: `Bearer ${credential.access_token}`,
        'X-Raccoon-Language': 'zh',
        'X-Client-Platform': 'desktop-windows',
        'X-Client-Version': 'v1.0.35',
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    })
    const payload = await response.json().catch(() => undefined)
    if (payload?.code !== undefined && payload.code !== 0) {
      return { ok: false, code: payload.code, message: payload.message ?? '', reasoningTokens: null, reasoningChars: null, contentChars: null }
    }
    if (!response.ok) {
      return { ok: false, code: response.status, message: payload?.message ?? `HTTP ${response.status}`, reasoningTokens: null, reasoningChars: null, contentChars: null }
    }
    const message = payload?.choices?.[0]?.message ?? {}
    const reasoning = typeof message.reasoning_content === 'string' ? message.reasoning_content : ''
    const content = typeof message.content === 'string' ? message.content : ''
    const reasoningTokens = typeof payload?.usage?.reasoning_tokens === 'number' ? payload.usage.reasoning_tokens : null
    return { ok: true, code: 0, message: '', reasoningTokens, reasoningChars: reasoning.length, contentChars: content.length }
  } catch (error) {
    return { ok: false, code: -1, message: error instanceof Error ? error.message : String(error), reasoningTokens: null, reasoningChars: null, contentChars: null }
  }
}

/** 符号检验（双尾精确二项）：返回 `{ plus, minus, p }`。 */
function signTest(diffs) {
  const plus = diffs.filter((d) => d > 0).length
  const minus = diffs.filter((d) => d < 0).length
  const n = plus + minus
  if (n === 0) return { plus, minus, p: 1 }
  // 双尾精确二项：2 * P(X <= min(plus,minus))，X~B(n, 0.5)
  const k = Math.min(plus, minus)
  let cdf = 0
  let binom = 1 // C(n,0)
  for (let i = 0; i <= k; i++) {
    if (i > 0) binom = (binom * (n - i + 1)) / i
    cdf += binom / 2 ** n
  }
  return { plus, minus, p: Math.min(1, 2 * cdf) }
}

async function main() {
  const lines = []
  const log = (t) => { lines.push(t); console.log(t) }

  const ref = firstRaccoonRef()
  log(`=== raccoon 思考档位配对实验 ${new Date().toISOString()} ===`)
  log(`账号: ${ref}  模型: ${MODEL}  轮数: ${ROUNDS}  条件数: ${CONDITIONS.length}`)

  // 前置探测：模型是否可用（避免整场跑空）。
  const probe = await chat(ref, CONDITIONS[0])
  if (!probe.ok) {
    log(`\n❌ 前置探测失败（code=${probe.code} ${probe.message}）—— 实验无法进行。`)
    log('   若为 `200903 service_unavailable`，是上游整体不可用，请稍后重试。')
    log(`\n结果已写入：${RESULT_PATH}`)
    writeResult({ ref, model: MODEL, rounds: ROUNDS, probe, samples: [] })
    return
  }

  /** 逐条件逐轮采样。 */
  const samples = {}
  for (const condition of CONDITIONS) samples[condition.id] = []

  for (let round = 1; round <= ROUNDS; round++) {
    log(`\n── 第 ${round}/${ROUNDS} 轮 ──`)
    for (const condition of CONDITIONS) {
      const r = await chat(ref, condition)
      samples[condition.id].push(r)
      const shown = r.ok
        ? `reasoning_tokens=${r.reasoningTokens} reasoning_chars=${r.reasoningChars} content_chars=${r.contentChars}`
        : `❌ code=${r.code} ${r.message}`
      log(`  [${condition.id.padEnd(18)}] ${shown}`)
    }
  }

  // ── 汇总 ──
  log('\n── 汇总（reasoning_tokens）──')
  const summarize = (id) => {
    const vals = samples[id].filter((s) => s.ok && s.reasoningTokens !== null).map((s) => s.reasoningTokens)
    if (vals.length === 0) return '（无有效样本）'
    const mean = vals.reduce((a, b) => a + b, 0) / vals.length
    return `均值 ${mean.toFixed(1)}  范围 [${Math.min(...vals)}, ${Math.max(...vals)}]  n=${vals.length}`
  }
  for (const condition of CONDITIONS) log(`  ${condition.id.padEnd(18)} ${summarize(condition.id)}`)

  // 配对符号检验：effort=max vs effort=minimal（若 reasoning_effort 有效，max 应显著更大）。
  log('\n── 配对符号检验 ──')
  const paired = []
  for (let i = 0; i < ROUNDS; i++) {
    const a = samples['effort=max'][i]
    const b = samples['effort=minimal'][i]
    if (a?.ok && b?.ok && a.reasoningTokens !== null && b.reasoningTokens !== null) {
      paired.push(a.reasoningTokens - b.reasoningTokens)
    }
  }
  const st = signTest(paired)
  log(`  effort=max − effort=minimal：正 ${st.plus} / 负 ${st.minus}，双尾 p=${st.p.toFixed(3)}`)
  log(st.p > 0.05
    ? '  ⇒ 差异**不显著**（正负接近各半）：证实 `reasoning_effort` **被接受但无效果**。'
    : '  ⇒ 差异显著：`reasoning_effort` 似乎**有效** —— 与来源结论相反，需复测确认。')

  // thinking=disabled 是否恒为 0。
  const disabledVals = samples['thinking=disabled'].filter((s) => s.ok).map((s) => s.reasoningTokens)
  const allZero = disabledVals.length > 0 && disabledVals.every((v) => v === 0)
  log(`\n  thinking=disabled：reasoning_tokens = [${disabledVals.join(', ')}]`)
  log(allZero
    ? '  ⇒ **全部为 0**：证实 `extra_body.thinking.type=disabled` 是**唯一有效**的关闭通道。'
    : '  ⇒ 未全部为 0：与来源结论不符，需复测确认。')

  writeResult({ ref, model: MODEL, rounds: ROUNDS, probe, samples, signTest: st })
  log(`\n结果已写入：${RESULT_PATH}`)
}

/** 追加落盘。 */
function writeResult(payload) {
  try {
    mkdirSync(dirname(RESULT_PATH), { recursive: true })
    appendFileSync(RESULT_PATH, `${JSON.stringify({ ranAt: new Date().toISOString(), ...payload })}\n`, 'utf-8')
  } catch { /* 落盘失败不影响结论 */ }
}

await main()
