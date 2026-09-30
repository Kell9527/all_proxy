/**
 * 凭据引用（`credentialRef`）的形态解析。
 *
 * ## 两种形态
 *
 * | 形态 | 例子 | 凭据存在哪 |
 * |---|---|---|
 * | 内置（默认） | `RACCOON_ACCOUNT_443D46EE` | 本项目 `data/credentials.json` |
 * | 文件引用 | `FILE:D:\...\auth-a.json` | **外部文件**（本项目只读写，不拥有） |
 *
 * ## 为什么需要文件引用
 *
 * 有些 provider 的 `refresh_token` 是**一次性轮换**的（raccoon / codearts / trae）：
 * 用一次即作废。若同一账号的凭据被多个消费者各存一份副本（本服务、官方客户端、
 * 其它网关），谁先刷新谁的副本就换新，**其余副本立即变成死 token**，表现为
 * 反复「续期失败：登录态已过期」。用户报障「Raccoon 账号容易过期」正是此因。
 *
 * 文件引用让所有消费者**共享同一个文件**：取用前实时读、刷新后原子写回，
 * 于是任何一方刷新，其余各方下次读取都能拿到最新值，不再互相作废。
 *
 * ## 为什么用前缀而不是新增字段
 *
 * `credentialRef` 本来就是字符串，且在 `state.json` / 备份文件 / 管理端之间
 * 原样透传。加前缀后**无需改任何 schema**；若新增 `credentialFile` 字段，
 * 则要改十几处读 `credentialRef` 的地方（账号池、备份、管理端、各 auth 服务），
 * 且要处理两个字段同时存在时的优先级 —— 得不偿失。
 *
 * ## 安全边界
 *
 * - 路径必须**绝对**：相对路径会随进程工作目录漂移，同一个 ref 在不同启动
 *   方式下指向不同文件，属静默的数据错乱。
 * - `~` 展开为用户主目录：用户配置里写 `~/...` 是自然习惯，且配置文件会被
 *   复制到别的机器上（那时两机的主目录名不同）。
 * - 本模块**只做形态解析**，不碰文件系统 —— 真正读写由凭据存储层负责。
 */

import { homedir } from 'node:os'
import { isAbsolute, join } from 'node:path'

/** 文件引用的前缀。 */
export const FILE_REF_PREFIX = 'FILE:'

/** 解析后的凭据引用。 */
export type CredentialRefKind =
  | { kind: 'inline'; ref: string }
  | { kind: 'file'; ref: string; path: string }

/**
 * 展开开头的 `~` / `~/` / `~\` 为用户主目录。
 *
 * 与参考项目（xiaohuanxiong2api）的 `expandHome` 语义一致：只处理**开头**的
 * `~`，中间出现的 `~` 是普通字符（Windows 短路径与某些工具会用到）。
 */
export function expandHome(path: string): string {
  const trimmed = path.trim()
  if (trimmed === '~') return homedir()
  if (trimmed.startsWith('~/') || trimmed.startsWith('~\\')) {
    return join(homedir(), trimmed.slice(2))
  }
  return trimmed
}

/**
 * 合成一个文件引用的 ref 字符串。
 *
 * 存进去的就是**展开后**的绝对路径：这样 ref 在任何工作目录下解析到同一个
 * 文件，也让备份文件里的路径可被直接阅读。
 */
export function formatFileRef(path: string): string {
  return `${FILE_REF_PREFIX}${expandHome(path)}`
}

/**
 * 解析凭据引用。
 *
 * `FILE:` 开头的即文件引用，其余一律视为内置 ref。**不做**「看起来像路径就当
 * 文件」的猜测：内置 ref 形态多样（`RACCOON_ACCOUNT_*` / `*_ACCESS_TOKEN`），
 * 猜测规则迟早会误判。
 */
export function parseCredentialRef(ref: string): CredentialRefKind {
  if (typeof ref !== 'string' || !ref.startsWith(FILE_REF_PREFIX)) {
    return { kind: 'inline', ref }
  }
  return { kind: 'file', ref, path: expandHome(ref.slice(FILE_REF_PREFIX.length)) }
}

/** 是否为文件引用。 */
export function isFileRef(ref: string): boolean {
  return parseCredentialRef(ref).kind === 'file'
}

/**
 * 校验一个用户输入的文件路径可否作为凭据文件引用。
 *
 * @returns 合法时返回规范化后的 ref；不合法时返回原因。
 *
 * ⚠️ 只校验**形态**（绝对路径、非空、不含 NUL），不校验文件是否存在 ——
 * 允许先绑定再创建文件（例如先绑到官方客户端将要写出的路径）。
 */
export function validateFileRefInput(
  input: string,
): { ok: true; ref: string; path: string } | { ok: false; message: string } {
  const raw = typeof input === 'string' ? input.trim() : ''
  if (raw.length === 0) return { ok: false, message: '路径不能为空' }
  if (raw.includes('\0')) return { ok: false, message: '路径含非法字符' }
  // 用户可能直接粘贴带前缀的值（从别处复制 ref），容忍它。
  const withoutPrefix = raw.startsWith(FILE_REF_PREFIX) ? raw.slice(FILE_REF_PREFIX.length) : raw
  const path = expandHome(withoutPrefix)
  if (!isAbsolute(path)) {
    return { ok: false, message: '必须是绝对路径（可用 ~ 表示用户主目录）' }
  }
  return { ok: true, ref: formatFileRef(path), path }
}

/**
 * 展示用脱敏：保留文件名与最后一级目录，中间打码。
 *
 * ⚠️ 凭据文件的绝对路径会出现在管理端页面上（有时是共享屏幕或截图场景），
 * 完整路径会泄露用户名等本机信息。保留尾部足以让用户认出是哪个文件。
 */
export function maskCredentialPath(path: string): string {
  const normalized = path.replace(/\\/g, '/')
  const parts = normalized.split('/').filter((p) => p.length > 0)
  if (parts.length === 0) return path
  const tail = parts.slice(-2).join('/')
  // 余下部分若只有盘符或主目录名，仍按「有前缀」展示，保持可读。
  const omitted = parts.length - Math.min(2, parts.length)
  return omitted > 0 ? `…/${tail}` : tail
}
