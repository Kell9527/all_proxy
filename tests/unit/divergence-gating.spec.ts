import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))

/**
 * 分叉点回归：**目录门控（`providerCatalogVisible`）必须保持「放行」**。
 *
 * ## 背景
 *
 * 来源插件用「无已登录账号 → `listModels` 返回空数组」让 DSH 的
 * `buildModelCatalog` 隐藏整个 provider 分组。本项目是独立服务，**没有**那个
 * 消费方；可见性由 `GET /v1/models` 与三层模型开关决定，而**硬拦截发生在
 * 网关的 `ModelResolver`**。
 *
 * 因此 `providerCatalogVisible` 在本项目里必须恒返回 `true`（= 不隐藏任何
 * provider）。若有人「顺手」把它实现成真实门控，会出现两个后果：
 *
 * 1. 没有账号的 provider 的模型会从 `/v1/models` 消失 —— 用户看不出是
 *    「没登录」还是「被开关关了」，排查困难；
 * 2. 更糟的是它与**硬拦截**语义重叠，让「模型是否可用」有两个互相矛盾的真源。
 *
 * 本文件把这条约定锁死。
 */
describe('分叉点：目录门控恒放行', () => {
  it('providerCatalogVisible 恒返回 true（不隐藏任何 provider）', async () => {
    const { providerCatalogVisible } = await import('../../src/providers/account-pool.js')
    // 无论传什么（甚至不传），都必须放行。
    expect(await providerCatalogVisible()).toBe(true)
    expect(await providerCatalogVisible(undefined, 'raccoon')).toBe(true)
    expect(await providerCatalogVisible({ hasLoggedInAccount: async () => false }, 'buddy')).toBe(true)
  })

  it('适配器调用门控时会得到「放行」，因此目录不被裁剪', async () => {
    // 适配器**仍然调用** `providerCatalogVisible(...)`（移植时未改它们的实现），
    // 但该函数在本项目里恒返回 true，故调用点等价于「不裁剪目录」。
    // 这里用真实适配器验证这一点，而不是用正则扫源码 —— 后者会把
    // 「调用了恒真函数」误判成「实现了门控」。
    const { BuddyAdapter } = await import('../../src/providers/buddy-adapter.js')
    const { CODEBUDDY } = await import('../../src/providers/product.js')

    const adapter = new BuddyAdapter({
      resolveCredential: async () => undefined,
      refresh: async () => {},
      fetchRemoteModels: async () => [{ id: 'm1', name: 'M1', contextWindow: 1000, maxTokens: 100, supportsImage: false }],
      // ⚠️ 关键：池**没有任何已登录账号**。
      accountPool: {
        disabledModelsFor: () => new Set<string>(),
        hasLoggedInAccount: async () => false,
      } as never,
      product: CODEBUDDY,
    })
    const models = await adapter.listModels('buddy')
    expect(models.length, '无账号时目录仍应完整（门控恒放行）').toBeGreaterThan(0)
  })
})

/**
 * 硬拦截的**唯一真源**是网关的 `ModelResolver`。
 *
 * 这里断言它确实存在且被网关调用 —— 避免「门控删了、硬拦截也没接上」这种
 * 两头落空的状态（那样模型开关就真的形同虚设了）。
 */
