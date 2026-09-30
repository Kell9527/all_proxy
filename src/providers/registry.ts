/**
 * Provider 注册表。
 *
 * 每个 provider 由一份配置（{@link ProviderDescriptor}）描述其静态事实
 * （标识、展示名、基地址、鉴权方式、模型目录来源），运行时行为由适配器提供。
 *
 * ## 为什么注册表要拒绝重复标识
 *
 * provider 标识同时是：账号池的 `provider` 字段、模型寻址的前缀、模型开关的
 * 隔离键。三者都靠它做唯一性判定，一旦重复（例如 `qoder` 与 `qodercn` 写成
 * 同一个 id），账号会串号、开关会互相影响，且**不会有任何报错** ——
 * 故在注册时就抛错。
 */

import type { LlmAdapter } from '../shared/llm.js'

/** 鉴权方式（决定请求头怎么加）。 */
export type AuthKind =
  /** 标准 `Authorization: Bearer <access_token>`。 */
  | 'bearer'
  /** 厂商自定义头族（如腾讯系的 `X-Domain` / TRAE 的 `Cloud-IDE-JWT`）。 */
  | 'custom'
  /** 华为 `SDK-HMAC-SHA256` 请求签名。 */
  | 'huawei-signature'
  /** Qoder 的 WASM 生成签名头（必须原样透传）。 */
  | 'qoder-wasm'

/** 模型目录来源。 */
export type CatalogSource =
  /** 远端端点优先，失败回退内置兜底表。 */
  | 'remote-first'
  /** 只有内置静态表（远端需要签名，不发请求）。 */
  | 'static-only'

/** 一个 provider 的静态描述。 */
export interface ProviderDescriptor {
  /** provider 标识：模型寻址前缀、账号池字段、开关隔离键。 */
  id: string
  /** 管理端与模型列表的展示名。 */
  displayName: string
  /** 上游基地址。 */
  apiBase: string
  /** chat 补全路径（相对 `apiBase`）。 */
  chatPath: string
  /** 鉴权方式。 */
  authKind: AuthKind
  /** 模型目录来源。 */
  catalogSource: CatalogSource
  /**
   * 该 provider 是否支持生图。
   *
   * 规格 `gateway-api` 要求：不支持的 provider 请求生图时明确报错，
   * 而不是静默失败或转发到一个不存在的端点。
   */
  supportsImages: boolean
  /**
   * 该 provider 是否实现账号轮换。
   *
   * ⚠️ 来源中 `loomy` 与 `raccoon` **没有**轮换逻辑。这里如实登记，
   * 而不是「顺手补一个」—— 臆造轮换会在上游拒绝时反复重试同一个账号。
   */
  rotatesAccounts: boolean
}

/** 一个已注册的 provider。 */
export interface RegisteredProvider {
  descriptor: ProviderDescriptor
  adapter: LlmAdapter
}

/** 注册表。 */
export class ProviderRegistry {
  private readonly byId = new Map<string, RegisteredProvider>()

  /**
   * 注册一个 provider。
   *
   * @throws 当 `descriptor.id` 为空或已注册时。
   */
  register(descriptor: ProviderDescriptor, adapter: LlmAdapter): void {
    const id = descriptor.id
    if (typeof id !== 'string' || id.trim().length === 0) {
      throw new Error('provider id 不能为空')
    }
    if (this.byId.has(id)) {
      throw new Error(`provider "${id}" 已被注册`)
    }
    this.byId.set(id, { descriptor, adapter })
  }

  /** 是否已注册。 */
  has(id: string): boolean {
    return this.byId.has(id)
  }

  /** 取一个已注册的 provider；未注册返回 undefined。 */
  get(id: string): RegisteredProvider | undefined {
    return this.byId.get(id)
  }

  /** 全部已注册 provider（按注册顺序）。 */
  list(): RegisteredProvider[] {
    return [...this.byId.values()]
  }

  /** 全部 provider 标识（按注册顺序）。 */
  ids(): string[] {
    return [...this.byId.keys()]
  }
}

/**
 * 解析对外模型标识 `<provider>/<model>`。
 *
 * ## 为什么强制前缀
 *
 * 10 个 provider 之间重名严重（`deepseek-v4-flash` 同时存在于 codearts /
 * buddy / workbuddy / trae / lobsterai；`glm-5.2` 亦多处）。前缀是唯一无歧义的
 * 寻址方式，且新增 provider 不会与既有名冲突。
 *
 * ## 分隔符取**第一个** `/`
 *
 * 上游模型 id 本身可能含 `/`（如某些网关的 `vendor/model` 形式），故只按
 * 第一个 `/` 切分：`<provider>` 在前，**其余整体**作为模型 id。
 *
 * @param raw - 请求里的 `model` 字段。
 * @returns 解析结果；格式不合法时 `ok: false` 并给出原因。
 */
export function parseModelRef(raw: unknown): {
  ok: true
  provider: string
  model: string
} | {
  ok: false
  reason: 'missing' | 'no-prefix' | 'empty-provider' | 'empty-model'
} {
  if (typeof raw !== 'string' || raw.length === 0) return { ok: false, reason: 'missing' }
  const slash = raw.indexOf('/')
  if (slash === -1) return { ok: false, reason: 'no-prefix' }
  const provider = raw.slice(0, slash)
  const model = raw.slice(slash + 1)
  if (provider.length === 0) return { ok: false, reason: 'empty-provider' }
  if (model.length === 0) return { ok: false, reason: 'empty-model' }
  return { ok: true, provider, model }
}

/** 拼装对外模型标识。 */
export function formatModelRef(provider: string, model: string): string {
  return `${provider}/${model}`
}
