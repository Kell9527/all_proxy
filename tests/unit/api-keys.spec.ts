import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  API_KEY_PREFIX,
  ApiKeyStore,
  extractApiKey,
  generateApiKey,
  hashApiKey,
  sanitizeApiKeys,
} from '../../src/auth/api-keys.js'

/** 每个用例一个临时数据目录（**绝不碰真实 data/**）。 */
let dir: string
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'all-proxy-keys-')) })
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

/** 建一个空存储。 */
function store(): ApiKeyStore {
  return new ApiKeyStore(dir)
}

describe('API Key · 创建', () => {
  it('创建返回一次性明文与标识', () => {
    const s = store()
    const created = s.create({ name: '编辑器插件' })
    expect(created.plaintext.startsWith(API_KEY_PREFIX)).toBe(true)
    expect(created.summary.id).toMatch(/^key-[0-9a-f]{12}$/)
    expect(created.summary.name).toBe('编辑器插件')
    expect(created.summary.disabled).toBe(false)
  })

  it('每次创建都是不同的 key（不是同一个常量）', () => {
    const s = store()
    const a = s.create({ name: 'a' })
    const b = s.create({ name: 'b' })
    expect(a.plaintext).not.toBe(b.plaintext)
    expect(a.summary.id).not.toBe(b.summary.id)
  })

  it('名称留空时给一个可读的兜底名（而不是空串）', () => {
    expect(store().create({ name: '   ' }).summary.name).toBe('未命名')
  })

  it('**明文不落盘**：磁盘上只有哈希', () => {
    const s = store()
    const created = s.create({ name: 'x' })
    const onDisk = readFileSync(s.filePath, 'utf-8')
    expect(onDisk).not.toContain(created.plaintext)
    // 只有哈希出现在文件里。
    expect(onDisk).toContain(hashApiKey(created.plaintext))
  })

  it('**列表任何字段都不含完整明文**', () => {
    const s = store()
    const created = s.create({ name: 'x' })
    const serialized = JSON.stringify(s.list())
    expect(serialized).not.toContain(created.plaintext)
    // 连哈希都不该出现（它虽不可逆，但没必要暴露）。
    expect(serialized).not.toContain(hashApiKey(created.plaintext))
    for (const item of s.list()) {
      for (const value of Object.values(item)) {
        expect(String(value)).not.toBe(created.plaintext)
      }
    }
  })

  it('列表暴露前缀与长度，便于用户辨认手里这把', () => {
    const s = store()
    const created = s.create({ name: 'x' })
    const item = s.list()[0]!
    expect(item.prefix).toBe(created.plaintext.slice(0, 12))
    expect(created.plaintext.startsWith(item.prefix)).toBe(true)
    expect(item.keyLength).toBe(created.plaintext.length)
  })
})

describe('API Key · 校验', () => {
  it('正确明文校验通过', () => {
    const s = store()
    const created = s.create({ name: 'x' })
    const result = s.authenticate(created.plaintext)
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.context.id).toBe(created.summary.id)
  })

  it('错误明文被拒（且与「不存在」不可区分）', () => {
    const s = store()
    s.create({ name: 'x' })
    const result = s.authenticate(`${API_KEY_PREFIX}wrongwrongwrongwrongwrongwrongwrongwrong`)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.failure.kind).toBe('invalid')
  })

  it('空明文视为缺失凭据', () => {
    const result = store().authenticate('')
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.failure.kind).toBe('missing')
  })

  it('**前缀相同的近邻 key 不能通过**（前缀不是凭据）', () => {
    const s = store()
    const created = s.create({ name: 'x' })
    // 只改最后一个字符。
    const tampered = created.plaintext.slice(0, -1) + (created.plaintext.endsWith('A') ? 'B' : 'A')
    expect(s.authenticate(tampered).ok).toBe(false)
  })
})

describe('API Key · 禁用与删除', () => {
  it('禁用后请求被拒', () => {
    const s = store()
    const created = s.create({ name: 'x' })
    s.update(created.summary.id, { disabled: true })
    const result = s.authenticate(created.plaintext)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.failure.kind).toBe('disabled')
  })

  it('重新启用后可用', () => {
    const s = store()
    const created = s.create({ name: 'x' })
    s.update(created.summary.id, { disabled: true })
    s.update(created.summary.id, { disabled: false })
    expect(s.authenticate(created.plaintext).ok).toBe(true)
  })

  it('**作废一把不影响其他 key**', () => {
    const s = store()
    const a = s.create({ name: 'a' })
    const b = s.create({ name: 'b' })
    s.remove(a.summary.id)
    expect(s.authenticate(a.plaintext).ok).toBe(false)
    expect(s.authenticate(b.plaintext).ok).toBe(true)
    expect(s.list().map(k => k.id)).toEqual([b.summary.id])
  })

  it('删除后不可恢复（明文再也换不回条目）', () => {
    const s = store()
    const created = s.create({ name: 'x' })
    expect(s.remove(created.summary.id)).toBe(true)
    expect(s.remove(created.summary.id)).toBe(false)
    expect(s.authenticate(created.plaintext).ok).toBe(false)
  })

  it('删除不存在的 id 返回 false 而不抛错', () => {
    expect(store().remove('key-nope')).toBe(false)
  })
})

