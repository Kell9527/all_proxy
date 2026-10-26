/**
 * OfficeAce 适配器：把标准 `LlmAdapter` 调用转发到华为 ModelArts MaaS。
 *
 * 移植自来源 `src/officeace-adapter.ts`，**改动仅限依赖与 DSH 专属机制**：
 * - `@deepseek-ai/dsh-llm` → 本地 `shared/llm.js`；`openai-compat` 走本地 `shared/`；
 * - **裁掉** `registerOfficeAceLlm`（本项目注册走 `ProviderRegistry`）；
 * - **裁掉** `onCatalogLoaded` / `announceLater`（本项目无推送式目录广播）；
 * - **裁掉** 倍率（`fetchModelTokenRates`，V11 签名）—— 本轮只做推理，余额/倍率降级；
 * - 凭据改由注入的 `resolveCredential` 提供（本项目账号池统一选号），而非读本机文件。
 *
 * ## 关键约束（原样保留）
 *
 * - `listModels` 静态（`OFFICEACE_MODELS`）+ 探测门控（凭据读不到 = 空目录）；
 * - `maasBaseUrlOf`：**必须优先用凭据里按账号下发的 `maasBaseUrl`**（硬编码默认域
 *   对同账号回 401 `APIG.1009`）；
 * - `max_tokens` 下限保护（< 4096 直接丢弃，否则思考链烧光预算、正文零产出）；
 * - 响应含 `reasoning_content`，`consumeOpenAiSse` 已兼容。
 */

import { LlmAdapter, LlmError } from '../shared/llm.js'
import type {
  GenerateOptions,
  LlmModelInfo,
  LlmProviderInfo,
  LlmResolvedModelInfo,
  StreamChunk,
} from '../shared/llm.js'
import { collectImages, consumeOpenAiSse, isTransportError, serializeMessages } from '../shared/openai-compat.js'
import { OFFICEACE, OFFICEACE_MODELS } from './officeace-product.js'
import { basicAuthorization, isExpiring, type OfficeAceCredential } from './officeace-auth.js'

/**
 * 上游认可的思考档位白名单。
 *
 * ⚠️ 来源是上游**自己的报错文案**（2026-10-23 实测，`reasoning_effort` 传非法值）：
 * > `reasoning_effort 参数值非法，可选值为：none、minimal、low、medium、high、xhigh、max`
 * > （`ModelArts.81001`）
 *
 * 它证明两件事：① 上游**真的消费**这个参数；② 非法值直接 **400**。
 * 故透传前必须过白名单，超出范围时**静默丢弃** —— 档位不是请求的必要条件。
 *
 * 注意它**不含 `ultra`**（sensenova 有），两个同为商汤/华为系但能力表不同，
 * 不要互相照抄。
 */
export const OFFICEACE_REASONING_EFFORTS: ReadonlySet<string> = new Set([
  'none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max',
])

/**
 * 推理/探测该用哪个 host —— **必须优先用凭据里按账号下发的 `maasBaseUrl`**。
 *
 * ## ⚠️⚠️ 阻断级真实缺陷（2026-10-13 真机实测）
 *
 * 症状：provider 列表**有** OfficeAce、账号也在，但**对话的模型选择器里一个
 * OfficeAce 模型都看不到**。
 *
 * 根因：适配器原先一律打硬编码的 `OFFICEACE.defaultBaseUrl`，而华为**按账号
 * 下发专属网关** `modelgw-0004.officeace.cn-southwest-2...`。同一个 Basic 凭据：
 *
 * | host | `/v2/models` | `/v2/chat/completions` |
 * |---|---|---|
 * | `officeace…`（硬编码）| **401** `APIG.1009 AppKey or AppSecret is invalid` | **401** |
 * | `modelgw-0004.officeace…`（凭据里）| **200** | **200** |
 *
 * 后果链：`probe` 401 ⇒ `listModels` 返回 `[]` ⇒ 模型选择器**空分组**。
 *
 * @returns 规范化（去尾斜杠）后的 base URL；凭据没带时回退默认域（零行为变化）。
 */
export function maasBaseUrlOf(credential: OfficeAceCredential): string {
  const raw = typeof credential.maasBaseUrl === 'string' ? credential.maasBaseUrl.trim() : ''
  const base = raw.length > 0 ? raw : OFFICEACE.defaultBaseUrl
  return base.replace(/\/+$/, '')
}

