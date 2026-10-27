/**
 * OfficeAce（华为 ModelArts MaaS 办公助手）产品配置。
 *
 * 移植自来源 `src/officeace-product.ts`，**零 import**（纯常量）。
 *
 * ## 鉴权（2026-10-12 实测打通）
 *
 * ```
 * Authorization: Basic base64(model_app_key + ":" + model_app_secret)
 * ```
 *
 * 推理用 Basic 凭据；登录用华为云 OAuth（PKCE + DPoP），见 `officeace-auth.ts`。
 *
 * ## 模型
 *
 * `/v2/models` 返回 11 个。⚠️ 端点返回 **`reasoning_content`**（思考链独立字段），
 * 流式解析需兼容（`consumeOpenAiSse` 已支持）。
 */

/** 华为 MaaS 端点（OfficeAce 预置账号走这个代理域）。 */
const DEFAULT_BASE_URL = 'https://officeace.cn-southwest-2.huaweicloud-agentarts.com'

/** 官方 MaaS 直连域（`/v2/models` 同样可用）。 */
export const OFFICIAL_MAAK_BASE_URL = 'https://api.modelarts-maas.com'

export interface OfficeAceProduct {
  readonly id: 'officeace'
  readonly displayName: string
  /** 面板上显示的额度单位（华为云按 token 计费）。 */
  readonly quotaUnit: string
  readonly defaultBaseUrl: string
  readonly chatPath: string
  readonly modelsPath: string
  /** 会话级超时（毫秒）。推理含思考链，给足。 */
  readonly requestTimeoutMs: number
  /** 首字节超时。 */
  readonly headerTimeoutMs: number
  /** SSE 帧间空闲超时。 */
  readonly chunkTimeoutMs: number
}

export const OFFICEACE: OfficeAceProduct = {
  id: 'officeace',
  displayName: 'OfficeAce (华为云)',
  quotaUnit: 'Token',
  defaultBaseUrl: DEFAULT_BASE_URL,
  chatPath: '/v2/chat/completions',
  modelsPath: '/v2/models',
  requestTimeoutMs: 600_000,
  headerTimeoutMs: 180_000,
  chunkTimeoutMs: 300_000,
}

/**
 * 暴露的模型（精选常用的 8 个；全部 11 个里 2 个 test 档不暴露）。
 *
 * ⚠️ 网关 `/v2/models` 返回的是平台目录，**不保证该账号已订阅** —— 但预置账号
 * 实测全目录可用。
 *
 * ## `multimodal`（2026-10-13 实测）
 *
 * `/v2/models` **不返回任何能力元数据**（只有 id），故逐个用 1×1 红色 PNG 以
 * 标准 OpenAI `image_url` parts 实测：
 *
 * | 模型 | 图片输入 | 证据 |
 * |---|---|---|
 * | `deepseek-v4.1-flash` | ✅ | HTTP 200，正常描述图片内容 |
 * | `kimi-k2.6` | ✅ | HTTP 200，正常描述图片内容 |
 * | `deepseek-v4-flash` | ❌ | 400 ModelArts.81001 参数校验失败 |
 * | `glm-5.3` / `5.2` / `5.1` | ❌ | 400 ModelArts.81001（content[1] 字段不认） |
 * | `qwen3-32b` / `30b-a3b` | ❌ | 400「is not a multimodal model」（服务端明说） |
 *
 * ⚠️ 此表是**图片准入闸门**的依据：不声明 `image` 时附件在入库阶段就被拒。
 * 漏报只是少个功能；**误报**会让用户选了不支持图片的模型却收到含图请求 ——
 * 上游 400，一轮对话报废。故只登记**实测通过**的，未测的宁可漏报。
 */
export const OFFICEACE_MODELS = [
  { id: 'glm-5.3', name: 'GLM-5.3', contextWindow: 202_752, maxTokens: 131_072 },
  { id: 'glm-5.2', name: 'GLM-5.2', contextWindow: 202_752, maxTokens: 131_072 },
  { id: 'glm-5.1', name: 'GLM-5.1', contextWindow: 202_752, maxTokens: 131_072 },
  { id: 'deepseek-v4.1-flash', name: 'DeepSeek-V4.1-Flash', contextWindow: 196_608, maxTokens: 131_072, multimodal: true },
  { id: 'deepseek-v4-flash', name: 'DeepSeek-V4-Flash', contextWindow: 196_608, maxTokens: 131_072 },
  { id: 'kimi-k2.6', name: 'Kimi-K2.6', contextWindow: 196_608, maxTokens: 131_072, multimodal: true },
  { id: 'qwen3-32b', name: 'Qwen3-32B', contextWindow: 131_072, maxTokens: 65_536 },
  { id: 'qwen3-30b-a3b', name: 'Qwen3-30B-A3B', contextWindow: 131_072, maxTokens: 65_536 },
] as const