describe('API Key · 持久化', () => {
  it('重启后 key 仍然有效', () => {
    const first = store()
    const created = first.create({ name: 'x' })
    // 新实例读同一目录（模拟重启）。
    const second = new ApiKeyStore(dir)
    expect(second.authenticate(created.plaintext).ok).toBe(true)
    expect(second.list()).toHaveLength(1)
  })

  it('额度计数跨重启保留', () => {
    const first = store()
    const created = first.create({ name: 'x', quotaTokens: 1000 })
    first.recordUsage(created.summary.id, 250)
    const second = new ApiKeyStore(dir)
    expect(second.list()[0]!.usedTokens).toBe(250)
  })

  it('文档损坏时视为空表（而不是让整份 key 表读不出来）', () => {
    writeFileSync(join(dir, 'api-keys.json'), '{ 这不是 JSON', 'utf-8')
    expect(store().list()).toEqual([])
  })

  it('坏条目被丢弃、好条目保留', () => {
    const records = sanitizeApiKeys([
      { id: 'good', hash: 'a'.repeat(64), name: 'ok' },
      { id: '', hash: 'b'.repeat(64) },
      { hash: 'c'.repeat(64) },
      null,
      'string',
      { id: 'dup', hash: 'd'.repeat(64) },
      { id: 'dup', hash: 'e'.repeat(64) },
    ])
    expect(records.map(r => r.id)).toEqual(['good', 'dup'])
  })
})

describe('API Key · 范围白名单', () => {
  it('未配置范围 = 不限制', () => {
    const s = store()
    const created = s.create({ name: 'x' })
    const record = s.find(created.summary.id)!
    expect(record.providers).toBeUndefined()
    expect(record.models).toBeUndefined()
  })

  it('provider 白名单被持久化', () => {
    const s = store()
    const created = s.create({ name: 'x', providers: ['raccoon'] })
    expect(new ApiKeyStore(dir).find(created.summary.id)?.providers).toEqual(['raccoon'])
  })

  it('模型白名单被持久化', () => {
    const s = store()
    const created = s.create({ name: 'x', models: ['raccoon/sn-glm-5-3'] })
    expect(new ApiKeyStore(dir).find(created.summary.id)?.models).toEqual(['raccoon/sn-glm-5-3'])
  })

  it('**空数组与「未配置」语义不同**（空数组 = 什么都不许）', () => {
    const s = store()
    const created = s.create({ name: 'x', providers: [] })
    const record = new ApiKeyStore(dir).find(created.summary.id)!
    expect(record.providers).toEqual([])
    expect(record.providers).not.toBeUndefined()
  })

  it('修改范围可清除（null → 恢复不限制）', () => {
    const s = store()
    const created = s.create({ name: 'x', providers: ['raccoon'] })
    s.update(created.summary.id, { providers: undefined })
    expect(s.find(created.summary.id)?.providers).toBeUndefined()
  })
})

describe('API Key · 速率限制', () => {
  it('未配置速率 = 不限', () => {
    const s = store()
    const created = s.create({ name: 'x' })
    for (let i = 0; i < 100; i++) expect(s.authenticate(created.plaintext).ok).toBe(true)
  })

  it('超过每分钟上限后返回可重试的等待时间', () => {
    const s = store()
    const created = s.create({ name: 'x', rateLimitPerMinute: 3 })
    for (let i = 0; i < 3; i++) expect(s.authenticate(created.plaintext).ok).toBe(true)
    const over = s.authenticate(created.plaintext)
    expect(over.ok).toBe(false)
    if (!over.ok) {
      expect(over.failure.kind).toBe('rate_limited')
      if (over.failure.kind === 'rate_limited') {
        expect(over.failure.retryAfterMs).toBeGreaterThan(0)
        expect(over.failure.retryAfterMs).toBeLessThanOrEqual(60_000)
      }
    }
  })

  it('超限的请求**不占用**窗口（否则会无限延长封锁）', () => {
    const s = store()
    const created = s.create({ name: 'x', rateLimitPerMinute: 2 })
    s.authenticate(created.plaintext)
    s.authenticate(created.plaintext)
    const first = s.authenticate(created.plaintext)
    const second = s.authenticate(created.plaintext)
    expect(first.ok).toBe(false)
    expect(second.ok).toBe(false)
    if (!first.ok && !second.ok && first.failure.kind === 'rate_limited' && second.failure.kind === 'rate_limited') {
      // 两次被拒的等待时间应当一致（窗口没有被后续失败请求推后）。
      expect(second.failure.retryAfterMs).toBeLessThanOrEqual(first.failure.retryAfterMs)
    }
  })

  it('不同 key 的窗口互相独立', () => {
    const s = store()
    const a = s.create({ name: 'a', rateLimitPerMinute: 1 })
    const b = s.create({ name: 'b', rateLimitPerMinute: 1 })
    expect(s.authenticate(a.plaintext).ok).toBe(true)
    expect(s.authenticate(a.plaintext).ok).toBe(false)
    // a 用完了不该影响 b。
    expect(s.authenticate(b.plaintext).ok).toBe(true)
  })
})

