import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AccountPool } from '../../src/pool/account-pool.js'
import { FileCredentialStore } from '../../src/pool/store.js'
import { ProviderRegistry } from '../../src/providers/registry.js'
import { listAllModelsForAdmin } from '../../src/gateway/model-resolver.js'
import { LlmAdapter } from '../../src/shared/llm.js'
import type { StreamChunk } from '../../src/shared/llm.js'

/**
 * 管理端模型目录（「显示列表」）。
 *
 * 固化两条关键行为：
 * 1. **含被关闭的模型**（否则用户无法重新开启；来源真实报障「关闭的就没
 *    有显示倍率」—— 显示列表按黑名单过滤后倍率展示名随之丢失）；
 * 2. 走 `listAllModels`（远端缓存优先）而不是 `listModels`（会按黑名单过滤），
 *    且调用顺序是「先 listModels 触发远端拉取、后 listAllModels 读缓存」。
 */

/** 带完整目录能力的替身适配器（模拟 buddy/lobsterai 的行为）。 */
class CatalogAdapter extends LlmAdapter {
  listModelsCalls = 0
  listAllModelsCalls = 0
  /** 远端目录（listModels 成功后缓存，listAllModels 读它）。 */
  remote: readonly { id: string; name: string }[] | undefined
  constructor(
    private readonly pool: AccountPool,
    private readonly failListModels = false,
  ) { super() }
  override async listModels(): Promise<readonly { provider: string; id: string; name: string }[]> {
    this.listModelsCalls += 1
    if (this.failListModels) throw new Error('远端目录不可用')
    // 懒加载远端（真实适配器 ensureRemoteModels 的语义）。
    if (this.remote === undefined) {
      this.remote = [
        { id: 'gro', name: 'Grok-4.7 · x1.90' },
        { id: 'glm', name: 'GLM-5.3 · x0.06' },
        { id: 'auto', name: 'Auto' },
      ]
    }
    const disabled = this.pool.disabledModelsFor('buddy')
    return this.remote.filter(m => !disabled.has(m.id)).map(m => ({ provider: 'buddy', ...m }))
  }
  /** 不受黑名单影响（真实适配器的 listAllModels 语义）。 */
  listAllModels(): readonly { id: string; name: string }[] {
    this.listAllModelsCalls += 1
    return this.remote ?? [{ id: 'legacy', name: 'Legacy' }]
  }
  override async resolveModel(provider: string, model: string): Promise<{ provider: string; id: string; name: string; context?: { contextWindow: number } }> {
    return { provider, id: model, name: model, context: { contextWindow: 128_000 } }
  }
  async *stream(): AsyncIterable<StreamChunk> { yield { type: 'finish', reason: { kind: 'stop' } } }
}

describe('管理端模型目录（显示列表）', () => {
  let dir: string
  let pool: AccountPool
  let registry: ProviderRegistry

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'all-proxy-catalog-'))
    pool = new AccountPool({ credentials: new FileCredentialStore(dir), dataDir: dir })
    registry = new ProviderRegistry()
  })
  afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

  const register = (adapter: CatalogAdapter): void => {
    registry.register({
      id: 'buddy',
      displayName: 'CodeBuddy',
      apiBase: 'https://example.invalid',
      chatPath: '/chat/completions',
      authKind: 'bearer',
      catalogSource: 'remote-first',
      supportsImages: true,
      rotatesAccounts: true,
    }, adapter)
  }

  it('显示列表包含被关闭的模型（disabled 标注，可重新开启）', async () => {
    await pool.setModelsDisabled('buddy', ['glm', 'auto'])
    register(new CatalogAdapter(pool))
    const models = await listAllModelsForAdmin(registry, pool)
    // 全量 3 个都在（listModels 只剩 1 个，但显示列表不过滤）。
    expect(models.map(m => m.model).sort()).toEqual(['auto', 'glm', 'gro'])
    const disabled = models.filter(m => m.disabled)
    expect(disabled).toHaveLength(2)
    expect(disabled.map(m => m.model).sort()).toEqual(['auto', 'glm'])
    // 关闭的模型也带归因与倍率展示名。
    const glm = models.find(m => m.model === 'glm')!
    expect(glm.blockedBy).toBe('model')
    expect(glm.name).toBe('GLM-5.3 · x0.06')
  })

  it('先 listModels（触发远端）后 listAllModels（读缓存）：倍率来自远端', async () => {
    const adapter = new CatalogAdapter(pool)
    register(adapter)
    const models = await listAllModelsForAdmin(registry, pool)
    expect(adapter.listModelsCalls).toBe(1)
    expect(adapter.listAllModelsCalls).toBe(1)
    // 远端目录的倍率名全部出现在显示列表（兜底名 'Legacy' 被远端顶替）。
    expect(models.map(m => m.name)).toContain('Grok-4.7 · x1.90')
    expect(models.map(m => m.name)).not.toContain('Legacy')
  })

  it('单个 provider 目录失败不阻断其它 provider 的列表', async () => {
    register(new CatalogAdapter(pool, true))
    registry.register({
      id: 'qoder', displayName: 'Qoder', apiBase: 'https://example.invalid',
      chatPath: '/chat/completions', authKind: 'bearer', catalogSource: 'static-only',
      supportsImages: true, rotatesAccounts: true,
    }, new CatalogAdapter(pool))
    const models = await listAllModelsForAdmin(registry, pool)
    // buddy 走兜底目录（'Legacy'），qoder 正常列出。
    const legacies = models.filter(m => m.name === 'Legacy')
    expect(legacies.length).toBeGreaterThan(0)
    expect(models.some(m => m.provider === 'qoder')).toBe(true)
  })
})
