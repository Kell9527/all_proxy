import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AccountPool } from '../../src/pool/account-pool.js'
import type { ProviderRegistry } from '../../src/providers/registry.js'
import type { registerAllProviders } from '../../src/providers/wiring.js'

/**
 * wiring 模块的目录缓存是**模块级单例**（进程内快照 + 失败冷却）。
 * 每个用例动态 import 一份全新模块，保证用例间零串味。
 */
type WiringModule = typeof import('../../src/providers/wiring.js')
type PoolModule = typeof import('../../src/pool/account-pool.js')
type StoreModule = typeof import('../../src/pool/store.js')
type RegistryModule = typeof import('../../src/providers/registry.js')

/**
 * 远端目录快照（用户报障「模型列表非常慢」的修复）。
 *
 * 行为契约：
 * 1. **新鲜快照 → 直接返回，不发网络**（无账号也不发）；
 * 2. 快照过期且拉取失败 → 仍用旧快照（有倍率，优于内置兜底表）；
 * 3. 返回的目录仍要过用户黑名单过滤（listModels 的语义不变）。
 */

/** 造一个注册好的 harness；`catalogModels` 预置 buddy 目录快照。 */
async function harness(
  modules: { wiring: WiringModule; poolM: PoolModule; storeM: StoreModule; registryM: RegistryModule },
  options: { fetchedAt?: number; models?: unknown[] } = {},
): Promise<{ dir: string; registry: ProviderRegistry; AccountPool: PoolModule['AccountPool'] }> {
  const dir = mkdtempSync(join(tmpdir(), 'all-proxy-catcache-'))
  const credentials = new modules.storeM.FileCredentialStore(dir)
  const catalogDir = join(dir, 'catalogs')
  if (options.models !== undefined) {
    mkdirSync(catalogDir, { recursive: true })
    writeFileSync(join(catalogDir, 'buddy.json'), JSON.stringify({
      fetchedAt: options.fetchedAt ?? Date.now(),
      models: options.models,
    }))
  }
  const pool = new modules.poolM.AccountPool({ credentials, dataDir: dir })
  const registry = new modules.registryM.ProviderRegistry()
  modules.wiring.registerAllProviders(registry, {
    pool,
    credentials,
    dataDir: dir,
    logger: { info: () => {}, warn: () => {}, error: () => {} },
    // 没有可用账号：目录来源只可能是快照/兜底表（网络路径不会发）。
    resolveCredential: async () => { throw new Error('no credential') },
    refresh: async () => {},
    readImage: async () => { throw new Error('no attachment') },
  })
  return { dir, registry, AccountPool: modules.poolM.AccountPool }
}

describe('远端目录快照', () => {
  let dirs: string[] = []
  let modules: { wiring: WiringModule; poolM: PoolModule; storeM: StoreModule; registryM: RegistryModule }
  const track = (dir: string): void => { dirs.push(dir) }
  beforeEach(async () => {
    dirs = []
    vi.resetModules()
    modules = {
      wiring: await import('../../src/providers/wiring.js'),
      poolM: await import('../../src/pool/account-pool.js'),
      storeM: await import('../../src/pool/store.js'),
      registryM: await import('../../src/providers/registry.js'),
    }
  })
  afterEach(() => {
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
  })

  // ⚠️ 必须用**产品兜底表里真实存在的 id**：adapter 的 reconcileWithFallback
  // 是白名单式重建（以兜底表 id 为准，远端 id 不在表里的会被丢弃），
  // 假 id 会被校正掉，测不出快照效果。creditsRate 只可能来自远端——
  // 这正是「有倍率」的判据。
  const MODELS = [
    { id: 'hy4-preview', name: 'Hy4 preview', creditsRate: 'x0.50' },
    { id: 'glm-5.3', name: 'GLM-5.3', creditsRate: 'x1.25' },
  ]

  it('新鲜快照直接返回，无账号也不发网络、不回退兜底表', async () => {
    const { dir, registry } = await harness(modules, { models: MODELS })
    track(dir)
    const buddy = registry.get('buddy')!
    const listed = await buddy.adapter.listModels('buddy')
    // 快照里的模型（经 reconcile 白名单重建后）出现，且倍率拼进 name。
    const hy4 = listed.find(m => m.id === 'hy4-preview')!
    expect(hy4).toBeDefined()
    expect(hy4.name).toContain('x0.5')
    const glm = listed.find(m => m.id === 'glm-5.3')!
    expect(glm.name).toContain('x1.25')
  })

  it('快照过期且无账号：仍用旧快照（有倍率，优于无倍率兜底表）', async () => {
    const { dir, registry } = await harness(modules, { models: MODELS, fetchedAt: Date.now() - 48 * 3600_000 })
    track(dir)
    const buddy = registry.get('buddy')!
    const listed = await buddy.adapter.listModels('buddy')
    expect(listed.find(m => m.id === 'hy4-preview')?.name).toContain('x0.50')
  })

  it('返回的目录仍过黑名单过滤（listModels 语义不变）', async () => {
    const { dir, registry, AccountPool } = await harness(modules, { models: MODELS })
    track(dir)
    const pool = new AccountPool({ credentials: new modules.storeM.FileCredentialStore(dir), dataDir: dir })
    await pool.setModelsDisabled('buddy', ['hy4-preview'])
    const buddy = registry.get('buddy')!
    const listed = await buddy.adapter.listModels('buddy')
    expect(listed.some(m => m.id === 'hy4-preview')).toBe(false)
    expect(listed.find(m => m.id === 'glm-5.3')).toBeDefined()
  })

  it('没有任何快照时无账号：回退内置兜底表（不抛错、不白屏）', async () => {
    const { dir, registry, AccountPool } = await harness(modules, {})
    track(dir)
    const buddy = registry.get('buddy')!
    const listed = await buddy.adapter.listModels('buddy')
    // 内置兜底表 Buddy 侧有 16 个（无凭据、无网络也能看到）。
    // ⚠️ 允许「同名消歧」后缀（-sg / -f 变体，兜底表合法），
    // 但**不能有倍率**——倍率只可能来自远端快照。
    expect(listed.length).toBeGreaterThan(0)
    const hasRate = listed.some(m => / · (x[\d.]+|[\d.]+→[\d.]+)/.test(m.name))
    expect(hasRate).toBe(false)
  })

  it('listAllModels（显示列表）读快照且不过滤黑名单', async () => {
    const { dir, registry, AccountPool } = await harness(modules, { models: MODELS })
    track(dir)
    const pool = new AccountPool({ credentials: new modules.storeM.FileCredentialStore(dir), dataDir: dir })
    await pool.setModelsDisabled('buddy', ['hy4-preview'])
    const buddy = registry.get('buddy')!
    // 触发一次 listModels 以填充缓存（与 listAllModelsForAdmin 的顺序一致）。
    await buddy.adapter.listModels('buddy')
    const all = (buddy.adapter as unknown as { listAllModels(): readonly { id: string }[] }).listAllModels()
    expect(all.map(m => m.id)).toContain('hy4-preview')
    expect(all.map(m => m.id)).toContain('glm-5.3')
  })
})