/** 单模型上限兜底（目录未返回时用）。 */
export const FALLBACK_CONTEXT_WINDOW = 131_072

/**
 * 远端目录条目。
 *
 * ⚠️ 与 `OFFICEACE_MODELS` 不同，**上游只返回 `id`**（`{id, object, created,
 * owned_by}`），既没有展示名也没有上下文窗口/多模态能力。`name` 由
 * {@link officeaceDisplayName} 本地生成。
 */
export interface OfficeAceRemoteModel {
  readonly id: string
  readonly name: string
}

/** `/v2/models` 的请求超时（目录是展示信息，不该像推理那样等十分钟）。 */
export const OFFICEACE_CATALOG_TIMEOUT_MS = 20_000

/**
 * 厂商名前缀（用于把裸 id 美化成展示名）。
 *
 * 只覆盖上游目录里实际出现过的厂商；不在表里的段走通用首字母大写。
 * 词表**故意做小**：写错了会把 `zhipu` 这类未知段硬套成错误的大小写，
 * 而首字母大写至少不会歪曲 id。
 */
const OFFICEACE_VENDOR_NAMES: Readonly<Record<string, string>> = {
  deepseek: 'DeepSeek',
  glm: 'GLM',
  kimi: 'Kimi',
  qwen: 'Qwen',
  openpangu: 'OpenPangu',
}

/**
 * 上游模型 id → 展示名。
 *
 * 兜底表命中时用表里的美化名（`deepseek-v4.1-flash` → `DeepSeek-V4.1-Flash`）；
 * 否则把 id 按 `-`/`.` 分段、厂商段查词表、其余段首字母大写
 * （`kimi-k3.1-pro` → `Kimi-K3.1-Pro`）。
 *
 * ⚠️ **不返回裸 id**：上游目录不带 name，若直接回显 id，模型选择器会显示
 * `deepseek-v4.1-flash-1017` 这种机器标识 —— 与 SenseNova 接远端目录时踩过的
 * 同款体验回退（那边是「远端 name 等于 id」，这边是「远端根本不返回 name」）。
 */
export function officeaceDisplayName(id: string): string {
  const known = OFFICEACE_MODELS.find((model) => model.id === id)
  if (known !== undefined) return known.name
  return id.split('-').map((segment) => {
    const [head, ...rest] = segment.split('.')
    const vendor = OFFICEACE_VENDOR_NAMES[(head ?? '').toLowerCase()]
    const prettyHead = vendor ?? (/^\d/.test(head ?? '') || head === undefined
      ? (head ?? '')
      : head.charAt(0).toUpperCase() + head.slice(1))
    return [prettyHead, ...rest].filter((part) => part.length > 0).join('.')
  }).join('-')
}

/**
 * 测试档模型 id 的判据（`glm-5.3-test`、`kimi-k3-test-1009`）。
 *
 * 兜底表**从来没有**暴露过 test 档（原型注释：「全部 11 个里 2 个 test 档不暴露」）。
 * 接远端目录时若不过滤，这些上游灰度条目会涌进模型选择器 —— 用户选了它们
 * 得到的可能是随时下线的内部版本。故保留原有的收窄口径。
 */
const OFFICEACE_TEST_MODEL_RE = /-test(?:-|$)/

/**
 * 解析 `/v2/models` 响应。
 *
 * 实测结构为 `{object: 'list', data: [{id, object, created, owned_by}, …]}`；
 * 同时兼容顶层直接是数组、以及条目是裸字符串的形态 —— 上游改形状时不必
 * 再发一版（多认一种形态的成本远低于「目录突然全空」）。
 *
 * 空 id 与 test 档一律丢弃；**不做去重以外的重排**：上游顺序即官方 IDE 的
 * 渲染序，擅自排序会让「常用的排前面」这种错觉成真。
 */
export function parseOfficeAceModels(payload: unknown): OfficeAceRemoteModel[] {
  const rows = Array.isArray(payload)
    ? payload
    : (payload !== null && typeof payload === 'object' && Array.isArray((payload as { data?: unknown }).data))
      ? (payload as { data: unknown[] }).data
      : []

  const seen = new Set<string>()
  const models: OfficeAceRemoteModel[] = []
  for (const row of rows) {
    const id = typeof row === 'string'
      ? row.trim()
      : (row !== null && typeof row === 'object' && typeof (row as { id?: unknown }).id === 'string'
          ? (row as { id: string }).id.trim()
          : '')
    if (id.length === 0 || seen.has(id) || OFFICEACE_TEST_MODEL_RE.test(id)) continue
    seen.add(id)
    models.push({ id, name: officeaceDisplayName(id) })
  }
  return models
}
