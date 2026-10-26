/**
 * Loomy LLM 适配器。
 *
 * ## 协议
 *
 * 实测（2026-09-26）`POST {apiBase}/chat/completions` 是**标准 OpenAI 兼容
 * + 标准 SSE**：`data:` 帧 + 空 `data:` 终止帧，思考在 `delta.reasoning_content`，
 * **无加密、无信封、无格式转换**。与 qoder 同形，故消息序列化与 SSE 消费
 * 直接复用 `src/openai-compat.ts` —— 那是为这种形态抽的共享层，
 * **新增** provider 用它正是其设计意图（AGENTS.md 只禁止拿它去重构
 * buddy/lobsterai 的既有实现）。
 *
 * ⚠️ **认证头与业务端点不同**：chat 端点**只认** `Authorization: Bearer`，
 * 而 `/models`、`/points/*` 只认 `token`。故 `stream()` 用
 * `loomyChatHeaders()`（两个都发），`listModels()` 用 `loomyBusinessHeaders()`。
 */

import type { Context } from './cordis.js'
import type { CredentialRef } from './credential-ref.js'
import { LlmAdapter, LlmError } from './llm.js'
import type {
  GenerateOptions, LlmModelInfo, LlmProviderInfo, LlmResolvedModelInfo, StreamChunk,
} from './llm.js'
import { AccountPool, providerCatalogVisible } from './account-pool.js'
import { settingsNamespaceFor } from './settings-compat.js'
import {
  isLoomyChatModel,
  isLoomyExpired,
  LOOMY_REQUEST_TIMEOUT_MS,
  loomyBusinessHeaders,
  loomyChatHeaders,
  loomyDisplayName,
  splitLoomyRate,
  type LoomyCredential,
} from './loomy.js'
import { LOOMY, type LoomyFallbackModel, type LoomyProduct } from './loomy-product.js'
import {
  collectImages,
  consumeOpenAiSse,
  errorDetail,
  httpErrorCode,
  isTransportError,
  serializeMessages,
} from './openai-compat.js'
import { RATE_LIMIT_FALLBACK_MS, looksLikeQuotaError } from '../shared/account-failover.js'
import { nextUtc8DayStartMs } from '../shared/model-queue.js'
import { recordCurrentAccount } from './current-account.js'

/** 本适配器注册的 provider 路由名（等价于 `LOOMY.id`）。 */
export const PROVIDER = 'loomy'

/**
 * 上游认可的思考档位白名单。
 *
 * ⚠️ 来源是上游自己的报错文案（2026-10-23 经 EasyCLIProxyAPI 实测）：
 * > `level "…" not supported, valid levels: low, medium, high, max, xhigh`
 *
 * 注意它**不含 `minimal` / `none` / `ultra`** —— 与同属商汤系的 sensenova
 * 能力表不同，不要互相照抄。
 */
export const LOOMY_REASONING_EFFORTS: ReadonlySet<string> = new Set([
  'low', 'medium', 'high', 'max', 'xhigh',
])

/** 远端模型条目（已归一）。 */
export interface LoomyRemoteModel {
  id: string
  /** **已规范化**的展示名（含倍率）。 */
  name: string
  contextWindow: number
  supportsImage: boolean
  supportsThinking: boolean
}

/** 把 `capabilities.input_modalities` 读成小写字符串数组。 */
function readInputModalities(entry: Record<string, unknown>): string[] {
  const capabilities = entry.capabilities
  if (typeof capabilities !== 'object' || capabilities === null) return []
  const raw = (capabilities as Record<string, unknown>).input_modalities
  if (!Array.isArray(raw)) return []
  return raw.filter((item): item is string => typeof item === 'string').map((item) => item.toLowerCase())
}

/**
 * 解析远端 `GET /models` 响应，只保留 `type === 'chat'` 的条目。
 *
 * ⚠️ 过滤判据是 `type`，**不能**看 `input_modalities` —— 实测 5 个 chat
 * 模型的输入模态含 `image`（能看图），那不是生图模型。
 * ⚠️ 展示名经 `loomyDisplayName` 规范化（远端原值是三种括号风格混用）。
 */
