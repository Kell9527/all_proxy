import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AccountPool } from '../../src/pool/account-pool.js'
import { FileCredentialStore } from '../../src/pool/store.js'
import { SWITCH_AUDIT_LIMIT, sanitizeSwitchAudit } from '../../src/pool/state-store.js'

describe('开关变更审计', () => {
  let dir: string
  let pool: AccountPool

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'all-proxy-audit-'))
    pool = new AccountPool({ credentials: new FileCredentialStore(dir), dataDir: dir })
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('初始为空', () => {
    expect(pool.switchAudit()).toEqual([])
  })

  it('记录全局开关变更', async () => {
    await pool.setGlobalModelsEnabled(false)
    const audit = pool.switchAudit()
    expect(audit).toHaveLength(1)
    expect(audit[0]).toMatchObject({ layer: 'global', target: '*', enabled: false })
    expect(audit[0]!.at).toMatch(/^\d{4}-\d{2}-\d{2}T/)
  })

  it('记录 provider 开关变更', async () => {
    await pool.setProviderEnabled('buddy', false)
    expect(pool.switchAudit()[0]).toMatchObject({ layer: 'provider', target: 'buddy', enabled: false })
  })

  it('记录单模型开关变更（含 provider/model 目标）', async () => {
    await pool.setModelDisabled('buddy', 'glm-5.2', true)
    expect(pool.switchAudit()[0]).toMatchObject({
      layer: 'model', target: 'buddy/glm-5.2', enabled: false,
    })
    // 重新打开也记录（enabled: true）。
    await pool.setModelDisabled('buddy', 'glm-5.2', false)
    const last = pool.switchAudit().at(-1)!
    expect(last).toMatchObject({ layer: 'model', target: 'buddy/glm-5.2', enabled: true })
  })

  it('按时间顺序累积（最新在后）', async () => {
    await pool.setModelDisabled('buddy', 'a', true)
    await pool.setModelDisabled('buddy', 'b', true)
    const targets = pool.switchAudit().map(e => e.target)
    expect(targets).toEqual(['buddy/a', 'buddy/b'])
  })

  it('**审计记录不含凭据**（只记元数据）', async () => {
    await new FileCredentialStore(dir).set('BUDDY_ACCOUNT_X', '{"access_token":"SECRET"}')
    await pool.setModelDisabled('buddy', 'm', true)
    const serialized = JSON.stringify(pool.switchAudit())
    expect(serialized).not.toContain('SECRET')
    expect(serialized).not.toContain('access_token')
  })

  it('跨实例持久化（重启后仍可查）', async () => {
    await pool.setModelDisabled('buddy', 'm', true)
    const reloaded = new AccountPool({ credentials: new FileCredentialStore(dir), dataDir: dir })
    expect(reloaded.switchAudit()).toHaveLength(1)
    expect(reloaded.switchAudit()[0]!.target).toBe('buddy/m')
  })

  it('超过上限时丢最旧的（不让状态文档无限膨胀）', async () => {
    for (let i = 0; i < SWITCH_AUDIT_LIMIT + 10; i++) {
      await pool.setModelDisabled('buddy', `m${i}`, true)
    }
    const audit = pool.switchAudit()
    expect(audit).toHaveLength(SWITCH_AUDIT_LIMIT)
    // 最旧的已被丢弃：`m0` 不在其中，最新的在。
    expect(audit.map(e => e.target)).not.toContain('buddy/m0')
    expect(audit.at(-1)!.target).toBe(`buddy/m${SWITCH_AUDIT_LIMIT + 9}`)
  })

  it('写账号列表不会抹掉审计记录（整体写入语义）', async () => {
    await pool.setModelDisabled('buddy', 'm', true)
    await pool.addAccount({
      id: 'a', provider: 'buddy', nickname: 'n', enabled: true,
      credentialRef: 'R', createdAt: Date.now(), refreshable: true,
    })
    expect(pool.switchAudit()).toHaveLength(1)
  })
})

describe('sanitizeSwitchAudit', () => {
  it('丢弃字段不合法的条目', () => {
    const result = sanitizeSwitchAudit([
      { at: '2026-01-01T00:00:00.000Z', layer: 'model', target: 'a/b', enabled: true },
      { at: '', layer: 'model', target: 'x', enabled: true },
      { at: '2026-01-01T00:00:00.000Z', layer: 'bogus', target: 'x', enabled: true },
      { at: '2026-01-01T00:00:00.000Z', layer: 'model', target: 'x', enabled: 'yes' },
      'not-an-object',
      null,
    ])
    expect(result).toHaveLength(1)
    expect(result[0]!.target).toBe('a/b')
  })

  it('非数组输入返回空表', () => {
    expect(sanitizeSwitchAudit(null)).toEqual([])
    expect(sanitizeSwitchAudit({ a: 1 })).toEqual([])
  })
})
