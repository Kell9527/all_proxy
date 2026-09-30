/**
 * 运行日志：按大小轮转 + 敏感信息脱敏。
 *
 * ## 为什么必须脱敏（而不是「注意别写进去」）
 *
 * 日志会被用户贴进 issue、被监控系统采集、被备份工具同步。任何一次
 * `logger.info(JSON.stringify(credential))` 都会把 refresh token 永久留在
 * 这些地方。**靠纪律不如靠代码**：所有写入都过 {@link redact}，它按
 * **键名**与**值形态**双重匹配。
 *
 * ## 为什么按大小轮转
 *
 * 长跑服务（数月）不轮转会占满磁盘，而磁盘满会连带把凭据文件写坏 ——
 * 一个日志问题升级成「10 个账号全部丢失」。故保留有限备份、写满即换。
 *
 * ## 请求标识贯穿
 *
 * 每条日志都带 `requestId`（若有），使用量记录里的同一标识能互相定位。
 * 阶段标记（`stage`）让「卡在哪一步」可以从日志直接读出来，而不是靠猜。
 */

import { appendFileSync, existsSync, mkdirSync, renameSync, statSync, unlinkSync } from 'node:fs'
import { dirname } from 'node:path'

/**
 * 请求处理阶段。
 *
 * 规格 `usage-tracking` 要求「日志能看出请求停在哪一阶段」。这四个阶段把
 * 「上游完全不响应」与「上游响应了但中途断了」区分开 —— 两者的排查方向
 * 完全不同（前者查网络/账号，后者查上游稳定性）。
 */
export type LogStage =
  /** 已收到请求、尚未连上上游。 */
  | 'received'
  /** 已建立连接但还没有首个字节。 */
  | 'upstream-connected'
  /** 首个字节已到达，正在传输。 */
  | 'streaming'
  /** 传输中断（连接被断开或读流出错）。 */
  | 'transfer-aborted'
  /** 正常完成。 */
  | 'completed'
  /** 在触达上游之前就失败了（鉴权、模型解析、额度）。 */
  | 'rejected'

/** 日志级别。 */
export type LogLevel = 'info' | 'warn' | 'error'

/** 一条结构化日志。 */
export interface LogEntry {
  at: string
  level: LogLevel
  stage: LogStage
  message: string
  /** 请求标识（与用量记录共享）。 */
  requestId?: string
  /** 附加字段（**会被脱敏**）。 */
  fields?: Record<string, unknown>
}

/** 轮转选项。 */
export interface RotatingLoggerOptions {
  /** 日志文件路径。 */
  path: string
  /** 单个文件大小上限（字节）。默认 5 MB。 */
  maxBytes?: number
  /** 保留的备份个数。默认 5。 */
  maxBackups?: number
  /** 同时输出到 stderr（便于前台运行时观察）。默认 false。 */
  mirrorToConsole?: boolean
}

/** 默认单文件上限：5 MB。 */
export const DEFAULT_MAX_BYTES = 5 * 1024 * 1024
/** 默认备份个数。 */
export const DEFAULT_MAX_BACKUPS = 5

/**
 * 敏感键名（小写子串匹配）。
 *
 * ⚠️ 用**子串**而不是全等：真实字段名有 `access_token` / `refreshToken` /
 * `authorization` / `apiKey` / `secret` 等十几种写法，逐个列举必然漏。
 */
const SENSITIVE_KEY_PATTERNS = [
  'token',
  'secret',
  'password',
  'passwd',
  'authorization',
  'api_key',
  'apikey',
  'api-key',
  'credential',
  'cookie',
  'session',
  'signature',
  'private_key',
  'privatekey',
  'access_key',
  'client_secret',
]

/**
 * 值形态匹配：本项目的 API Key 明文有固定前缀。
 *
 * 键名匹配可能被绕过（比如把 key 放在 `note` 字段里），值形态是第二道防线。
 */
const SENSITIVE_VALUE_PATTERNS = [
  /sk-all-[A-Za-z0-9_-]{10,}/g,
]

/** 脱敏后的占位文本。 */
export const REDACTED = '[已脱敏]'

/**
 * 脱敏一个值（递归）。
 *
 * 规则：
 * - 键名命中敏感模式 → 整个值替换为占位符（**不保留长度**：长度本身可能泄露信息）；
 * - 字符串值命中敏感形态 → 就地替换该片段；
 * - 数组 / 对象 → 递归；
 * - `Error` → 只取 `message`（**不取 stack**：stack 里可能带请求 URL 与查询参数）。
 */
export function redact(value: unknown, keyHint = ''): unknown {
  if (keyHint.length > 0 && isSensitiveKey(keyHint)) return REDACTED
  if (typeof value === 'string') return redactString(value)
  if (value === null || value === undefined) return value
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') return value
  if (value instanceof Error) return redactString(value.message)
  if (Array.isArray(value)) return value.map(item => redact(item, keyHint))
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [key, inner] of Object.entries(value as Record<string, unknown>)) {
      out[key] = redact(inner, key)
    }
    return out
  }
  // 函数 / symbol 等：转成类型名，避免 JSON.stringify 丢字段或抛错。
  return `[${typeof value}]`
}

/** 判断键名是否敏感。 */
export function isSensitiveKey(key: string): boolean {
  const lower = key.toLowerCase()
  return SENSITIVE_KEY_PATTERNS.some(pattern => lower.includes(pattern))
}

