/**
 * Magicrew（超级麦吉）的 `LlmAdapter` 实现 —— 推理面 + 目录面。
 *
 * 移植自 `deepseek-harness-codearts` 的 `src/magicrew-adapter.ts`（来源 `392d370`）。
 * **只改接线形状，不改判据** —— 下面每一条「实测」都是来源真机取证换来的。
 *
 * ## 只做**流式**
 *
 * 来源实测（2026-10-28）非流式也能用，但本实现只走流式：流式才能把
 * `reasoning_content` 分片及时交给上层。
 *
 * ## ⚠️ 成功判据是**业务码**，不是 HTTP 状态
 *
 * 用错配的 `api_key` 会得到 **HTTP 200 + `{"code":403,"message":"token无效"}`**
 * （`content-type` 是 `application/json` 而不是 `text/event-stream`）。
 * ⇒ 进流之前**必须先看 content-type**，否则会把这段 JSON 当 SSE 读、
 * 报「没收到任何内容」—— 症状与真因相距很远。
 *
 * ## ⚠️ SSE 解析与消息序列化都走**共享件**，不得在本文件手写
 *
 * 来源记过两次同型事故：手写 `readSse` 会缺 `tool-call-delta` / `reasoning` 别名 /
 * 两级超时 / 流内错误帧分类；手写 `toWireMessages` 会让**多轮工具往返丢工具结果**
 * （`tool-call` / `tool-result` 被映射成空文本 ⇒ wire 上既无 `tool_calls` 也无
 * `role:'tool'` ⇒ 模型看不到自己上一步的工具输出）。
 *
 * ## 图片：**宁报错，不降级**
 *
 * 目录里声明了 image 模态的模型，收到图片时把图换成占位文字会让模型
 * **以为看到了**（幻觉），且症状是 HTTP 200 + 正文正常 + 上游零报错。
 * ⇒ 只有两条路：经注入的 `readImage` 真读字节内联，或抛 `INVALID_REQUEST`。
 */

import { LlmAdapter, LlmError } from '../shared/llm.js'
import type {
  GenerateOptions,
  LlmModelInfo,
  LlmProviderInfo,
  LlmResolvedModelInfo,
  StreamChunk,
} from '../shared/llm.js'
import {
  collectImages,
  consumeOpenAiSse,
  serializeMessages,
} from '../shared/openai-compat.js'
import type { AccountPool } from '../pool/account-pool.js'
import {
  MAGICREW,
  MAGICREW_CHAT_PATH,
  MAGICREW_DEFAULT_EFFORT,
  MAGICREW_FALLBACK_CONTEXT_WINDOW,
  MAGICREW_MIN_MAX_TOKENS,
  MAGICREW_REASONING_EFFORTS,
  magicrewFallbackModelOf,
  type MagicrewProduct,
} from './magicrew-product.js'
import { isMagicrewApiKeyDeadError, type MagicrewCredential } from './magicrew-auth.js'
import { fetchMagicrewCatalogModels, type MagicrewCatalogModel } from './magicrew-catalog.js'
import { fetchMagicrewModelPoints, magicrewIsFree, magicrewRateOf } from './magicrew-credits.js'

/**
 * 内联一张图片为**原始字节**的注入点（由接线层桥接）。
 *
 * ⚠️ 契约与 accio / buddy 一致：**读不到返回 `undefined`**（不是抛错、也不是返回空）
 * —— 由本适配器统一判成 `INVALID_REQUEST`。
 */
export type MagicrewReadImage =
  (attachment: unknown) => Promise<{ data: Uint8Array; mediaType: string } | undefined>

