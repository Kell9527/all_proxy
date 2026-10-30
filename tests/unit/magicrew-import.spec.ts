/**
 * Magicrew「从本机浏览器导入」的回归用例。
 *
 * 锁两件事：
 * 1. **一个浏览器 profile 只有一份登录态** ⇒ 每次导入必须落成一条**独立**账号
 *    （不能复用 ref，否则第二个账号会覆盖第一个 —— 用户原话「只能一个账号」）。
 * 2. **三种「不完美但可接受」的情形都不失败，但都留痕**：签发 key 失败、取资料
 *    失败、手机号是 10 位本地号。
 */
import { describe, expect, it } from 'vitest'

import { importMagicrewFromLocalBrowser } from '../../src/admin/magicrew-import.js'

/** 最小池替身：只记 addAccount 收到的条目。 */
function stubPool() {
  const added: Record<string, unknown>[] = []
  return {
    added,
    pool: {
      addAccount: async (entry: unknown) => { added.push(entry as Record<string, unknown>) },
    } as never,
  }
}

/** 最小凭据存储替身：记下 ref → 值。 */
function stubCredentials() {
  const store = new Map<string, string>()
  return {
    store,
    credentials: {
      set: async (ref: string, value: string) => { store.set(ref, value) },
    } as never,
  }
}

describe('importMagicrewFromLocalBrowser', () => {
  it('读不到登录态 ⇒ 返回 not-found，**不建空账号**', async () => {
    // ⚠️ 「本机浏览器里这个站没登录过」不是故障：建空账号会得到一个每请求都报
    //    AUTH 的幽灵条目。
    const { pool, added } = stubPool()
    const { credentials } = stubCredentials()
    const result = await importMagicrewFromLocalBrowser({
      pool,
      credentials,
      nickname: '',
      readCreds: () => undefined,
      warn: () => {},
    })
    expect(result).toEqual({ kind: 'not-found' })
    expect(added).toHaveLength(0)
  })

  it('**每次导入都落一条独立账号**（一个浏览器只有一份登录态）', async () => {
    // ⚠️⚠️ 这条锁的是用户报障的核心：「同个浏览器只能一个账号」。
    //    每个账号必须有自己的 ref，否则第二次导入会**覆盖**第一次的凭据。
    //    本用例两次都返回**同一份**登录态（模拟用户没换浏览器）—— 服务端无法
    //    分辨，只如实各建一条（覆盖顺序由浏览器决定）。
    const { pool, added } = stubPool()
    const { credentials, store } = stubCredentials()
    const io = {
      readCreds: () => ({ jwt: 'jwt-same', organizationCode: 'org' }),
      issueKey: async () => ({ apiKey: 'mgw_x', apiKeyExpiresAt: Date.now() + 7200000 }),
      profileFetcher: async () => ({ nickname: 'Nick', realName: 'Nick', phone: '' }),
      warn: () => {},
    }
    await importMagicrewFromLocalBrowser({ pool, credentials, nickname: '', ...io })
    await importMagicrewFromLocalBrowser({ pool, credentials, nickname: '', ...io })
    expect(added).toHaveLength(2)
    expect((added[0] as { credentialRef: string }).credentialRef)
      .not.toBe((added[1] as { credentialRef: string }).credentialRef)
    expect((added[0] as { id: string }).id).not.toBe((added[1] as { id: string }).id)
    expect(store.size).toBe(2)
  })

  it('签发 key 失败 ⇒ **仍然建号**（warn 留痕），但 hasApiKey=false', async () => {
    // ⚠️ 不吞掉导入：jwt 能拉目录/积分，api_key 可由续期救回。但必须如实告诉
    //    调用方 —— 否则用户看到「建号成功却每请求不回复」。
    const { pool, added } = stubPool()
    const { credentials } = stubCredentials()
    const warnings: string[] = []
    const result = await importMagicrewFromLocalBrowser({
      pool,
      credentials,
      nickname: '',
      readCreds: () => ({ jwt: 'jwt', organizationCode: 'org' }),
      issueKey: async () => { throw new Error('network down') },
      profileFetcher: async () => ({ nickname: '', realName: '', phone: '' }),
      warn: (message: string) => warnings.push(message),
    })
    expect(added).toHaveLength(1)
    expect((result as { hasApiKey: boolean }).hasApiKey).toBe(false)
    expect(warnings.some((w) => w.includes('签发 gateway key 失败'))).toBe(true)
  })

  it('取资料失败 ⇒ 不挡建号（昵称回落渠道名）', async () => {
    const { pool, added } = stubPool()
    const { credentials } = stubCredentials()
    const warnings: string[] = []
    await importMagicrewFromLocalBrowser({
      pool,
      credentials,
      nickname: '',
      readCreds: () => ({ jwt: 'jwt', organizationCode: 'org' }),
      issueKey: async () => ({ apiKey: 'mgw_x' }),
      profileFetcher: async () => { throw new Error('404') },
      warn: (message: string) => warnings.push(message),
    })
    expect(added).toHaveLength(1)
    expect((added[0] as { nickname: string }).nickname).toBe('超级麦吉')
    expect(warnings.some((w) => w.includes('读取账号资料失败'))).toBe(true)
  })

  it('手机号**原样**写进凭据（10 位本地号不补国家码）', async () => {
    // ⚠️ 补国家码会让用户以为登录的是另一个账号（照着重登会输错）。
    const { pool } = stubPool()
    const { credentials, store } = stubCredentials()
    const result = await importMagicrewFromLocalBrowser({
      pool,
      credentials,
      nickname: '',
      readCreds: () => ({ jwt: 'jwt', organizationCode: 'org' }),
      issueKey: async () => ({ apiKey: 'mgw_x' }),
      profileFetcher: async () => ({ nickname: 'Nick', realName: 'Nick', phone: '1380013800' }),
      warn: () => {},
    })
    expect((result as { hasPhone: boolean }).hasPhone).toBe(true)
    const stored = JSON.parse([...store.values()][0]!) as { phone?: string }
    expect(stored.phone).toBe('1380013800')
    expect(stored.phone).not.toBe('13800138000')
  })

  it('用户显式给的昵称优先于 profile 昵称', async () => {
    const { pool, added } = stubPool()
    const { credentials } = stubCredentials()
    await importMagicrewFromLocalBrowser({
      pool,
      credentials,
      nickname: '我的小号',
      readCreds: () => ({ jwt: 'jwt', organizationCode: 'org' }),
      issueKey: async () => ({ apiKey: 'mgw_x' }),
      profileFetcher: async () => ({ nickname: 'Nick', realName: 'Nick', phone: '' }),
      warn: () => {},
    })
    expect((added[0] as { nickname: string }).nickname).toBe('我的小号')
  })

  it('refreshable 恒 true（refresh_token 能换 api_key）', async () => {
    const { pool, added } = stubPool()
    const { credentials } = stubCredentials()
    await importMagicrewFromLocalBrowser({
      pool,
      credentials,
      nickname: '',
      readCreds: () => ({ jwt: 'jwt', organizationCode: 'org' }),
      issueKey: async () => ({ apiKey: 'mgw_x' }),
      profileFetcher: async () => ({ nickname: '', realName: '', phone: '' }),
      warn: () => {},
    })
    expect((added[0] as { refreshable: boolean }).refreshable).toBe(true)
  })
})
