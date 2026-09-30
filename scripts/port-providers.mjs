#!/usr/bin/env node
/**
 * 批量移植脚本：把来源插件的 provider 实现搬进本项目。
 *
 * ## 为什么用脚本而不是手工复制
 *
 * 移植策略是「**只改 import 行**，实现逐字保留」（见 AGENTS.md）。要搬的文件
 * 有几十个、互相引用，手工逐个改 import 极易漏改或改错，且日后按基线 commit
 * 重新 cherry-pick 时又要重来一遍。脚本让这件事**可重复、可审计**。
 *
 * ## 本脚本做的改写（仅三类）
 *
 * 1. `@deepseek-ai/dsh-llm` → `./llm.js`（本地词汇表，`src/providers/llm.ts` 转发）；
 * 2. `@deepseek-ai/dsh-credentials` → `./credential-ref.js`（本地恒等实现）；
 * 3. `@deepseek-ai/cordis` → `./cordis.js`（本地最小 Service/Context shim）。
 *
 * ⚠️ **不做任何其它改写**。任何「顺手重构」都会让日后与来源对照变得困难。
 *
 * ## 关于同目录 shim
 *
 * 来源的 provider 文件与 `account-pool.ts` / `sse.ts` / `settings-compat.ts` 等
 * **同目录**，故它们写 `./account-pool.js`。本项目把这些实现在别处，并在
 * `src/providers/` 放了同名转发 shim —— 于是移植文件**无需改动 import 路径**。
 *
 * 用法：
 *   node scripts/port-providers.mjs --group adapters [--check]
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = join(HERE, '..')
const SRC = join(REPO, '..', 'deepseek-harness-codearts', 'src')
const DST = join(REPO, 'src', 'providers')

/**
 * 分组清单。
 *
 * `adapters` = 协议层与适配器（任务组 4）。
 * `credentials` = 登录与积分（任务组 5 与 10），按需再跑。
 */
const GROUPS = {
  adapters: [
    // 共享类型
    'types.ts',
    // CodeArts（华为云）
    'models.ts',
    'llm-adapter.ts',
    // CodeBuddy 系（buddy + workbuddy 共用）
    'buddy.ts',
    'product.ts',
    'buddy-adapter.ts',
    // LobsterAI
    'lobsterai.ts',
    'lobsterai-product.ts',
    'lobsterai-errors.ts',
    'lobsterai-adapter.ts',
    // Qoder 系（qoder + qodercn 共用）
    'qoder.ts',
    'qoder-product.ts',
    'qoder-machine.ts',
    'qoder-wasm.ts',
    'qoder-envelope.ts',
    'qoder-adapter.ts',
    // TRAE
    'trae.ts',
    'trae-product.ts',
    'trae-errors.ts',
    'trae-adapter.ts',
    // Cline
    'cline.ts',
    'cline-product.ts',
    'cline-models.ts',
    'cline-adapter.ts',
    // Loomy
    'loomy.ts',
    'loomy-product.ts',
    'loomy-adapter.ts',
  ],
  /**
   * 登录与积分（任务组 10 与积分能力）。
   *
   * 这些文件含**协议级**知识（短信/扫码/设备码/DPoP、签到端点与幂等判据），
   * 是「完整移植登录流程」这一目标的主体。
   */
  credentials: [
    // 通用
    'oauth.ts',
    'login.ts',
    'credits.ts',
    // CodeArts
    'service.ts',
    'codearts-credits.ts',
    // CodeBuddy 系
    'buddy-oauth.ts',
    'buddy-auth.ts',
    // LobsterAI
    'lobsterai-oauth.ts',
    'lobsterai-auth.ts',
    'lobsterai-credits.ts',
    // Qoder 系
    'qoder-oauth.ts',
    'qoder-auth.ts',
    'qoder-credits.ts',
    // TRAE
    'trae-oauth.ts',
    'trae-auth.ts',
    'trae-credits.ts',
    // Cline
    'cline-oauth.ts',
    'cline-auth.ts',
    'cline-credits.ts',
    // Loomy
    'loomy-sign.ts',
    'loomy-wechat.ts',
    'loomy-oauth.ts',
    'loomy-wechat-login.ts',
    'loomy-auth.ts',
    'loomy-credits.ts',
    'loomy-onboarding.ts',
    'loomy-balance-rank.ts',
    'loomy-balance-selector.ts',
    // Raccoon
    'raccoon-qr.ts',
    'raccoon-oauth.ts',
    'raccoon-login-page.ts',
    'raccoon-auth.ts',
    // 探针与备份
    'account-probe.ts',
    'backup.ts',
  ],
}