export interface MagicrewAdapterOptions {
  readonly product?: MagicrewProduct
  readonly fetchImpl?: typeof fetch
  readonly warn?: (message: string) => void
  readonly now?: () => number
  readonly accountPool?: AccountPool
  /**
   * 取当前账号凭据。
   *
   * ⚠️ **必须透传 `modelId`**：空串会让 `AccountPool.getAvailableAccount`
   * 的模型级限流过滤整体短路（`if (modelId.length === 0) return true`），
   * 于是刚被标记限流的账号下次仍被选中 —— 换号形同虚设
   * （AGENTS.md 第 13 条，qoder / trae 已合规）。
   */
  readonly resolveCredential?: (modelId?: string) => Promise<MagicrewCredential | undefined>
  readonly fetchRemoteModels?: () => Promise<readonly MagicrewCatalogModel[]>
  /** 读图入口。⚠️ 缺省时遇到图片块**必须抛错**，绝不降级成占位文字。 */
  readonly readImage?: MagicrewReadImage
}

/**
 * 上游 UA（缺了偶发 403）。
 *
 * ⚠️ 与 `magicrew-auth.ts` / `magicrew-catalog.ts` / `magicrew-credits.ts` 里
 * 那三份**逐字相同**：四处各留一份是既有形态（不改骨架），但改的时候必须一起改。
 */
const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
  + '(KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36'

/** 目录缓存 TTL（与其余 provider 一致：6 小时）。 */
const CATALOG_TTL_MS = 6 * 60 * 60 * 1000

/**
 * 上游成功业务码。
 *
 * ⚠️ `1000` 是上游的成功码（与 `magicrew-catalog.ts` / `magicrew-auth.ts`
 * 同一常量）。
 */
const MAGICREW_OK_CODE = 1000

/**
 * 从 `HTTP 200 + JSON` 的业务信封里读 `code`（读不到 / 非 JSON 返回 `undefined`）。
 *
 * ⚠️ 上游把**鉴权与业务失败都装在 200 的 body 里**（`{code:403,message:"token无效"}`），
 * 所以状态码根本不是判据。
 */
function magicrewBusinessCodeOf(text: string): number | undefined {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return undefined
  }
  if (typeof parsed !== 'object' || parsed === null) return undefined
  const code = (parsed as { code?: unknown }).code
  return typeof code === 'number' ? code : undefined
}

/**
 * 「组织 / 配置类」业务失败的判据（**不是** key 失效）。
 *
 * ⚠️⚠️ 这类错误**必须归 `INVALID_REQUEST` 而不是 `AUTH`**：`AUTH` 会把 message
 * 一起吞掉、只留宿主那句「API 密钥无效」—— 而 `organization-code 不匹配` 这句
 * **是用户唯一的出路**（国际站必须带组织码），吞掉之后用户只会反复重新登录。
 * 同理也不能落 `SERVER`：那会把它当可重试，白重试 5 次。
 */
function isMagicrewConfigBusinessError(text: string): boolean {
  return /organization[\s_-]*code|org[\s_-]*code|组织/i.test(text)
}

/**
 * 把「非 SSE 响应体」判成 `LlmError`。
 *
 * ⚠️ 顺序固定：**先文案判 key 失效**（共享判据，不另写一份正则）→ 再按业务码分类。
 * `code !== 1000` 时把**上游原文**带进 message，而不是换成一句自造的文案。
 */
function magicrewNonStreamError(text: string): LlmError {
  if (isMagicrewApiKeyDeadError(text)) {
    return new LlmError('超级麦吉 api_key 已失效，请重试或重新登录', 'AUTH')
  }
  const code = magicrewBusinessCodeOf(text)
  if (code !== undefined && code !== MAGICREW_OK_CODE) {
    if (isMagicrewConfigBusinessError(text)) {
      return new LlmError(`超级麦吉拒绝了请求（业务码 ${code}）：${text.slice(0, 300)}`, 'INVALID_REQUEST')
    }
    return new LlmError(`超级麦吉业务失败（业务码 ${code}）：${text.slice(0, 300)}`, 'SERVER')
  }
  return new LlmError(`超级麦吉返回了非流式响应：${text.slice(0, 200)}`, 'SERVER')
}

/** 适配器内部用的目录条目（远端 ∪ 静态表）。 */
interface MagicrewModelEntry {
  readonly id: string
  readonly name: string
  readonly vision: boolean
  readonly contextWindow?: number
  readonly maxTokens?: number
  readonly rateLabel?: string
  readonly isFree: boolean
}