describe('分叉点：硬拦截由网关承担', () => {
  it('ModelResolver 会检查三层开关并在关闭时拒绝', async () => {
    const { ModelResolver } = await import('../../src/gateway/model-resolver.js')
    const { AccountPool } = await import('../../src/pool/account-pool.js')
    const { FileCredentialStore } = await import('../../src/pool/store.js')
    const { ProviderRegistry } = await import('../../src/providers/registry.js')
    const { LlmAdapter } = await import('../../src/shared/llm.js')
    const { mkdtempSync, rmSync } = await import('node:fs')
    const { tmpdir } = await import('node:os')

    class StubAdapter extends LlmAdapter {
      async *stream(): AsyncIterable<never> {}
    }

    const dir = mkdtempSync(join(tmpdir(), 'all-proxy-fork-'))
    try {
      const pool = new AccountPool({ credentials: new FileCredentialStore(dir), dataDir: dir })
      const registry = new ProviderRegistry()
      registry.register({
        id: 'p', displayName: 'P', apiBase: 'https://x.invalid', chatPath: '/c',
        authKind: 'bearer', catalogSource: 'static-only', supportsImages: false, rotatesAccounts: false,
      }, new StubAdapter())

      const resolver = new ModelResolver(registry, pool)
      expect(resolver.resolve('p/m').ok).toBe(true)

      await pool.setModelDisabled('p', 'm', true)
      const blocked = resolver.resolve('p/m')
      expect(blocked.ok).toBe(false)
      if (!blocked.ok) expect(blocked.error.code).toBe('model_not_found')

      await pool.setModelDisabled('p', 'm', false)
      await pool.setProviderEnabled('p', false)
      const byProvider = resolver.resolve('p/m')
      expect(byProvider.ok).toBe(false)

      await pool.setProviderEnabled('p', true)
      await pool.setGlobalModelsEnabled(false)
      const byGlobal = resolver.resolve('p/m')
      expect(byGlobal.ok).toBe(false)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('**授权范围与模型开关是两个维度，且判定顺序是「先范围后开关」**', async () => {
    const { ModelResolver } = await import('../../src/gateway/model-resolver.js')
    const { AccountPool } = await import('../../src/pool/account-pool.js')
    const { FileCredentialStore } = await import('../../src/pool/store.js')
    const { ProviderRegistry } = await import('../../src/providers/registry.js')
    const { LlmAdapter } = await import('../../src/shared/llm.js')
    const { mkdtempSync, rmSync } = await import('node:fs')
    const { tmpdir } = await import('node:os')

    class StubAdapter extends LlmAdapter {
      async *stream(): AsyncIterable<never> {}
    }

    const dir = mkdtempSync(join(tmpdir(), 'all-proxy-scope-'))
    try {
      const pool = new AccountPool({ credentials: new FileCredentialStore(dir), dataDir: dir })
      const registry = new ProviderRegistry()
      for (const id of ['p', 'q']) {
        registry.register({
          id, displayName: id, apiBase: 'https://x.invalid', chatPath: '/c',
          authKind: 'bearer', catalogSource: 'static-only', supportsImages: false, rotatesAccounts: false,
        }, new StubAdapter())
      }
      const resolver = new ModelResolver(registry, pool)

      // 无范围 = 不限制。
      expect(resolver.resolve('p/m').ok).toBe(true)

      // provider 范围外的请求被拒，且**错误码是授权而非不存在**。
      const outside = resolver.resolve('p/m', { providers: ['q'] })
      expect(outside.ok).toBe(false)
      if (!outside.ok) {
        expect(outside.error.code).toBe('model_not_authorized')
        expect(outside.error.status).toBe(403)
      }

      // ⚠️ 关键顺序断言：即便该模型**同时**被开关关闭，受限 key 也应先撞上
      // 「无权访问」。反过来（先报 `已被关闭`）会让受限 key 通过错误消息
      // 探测出服务端的开关配置。
      await pool.setModelDisabled('p', 'm', true)
      const both = resolver.resolve('p/m', { providers: ['q'] })
      expect(both.ok).toBe(false)
      if (!both.ok) expect(both.error.code).toBe('model_not_authorized')

      // 而**不限范围**的调用方此时应当看到「已被关闭」。
      const unrestricted = resolver.resolve('p/m')
      expect(unrestricted.ok).toBe(false)
      if (!unrestricted.ok) expect(unrestricted.error.code).toBe('model_not_found')

      // 范围与开关取交集：范围内的调用方 + 已关闭的模型 → 仍被拒。
      const inScope = resolver.resolve('p/m', { providers: ['p'] })
      expect(inScope.ok).toBe(false)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
