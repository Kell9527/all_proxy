/**
 * 凭据与账号状态的持久化。
 *
 * ## 设计
 *
 * 两个文件，都是 JSON，都**原子写**（临时文件 + rename）：
 *
 * | 文件 | 内容 |
 * |---|---|
 * | `<dataDir>/credentials.json` | 凭据本体：ref → JSON 字符串（含 refresh token） |
 * | `<dataDir>/state.json` | 账号索引 + 模型黑名单 + 其他全局开关 |
 *
 * ## 为什么原子写是硬要求
 *
 * 账号索引与凭据在每次请求限流、每次 token 续期时都会被改写。若直接覆写目标
 * 文件，进程在写入中途被杀（或磁盘写满）会留下**半截 JSON** —— 下次启动时
 * 整个账号池读不出来，用户要重新登录 10 个平台。临时文件 + `rename` 在
 * 同一文件系统内是原子的，读者要么看到旧内容、要么看到新内容。
 *
 * ⚠️ **`data/` 含账号凭证，绝不可提交**（`.gitignore` 已排除）。
 */

import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync, unlinkSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { parseCredentialRef } from './credential-ref-kind.js'
import type { CredentialStore } from './types.js'

/** 日志接口（只用到这两级；注入以便测试与复用）。 */
export interface Logger {
  info(message: string): void
  warn(message: string): void
  error(message: string): void
}

/** 控制台日志实现。 */
export const consoleLogger: Logger = {
  info: (message) => { console.log(message) },
  warn: (message) => { console.warn(message) },
  error: (message) => { console.error(message) },
}

/**
 * 原子写入文本文件：先写临时文件，再 `rename` 替换目标。
 *
 * ⚠️ 临时文件必须与目标**同目录**：`rename` 只在同一文件系统内原子，
 * 跨设备（如临时目录在别的盘）会退化成「复制 + 删除」，失去原子性。
 */
export function writeFileAtomic(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true })
  const tmp = `${path}.tmp`
  writeFileSync(tmp, content, 'utf-8')
  try {
    renameSync(tmp, path)
  } catch (error) {
    // rename 失败时清掉临时文件，避免残留垃圾被下次启动误读。
    try { unlinkSync(tmp) } catch { /* 忽略 */ }
    throw error
  }
}

/** 读取 JSON 文件；不存在或损坏时返回 undefined（并可选告警）。 */
export function readJsonFile<T>(path: string, logger?: Logger): T | undefined {
  if (!existsSync(path)) return undefined
  try {
    return JSON.parse(readFileSync(path, 'utf-8')) as T
  } catch (error) {
    logger?.warn(`[store] 读取 ${path} 失败，本次视为空: ${String(error)}`)
    return undefined
  }
}

/**
 * 写入外部凭据文件（文件引用用）。
 *
 * 与 {@link writeFileAtomic} 的差别：
 * - **权限 0600**：凭据文件含 refresh token，同机其它用户不该读得到
 *   （Windows 上 chmod 基本无效，故失败忽略，与参考实现一致）；
 * - 临时文件名带进程号：多个消费者（本服务 / 官方客户端 / 其它网关）可能同时
 *   写同一个共享文件，固定 `.tmp` 会让它们互相覆盖对方的半成品。
 */
export function writeCredentialFileAtomic(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true })
  const tmp = `${path}.${process.pid}.tmp`
  writeFileSync(tmp, content, { encoding: 'utf-8', mode: 0o600 })
  try { chmodSync(tmp, 0o600) } catch { /* Windows 忽略 */ }
  try {
    renameSync(tmp, path)
  } catch (error) {
    try { unlinkSync(tmp) } catch { /* 忽略 */ }
    throw error
  }
}

/**
 * 基于 JSON 文件的凭据存储。
 *
 * 内存里保留一份权威副本（与来源的 `AccountPool.cache` 同理）：读路径不碰磁盘，
 * 写路径「改内存 → 整体落盘」，避免并发写入互相覆盖。
 *
 * ## 文件引用（`FILE:<绝对路径>`）
 *
 * 带该前缀的 ref **不走内存副本也不落 `credentials.json`**，而是直接读写那个
 * 外部文件（见 `credential-ref-kind.ts` 的说明）。要点：
 *
 * - `resolve` **每次都重新读文件** —— 这正是「不再持死副本」的机制本身：
 *   其它消费者刷新后写回文件，我们下次读取就拿到新 token，无需额外重读代码；
 * - `set` 原子写回该文件（0600），其它消费者同样能读到；
 * - `unset` **只从账号池的引用中摘除，绝不删除文件** —— 那个文件可能被官方
 *   客户端或其它网关共享，删掉会波及本服务之外的东西；
 * - `snapshot` / `replaceAll` / `listRefs` **不含**文件引用：备份由
 *   `providers/backup.ts` 专门处理（把内容内联进备份文件，保持备份自包含）。
 */
