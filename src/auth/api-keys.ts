/**
 * 多 API Key 的创建、校验与范围/限额判定。
 *
 * ## 明文只出现一次
 *
 * key 的明文**只在创建响应里返回一次**，落盘的是 `sha256(明文)`。
 * 列表接口只回 `prefix`（明文前 12 字符）供人辨认，
 * **任何字段都不含可用于还原或直接调用的完整明文**。
 *
 * 为什么用哈希而不是对称加密：本服务没有「找回 key」的需求（丢了就重建），
 * 而加密意味着密钥必须与密文放在同一台机器上 —— 攻击者拿到 `data/` 时两者
 * 一起拿到，等于没加密。哈希则是单向的。
 *
 * ## 校验恒定耗时
 *
 * 比对用 `timingSafeEqual`。虽然 sha256 之后按哈希查表本身就是等长的，
 * 但「先按前缀缩小候选再比对」这类优化会引入时间差，故这里直接对**全部**
 * 条目做定长哈希比对（key 数量是个位数，代价可忽略）。
 */

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { join } from 'node:path'
import { readJsonFile, writeFileAtomic, type Logger } from '../pool/store.js'
import { scopeAllows } from '../shared/model-scope.js'

/** key 明文前缀；便于人一眼认出这是本服务的 key。 */
export const API_KEY_PREFIX = 'sk-all-'

/** 落盘文档结构。 */
export interface ApiKeyRecord {
  /** 内部标识（同时是管理端引用该 key 的句柄）。 */
  id: string
  /** 用户可读名称。 */
  name: string
  /**
   * 明文前 12 字符。
   *
   * 用于列表展示「这把是哪把」。12 字符里含 `sk-all-` 这 7 个固定字符，
   * 剩余 5 个随机字符（base64url，约 30 bit）不足以在离线爆破中还原出
   * 43 字符的密钥本体。
   */
  prefix: string
  /** `sha256(明文)` 的 hex。**这是唯一的校验依据**。 */
  hash: string
  createdAt: string
  /** 是否已禁用（禁用后请求被拒，但条目保留以便审计与恢复）。 */
  disabled: boolean
  /** 最近一次成功使用的时刻（ISO）。 */
  lastUsedAt?: string
  /**
   * 可访问的 provider 白名单；省略 = 不限制。
   *
   * 空数组与省略**语义不同**：空数组表示「一个都不许」，省略表示「全部允许」。
   */
  providers?: string[]
  /**
   * 可访问的模型白名单（完整 ref `<provider>/<model>`，支持 `<provider>/*` 通配）；
   * 省略 = 不限制。
   */
  models?: string[]
  /** 速率限制：每分钟允许的请求数；省略 = 不限。 */
  rateLimitPerMinute?: number
  /**
   * 额度限制：累计可用 token 数；省略 = 不限。
   *
   * ⚠️ 计数是**单调递增**的累计值（含 prompt + completion），由用量模块在
   * 每次请求结束后回填。刻意不做「按天重置」——额度是总量配额，
   * 需要周期性恢复的场景应改用速率限制。
   */
  quotaTokens?: number
  /** 已消耗的 token 累计（由 {@link ApiKeyStore.recordUsage} 维护）。 */
  usedTokens: number
}

/** 列表项（**不含 hash**）。 */
export interface ApiKeySummary {
  id: string
  name: string
  prefix: string
  createdAt: string
  disabled: boolean
  lastUsedAt?: string
  providers?: string[]
  models?: string[]
  rateLimitPerMinute?: number
  quotaTokens?: number
  usedTokens: number
  /** 明文长度，便于用户确认自己手里的 key 形状正确。 */
  keyLength: number
}

/** 创建结果：含**一次性明文**。 */
export interface CreatedApiKey {
  /** 明文。调用方必须立即展示给用户，之后无处可取。 */
  plaintext: string
  summary: ApiKeySummary
}

/** 校验通过后得到的调用上下文。 */
export interface ApiKeyContext {
  id: string
  name: string
  record: ApiKeyRecord
}

