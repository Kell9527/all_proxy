import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AccountPool } from '../../src/pool/account-pool.js'
import { FileCredentialStore, writeFileAtomic, readJsonFile } from '../../src/pool/store.js'
import { sanitizeAccounts, sanitizeDisabledModels, sanitizeDisabledProviders } from '../../src/pool/state-store.js'
import type { ProviderAccountEntry } from '../../src/pool/types.js'

/** 每次返回新对象，避免测试间共享引用污染。 */
function makeAccount(overrides: Partial<ProviderAccountEntry> = {}): ProviderAccountEntry {
  return {
    id: 'buddy-001',
    provider: 'buddy',
    nickname: 'test-user',
    enabled: true,
    credentialRef: 'BUDDY_ACCOUNT_T1',
    createdAt: Date.now(),
    expiresAt: Date.now() + 3_600_000,
    refreshable: true,
    ...overrides,
  }
}

describe('AccountPool', () => {
  let dir: string
  let credentials: FileCredentialStore
  let pool: AccountPool

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'all-proxy-pool-'))
    credentials = new FileCredentialStore(dir)
    pool = new AccountPool({ credentials, dataDir: dir })
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  /** 写入一份可用凭据。 */
  async function seedCredential(ref: string, value: Record<string, unknown> = { access_token: 'tok' }): Promise<void> {
    await credentials.set(ref, JSON.stringify(value))
  }

  it('should add and list accounts', async () => {
    await pool.addAccount(makeAccount())
    const list = await pool.listAccounts('buddy')
    expect(list).toHaveLength(1)
    expect(list[0]!.id).toBe('buddy-001')
  })

  it('should filter by provider', async () => {
    await pool.addAccount(makeAccount())
    await pool.addAccount(makeAccount({ id: 'codearts-001', provider: 'codearts', credentialRef: 'CODEARTS_ACCOUNT_T1' }))
    expect(await pool.listAccounts('buddy')).toHaveLength(1)
    expect(await pool.listAccounts('codearts')).toHaveLength(1)
  })

  it('should update account', async () => {
    await pool.addAccount(makeAccount())
    await pool.updateAccount('buddy-001', { nickname: 'renamed', enabled: false })
    const entry = pool.findAccount('buddy-001')
    expect(entry?.nickname).toBe('renamed')
    expect(entry?.enabled).toBe(false)
  })

  it('should throw on update for non-existent account', async () => {
    await expect(pool.updateAccount('nope', { nickname: 'x' })).rejects.toThrow(/not found/)
  })

  it('should remove account and credential', async () => {
    await pool.addAccount(makeAccount())
    await seedCredential('BUDDY_ACCOUNT_T1')
    await pool.removeAccount('buddy-001')
    expect(pool.findAccount('buddy-001')).toBeUndefined()
    // ⚠️ 凭据必须被连带清理，不留孤立凭据。
    expect(await credentials.resolve('BUDDY_ACCOUNT_T1')).toBeUndefined()
  })

  it('should handle removeAccount of non-existent account gracefully', async () => {
    await expect(pool.removeAccount('nope')).resolves.toBeUndefined()
  })

  describe('getAvailableAccount', () => {
    it('returns the first enabled account with resolvable credential', async () => {
      await pool.addAccount(makeAccount({ id: 'a', credentialRef: 'REF_A' }))
      await seedCredential('REF_A', { access_token: 'tok-a' })
      const picked = await pool.getAvailableAccount('buddy', 'glm-5.2')
      expect(picked?.entry.id).toBe('a')
      expect(picked?.credential['access_token']).toBe('tok-a')
    })

    it('returns null when no accounts at all', async () => {
      expect(await pool.getAvailableAccount('buddy', 'glm-5.2')).toBeNull()
    })

    it('skips accounts whose credential is missing', async () => {
      await pool.addAccount(makeAccount({ id: 'a', credentialRef: 'REF_A' }))
      await pool.addAccount(makeAccount({ id: 'b', credentialRef: 'REF_B' }))
      await seedCredential('REF_B', { access_token: 'tok-b' })
      const picked = await pool.getAvailableAccount('buddy', 'glm-5.2')
      expect(picked?.entry.id).toBe('b')
    })

    it('skips accounts whose credential JSON is corrupt', async () => {
      await pool.addAccount(makeAccount({ id: 'a', credentialRef: 'REF_A' }))
      await pool.addAccount(makeAccount({ id: 'b', credentialRef: 'REF_B' }))
      await credentials.set('REF_A', '{not json')
      await seedCredential('REF_B', { access_token: 'tok-b' })
      const picked = await pool.getAvailableAccount('buddy', 'glm-5.2')
      expect(picked?.entry.id).toBe('b')
    })

    it('returns null when all credentials are unusable', async () => {
      await pool.addAccount(makeAccount({ id: 'a', credentialRef: 'REF_A' }))
      expect(await pool.getAvailableAccount('buddy', 'glm-5.2')).toBeNull()
    })

    it('excludes accounts in excludeAccountIds (request-level rotation)', async () => {
      await pool.addAccount(makeAccount({ id: 'a', credentialRef: 'REF_A' }))
      await pool.addAccount(makeAccount({ id: 'b', credentialRef: 'REF_B' }))
      await seedCredential('REF_A')
      await seedCredential('REF_B')
      const picked = await pool.getAvailableAccount('buddy', 'glm-5.2', new Set(['a']))
      expect(picked?.entry.id).toBe('b')
    })

    it('returns null when all accounts rate-limited for that model', async () => {
      await pool.addAccount(makeAccount({ id: 'a', credentialRef: 'REF_A' }))
      await seedCredential('REF_A')
      await pool.updateModelRateLimit('a', 'glm-5.2', Date.now() + 60_000)
      expect(await pool.getAvailableAccount('buddy', 'glm-5.2')).toBeNull()
    })

    it('ignores rate limits that already expired', async () => {
      await pool.addAccount(makeAccount({ id: 'a', credentialRef: 'REF_A' }))
      await seedCredential('REF_A')
      await pool.updateModelRateLimit('a', 'glm-5.2', Date.now() - 1)
      expect((await pool.getAvailableAccount('buddy', 'glm-5.2'))?.entry.id).toBe('a')
    })

    it('rate limit is per-model: other models stay available', async () => {
      await pool.addAccount(makeAccount({ id: 'a', credentialRef: 'REF_A' }))
      await seedCredential('REF_A')
      await pool.updateModelRateLimit('a', 'glm-5.2', Date.now() + 60_000)
      expect((await pool.getAvailableAccount('buddy', 'other-model'))?.entry.id).toBe('a')
    })

    it('empty modelId skips rate-limit filtering but still respects enabled', async () => {
      await pool.addAccount(makeAccount({ id: 'a', credentialRef: 'REF_A' }))
      await seedCredential('REF_A')
      await pool.updateModelRateLimit('a', 'glm-5.2', Date.now() + 60_000)
      expect((await pool.getAvailableAccount('buddy', ''))?.entry.id).toBe('a')
    })
  })

  describe('停用账号不参与自动选择', () => {
    it('modelId 为空串时也不返回停用账号', async () => {
      await pool.addAccount(makeAccount({ id: 'a', enabled: false, credentialRef: 'REF_A' }))
      await seedCredential('REF_A')
      expect(await pool.getAvailableAccount('buddy', '')).toBeNull()
    })

    it('仅剩停用账号时返回 null', async () => {
      await pool.addAccount(makeAccount({ id: 'a', enabled: false, credentialRef: 'REF_A' }))
      await seedCredential('REF_A')
      expect(await pool.getAvailableAccount('buddy', 'glm-5.2')).toBeNull()
    })

    it('跳过停用账号，选用后面的启用账号', async () => {
      await pool.addAccount(makeAccount({ id: 'a', enabled: false, credentialRef: 'REF_A' }))
      await pool.addAccount(makeAccount({ id: 'b', credentialRef: 'REF_B' }))
      await seedCredential('REF_A')
      await seedCredential('REF_B')
      expect((await pool.getAvailableAccount('buddy', 'glm-5.2'))?.entry.id).toBe('b')
    })
  })

  describe('reorderAccounts', () => {
    /** 建三个账号，凭据都可用。 */
    async function seedThree(): Promise<void> {
      for (const id of ['a', 'b', 'c']) {
        await pool.addAccount(makeAccount({ id, credentialRef: `REF_${id.toUpperCase()}` }))
        await seedCredential(`REF_${id.toUpperCase()}`)
      }
    }

    it('重排后 listAccounts 顺序随之改变', async () => {
      await seedThree()
      await pool.reorderAccounts('buddy', ['c', 'a', 'b'])
      expect((await pool.listAccounts('buddy')).map(a => a.id)).toEqual(['c', 'a', 'b'])
    })

    it('重排真正影响 getAvailableAccount 的选号结果', async () => {
      await seedThree()
      await pool.reorderAccounts('buddy', ['c', 'a', 'b'])
      expect((await pool.getAvailableAccount('buddy', 'glm-5.2'))?.entry.id).toBe('c')
    })

    it('手动顺序优先于「限流重置时间更早」的账号', async () => {
      // ⚠️ 回归用例：来源早期实现按「重置时间最早到期」重排候选，
      // 会让用户的手动拖拽形同虚设。这里锁定「手动顺序优先」。
      await seedThree()
      await pool.reorderAccounts('buddy', ['c', 'a', 'b'])
      // a 的限流更早到期，但 c 排在首位 → 仍应选 c。
      await pool.updateModelRateLimit('a', 'glm-5.2', Date.now() + 1000)
      await pool.updateModelRateLimit('c', 'glm-5.2', Date.now() + 500_000)
      // c 在限流期内会被跳过，故先只标记 a。
      await pool.clearModelRateLimits('c', ['glm-5.2'])
      expect((await pool.getAvailableAccount('buddy', 'glm-5.2'))?.entry.id).toBe('c')
    })

    it('限流期内的账号被跳过，即使它排在最前（限流豁免）', async () => {
      await seedThree()
      await pool.reorderAccounts('buddy', ['c', 'a', 'b'])
      await pool.updateModelRateLimit('c', 'glm-5.2', Date.now() + 60_000)
      expect((await pool.getAvailableAccount('buddy', 'glm-5.2'))?.entry.id).toBe('a')
    })

    it('不影响其他 provider 账号的相对位置与下标', async () => {
      await pool.addAccount(makeAccount({ id: 'x', provider: 'codearts', credentialRef: 'REF_X' }))
      await seedThree()
      await pool.addAccount(makeAccount({ id: 'y', provider: 'codearts', credentialRef: 'REF_Y' }))
      await pool.reorderAccounts('buddy', ['c', 'b', 'a'])
      const all = await pool.listAllAccounts()
      // codearts 的账号仍处在原来的下标（0 与 4），相对顺序不变。
      expect(all[0]!.id).toBe('x')
      expect(all[4]!.id).toBe('y')
      expect(all.filter(a => a.provider === 'buddy').map(a => a.id)).toEqual(['c', 'b', 'a'])
    })

    it('id 集合不一致时抛错且不改动数据（前端列表过期）', async () => {
      await seedThree()
      await expect(pool.reorderAccounts('buddy', ['a', 'b'])).rejects.toThrow(/账号列表已变化/)
      expect((await pool.listAccounts('buddy')).map(a => a.id)).toEqual(['a', 'b', 'c'])
    })

    it('包含未知 id 时抛错', async () => {
      await seedThree()
      await expect(pool.reorderAccounts('buddy', ['a', 'b', 'zzz'])).rejects.toThrow(/账号列表已变化/)
    })

    it('含重复 id 时抛错', async () => {
      await seedThree()
      await expect(pool.reorderAccounts('buddy', ['a', 'a', 'b'])).rejects.toThrow(/账号列表已变化/)
    })

    it('重排只写账号字段，不抹掉模型黑名单', async () => {
      await seedThree()
      await pool.setModelDisabled('buddy', 'glm-5.2', true)
      await pool.reorderAccounts('buddy', ['c', 'b', 'a'])
      expect([...pool.disabledModelsFor('buddy')]).toEqual(['glm-5.2'])
    })
  })

  describe('clearModelRateLimits', () => {
    it('清空后删除 modelRateLimits 字段本身，不留空对象', async () => {
      await pool.addAccount(makeAccount())
      await pool.updateModelRateLimit('buddy-001', 'glm-5.2', Date.now() + 1000)
      expect(await pool.clearModelRateLimits('buddy-001')).toBe(1)
      expect(pool.findAccount('buddy-001')?.modelRateLimits).toBeUndefined()
    })

    it('只清除指定的模型，其余保留', async () => {
      await pool.addAccount(makeAccount())
      await pool.updateModelRateLimit('buddy-001', 'm1', Date.now() + 1000)
      await pool.updateModelRateLimit('buddy-001', 'm2', Date.now() + 1000)
      expect(await pool.clearModelRateLimits('buddy-001', ['m1'])).toBe(1)
      expect(pool.findAccount('buddy-001')?.modelRateLimits).toEqual({ m2: expect.any(Number) })
    })

    it('对无标记的账号返回 0', async () => {
      await pool.addAccount(makeAccount())
      expect(await pool.clearModelRateLimits('buddy-001')).toBe(0)
    })

    it('对不存在的账号返回 0', async () => {
      expect(await pool.clearModelRateLimits('nope')).toBe(0)
    })
  })

  describe('sweepExpiredRateLimits', () => {
    it('清理已过期的标记，保留未过期的', async () => {
      await pool.addAccount(makeAccount())
      await pool.updateModelRateLimit('buddy-001', 'expired', Date.now() - 1)
      await pool.updateModelRateLimit('buddy-001', 'active', Date.now() + 60_000)
      await pool.sweepExpiredRateLimits()
      expect(pool.findAccount('buddy-001')?.modelRateLimits).toEqual({ active: expect.any(Number) })
    })
  })

  describe('resolveCredentialForAccount（含停用账号）', () => {
    it('停用账号凭据仍可按 id 解析（重测需要）', async () => {
      await pool.addAccount(makeAccount({ enabled: false }))
      await seedCredential('BUDDY_ACCOUNT_T1', { access_token: 'still-there' })
      const cred = await pool.resolveCredentialForAccount('buddy-001')
      expect(cred?.['access_token']).toBe('still-there')
    })

    it('账号不存在或凭据不可用时返回 undefined', async () => {
      expect(await pool.resolveCredentialForAccount('nope')).toBeUndefined()
      await pool.addAccount(makeAccount())
      expect(await pool.resolveCredentialForAccount('buddy-001')).toBeUndefined()
    })

    it('listAccountsByProvider 含停用账号', async () => {
      await pool.addAccount(makeAccount({ id: 'a', enabled: false, credentialRef: 'REF_A' }))
      await pool.addAccount(makeAccount({ id: 'b', credentialRef: 'REF_B' }))
      expect(pool.listAccountsByProvider('buddy').map(a => a.id)).toEqual(['a', 'b'])
    })
  })

  describe('findAccountIdByCredential 的 provider 字段选择', () => {
    it('workbuddy 按 access_token 匹配', async () => {
      await pool.addAccount(makeAccount({ id: 'w1', provider: 'workbuddy', credentialRef: 'REF_W' }))
      await seedCredential('REF_W', { access_token: 'tok-w', access_key_id: 'ak-w' })
      expect(await pool.findAccountIdByCredential('workbuddy', 'tok-w')).toBe('w1')
    })

    it('workbuddy 不会误用 access_key_id 匹配', async () => {
      await pool.addAccount(makeAccount({ id: 'w1', provider: 'workbuddy', credentialRef: 'REF_W' }))
      await seedCredential('REF_W', { access_token: 'tok-w', access_key_id: 'ak-w' })
      expect(await pool.findAccountIdByCredential('workbuddy', 'ak-w')).toBe('')
    })

    it('codearts 按 access_key_id 匹配（既有行为不回归）', async () => {
      await pool.addAccount(makeAccount({ id: 'c1', provider: 'codearts', credentialRef: 'REF_C' }))
      await seedCredential('REF_C', { access_token: 'tok-c', access_key_id: 'ak-c' })
      expect(await pool.findAccountIdByCredential('codearts', 'ak-c')).toBe('c1')
    })

    it('空 identity 直接返回空串（不做无谓遍历）', async () => {
      expect(await pool.findAccountIdByCredential('buddy', '')).toBe('')
    })
  })

  describe('AccountPool 模型黑名单', () => {
    it('未配置时没有任何模型被关闭（默认全开）', () => {
      expect([...pool.disabledModelsFor('buddy')]).toEqual([])
    })

    it('关闭模型后该模型进入黑名单，其余模型不受影响', async () => {
      await pool.setModelDisabled('buddy', 'glm-5.2', true)
      expect([...pool.disabledModelsFor('buddy')]).toEqual(['glm-5.2'])
      expect(pool.disabledModelsFor('buddy').has('other')).toBe(false)
    })

    it('重新打开时删除条目，而不是写入 false', async () => {
      await pool.setModelDisabled('buddy', 'glm-5.2', true)
      await pool.setModelDisabled('buddy', 'glm-5.2', false)
      expect(pool.disabledModelsFor('buddy').size).toBe(0)
      // 文档里不应留下 `{ buddy: {} }` 噪音。
      expect(pool.listDisabledModels('buddy')).toEqual({})
    })

    it('不同 provider 的黑名单互不影响', async () => {
      await pool.setModelDisabled('buddy', 'glm-5.2', true)
      expect(pool.disabledModelsFor('trae').size).toBe(0)
    })

    it('关闭多个模型后全部保留', async () => {
      await pool.setModelDisabled('buddy', 'm1', true)
      await pool.setModelDisabled('buddy', 'm2', true)
      expect([...pool.disabledModelsFor('buddy')].sort()).toEqual(['m1', 'm2'])
    })
  })

  describe('批量开关（打开全部 / 关闭全部）', () => {
    it('关闭全部：把给定 id 全部写入黑名单', async () => {
      await pool.setModelsDisabled('buddy', ['m1', 'm2', 'm3'])
      expect([...pool.disabledModelsFor('buddy')].sort()).toEqual(['m1', 'm2', 'm3'])
    })

    it('关闭全部保留该 provider 原有的其它关闭项', async () => {
      await pool.setModelDisabled('buddy', 'earlier', true)
      await pool.setModelsDisabled('buddy', ['m1'])
      expect([...pool.disabledModelsFor('buddy')].sort()).toEqual(['earlier', 'm1'])
    })

    it('打开全部：清空该 provider 的全部关闭项', async () => {
      await pool.setModelsDisabled('buddy', ['m1', 'm2'])
      await pool.clearDisabledModels('buddy')
      expect(pool.disabledModelsFor('buddy').size).toBe(0)
    })

    it('打开全部：清掉不在当前目录里的历史遗留键', async () => {
      // ⚠️ 「曾被关闭、后来从服务端目录下线」的键必须能被清掉，
      // 否则黑名单会积累死键、将来被同名模型复用时莫名隐藏它。
      await pool.setModelDisabled('buddy', 'retired-model', true)
      await pool.clearDisabledModels('buddy')
      expect(pool.listDisabledModels('buddy')).toEqual({})
    })

    it('打开全部后 provider 表整体消失（不留 { buddy: {} } 噪音）', async () => {
      await pool.setModelsDisabled('buddy', ['m1'])
      await pool.clearDisabledModels('buddy')
      expect(Object.keys(pool.getStateSnapshot().disabledModels)).not.toContain('buddy')
    })

    it('批量操作不影响其它 provider 的黑名单', async () => {
      await pool.setModelDisabled('trae', 'keep-me', true)
      await pool.setModelsDisabled('buddy', ['m1'])
      await pool.clearDisabledModels('buddy')
      expect([...pool.disabledModelsFor('trae')]).toEqual(['keep-me'])
    })

    it('批量写黑名单不会抹掉账号列表（整体写入语义）', async () => {
      await pool.addAccount(makeAccount())
      await pool.setModelsDisabled('buddy', ['m1'])
      expect(pool.findAccount('buddy-001')).toBeDefined()
    })

    it('关闭全部传空列表时不写盘', async () => {
      const before = existsSync(join(dir, 'state.json'))
      await pool.setModelsDisabled('buddy', [])
      expect(existsSync(join(dir, 'state.json'))).toBe(before)
    })

    it('打开全部在本就为空时不写盘', async () => {
      const before = existsSync(join(dir, 'state.json'))
      await pool.clearDisabledModels('buddy')
      expect(existsSync(join(dir, 'state.json'))).toBe(before)
    })

    it('从已有配置载入黑名单', async () => {
      await pool.setModelDisabled('buddy', 'm1', true)
      const reloaded = new AccountPool({ credentials, dataDir: dir })
      expect([...reloaded.disabledModelsFor('buddy')]).toEqual(['m1'])
    })

    it('写账号列表时不会抹掉已有的黑名单', async () => {
      await pool.setModelDisabled('buddy', 'm1', true)
      await pool.addAccount(makeAccount())
      expect([...pool.disabledModelsFor('buddy')]).toEqual(['m1'])
    })

    it('写黑名单时不会抹掉账号列表', async () => {
      await pool.addAccount(makeAccount())
      await pool.setModelDisabled('buddy', 'm1', true)
      expect(pool.findAccount('buddy-001')).toBeDefined()
    })
  })

  describe('三层开关判定', () => {
    it('全开时模型可用', async () => {
      expect(pool.modelAvailability('buddy', 'm1')).toEqual({ allowed: true })
    })

    it('全局关闭时归因 global', async () => {
      await pool.setGlobalModelsEnabled(false)
      expect(pool.modelAvailability('buddy', 'm1')).toEqual({ allowed: false, blockedBy: 'global' })
    })

    it('provider 关闭时归因 provider', async () => {
      await pool.setProviderEnabled('buddy', false)
      expect(pool.modelAvailability('buddy', 'm1')).toEqual({ allowed: false, blockedBy: 'provider' })
    })

    it('单模型关闭时归因 model', async () => {
      await pool.setModelDisabled('buddy', 'm1', true)
      expect(pool.modelAvailability('buddy', 'm1')).toEqual({ allowed: false, blockedBy: 'model' })
      expect(pool.modelAvailability('buddy', 'm2')).toEqual({ allowed: true })
    })

    it('provider 级开关不影响模型黑名单表（两者分开存储）', async () => {
      await pool.setProviderEnabled('buddy', false)
      // 关键：关闭 provider 不应在模型黑名单里留下哨兵条目。
      expect(pool.listDisabledModels('buddy')).toEqual({})
    })

    it('全局开关优先于 provider 与单模型', async () => {
      await pool.setProviderEnabled('buddy', false)
      await pool.setModelDisabled('buddy', 'm1', true)
      await pool.setGlobalModelsEnabled(false)
      expect(pool.modelAvailability('buddy', 'm1').blockedBy).toBe('global')
    })

    it('打开全部会同时解除 provider 级关闭', async () => {
      await pool.setProviderEnabled('buddy', false)
      await pool.clearDisabledModels('buddy')
      expect(pool.providerEnabled('buddy')).toBe(true)
    })
  })

  describe('Loomy 永久积分锁定', () => {
    it('默认解锁（未设置时为 false）', () => {
      expect(pool.loomyPermanentLocked()).toBe(false)
    })

    it('设置后可读回', async () => {
      await pool.setLoomyPermanentLocked(true)
      expect(pool.loomyPermanentLocked()).toBe(true)
    })

    it('可再解锁', async () => {
      await pool.setLoomyPermanentLocked(true)
      await pool.setLoomyPermanentLocked(false)
      expect(pool.loomyPermanentLocked()).toBe(false)
    })

    it('新增账号不会抹掉锁定', async () => {
      await pool.setLoomyPermanentLocked(true)
      await pool.addAccount(makeAccount())
      expect(pool.loomyPermanentLocked()).toBe(true)
    })

    it('写黑名单不会抹掉锁定', async () => {
      await pool.setLoomyPermanentLocked(true)
      await pool.setModelDisabled('buddy', 'm1', true)
      expect(pool.loomyPermanentLocked()).toBe(true)
    })

    it('写锁定不会抹掉账号列表与黑名单', async () => {
      await pool.addAccount(makeAccount())
      await pool.setModelDisabled('buddy', 'm1', true)
      await pool.setLoomyPermanentLocked(true)
      expect(pool.findAccount('buddy-001')).toBeDefined()
      expect([...pool.disabledModelsFor('buddy')]).toEqual(['m1'])
    })
  })

  describe('跨实例持久化（模拟重启）', () => {
    it('账号列表与黑名单跨实例存活', async () => {
      await pool.addAccount(makeAccount())
      await pool.setModelDisabled('buddy', 'm1', true)
      const reloaded = new AccountPool({ credentials, dataDir: dir })
      expect(reloaded.findAccount('buddy-001')).toBeDefined()
      expect([...reloaded.disabledModelsFor('buddy')]).toEqual(['m1'])
    })

    it('限流标记跨实例存活', async () => {
      await pool.addAccount(makeAccount())
      await pool.updateModelRateLimit('buddy-001', 'm1', Date.now() + 60_000)
      const reloaded = new AccountPool({ credentials, dataDir: dir })
      expect(reloaded.findAccount('buddy-001')?.modelRateLimits?.['m1']).toBeGreaterThan(Date.now())
    })

    it('顺序跨实例存活', async () => {
      for (const id of ['a', 'b', 'c']) {
        await pool.addAccount(makeAccount({ id, credentialRef: `REF_${id.toUpperCase()}` }))
      }
      await pool.reorderAccounts('buddy', ['c', 'b', 'a'])
      const reloaded = new AccountPool({ credentials, dataDir: dir })
      expect(reloaded.listAccountsByProvider('buddy').map(a => a.id)).toEqual(['c', 'b', 'a'])
    })

    it('配置文件里的脏数据被忽略而不是抛错', () => {
      writeFileSync(join(dir, 'state.json'), JSON.stringify({
        accounts: [{ id: 'ok', provider: 'buddy', credentialRef: 'REF', junk: 1 }, 'not-an-object', { id: '' }],
        disabledModels: { buddy: { m1: true, m2: false }, bad: 'nope', empty: {} },
        disabledProviders: { buddy: true, other: false },
        globalModelsEnabled: 'yes',
      }), 'utf-8')
      const reloaded = new AccountPool({ credentials, dataDir: dir })
      expect(reloaded.listAccountsByProvider('buddy')).toHaveLength(1)
      // 只保留显式 true；`m2: false` 与空表被丢弃。
      expect([...reloaded.disabledModelsFor('buddy')]).toEqual(['m1'])
      expect(reloaded.providerEnabled('buddy')).toBe(false)
      expect(reloaded.providerEnabled('other')).toBe(true)
    })
  })

  describe('TRAE 签到设备轮换代次', () => {
    it('默认代次为 0（既有账号行为不变）', async () => {
      await pool.addAccount(makeAccount())
      expect(pool.traeCheckinDeviceGenerationFor('buddy-001')).toBe(0)
    })

    it('写入后读回新代次', async () => {
      await pool.addAccount(makeAccount())
      await pool.updateTraeCheckinDeviceGeneration('buddy-001', 3)
      expect(pool.traeCheckinDeviceGenerationFor('buddy-001')).toBe(3)
    })

    it('只接受更大的代次（防止乱序回调把代次写回小值）', async () => {
      await pool.addAccount(makeAccount())
      await pool.updateTraeCheckinDeviceGeneration('buddy-001', 5)
      await pool.updateTraeCheckinDeviceGeneration('buddy-001', 2)
      expect(pool.traeCheckinDeviceGenerationFor('buddy-001')).toBe(5)
    })

    it('非法代次（0 / 负数 / NaN）被忽略', async () => {
      await pool.addAccount(makeAccount())
      await pool.updateTraeCheckinDeviceGeneration('buddy-001', 0)
      await pool.updateTraeCheckinDeviceGeneration('buddy-001', -1)
      await pool.updateTraeCheckinDeviceGeneration('buddy-001', Number.NaN)
      expect(pool.traeCheckinDeviceGenerationFor('buddy-001')).toBe(0)
    })

    it('账号不存在时不抛错', async () => {
      await expect(pool.updateTraeCheckinDeviceGeneration('nope', 2)).resolves.toBeUndefined()
    })

    it('不破坏同一账号条目的其它字段', async () => {
      await pool.addAccount(makeAccount())
      await pool.updateModelRateLimit('buddy-001', 'm1', Date.now() + 60_000)
      await pool.updateTraeCheckinDeviceGeneration('buddy-001', 2)
      expect(pool.findAccount('buddy-001')?.modelRateLimits?.['m1']).toBeGreaterThan(Date.now())
    })
  })

  describe('getStateSnapshot / replaceAll（备份导入用）', () => {
    it('getStateSnapshot 返回副本（与进程内解耦）', async () => {
      await pool.addAccount(makeAccount())
      await pool.setModelDisabled('buddy', 'm1', true)
      const snapshot = pool.getStateSnapshot()
      snapshot.accounts.push(makeAccount({ id: 'injected' }))
      snapshot.disabledModels['buddy']!['injected'] = true
      expect(pool.findAccount('injected')).toBeUndefined()
      expect(pool.disabledModelsFor('buddy').has('injected')).toBe(false)
    })

    it('replaceAll 整体替换账号与黑名单', async () => {
      await pool.addAccount(makeAccount())
      await pool.replaceAll({
        accounts: [makeAccount({ id: 'new-one', credentialRef: 'REF_N' })],
        disabledModels: { buddy: { replaced: true } },
        disabledProviders: { buddy: true },
      })
      expect(pool.findAccount('buddy-001')).toBeUndefined()
      expect(pool.findAccount('new-one')).toBeDefined()
      expect([...pool.disabledModelsFor('buddy')]).toEqual(['replaced'])
      expect(pool.providerEnabled('buddy')).toBe(false)
    })

    it('replaceAll 归一化坏条目（丢弃缺 id/provider/credentialRef 的账号）', async () => {
      await pool.replaceAll({
        accounts: [
          makeAccount({ id: 'good' }),
          { id: '', provider: 'buddy', credentialRef: 'X', nickname: 'n', enabled: true, refreshable: true, createdAt: 0 },
          { id: 'no-provider', provider: '', credentialRef: 'X', nickname: 'n', enabled: true, refreshable: true, createdAt: 0 },
          { id: 'no-ref', provider: 'buddy', credentialRef: '', nickname: 'n', enabled: true, refreshable: true, createdAt: 0 },
        ] as ProviderAccountEntry[],
        disabledModels: {},
      })
      expect((await pool.listAllAccounts()).map(a => a.id)).toEqual(['good'])
    })

    it('replaceAll 落盘后跨实例可读', async () => {
      await pool.replaceAll({ accounts: [makeAccount({ id: 'persisted' })], disabledModels: {} })
      const reloaded = new AccountPool({ credentials, dataDir: dir })
      expect(reloaded.findAccount('persisted')).toBeDefined()
    })
  })

  describe('账号条目字段默认值', () => {
    it('sanitizeAccounts 补全 enabled/refreshable/nickname/createdAt', () => {
      const [entry] = sanitizeAccounts([{ id: 'a', provider: 'buddy', credentialRef: 'R' }])
      expect(entry).toMatchObject({ id: 'a', enabled: true, refreshable: true, nickname: 'a' })
      expect(entry!.createdAt).toBeTypeOf('number')
    })

    it('显式 enabled:false 被保留', () => {
      const [entry] = sanitizeAccounts([{ id: 'a', provider: 'buddy', credentialRef: 'R', enabled: false }])
      expect(entry!.enabled).toBe(false)
    })
  })

  describe('归一化函数', () => {
    it('sanitizeDisabledModels 丢弃非对象层与假值', () => {
      expect(sanitizeDisabledModels({ a: { x: true, y: false }, b: 'nope', c: [], d: {} })).toEqual({ a: { x: true } })
      expect(sanitizeDisabledModels(null)).toEqual({})
      expect(sanitizeDisabledModels([1, 2])).toEqual({})
    })

    it('sanitizeDisabledProviders 只保留显式 true', () => {
      expect(sanitizeDisabledProviders({ a: true, b: false, c: 'yes' })).toEqual({ a: true })
      expect(sanitizeDisabledProviders(undefined)).toEqual({})
    })
  })
})

