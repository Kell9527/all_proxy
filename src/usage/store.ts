/**
 * 用量记录（SQLite）。
 *
 * ## 为什么用 `node:sqlite`
 *
 * 用量是**只增不改、需要按维度聚合**的数据，正是关系库的强项；用 JSON 累积
 * 会在几千条之后让每次写入变成「读全量 → 改 → 写全量」。而 `better-sqlite3`
 * 需要原生编译（本机 npm 环境脆弱），`node:sqlite` 是 Node 内置的，无编译步骤。
 *
 * 代价：它是 **experimental**，启动会打印一条警告。已在 AGENTS.md 记录为已知限制。
 *
 * ## 写入口径：`prompt_tokens` 含缓存
 *
 * ⚠️ 内部 `TokenUsage` 的 `inputTokens` 是**未缓存**输入（counts are DISJOINT），
 * 而对外响应里的 `prompt_tokens` 是**总**输入。记录必须与**响应**一致，
 * 否则用户拿响应里的数字对不上用量页，会以为统计漏了。
 * 故这里落盘的 `prompt_tokens = inputTokens + cacheReadTokens + cacheWriteTokens`。
 *
 * ## 不记正文
 *
 * 表结构里**没有任何正文列**。这不是「记得删掉」，而是**根本没有地方可写**
 * —— 从结构上保证隐私要求（规格 `usage-tracking`）不会被后来的改动破坏。
 *
 * ## 写入失败不阻断请求
 *
 * 所有写入路径都包在 try/catch 里并只记告警。用量是**观测数据**，不是业务
 * 数据：为了一条统计记录让用户的请求失败，是明确的优先级倒置。
 */

