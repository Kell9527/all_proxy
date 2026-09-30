#!/usr/bin/env node
/**
 * 真机验证：从**真实 DSH 数据**导入账号与模型开关。
 *
 * ⚠️ **只读 DSH**：本脚本绝不写回 `~/.dsh`。它把导入结果写到临时目录，
 * 打印摘要后即可丢弃。
 *
 * 用法：
 *   node scripts/verify-dsh-import.mjs
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AccountPool } from '../dist/pool/account-pool.js'
import { FileCredentialStore } from '../dist/pool/store.js'
import { importFromDsh, resolveDshPaths } from '../dist/pool/dsh-import.js'

const paths = resolveDshPaths()
console.log(`DSH home: ${paths.home}`)
console.log(`凭据文件: ${paths.credentials}`)
console.log(`状态文件: ${paths.state}\n`)

// 导入到临时目录：不碰 all_proxy 的真实 data/。
const dir = mkdtempSync(join(tmpdir(), 'all-proxy-import-verify-'))
try {
  const credentials = new FileCredentialStore(dir)
  const pool = new AccountPool({ credentials, dataDir: dir })

  const result = await importFromDsh({ pool, credentials, paths, backupDir: join(dir, 'backups') })

  console.log('=== 导入结果 ===')
  console.log(`新增账号: ${result.added}`)
  console.log(`更新账号: ${result.updated}`)
  console.log(`导入凭据: ${result.credentials}`)
  console.log(`导入模型开关的 provider 数: ${result.disabledModelProviders}`)
  console.log(`备份: ${result.backupPath ?? '(无)'}`)

  const accounts = await pool.listAllAccounts()
  console.log(`\n=== 账号清单（${accounts.length} 个）===`)
  const byProvider = new Map()
  for (const account of accounts) {
    if (!byProvider.has(account.provider)) byProvider.set(account.provider, [])
    byProvider.get(account.provider).push(account)
  }
  for (const [provider, list] of [...byProvider.entries()].sort()) {
    console.log(`  ${provider.padEnd(12)} ${list.length} 个  ${list.map(a => a.nickname).join(', ')}`)
  }

  console.log('\n=== 模型开关（被关闭的模型数）===')
  const providers = [...new Set(accounts.map(a => a.provider))]
  for (const provider of providers.sort()) {
    const disabled = pool.disabledModelsFor(provider)
    if (disabled.size > 0) console.log(`  ${provider.padEnd(12)} ${disabled.size} 个`)
  }

  if (result.warnings.length > 0) {
    console.log('\n=== 警告 ===')
    for (const warning of result.warnings) console.log(`  ⚠️ ${warning}`)
  }
  if (result.skipped.length > 0) {
    console.log(`\n=== 跳过 ${result.skipped.length} 项（前 5）===`)
    for (const item of result.skipped.slice(0, 5)) console.log(`  ${item}`)
  }

  // 交叉验证：DSH 状态文件里的账号数应与导入数一致。
  const { readFileSync, existsSync } = await import('node:fs')
  if (existsSync(paths.state)) {
    const state = JSON.parse(readFileSync(paths.state, 'utf-8'))
    const dshCount = Array.isArray(state.accounts) ? state.accounts.length : 0
    console.log(`\n=== 交叉验证 ===`)
    console.log(`DSH state.json 里的账号数: ${dshCount}`)
    console.log(`all_proxy 导入后的账号数: ${accounts.length}`)
    console.log(dshCount === accounts.length
      ? '✅ 一致'
      : `⚠️ 不一致（差 ${Math.abs(dshCount - accounts.length)}）—— 检查是否有 ref 未被识别`)
  }

  console.log('\n✅ 真机导入验证完成（DSH 数据未被修改）')
} finally {
  rmSync(dir, { recursive: true, force: true })
}