/** 校验失败的原因（对外统一为 401，不区分细节）。 */
export type ApiKeyFailure =
  | { kind: 'missing' }
  | { kind: 'invalid' }
  | { kind: 'disabled' }
  | { kind: 'rate_limited'; retryAfterMs: number }
  | { kind: 'quota_exhausted' }

/** 创建参数。 */
export interface CreateApiKeyInput {
  name: string
  providers?: readonly string[]
  models?: readonly string[]
  rateLimitPerMinute?: number
  quotaTokens?: number
}

/** 生成一把新 key 的明文。 */
export function generateApiKey(): string {
  // 32 字节 → base64url 43 字符。熵远超暴力破解可行范围。
  return `${API_KEY_PREFIX}${randomBytes(32).toString('base64url')}`
}

/** 计算校验用哈希。 */
export function hashApiKey(plaintext: string): string {
  return createHash('sha256').update(plaintext, 'utf8').digest('hex')
}

/**
 * 把持久化文档归一化。
 *
 * 文档可能被手工编辑过：坏条目直接丢弃，而不是让整份 key 表读不出来
 * （那会让所有客户端同时 401，且用户不知道原因）。
 */
export function sanitizeApiKeys(raw: unknown): ApiKeyRecord[] {
  if (!Array.isArray(raw)) return []
  const out: ApiKeyRecord[] = []
  const seen = new Set<string>()
  for (const entry of raw) {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) continue
    const c = entry as Partial<ApiKeyRecord>
    if (typeof c.id !== 'string' || c.id.length === 0) continue
    if (typeof c.hash !== 'string' || c.hash.length === 0) continue
    // id 重复会让「按 id 删除」误伤，直接丢弃后一条。
    if (seen.has(c.id)) continue
    seen.add(c.id)
    out.push({
      id: c.id,
      name: typeof c.name === 'string' && c.name.length > 0 ? c.name : c.id,
      prefix: typeof c.prefix === 'string' ? c.prefix : '',
      hash: c.hash,
      createdAt: typeof c.createdAt === 'string' ? c.createdAt : new Date().toISOString(),
      disabled: c.disabled === true,
      ...typeof c.lastUsedAt === 'string' ? { lastUsedAt: c.lastUsedAt } : {},
      ...sanitizeScope(c.providers, 'providers'),
      ...sanitizeScope(c.models, 'models'),
      ...sanitizePositive(c.rateLimitPerMinute, 'rateLimitPerMinute'),
      ...sanitizePositive(c.quotaTokens, 'quotaTokens'),
      usedTokens: typeof c.usedTokens === 'number' && Number.isFinite(c.usedTokens) && c.usedTokens > 0
        ? Math.floor(c.usedTokens)
        : 0,
    })
  }
  return out
}

/**
 * 归一化范围字段。
 *
 * ⚠️ **必须区分「省略」与「空数组」**：省略 = 不限制，空数组 = 什么都不许。
 * 若把空数组也当成「未配置」，用户刻意设成「禁止一切」的 key 会变成万能 key。
 */
function sanitizeScope(value: unknown, key: 'providers' | 'models'): Pick<ApiKeyRecord, 'providers'> | Pick<ApiKeyRecord, 'models'> | Record<string, never> {
  if (!Array.isArray(value)) return {}
  const items = value.filter((v): v is string => typeof v === 'string' && v.trim().length > 0).map(v => v.trim())
  // 去重但保持顺序。
  const unique = [...new Set(items)]
  return { [key]: unique } as Pick<ApiKeyRecord, 'providers'>
}

/** 归一化正整数限制字段；非法或非正数视为「未配置」。 */
function sanitizePositive(value: unknown, key: 'rateLimitPerMinute' | 'quotaTokens'): Record<string, number> {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return {}
  return { [key]: Math.floor(value) }
}

/**
 * 判断某模型是否落在 key 的授权范围内。
 *
 * ⚠️ **刻意转发到共享实现**（`shared/model-scope.ts`），而不是在这里重写一遍：
 * 两处判定一旦分叉，会出现「目录里看得到、调用时被拒」这类自相矛盾的行为，
 * 且很难排查。`ApiKeyRecord` 的 `providers` / `models` 与 `ModelScope`
 * 结构兼容，直接传入即可。
 */
