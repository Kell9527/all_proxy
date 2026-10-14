/**
 * SenseNova（商汤）开放平台产品配置。
 *
 * ## 为什么是**又一套**独立配置（而且与前 10 个都不同类）
 *
 * 既有 10 个 provider **全部**是「登录态凭据」（`access_token` [+
 * `refresh_token`]，经扫码/OAuth/短信/密码换来）。SenseNova 是**第一个用
 * 静态 API Key** 的 provider：一把 `sk-...` 直接作为 `Bearer` 令牌，
 * 没有登录流程、没有 refresh 端点、也就没有「凭据过期」这一概念。
 *
 * 因此本文件**故意不引入** `*-oauth.ts` / `*-auth.ts`：那两层的全部职责
 * （换 token、轮换 refresh token）在这里都不存在。账号的来源是「用户在
 * 管理端粘贴 key」，而不是「走一次授权」。
 *
 * ## 数据来源
 *
 * 2026-10-13 实测 `GET https://token.sensenova.cn/v1/models`（Bearer 静态 key）：
 *
 * ```json
 * { "data": [{ "id": "kimi-k3", "input_modalities": ["text"],
 *              "output_modalities": ["text"], "context_length": 1048576,
 *              "max_output_length": 65536, "supported_features": ["tools", ...] }] }
 * ```
 *
 * 该端点与 `POST /v1/chat/completions` **都是标准 OpenAI 兼容**（标准 SSE、
 * `reasoning_content` 思考字段），故协议层完全复用 `shared/openai-compat.ts`
 * （与 qoder / cline 同做法）。
 *
 * ⚠️ **`sensenova-u1.5-lite` 是出图模型**（`output_modalities:["image"]`），
 * 不是对话模型 —— 它出现在 `/v1/models` 里，但不能作为 chat 目标，故**不进**
 * 兜底表（远端目录也要在解析时过滤掉非文本输出模型）。
 */

/** 兜底模型目录中的一个条目（远端 `/v1/models` 不可用时使用）。 */
export interface SensenovaFallbackModel {
  /** 模型 id（传给 `chat/completions` 的 `model`）。 */
  id: string
  /** 展示名。 */
  name: string
  /** 上下文窗口（远端 `context_length`）。 */
  contextWindow: number
  /** 单次输出上限（远端 `max_output_length`）。 */
  maxTokens: number
  /** 是否接受图片输入（远端 `input_modalities` 含 `image`）。 */
  supportsImage: boolean
}

/** SenseNova 产品配置。 */
export interface SensenovaProduct {
  /** provider 标识：模型寻址前缀、账号池 provider 字段、开关隔离键。 */
  id: 'sensenova'
  /** 管理端与模型列表的展示名。 */
  displayName: string
  /** API 基址（`/chat/completions` 与 `/models` 都挂在它下面）。 */
  apiBase: string
  /** chat 补全路径（相对 `apiBase`）。 */
  chatPath: string
  /** 模型目录路径（相对 `apiBase`）。 */
  modelsPath: string
  /** 默认凭据 ref（无账号池时的单凭据回退）。 */
  defaultCredentialRef: string
  /**
   * 引导用环境变量名：逗号分隔的多把 key。
   *
   * ⚠️ 只在**首次启动且该 provider 尚无账号**时用于初始化，绝不覆盖已有账号
   * （否则用户删掉的 key 会被环境变量在每次启动时塞回来）。
   */
  envVar: string
  /** 远端模型列表不可用时的兜底目录（当前 6 个文本模型）。 */
  fallbackModels: readonly SensenovaFallbackModel[]
}

/** 请求超时（毫秒）。 */
export const SENSENOVA_REQUEST_TIMEOUT_MS = 120_000

/**
 * 兜底模型目录（2026-10-13 实测 `GET /v1/models` 的 6 个**文本输出**模型）。
 *
 * 顺序**照抄远端返回顺序**，不重排 —— 重排会让「与远端对比」这类排查失去
 * 可比性（与 raccoon 兜底表同约定）。
 *
 * ⚠️ 不含 `sensenova-u1.5-lite`（出图模型，不能作为 chat 目标）。
 */
const SENSENOVA_FALLBACK_MODELS: readonly SensenovaFallbackModel[] = [
  {
    id: 'deepseek-v4-flash',
    name: 'DeepSeek-V4-Flash',
    contextWindow: 1_048_576,
    maxTokens: 65_536,
    supportsImage: false,
  },
  {
    id: 'glm-5.2',
    name: 'GLM-5.2',
    contextWindow: 1_048_576,
    maxTokens: 131_072,
    supportsImage: false,
  },
  {
    id: 'sensenova-6.8-flash-lite',
    name: 'SenseNova-6.8-Flash-Lite',
    contextWindow: 262_144,
    maxTokens: 65_536,
    supportsImage: true,
  },
  {
    // ⚠️ 用户口语里的「K3」就是它（`kimi-k3`）。它是本 provider 的主力模型，
    // 也是**最容易 429** 的那个（tpm/rpm 限流）—— 换号逻辑正为它而设。
    id: 'kimi-k3',
    name: 'Kimi-K3',
    contextWindow: 1_048_576,
    maxTokens: 65_536,
    supportsImage: false,
  },
  {
    id: 'deepseek-flash',
    name: 'DeepSeek-Flash',
    contextWindow: 1_048_576,
    maxTokens: 65_536,
    supportsImage: false,
  },
  {
    id: 'deepseek-v4.1-flash',
    name: 'DeepSeek-V4.1-Flash',
    contextWindow: 1_048_576,
    maxTokens: 65_536,
    supportsImage: false,
  },
]

/** SenseNova provider 配置。 */
export const SENSENOVA: SensenovaProduct = {
  id: 'sensenova',
  // ⚠️ 用『SenseNova (商汤)』：既对上官方平台名，又与既有的
  // 『Raccoon (商汤)』区分开（两者同属商汤，但一个是开放平台 API、
  // 一个是小浣熊桌面端，凭据形态完全不同）。长度也与其余 Tab 标签一致，
  // 不会触发换行（Raccoon 那次报障过）。
  displayName: 'SenseNova (商汤)',
  apiBase: 'https://token.sensenova.cn/v1',
  chatPath: '/chat/completions',
  modelsPath: '/models',
  defaultCredentialRef: 'SENSENOVA_ACCESS_TOKEN',
  envVar: 'SENSENOVA_API_KEYS',
  fallbackModels: SENSENOVA_FALLBACK_MODELS,
}

/** 全部 SenseNova 产品配置（当前只有一个，保留数组以便将来扩展）。 */
export const ALL_SENSENOVA_PRODUCTS: readonly SensenovaProduct[] = [SENSENOVA]

/** 按 provider id 取产品配置；未知 id 返回 undefined。 */
export function sensenovaProductById(id: string): SensenovaProduct | undefined {
  return ALL_SENSENOVA_PRODUCTS.find((product) => product.id === id)
}
