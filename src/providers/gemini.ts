/**
 * Gemini 协议族的**最小共享词汇**。
 *
 * ## 为什么只搬这一小撮
 *
 * 本项目移植 Accio（阿里）时，其 SSE 消费复用来源的 `consumeGeminiSse`
 * （`gemini-messages.ts`）。该模块只依赖本文件的这几个**纯函数/常量**：
 *
 * - `deriveGeminiSessionId` —— 会话 id 派生；
 * - `GEMINI_DEFAULT_PROJECT` / `GEMINI_SESSION_LANE_INFER` —— 缺省值；
 * - `GEMINI_IDLE_TIMEOUT_MS` —— SSE 空闲超时；
 * - `sanitizeGeminiSchema` —— 工具 schema 清洗；
 * - `sortedStringify` —— 字母序序列化；
 * - `GeminiModelSpec` / `GeminiInlineImage` —— 类型。
 *
 * 来源的 `gemini.ts` 有 719 行，其余大部分是 **Gemini Code Assist provider
 * 自身**的 OAuth / 凭据 / 端点 / 模型档表 —— Accio **完全用不到**（它自己的
 * 端点、凭据、模型表在 `accio-*.ts`）。故这里只保留被 `gemini-messages.ts`
 * 引用的符号，**不搬 OAuth/端点/档表**，避免把无关的 500 行拖进来。
 *
 * ⚠️ 若日后真要移植 Gemini provider，应把来源 `gemini.ts` 的其余部分补齐，
 * 届时本文件可被整体替换。
 */

import { randomBytes } from 'node:crypto'

/** 缺省 project（`loadCodeAssist` 免费档回落值）。 */
export const GEMINI_DEFAULT_PROJECT = 'aicode-consumers'

/** 会话派生标签：推理。 */
export const GEMINI_SESSION_LANE_INFER = 'infer'

/** SSE 帧间空闲超时（毫秒）。 */
export const GEMINI_IDLE_TIMEOUT_MS = 120_000

/** 已内联的图片（`attachmentId` → base64 与 mediaType）。 */
export interface GeminiInlineImage {
  mediaType: string
  /** **裸 base64**（不含 `data:` 前缀）—— `inlineData.data` 要的就是它。 */
  data: string
}

/** 思考档位。 */
export type GeminiTier = 'low' | 'medium' | 'high' | 'tiered'

/** 一个模型档位规格。 */
export interface GeminiModelSpec {
  /** 真正发给上游的模型名（带档位后缀）。 */
  readonly upstream: string
  readonly tier: GeminiTier
  readonly thinkingBudget: number
  /** **恒 true**（「关闭思考」是假关）。 */
  readonly includeThoughts: true
}

/**
 * 按 `(project, 首条 user 文本, lane)` **确定性派生** sessionId。
 *
 * ⚠️ 用 FNV-1a 复刻的是**依赖维度与「同输入同输出」**，不是与原版逐字相同的
 * 数值（原版哈希函数本体尚未反推出来）。输出形态对齐原版：有符号 int64 的
 * 十进制串。
 *
 * ⚠️ `generation === 0` 时**不把代数拼进输入** —— 必须与升代前逐字同值。
 */
export function deriveGeminiSessionId(
  project: string,
  firstUserText: string,
  lane: string,
  generation = 0,
): string {
  let hash = 0xcbf29ce484222325n
  const prime = 0x100000001b3n
  const mask = 0xffffffffffffffffn
  const base = `${project}\u0000${lane}\u0000${firstUserText}`
  const input = generation > 0 ? `${base}\u0000${generation}` : base
  for (const byte of Buffer.from(input, 'utf8')) {
    hash = (hash ^ BigInt(byte)) & mask
    hash = (hash * prime) & mask
  }
  // 按**有符号** 64 位解释（原版取值有正有负）。
  return BigInt.asIntN(64, hash).toString()
}

/** 生成每请求随机的 requestId（原版 `newRequestID()`）。 */
export function newGeminiRequestId(nowMs: number = Date.now()): string {
  return `agent/${nowMs}/${randomBytes(4).toString('hex')}`
}

/** 递归按键名升序重建对象。 */
function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue)
  if (value === null || typeof value !== 'object') return value
  const source = value as Record<string, unknown>
  const out: Record<string, unknown> = {}
  for (const key of Object.keys(source).sort()) out[key] = sortValue(source[key])
  return out
}

/** 按键名升序序列化（{@link sortValue} 的 JSON 出口）。 */
export function sortedStringify(value: unknown): string {
  return JSON.stringify(sortValue(value))
}

/** Gemini 工具 schema 白名单（白名单外的键会让上游 400）。 */
export const GEMINI_SCHEMA_KEYS: ReadonlySet<string> = new Set([
  'type',
  'format',
  'description',
  'nullable',
  'enum',
  'items',
  'minItems',
  'maxItems',
  'properties',
  'required',
  'minProperties',
  'maxProperties',
  'minLength',
  'maxLength',
  'pattern',
  'anyOf',
  'propertyOrdering',
  'minimum',
  'maximum',
])

/**
 * 递归清洗工具参数 schema（原版 `SanitizeGeminiSchema`）。
 *
 * 三条规则：
 * 1. 白名单外的键整键删除；
 * 2. `properties` / `items` / `anyOf` 递归清洗（`items` 可能是对象或数组）；
 * 3. `type` 为数组形态（如 `['string','null']`）时收敛成单个 type 并补
 *    `nullable: true`；`enum` 只要含**任何非字符串**值就整删。
 */
export function sanitizeGeminiSchema(schema: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(schema)) {
    if (!GEMINI_SCHEMA_KEYS.has(key)) continue

    if (key === 'properties') {
      if (typeof value !== 'object' || value === null || Array.isArray(value)) continue
      const properties: Record<string, unknown> = {}
      for (const [name, child] of Object.entries(value as Record<string, unknown>)) {
        if (typeof child !== 'object' || child === null || Array.isArray(child)) continue
        properties[name] = sanitizeGeminiSchema(child as Record<string, unknown>)
      }
      out.properties = properties
      continue
    }

    if (key === 'items') {
      if (Array.isArray(value)) {
        out.items = value
          .filter((item): item is Record<string, unknown> => (
            typeof item === 'object' && item !== null && !Array.isArray(item)
          ))
          .map((item) => sanitizeGeminiSchema(item))
        continue
      }
      if (typeof value === 'object' && value !== null) {
        out.items = sanitizeGeminiSchema(value as Record<string, unknown>)
      }
      continue
    }

    if (key === 'anyOf') {
      if (!Array.isArray(value)) continue
      out.anyOf = value
        .filter((item): item is Record<string, unknown> => (
          typeof item === 'object' && item !== null && !Array.isArray(item)
        ))
        .map((item) => sanitizeGeminiSchema(item))
      continue
    }

    if (key === 'type') {
      if (typeof value === 'string') {
        out.type = value
        continue
      }
      if (Array.isArray(value)) {
        const types = value.filter((item): item is string => typeof item === 'string')
        const nonNull = types.filter((item) => item !== 'null')
        if (nonNull.length > 0) out.type = nonNull[0]
        // 出现 'null' ⇒ 该字段可空。原版用 nullable 表达。
        if (nonNull.length !== types.length) out.nullable = true
      }
      continue
    }

    if (key === 'enum') {
      if (Array.isArray(value) && value.every((item) => typeof item === 'string')) {
        out.enum = [...value]
      }
      continue
    }

    out[key] = value
  }
  return out
}