export function keyScopeAllows(record: ApiKeyRecord, provider: string, model: string): boolean {
  // 显式取字段而不是把整个记录传进去：记录上还有 hash / usedTokens 等字段，
  // 传整个对象会让「哪些字段参与授权判定」变得隐晦。
  return scopeAllows({ providers: record.providers, models: record.models }, provider, model)
}

/**
 * 多 API Key 存储与校验。
 *
 * 内存持有权威副本，写路径「改内存 → 整体落盘（原子写）」。
 */
export class ApiKeyStore {
  private readonly path: string
  private cache: ApiKeyRecord[] | undefined
  /**
   * 速率限制的滑动窗口：key id → 最近若干次请求的时间戳（毫秒）。
   *
   * ⚠️ **刻意不持久化**：这是「每分钟」级别的瞬时状态，重启后清零是合理
   * 且更安全的（重启不该让客户端继续被上一轮计数惩罚）。额度则是累计量，
   * 必须持久化。
   */
  private readonly windows = new Map<string, number[]>()

  constructor(
    dataDir: string,
    private readonly logger: Logger = { info: () => {}, warn: () => {}, error: () => {} },
    filename = 'api-keys.json',
  ) {
    this.path = join(dataDir, filename)
  }

  /** 落盘路径（供备份与测试断言）。 */
  get filePath(): string {
    return this.path
  }

  private ensureLoaded(): ApiKeyRecord[] {
    if (this.cache !== undefined) return this.cache
    this.cache = sanitizeApiKeys(readJsonFile<unknown>(this.path, this.logger))
    return this.cache
  }

  private persist(records: ApiKeyRecord[]): void {
    this.cache = records
    writeFileAtomic(this.path, JSON.stringify(records, null, 2))
  }

  /** 列出全部 key（**不含 hash 与明文**）。 */
  list(): ApiKeySummary[] {
    return this.ensureLoaded().map(toSummary)
  }

  /** 按 id 取原始记录（管理端内部用；**不要**把它序列化给客户端）。 */
  find(id: string): ApiKeyRecord | undefined {
    return this.ensureLoaded().find(r => r.id === id)
  }

  /**
   * 创建一把 key。
   *
   * @returns 一次性明文与摘要。明文**不落盘**，此后无从取回。
   */
  create(input: CreateApiKeyInput): CreatedApiKey {
    const records = this.ensureLoaded()
    const plaintext = generateApiKey()
    const record: ApiKeyRecord = {
      id: `key-${randomBytes(6).toString('hex')}`,
      name: input.name.trim().length > 0 ? input.name.trim() : '未命名',
      prefix: plaintext.slice(0, 12),
      hash: hashApiKey(plaintext),
      createdAt: new Date().toISOString(),
      disabled: false,
      usedTokens: 0,
      ...input.providers === undefined ? {} : { providers: [...input.providers] },
      ...input.models === undefined ? {} : { models: [...input.models] },
      ...input.rateLimitPerMinute === undefined ? {} : { rateLimitPerMinute: input.rateLimitPerMinute },
      ...input.quotaTokens === undefined ? {} : { quotaTokens: input.quotaTokens },
    }
    this.persist([...records, record])
    return { plaintext, summary: toSummary(record) }
  }

  /** 修改范围与限额（不改明文，也无从改）。 */
  update(id: string, patch: Partial<Pick<ApiKeyRecord, 'name' | 'disabled' | 'providers' | 'models' | 'rateLimitPerMinute' | 'quotaTokens'>>): ApiKeySummary {
    const records = this.ensureLoaded()
    const idx = records.findIndex(r => r.id === id)
    if (idx === -1) throw new Error(`API Key ${id} 不存在`)
    const current = records[idx]!
    // ⚠️ 显式 `undefined` 表示「清除该限制」，因此不能简单展开 patch
    // （`{...current, ...patch}` 对显式 undefined 会写入 undefined，语义上
    // 等价于删除，但会让 JSON.stringify 丢掉该键 —— 结果正确，但可读性差）。
    const next: ApiKeyRecord = { ...current }
    if (patch.name !== undefined) next.name = patch.name
    if (patch.disabled !== undefined) next.disabled = patch.disabled
    for (const key of ['providers', 'models', 'rateLimitPerMinute', 'quotaTokens'] as const) {
      if (!Object.prototype.hasOwnProperty.call(patch, key)) continue
      const value = patch[key]
      if (value === undefined) delete next[key]
      else (next as unknown as Record<string, unknown>)[key] = value
    }
    const updated = [...records]
    updated[idx] = next
    this.persist(updated)
    // 解除禁用时清掉速率窗口：否则刚恢复的 key 会立刻吃到禁用前的计数。
    if (patch.disabled === false) this.windows.delete(id)
    return toSummary(next)
  }