export interface OfficeAceAdapterOptions {
  /** 解析当前可用凭据（账号池统一选号）。 */
  resolveCredential: () => Promise<OfficeAceCredential | undefined>
  /**
   * 凭据续期（STS 已过期时的兜底）。
   *
   * ⚠️ **必须由接线层注入**：漏接的症状是该渠道的账号永不过期。
   */
  refresh?: () => Promise<void>
  /** 覆盖默认的 fetch（测试注入）。 */
  fetchImpl?: typeof fetch
  /**
   * 图片读取桥 —— **图片输入的必要条件**。
   *
   * 未提供时收到图片消息会报 `UNSUPPORTED_CONTENT`：静默丢图会让用户以为模型
   * 看到了图，实际它什么都没看见。
   */
  readImage?: (attachment: unknown) => Promise<{ data: Uint8Array; mediaType: string } | undefined>
  /** 黑名单模型 id（管理端「显示列表」开关）。 */
  disabledModels?: () => ReadonlySet<string>
}

/**
 * 该模型是否接受图片输入（**实测表**，依据见 `OFFICEACE_MODELS` 的 `multimodal` 注）。
 *
 * `/v2/models` 不返回能力元数据，只能逐个实测 —— 未入库的 id 保守按不支持。
 */
function isMultimodalModel(model: string): boolean {
  return OFFICEACE_MODELS.some((m) => m.id === model && (m as { multimodal?: boolean }).multimodal === true)
}

/** 在 `options.messages` 里收集图片引用（含工具结果内层，任意深度）。 */
function collectMessageImages(options: GenerateOptions): Map<string, unknown> {
  const refs = new Map<string, unknown>()
  for (const message of options.messages) {
    const content = Array.isArray(message.content) ? message.content : []
    collectImages(content, refs)
  }
  return refs
}

export class OfficeAceAdapter extends LlmAdapter {
  constructor(private readonly options: OfficeAceAdapterOptions) {
    super()
  }

  /**
   * 取当前可用凭据；STS 临期（10 分钟内）先静默刷新。
   *
   * ⚠️ 刷新失败返回旧凭据 —— 推理可能仍可用（MaaS Basic 凭据与 STS 生命周期
   * 不同步）；真正失效由 stream 的 401 报错兜底。
   */
  private async resolveCredential(): Promise<OfficeAceCredential | undefined> {
    const credential = await this.options.resolveCredential()
    if (credential !== undefined && isExpiring(credential) && this.options.refresh !== undefined) {
      await this.options.refresh().catch(() => undefined)
      return (await this.options.resolveCredential()) ?? credential
    }
    return credential
  }

  providerInfo(provider: string): LlmProviderInfo {
    const id = typeof provider === 'string' && provider.length > 0 ? provider : OFFICEACE.id
    return { id, name: OFFICEACE.displayName }
  }

  /** ⚠️ 必须同步（管理端目录不 await，同其余适配器）。 */
  listAllModels(): readonly { id: string; name: string }[] {
    return OFFICEACE_MODELS.map((m) => ({ id: m.id, name: m.name }))
  }

  /**
   * 目录：凭据可读 + `/v2/models` 可达才暴露（空目录 = 隐藏，而不是报错）。
   */
  async listModels(_provider: string): Promise<readonly LlmModelInfo[]> {
    const disabled = this.options.disabledModels?.() ?? new Set<string>()
    const credential = await this.resolveCredential()
    if (credential === undefined) return []
    try {
      const probe = await this.probe(credential)
      if (!probe) return []
    } catch {
      return []
    }
    return OFFICEACE_MODELS
      .filter((m) => !disabled.has(m.id))
      .map((m) => ({
        provider: OFFICEACE.id,
        id: m.id,
        name: m.name,
        // ⚠️ **图片准入闸门**：不声明 `image` 时附件在入库阶段就被拒。
        inputModalities: isMultimodalModel(m.id) ? (['text', 'image'] as const) : (['text'] as const),
      }))
  }

  async resolveModel(provider: string, model: string, _signal?: AbortSignal): Promise<LlmResolvedModelInfo> {
    const known = OFFICEACE_MODELS.find((m) => m.id === model)
    return {
      provider,
      id: model,
      name: known?.name ?? model,
      inputModalities: isMultimodalModel(model) ? (['text', 'image'] as const) : (['text'] as const),
      // ⚠️ **未知 id 不编造 `context`**：拿一个猜测值会让自动压缩按错误阈值决策
      //    —— 如实 `undefined` 比编一个数诚实。
      ...(known === undefined ? {} : { context: { contextWindow: known.contextWindow } }),
    }
  }