export class FileCredentialStore implements CredentialStore {
  private readonly path: string
  /** 权威进程内副本：ref → 值。 */
  private cache: Record<string, string>
  private loaded = false

  constructor(
    dataDir: string,
    private readonly logger: Logger = consoleLogger,
    filename = 'credentials.json',
  ) {
    this.path = join(dataDir, filename)
    this.cache = {}
  }

  /** 凭据文件路径（供备份与测试断言）。 */
  get filePath(): string {
    return this.path
  }

  private ensureLoaded(): void {
    if (this.loaded) return
    this.loaded = true
    const parsed = readJsonFile<Record<string, unknown>>(this.path, this.logger)
    if (parsed === undefined) return
    for (const [ref, value] of Object.entries(parsed)) {
      if (typeof value === 'string') this.cache[ref] = value
    }
  }

  /** 整体落盘（原子写）。 */
  private persist(): void {
    writeFileAtomic(this.path, JSON.stringify(this.cache, null, 2))
  }

  async resolve(ref: string): Promise<{ value: string; source?: string } | undefined> {
    const parsed = parseCredentialRef(ref)
    if (parsed.kind === 'file') {
      // ⚠️ 实时读盘，**不缓存**：共享凭据文件的全部价值就在于「别的消费者
      // 写了新 token，我下次就读到新的」。缓存一次就退化成死副本，
      // 那正是本机制要解决的问题。
      try {
        return { value: readFileSync(parsed.path, 'utf-8'), source: 'file-ref' }
      } catch {
        // 文件不存在/不可读：视为无凭据（选号器会跳过该账号并给出可读原因）。
        return undefined
      }
    }
    this.ensureLoaded()
    const value = this.cache[ref]
    return value === undefined ? undefined : { value, source: 'file' }
  }

  async describe(ref: string): Promise<{ source?: string; exists: boolean }> {
    const parsed = parseCredentialRef(ref)
    if (parsed.kind === 'file') {
      return existsSync(parsed.path) ? { exists: true, source: 'file-ref' } : { exists: false }
    }
    this.ensureLoaded()
    const exists = this.cache[ref] !== undefined
    return exists ? { exists, source: 'file' } : { exists }
  }

  async set(ref: string, value: string): Promise<void> {
    const parsed = parseCredentialRef(ref)
    if (parsed.kind === 'file') {
      writeCredentialFileAtomic(parsed.path, value)
      return
    }
    this.ensureLoaded()
    this.cache = { ...this.cache, [ref]: value }
    this.persist()
  }

  async unset(ref: string): Promise<void> {
    // ⚠️ 文件引用**不删文件**：它可能被官方客户端或其它网关共享。删除它等于
    // 破坏本服务之外的消费者的凭据，且无法恢复（refresh token 一次性）。
    // 摘除引用由调用方（账号池）从账号索引里去掉该条目完成。
    if (parseCredentialRef(ref).kind === 'file') return
    this.ensureLoaded()
    if (this.cache[ref] === undefined) return
    const next = { ...this.cache }
    delete next[ref]
    this.cache = next
    this.persist()
  }

  /** 列出全部 ref 名（**不含值**），供备份与诊断。 */
  listRefs(): string[] {
    this.ensureLoaded()
    return Object.keys(this.cache).sort()
  }

  /** 全部凭据的深拷贝（供备份导出；调用方负责妥善保管）。 */
  snapshot(): Record<string, string> {
    this.ensureLoaded()
    return { ...this.cache }
  }

  /** 整体替换（供备份导入）。 */
  async replaceAll(values: Record<string, string>): Promise<void> {
    const next: Record<string, string> = {}
    for (const [ref, value] of Object.entries(values)) {
      if (typeof value !== 'string') continue
      // 备份里可能含文件引用的键（`backup.ts` 导出时内联了内容）。这里按引用
      // 语义写回**外部文件**，而不是把 `FILE:...` 当成一个普通键存进本文件。
      const parsed = parseCredentialRef(ref)
      if (parsed.kind === 'file') {
        try {
          writeCredentialFileAtomic(parsed.path, value)
        } catch {
          // 路径不可写（盘符不存在、权限不足）：跳过而不是让整次导入失败，
          // 账号索引仍会导入，该账号表现为「凭据缺失」并给出可读提示。
        }
        continue
      }
      next[ref] = value
    }
    this.cache = next
    this.loaded = true
    this.persist()
  }
}

/**
 * 解析数据目录。
 *
 * 优先级：`ALL_PROXY_DATA_DIR` → `<仓库根>/data`。
 * 测试通过 `ALL_PROXY_DATA_DIR` 指向临时目录，**绝不碰真实数据**。
 */
export function resolveDataDir(repoRoot: string): string {
  const override = process.env.ALL_PROXY_DATA_DIR
  if (override !== undefined && override.trim().length > 0) return override.trim()
  return join(repoRoot, 'data')
}