export function parseLoomyRemoteModels(payload: unknown): LoomyRemoteModel[] {
  const list = Array.isArray(payload)
    ? payload
    : (typeof payload === 'object' && payload !== null
        && Array.isArray((payload as Record<string, unknown>).data)
      ? (payload as Record<string, unknown>).data as unknown[]
      : [])
  const models: LoomyRemoteModel[] = []
  for (const item of list) {
    if (!isLoomyChatModel(item)) continue
    const entry = item as Record<string, unknown>
    const id = String(entry.id)
    const rawName = typeof entry.name === 'string' && entry.name.length > 0 ? entry.name : id
    const contextWindow = Number(entry.context_length)
    const capabilities = typeof entry.capabilities === 'object' && entry.capabilities !== null
      ? entry.capabilities as Record<string, unknown>
      : {}
    models.push({
      id,
      name: loomyDisplayName(rawName),
      contextWindow: Number.isFinite(contextWindow) && contextWindow > 0 ? contextWindow : 0,
      supportsImage: readInputModalities(entry).includes('image'),
      supportsThinking: capabilities.reasoning === true,
    })
  }
  return models
}

/**
 * 从上游拉取真实模型目录（`GET {apiBase}/models`）。
 *
 * ## 为什么这一支必须存在（用户报障「loomy 模型没刷新」）
 *
 * 此前 Loomy **从未接过远端目录**：`wiring.ts` 注册适配器时没传
 * `fetchRemoteModels`，于是 `loadModels()` 永远走 `fallbackModels` ——
 * 那张表是 2026-09-26 的快照，上游后来上架的 `spark-x2.6` / `auto` 一律看不到。
 * 点「刷新模型目录」还会得到一句误导性的「远端未返回目录，仍显示本地缓存」：
 * 不是远端挂了，而是**根本没有远端请求**。
 *
 * ⚠️ **请求头只发 `token`**（`loomyBusinessHeaders`）：`/models` 不认
 * `Authorization: Bearer`，带上会被判「缺少 token」。
 * ⚠️ 目录是**账号无关**的（同一份目录对所有账号下发），故取第一个可解析凭据
 * 即可，不必按账号各拉一次。
 *
 * @returns 归一后的模型列表；上游异常时抛错（由 `fetchRemoteCatalog` 转成
 *   失败冷却并回退快照/兜底表）。
 */
export async function fetchLoomyRemoteModels(
  credential: LoomyCredential,
  product: LoomyProduct,
  fetcher: typeof fetch = fetch,
): Promise<LoomyRemoteModel[]> {
  const response = await fetcher(`${product.apiBase}/models`, {
    method: 'GET',
    headers: loomyBusinessHeaders(credential.access_token),
    signal: AbortSignal.timeout(LOOMY_REQUEST_TIMEOUT_MS),
  })
  if (!response.ok) throw new Error(`loomy 远端目录 HTTP ${response.status}`)
  const models = parseLoomyRemoteModels(await response.json() as unknown)
  if (models.length === 0) throw new Error('loomy 远端目录为空，使用兜底表')
  return models
}

/** 兜底表条目转远端形状。 */
function fallbackToRemote(model: LoomyFallbackModel): LoomyRemoteModel {
  return {
    id: model.id,
    name: model.name,
    contextWindow: model.contextWindow,
    // 兜底表不声明图片能力：宁可少报（用户改用文本描述），
    // 也不要报一个服务端可能不认的模态。
    supportsImage: false,
    supportsThinking: true,
  }
}

