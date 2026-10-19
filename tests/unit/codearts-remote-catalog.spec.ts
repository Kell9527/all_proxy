import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AccountPool } from '../../src/pool/account-pool.js'
import { FileCredentialStore } from '../../src/pool/store.js'
import { ProviderRegistry } from '../../src/providers/registry.js'
import { registerAllProviders } from '../../src/providers/wiring.js'
import { CodeArtsAdapter } from '../../src/providers/llm-adapter.js'
import {
  OPENGW_GATEWAY_CONFIG_URL,
  SNAP_MODEL_BUILTIN_URL,
} from '../../src/providers/models.js'
import type { ProviderAccountEntry } from '../../src/pool/types.js'

/**
 * CodeArts 远端目录接线（用户报障「上游有 glm-5.3，本项目模型列表没有」）。
 *
 * 根因：`wiring.ts` 构造 `CodeArtsAdapter` 时**没有**注入 `fetchRemoteModels`，
 * 适配器只能播报静态兜底表 `DEFAULT_MODELS`；而该表停在 `glm-5.3-flash`
 * 那一代，上游 builtin 端点后来新增的 `glm-5.3` 永远看不到。
 *
 * 本文件锁死两件事：
 * 1. 有账号时真的去拉两个远端端点，并把 `glm-5.3` 播报出来；
 * 2. 无账号时**不抛错**，回退到静态兜底表（规格 provider-routing）。
 *
 * ⚠️ `wiring.ts` 的目录缓存是**模块级**的，故这段断言独立成文件，
 * 避免同文件内其它用例先把 `codearts` 打进失败冷却（10 分钟）。
 */
describe('CodeArts 远端模型目录接线', () => {
  let dir: string
  let pool: AccountPool
  let credentials: FileCredentialStore
  let registry: ProviderRegistry
  const originalCacheDir = process.env.DSH_CODEARTS_CACHE_DIR

  /** 远端目录：gateway/config 给 benefit，builtin 给常规（含 glm-5.3）。 */
  function makeFetcher() {
    return async (input: RequestInfo | URL): Promise<Response> => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      if (url === OPENGW_GATEWAY_CONFIG_URL) {
        return new Response(JSON.stringify({
          result: {
            models: [
              { model_id: 'glm-5.3-flash', model_name: 'GLM-5.3-Flash' },
              { model_id: 'deepseek-v4.1-flash', model_name: 'deepseek-v4.1-flash' },
            ],
          },
        }), { status: 200 })
      }
      if (url === SNAP_MODEL_BUILTIN_URL) {
        return new Response(JSON.stringify({
          count: 3,
          builtinModels: [
            { model_id: 'GLM-5.2', model_name: 'GLM-5.2' },
            // 上游真实下发的 id 就是小写 `glm-5.3`（DSH 侧缓存实证）。
            { model_id: 'glm-5.3', model_name: 'GLM-5.3' },
            { model_id: 'kimi-k2.6-vl', model_name: 'Kimi-K2.6-VL' },
          ],
        }), { status: 200 })
      }
      return new Response('', { status: 404 })
    }
  }

  function makeAccount(overrides: Partial<ProviderAccountEntry> = {}): ProviderAccountEntry {
    return {
      id: 'codearts-001',
      provider: 'codearts',
      nickname: 'codearts-001',
      enabled: true,
      credentialRef: 'CODEARTS_ACCOUNT_T1',
      createdAt: Date.now(),
      expiresAt: Date.now() + 3_600_000,
      refreshable: false,
      ...overrides,
    }
  }

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'all-proxy-codearts-catalog-'))
    // 隔离 benefit 集合的磁盘缓存，避免污染真实用户缓存（~/.cache/deveco）。
    process.env.DSH_CODEARTS_CACHE_DIR = dir
    credentials = new FileCredentialStore(dir)
    pool = new AccountPool({ credentials, dataDir: dir })
    registry = new ProviderRegistry()
    registerAllProviders(registry, {
      pool,
      credentials,
      dataDir: dir,
      logger: { info: () => {}, warn: () => {}, error: () => {} },
      fetcher: makeFetcher() as unknown as typeof fetch,
      resolveCredential: async () => undefined,
      refresh: async () => {},
      readImage: async () => { throw new Error('本项目暂无附件服务') },
    })
  })

  afterEach(() => {
    if (originalCacheDir === undefined) delete process.env.DSH_CODEARTS_CACHE_DIR
    else process.env.DSH_CODEARTS_CACHE_DIR = originalCacheDir
    rmSync(dir, { recursive: true, force: true })
  })

  it('有账号时从两个远端端点取并集，`glm-5.3` 出现在模型列表里', async () => {
    await credentials.set('CODEARTS_ACCOUNT_T1', JSON.stringify({
      access_key_id: 'AKTEST',
      secret_access_key: 'SKTEST',
      security_token: 'STTEST',
      expires_at: '2099-01-01T00:00:00Z',
    }))
    await pool.addAccount(makeAccount())

    const models = await registry.get('codearts')!.adapter.listModels('codearts')
    const ids = models.map((m) => m.id)
    // 上游 builtin 端点新增的模型 —— 静态兜底表里没有，只能靠远端目录。
    expect(ids, '上游有 glm-5.3，列表里就必须有').toContain('glm-5.3')
    // 两个端点取并集：gateway/config 的 benefit 与 builtin 的常规模型都在。
    expect(ids).toContain('glm-5.3-flash')
    expect(ids).toContain('deepseek-v4.1-flash')
    expect(ids).toContain('GLM-5.2')
    // 展示名用上游下发的 model_name，而不是裸 id。
    expect(models.find((m) => m.id === 'glm-5.3')?.name).toBe('GLM-5.3')
  })

  it('远端目录为空时回退静态兜底表且不抛错（规格 provider-routing）', async () => {
    // ⚠️ 这里**刻意**直接构造适配器而不是走 registry：`wiring.ts` 的
    // `fetchRemoteCatalog` 是模块级缓存（TTL 6 小时），上一个用例拉到的
    // 目录会被直接复用，无法表达「本轮远端拿不到」。
    //
    // `fetchRemoteModels` 返回 `[]` 正是无账号时的真实形态
    // （`firstUsableCodeArtsCredential` 拿不到凭据 → 返回空数组），
    // 适配器据此保持 `remoteModels === undefined` 并回退静态表。
    const adapter = new CodeArtsAdapter({
      credentialRef: 'CODEARTS_ACCESS_TOKEN' as never,
      resolveCredential: async () => undefined,
      refresh: async () => {},
      fetchRemoteModels: async () => [],
    })
    const ids = (await adapter.listModels('codearts')).map((m) => m.id)
    expect(ids).toContain('glm-5.3-flash')
    // 静态表确实没有 `glm-5.3` —— 这正是必须接远端目录的原因。
    expect(ids).not.toContain('glm-5.3')
  })
})
