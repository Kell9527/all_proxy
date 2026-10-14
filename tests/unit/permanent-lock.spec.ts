import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AccountPool } from '../../src/pool/account-pool.js'
import { FileCredentialStore } from '../../src/pool/store.js'

/**
 * 「锁定永久积分」**按 provider 泛化**的回归测试。
 *
 * 背景：此前只有 Loomy 一个布尔（`loomyPermanentLocked`），OfficeAce 接入
 * 后两个渠道会互相覆盖（锁 Loomy 把 OfficeAce 也锁上 / 反之）。
 * 泛化成 `permanentLocks: Record<provider, boolean>`，老字段降级为兼容镜像。
 */
describe('permanentLocks：按 provider', () => {
  let dir: string
  let credentials: FileCredentialStore
  let pool: AccountPool

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'all-proxy-permanent-lock-'))
    credentials = new FileCredentialStore(dir)
    pool = new AccountPool({ credentials, dataDir: dir })
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('Loomy 与 OfficeAce 各自独立（互不覆盖）', async () => {
    await pool.setPermanentLocked('loomy', true)
    await pool.setPermanentLocked('officeace', true)
    expect(pool.permanentLocked('loomy')).toBe(true)
    expect(pool.permanentLocked('officeace')).toBe(true)

    // 只解 Loomy：OfficeAce 必须保持锁定
    await pool.setPermanentLocked('loomy', false)
    expect(pool.permanentLocked('loomy')).toBe(false)
    expect(pool.permanentLocked('officeace')).toBe(true)
  })

  it('解锁删键（表里只留已锁定的 provider，不随反复切换累积死条目）', async () => {
    await pool.setPermanentLocked('loomy', true)
    await pool.setPermanentLocked('loomy', false)
    const state = JSON.parse(readFileSync(join(dir, 'state.json'), 'utf8')) as Record<string, unknown>
    expect(state['permanentLocks']).toEqual({})
    expect(state['loomyPermanentLocked']).toBe(false)
  })

  it('锁持久化到 state.json 且重新载入后仍在', async () => {
    await pool.setPermanentLocked('officeace', true)
    const reloaded = new AccountPool({ credentials, dataDir: dir })
    expect(reloaded.permanentLocked('officeace')).toBe(true)
    expect(reloaded.permanentLocked('loomy')).toBe(false)
  })

  it('老文档（只有 loomyPermanentLocked 布尔）载入时迁移到 per-provider 表', () => {
    writeFileSync(join(dir, 'state.json'), JSON.stringify({
      accounts: [],
      disabledModels: {},
      loomyPermanentLocked: true,
    }))
    const migrated = new AccountPool({ credentials, dataDir: dir })
    expect(migrated.permanentLocked('loomy')).toBe(true)
    // 迁移后写回一次，文档里就有新字段（老布尔同步为 true 的镜像）
    expect(migrated.loomyPermanentLocked()).toBe(true)
  })

  it('loomy 兼容方法与通用方法等价', async () => {
    await pool.setLoomyPermanentLocked(true)
    expect(pool.loomyPermanentLocked()).toBe(true)
    expect(pool.permanentLocked('loomy')).toBe(true)
  })

  it('备份快照同时带 permanentLocks 与 loomyPermanentLocked 镜像', async () => {
    await pool.setPermanentLocked('officeace', true)
    const snapshot = pool.getStateSnapshot()
    expect(snapshot.permanentLocks).toEqual({ officeace: true })
    expect(snapshot.loomyPermanentLocked).toBe(false)
  })

  it('旧版备份（只有 loomyPermanentLocked）导入后落到对应 provider', async () => {
    await pool.replaceAll({
      accounts: [],
      disabledModels: {},
      globalModelsEnabled: true,
      disabledProviders: {},
      loomyPermanentLocked: true,
    })
    expect(pool.permanentLocked('loomy')).toBe(true)
    expect(pool.permanentLocked('officeace')).toBe(false)
  })
})