  /** 删除一把 key（不可恢复）。 */
  remove(id: string): boolean {
    const records = this.ensureLoaded()
    const next = records.filter(r => r.id !== id)
    if (next.length === records.length) return false
    this.persist(next)
    this.windows.delete(id)
    return true
  }

  /**
   * 校验入站凭据。
   *
   * 判定顺序：**是否存在 → 是否禁用 → 速率 → 额度**。
   *
   * ⚠️ 前三类失败对外**统一成 401**（见 `access-control` 规格：错误消息不得
   * 泄露「该 key 是否存在」）。速率与额度是 429，因为那时 key 已被证实有效，
   * 告诉持有者「稍后再试 / 额度已尽」不构成信息泄露，反而是必需的。
   *
   * @param plaintext - 从请求头提取到的 key 明文。
   */
  authenticate(plaintext: string): { ok: true; context: ApiKeyContext } | { ok: false; failure: ApiKeyFailure } {
    if (plaintext.length === 0) return { ok: false, failure: { kind: 'missing' } }
    const records = this.ensureLoaded()
    const candidate = hashApiKey(plaintext)
    // 对全部条目做定长比对，不做「按前缀缩小候选」的优化（那会引入时间差）。
    let matched: ApiKeyRecord | undefined
    for (const record of records) {
      if (constantTimeEqualsHex(record.hash, candidate)) { matched = record; break }
    }
    // 存在性未知时统一按 invalid 处理：不区分「不存在」与「哈希不符」。
    if (matched === undefined) return { ok: false, failure: { kind: 'invalid' } }
    if (matched.disabled) return { ok: false, failure: { kind: 'disabled' } }

    const rate = this.checkRateLimit(matched)
    if (rate !== undefined) return { ok: false, failure: rate }

    if (matched.quotaTokens !== undefined && matched.usedTokens >= matched.quotaTokens) {
      return { ok: false, failure: { kind: 'quota_exhausted' } }
    }

    return { ok: true, context: { id: matched.id, name: matched.name, record: matched } }
  }

  /**
   * 检查并记录一次速率窗口。
   *
   * @returns 超限时返回失败原因（含建议等待毫秒），否则 `undefined`。
   */
  private checkRateLimit(record: ApiKeyRecord): { kind: 'rate_limited'; retryAfterMs: number } | undefined {
    const limit = record.rateLimitPerMinute
    if (limit === undefined) return undefined
    const now = Date.now()
    const windowMs = 60_000
    const recent = (this.windows.get(record.id) ?? []).filter(t => now - t < windowMs)
    if (recent.length >= limit) {
      // 最早那次请求滑出窗口的时刻即可重试。
      const oldest = recent[0] ?? now
      const retryAfterMs = Math.max(1, oldest + windowMs - now)
      this.windows.set(record.id, recent)
      return { kind: 'rate_limited', retryAfterMs }
    }
    recent.push(now)
    this.windows.set(record.id, recent)
    return undefined
  }

  /** 标记一次成功使用（写 `lastUsedAt`；**不**在这里落盘每次请求）。 */
  markUsed(id: string): void {
    const records = this.ensureLoaded()
    const idx = records.findIndex(r => r.id === id)
    if (idx === -1) return
    // 内存里更新即可：`lastUsedAt` 是诊断信息，不值得为每次请求写一次磁盘。
    // 下一次任何写操作（改范围 / 改额度）会把它一并落盘。
    records[idx] = { ...records[idx]!, lastUsedAt: new Date().toISOString() }
  }

