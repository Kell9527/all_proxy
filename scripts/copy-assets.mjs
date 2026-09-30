#!/usr/bin/env node
/**
 * 构建辅助：把非 TS 资产复制到编译产物目录。
 *
 * ## 为什么需要它
 *
 * `tsc` 只搬 `.js`/`.d.ts`，**不会**复制 `.wasm`。而 Qoder 的加密推理依赖
 * `qoder-auth-wasm.wasm`，且 `qoder-wasm.ts` 按 `import.meta.url` **相对自身
 * 目录**解析它 —— 若构建后产物目录里没有该文件，会在**第一次发起 Qoder 请求时**
 * 才失败（`ENOENT`），而不是启动时。
 *
 * 故：构建后必须执行本脚本，且启动时自检（见 `src/index.ts` 的 `assertAssets`）。
 *
 * 用法：
 *   node scripts/copy-assets.mjs
 */
import { copyFileSync, existsSync, mkdirSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = join(HERE, '..')

/** 需要随产物分发的资产：源路径（相对仓库）→ 产物路径（相对 dist）。 */
const ASSETS = [
  ['src/providers/qoder-auth-wasm.wasm', 'providers/qoder-auth-wasm.wasm'],
]

const DIST = join(REPO, 'dist')
let copied = 0

for (const [from, to] of ASSETS) {
  const source = join(REPO, from)
  const target = join(DIST, to)
  if (!existsSync(source)) {
    console.error(`✗ 资产缺失: ${from}`)
    console.error('  Qoder 的加密推理依赖它；没有它时 Qoder 请求会在运行时 ENOENT。')
    process.exit(1)
  }
  mkdirSync(dirname(target), { recursive: true })
  copyFileSync(source, target)
  const size = statSync(target).size
  console.log(`✓ ${from} → dist/${to} (${size} 字节)`)
  copied++
}

console.log(`已复制 ${copied} 个资产到 dist/`)
