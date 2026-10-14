import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AccountPool } from '../../src/pool/account-pool.js'
import { FileCredentialStore } from '../../src/pool/store.js'
import {
  accountFromCredentialRef,
  importFromDsh,
  parseCredentialRefs,
  resolveDshPaths,
} from '../../src/pool/dsh-import.js'

/** 造一个 DSH home 目录，含凭据与状态文件。 */
function makeDshHome(options: {
  refs: Record<string, string>
  disabledModels?: Record<string, Record<string, boolean>>
  stateMissing?: boolean
}): string {
  const home = mkdtempSync(join(tmpdir(), 'all-proxy-dsh-'))
  const lines = ['version: 1', 'refs:']
  for (const [name, value] of Object.entries(options.refs)) {
    // YAML 单引号包裹，内部 ' 转义为 ''。
    lines.push(`  ${name}: '${value.replace(/'/g, "''")}'`)
  }
  lines.push('records:')
  lines.push('  some/record:')
  lines.push('    kind: grant')
  writeFileSync(join(home, '.credentials.yaml'), lines.join('\n'), 'utf-8')

  if (options.stateMissing !== true) {
    const state = {
      accounts: [],
      disabledModels: options.disabledModels ?? {},
      loomyPermanentLocked: false,
    }
    const dir = join(home, 'jet-hub')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'state.json'), JSON.stringify(state, null, 2), 'utf-8')
  }
  return home
}



describe('parseCredentialRefs', () => {
  it('解析 refs 段的键与值，并在顶格键处结束', () => {
    const refs = parseCredentialRefs([
      'version: 1',
      'refs:',
      "  REF_A: '{\"access_token\":\"a\"}'",
      "  REF_B: '{\"access_token\":\"b\"}'",
      'records:',
      "  should/not: 'be-parsed'",
    ].join('\n'))
    expect([...refs.keys()]).toEqual(['REF_A', 'REF_B'])
    expect(refs.get('REF_A')).toBe('{"access_token":"a"}')
  })

  it('还原 YAML 单引号转义（内部 \'\' 表示一个 \'）', () => {
    const refs = parseCredentialRefs("refs:\n  R: 'it''s ok'")
    expect(refs.get('R')).toBe("it's ok")
  })

  it('无 refs 段时返回空表（不抛错）', () => {
    expect(parseCredentialRefs('version: 1\nrecords:\n  a: b').size).toBe(0)
  })

  it('容忍空值与缺少冒号的行', () => {
    const refs = parseCredentialRefs('refs:\n  A:\n  这一行不是键值对\n  B: x')
    expect(refs.get('A')).toBe('')
    expect(refs.get('B')).toBe('x')
  })
})