  /**
   * 累计一次请求的 token 用量（供额度判定）。
   *
   * @returns 累计后的总量。
   */
  recordUsage(id: string, tokens: number): number {
    if (!Number.isFinite(tokens) || tokens <= 0) return this.find(id)?.usedTokens ?? 0
    const records = this.ensureLoaded()
    const idx = records.findIndex(r => r.id === id)
    if (idx === -1) return 0
    const current = records[idx]!
    const usedTokens = current.usedTokens + Math.floor(tokens)
    records[idx] = { ...current, usedTokens }
    this.persist(records)
    return usedTokens
  }

  /** 手动重置额度计数（管理端的「恢复额度」）。 */
  resetUsage(id: string): ApiKeySummary {
    const records = this.ensureLoaded()
    const idx = records.findIndex(r => r.id === id)
    if (idx === -1) throw new Error(`API Key ${id} 不存在`)
    const next = { ...records[idx]!, usedTokens: 0 }
    const updated = [...records]
    updated[idx] = next
    this.persist(updated)
    return toSummary(next)
  }

  /**
   * 导出全部原始记录（备份导出用）。
   *
   * ⚠️ 含 `hash`（可继续校验）但**不含明文**（明文从未落盘）。
   */
  exportAll(): ApiKeyRecord[] {
    return this.ensureLoaded().map(record => ({ ...record }))
  }

  /**
   * 用导入的记录整体替换（备份导入用）。
   *
   * 条目先过 {@link sanitizeApiKeys}：坏条目被丢弃，不导入半截文档。
   * 导入前的备份由调用方负责（与 pool 同一批）。
   */
  replaceAll(records: readonly ApiKeyRecord[]): void {
    this.persist(sanitizeApiKeys(records))
  }
}

/**
 * 定长比较两个 hex 字符串。
 *
 * 长度不同直接返回 `false`（长度本身不是秘密：哈希恒为 64 字符）。
 * 长度相同时用 `timingSafeEqual`，避免逐字符比较的短路时间差。
 */
function constantTimeEqualsHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  try {
    return timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'))
  } catch {
    return false
  }
}

/** 把记录转成不含敏感字段的摘要。 */
function toSummary(record: ApiKeyRecord): ApiKeySummary {
  return {
    id: record.id,
    name: record.name,
    prefix: record.prefix,
    createdAt: record.createdAt,
    disabled: record.disabled,
    ...record.lastUsedAt === undefined ? {} : { lastUsedAt: record.lastUsedAt },
    ...record.providers === undefined ? {} : { providers: [...record.providers] },
    ...record.models === undefined ? {} : { models: [...record.models] },
    ...record.rateLimitPerMinute === undefined ? {} : { rateLimitPerMinute: record.rateLimitPerMinute },
    ...record.quotaTokens === undefined ? {} : { quotaTokens: record.quotaTokens },
    usedTokens: record.usedTokens,
    keyLength: API_KEY_PREFIX.length + 43,
  }
}

/**
 * 从请求头提取 key 明文。
 *
 * 同时接受 `Authorization: Bearer <key>` 与 `x-api-key: <key>`（规格要求两者等价）。
 * 前者优先 —— 同时携带且不一致时，以标准头为准，避免出现「两个头决定不同身份」
 * 的歧义。
 */
export function extractApiKey(headers: Record<string, string | string[] | undefined>): string {
  const authorization = firstHeader(headers['authorization'])
  if (authorization !== undefined) {
    const match = /^Bearer\s+(.+)$/i.exec(authorization.trim())
    if (match !== null && match[1] !== undefined) return match[1].trim()
    // 有 Authorization 但不是 Bearer 形式：继续看 x-api-key，而不是直接判失败
    // （某些客户端会同时带一个无关的 Basic 头）。
  }
  const apiKey = firstHeader(headers['x-api-key'])
  return apiKey === undefined ? '' : apiKey.trim()
}

/** 取头部的单值（多值取第一个）。 */
function firstHeader(value: string | string[] | undefined): string | undefined {
  if (value === undefined) return undefined
  if (Array.isArray(value)) return value[0]
  return value
}