/** {@link LoomyAdapter} 的构造选项。 */
export interface LoomyAdapterOptions {
  /** 单凭据回退 ref（无账号池时）。 */
  credentialRef: CredentialRef
  /**
   * 解析当前可用凭据。
   *
   * ⚠️ 入参是**本轮要用的模型 id**：Loomy 的选号策略要按「该模型是否受限」
   * 先过滤账号（限流是**按模型**记的），再按余额分档。实现**必须**把它透传给
   * `AccountPool.getAvailableAccount` 的 `modelId` —— 早期实现传空串
   * （等于不按模型过滤），会让模型级限流失效。
   */
  resolveCredential: (modelId?: string) => Promise<LoomyCredential | undefined>
  /**
   * 凭据失效时的处理。
   *
   * ⚠️ Loomy **没有 refresh 端点**，故实现只做**有效性探测**并在失效时抛错，
   * 不会（也无法）续期。
   */
  refresh: () => Promise<void>
  /** 拉取远端模型目录；失败时适配器回退兜底表。 */
  fetchRemoteModels?: () => Promise<LoomyRemoteModel[]>
  /** 读取图片附件的原始字节（内联为 data URL 用）。 */
  readImage?: (attachment: unknown) => Promise<{ data: Uint8Array; mediaType: string } | undefined>
  /** 账号池（目录门控与黑名单）。 */
  accountPool?: AccountPool
  /** 产品配置；默认 {@link LOOMY}。 */
  product?: LoomyProduct
  /** 注入的 fetch（测试用）。 */
  fetchImpl?: typeof fetch
}

/** Loomy 模型适配器。chat 端点用 Bearer，业务端点用 token。 */
export class LoomyAdapter extends LlmAdapter {
  private readonly product: LoomyProduct
  private readonly fetchImpl: typeof fetch
  /** 兜底模型索引（id → 条目）。 */
  private readonly fallbackIndex: ReadonlyMap<string, LoomyFallbackModel>
  /** 远端模型缓存（含展示名与能力）；未拉取时为 undefined。 */
  private remoteModels: LoomyRemoteModel[] | undefined

  /**
   * 丢弃已缓存的远端模型目录，供管理端「刷新模型目录」按钮强制重拉。
   * 见 `src/providers/llm-adapter.ts` 与 `wiring.ts` 的 `refreshModelCatalog`。
   */
  override invalidateModelCatalog(): void {
    this.remoteModels = undefined
  }

  constructor(private readonly options: LoomyAdapterOptions) {
    super()
    this.product = options.product ?? LOOMY
    this.fetchImpl = options.fetchImpl ?? fetch
    this.fallbackIndex = new Map(this.product.fallbackModels.map((model) => [model.id, model]))
  }

  /**
   * 描述本适配器拥有的 provider 路由。
   *
   * 对入参做防御性归一化：DSH 会强制校验 `info.id === provider`，而模型设置页
   * 会用该 id 计算 `deriveKeyRef(provider)`（内部调 `provider.toUpperCase()`）。
   * 一旦 provider 不是字符串（上游传入 undefined），直接回退到本产品的 id，
   * 避免 `undefined.toUpperCase is not a function` 在客户端炸开。
   */
  providerInfo(provider: string): LlmProviderInfo {
    const id = typeof provider === 'string' && provider.length > 0 ? provider : this.product.id
    return { id, name: this.product.displayName }
  }

  /** 完整目录（**不套黑名单**），带最终展示名。设置页需要它渲染被关闭的模型。 */
  listAllModels(): readonly { id: string; name: string }[] {
    const source = this.remoteModels ?? this.product.fallbackModels.map(fallbackToRemote)
    return source.map((model) => ({ id: model.id, name: model.name }))
  }

  /** 取（并缓存）远端模型目录；失败时回退兜底表。 */
  private async loadModels(): Promise<LoomyRemoteModel[]> {
    if (this.remoteModels !== undefined) return this.remoteModels
    if (this.options.fetchRemoteModels !== undefined) {
      try {
        const fetched = await this.options.fetchRemoteModels()
        if (fetched.length > 0) {
          this.remoteModels = fetched
          return fetched
        }
      } catch {
        // 远端失败静默回退兜底表：模型目录是展示信息，不该让整个 provider 报错。
      }
    }
    const fallback = this.product.fallbackModels.map(fallbackToRemote)
    this.remoteModels = fallback
    return fallback
  }

