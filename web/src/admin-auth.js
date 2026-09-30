/**
 * 管理端鉴权层：让全部 `/api/*` 请求自动携带管理口令。
 *
 * ## 为什么要这层（真实缺陷）
 *
 * 后端的管理 API 用**独立管理口令**（`access-control` 规格：普通 API Key
 * 不足以访问管理端）。早期前端的所有请求都只带 `Content-Type`，不带口令，
 * 于是「确认导入」等写操作一律 401「需要管理口令」——只读探测（backup.status）
 * 失败还被 jet-hub 静默吞掉，用户看不出是没带凭据。
 *
 * ## 口令的生命周期
 *
 * 1. 优先从 URL `?admin_secret=` 读取一次（浏览器里首次打开页面最省事），
 *    **读后立即用 `history.replaceState` 从地址栏清除**——查询参数会留在
 *    浏览器历史与代理日志里，不能让它比一次跳转活得更久；
 * 2. 其次复用 `sessionStorage` 里的口令（同一个标签页内不再重复询问）；
 * 3. 都没有 → 渲染口令输入门（`AdminShell` 的 gate），验证通过才进界面。
 *
 * 口令随每个请求放 `x-admin-secret` 头（而不是 URL），避免落进历史/日志。
 * 服务端重启后口令更换 → 请求 401 → 这里自动清除本地口令并让 gate 重新出现。
 */

const STORAGE_KEY = 'all-proxy-admin-secret'

/** 当前口令（模块级单例；sessionStorage 是它的持久化形态）。 */
let current = ''

/** 从 sessionStorage 恢复口令。 */
export function restoreSecret() {
  if (current.length === 0) {
    try {
      current = sessionStorage.getItem(STORAGE_KEY) ?? ''
    } catch {
      current = ''
    }
  }
  return current
}

/** 保存口令（sessionStorage；标签页关闭即失效，不落 localStorage）。 */
export function storeSecret(secret) {
  current = secret
  try {
    sessionStorage.setItem(STORAGE_KEY, secret)
  } catch {
    // 隐私模式等场景下 sessionStorage 不可用：退化为仅内存持有。
  }
}

export function clearSecret() {
  current = ''
  try {
    sessionStorage.removeItem(STORAGE_KEY)
  } catch { /* 同上 */ }
}

/**
 * 从 URL `?admin_secret=` 初始化口令。
 *
 * 成功读取后把参数从地址栏清除（历史与分享出去的链接不再携带口令）。
 */
export function initSecretFromUrl() {
  try {
    const url = new URL(window.location.href)
    const secret = url.searchParams.get('admin_secret')
    if (secret !== null && secret.trim().length > 0) {
      storeSecret(secret.trim())
      url.searchParams.delete('admin_secret')
      window.history.replaceState(null, '', url.toString())
      return true
    }
  } catch {
    // 非 http 环境（测试/文件协议）：跳过。
  }
  return false
}

/** 当前是否有可用口令。 */
export function hasSecret() {
  return restoreSecret().length > 0
}

/** 401 且是管理鉴权失败的错误标记（gate 据此重新弹出输入框）。 */
export class AdminUnauthorizedError extends Error {
  constructor() {
    super('管理口令缺失或已失效，请重新输入')
    this.name = 'AdminUnauthorizedError'
    this.code = 'ADMIN_UNAUTHORIZED'
  }
}

/**
 * 带管理口令的 fetch：所有 `/api/*` 请求都应走这里。
 *
 * 401（管理鉴权失败）时自动清除本地口令并抛 {@link AdminUnauthorizedError}，
 * 让上层界面回到口令输入门，而不是把一堆 401 文案散落各处。
 */
export async function adminFetch(path, init = {}) {
  const headers = new Headers(init.headers)
  restoreSecret()
  if (current.length > 0) headers.set('x-admin-secret', current)
  const response = await fetch(path, { ...init, headers })
  const text = await response.text()
  let body = undefined
  try {
    body = text.length > 0 ? JSON.parse(text) : undefined
  } catch {
    body = undefined
  }
  if (!response.ok) {
    if (response.status === 401) {
      // 口令可能已被服务端更换：清掉本地的，回到输入门。
      clearSecret()
      throw new AdminUnauthorizedError()
    }
    const message = body?.error?.message
      ?? `管理 API 请求失败（HTTP ${response.status}）`
    throw new Error(message)
  }
  return body
}