describe('accountFromCredentialRef', () => {
  it('**覆盖全部 11 个 provider 的前缀**（来源漏了四个）', () => {
    // ⚠️ 来源的 PROVIDER_BY_REF_PREFIX 只列了 6 个，遗漏 QODERCN / CLINE /
    // LOOMY / RACCOON —— 用户的凭据里确实有后三类，故必须补全。
    // SENSENOVA 虽在 DSH 里没有登录态，但本项目「粘贴 key 建号」会造出该前缀。
    const cases: Array<[string, string]> = [
      ['CODEARTS_ACCOUNT_AABBCC', 'codearts'],
      ['BUDDY_ACCOUNT_AABBCC', 'buddy'],
      ['WORKBUDDY_ACCOUNT_AABBCC', 'workbuddy'],
      ['LOBSTERAI_ACCOUNT_AABBCC', 'lobsterai'],
      ['QODER_ACCOUNT_AABBCC', 'qoder'],
      ['QODERCN_ACCOUNT_AABBCC', 'qodercn'],
      ['TRAE_ACCOUNT_AABBCC', 'trae'],
      ['CLINE_ACCOUNT_AABBCC', 'cline'],
      ['LOOMY_ACCOUNT_AABBCC', 'loomy'],
      ['RACCOON_ACCOUNT_AABBCC', 'raccoon'],
      ['OFFICEACE_ACCOUNT_AABBCC', 'officeace'],
      ['ACCIO_ACCOUNT_AABBCC', 'accio'],
      ['SENSENOVA_ACCOUNT_AABBCC', 'sensenova'],
    ]
    for (const [ref, provider] of cases) {
      const entry = accountFromCredentialRef(ref)
      expect(entry, `${ref} 应被识别`).toBeDefined()
      expect(entry?.provider).toBe(provider)
    }
  })

  it('id 形如 {provider}-{hex 小写}', () => {
    expect(accountFromCredentialRef('RACCOON_ACCOUNT_9ED45558')?.id).toBe('raccoon-9ed45558')
  })

  it('从凭据值里取昵称与过期时间', () => {
    const value = JSON.stringify({ nickname: 'RaccoonMia', expires_at: '1790571894000' })
    const entry = accountFromCredentialRef('RACCOON_ACCOUNT_9ED45558', value)
    expect(entry?.nickname).toBe('RaccoonMia')
    expect(entry?.expiresAt).toBe(1790571894000)
  })

  it('取 `expire_time` 作为过期时间的别名（Qoder 系用它）', () => {
    const value = JSON.stringify({ expire_time: 1793153094000 })
    expect(accountFromCredentialRef('QODERCN_ACCOUNT_AABBCC', value)?.expiresAt).toBe(1793153094000)
  })

  it('凭据值损坏时退回 id 作昵称（不阻断导入）', () => {
    const entry = accountFromCredentialRef('BUDDY_ACCOUNT_AABBCC', '{not json')
    expect(entry?.nickname).toBe('buddy-aabbcc')
    expect(entry?.expiresAt).toBeUndefined()
  })

  it('非账号 ref（如 API key）返回 undefined', () => {
    expect(accountFromCredentialRef('OPENCODE_API_KEY')).toBeUndefined()
    expect(accountFromCredentialRef('ROUTER999_API_KEY')).toBeUndefined()
  })

  it('hex 后缀太短时拒绝（避免把非账号 ref 当账号）', () => {
    expect(accountFromCredentialRef('BUDDY_ACCOUNT_AB')).toBeUndefined()
  })
})

describe('resolveDshPaths', () => {
  it('默认指向 ~/.dsh', () => {
    const paths = resolveDshPaths()
    expect(paths.credentials.endsWith('.credentials.yaml')).toBe(true)
    expect(paths.state).toContain('jet-hub')
  })

  it('可用显式 home 覆盖', () => {
    const paths = resolveDshPaths('C:\\custom\\dsh')
    expect(paths.home).toBe('C:\\custom\\dsh')
    expect(paths.credentials).toBe('C:\\custom\\dsh\\.credentials.yaml')
  })
})