export class MagicrewAdapter extends LlmAdapter {
  private readonly product: MagicrewProduct
  private readonly fetchImpl: typeof fetch
  private readonly warnImpl: (message: string) => void
  private readonly nowImpl: () => number
  private readonly resolveCredentialImpl: (modelId?: string) => Promise<MagicrewCredential | undefined>
  /** 倍率表（model_id → inputPoints/outputPoints），由 loadModelPoints 填充。 */
  private modelPoints: Readonly<Record<string, { inputPoints?: number; outputPoints?: number }>> = {}
  private readonly fetchRemoteModelsImpl: (() => Promise<readonly MagicrewCatalogModel[]>) | undefined
  private readonly readImageImpl: MagicrewReadImage | undefined
  private readonly accountPool: AccountPool | undefined
  private remoteModels: readonly MagicrewCatalogModel[] | undefined
  private catalogAt = 0
  /** 上次**失败**的时间戳（负缓存用；0 = 从未失败）。 */
  private catalogFailedAt = 0
  private catalogInFlight: Promise<readonly MagicrewCatalogModel[]> | undefined

  constructor(options: MagicrewAdapterOptions = {}) {
    super()
    this.product = options.product ?? MAGICREW
    this.fetchImpl = options.fetchImpl ?? fetch
    this.warnImpl = options.warn ?? ((message: string) => { console.warn(message) })
    this.nowImpl = options.now ?? (() => Date.now())
    this.resolveCredentialImpl = options.resolveCredential ?? (async () => undefined)
    this.fetchRemoteModelsImpl = options.fetchRemoteModels
    this.readImageImpl = options.readImage
    this.accountPool = options.accountPool
  }

  providerInfo(provider: string): LlmProviderInfo {
    const id = typeof provider === 'string' && provider.length > 0 ? provider : this.product.id
    return { id, name: this.product.displayName }
  }

  /**
   * 完整目录（**不套黑名单**），带最终展示名。
   *
   * 管理端需要它渲染被关闭的模型 —— 否则那些条目只能凭黑名单的 key 补回，
   * 而那条路径拿不到展示名，会退化成裸 id。
   */
  listAllModels(): readonly { id: string; name: string; costCoefficient?: number }[] {
    return this.entriesSync().map((model) => ({
      id: model.id,
      name: model.name,
      ...(model.rateLabel === undefined ? {} : { costCoefficient: Number.parseFloat(model.rateLabel) }),
    }))
  }

  /** 强制重拉目录（`refreshModelCatalog` 的 `invalidateModelCatalog()` 会调它）。 */
  invalidateModelCatalog(): void {
    this.remoteModels = undefined
    this.catalogAt = 0
    this.catalogFailedAt = 0
  }

  async listModels(_provider: string): Promise<readonly LlmModelInfo[]> {
    const all = await this.entries()
    const disabled = this.accountPool?.disabledModelsFor(this.product.id)
    const listed = disabled === undefined || disabled.size === 0
      ? all
      : all.filter((model) => !disabled.has(model.id))

    return listed.map((model) => ({
      provider: this.product.id,
      id: model.id,
      name: model.name,
      inputModalities: model.vision ? ['text', 'image'] as const : ['text'] as const,
      ...(model.isFree ? { isFree: true } : {}),
      reasoning: this.reasoningOf(),
    }))
  }

  async resolveModel(provider: string, model: string, _signal?: AbortSignal): Promise<LlmResolvedModelInfo> {
    const all = await this.entries()
    const entry = all.find((item) => item.id === model)
    const resolved: LlmResolvedModelInfo = {
      provider,
      id: model,
      // ⚠️ name 不带倍率后缀：这里是「会话记录」语境，倍率只属于选择列表
      // （与 raccoon / cline 的 resolveModel 约定一致）。
      name: entry?.name ?? model,
      inputModalities: entry?.vision === true ? ['text', 'image'] as const : ['text'] as const,
    }
    // ⚠️ **恒有窗口**：缺 `context` 会让宿主的上下文占用条整条不渲染、
    // 自动压缩阈值也失去唯一输入（codearts 的真实报障）。目录内用静态表的值，
    // 目录外给具名兜底 —— 本家目录的窗口**全部来自静态表**（上游端点不下发）。
    resolved.context = { contextWindow: entry?.contextWindow ?? MAGICREW_FALLBACK_CONTEXT_WINDOW }
    if (entry?.maxTokens !== undefined && entry.maxTokens > 0) resolved.defaultMaxTokens = entry.maxTokens
    resolved.reasoning = this.reasoningOf()
    return resolved
  }

