/**
 * SenseNova（商汤）凭据模型与协议纯函数。
 *
 * 本模块**不做任何 IO**：凭据读取、模型目录解析、错误判定全部是纯函数，
 * 便于单测锁死。网络行为在 `sensenova-adapter.ts`。
 *
 * ## 凭据形态（与其余 10 个 provider 的根本差异）
 *
 * 凭据就是**一把静态 API Key**，没有 refresh token、没有过期时间：
 *
 * ```json
 * { "access_token": "sk-...", "nickname": "sensenova-…NQ" }
 * ```
 *
 * ⚠️ **字段名必须是 `access_token`**，不能叫 `api_key` ——
 * `AccountPool.findAccountIdByCredential` 对非 codearts 的 provider 一律取
 * `access_token` 作身份标识（用于「当前账号」登记、用量归属、限流标记）。
 * 改用别的字段名会让该账号**永远登记不上**，换号/限流全部失效。
 * （同时接受 `api_key` 作为读取别名，以兼容手工写入的凭据文件。）
 */

import type { SensenovaProduct } from './sensenova-product.js'

/** SenseNova 凭据。 */
export interface SensenovaCredential {
  /**
   * 静态 API Key（上游原样，形如 `sk-...`）。
   *
   * ⚠️ 字段名必须是 `access_token`（见文件头说明）。
   */
  access_token: string
  /** `api_key` 读取别名（仅兼容手工写入；写入时统一用 `access_token`）。 */
  api_key?: string
  /** 展示用昵称（账号池卡片；缺省时由管理端按 ref 回退）。 */
  nickname?: string
}

/**
 * 取凭据里的 API Key 明文。
 *
 * 优先 `access_token`，回退 `api_key`（别名，见文件头说明）；都没有则空串。
 */
export function sensenovaToken(credential: SensenovaCredential | undefined): string {
  if (credential === undefined) return ''
  const primary = typeof credential.access_token === 'string' ? credential.access_token.trim() : ''
  if (primary.length > 0) return primary
  const alias = typeof credential.api_key === 'string' ? credential.api_key.trim() : ''
  return alias
}

/** 该凭据是否可用（有一把非空 key）。 */
export function isSensenovaCredentialUsable(credential: SensenovaCredential | undefined): boolean {
  return sensenovaToken(credential).length > 0
}

/**
 * 由 API Key 派生展示昵称（脱敏）。
 *
 * ⚠️ 只露**前 6 后 4**，中间打码：key 是账号凭证，绝不能在管理端卡片、
 * 用量日志、错误响应里出现明文。key 太短（无法安全脱敏）时只显示前缀。
 */
export function sensenovaNicknameFromKey(apiKey: string): string {
  const key = apiKey.trim()
  if (key.length === 0) return 'sensenova'
  if (key.length <= 10) return key
  return `${key.slice(0, 6)}…${key.slice(-4)}`
}

/** 远端模型条目（已归一）。 */
export interface SensenovaRemoteModel {
  id: string
  /** 已规范化的展示名。 */
  name: string
  contextWindow: number
  maxTokens: number
  supportsImage: boolean
}

/**
 * 只放行**安全正整数**。
 *
 * ⚠️ 远端是外部输入：`0` / 负数 / `NaN` 会让调用方在 `defaultMaxTokens`
 * 的硬校验上抛错，整轮对话起不来（不是降级，是崩）。
 */
function positiveInt(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : undefined
}

/** 读字符串数组里是否含某成员（大小写不敏感）。 */
function modalitiesInclude(value: unknown, member: string): boolean {
  if (!Array.isArray(value)) return false
  return value.some((item) => typeof item === 'string' && item.toLowerCase() === member)
}

/**
 * 解析 `GET /v1/models` 的响应。
 *
 * 只保留**输出为文本**的模型（`output_modalities` 含 `text`）——
 * `sensenova-u1.5-lite` 这类出图模型不能作为 chat 目标，混进目录会让用户
 * 选中后必然失败。
 *
 * 垃圾输入返回空数组（而非抛错），由调用方回退兜底表。
 */
export function parseSensenovaModels(value: unknown): SensenovaRemoteModel[] {
  const data = (typeof value === 'object' && value !== null ? (value as Record<string, unknown>).data : undefined)
  if (!Array.isArray(data)) return []
  const out: SensenovaRemoteModel[] = []
  const seen = new Set<string>()
  for (const raw of data) {
    if (typeof raw !== 'object' || raw === null) continue
    const entry = raw as Record<string, unknown>
    const id = typeof entry.id === 'string' ? entry.id.trim() : ''
    if (id.length === 0 || seen.has(id)) continue
    // 只认文本输出：出图模型（output_modalities 只有 image）不进对话目录。
    const outputModalities = entry.output_modalities
    if (Array.isArray(outputModalities) && !modalitiesInclude(outputModalities, 'text')) continue
    seen.add(id)
    const rawName = typeof entry.name === 'string' ? entry.name.trim() : ''
    out.push({
      id,
      name: rawName.length > 0 ? rawName : id,
      // 上下文/输出上限未知时给 0（调用方据此不声明，让上游用默认）。
      contextWindow: positiveInt(entry.context_length) ?? 0,
      maxTokens: positiveInt(entry.max_output_length) ?? 0,
      supportsImage: modalitiesInclude(entry.input_modalities, 'image'),
    })
  }
  return out
}

/**
 * 拼出 `chat/completions` 的完整 URL。
 *
 * 独立成纯函数以便单测断言（避免在适配器里手拼字符串时漏掉分隔斜杠）。
 */
export function sensenovaChatUrl(product: SensenovaProduct): string {
  return `${product.apiBase}${product.chatPath}`
}

/** 拼出模型目录的完整 URL。 */
export function sensenovaModelsUrl(product: SensenovaProduct): string {
  return `${product.apiBase}${product.modelsPath}`
}