  private inputModalitiesFor(model: LoomyRemoteModel | undefined): readonly ('text' | 'image')[] {
    return model?.supportsImage === true ? ['text', 'image'] : ['text']
  }

  async listModels(_provider: string): Promise<readonly LlmModelInfo[]> {
    // ⚠️ 无已登录账号时返回 `[]` → DSH 的 buildModelCatalog 把整个 provider
    // 分组隐藏。**必须返回空数组而不能抛错**（抛错会被归入 catalog 的
    // failures，界面上反而多一条 provider 报错）。
    if (!await providerCatalogVisible(this.options.accountPool, this.product.id)) return []

    const all = await this.loadModels()
    const disabled = this.options.accountPool?.disabledModelsFor(this.product.id)
    const listed = disabled === undefined || disabled.size === 0
      ? all
      : all.filter((model) => !disabled.has(model.id))

    return listed.map((model) => ({
      provider: this.product.id,
      id: model.id,
      // 倍率拼进 name（不是 description）：composer 的模型切换菜单只渲染 name。
      name: model.name,
      inputModalities: this.inputModalitiesFor(model),
    }))
  }

  async resolveModel(provider: string, model: string, _signal?: AbortSignal): Promise<LlmResolvedModelInfo> {
    const all = await this.loadModels()
    const entry = all.find((item) => item.id === model)
    const fallback = this.fallbackIndex.get(model)
    // ⚠️ name **不带倍率**（与 qoder/trae 一致）：价格只属于选择列表语境。
    const bareName = fallback !== undefined ? splitLoomyRate(fallback.name).name : model
    const resolved: LlmResolvedModelInfo = {
      provider,
      id: model,
      name: entry !== undefined ? splitLoomyRate(entry.name).name : bareName,
      inputModalities: this.inputModalitiesFor(entry),
    }
    const contextWindow = entry?.contextWindow ?? fallback?.contextWindow
    // 未知模型不编造 context（宁可让 DSH 用默认值，也不报一个假窗口）。
    if (contextWindow !== undefined && contextWindow > 0) {
      resolved.context = { contextWindow }
    }
    return resolved
  }

  /**
   * 兼容 0.1.1-rc.2：新版 `LlmRuntime.prepareCall()` 会调用
   * `registration.adapter.prepareCall(...)`，而本仓库链接的 dsh-llm 副本
   * 基类尚未提供该方法，缺少时会在每轮请求开始时抛
   * `registration.adapter.prepareCall is not a function`。
   * 与 `BuddyAdapter` / `QoderAdapter` 同款 shim。
   */
  async prepareCall(
    provider: string,
    model: string,
    signal?: AbortSignal,
  ): Promise<{ model: LlmResolvedModelInfo; stream: (options: GenerateOptions) => AsyncIterable<StreamChunk> }> {
    return {
      model: await this.resolveModel(provider, model, signal),
      stream: (options: GenerateOptions) => this.stream(options),
    }
  }

  async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    // 图片能力按**模型**判定。这里**不能**放宽成「总是接受」：DSH 在
    // LlmRuntime 里按适配器播报的 `inputModalities` 决定要不要把图片投影成
    // 文本占位符，声明支持就必须真支持。
    const imageRefs = new Map<string, unknown>()
    for (const message of options.messages) {
      if (Array.isArray(message.content)) collectImages(message.content, imageRefs)
    }
    const all = await this.loadModels()
    const entry = all.find((item) => item.id === options.model)
    let imageUrls: Map<string, string> | undefined
    if (imageRefs.size > 0) {
      if (!this.inputModalitiesFor(entry).includes('image')) {
        throw new LlmError(`loomy: 模型 "${options.model}" 不支持图片输入`, 'UNSUPPORTED_CONTENT')
      }
      if (this.options.readImage === undefined) {
        throw new LlmError('loomy: 图片输入需要附件服务', 'UNSUPPORTED_CONTENT')
      }
      // 保留**空 Map**（而非降级为 undefined）：图片存在但全部读取失败时，
      // 空 Map 仍会让 userContentParts 产出 [image unavailable] 占位符。
      imageUrls = new Map()
      for (const [id, ref] of imageRefs) {
        const image = await this.options.readImage(ref)
        if (image === undefined) continue
        imageUrls.set(id, `data:${image.mediaType};base64,${Buffer.from(image.data).toString('base64')}`)
      }
    }

