/**
 * 共享凭据文件引用（`FILE:<路径>`）的单元测试。
 *
 * ## 这组用例守的是什么
 *
 * 用户报障「Raccoon 账号容易过期」，根因是**多方各持一份 refresh_token 副本**：
 * 该 token 一次性轮换，谁先刷新，其余副本立刻作废。修法是让凭据可以指向一个
 * **共享文件** —— 谁刷新都写回同一处，其余消费者下次读到最新值。
 *
 * 因此这里锁死的核心行为是「**读永远反映文件此刻的内容**」：只要这条不成立
 * （例如某次优化给 resolve 加了缓存），整个机制就退化成死副本，且**没有任何
 * 报错**，只会表现为「账号又过期了」—— 正是最难查的那种回归。
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { FileCredentialStore } from '../../src/pool/store.js'
import { exportBackup, importBackup } from '../../src/providers/backup.js'
import type { ProviderAccountEntry } from '../../src/pool/types.js'
import { BACKUP_FORMAT, BACKUP_VERSION } from '../../src/providers/types.js'
import {
  expandHome,
  formatFileRef,
  isFileRef,
  maskCredentialPath,
  parseCredentialRef,
  validateFileRefInput,
} from '../../src/pool/credential-ref-kind.js'

describe('credential-ref-kind', () => {
  it('FILE: 前缀识别为文件引用，其余为内置 ref', () => {
    expect(parseCredentialRef('FILE:D:\\x\\auth.json').kind).toBe('file')
    expect(parseCredentialRef('RACCOON_ACCOUNT_ABCD1234').kind).toBe('inline')
    // ⚠️ 不做「看起来像路径就当文件」的猜测：内置 ref 形态多样，猜错会
    // 把一个普通键当成路径去读盘。
    expect(parseCredentialRef('C:\\Users\\me\\auth.json').kind).toBe('inline')
    expect(isFileRef('FILE:/tmp/a.json')).toBe(true)
    expect(isFileRef('RACCOON_ACCOUNT_1')).toBe(false)
  })

  it('展开开头的 ~ 为用户主目录（只处理开头）', () => {
    expect(expandHome('~/a/b.json')).toBe(join(homedir(), 'a', 'b.json'))
    expect(expandHome('~\\\\a\\\\b.json')).toBe(join(homedir(), 'a\\\\b.json'))
    expect(expandHome('~')).toBe(homedir())
    // 中间的 ~ 是普通字符，不动它。
    expect(expandHome('D:\\we~ird\\a.json')).toBe('D:\\we~ird\\a.json')
  })

  it('formatFileRef 存展开后的绝对路径（不受工作目录影响）', () => {
    const ref = formatFileRef('~/x/auth.json')
    expect(ref.startsWith('FILE:')).toBe(true)
    expect(ref).not.toContain('~')
    expect(ref).toBe(`FILE:${join(homedir(), 'x', 'auth.json')}`)
  })

  it('校验：相对路径与空路径被拒，绝对路径与 ~ 路径通过', () => {
    expect(validateFileRefInput('').ok).toBe(false)
    expect(validateFileRefInput('   ').ok).toBe(false)
    const relative = validateFileRefInput('auth.json')
    expect(relative.ok).toBe(false)
    if (!relative.ok) expect(relative.message).toContain('绝对路径')

    const abs = validateFileRefInput('D:\\tmp\\auth.json')
    expect(abs.ok).toBe(true)
    if (abs.ok) expect(abs.ref).toBe('FILE:D:\\tmp\\auth.json')

    const home = validateFileRefInput('~/auth.json')
    expect(home.ok).toBe(true)
  })

  it('容忍用户粘贴带前缀的值（从别处复制的 ref）', () => {
    const result = validateFileRefInput('FILE:D:\\tmp\\auth.json')
    expect(result.ok).toBe(true)
    // 不会变成 FILE:FILE:...
    if (result.ok) expect(result.ref).toBe('FILE:D:\\tmp\\auth.json')
  })

  it('脱敏保留尾部两段，隐藏用户名等本机信息', () => {
    expect(maskCredentialPath('C:\\Users\\alice\\.box-agent\\config\\auth-a.json'))
      .toBe('…/config/auth-a.json')
    // 层级不足时不硬加省略号。
    expect(maskCredentialPath('auth.json')).toBe('auth.json')
  })
})

describe('FileCredentialStore 的文件引用语义', () => {
  let dir: string
  let store: FileCredentialStore

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'all-proxy-fileref-'))
    store = new FileCredentialStore(dir)
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  function fileRef(name: string): { ref: string; path: string } {
    const path = join(dir, name)
    return { ref: `FILE:${path}`, path }
  }

  it('resolve 实时读盘：外部改动立即反映（这是整个机制的核心）', async () => {
    const { ref, path } = fileRef('auth.json')
    writeFileSync(path, JSON.stringify({ access_token: 'first' }), 'utf-8')
    const before = await store.resolve(ref)
    expect(JSON.parse(before!.value).access_token).toBe('first')

    // 模拟「另一个消费者（官方客户端 / 另一个网关）刷新后写回文件」。
    writeFileSync(path, JSON.stringify({ access_token: 'rotated-by-someone-else' }), 'utf-8')

    const after = await store.resolve(ref)
    expect(JSON.parse(after!.value).access_token).toBe('rotated-by-someone-else')
    expect(after!.source).toBe('file-ref')
  })

  it('set 写回外部文件（不是写进内置凭据表）', async () => {
    const { ref, path } = fileRef('auth.json')
    await store.set(ref, JSON.stringify({ access_token: 'new-token' }))

    expect(JSON.parse(readFileSync(path, 'utf-8')).access_token).toBe('new-token')
    // 内置表里不得出现 FILE: 这个键。
    expect(store.listRefs()).toEqual([])
    expect(store.snapshot()).toEqual({})
  })

  it('文件不存在时 resolve 返回 undefined（选号器据此跳过并给可读原因）', async () => {
    const { ref } = fileRef('missing.json')
    expect(await store.resolve(ref)).toBeUndefined()
    expect(await store.describe(ref)).toEqual({ exists: false })
  })

  it('describe 区分文件引用与内置凭据', async () => {
    const { ref, path } = fileRef('auth.json')
    await store.set(ref, '{}')
    expect(await store.describe(ref)).toEqual({ exists: true, source: 'file-ref' })

    await store.set('RACCOON_ACCOUNT_X', '{}')
    expect(await store.describe('RACCOON_ACCOUNT_X')).toEqual({ exists: true, source: 'file' })
  })

  it('unset 对文件引用是**无操作**：绝不删除外部文件', async () => {
    const { ref, path } = fileRef('auth.json')
    await store.set(ref, JSON.stringify({ access_token: 'keep-me' }))

    await store.unset(ref)

    // ⚠️ 该文件可能被官方客户端或其它网关共享，删除会波及本服务之外的东西，
    // 且 refresh token 一次性、删了无法恢复。
    expect(existsSync(path)).toBe(true)
    expect(JSON.parse(readFileSync(path, 'utf-8')).access_token).toBe('keep-me')
  })

  it('unset 对内置 ref 照常删除', async () => {
    await store.set('REF_A', 'v')
    await store.unset('REF_A')
    expect(await store.resolve('REF_A')).toBeUndefined()
  })

  it('原子写：目标目录不存在时自动创建', async () => {
    const path = join(dir, 'nested', 'deep', 'auth.json')
    await store.set(`FILE:${path}`, JSON.stringify({ access_token: 'nested' }))
    expect(JSON.parse(readFileSync(path, 'utf-8')).access_token).toBe('nested')
  })

  it('原子写：不会留下 .tmp 残留', async () => {
    const { ref, path } = fileRef('auth.json')
    await store.set(ref, JSON.stringify({ access_token: 'x' }))
    expect(existsSync(`${path}.${process.pid}.tmp`)).toBe(false)
  })

  it('replaceAll 对文件引用写回原路径，且不进内置表', async () => {
    const { ref, path } = fileRef('auth.json')
    mkdirSync(dir, { recursive: true })
    await store.replaceAll({ [ref]: JSON.stringify({ access_token: 'from-backup' }), REF_B: 'inline' })

    expect(JSON.parse(readFileSync(path, 'utf-8')).access_token).toBe('from-backup')
    expect(store.listRefs()).toEqual(['REF_B'])
  })

  it('replaceAll 对不可写的文件路径跳过，不让整次导入失败', async () => {
    // Windows 下非法盘符；其它平台用明显不存在的挂载点。
    const badRef = process.platform === 'win32' ? 'FILE:Q:\\nope\\auth.json' : 'FILE:/proc/nope/auth.json'
    await expect(store.replaceAll({ [badRef]: '{}', REF_C: 'ok' })).resolves.toBeUndefined()
    // 内置那份仍写进去了。
    expect(await store.resolve('REF_C')).toBeDefined()
  })

  it('文件引用不参与 listRefs/snapshot（备份由 backup.ts 专门内联）', async () => {
    const { ref } = fileRef('auth.json')
    await store.set(ref, '{}')
    await store.set('INLINE_A', 'v')
    expect(store.listRefs()).toEqual(['INLINE_A'])
    expect(Object.keys(store.snapshot())).toEqual(['INLINE_A'])
  })

  it('写入的凭据文件权限尽可能收紧（Windows 上 chmod 无效，忽略失败）', async () => {
    const { ref, path } = fileRef('auth.json')
    await store.set(ref, JSON.stringify({ access_token: 'x' }))
    const mode = statSync(path).mode & 0o777
    if (process.platform !== 'win32') expect(mode).toBe(0o600)
    else expect(mode).toBeGreaterThan(0)
  })
})

describe('备份与共享凭据文件的往返', () => {
  let dir: string
  let store: FileCredentialStore

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'all-proxy-bkref-'))
    store = new FileCredentialStore(dir)
  })
  afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

  /** 备份模块所需的池最小接口（本组用例只关心凭据部分）。 */
  function poolFor(accounts: ProviderAccountEntry[]): Parameters<typeof importBackup>[1] {
    return {
      getStateSnapshot: () => ({
        accounts,
        disabledModels: {},
        globalModelsEnabled: true,
        disabledProviders: {},
        loomyPermanentLocked: false,
        switchAudit: [],
      }),
      replaceAll: async () => {},
    }
  }

  function entry(id: string, credentialRef: string): ProviderAccountEntry {
    return {
      id, provider: 'raccoon', nickname: id, enabled: true,
      credentialRef, createdAt: Date.now(), refreshable: true,
    }
  }

  it('导出把共享文件的内容**内联**进备份（备份自包含，换机器可恢复）', async () => {
    const authPath = join(dir, 'auth-a.json')
    writeFileSync(authPath, JSON.stringify({ access_token: 'shared-tok', refresh_token: 'shared-rt' }), 'utf-8')
    const account = entry('raccoon-x', `FILE:${authPath}`)

    const result = await exportBackup(poolFor([account]), store)

    // 键是文件引用本身，值是那一刻文件的内容。
    expect(result.payload.credentials[`FILE:${authPath}`]).toContain('shared-tok')
    expect(result.warnings).toEqual([])
  })

  it('导入按 ref 语义**写回原路径**（同机恢复等价于把 token 送回共享文件）', async () => {
    const authPath = join(dir, 'auth-b.json')
    writeFileSync(authPath, JSON.stringify({ access_token: 'old' }), 'utf-8')
    const account = entry('raccoon-y', `FILE:${authPath}`)

    const payload = {
      format: BACKUP_FORMAT,
      version: BACKUP_VERSION,
      exportedAt: new Date().toISOString(),
      credentials: { [`FILE:${authPath}`]: JSON.stringify({ access_token: 'restored', refresh_token: 'rt' }) },
      accounts: [account],
      disabledModels: {},
      loomyPermanentLocked: false,
    }

    const result = await importBackup(store, poolFor([account]), payload)

    expect(result.credentialsImported).toBe(1)
    expect(result.skipped).toEqual([])
    // ⚠️ 关键：写到了**外部文件**，而不是把 `FILE:...` 当成一个普通键
    // 塞进 credentials.json。后者会让共享关系静默失效。
    expect(JSON.parse(readFileSync(authPath, 'utf-8')).access_token).toBe('restored')
    expect(store.listRefs()).toEqual([])
  })

  it('导入时外部路径不可写：跳过并记录，不让整次导入失败', async () => {
    const badRef = process.platform === 'win32' ? 'FILE:Q:\\nope\\x.json' : 'FILE:/proc/nope/x.json'
    const account = entry('raccoon-z', badRef)
    const payload = {
      format: BACKUP_FORMAT,
      version: BACKUP_VERSION,
      exportedAt: new Date().toISOString(),
      credentials: { [badRef]: '{}', RACCOON_ACCOUNT_OK: '{"access_token":"a"}' },
      accounts: [account, entry('raccoon-ok', 'RACCOON_ACCOUNT_OK')],
      disabledModels: {},
      loomyPermanentLocked: false,
    }

    const result = await importBackup(store, poolFor(payload.accounts), payload)

    expect(result.skipped).toContain(badRef)
    expect(result.credentialsImported).toBe(1)
    // 不可写的那个账号被计为「凭据缺失」，前端据此提示重新登录或重新绑定。
    expect(result.missingCredentials).toBe(1)
  })
})
