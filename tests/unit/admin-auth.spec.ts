import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AdminAuth, MIN_ADMIN_SECRET_LENGTH, assertAdminSafety, extractAdminSecret, hashSecret, isLoopbackHost } from '../../src/admin/auth.js'
import type { IncomingMessage } from 'node:http'

let dir: string
const savedSecret = process.env['ALL_PROXY_ADMIN_SECRET']
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'all-proxy-admin-'))
  delete process.env['ALL_PROXY_ADMIN_SECRET']
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
  if (savedSecret === undefined) delete process.env['ALL_PROXY_ADMIN_SECRET']
  else process.env['ALL_PROXY_ADMIN_SECRET'] = savedSecret
})

/** 造一个最小请求对象（只用到 headers）。 */
function reqWith(headers: Record<string, string | string[] | undefined>): IncomingMessage {
  return { headers } as IncomingMessage
}

describe('管理凭据 · 首次生成', () => {
  it('首次启动自动生成并返回一次性明文', () => {
    const auth = new AdminAuth(dir)
    const secret = auth.ensure()
    expect(secret).toBeTypeOf('string')
    expect((secret ?? '').length).toBeGreaterThanOrEqual(20)
    expect(auth.verify(secret!)).toBe(true)
  })

  it('**明文不落盘**（磁盘上只有哈希）', () => {
    const auth = new AdminAuth(dir)
    const secret = auth.ensure()!
    const onDisk = readFileSync(auth.filePath, 'utf-8')
    expect(onDisk).not.toContain(secret)
    expect(onDisk).toContain(hashSecret(secret))
  })

  it('第二次启动不再返回明文（复用已有凭据）', () => {
    const first = new AdminAuth(dir)
    const secret = first.ensure()!
    const second = new AdminAuth(dir)
    expect(second.ensure()).toBeUndefined()
    // 但口令仍然有效。
    expect(second.verify(secret)).toBe(true)
  })

  it('重启后旧口令失效仅当重新生成（不会静默换口令）', () => {
    const first = new AdminAuth(dir)
    const secret = first.ensure()!
    const second = new AdminAuth(dir)
    second.ensure()
    expect(second.verify(secret)).toBe(true)
  })

  it('凭据文件损坏时视为未配置（而不是启动崩溃）', () => {
    writeFileSync(join(dir, 'admin-credential.json'), 'not json at all', 'utf-8')
    const auth = new AdminAuth(dir)
    // 损坏 → load 返回 undefined → ensure 走「已有文件」分支，不覆盖也不崩。
    expect(() => auth.ensure()).not.toThrow()
    expect(auth.verify('anything')).toBe(false)
  })
})

describe('管理凭据 · 环境变量优先', () => {
  it('环境变量设置的口令生效且不返回一次性明文', () => {
    process.env['ALL_PROXY_ADMIN_SECRET'] = 'a-very-long-admin-secret'
    const auth = new AdminAuth(dir)
    expect(auth.ensure()).toBeUndefined()
    expect(auth.verify('a-very-long-admin-secret')).toBe(true)
  })

  it('环境变量覆盖已有文件里的口令', () => {
    const first = new AdminAuth(dir)
    const old = first.ensure()!
    process.env['ALL_PROXY_ADMIN_SECRET'] = 'brand-new-admin-secret-value'
    const second = new AdminAuth(dir)
    second.ensure()
    expect(second.verify('brand-new-admin-secret-value')).toBe(true)
    expect(second.verify(old)).toBe(false)
  })

  it('**环境变量口令太短时拒绝启动**（能导出全部凭据的东西不能用短口令）', () => {
    process.env['ALL_PROXY_ADMIN_SECRET'] = 'short'
    expect(() => new AdminAuth(dir).ensure()).toThrow(/太短/)
  })

  it('**默认档（对外监听）12 位**：11 位也拒', () => {
    process.env['ALL_PROXY_ADMIN_SECRET'] = 'a'.repeat(11)
    expect(() => new AdminAuth(dir).ensure()).toThrow(/至少 12/)
  })

  it('**本机档放宽到 4 位**：serve 对本机监听传 minSecretLength=4', () => {
    process.env['ALL_PROXY_ADMIN_SECRET'] = '1234'
    const auth = new AdminAuth(dir)
    // 不传参数仍按 12 拒；显式传 4 才放行（对外监听不可放松）。
    expect(() => auth.ensure()).toThrow(/太短/)
    const bootstrap = auth.ensure(undefined, { minSecretLength: 4 })
    expect(bootstrap).toBeUndefined()
    // 落盘哈希与 4 位口令匹配，且不再视为自动生成。
    expect(auth.verify('1234')).toBe(true)
    expect(auth.verify('4321')).toBe(false)
  })
})

describe('管理凭据 · 校验', () => {
  it('错误口令被拒', () => {
    const auth = new AdminAuth(dir)
    const secret = auth.ensure()!
    expect(auth.verify(secret + 'x')).toBe(false)
    expect(auth.verify('')).toBe(false)
  })

  it('大小写敏感', () => {
    process.env['ALL_PROXY_ADMIN_SECRET'] = 'CaseSensitiveSecret123'
    const auth = new AdminAuth(dir)
    auth.ensure()
    expect(auth.verify('casesensitivesecret123')).toBe(false)
    expect(auth.verify('CaseSensitiveSecret123')).toBe(true)
  })

  it('未配置凭据时任何口令都被拒', () => {
    // 直接构造但不 ensure：此时没有凭据文件。
    expect(new AdminAuth(dir).verify('anything')).toBe(false)
  })
})