/** 脱敏字符串里的敏感片段。 */
export function redactString(text: string): string {
  let out = text
  for (const pattern of SENSITIVE_VALUE_PATTERNS) {
    out = out.replace(pattern, REDACTED)
  }
  return out
}

/** 按大小轮转的日志写入器。 */
export class RotatingLogger {
  private readonly path: string
  private readonly maxBytes: number
  private readonly maxBackups: number
  private readonly mirror: boolean

  constructor(options: RotatingLoggerOptions) {
    this.path = options.path
    this.maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES
    this.maxBackups = Math.max(1, options.maxBackups ?? DEFAULT_MAX_BACKUPS)
    this.mirror = options.mirrorToConsole === true
    mkdirSync(dirname(this.path), { recursive: true })
  }

  /** 日志文件路径。 */
  get filePath(): string {
    return this.path
  }

  /** 当前文件大小（字节）；不存在时为 0。 */
  size(): number {
    try {
      return existsSync(this.path) ? statSync(this.path).size : 0
    } catch {
      return 0
    }
  }

  /** 全部备份文件路径（`.1` 最新，`.N` 最旧）。 */
  backupPaths(): string[] {
    const out: string[] = []
    for (let i = 1; i <= this.maxBackups; i++) out.push(`${this.path}.${i}`)
    return out
  }

  /** 写一条日志。 */
  log(entry: Omit<LogEntry, 'at'> & { at?: string }): void {
    const full: LogEntry = {
      at: entry.at ?? new Date().toISOString(),
      level: entry.level,
      stage: entry.stage,
      // 消息本身也要脱敏：异常消息里常带完整请求 URL 与查询参数。
      message: redactString(entry.message),
      ...entry.requestId === undefined ? {} : { requestId: entry.requestId },
      ...entry.fields === undefined ? {} : { fields: redact(entry.fields) as Record<string, unknown> },
    }
    const line = `${JSON.stringify(full)}\n`
    try {
      this.rotateIfNeeded(Buffer.byteLength(line, 'utf-8'))
      appendFileSync(this.path, line, 'utf-8')
      if (this.mirror) process.stderr.write(line)
    } catch (error) {
      // 日志写入失败绝不能影响业务：退化成 stderr 一行说明。
      process.stderr.write(`[logger] 写入日志失败: ${String(error)}\n`)
    }
  }

  /** 便捷方法。 */
  info(stage: LogStage, message: string, fields?: Record<string, unknown>): void {
    this.log({ level: 'info', stage, message, ...fields === undefined ? {} : { fields } })
  }

  warn(stage: LogStage, message: string, fields?: Record<string, unknown>): void {
    this.log({ level: 'warn', stage, message, ...fields === undefined ? {} : { fields } })
  }

  error(stage: LogStage, message: string, fields?: Record<string, unknown>): void {
    this.log({ level: 'error', stage, message, ...fields === undefined ? {} : { fields } })
  }

  /** 带请求标识的便捷方法。 */
  forRequest(requestId: string) {
    return {
      info: (stage: LogStage, message: string, fields?: Record<string, unknown>) => {
        this.log({ level: 'info', stage, message, requestId, ...fields === undefined ? {} : { fields } })
      },
      warn: (stage: LogStage, message: string, fields?: Record<string, unknown>) => {
        this.log({ level: 'warn', stage, message, requestId, ...fields === undefined ? {} : { fields } })
      },
      error: (stage: LogStage, message: string, fields?: Record<string, unknown>) => {
        this.log({ level: 'error', stage, message, requestId, ...fields === undefined ? {} : { fields } })
      },
    }
  }

  /**
   * 按需轮转。
   *
   * 顺序：`app.log.(N-1)` → `app.log.N` … `app.log` → `app.log.1`。
   * **从最旧的开始搬**，否则会把新的备份覆盖掉。
   *
   * @param incomingBytes - 即将写入的字节数（用「写完之后会不会超」判断，
   *   而不是「现在已经超了」—— 后者会让单条超大日志永远触发不了轮转）。
   */
  private rotateIfNeeded(incomingBytes: number): void {
    if (this.size() + incomingBytes <= this.maxBytes) return
    if (!existsSync(this.path)) return

    // 最旧的备份直接删除（保留数量受限）。
    const oldest = `${this.path}.${this.maxBackups}`
    try { if (existsSync(oldest)) unlinkSync(oldest) } catch { /* 忽略 */ }

    // 从旧到新依次后移一位。
    for (let i = this.maxBackups - 1; i >= 1; i--) {
      const from = `${this.path}.${i}`
      const to = `${this.path}.${i + 1}`
      try {
        if (existsSync(from)) renameSync(from, to)
      } catch { /* 单个备份搬迁失败不阻断轮转 */ }
    }
    try {
      renameSync(this.path, `${this.path}.1`)
    } catch {
      // 搬迁失败：宁可继续往原文件追加，也不要丢日志。
    }
  }
}

/**
 * 一个把 `Logger` 接口（`info`/`warn`/`error`）接到 {@link RotatingLogger} 上的适配器。
 *
 * 移植过来的模块（适配器、账号池）用的是那个三方法接口，故需要这层桥接，
 * 而不是让它们各自去认 `LogStage`。
 */
export function loggerAdapter(logger: RotatingLogger, stage: LogStage = 'received'): {
  info(message: string): void
  warn(message: string): void
  error(message: string): void
} {
  return {
    info: (message) => logger.info(stage, message),
    warn: (message) => logger.warn(stage, message),
    error: (message) => logger.error(stage, message),
  }
}