import { DatabaseSync } from 'node:sqlite'
import { mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { Logger } from '../pool/store.js'

/** 一条待落盘的用量记录。 */
export interface UsageRecord {
  /** 请求标识（与运行日志共享）。 */
  requestId: string
  /** 完成时刻（ISO 字符串，UTC）。 */
  at: string
  /** API Key 标识；未鉴权时为 `anonymous`。 */
  keyId: string
  /** API Key 名称（可读，便于按人看消耗）。 */
  keyName: string
  /** provider id；解析失败时为空串。 */
  provider: string
  /** 对外模型 ref。 */
  model: string
  /** 上游原始模型 id。 */
  upstreamModel: string
  /** 实际完成请求的账号 id；未知时为空串。 */
  accountId: string
  /**
   * 调用方请求的思考等级（`reasoning_effort`）；未指定时为空串。
   *
   * ⚠️ 记的是**网关收到的入参**，不是「上游实际生效的档位」：部分适配器
   * 整段丢弃该参数（见 AGENTS.md 的 provider 透传表），另有模型会在客户端
   * 未指定时回落到自己声明的 `defaultEffort`。空串的正确读法是「本次请求
   * 没有指定」，不能读成「没有思考」。
   */
  reasoningEffort: string
  /** 总输入 token（**含**缓存读与缓存写，与响应里的 `prompt_tokens` 同口径）。 */
  promptTokens: number
  /** 输出 token。 */
  completionTokens: number
  /** 缓存命中（读）token。 */
  cacheReadTokens: number
  /** 缓存写入 token。 */
  cacheWriteTokens: number
  /** 是否流式。 */
  stream: boolean
  /** 总耗时（毫秒）。 */
  durationMs: number
  /** 首字节耗时（毫秒）；未产出任何内容时为 `null`。 */
  firstByteMs: number | null
  /** 结束原因；未知时为空串。 */
  finishReason: string
  /** HTTP 状态码。 */
  status: number
  /** 错误码；成功时为空串。 */
  errorCode: string
}

/** 查询条件。 */
export interface UsageQuery {
  /** 起始时刻（含），ISO 字符串或毫秒时间戳。 */
  from?: string | number
  /** 结束时刻（含）。 */
  to?: string | number
  keyId?: string
  provider?: string
  model?: string
  /**
   * 思考等级筛选。
   *
   * 传空串表示**筛出「未指定档位」的那些请求**（旧记录与不传该参数的客户端），
   * 这与「不筛选」是两回事，故不能用「空串等于不过滤」的惯例。
   */
  reasoningEffort?: string
  /** 只取成功（`status < 400`）或只取失败。省略为全部。 */
  outcome?: 'success' | 'failure'
  /** 每页条数（1–500，默认 50）。 */
  limit?: number
  /** 偏移量（默认 0）。 */
  offset?: number
}

/** 汇总结果。 */
export interface UsageSummary {
  total: number
  success: number
  failure: number
  promptTokens: number
  completionTokens: number
  cacheReadTokens: number
  /** 平均首字节耗时（毫秒）；无样本时为 `null`。 */
  avgFirstByteMs: number | null
  /** 平均总耗时（毫秒）。 */
  avgDurationMs: number | null
  /**
   * 按思考等级分桶的请求数（降序）。
   *
   * `effort` 为空串的那一桶代表「调用方未指定档位」。它几乎总会出现 ——
   * 客户端不传 `reasoning_effort`、走 Anthropic 协议、以及本列上线前的历史
   * 记录都落在这里，故**不要**把它当成异常数据。
   */
  reasoningEfforts: Array<{ effort: string; requests: number }>
}

/** 查询结果。 */
export interface UsageQueryResult {
  records: UsageRecord[]
  summary: UsageSummary
  /** 未分页时的总条数（用于前端算页数）。 */
  matched: number
  limit: number
  offset: number
}

/** 按 key 的消耗汇总。 */
export interface KeyUsage {
  keyId: string
  keyName: string
  requests: number
  promptTokens: number
  completionTokens: number
  lastAt: string | null
}

/** 保留策略。 */
export interface RetentionPolicy {
  /** 保留天数；省略表示不按时间清理。 */
  days?: number
  /** 最大记录数；超出时删最旧的。省略表示不按总量清理。 */
  maxRecords?: number
}

/** 默认保留策略：保留 90 天、最多 20 万条。 */
export const DEFAULT_RETENTION: RetentionPolicy = { days: 90, maxRecords: 200_000 }

/** 每页最大条数（防止一次拉爆内存）。 */
export const MAX_PAGE_SIZE = 500

/** 用量存储。 */
export class UsageStore {
  private readonly db: DatabaseSync
  private readonly logger: Logger
  private closed = false

  constructor(
    dataDir: string,
    logger: Logger = { info: () => {}, warn: () => {}, error: () => {} },
    filename = 'usage.db',
  ) {
    const path = join(dataDir, filename)
    mkdirSync(dirname(path), { recursive: true })
    this.db = new DatabaseSync(path)
    this.logger = logger
    this.migrate()
  }

  /** 建表（幂等）。 */
  private migrate(): void {
    // ⚠️ **没有任何正文列**：隐私要求靠表结构保证，而不是靠写入方自觉。
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS usage_records (
        request_id        TEXT    NOT NULL PRIMARY KEY,
        at                TEXT    NOT NULL,
        at_ms             INTEGER NOT NULL,
        key_id            TEXT    NOT NULL,
        key_name          TEXT    NOT NULL,
        provider          TEXT    NOT NULL,
        model             TEXT    NOT NULL,
        upstream_model    TEXT    NOT NULL,
        account_id        TEXT    NOT NULL,
        reasoning_effort  TEXT    NOT NULL DEFAULT '',
        prompt_tokens     INTEGER NOT NULL,
        completion_tokens INTEGER NOT NULL,
        cache_read_tokens INTEGER NOT NULL,
        cache_write_tokens INTEGER NOT NULL,
        stream            INTEGER NOT NULL,
        duration_ms       INTEGER NOT NULL,
        first_byte_ms     INTEGER,
        finish_reason     TEXT    NOT NULL,
        status            INTEGER NOT NULL,
        error_code        TEXT    NOT NULL
      )
    `)
    // 查询都是「按时间倒序 + 维度筛选」，故索引按 (at_ms) 与常用维度各建一个。
    this.db.exec('CREATE INDEX IF NOT EXISTS idx_usage_at ON usage_records (at_ms)')
    this.db.exec('CREATE INDEX IF NOT EXISTS idx_usage_key ON usage_records (key_id, at_ms)')
    this.db.exec('CREATE INDEX IF NOT EXISTS idx_usage_provider ON usage_records (provider, at_ms)')
    this.db.exec('CREATE INDEX IF NOT EXISTS idx_usage_model ON usage_records (provider, model, at_ms)')
    this.addMissingColumns()
  }

  /**
   * 给**已存在的**旧库补新列。
   *
   * ⚠️ `CREATE TABLE IF NOT EXISTS` 建表语句里加列对存量库**毫无作用** ——
   * 表已存在时整条语句被跳过，写入方随后 INSERT 一个不存在的列会直接抛错
   * （而 `record()` 会把它吞成一条告警，表现是「用量页从此一条新记录都没有」，
   * 极难归因）。故每次启动都按 `PRAGMA table_info` 比对，缺什么补什么。
   */
  private addMissingColumns(): void {
    const existing = new Set(
      (this.db.prepare('PRAGMA table_info(usage_records)').all() as Array<{ name?: unknown }>)
        .map(column => String(column.name ?? '')),
    )
    /** 后加的列：`[列名, 列定义]`。顺序即补列顺序，新增时追加到末尾。 */
    const added: Array<readonly [string, string]> = [
      // 2026-10-23：思考等级。旧记录的档位未知，故默认空串而不是猜一个值。
      ['reasoning_effort', "TEXT NOT NULL DEFAULT ''"],
    ]
    for (const [name, definition] of added) {
      if (existing.has(name)) continue
      this.db.exec(`ALTER TABLE usage_records ADD COLUMN ${name} ${definition}`)
    }
  }

  /**
   * 写入一条记录。
   *
   * ⚠️ **绝不抛错**：用量是观测数据，写入失败只记告警。调用方在请求热路径上，
   * 不能因为统计问题让用户拿到 500。
   *
   * @returns 是否写入成功（供测试与诊断）。
   */
  record(record: UsageRecord): boolean {
    if (this.closed) return false
    try {
      this.insert(record)
      return true
    } catch (error) {
      this.logger.warn(`[usage] 写入失败 ${record.requestId}: ${String(error)}`)
      return false
    }
  }

  private insert(record: UsageRecord): void {
    const atMs = Date.parse(record.at)
    const statement = this.db.prepare(`
      INSERT OR REPLACE INTO usage_records (
        request_id, at, at_ms, key_id, key_name, provider, model, upstream_model,
        account_id, reasoning_effort, prompt_tokens, completion_tokens, cache_read_tokens, cache_write_tokens,
        stream, duration_ms, first_byte_ms, finish_reason, status, error_code
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)
    statement.run(
      record.requestId,
      record.at,
      Number.isFinite(atMs) ? atMs : Date.now(),
      record.keyId,
      record.keyName,
      record.provider,
      record.model,
      record.upstreamModel,
      record.accountId,
      record.reasoningEffort,
      Math.max(0, Math.floor(record.promptTokens)),
      Math.max(0, Math.floor(record.completionTokens)),
      Math.max(0, Math.floor(record.cacheReadTokens)),
      Math.max(0, Math.floor(record.cacheWriteTokens)),
      record.stream ? 1 : 0,
      Math.max(0, Math.floor(record.durationMs)),
      record.firstByteMs === null ? null : Math.max(0, Math.floor(record.firstByteMs)),
      record.finishReason,
      record.status,
      record.errorCode,
    )
  }

  /**
   * 批量写入（备份导入等场景）。
   *
   * 包在一个事务里：中途失败不会留下「导入了一半」的用量库。
   */
  recordMany(records: readonly UsageRecord[]): number {
    if (this.closed || records.length === 0) return 0
    try {
      this.db.exec('BEGIN')
      let written = 0
      for (const record of records) {
        try {
          this.insert(record)
          written++
        } catch (error) {
          this.logger.warn(`[usage] 批量写入跳过 ${record.requestId}: ${String(error)}`)
        }
      }
      this.db.exec('COMMIT')
      return written
    } catch (error) {
      try { this.db.exec('ROLLBACK') } catch { /* 回滚失败只能忽略 */ }
      this.logger.warn(`[usage] 批量写入失败: ${String(error)}`)
      return 0
    }
  }

  /** 按条件查询记录与汇总。 */
  query(query: UsageQuery = {}): UsageQueryResult {
    const limit = Math.min(Math.max(1, Math.floor(query.limit ?? 50)), MAX_PAGE_SIZE)
    const offset = Math.max(0, Math.floor(query.offset ?? 0))
    const where = buildWhere(query)

    const summaryRow = this.db.prepare(`
      SELECT
        COUNT(*) AS total,
        SUM(CASE WHEN status < 400 THEN 1 ELSE 0 END) AS success,
        SUM(CASE WHEN status >= 400 THEN 1 ELSE 0 END) AS failure,
        COALESCE(SUM(prompt_tokens), 0) AS prompt_tokens,
        COALESCE(SUM(completion_tokens), 0) AS completion_tokens,
        COALESCE(SUM(cache_read_tokens), 0) AS cache_read_tokens,
        AVG(first_byte_ms) AS avg_first_byte_ms,
        AVG(duration_ms) AS avg_duration_ms
      FROM usage_records ${where.sql}
    `).get(...where.params) as Record<string, unknown> | undefined

    // 档位分桶：与主查询共用同一套 WHERE，故它描述的是「本次筛选结果」的分布。
    const effortRows = this.db.prepare(`
      SELECT reasoning_effort AS effort, COUNT(*) AS requests
      FROM usage_records ${where.sql}
      GROUP BY reasoning_effort
      ORDER BY requests DESC, reasoning_effort ASC
    `).all(...where.params) as Array<Record<string, unknown>>

    const rows = this.db.prepare(`
      SELECT * FROM usage_records ${where.sql}
      ORDER BY at_ms DESC, request_id DESC
      LIMIT ? OFFSET ?
    `).all(...where.params, limit, offset) as Array<Record<string, unknown>>

    const total = num(summaryRow?.['total'])
    return {
      records: rows.map(rowToRecord),
      summary: {
        total,
        success: num(summaryRow?.['success']),
        failure: num(summaryRow?.['failure']),
        promptTokens: num(summaryRow?.['prompt_tokens']),
        completionTokens: num(summaryRow?.['completion_tokens']),
        cacheReadTokens: num(summaryRow?.['cache_read_tokens']),
        avgFirstByteMs: nullableNum(summaryRow?.['avg_first_byte_ms']),
        avgDurationMs: nullableNum(summaryRow?.['avg_duration_ms']),
        reasoningEfforts: effortRows.map(row => ({
          effort: String(row['effort'] ?? ''),
          requests: num(row['requests']),
        })),
      },
      matched: total,
      limit,
      offset,
    }
  }

  /** 按 API Key 汇总消耗（供额度分配决策）。 */
  keyUsage(): KeyUsage[] {
    const rows = this.db.prepare(`
      SELECT key_id, key_name, COUNT(*) AS requests,
             COALESCE(SUM(prompt_tokens), 0) AS prompt_tokens,
             COALESCE(SUM(completion_tokens), 0) AS completion_tokens,
             MAX(at) AS last_at
      FROM usage_records
      GROUP BY key_id, key_name
      ORDER BY (COALESCE(SUM(prompt_tokens), 0) + COALESCE(SUM(completion_tokens), 0)) DESC
    `).all() as Array<Record<string, unknown>>
    return rows.map(row => ({
      keyId: String(row['key_id'] ?? ''),
      keyName: String(row['key_name'] ?? ''),
      requests: num(row['requests']),
      promptTokens: num(row['prompt_tokens']),
      completionTokens: num(row['completion_tokens']),
      lastAt: row['last_at'] === null || row['last_at'] === undefined ? null : String(row['last_at']),
    }))
  }

  /** 记录总数。 */
  count(): number {
    const row = this.db.prepare('SELECT COUNT(*) AS n FROM usage_records').get() as Record<string, unknown> | undefined
    return num(row?.['n'])
  }

  /**
   * 应用保留策略：按期限与总量清理最旧记录。
   *
   * @returns 删除的条数。
   */
  applyRetention(policy: RetentionPolicy = DEFAULT_RETENTION, now = Date.now()): number {
    if (this.closed) return 0
    let removed = 0
    try {
      if (policy.days !== undefined && policy.days > 0) {
        const cutoff = now - policy.days * 24 * 60 * 60 * 1000
        const result = this.db.prepare('DELETE FROM usage_records WHERE at_ms < ?').run(cutoff)
        removed += Number(result.changes ?? 0)
      }
      if (policy.maxRecords !== undefined && policy.maxRecords > 0) {
        const total = this.count()
        if (total > policy.maxRecords) {
          const excess = total - policy.maxRecords
          // ⚠️ 用子查询按 at_ms 升序取最旧的 N 条删除。SQLite 的 DELETE ... LIMIT
          // 需要编译开关，不保证可用，故走子查询这条可移植路径。
          const result = this.db.prepare(`
            DELETE FROM usage_records WHERE request_id IN (
              SELECT request_id FROM usage_records ORDER BY at_ms ASC, request_id ASC LIMIT ?
            )
          `).run(excess)
          removed += Number(result.changes ?? 0)
        }
      }
    } catch (error) {
      this.logger.warn(`[usage] 保留策略执行失败: ${String(error)}`)
    }
    return removed
  }

  /** 导出全部记录（供备份）。 */
  exportAll(): UsageRecord[] {
    const rows = this.db.prepare('SELECT * FROM usage_records ORDER BY at_ms ASC').all() as Array<Record<string, unknown>>
    return rows.map(rowToRecord)
  }

  /** 关闭数据库（进程退出时调用）。 */
  close(): void {
    if (this.closed) return
    this.closed = true
    try { this.db.close() } catch { /* 已关闭或从未打开 */ }
  }
}

/** 构造 WHERE 子句与参数。 */
function buildWhere(query: UsageQuery): { sql: string; params: Array<string | number> } {
  const clauses: string[] = []
  const params: Array<string | number> = []
  const fromMs = toTimestamp(query.from)
  if (fromMs !== undefined) { clauses.push('at_ms >= ?'); params.push(fromMs) }
  const toMsValue = toTimestamp(query.to)
  if (toMsValue !== undefined) { clauses.push('at_ms <= ?'); params.push(toMsValue) }
  if (query.keyId !== undefined && query.keyId.length > 0) { clauses.push('key_id = ?'); params.push(query.keyId) }
  if (query.provider !== undefined && query.provider.length > 0) { clauses.push('provider = ?'); params.push(query.provider) }
  if (query.model !== undefined && query.model.length > 0) { clauses.push('model = ?'); params.push(query.model) }
  // ⚠️ 与其他维度不同：**空串是有效取值**（代表「未指定档位」），故只判 undefined。
  if (query.reasoningEffort !== undefined) { clauses.push('reasoning_effort = ?'); params.push(query.reasoningEffort) }
  if (query.outcome === 'success') clauses.push('status < 400')
  if (query.outcome === 'failure') clauses.push('status >= 400')
  return { sql: clauses.length === 0 ? '' : `WHERE ${clauses.join(' AND ')}`, params }
}

/** 把时间输入统一成毫秒时间戳；无法解析返回 undefined。 */
function toTimestamp(value: string | number | undefined): number | undefined {
  if (value === undefined) return undefined
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined
  const parsed = Date.parse(value)
  return Number.isNaN(parsed) ? undefined : parsed
}

/** 数据库行 → 记录对象。 */
function rowToRecord(row: Record<string, unknown>): UsageRecord {
  const firstByte = row['first_byte_ms']
  return {
    requestId: String(row['request_id'] ?? ''),
    at: String(row['at'] ?? ''),
    keyId: String(row['key_id'] ?? ''),
    keyName: String(row['key_name'] ?? ''),
    provider: String(row['provider'] ?? ''),
    model: String(row['model'] ?? ''),
    upstreamModel: String(row['upstream_model'] ?? ''),
    accountId: String(row['account_id'] ?? ''),
    // 旧库补列后该值为空串（写入时 DEFAULT ''），故不需要另设兜底。
    reasoningEffort: String(row['reasoning_effort'] ?? ''),
    promptTokens: num(row['prompt_tokens']),
    completionTokens: num(row['completion_tokens']),
    cacheReadTokens: num(row['cache_read_tokens']),
    cacheWriteTokens: num(row['cache_write_tokens']),
    stream: num(row['stream']) === 1,
    durationMs: num(row['duration_ms']),
    firstByteMs: firstByte === null || firstByte === undefined ? null : num(firstByte),
    finishReason: String(row['finish_reason'] ?? ''),
    status: num(row['status']),
    errorCode: String(row['error_code'] ?? ''),
  }
}

/** 转成非负整数。 */
function num(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'bigint') return Number(value)
  if (typeof value === 'string') {
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : 0
  }
  return 0
}

/** 转成数字或 null。 */
function nullableNum(value: unknown): number | null {
  if (value === null || value === undefined) return null
  const parsed = num(value)
  return Number.isFinite(parsed) ? parsed : null
}