describe('监听地址安全', () => {
  it('识别本机地址', () => {
    for (const host of ['127.0.0.1', 'localhost', '::1', '[::1]', '  127.0.0.1  ']) {
      expect(isLoopbackHost(host), `${host} 应被识别为本机`).toBe(true)
    }
  })

  it('**`0.0.0.0` 与 `::` 不是本机限定**（它们监听全部网卡）', () => {
    for (const host of ['0.0.0.0', '::', '192.168.1.5', 'example.com']) {
      expect(isLoopbackHost(host), `${host} 不应被识别为本机`).toBe(false)
    }
  })

  it('本机监听时无需管理口令', () => {
    const auth = new AdminAuth(dir)
    auth.ensure()
    expect(() => assertAdminSafety('127.0.0.1', auth)).not.toThrow()
  })

  it('**对外监听且未设口令时拒绝启动**', () => {
    const auth = new AdminAuth(dir)
    auth.ensure()
    expect(() => assertAdminSafety('0.0.0.0', auth)).toThrow(/ALL_PROXY_ADMIN_SECRET/)
  })

  it('对外监听 + 已设环境变量口令 → 放行并警告', () => {
    process.env['ALL_PROXY_ADMIN_SECRET'] = 'long-enough-admin-secret'
    const auth = new AdminAuth(dir)
    auth.ensure()
    const warnings: string[] = []
    expect(() => assertAdminSafety('0.0.0.0', auth, { info: () => {}, warn: m => warnings.push(m), error: () => {} })).not.toThrow()
    expect(warnings.some(w => w.includes('非本机'))).toBe(true)
  })

  it('最小口令长度是一个明确的常量（文档与校验共用）', () => {
    expect(MIN_ADMIN_SECRET_LENGTH).toBe(12)
    process.env['ALL_PROXY_ADMIN_SECRET'] = 'x'.repeat(MIN_ADMIN_SECRET_LENGTH)
    expect(() => new AdminAuth(dir).ensure()).not.toThrow()
    process.env['ALL_PROXY_ADMIN_SECRET'] = 'x'.repeat(MIN_ADMIN_SECRET_LENGTH - 1)
    expect(() => new AdminAuth(dir).ensure()).toThrow()
  })
})

describe('管理口令提取', () => {
  it('从 Authorization: Bearer 提取', () => {
    expect(extractAdminSecret(reqWith({ authorization: 'Bearer my-admin-secret' }))).toBe('my-admin-secret')
  })

  it('从 x-admin-secret 提取', () => {
    expect(extractAdminSecret(reqWith({ 'x-admin-secret': 'my-admin-secret' }))).toBe('my-admin-secret')
  })

  it('Bearer 优先于 x-admin-secret', () => {
    expect(extractAdminSecret(reqWith({ authorization: 'Bearer from-bearer', 'x-admin-secret': 'from-header' }))).toBe('from-bearer')
  })

  it('从查询参数提取（用于首次在浏览器打开页面）', () => {
    expect(extractAdminSecret(reqWith({}), new URL('http://x/api/keys?admin_secret=from-query'))).toBe('from-query')
  })

  it('都没有时返回空串', () => {
    expect(extractAdminSecret(reqWith({}))).toBe('')
  })

  it('多值头取第一个', () => {
    expect(extractAdminSecret(reqWith({ 'x-admin-secret': ['first', 'second'] }))).toBe('first')
  })
})

describe('管理操作留痕', () => {
  it('记录操作名、目标与成败', () => {
    const auth = new AdminAuth(dir)
    auth.ensure()
    auth.record('create-key', 'key-abc', true)
    auth.record('delete-account', 'raccoon-1', false)
    const entries = auth.entries()
    expect(entries).toHaveLength(2)
    expect(entries[0]!.action).toBe('create-key')
    expect(entries[0]!.target).toBe('key-abc')
    expect(entries[0]!.ok).toBe(true)
    expect(entries[1]!.ok).toBe(false)
    expect(entries[0]!.at).toMatch(/^\d{4}-\d{2}-\d{2}T/)
  })

  it('留痕数量有上限（诊断信息不该无限增长）', () => {
    const auth = new AdminAuth(dir)
    auth.ensure()
    for (let i = 0; i < 600; i++) auth.record('op', `target-${i}`, true)
    expect(auth.entries().length).toBeLessThanOrEqual(500)
    // 保留的是最近的。
    expect(auth.entries().at(-1)!.target).toBe('target-599')
  })

  it('凭据文件路径可断言（供备份与诊断）', () => {
    const auth = new AdminAuth(dir)
    expect(auth.filePath).toBe(join(dir, 'admin-credential.json'))
    expect(existsSync(auth.filePath)).toBe(false)
    auth.ensure()
    expect(existsSync(auth.filePath)).toBe(true)
  })
})