    // 1. 取凭据（过期则先尝试探测/刷新）
    //
    // ⚠️ **必须把模型 id 传给选号器**：Loomy 的选号要先按「该模型是否受限」
    // 过滤账号（限流按模型记），再按余额分档。传空串会让模型级限流失效。
    let credential = await this.options.resolveCredential(options.model)
    if (credential === undefined || isLoomyExpired(credential)) {
      await this.options.refresh()
      credential = await this.options.resolveCredential(options.model)
    }
    if (credential === undefined || credential.access_token.length === 0) {
      throw new LlmError('loomy: no usable credential; log in first', 'MISSING_CREDENTIAL')
    }
    // 反查账号 id：额度/限流标记与换号排除都以它为键（用量归属与定向续期同样用它）。
    let currentAccountId = ''
    if (this.options.accountPool !== undefined) {
      currentAccountId = await this.options.accountPool.findAccountIdByCredential(
        this.product.id, credential.access_token,
      )
    }

    const messages = serializeMessages(options.messages, imageUrls)

    /**
     * 前置 system 消息（若有）。
     *
     * ⚠️ 必须**先拼再放进对象**，不要在对象字面量里写两次 `messages` ——
     * 后者依赖「后面的键覆盖前面」这一隐式行为，读者极易误判成漏了 system。
     */
    const wireMessages = options.system !== undefined && options.system.length > 0
      ? [{ role: 'system', content: options.system }, ...messages]
      : messages

    /** 构造请求体。 */
    const buildBody = (): string => JSON.stringify({
      model: options.model,
      messages: wireMessages,
      stream: true,
      ...options.maxTokens !== undefined ? { max_tokens: options.maxTokens } : {},
      ...options.temperature !== undefined ? { temperature: options.temperature } : {},
      ...options.stop !== undefined && options.stop.length > 0 ? { stop: options.stop } : {},
      // 思考等级：只发上游认的五档。
      //
      // ⚠️ 判据来自上游自己的报错文案（2026-10-23 经 EasyCLIProxyAPI 实测，
      // 传非法值时中间层把上游原文透出）：
      // > `level "…" not supported, valid levels: low, medium, high, max, xhigh`
      // 即上游**真的消费**这个参数，且非法值是硬失败（故必须过白名单）。
      //
      // ⚠️ `xhigh` 归一成 `max`：参考实现 `loomy-gateway.js` 明确这么做
      // （「思考强度归一化：xhigh 视为 max，去掉 xhigh 档，与 max 等价」）。
      // 透传前不归一会让同一档位在两条链路上行为不一致。
      ...LOOMY_REASONING_EFFORTS.has(options.reasoningEffort ?? '')
        ? {
            reasoning_effort: options.reasoningEffort === 'xhigh' ? 'max' : options.reasoningEffort,
          }
        : {},
      ...options.tools !== undefined && options.tools.length > 0
        ? {
            tools: options.tools.map((tool) => ({
              type: 'function',
              function: {
                name: tool.name,
                ...tool.description.length > 0 ? { description: tool.description } : {},
                ...tool.parameters === undefined ? {} : { parameters: tool.parameters },
              },
            })),
          }
        : {},
    })

    /** 发送一次 chat 请求。 */
    const send = async (token: string): Promise<Response> => {
      try {
        return await this.fetchImpl(`${this.product.apiBase}/chat/completions`, {
          method: 'POST',
          // ⚠️ chat 端点只认 Bearer（业务端点才认 token），这里两个都发。
          headers: loomyChatHeaders(token),
          body: buildBody(),
          signal: options.signal,
        })
      } catch (error) {
        if (options.signal?.aborted) throw error
        if (isTransportError(error)) {
          throw new LlmError(
            `loomy: transport error: ${error instanceof Error ? error.message : String(error)}`,
            'TRANSPORT',
            { cause: error as Error },
          )
        }
        throw error
      }
    }