describe('API Key · 额度限制', () => {
  it('未配置额度 = 不限', () => {
    const s = store()
    const created = s.create({ name: 'x' })
    s.recordUsage(created.summary.id, 10_000_000)
    expect(s.authenticate(created.plaintext).ok).toBe(true)
  })

  it('额度用尽后拒绝', () => {
    const s = store()
    const created = s.create({ name: 'x', quotaTokens: 100 })
    s.recordUsage(created.summary.id, 100)
    const result = s.authenticate(created.plaintext)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.failure.kind).toBe('quota_exhausted')
  })

  it('未达额度时放行', () => {
    const s = store()
    const created = s.create({ name: 'x', quotaTokens: 100 })
    s.recordUsage(created.summary.id, 99)
    expect(s.authenticate(created.plaintext).ok).toBe(true)
  })

  it('累计用量单调递增', () => {
    const s = store()
    const created = s.create({ name: 'x', quotaTokens: 1000 })
    s.recordUsage(created.summary.id, 10)
    s.recordUsage(created.summary.id, 20)
    expect(s.find(created.summary.id)?.usedTokens).toBe(30)
  })

  it('重置额度后可再次使用', () => {
    const s = store()
    const created = s.create({ name: 'x', quotaTokens: 100 })
    s.recordUsage(created.summary.id, 100)
    expect(s.authenticate(created.plaintext).ok).toBe(false)
    s.resetUsage(created.summary.id)
    expect(s.authenticate(created.plaintext).ok).toBe(true)
  })
})

describe('API Key · 请求头提取', () => {
  it('接受 Authorization: Bearer', () => {
    expect(extractApiKey({ authorization: 'Bearer sk-all-abc' })).toBe('sk-all-abc')
  })

  it('接受 x-api-key', () => {
    expect(extractApiKey({ 'x-api-key': 'sk-all-abc' })).toBe('sk-all-abc')
  })

  it('**两种携带方式等价**', () => {
    const viaBearer = extractApiKey({ authorization: 'Bearer sk-all-same' })
    const viaHeader = extractApiKey({ 'x-api-key': 'sk-all-same' })
    expect(viaBearer).toBe(viaHeader)
  })

  it('Bearer 大小写不敏感', () => {
    expect(extractApiKey({ authorization: 'bearer sk-all-abc' })).toBe('sk-all-abc')
    expect(extractApiKey({ authorization: 'BEARER sk-all-abc' })).toBe('sk-all-abc')
  })

  it('两者都带且不一致时以标准头为准', () => {
    expect(extractApiKey({ authorization: 'Bearer sk-all-a', 'x-api-key': 'sk-all-b' })).toBe('sk-all-a')
  })

  it('Authorization 不是 Bearer 形式时回退到 x-api-key', () => {
    expect(extractApiKey({ authorization: 'Basic dXNlcjpwYXNz', 'x-api-key': 'sk-all-b' })).toBe('sk-all-b')
  })

  it('都没有时返回空串', () => {
    expect(extractApiKey({})).toBe('')
  })

  it('多值头取第一个', () => {
    expect(extractApiKey({ 'x-api-key': ['sk-all-first', 'sk-all-second'] })).toBe('sk-all-first')
  })

  it('两端空白被去掉', () => {
    expect(extractApiKey({ 'x-api-key': '  sk-all-abc  ' })).toBe('sk-all-abc')
  })
})

describe('API Key · 明文生成', () => {
  it('长度与熵稳定', () => {
    const keys = Array.from({ length: 50 }, () => generateApiKey())
    expect(new Set(keys).size).toBe(50)
    for (const key of keys) {
      expect(key.startsWith(API_KEY_PREFIX)).toBe(true)
      expect(key.length).toBe(API_KEY_PREFIX.length + 43)
    }
  })

  it('哈希稳定且区分大小写', () => {
    expect(hashApiKey('abc')).toBe(hashApiKey('abc'))
    expect(hashApiKey('abc')).not.toBe(hashApiKey('ABC'))
    expect(hashApiKey('abc')).toMatch(/^[0-9a-f]{64}$/)
  })
})