  /**
   * 档位声明 —— 上游认 7 档但**强度不被区分**（见 `MAGICREW_REASONING_EFFORTS`）
   * ⇒ 只声明「关闭 / 开启」两档。
   *
   * ⚠️ **只在这里构造一次**：`listModels`（目录内）与 `resolveModel`（可能是手填 id）
   * 必须给**同一份**声明，否则用户手填一个模型与选一个模型会看到两套档位。
   */
  private reasoningOf(): LlmResolvedModelInfo['reasoning'] {
    return {
      efforts: MAGICREW_REASONING_EFFORTS.map((id) => ({ id, name: id })),
      defaultEffort: MAGICREW_DEFAULT_EFFORT,
    } as LlmResolvedModelInfo['reasoning']
  }

  // ── 推理 ──────────────────────────────────────────────────────────────

  async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    // ⚠️ 必须透传 modelId（见 options.resolveCredential 的注释）。
    const credential = await this.resolveCredentialImpl(options.model)
    if (credential === undefined || credential.apiKey === undefined || credential.apiKey.length === 0) {
      throw new LlmError('超级麦吉账号未登录或缺少 api_key，请重新登录', 'AUTH')
    }
    const body = await this.requestBody(options)
    const headers: Record<string, string> = {
      authorization: `Bearer ${credential.apiKey}`,
      'content-type': 'application/json',
      accept: 'text/event-stream',
      'user-agent': USER_AGENT,
      origin: this.product.webOrigin,
    }
    // ⚠️ 国际站**强制**要它（缺了是 HTTP 500 裸文本）；国内站不强制但带上无害。
    if (credential.organizationCode.length > 0) {
      headers['organization-code'] = credential.organizationCode
    }
    const response = await this.fetchChat(headers, body, options.signal)
    const contentType = response.headers.get('content-type') ?? ''
    if (!contentType.includes('text/event-stream')) {
      // ⚠️ 业务错误会以 HTTP 200 + application/json 返回（`code:403 token无效`）。
      //    不当成 SSE 读，否则症状是「没收到任何内容块」，与真因相距很远。
      throw magicrewNonStreamError(await response.text())
    }
    // ⚠️ 两级超时的数字**只来自产品配置**，不在这里另写常量 ——
    //    否则改配置会漏掉一处。
    yield* consumeOpenAiSse(
      response,
      { ...options.signal !== undefined ? { signal: options.signal } : {} },
      {
        label: 'magicrew',
        firstTokenTimeoutMs: this.product.chatHeaderTimeoutMs,
        chunkTimeoutMs: this.product.chunkTimeoutMs,
        ...options.maxTokens !== undefined ? { maxTokens: options.maxTokens } : {},
      },
    )
  }

  /**
   * 发推理请求并**只对「等响应头」这一段**设上限。
   *
   * ⚠️ 为什么必须单独一段：`chatHeaderTimeoutMs` 若只喂给 `consumeOpenAiSse`
   * 的 `firstTokenTimeoutMs`，那是**拿到响应头之后**的首 token 空闲超时
   * ⇒「等头」这一段没有任何超时，只靠 undici 默认（约 300s）。
   * 症状：网关卡在排队时用户看到一个「永远转圈」的会话。
   *
   * ⚠️ 拿到响应头**立即** `clearTimeout`（`finally` 里）：这条定时器只管「等头」，
   * 绝不能误杀后面的长回答（推理模型可能长时间只吐 reasoning）。
   */
  private async fetchChat(
    headers: Record<string, string>,
    body: Record<string, unknown>,
    signal: AbortSignal | undefined,
  ): Promise<Response> {
    const headerController = new AbortController()
    const headerTimer = setTimeout(
      () => headerController.abort(
        new LlmError('超级麦吉：等待响应头超时（上游可能正在排队）', 'TIMEOUT'),
      ),
      this.product.chatHeaderTimeoutMs,
    )
    try {
      return await this.fetchImpl(`${this.product.host}${MAGICREW_CHAT_PATH}`, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: signal === undefined
          ? headerController.signal
          : AbortSignal.any([signal, headerController.signal]),
      })
    } catch (error) {
      // ⚠️ 只有**本控制器**超时才改写错误；调用方 abort 必须原样冒泡
      //    （否则「用户点了停止」会被报成「上游超时」）。
      if (headerController.signal.aborted) throw headerController.signal.reason
      throw error
    } finally {
      clearTimeout(headerTimer)
    }
  }

  private async requestBody(options: GenerateOptions): Promise<Record<string, unknown>> {
    const body: Record<string, unknown> = {
      model: options.model,
      messages: await this.wireMessages(options),
      // ⚠️ 只流式：本适配器**没有**非流式分支。
      stream: true,
      /**
       * ⚠️⚠️ **必须显式要 usage**（来源实发实测）：
       * 不发这个字段上游就**不回** usage 帧，而 usage 是上下文占用条与
       * token 记账的**唯一来源** —— 缺了用户看到的是「占用 0% / 不显示」。
       */
      stream_options: { include_usage: true },
      /**
       * ⚠️⚠️ **未提供就一个字都不发**（来源真账号实测，让模型从 1 数到 400）：
       *
       * | 配置 | `finish_reason` | 正文长度 |
       * |---|---|---|
       * | **不发该字段** | `stop` | **1491 字符（完整）** |
       * | `max_tokens: 512` | **`length`** | **916 字符（被截断）** |
       *
       * 修前 `Math.max(undefined ?? 0, 512)` 恒发 512 ⇒ **每一轮都被上游截断**，
       * 用户看到的是「模型话说一半」。⇒ 只有调用方**真的给了**预算才下发，
       * 且仍抬到下限（64 会被 reasoning 吃满、正文空串）。
       */
      ...options.maxTokens === undefined
        ? {}
        : { max_tokens: Math.max(options.maxTokens, MAGICREW_MIN_MAX_TOKENS) },
    }
    // ⚠️ 非法档位**不发**：上游对非法值回 HTTP 400（`must be one of: none, …`）。
    //    判据用共享表 `MAGICREW_REASONING_EFFORTS`，不在这里另写一份。
    const effort = options.reasoningEffort
    if (typeof effort === 'string' && MAGICREW_REASONING_EFFORTS.includes(effort)) {
      body.reasoning_effort = effort
    }
    // ⚠️⚠️ **`options.tools` 不能直接下发**：它是本项目的 `ToolSchema`
    //（`{name, description, parameters}`），而上游要的是 **OpenAI 信封**
    //（`{type:'function', function:{name, description?, parameters?}}`）。
    // 直接摊平下发 ⇒ 上游 400（或更糟：吞掉字段、模型永不调用工具）。
    if (options.tools !== undefined && options.tools.length > 0) {
      body.tools = options.tools.map((tool) => ({
        type: 'function',
        function: {
          name: tool.name,
          ...tool.description.length > 0 ? { description: tool.description } : {},
          ...tool.parameters === undefined ? {} : { parameters: tool.parameters },
        },
      }))
    }
    return body
  }

  /**
   * wire 消息 = 共享件 `serializeMessages` 的产物（+ `options.system`）。
   *
   * ⚠️ **`options.system` 不在 `messages` 里**（它是独立入参），
   * `serializeMessages` 只吃 `messages` ⇒ 必须自己前置成 system 消息，
   * 否则整段系统提示**静默丢失**。
   */
  private async wireMessages(options: GenerateOptions): Promise<Array<Record<string, unknown>>> {
    const messages = serializeMessages(options.messages, await this.imageUrlsOf(options))
    if (options.system !== undefined && options.system.length > 0) {
      messages.unshift({ role: 'system', content: options.system })
    }
    return messages
  }

  /**
   * 收集图片附件 → 读字节 → `attachmentId → data URL` 映射（`serializeMessages` 的第二参）。
   *
   * ⚠️ key 的语义：共享件的消费点是 `userContentParts`，它用
   * `block.attachment.attachmentId` 去查表；而 `collectImages` 收集时写入的 key
   * **就是** `attachmentId` ⇒ 两条腿天然同源。
   *
   * ⚠️ 返回 `undefined` = 「整个请求没有图片」：`serializeMessages` 会走**纯文本**
   * 老路径（字符串形态 `content`）。返回**空 Map** 是另一种语义（「有图但读不到」），
   * 会把 user 消息升级成 parts 并留 `[image unavailable]` 占位 —— 那正是
   * 本适配器**刻意不做**的降级。
   */
  private async imageUrlsOf(options: GenerateOptions): Promise<Map<string, string> | undefined> {
    const refs = new Map<string, unknown>()
    for (const message of options.messages) {
      if (Array.isArray(message.content)) collectImages(message.content, refs)
    }
    if (refs.size === 0) return undefined
    const readImage = this.readImageImpl
    if (readImage === undefined) {
      throw new LlmError('magicrew: 未配置读图入口，无法发送图片', 'INVALID_REQUEST')
    }
    const imageUrls = new Map<string, string>()
    for (const [attachmentId, attachment] of refs) {
      const inline = await readImage(attachment)
      if (inline === undefined || inline.data.byteLength === 0) {
        throw new LlmError(
          'magicrew: 图片附件读取不到内容（附件服务可能未就绪，或该对象已不存在）',
          'INVALID_REQUEST',
        )
      }
      const mediaType = inline.mediaType.length > 0 ? inline.mediaType : 'image/png'
      imageUrls.set(attachmentId, `data:${mediaType};base64,${Buffer.from(inline.data).toString('base64')}`)
    }
    return imageUrls
  }

  // ── 目录 ──

  /** 同步全量目录（不触发网络）。 */
  private entriesSync(): readonly MagicrewModelEntry[] {
    return (this.remoteModels ?? this.staticModels()).map((model) => this.toEntry(model))
  }

  private async entries(): Promise<readonly MagicrewModelEntry[]> {
    const models = await this.loadModels()
    return models.map((model) => this.toEntry(model))
  }

  private toEntry(model: MagicrewCatalogModel): MagicrewModelEntry {
    const fallback = magicrewFallbackModelOf(model.id)
    // ⚠️ 远端只给 value/label/vision；ctx 与档位**两个端点都不下发** ⇒ 取静态表。
    //    ⚠️ 静态表没有就**不给**（不编造），目录外由 resolveModel 的具名兜底接住。
    const points = this.modelPoints[model.id]
    const wirePoints = points === undefined ? {} : { input_points: points.inputPoints }
    const rate = magicrewRateOf(wirePoints)
    const baseName = model.name.length > 0 ? model.name : model.id
    const name = rate === undefined ? baseName : `${baseName}（${rate}×）`
    return {
      id: model.id,
      name,
      vision: model.vision,
      ...fallback?.contextWindow === undefined ? {} : { contextWindow: fallback.contextWindow },
      ...fallback?.maxTokens === undefined ? {} : { maxTokens: fallback.maxTokens },
      ...rate === undefined ? {} : { rateLabel: String(rate) },
      // ⚠️ isFree 只从 input_points === 0 判，不能从 rate === 0 反推
      //    （缺价格时 rate 是 undefined 不是 0）。
      isFree: magicrewIsFree(wirePoints),
    }
  }

  private staticModels(): readonly MagicrewCatalogModel[] {
    return this.product.fallbackModels.map((model) => ({
      id: model.id,
      name: model.name,
      vision: model.supportsImage === true,
    }))
  }

  private async loadModels(): Promise<readonly MagicrewCatalogModel[]> {
    // ⚠️ TTL 门：没有它时每次发消息（resolveModel）都会多一次目录 GET。
    if (this.remoteModels !== undefined && this.nowImpl() - this.catalogAt < CATALOG_TTL_MS) {
      return this.remoteModels
    }
    // ⚠️ **负缓存（失败退避）**：失败时 `catalogAt` 仍是旧值 ⇒ 没有这道门时
    //    **每条消息**都会再发一次目录 GET + 一条 warn —— 一次上游抖动就会让
    //    整段对话每轮多一次超时请求。成功时 `catalogFailedAt` 会被清零。
    if (this.catalogFailedAt !== 0
      && this.nowImpl() - this.catalogFailedAt < this.product.catalogRetryMs) {
      return this.remoteModels ?? this.staticModels()
    }
    // 并发去重：多个入口同时 listModels 只发一次。
    if (this.catalogInFlight !== undefined) return await this.catalogInFlight
    const inFlight = this.fetchModels()
    this.catalogInFlight = inFlight
    try {
      return await inFlight
    } finally {
      this.catalogInFlight = undefined
    }
  }

  private async fetchModels(): Promise<readonly MagicrewCatalogModel[]> {
    // ① 接线层注入的拉取器（`wiring.ts` 的 `fetchRemoteCatalog` 三层缓存走这条）
    if (this.fetchRemoteModelsImpl !== undefined) {
      try {
        const models = await this.fetchRemoteModelsImpl()
        if (models.length > 0) {
          this.rememberModels(models)
          return models
        }
      } catch (error) {
        this.warnImpl(`[magicrew] 目录拉取失败，回退静态表：${String(error)}`)
      }
    }
    // ② 适配器自己用当前账号的 jwt 真拉（未接线时的兜底）
    const credential = await this.resolveCredentialImpl()
    if (credential !== undefined) {
      try {
        const models = await fetchMagicrewCatalogModels({
          jwt: credential.jwt,
          organizationCode: credential.organizationCode,
          product: this.product,
          fetchImpl: this.fetchImpl,
        })
        if (models.length > 0) {
          this.rememberModels(models)
          await this.loadModelPoints(credential, models)
          return models
        }
      } catch (error) {
        // ⚠️ 网络抖动 ⇒ 退回上次快照/静态表，**别让整个 provider 从列表里消失**。
        this.warnImpl(`[magicrew] 目录拉取失败，回退：${String(error)}`)
      }
    }
    // ⚠️ 两条腿都没拿到 ⇒ 记失败时间戳（负缓存据此退避）。
    //    **不覆盖** `catalogAt`：上一次成功的时间戳仍然有效。
    this.catalogFailedAt = this.nowImpl()
    return this.remoteModels ?? this.staticModels()
  }

  /**
   * 拉一次倍率表（`products/model-points`）并缓存。
   *
   * 失败静默：倍率是装饰性信息，让它的失败冒泡会让整份目录回退到静态表。
   * 空目录直接跳过（没有 id 可问，白花一次请求）。
   */
  private async loadModelPoints(
    credential: MagicrewCredential,
    models: readonly MagicrewCatalogModel[],
  ): Promise<void> {
    const ids = models.map((model) => model.id)
    if (ids.length === 0) return
    try {
      this.modelPoints = await fetchMagicrewModelPoints({
        jwt: credential.jwt,
        organizationCode: credential.organizationCode,
        modelIds: ids,
        product: this.product,
        fetchImpl: this.fetchImpl,
      })
    } catch (error) {
      this.warnImpl(`[magicrew] 倍率拉取失败（不影响目录）：${String(error)}`)
    }
  }

  /** 记一次目录**成功**：刷新时间戳并清掉失败退避（只此一处）。 */
  private rememberModels(models: readonly MagicrewCatalogModel[]): void {
    this.remoteModels = models
    this.catalogAt = this.nowImpl()
    this.catalogFailedAt = 0
  }
}
