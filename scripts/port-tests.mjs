#!/usr/bin/env node
/**
 * 批量移植来源的单元测试。
 *
 * ## 为什么值得做
 *
 * 来源的测试是「移植正确性」的唯一可信证据 —— 它们断言的是**真实故障现场**
 * 总结出的行为（Qoder 三层嵌套错误码、TRAE 档位合并、腾讯促销时段推算…）。
 * 重写测试会丢掉这些断言，而移植实现**逐字保留**，故测试也应逐字保留。
 *
 * ## 改写规则（与 `port-providers.mjs` 对应）
 *
 * 1. `../../src/xxx.js` → `../../src/providers/xxx.js`（本项目的实现位置）；
 * 2. `@deepseek-ai/dsh-llm` → `../../src/providers/llm.js`；
 * 3. `@deepseek-ai/dsh-credentials` → `../../src/providers/credential-ref.js`；
 * 4. `@deepseek-ai/cordis` → `../../src/providers/cordis.js`。
 *
 * ⚠️ 跳过已在 `src/shared/` 的模块（那些测试本项目已单独移植过）。
 *
 * 用法：
 *   node scripts/port-tests.mjs [--check] [文件...]
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = join(HERE, '..')
const SRC = join(REPO, '..', 'deepseek-harness-codearts', 'tests', 'unit')
const DST = join(REPO, 'tests', 'unit')

/** 已由本项目单独移植（走 src/shared）的测试，不要覆盖。 */
const SKIP = new Set([
  'message-shape.spec.ts',
  'model-queue.spec.ts',
  'sign.spec.ts',
  'refresh.spec.ts',
  'sse.spec.ts',
  'think-tag-split.spec.ts',
  'think-stop-string.spec.ts',
  'strip-bare-think.spec.ts',
  'reasoning-loop.spec.ts',
  'course-leak-strip.spec.ts',
  'prose-loop-guard.spec.ts',
  'blank-reasoning.spec.ts',
  'account-pool.spec.ts',
  'gateway.spec.ts',
  'llm.spec.ts',
  'raccoon.spec.ts',
  'raccoon-product.spec.ts',
  'raccoon-adapter.spec.ts',
  'raccoon-credits.spec.ts',
])

/** 依赖 DSH 服务容器、无法机械移植的测试（需重写或跳过）。 */
const NEEDS_REWRITE = new Set([
  'plugin.spec.ts',
  'jet-hub-rpc.spec.ts',
  'jet-hub-store.spec.ts',
  'backup.spec.ts',
  'buddy-wiring.spec.ts',
  'lobsterai-wiring.spec.ts',
  'loomy-wiring.spec.ts',
  'qoder-wiring.spec.ts',
  'raccoon-wiring.spec.ts',
  'lobsterai-rpc-dispatch.spec.ts',
  'loomy-rpc-dispatch.spec.ts',
  'qoder-credential-refs.spec.ts',
  'raccoon-rpc-dispatch.spec.ts',
  'account-probe-adapter.spec.ts',
  'session-replay.spec.ts',
  'smoke.spec.ts',
])

function rewrite(text) {
  return text
    // 实现位置：来源与本项目同名，但在 src/providers/ 下。
    .replace(/from '\.\.\/\.\.\/src\/([a-z0-9-]+)\.js'/g, "from '../../src/providers/$1.js'")
    // DSH 词汇表。
    .replace(/from '@deepseek-ai\/dsh-llm'/g, "from '../../src/providers/llm.js'")
    .replace(/from '@deepseek-ai\/dsh-credentials'/g, "from '../../src/providers/credential-ref.js'")
    .replace(/from '@deepseek-ai\/cordis'/g, "from '../../src/providers/cordis.js'")
}

/** 找出仍指向 DSH 的导入（必须手工处理）。 */
function remainingDsh(text) {
  return [...new Set([...text.matchAll(/from '(@deepseek-ai\/[^']+)'/g)].map(m => m[1]))]
}

const args = process.argv.slice(2).filter(a => !a.startsWith('--'))
const checkOnly = process.argv.includes('--check')

const candidates = args.length > 0
  ? args
  : readdirSync(SRC)

mkdirSync(DST, { recursive: true })
let ported = 0
const skipped = []
const manual = []

for (const file of candidates) {
  if (SKIP.has(file)) { skipped.push(`${file}（已单独移植）`); continue }
  if (NEEDS_REWRITE.has(file)) { skipped.push(`${file}（依赖 DSH 服务容器）`); continue }
  const from = join(SRC, file)
  if (!existsSync(from)) { manual.push(`${file}: 来源不存在`); continue }
  const rewritten = rewrite(readFileSync(from, 'utf-8'))
  const left = remainingDsh(rewritten)
  if (left.length > 0) { manual.push(`${file}: 仍引用 ${left.join(', ')}`); continue }
  if (!checkOnly) writeFileSync(join(DST, file), rewritten, 'utf-8')
  ported++
}

console.log(`移植测试 ${ported} 个`)
if (skipped.length > 0) console.log(`跳过: ${skipped.join('; ')}`)
if (manual.length > 0) {
  console.log('\n⚠️ 需手工处理：')
  for (const m of manual) console.log(`  ${m}`)
}
