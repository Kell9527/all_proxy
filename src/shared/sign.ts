/**
 * 华为云 `SDK-HMAC-SHA256` 请求签名。
 *
 * 用于 CodeArts（华为云）的每个后端 API 请求，以及「每日签到得积分」的领取请求。
 * 只用 WebCrypto（`crypto.subtle`），无第三方依赖。
 *
 * ## 两个必须记住的坑（来源仓库已踩过，移植时保留）
 *
 * 1. **`maas_type: benefit` 必须参与签名**：benefit（免费额度）模型的 chat 请求
 *    必须携带该头，且该头**进入 canonical request 与 SignedHeaders**，否则后端
 *    返回 `InferHub.002002009.404 The model is not registered`。
 * 2. **反过来，`Agent-Type` / `X-Language` 绝不能参与签名**：实测把它们作为
 *    `extraHeaders` 传入会回 `401 APIG.0301 verify ak sk signature fail`；
 *    必须**签名后追加**。
 *
 * 这两个结论方向相反，不要据此互相推断。
 */

/** 计算 `SHA-256` 并输出小写十六进制。 */
export async function sha256Hex(data: Uint8Array): Promise<string> {
  const hash = await crypto.subtle.digest('SHA-256', data.slice().buffer as ArrayBuffer)
  return Array.from(new Uint8Array(hash)).map((b) => b.toString(16).padStart(2, '0')).join('')
}

/** 计算 `HMAC-SHA256` 并输出小写十六进制。 */
export async function hmacSha256Hex(key: Uint8Array, data: Uint8Array): Promise<string> {
  const cryptoKey = await crypto.subtle.importKey('raw', key.slice().buffer as ArrayBuffer, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  const sig = await crypto.subtle.sign('HMAC', cryptoKey, data.slice().buffer as ArrayBuffer)
  return Array.from(new Uint8Array(sig)).map((b) => b.toString(16).padStart(2, '0')).join('')
}

/** 拼装 canonical request（签名头按字典序排序）。 */
export function buildCanonicalRequest(
  method: string,
  uri: string,
  query: string,
  headers: Map<string, string>,
  payloadHash: string,
): string {
  const signedHeaders: string[] = []
  headers.forEach((_, k) => signedHeaders.push(k))
  signedHeaders.sort()
  const headerLines = signedHeaders.map((k) => `${k}:${headers.get(k) ?? ''}`)
  return [method, uri, query, headerLines.join('\n'), '', signedHeaders.join(';'), payloadHash].join('\n')
}

/**
 * 签名一个华为请求；返回需合并到请求中的头映射。
 *
 * @param ak - access key id。
 * @param sk - secret access key。
 * @param securityToken - STS 安全令牌。
 * @param method - HTTP 方法。
 * @param urlStr - 完整 URL。
 * @param body - 请求体字节（GET 传空）。
 * @param extraHeaders - **参与签名**的额外头（如 `maas_type: benefit`）。
 *   ⚠️ 仅用于确实需要签名的头；只用于标识用途的头必须在签名**之后**追加。
 */
export async function signRequestHuawei(
  ak: string,
  sk: string,
  securityToken: string,
  method: string,
  urlStr: string,
  body: Uint8Array,
  extraHeaders?: Readonly<Record<string, string>>,
): Promise<Map<string, string>> {
  const url = new URL(urlStr)
  let uri = url.pathname
  if (!uri.endsWith('/')) uri += '/'
  const query = url.search.slice(1)
  const dateStamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z')
  const payloadHash = await sha256Hex(body)

  const headers = new Map<string, string>()
  headers.set('host', url.host)
  headers.set('x-sdk-date', dateStamp)
  headers.set('x-sdk-content-sha256', payloadHash)
  headers.set('x-security-token', securityToken)
  // 额外的签名头（如 benefit 模型的 maas_type）：与参考实现一致，
  // 参与 canonical 计算并包含在 SignedHeaders 中，需原样随请求发送。
  if (extraHeaders !== undefined) {
    for (const [key, value] of Object.entries(extraHeaders)) headers.set(key, value)
  }
  // GET 请求（排队状态轮询）不携带请求体，因此无 content-type。
  if (method.toUpperCase() !== 'GET') headers.set('content-type', 'application/json')

  const signedHeaders: string[] = []
  headers.forEach((_, k) => signedHeaders.push(k))
  signedHeaders.sort()

  const canonicalRequest = buildCanonicalRequest(method, uri, query, headers, payloadHash)
  const canonicalHash = await sha256Hex(new TextEncoder().encode(canonicalRequest))
  const stringToSign = `SDK-HMAC-SHA256\n${dateStamp}\n${canonicalHash}`
  const signature = await hmacSha256Hex(new TextEncoder().encode(sk), new TextEncoder().encode(stringToSign))
  headers.set('Authorization', `SDK-HMAC-SHA256 Access=${ak},SignedHeaders=${signedHeaders.join(';')},Signature=${signature}`)
  return headers
}