    // 2. 发送请求（账号级失败自动换号，试完所有候选才报错）。
    //
    // ## 换号语义（真实缺陷，用户报障 2026-09-29「积分不足不切号」）
    //
    // Loomy 的「积分余额不足」以普通 400 返回（无独立状态码），而账号按手动
    // 顺序选取 —— 排在首位的 0 积分账号会**每次**被选中并失败，永远轮不到
    // 有积分的账号。故在请求路径上做账号级故障转移：
    //
    // - **积分耗尽**（HTTP 402，或其他 4xx + 额度文案，实测为 400 +
    //   「积分余额不足，请获取积分后再试」）→ 把该账号在该模型上标记到
    //   UTC+8 当日 24:00（积分按自然日结算），换下一个账号重试；
    // - **限流**（HTTP 429）→ 短冷却标记后换号；
    // - **401/403** → 先尝试刷新一次（Loomy 无 refresh 端点，多半抛错，
    //   保留该路径以便将来上游开放续期时自动受益）；401 仍失败则换号
    //   （token 过期按账号生效，别的账号可能仍有效），裸 403 无账号级证据，
    //   保持原样抛出；
    // - 其余（400 无额度文案、5xx…）与账号无关，原样抛出。
    //
    // ⚠️ 额度/限流标记落在 `modelRateLimits`（账号 × 模型）：选号时
    // `getAvailableAccount` 自动跳过未到期的标记，到期由 `sweepExpiredRateLimits`
    // 清理 —— 「当天锁」复用既有存储，不需要新的状态形态。
    //
    // ⚠️ 已试过的账号必须排除（`tried`）：池按手动顺序取「第一个可用」，
    // 刚失败的账号往往仍是第一，不排除就会原地打转、换号形同虚设。
    const tried = new Set<string>()
    for (;;) {
      let response = await send(credential.access_token)
      let errorText = response.ok ? '' : await response.text().catch(() => '')

      if (!response.ok && (response.status === 401 || response.status === 403)) {
        // 401/403 时尝试刷新一次（Loomy 无 refresh 端点，故这里多半会抛错，
        // 但保留该路径以便将来上游开放续期时自动受益）。
        let refreshed: LoomyCredential | undefined
        try {
          await this.options.refresh()
          refreshed = await this.credentialOfAccount(currentAccountId)
        } catch (error) {
          // 刷新失败不致命：换号仍有机会，单个账号故障不该让整轮陪葬。
          console.warn(`[loomy] 刷新账号 ${currentAccountId || '(current)'} 凭据失败，改用换号重试：${String(error)}`)
        }
        if (refreshed !== undefined && refreshed.access_token.length > 0) {
          credential = refreshed
          response = await send(credential.access_token)
          errorText = response.ok ? '' : await response.text().catch(() => '')
        }
      }

      if (response.ok) {
        // ⚠️ 业务失败也可能以 HTTP 200 + SSE 内嵌错误帧返回，由 consumeOpenAiSse 处理
        //（流中途的错误不换号：此时可能已向客户端产出内容，重放会造成重复输出）。
        yield* consumeOpenAiSse(response, { signal: options.signal }, {
          label: 'loomy',
          firstTokenTimeoutMs: resolveFirstTokenTimeoutMs(),
          chunkTimeoutMs: resolveChunkTimeoutMs(),
        })
        return
      }

      const quotaLike = response.status === 402
        || (response.status >= 400 && looksLikeQuotaError(errorText))
      const rateLimited = response.status === 429
      const authFailed = response.status === 401
      if (!quotaLike && !rateLimited && !authFailed) {
        throw new LlmError(`loomy: ${errorDetail(errorText)}`, httpErrorCode(response.status), { status: response.status })
      }

      const pool = this.options.accountPool
      if (pool === undefined) {
        // 无账号池：无从换号，保持原有单账号行为。
        throw new LlmError(`loomy: ${errorDetail(errorText)}`, httpErrorCode(response.status), { status: response.status })
      }

      // 标记失败账号，让后续选号自动跳过它（401 不标记：token 过期与限流/额度语义不同）。
      if (currentAccountId !== '' && !authFailed) {
        const resetAt = rateLimited ? Date.now() + RATE_LIMIT_FALLBACK_MS : nextUtc8DayStartMs()
        await pool.updateModelRateLimit(currentAccountId, options.model, resetAt)
      }

      if (currentAccountId !== '') tried.add(currentAccountId)
      const next = await pool.getAvailableAccount(this.product.id, options.model, tried)
      if (next === null || tried.has(next.entry.id)) {
        throw new LlmError(
          `loomy: 所有账号均额度不足、受限或凭证失效（最后错误：${errorDetail(errorText)}）`,
          quotaLike ? 'QUOTA_EXCEEDED' : (rateLimited ? 'RATE_LIMIT' : 'AUTH'),
          { status: response.status },
        )
      }
      credential = next.credential as LoomyCredential
      currentAccountId = next.entry.id
      // 登记实际用上的账号：定向续期（wiringRefresh）与用量记录都以它为准。
      recordCurrentAccount(this.product.id, currentAccountId)
      if (isLoomyExpired(credential)) {
        await this.options.refresh()
        const fresh = await this.credentialOfAccount(currentAccountId)
        if (fresh !== undefined && fresh.access_token.length > 0) credential = fresh
      }
    }
  }

  /**
   * 按账号 id 取凭据（刷新后的定向取用）。
   *
   * ⚠️ 刷新后**不能**用 `resolveCredential()` 取凭据 —— 那拿回的是「池首选」
   * 账号，而刚刷新的是 `currentAccountId` 指向的账号；两者不同时，拿到的是
   * 没刷新过的旧 token。按 id 定向解析才与刷新目标一致。
   */
  private async credentialOfAccount(accountId: string): Promise<LoomyCredential | undefined> {
    if (this.options.accountPool !== undefined && accountId !== '') {
      const resolved = await this.options.accountPool.resolveCredentialForAccount(accountId)
      if (resolved !== undefined) return resolved as LoomyCredential
    }
    return await this.options.resolveCredential()
  }
}

