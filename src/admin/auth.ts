/**
 * 管理端鉴权与操作留痕。
 *
 * ## 为什么管理端必须用**独立**凭据
 *
 * 普通 API Key 会被分发给各种客户端（编辑器插件、脚本、第三方应用）。
 * 若管理 API 接受同一把 key，任何拿到 key 的客户端都能：
 * 读出全部账号、导出凭据备份、把模型全关掉。
 * 因此管理端有自己的口令，且**普通 key 一律拒绝**（规格 `access-control`）。
 *
 * ## 默认仅监听本机
 *
 * 管理端能导出凭据，暴露到局域网等于把 10 个平台的账号凭证交出去。
 * 故默认绑定 `127.0.0.1`；一旦监听地址不是本机，**强制**要求设置管理口令，
 * 否则启动失败 —— 而不是打印一条警告后照常裸奔。
 */

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { IncomingMessage } from 'node:http'
import { writeFileAtomic, type Logger } from '../pool/store.js'

/** 管理端凭据文件名。 */
export const ADMIN_CREDENTIAL_FILE = 'admin-credential.json'

/** 管理口令的最小长度（**对外监听**时的硬约束）。 */
export const MIN_ADMIN_SECRET_LENGTH = 12

/**
 * 管理口令的最小长度（**仅本机监听**时的约束）。
 *
 * 分级理由：管理端能导出全部账号凭据，一旦监听非本机地址，短口令等于把
 * 10 个平台的账号凭证拱手送人（规格 `access-control` 的硬要求）；但服务
 * 默认只监听 127.0.0.1，本机场景的猜解攻击面小，用户自用不要求 12 位
 * 那么难记——4 位即可，其余安全策略（401 不泄露存在性、留痕）不变。
 */
export const MIN_LOOPBACK_ADMIN_SECRET_LENGTH = 4

/** 落盘结构。 */
interface AdminCredentialFile {
  /** `sha256(口令)` 的 hex。 */
  hash: string
  /** 创建时刻（ISO）。 */
  createdAt: string
  /**
   * 是否由系统自动生成（自动生成时会在启动日志里打印一次明文，
   * 让用户能首次登录；用户自设的则不打印）。
   */
  generated: boolean
}

/** 管理端鉴权器。 */
export class AdminAuth {
  private readonly path: string
  private cache: AdminCredentialFile | undefined
  /** 最近若干条管理操作留痕（内存即可，进程重启后清空）。 */
  private readonly audit: AdminAuditEntry[] = []
  /**
   * 自动生成口令的明文（**仅存在于内存**）。
   *
   * 存在时说明这是本次启动刚生成的口令，调用方应把它打印到启动日志里，
   * 否则用户永远登不进来。用户自设或已落盘的口令这里恒为 `undefined`。
   */
  private bootstrapSecret: string | undefined

  constructor(
    private readonly dataDir: string,
    private readonly logger: Logger = { info: () => {}, warn: () => {}, error: () => {} },
  ) {
    this.path = join(dataDir, ADMIN_CREDENTIAL_FILE)
  }

  /** 凭据文件路径（供测试与诊断）。 */
  get filePath(): string {
    return this.path
  }

  /**
   * 确保存在一份管理凭据。
   *
   * 优先级：`ALL_PROXY_ADMIN_SECRET` 环境变量 → 已有文件 → 自动生成。
   *
   * @param logger - 打印一次性口令用。
   * @param options.minSecretLength - 环境变量口令的最小长度。
   *   缺省 {@link MIN_ADMIN_SECRET_LENGTH}(12，面向对外监听的硬约束)；
   *   serve 组装层按监听地址传 4（仅本机，见 {@link MIN_LOOPBACK_ADMIN_SECRET_LENGTH}）。
   * @returns 本次启动需要打印给用户的一次性明文（无则为 `undefined`）。
   *   **只有自动生成时才有值** —— 用户自设的口令不该出现在日志里。
   */
  ensure(logger?: Logger, options: { minSecretLength?: number } = {}): string | undefined {
    const minLength = options.minSecretLength ?? MIN_ADMIN_SECRET_LENGTH
    const envSecret = process.env['ALL_PROXY_ADMIN_SECRET']
    if (envSecret !== undefined && envSecret.trim().length > 0) {
      const secret = envSecret.trim()
      if (secret.length < minLength) {
        throw new Error(
          `ALL_PROXY_ADMIN_SECRET 太短（至少 ${minLength} 字符）。`
          + (minLength >= MIN_ADMIN_SECRET_LENGTH
            ? '管理口令能导出全部账号凭据，对外监听时短口令等于没有保护。'
            : '本机监听可用短口令；对外监听时至少需要 '
              + `${MIN_ADMIN_SECRET_LENGTH} 字符。`),
        )
      }
      // 环境变量优先：把它写盘，使「重启后仍可用」与「改了环境变量就换口令」都成立。
      this.persist({ hash: hashSecret(secret), createdAt: new Date().toISOString(), generated: false })
      return undefined
    }
    if (existsSync(this.path)) {
      this.load()
      return undefined
    }
    // 首次启动：自动生成一个强口令并打印一次。
    const generated = randomBytes(24).toString('base64url')
    this.persist({ hash: hashSecret(generated), createdAt: new Date().toISOString(), generated: true })
    this.bootstrapSecret = generated
    ;(logger ?? this.logger).info(
      '[admin] 已生成管理口令（仅本次启动打印，请立即保存）：\n'
      + `        ${generated}\n`
      + `        也可用环境变量 ALL_PROXY_ADMIN_SECRET 自设（至少 ${MIN_ADMIN_SECRET_LENGTH} 字符）。`,
    )
    return generated
  }