describe('importFromDsh', () => {
  let dir: string
  let pool: AccountPool
  let credentials: FileCredentialStore

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'all-proxy-import-'))
    credentials = new FileCredentialStore(dir)
    pool = new AccountPool({ credentials, dataDir: dir })
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('导入账号与凭据', async () => {
    const home = makeDshHome({
      refs: {
        RACCOON_ACCOUNT_9ED45558: JSON.stringify({ access_token: 'tok-a', nickname: 'RaccoonMia' }),
        LOOMY_ACCOUNT_2288888D: JSON.stringify({ access_token: 'tok-b', nickname: '八戒' }),
      },
    })
    try {
      const result = await importFromDsh({ pool, credentials, paths: resolveDshPaths(home) })
      expect(result.added).toBe(2)
      expect(result.credentials).toBe(2)
      const accounts = await pool.listAllAccounts()
      expect(accounts.map(a => a.id).sort()).toEqual(['loomy-2288888d', 'raccoon-9ed45558'])
      expect(accounts.find(a => a.id === 'raccoon-9ed45558')?.nickname).toBe('RaccoonMia')
      // 凭据本体也导入了。
      expect((await credentials.resolve('RACCOON_ACCOUNT_9ED45558'))?.value).toContain('tok-a')
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  it('**幂等**：重复导入不产生重复账号', async () => {
    const home = makeDshHome({ refs: { BUDDY_ACCOUNT_AABBCC: '{"access_token":"t"}' } })
    try {
      const paths = resolveDshPaths(home)
      const first = await importFromDsh({ pool, credentials, paths })
      expect(first.added).toBe(1)
      const second = await importFromDsh({ pool, credentials, paths })
      expect(second.added).toBe(0)
      expect(second.updated).toBe(1)
      expect(await pool.listAllAccounts()).toHaveLength(1)
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  it('**保留用户在本项目里的启用状态**（导入不覆盖停用决定）', async () => {
    const home = makeDshHome({ refs: { BUDDY_ACCOUNT_AABBCC: '{"access_token":"t"}' } })
    try {
      const paths = resolveDshPaths(home)
      await importFromDsh({ pool, credentials, paths })
      await pool.updateAccount('buddy-aabbcc', { enabled: false })
      await importFromDsh({ pool, credentials, paths })
      // 停用是用户的决定，不该被一次导入悄悄改回启用。
      expect(pool.findAccount('buddy-aabbcc')?.enabled).toBe(false)
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  it('**导入模型黑名单**（否则会暴露用户刻意关闭的模型）', async () => {
    const home = makeDshHome({
      refs: { BUDDY_ACCOUNT_AABBCC: '{"access_token":"t"}' },
      disabledModels: {
        trae: { 'glm-5.2': true, 'kimi-k3': true, 'ignored-false': false },
        lobsterai: { 'deepseek-v4-pro': true },
      },
    })
    try {
      const result = await importFromDsh({ pool, credentials, paths: resolveDshPaths(home) })
      expect(result.disabledModelProviders).toBe(2)
      // 只导入显式 true 的项。
      expect([...pool.disabledModelsFor('trae')].sort()).toEqual(['glm-5.2', 'kimi-k3'])
      expect([...pool.disabledModelsFor('lobsterai')]).toEqual(['deepseek-v4-pro'])
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  it('**对一次性 refresh token 的 provider 给出警告**', async () => {
    const home = makeDshHome({
      refs: {
        CODEARTS_ACCOUNT_AABBCC: '{"access_key_id":"ak"}',
        TRAE_ACCOUNT_DDEEFF: '{"access_token":"t"}',
        BUDDY_ACCOUNT_112233: '{"access_token":"t"}',
      },
    })
    try {
      const result = await importFromDsh({ pool, credentials, paths: resolveDshPaths(home) })
      const joined = result.warnings.join('\n')
      expect(joined).toContain('codearts')
      expect(joined).toContain('trae')
      expect(joined).toContain('一次性轮换')
      // buddy 不是轮换型，不该出现在警告里。
      expect(joined).not.toMatch(/buddy/)
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  it('导入前备份现有数据（含凭据），且备份文件可读', async () => {
    const home = makeDshHome({ refs: { BUDDY_ACCOUNT_AABBCC: '{"access_token":"t"}' } })
    const backupDir = join(dir, 'backups')
    try {
      // 先放一个既有账号，验证备份确实捕获了它。
      await pool.addAccount({
        id: 'prior-1', provider: 'buddy', nickname: 'prior', enabled: true,
        credentialRef: 'BUDDY_ACCOUNT_PRIOR', createdAt: Date.now(), refreshable: true,
      })
      await credentials.set('BUDDY_ACCOUNT_PRIOR', '{"access_token":"prior"}')

      const result = await importFromDsh({
        pool, credentials, paths: resolveDshPaths(home), backupDir,
      })
      expect(result.backupPath).toBeDefined()
      expect(existsSync(result.backupPath!)).toBe(true)
      const backup = JSON.parse(readFileSync(result.backupPath!, 'utf-8')) as Record<string, unknown>
      expect((backup['state'] as { accounts: unknown[] }).accounts).toHaveLength(1)
      expect((backup['credentials'] as Record<string, string>)['BUDDY_ACCOUNT_PRIOR']).toContain('prior')
      expect(String(backup['warning'])).toContain('妥善保管')
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  it('状态文件缺失时导入账号但告警「模型开关未导入」', async () => {
    const home = makeDshHome({ refs: { BUDDY_ACCOUNT_AABBCC: '{"access_token":"t"}' }, stateMissing: true })
    try {
      const result = await importFromDsh({ pool, credentials, paths: resolveDshPaths(home) })
      expect(result.added).toBe(1)
      expect(result.warnings.join('\n')).toContain('模型开关未导入')
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  it('凭据文件不存在时抛出可读错误', async () => {
    await expect(importFromDsh({
      pool, credentials, paths: resolveDshPaths(join(dir, 'nonexistent')),
    })).rejects.toThrow(/未找到 DSH 凭据文件/)
  })

  it('refs 段为空时抛出可读错误', async () => {
    const home = mkdtempSync(join(tmpdir(), 'all-proxy-empty-'))
    writeFileSync(join(home, '.credentials.yaml'), 'version: 1\nrefs:\n', 'utf-8')
    try {
      await expect(importFromDsh({
        pool, credentials, paths: resolveDshPaths(home),
      })).rejects.toThrow(/refs 段为空/)
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  it('非账号凭据（API key）被跳过且**不导入**', async () => {
    const home = makeDshHome({
      refs: {
        BUDDY_ACCOUNT_AABBCC: '{"access_token":"t"}',
        OPENCODE_API_KEY: 'sk-xxx',
      },
    })
    try {
      const result = await importFromDsh({ pool, credentials, paths: resolveDshPaths(home) })
      expect(result.added).toBe(1)
      // ⚠️ 与本项目无关的凭据**不该**被复制过来：无用且扩大敏感面。
      expect(result.credentials).toBe(1)
      expect(await credentials.resolve('OPENCODE_API_KEY')).toBeUndefined()
      expect(result.skipped.join('\n')).toContain('OPENCODE_API_KEY')
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  it('导入各 provider 的单凭据回退 ref（供无账号池时使用）', async () => {
    const home = makeDshHome({
      refs: { RACCOON_ACCESS_TOKEN: '{"access_token":"single"}' },
    })
    try {
      const result = await importFromDsh({ pool, credentials, paths: resolveDshPaths(home) })
      expect(result.credentials).toBe(1)
      expect((await credentials.resolve('RACCOON_ACCESS_TOKEN'))?.value).toContain('single')
      // 它不是账号 ref，故不建账号条目。
      expect(result.added).toBe(0)
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  it('**绝不写入 DSH 数据文件**（导入前后内容逐字节一致）', async () => {
    const home = makeDshHome({
      refs: { BUDDY_ACCOUNT_AABBCC: '{"access_token":"t"}' },
      disabledModels: { trae: { m: true } },
    })
    try {
      const credPath = join(home, '.credentials.yaml')
      const statePath = join(home, 'jet-hub', 'state.json')
      const credBefore = readFileSync(credPath, 'utf-8')
      const stateBefore = readFileSync(statePath, 'utf-8')

      await importFromDsh({ pool, credentials, paths: resolveDshPaths(home) })

      expect(readFileSync(credPath, 'utf-8')).toBe(credBefore)
      expect(readFileSync(statePath, 'utf-8')).toBe(stateBefore)
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  it('保留本项目已有的全局开关与 provider 开关', async () => {
    const home = makeDshHome({ refs: { BUDDY_ACCOUNT_AABBCC: '{"access_token":"t"}' } })
    try {
      await pool.setGlobalModelsEnabled(false)
      await pool.setProviderEnabled('buddy', false)
      await importFromDsh({ pool, credentials, paths: resolveDshPaths(home) })
      expect(pool.globalModelsEnabled()).toBe(false)
      expect(pool.providerEnabled('buddy')).toBe(false)
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })
})