/**
 * 已在本项目中重写或已就位的文件 —— **不要**被脚本覆盖。
 *
 * 这些文件有实质改动（去掉 DSH 依赖或改语义），脚本必须跳过，
 * 否则会把手工成果冲掉。
 */
const SKIP = new Set([
  'raccoon.ts',           // 已移植
  'raccoon-product.ts',   // 已移植
  'raccoon-adapter.ts',   // 已移植（删了目录门控）
  'raccoon-credits.ts',   // 已移植（改了 credits 类型导入）
])

/** 把 DSH 导入换成本地实现。 */
function rewriteImports(text) {
  return text
    .replace(/from '@deepseek-ai\/dsh-llm'/g, "from './llm.js'")
    .replace(/from '@deepseek-ai\/dsh-credentials'/g, "from './credential-ref.js'")
    .replace(/from '@deepseek-ai\/cordis'/g, "from './cordis.js'")
    // ⚠️ `declare module '@deepseek-ai/cordis'` 的增补也要指向本地模块名 ——
    // 否则 TS 会去找一个不存在的包，报 TS2664。
    .replace(/declare module '@deepseek-ai\/cordis'/g, "declare module './cordis.js'")
    // 账号池与状态文档：本项目实现在 src/pool/。
    .replace(/from '\.\/jet-hub-store\.js'/g, "from '../pool/state-store.js'")
}

/** 找出移植后仍指向 DSH 或未就位模块的导入（必须手工处理）。 */
function findRemainingDsh(text) {
  const hits = []
  for (const m of text.matchAll(/from '(@deepseek-ai\/[^']+)'/g)) hits.push(m[1])
  for (const m of text.matchAll(/from '\.\/(settings-compat|jet-hub-store|jet-hub-rpc|index)\.js'/g)) {
    // settings-compat 有本地 shim，是允许的。
    if (m[1] !== 'settings-compat') hits.push(`./${m[1]}.js`)
  }
  return [...new Set(hits)]
}

const groupName = (() => {
  const i = process.argv.indexOf('--group')
  return i === -1 ? 'adapters' : process.argv[i + 1]
})()
const checkOnly = process.argv.includes('--check')

const FILES = GROUPS[groupName]
if (FILES === undefined) {
  console.error(`未知分组 "${groupName}"，可用: ${Object.keys(GROUPS).join(', ')}`)
  process.exit(1)
}
if (!existsSync(SRC)) {
  console.error(`来源目录不存在: ${SRC}`)
  process.exit(1)
}
mkdirSync(DST, { recursive: true })

let ported = 0
let skipped = 0
const needManual = []

for (const file of FILES) {
  if (SKIP.has(file)) { skipped++; continue }
  const from = join(SRC, file)
  if (!existsSync(from)) {
    needManual.push({ file, reason: '来源文件不存在' })
    continue
  }
  const rewritten = rewriteImports(readFileSync(from, 'utf-8'))
  const remaining = findRemainingDsh(rewritten)
  if (remaining.length > 0) needManual.push({ file, reason: `仍引用: ${remaining.join(', ')}` })
  if (!checkOnly) writeFileSync(join(DST, file), rewritten, 'utf-8')
  ported++
}

console.log(`分组 ${groupName}: 移植 ${ported} 个文件，跳过 ${skipped} 个已就位文件`)
if (needManual.length > 0) {
  console.log('\n⚠️ 需要手工处理（脚本不猜语义）：')
  for (const item of needManual) console.log(`  ${item.file}: ${item.reason}`)
}