/** 首 token 超时（毫秒）；可用环境变量覆盖（与其余适配器同约定）。 */
function resolveFirstTokenTimeoutMs(): number {
  const raw = Number(process.env.DSH_LOOMY_FIRST_TOKEN_TIMEOUT_MS)
  return Number.isFinite(raw) && raw > 0 ? raw : 120_000
}

/** chunk 间隔超时（毫秒）。 */
function resolveChunkTimeoutMs(): number {
  const raw = Number(process.env.DSH_LOOMY_CHUNK_TIMEOUT_MS)
  return Number.isFinite(raw) && raw > 0 ? raw : 120_000
}

/**
 * 在 `ctx.llm` 上注册 Loomy provider 路由与适配器。
 *
 * 返回适配器实例：Jet Hub「显示列表」需要 `listAllModels()`
 * （不受黑名单影响、带最终展示名）。`ctx.llm` 不透传自定义方法，
 * 故须由调用方持有引用并在 `index.ts` 的 `modelAdapters` 里登记。
 */
export function registerLoomyLlm(ctx: Context, options: LoomyAdapterOptions): LoomyAdapter {
  const product = options.product ?? LOOMY
  ctx.llm.registerConfigurableProviders([
    {
      provider: product.id,
      displayName: product.displayName,
      settingsNs: settingsNamespaceFor(ctx, `llm-${product.id}`),
      settingsPath: [],
    },
  ])
  const adapter = new LoomyAdapter(options)
  ctx.llm.registerAdapter([product.id], adapter)
  return adapter
}