describe('持久化原子性', () => {
  it('writeFileAtomic 替换内容且不留下临时文件', () => {
    const dir = mkdtempSync(join(tmpdir(), 'all-proxy-atomic-'))
    try {
      const path = join(dir, 'x.json')
      writeFileAtomic(path, '{"a":1}')
      expect(JSON.parse(readFileSync(path, 'utf-8'))).toEqual({ a: 1 })
      writeFileAtomic(path, '{"a":2}')
      expect(JSON.parse(readFileSync(path, 'utf-8'))).toEqual({ a: 2 })
      expect(existsSync(`${path}.tmp`)).toBe(false)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('readJsonFile 对损坏内容返回 undefined 而不是抛错', () => {
    const dir = mkdtempSync(join(tmpdir(), 'all-proxy-badjson-'))
    try {
      const path = join(dir, 'bad.json')
      writeFileSync(path, '{oops', 'utf-8')
      // ⚠️ 损坏的凭据文件绝不能让整个服务启动失败。
      expect(readJsonFile(path)).toBeUndefined()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('FileCredentialStore 跨实例读回', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'all-proxy-cred-'))
    try {
      const store = new FileCredentialStore(dir)
      await store.set('REF_A', '{"access_token":"tok"}')
      const reloaded = new FileCredentialStore(dir)
      expect((await reloaded.resolve('REF_A'))?.value).toBe('{"access_token":"tok"}')
      expect(await reloaded.listRefs()).toEqual(['REF_A'])
      await reloaded.unset('REF_A')
      expect(await reloaded.resolve('REF_A')).toBeUndefined()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

// ── 凭据换绑（管理端「绑定共享凭据文件」）──
//
// 用于一次性轮换 refresh_token 的 provider：把凭据指向一个共享文件，
// 避免本服务与官方客户端各持副本互相作废。
describe('AccountPool 凭据换绑', () => {
  let dir: string
  let credentials: FileCredentialStore
  let pool: AccountPool

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'all-proxy-rebind-'))
    credentials = new FileCredentialStore(dir)
    pool = new AccountPool({ credentials, dataDir: dir })
  })
  afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

  async function seedCredential(ref: string, value: Record<string, unknown>): Promise<void> {
    await credentials.set(ref, JSON.stringify(value))
  }

  it('换绑到尚不存在的外部文件：把旧凭据迁移过去，账号不丢凭据', async () => {
    const authPath = join(dir, 'auth-a.json')
    await seedCredential('RACCOON_ACCOUNT_M1', { access_token: 'tok-1', refresh_token: 'rt-1' })
    await pool.addAccount(makeAccount({
      id: 'raccoon-m1', provider: 'raccoon', credentialRef: 'RACCOON_ACCOUNT_M1',
    }))

    const result = await pool.rebindCredential('raccoon-m1', `FILE:${authPath}`)

    expect(result.migrated).toBe(true)
    expect(pool.findAccount('raccoon-m1')?.credentialRef).toBe(`FILE:${authPath}`)
    // 旧凭据的内容原样搬到了外部文件。
    const written = JSON.parse(readFileSync(authPath, 'utf-8')) as Record<string, unknown>
    expect(written['refresh_token']).toBe('rt-1')
  })

  it('换绑到已有内容的外部文件：**不覆盖**它，以文件为准', async () => {
    const authPath = join(dir, 'auth-b.json')
    writeFileSync(authPath, JSON.stringify({ access_token: 'from-official-client', refresh_token: 'rt-shared' }), 'utf-8')
    await seedCredential('RACCOON_ACCOUNT_M2', { access_token: 'stale', refresh_token: 'rt-stale' })
    await pool.addAccount(makeAccount({
      id: 'raccoon-m2', provider: 'raccoon', credentialRef: 'RACCOON_ACCOUNT_M2',
    }))

    const result = await pool.rebindCredential('raccoon-m2', `FILE:${authPath}`)

    expect(result.migrated).toBe(false)
    // ⚠️ 覆盖它等于把别的消费者刚刷出来的 token 抹掉 —— 正是要避免的事。
    const written = JSON.parse(readFileSync(authPath, 'utf-8')) as Record<string, unknown>
    expect(written['access_token']).toBe('from-official-client')
  })

  it('从共享文件解绑：当前内容转存为内置凭据（不因解绑丢凭据）', async () => {
    const authPath = join(dir, 'auth-c.json')
    writeFileSync(authPath, JSON.stringify({ access_token: 'tok-shared', refresh_token: 'rt-shared' }), 'utf-8')
    await pool.addAccount(makeAccount({
      id: 'raccoon-m3', provider: 'raccoon', credentialRef: `FILE:${authPath}`,
    }))

    const result = await pool.rebindCredential('raccoon-m3', 'RACCOON_ACCOUNT_M3')

    expect(result.migrated).toBe(true)
    const stored = await pool.resolveCredentialByRef('RACCOON_ACCOUNT_M3')
    expect(stored?.['access_token']).toBe('tok-shared')
    // 外部文件仍在（不属于我们，不该删）。
    expect(existsSync(authPath)).toBe(true)
  })

  it('换绑到同一 ref 是无操作', async () => {
    await seedCredential('RACCOON_ACCOUNT_M4', { access_token: 't' })
    await pool.addAccount(makeAccount({
      id: 'raccoon-m4', provider: 'raccoon', credentialRef: 'RACCOON_ACCOUNT_M4',
    }))
    const result = await pool.rebindCredential('raccoon-m4', 'RACCOON_ACCOUNT_M4')
    expect(result.migrated).toBe(false)
  })

  it('换绑空 ref 被拒（避免产生无凭据可解的账号）', async () => {
    await pool.addAccount(makeAccount({ id: 'raccoon-m5', provider: 'raccoon' }))
    await expect(pool.rebindCredential('raccoon-m5', '   ')).rejects.toThrow(/不能为空/)
  })

  it('换绑不存在的账号报错', async () => {
    await expect(pool.rebindCredential('nope', 'REF_X')).rejects.toThrow(/not found/)
  })
})