  /** 探测：模型端点 200 且 JSON（凭据有效即通过）。 */
  private async probe(credential: OfficeAceCredential): Promise<boolean> {
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), 8_000)
    try {
      const f = this.options.fetchImpl ?? fetch
      const r = await f(`${maasBaseUrlOf(credential)}${OFFICEACE.modelsPath}`, {
        headers: { Authorization: basicAuthorization(credential) },
        signal: ctrl.signal,
      })
      const ct = r.headers.get('content-type') ?? ''
      return r.ok && ct.includes('application/json')
    } catch {
      return false
    } finally {
      clearTimeout(timer)
    }
  }

  async prepareCall(provider: string, model: string, signal?: AbortSignal): Promise<{
    model: LlmResolvedModelInfo
    stream: (options: GenerateOptions) => AsyncGenerator<StreamChunk>
  }> {
    return {
      model: await this.resolveModel(provider, model, signal),
      stream: (options: GenerateOptions) => this.stream(options),
    }
  }

  /** ⚠️ 单参数 `stream(options)`（`LlmAdapter` 基类契约）。 */
  async *stream(options: GenerateOptions): AsyncGenerator<StreamChunk> {
    const model = options.model
    const credential = await this.resolveCredential()
    if (credential === undefined) {
      throw new LlmError(
        '未找到 OfficeAce 凭据：请在管理端添加 OfficeAce 账号并完成华为云登录',
        'MISSING_CREDENTIAL',
      )
    }
    const f = this.options.fetchImpl ?? fetch

    const controller = new AbortController()
    const onAbort = (): void => controller.abort()
    options.signal?.addEventListener('abort', onAbort)

    // ⚠️ **max_tokens 下限保护**（2026-10-12 实测定位「渠道老是停」）：
    //    OfficeAce 全系模型带思考链，且思考 token 计入 max_tokens 预算。
    //    实测 deepseek-v4.1-flash：max_tokens=32 → reasoning_tokens=32、content 0 字；
    //    512 同样 0 字；不限 → 完整回复。即小预算会被思考链**全部烧光**，正文一个字
    //    都不剩 —— 外部表现就是「回复是空的 / 渠道停了」。故低于下限的预算直接**丢弃**
    //    （交给端点默认上限兜底）。下限取 4096：留足思考 + 正文余量。
    const MAX_TOKENS_FLOOR = 4096
    const maxTokens = options.maxTokens !== undefined && options.maxTokens >= MAX_TOKENS_FLOOR
      ? options.maxTokens
      : undefined

    // ── 图片输入（多模态）──
    const imageRefs = collectMessageImages(options)
    let imageUrls: Map<string, string> | undefined
    if (imageRefs.size > 0) {
      if (!isMultimodalModel(model)) {
        throw new LlmError(
          `OfficeAce: 模型 "${model}" 不支持图片输入。`
          + '已实测支持：DeepSeek-V4.1-Flash、Kimi-K2.6',
          'UNSUPPORTED_CONTENT',
        )
      }
      if (this.options.readImage === undefined) {
        throw new LlmError('OfficeAce: 图片输入需要附件服务桥接（readImage）', 'UNSUPPORTED_CONTENT')
      }
      imageUrls = new Map()
      for (const [id, ref] of imageRefs) {
        const image = await this.options.readImage(ref)
        if (image === undefined) continue
        imageUrls.set(id, `data:${image.mediaType};base64,${Buffer.from(image.data).toString('base64')}`)
      }
    }

    const wireMessages = serializeMessages(options.messages)
    // 把图片 parts 注回 user 消息：共享 `serializeMessages` 会把 content 压成纯文本
    //（图片静默丢失），这里按 user 消息出现顺序一一对应，把该消息内（含 tool-result
    //  内层）的图片补成 `{type:'image_url'}` parts。
    if (imageUrls !== undefined) {
      const originalUsers = options.messages.filter((m) => m.role === 'user')
      let userIdx = 0
      for (const wire of wireMessages) {
        if (wire.role !== 'user') continue
        const original = originalUsers[userIdx++]
        if (original === undefined) break
        const inner: unknown[] = Array.isArray(original.content) ? original.content : []
        const parts: Array<Record<string, unknown>> = []
        const text = typeof wire.content === 'string' ? wire.content : ''
        if (text.length > 0) parts.push({ type: 'text', text })
        for (const raw of inner) {
          if (typeof raw !== 'object' || raw === null) continue
          const block = raw as { type?: unknown; attachment?: { attachmentId?: unknown } }
          if (block.type === 'image') {
            const url = block.attachment?.attachmentId === undefined
              ? undefined
              : imageUrls.get(String(block.attachment.attachmentId))
            // 解析不到字节时留占位文本，而不是静默吞掉整张图。
            parts.push(url === undefined
              ? { type: 'text', text: '[image unavailable]' }
              : { type: 'image_url', image_url: { url } })
          }
        }
        if (parts.length > 0) wire.content = parts
      }
    }

    // ── 工具定义下发 ──
    //
    // ⚠️ **`tools` 必须真的下发到请求体顶层**（Qoder / TRAE 都因漏发而让模型在
    //    正文里臆造 XML 工具调用）。
    const wireTools = options.tools?.map((tool) => ({
      type: 'function' as const,
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters,
      },
    }))

    const payload = JSON.stringify({
      model,
      messages: wireMessages,
      stream: true,
      ...wireTools !== undefined && wireTools.length > 0 ? { tools: wireTools } : {},
      ...maxTokens === undefined ? {} : { max_tokens: maxTokens },
      ...options.temperature === undefined ? {} : { temperature: options.temperature },
      // 思考等级：只发上游认的档位（见 {@link OFFICEACE_REASONING_EFFORTS}
      // 的实测依据）。白名单外静默丢弃，避免变成一条 400。
      ...OFFICEACE_REASONING_EFFORTS.has(options.reasoningEffort ?? '')
        ? { reasoning_effort: options.reasoningEffort }
        : {},
    })

    try {
      const response = await f(`${maasBaseUrlOf(credential)}${OFFICEACE.chatPath}`, {
        method: 'POST',
        headers: {
          Authorization: basicAuthorization(credential),
          'Content-Type': 'application/json',
          Accept: 'text/event-stream',
        },
        body: payload,
        signal: controller.signal,
      })

      if (!response.ok) {
        const text = await response.text().catch(() => '')
        // ⚠️ 401 = Basic 凭据失效。MaaS 凭据与 STS 生命周期不同步，**STS 也快到期**
        //    是常见成因 —— 这里续期一次再重发，与 trae / gemini 同款模式。
        if (response.status === 401 && this.options.refresh !== undefined) {
          await this.options.refresh().catch(() => undefined)
          const renewed = await this.options.resolveCredential()
          if (renewed !== undefined && renewed !== credential) {
            const retry = await f(`${maasBaseUrlOf(renewed)}${OFFICEACE.chatPath}`, {
              method: 'POST',
              headers: {
                Authorization: basicAuthorization(renewed),
                'Content-Type': 'application/json',
                Accept: 'text/event-stream',
              },
              body: payload,
              signal: controller.signal,
            })
            if (retry.ok) {
              yield* consumeOpenAiSse(
                retry,
                { signal: controller.signal },
                {
                  label: OFFICEACE.id,
                  firstTokenTimeoutMs: OFFICEACE.headerTimeoutMs,
                  chunkTimeoutMs: OFFICEACE.chunkTimeoutMs,
                },
              )
              return
            }
          }
        }
        throw new LlmError(
          `OfficeAce (华为MaaS) 返回 HTTP ${response.status}：${text.slice(0, 200)}`
          + `（${this.diagnose(response.status)}）`,
          response.status === 401 || response.status === 403 ? 'AUTH' : 'SERVER',
          { status: response.status },
        )
      }

      yield* consumeOpenAiSse(
        response,
        { signal: controller.signal },
        {
          label: OFFICEACE.id,
          firstTokenTimeoutMs: OFFICEACE.headerTimeoutMs,
          chunkTimeoutMs: OFFICEACE.chunkTimeoutMs,
        },
      )
    } finally {
      options.signal?.removeEventListener('abort', onAbort)
      controller.abort()
    }
  }

  private diagnose(status: number): string {
    if (status === 401) return 'Basic 凭据失效：OfficeAce 会话已过期，请重新登录'
    if (status === 403) return '该账号未订阅此模型（ModelArts.81004）：请在华为云控制台订阅'
    if (status === 404) return '模型不存在：检查模型 id 是否在目录中'
    if (status === 429) return '限流：稍后重试'
    if (status >= 500) return '华为云服务端错误：稍后重试'
    return '请确认 OfficeAce 账号已登录且有可用额度'
  }
}

/** 传输级错误判定（供接线层复用，与其余适配器同义）。 */
export { isTransportError }
