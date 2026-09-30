#!/usr/bin/env node
/**
 * 真机验证：对**真实 raccoon 账号**发一次请求，验证网关的流式与非流式路径。
 *
 * ⚠️ 这会真实消耗该账号的少量额度（约几十 token）。
 *
 * 凭据来源：`~/.dsh/.credentials.yaml` 的 `refs:` 段（**只读**，不写回）。
 * 该文件是 YAML，但运行时没有 YAML 依赖，故这里只做最小文本扫描
 * （与来源 `jet-hub-store.ts` 的 `extractCredentialRefNames` 同思路）。
 *
 * 用法：
 *   node scripts/verify-raccoon-live.mjs
 */
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { RaccoonAdapter } from '../dist/providers/raccoon/raccoon-adapter.js'

const CREDENTIALS = join(homedir(), '.dsh', '.credentials.yaml')

/** 从 .credentials.yaml 里取出某个 ref 的值（JSON 字符串）。 */
function readCredential(ref) {
  const text = readFileSync(CREDENTIALS, 'utf-8')
  // 逐行找 `  <REF>: '<json>'`；值可能很长且含转义，故用宽松匹配。
  const lines = text.split(/\r?\n/)
  for (const line of lines) {
    const match = new RegExp(`^\\s{2,}${ref}:\\s*(.*)$`).exec(line)
    if (match === null) continue
    let value = match[1].trim()
    // 去掉 YAML 单引号包裹（内部 '' 表示一个 '）。
    if (value.startsWith("'") && value.endsWith("'")) {
      value = value.slice(1, -1).replace(/''/g, "'")
    }
    return JSON.parse(value)
  }
  throw new Error(`未找到凭据 ref: ${ref}`)
}

/** 收集 chunk 流并按类型汇总。 */
async function collect(adapter, options) {
  const chunks = []
  for await (const chunk of adapter.stream(options)) chunks.push(chunk)
  return chunks
}

/** 把 chunk 汇总成可读结果。 */
function summarize(chunks) {
  const text = chunks.filter(c => c.type === 'text-delta').map(c => c.text).join('')
  const reasoning = chunks.filter(c => c.type === 'reasoning-delta').map(c => c.text).join('')
  const usage = chunks.find(c => c.type === 'usage')?.usage
  const finish = chunks.find(c => c.type === 'finish')?.reason
  const toolCalls = chunks.filter(c => c.type === 'tool-call-delta').length
  return { text, reasoning, usage, finish, toolCalls, chunkCount: chunks.length }
}

const ref = process.env.RACCOON_REF ?? 'RACCOON_ACCOUNT_9ED45558'
const credential = readCredential(ref)
console.log(`账号: ${credential.nickname ?? '(无昵称)'}  过期: ${credential.expires_at ? new Date(Number(credential.expires_at)).toISOString() : '(未知)'}`)

let refreshCalled = 0
const adapter = new RaccoonAdapter({
  resolveCredential: async () => credential,
  // ⚠️ 刻意**不真刷新**：raccoon 的 refresh 会轮换 refresh_token，而本脚本
  // 只读 DSH 的凭据文件、不写回 —— 真刷新会让 DSH 侧那份失效。
  refresh: async () => { refreshCalled++ },
})

// ── 非流式（网关内部始终用流式对接上游，这里聚合成非流式结果） ──
console.log('\n=== 1. 非流式请求（聚合） ===')
const model = process.env.RACCOON_MODEL ?? 'sn-glm-5-3'
const started = Date.now()
const nonStream = await collect(adapter, {
  provider: 'raccoon',
  model,
  messages: [{ role: 'user', content: '只回复两个字：你好' }],
  maxTokens: 64,
})
const ns = summarize(nonStream)
console.log(`模型: ${model}  用时: ${Date.now() - started}ms`)
console.log(`chunk 数: ${ns.chunkCount}  finish: ${JSON.stringify(ns.finish)}`)
console.log(`正文: ${JSON.stringify(ns.text.slice(0, 200))}`)
console.log(`思考: ${ns.reasoning.length} 字`)
console.log(`usage: ${JSON.stringify(ns.usage)}`)
if (ns.text.length === 0) {
  console.log('⚠️ 正文为空 —— 该模型默认思考很重，max_tokens=64 可能全被思考占满（属上游行为）')
}

// ── 流式（逐块到达） ──
console.log('\n=== 2. 流式请求（观察逐块到达） ===')
const arrivals = []
const streamStarted = Date.now()
for await (const chunk of adapter.stream({
  provider: 'raccoon',
  model,
  messages: [{ role: 'user', content: '数到三' }],
  maxTokens: 128,
})) {
  if (chunk.type === 'text-delta' || chunk.type === 'reasoning-delta') {
    arrivals.push({ t: Date.now() - streamStarted, type: chunk.type })
  }
}
console.log(`收到 ${arrivals.length} 个增量，首块 t=${arrivals[0]?.t ?? '-'}ms，末块 t=${arrivals.at(-1)?.t ?? '-'}ms`)
console.log(`分块到达（前 8 个）: ${arrivals.slice(0, 8).map(a => `${a.type[0]}@${a.t}ms`).join(' ')}`)
console.log(`刷新调用次数: ${refreshCalled}（应为 0 —— 脚本不真刷新）`)
console.log('\n✅ 真机验证完成')