  /** 本次启动自动生成的口令（供启动横幅使用）。 */
  generatedSecret(): string | undefined {
    return this.bootstrapSecret
  }

  private load(): AdminCredentialFile | undefined {
    if (this.cache !== undefined) return this.cache
    try {
      const parsed = JSON.parse(readFileSync(this.path, 'utf-8')) as Partial<AdminCredentialFile>
      if (typeof parsed.hash !== 'string' || parsed.hash.length === 0) return undefined
      this.cache = {
        hash: parsed.hash,
        createdAt: typeof parsed.createdAt === 'string' ? parsed.createdAt : new Date().toISOString(),
        generated: parsed.generated === true,
      }
      return this.cache
    } catch (error) {
      this.logger.warn(`[admin] 读取管理凭据失败（本次视为未配置）: ${String(error)}`)
      return undefined
    }
  }

  private persist(value: AdminCredentialFile): void {
    this.cache = value
    writeFileAtomic(this.path, JSON.stringify(value, null, 2))
  }

  /**
   * 校验管理口令。
   *
   * 用哈希 + 定长比较：即使本机被同机其他进程嗅探，也无法通过响应时间
   * 逐字节试出口令。
   */
  verify(secret: string): boolean {
    const current = this.load()
    if (current === undefined) return false
    if (secret.length === 0) return false
    return constantTimeEqualsHex(current.hash, hashSecret(secret))
  }

  /** 记录一条管理操作留痕（**不记凭据明文**）。 */
  record(action: string, target: string, ok: boolean): void {
    this.audit.push({ at: new Date().toISOString(), action, target, ok })
    // 只留最近 500 条：这是诊断信息，不是业务数据。
    if (this.audit.length > 500) this.audit.splice(0, this.audit.length - 500)
  }

  /** 读取管理操作留痕（最新在后）。 */
  entries(): readonly AdminAuditEntry[] {
    return this.audit
  }
}

/** 一条管理操作留痕。 */
export interface AdminAuditEntry {
  at: string
  /** 操作名（`create-key` / `delete-account` / `import-dsh` …）。 */
  action: string
  /** 目标标识（key id、账号 id、provider id …）。**绝不含凭据明文**。 */
  target: string
  /** 是否成功。 */
  ok: boolean
}

/** 计算口令哈希。 */
export function hashSecret(secret: string): string {
  return createHash('sha256').update(secret, 'utf8').digest('hex')
}

/** 定长比较两个 hex 串。 */
function constantTimeEqualsHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  try {
    return timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'))
  } catch {
    return false
  }
}

/**
 * 判断某监听地址是否「仅本机」。
 *
 * `0.0.0.0` / `::` 都表示监听全部网卡，**不是**本机限定。
 */
export function isLoopbackHost(host: string): boolean {
  const normalized = host.trim().toLowerCase()
  return normalized === '127.0.0.1'
    || normalized === 'localhost'
    || normalized === '::1'
    || normalized === '[::1]'
}

/**
 * 校验监听地址与管理凭据的组合是否安全。
 *
 * @throws 当监听非本机却没有可用管理口令时。
 */
export function assertAdminSafety(host: string, auth: AdminAuth, logger?: Logger): void {
  if (isLoopbackHost(host)) return
  const configured = (process.env['ALL_PROXY_ADMIN_SECRET'] ?? '').trim()
  if (configured.length >= MIN_ADMIN_SECRET_LENGTH) {
    logger?.warn(
      `[admin] ⚠️ 服务监听在 ${host}（非本机）。管理端可导出全部账号凭据，请确保网络可达范围可信。`,
    )
    return
  }
  // 走到这里说明：对外监听 + 没有自设口令。自动生成的口令虽然也存在，
  // 但它只打印在启动日志里，用户很可能没注意到 —— 对外暴露时不能靠它兜底。
  throw new Error(
    `服务监听在 ${host}（非本机），但未设置管理口令。\n`
    + '管理端可以导出全部账号凭据，对外监听时必须设置 ALL_PROXY_ADMIN_SECRET'
    + `（至少 ${MIN_ADMIN_SECRET_LENGTH} 字符）。\n`
    + '若只想本机使用，请把 ALL_PROXY_HOST 设为 127.0.0.1。',
  )
}

/**
 * 从请求里提取管理口令。
 *
 * 支持三种携带方式（按优先级）：
 * 1. `Authorization: Bearer <口令>`（curl / SDK 通用）；
 * 2. `x-admin-secret: <口令>`（浏览器端避免与 API Key 头混淆）；
 * 3. `?admin_secret=` 查询参数（**仅**用于首次在浏览器里打开页面，
 *    因为它会留在浏览器历史与代理日志里）。
 */
export function extractAdminSecret(req: IncomingMessage, url?: URL): string {
  const authorization = firstHeader(req.headers['authorization'])
  if (authorization !== undefined) {
    const match = /^Bearer\s+(.+)$/i.exec(authorization.trim())
    if (match !== null && match[1] !== undefined) return match[1].trim()
  }
  const header = firstHeader(req.headers['x-admin-secret'])
  if (header !== undefined && header.trim().length > 0) return header.trim()
  const query = url?.searchParams.get('admin_secret')
  return query === null || query === undefined ? '' : query.trim()
}

/** 取头部的单值。 */
function firstHeader(value: string | string[] | undefined): string | undefined {
  if (value === undefined) return undefined
  return Array.isArray(value) ? value[0] : value
}
