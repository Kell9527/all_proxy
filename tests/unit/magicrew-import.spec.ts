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
import { MAGICREW_INTL } from '../../src/providers/magicrew-product.js'

/** 最小池替身：记 addAccount 收到的条目，并支持判重所需的只读遍历。 */
function stubPool(preexisting: Record<string, unknown>[] = []) {
  const added: Record<string, unknown>[] = []
  const all = [...preexisting]
  return {
    added,
    all,
    pool: {
      addAccount: async (entry: unknown) => {
        added.push(entry as Record<string, unknown>)
        all.push(entry as Record<string, unknown>)
      },
      /**
       * 判重会遍历该 provider 的既有条目。
       *
       * ⚠️ 返回的是 `preexisting` 里 provider 匹配的那些 —— 与真实池一致，
       * **不按 ref 形态过滤**（判据是凭据内容，不是 ref 名）。
       */
      listAccountsByProvider: (provider: string) =>
        all.filter((entry) => entry.provider === provider),
      resolveCredentialByRef: async () => undefined,
      updateAccount: async () => {},
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
  it('国际站：按 `product` 读**国际站**的 origin，且落成 magicrewintl 账号 + 独立 ref 前缀', async () => {
    // ⚠️ 用国内站 host 去读国际站的 localStorage 会**恒读不到**且完全静默
    //    （症状与「用户没登录」同形）—— 所以这里断言读到的 hostname 与 provider/ref。
    const { pool, added } = stubPool()
    const { credentials, store } = stubCredentials()
    const seenHosts: string[] = []
    await importMagicrewFromLocalBrowser({
      pool,
      credentials,
      product: MAGICREW_INTL,
      nickname: '',
      readCreds: (hostname) => {
        seenHosts.push(hostname)
        return { jwt: 'jwt', organizationCode: 'org' }
      },
      issueKey: async () => ({ apiKey: 'mgw_x' }),
      profileFetcher: async () => ({ nickname: '', realName: '', phone: '' }),
      warn: () => {},
    })
    expect(seenHosts).toEqual(['www.magicrew.ai'])
    expect((added[0] as { provider: string }).provider).toBe('magicrewintl')
    // ⚠️ ref 前缀必须与 dsh-import 的 ACCOUNT_REF_RE 一致，否则账号会被判不可识别。
    expect([...store.keys()][0]).toMatch(/^MAGICREWINTL_ACCOUNT_[0-9A-F]+$/)
  })

  it('国内站：provider 与 ref 前缀保持 magicrew / MAGICREW_ACCOUNT_', async () => {
    const { pool, added } = stubPool()
    const { credentials, store } = stubCredentials()
    await importMagicrewFromLocalBrowser({
      pool,
      credentials,
      nickname: '',
      readCreds: () => ({ jwt: 'jwt', organizationCode: 'org' }),
      issueKey: async () => ({ apiKey: 'mgw_x' }),
      profileFetcher: async () => ({ nickname: '', realName: '', phone: '' }),
      warn: () => {},
    })
    expect((added[0] as { provider: string }).provider).toBe('magicrew')
    expect([...store.keys()][0]).toMatch(/^MAGICREW_ACCOUNT_[0-9A-F]+$/)
  })

  /**
   * ⚠️ **判重**（来源 `findMagicrewAccountByFingerprint` 的语义）：同一个上游账号
   * 反复导入（导入 → 网页登录 → 再导入）拿到的是**同一份 jwt** ⇒ 不得堆出多张卡。
   */
  describe('判重：按 sha256(jwt) 指纹', () => {
    /** 造一个「池里已有一条同 jwt 账号」的替身（凭据真的能解出来）。 */
    function stubPoolWithExisting(preexistingJwt: string, provider = 'magicrew') {
      const added: Record<string, unknown>[] = []
      const existing = {
        id: `${provider}-existing`, provider, nickname: '老账号',
        enabled: true, credentialRef: 'MAGICREW_ACCOUNT_EXISTING',
      }
      const patches: Record<string, unknown>[] = []
      const written: Record<string, string> = {}
      return {
        added,
        patches,
        written,
        pool: {
          listAccountsByProvider: (p: string) => (p === provider ? [existing] : []),
          resolveCredentialByRef: async (ref: string) =>
            ref === 'MAGICREW_ACCOUNT_EXISTING' ? { jwt: preexistingJwt } : undefined,
          addAccount: async (entry: unknown) => { added.push(entry as Record<string, unknown>) },
          updateAccount: async (_id: string, patch: unknown) => {
            patches.push(patch as Record<string, unknown>)
          },
        } as never,
        credentials: {
          set: async (ref: string, value: string) => { written[ref] = value },
        } as never,
      }
    }

    it('命中既有账号 ⇒ **不新建**，返回原 id 并标 reused', async () => {
      const { pool, added, written } = stubPoolWithExisting('same-jwt')
      const result = await importMagicrewFromLocalBrowser({
        pool,
        credentials: { set: async (ref: string, value: string) => { written[ref] = value } } as never,
        nickname: '',
        readCreds: () => ({ jwt: 'same-jwt', organizationCode: 'org' }),
        issueKey: async () => ({ apiKey: 'mgw_new' }),
        profileFetcher: async () => ({ nickname: '', realName: '', phone: '' }),
        warn: () => {},
      })
      expect(added).toHaveLength(0)
      expect(result).toMatchObject({ id: 'magicrew-existing', reused: true })
    })

    it('⚠️ 命中时**必须**把新凭据写回**既有账号自己的 ref**（新 api_key 会吊销旧 key）', async () => {
      // 不写回 ⇒ 那条账号手里是刚被吊销的死 key ⇒ 每个请求 401。
      const { pool, written } = stubPoolWithExisting('same-jwt')
      await importMagicrewFromLocalBrowser({
        pool,
        credentials: { set: async (ref: string, value: string) => { written[ref] = value } } as never,
        nickname: '',
        readCreds: () => ({ jwt: 'same-jwt', organizationCode: 'org' }),
        issueKey: async () => ({ apiKey: 'mgw_new' }),
        profileFetcher: async () => ({ nickname: '', realName: '', phone: '' }),
        warn: () => {},
      })
      expect(Object.keys(written)).toEqual(['MAGICREW_ACCOUNT_EXISTING'])
      expect(written['MAGICREW_ACCOUNT_EXISTING']).toContain('mgw_new')
    })

    it('jwt 不同 ⇒ 正常新建（重新登录会拿到新 jwt，这种拦不住，各成一张卡）', async () => {
      const { pool, added, written } = stubPoolWithExisting('other-jwt')
      const result = await importMagicrewFromLocalBrowser({
        pool,
        credentials: { set: async (ref: string, value: string) => { written[ref] = value } } as never,
        nickname: '',
        readCreds: () => ({ jwt: 'new-jwt', organizationCode: 'org' }),
        issueKey: async () => ({ apiKey: 'mgw_new' }),
        profileFetcher: async () => ({ nickname: '', realName: '', phone: '' }),
        warn: () => {},
      })
      expect(added).toHaveLength(1)
      expect(result).toMatchObject({ reused: false })
    })

    it('两站互不可见：国际站导入不会命中池里的国内站账号', async () => {
      const { pool, added } = stubPoolWithExisting('same-jwt', 'magicrew')
      const result = await importMagicrewFromLocalBrowser({
        pool,
        credentials: { set: async () => {} } as never,
        product: MAGICREW_INTL,
        nickname: '',
        readCreds: () => ({ jwt: 'same-jwt', organizationCode: 'org' }),
        issueKey: async () => ({ apiKey: 'mgw_new' }),
        profileFetcher: async () => ({ nickname: '', realName: '', phone: '' }),
        warn: () => {},
      })
      // 国际站按 `provider: 'magicrewintl'` 遍历，那份池替身只认同 provider ⇒ 不命中。
      expect(added).toHaveLength(1)
      expect(result).toMatchObject({ reused: false })
    })
  })
})
