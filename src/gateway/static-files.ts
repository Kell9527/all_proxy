/**
 * 管理端静态资源托管（生产态由网关直接服务，design D7 单进程同源）。
 *
 * ## 缓存策略
 *
 * Vite 构建的 `assets/*` 文件名自带内容哈希（`index-B1xY2z.js`），内容永不变，
 * 故可给**一年 immutable**；入口 `index.html` 必须每次校验（它引用的哈希文件名
 * 会随构建变化），否则用户会拿到旧入口、加载已被删掉的旧哈希文件而白屏。
 *
 * ## 路径安全
 *
 * 只服务 root 内的文件：`resolve` 后必须仍在 root 内，否则 403 —— 防
 * `GET /../../.env` 式路径穿越把凭据文件吐出去。
 */

import { createReadStream, existsSync, statSync } from 'node:fs'
import { extname, join, resolve, sep } from 'node:path'
import type { ServerResponse } from 'node:http'

/** 常见静态类型的 MIME（Vite 产物覆盖这些就够了）。 */
const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.map': 'application/json; charset=utf-8',
}

/** 带内容哈希的资产路径（Vite 默认 `assets/name-HASH.ext`）。 */
const HASHED_ASSET_RE = /-[\w-]{8,}\.\w+$/

/** 解析 URL 路径为 root 内的安全文件路径；越界返回 `undefined`。 */
export function resolveStaticFile(root: string, urlPath: string): string | undefined {
  const clean = urlPath.split('?')[0]!
  const resolved = resolve(join(root, clean))
  // ⚠️ 路径穿越防线：resolve 后必须仍在 root 目录内（含 root 本身）。
  if (resolved !== root && !resolved.startsWith(root + sep)) return undefined
  return resolved
}

/**
 * 尝试按静态资源处理请求。
 *
 * @returns 是否已处理（`true` 时响应已写出）。SPA 路由回退到 `index.html`。
 */
export function serveStatic(root: string, urlPath: string, res: ServerResponse): boolean {
  let filePath = resolveStaticFile(root, urlPath)
  if (filePath === undefined) {
    res.writeHead(403)
    res.end()
    return true
  }
  if (!existsSync(filePath) || !statSync(filePath).isFile()) {
    // SPA 回退：非资产路径都回入口页（前端自己路由）。
    const fallback = join(root, 'index.html')
    if (!existsSync(fallback)) return false
    filePath = fallback
  }
  const ext = extname(filePath)
  const contentType = MIME[ext] ?? 'application/octet-stream'
  // 哈希资产 → 一年 immutable；其余（入口 HTML 等）→ 每次校验。
  const cacheControl = HASHED_ASSET_RE.test(filePath) && ext !== '.html'
    ? 'public, max-age=31536000, immutable'
    : 'no-cache'
  res.writeHead(200, { 'Content-Type': contentType, 'Cache-Control': cacheControl })
  createReadStream(filePath).pipe(res)
  return true
}
