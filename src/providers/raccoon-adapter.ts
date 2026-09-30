/**
 * Raccoon Work（商汤小浣熊）LLM 适配器。
 *
 * 移植自来源 `src/raccoon-adapter.ts`，**改动仅限依赖**：
 * - `@deepseek-ai/dsh-llm` → 本地 `shared/llm.js`；
 * - `providerCatalogVisible`（DSH 模型选择器的目录门控）→ **整体删除**：
 *   它只影响 DSH 是否隐藏该 provider 分组，不改路由；对外 API 由
 *   `GET /v1/models` 与模型开关自行决定可见性（见 AGENTS.md 的分叉点表）。
 * - `registerRaccoonLlm(ctx, ...)` → 由调用方用 {@link RaccoonAdapter} 构造并
 *   注册进 {@link ProviderRegistry}。
 *
 * ## 两个必须真的做到的点（来源踩过的坑）
 *
 * 1. **`tools` 必须下发到请求体顶层** —— Qoder 与 TRAE 都因漏发而让模型在
 *    正文里臆造 XML 工具调用。
 * 2. **`listAllModels()` 必须实现** —— 管理端要显示被关闭的模型及其倍率；
 *    缺了它会退化为裸 id。
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
  errorDetail,
  httpErrorCode,
  isTransportError,
  serializeMessages,
} from '../shared/openai-compat.js'
import { RATE_LIMIT_FALLBACK_MS, looksLikeQuotaError } from '../shared/account-failover.js'
import { nextUtc8DayStartMs } from '../shared/model-queue.js'
import { isRaccoonExpired, type RaccoonCredential } from './raccoon.js'
import { RACCOON, type RaccoonFallbackModel, type RaccoonProduct } from './raccoon-product.js'
import { recordCurrentAccount } from './current-account.js'
import type { AccountPool } from '../pool/account-pool.js'

/** 本适配器注册的 provider 路由名（等价于 `RACCOON.id`）。 */
export const PROVIDER = 'raccoon'

/** 远端模型条目（已归一）。 */
export interface RaccoonRemoteModel {
  id: string
  /** **已规范化**的展示名（含倍率）。 */
  name: string
  contextWindow: number
  maxTokens: number
  supportsImage: boolean
}

/**
 * 只放行**安全正整数**。
 *
 * ⚠️ 远端是外部输入：`0` / 负数 / `NaN` 会让调用方在 `defaultMaxTokens` 的
 * 硬校验上抛错，**整轮对话起不来**（不是降级，是崩）。
 */
function positiveMaxTokens(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : undefined
}

/** 兜底表条目转远端形状。 */
function fallbackToRemote(model: RaccoonFallbackModel): RaccoonRemoteModel {
  return {
    id: model.id,
    name: model.name,
    contextWindow: model.contextWindow,
    maxTokens: model.maxTokens,
    // 兜底表**声明**图片能力（它有该字段）。
    supportsImage: model.supportsImage,
  }
}

/** {@link RaccoonAdapter} 的构造选项。 */
export interface RaccoonAdapterOptions {
  /** 解析当前可用凭据。 */
  resolveCredential: () => Promise<RaccoonCredential | undefined>
  /** 凭据失效时的处理（raccoon 有 refresh 端点，会真续期）。 */
  refresh: () => Promise<void>
  /** 拉取远端模型目录；失败时适配器回退兜底表。 */
  fetchRemoteModels?: () => Promise<RaccoonRemoteModel[]>
  /** 读取图片附件的原始字节（内联为 data URL 用）。 */
  readImage?: (attachment: unknown) => Promise<{ data: Uint8Array; mediaType: string } | undefined>
  /** 账号池（用于读模型黑名单）。 */
  accountPool?: AccountPool
  /** 产品配置；默认 {@link RACCOON}。 */
  product?: RaccoonProduct
  /** 注入的 fetch（测试用）。 */
  fetchImpl?: typeof fetch
}

/** Raccoon Work 模型适配器。 */
export class RaccoonAdapter extends LlmAdapter {
  private readonly product: RaccoonProduct
  private readonly fetchImpl: typeof fetch
  /** 兜底模型索引（id → 条目）。 */
  private readonly fallbackIndex: ReadonlyMap<string, RaccoonFallbackModel>
  /** 远端模型缓存；未拉取时为 undefined。 */
  private remoteModels: RaccoonRemoteModel[] | undefined

  constructor(private readonly options: RaccoonAdapterOptions) {
    super()
    this.product = options.product ?? RACCOON
    this.fetchImpl = options.fetchImpl ?? fetch
    this.fallbackIndex = new Map(this.product.fallbackModels.map((model) => [model.id, model]))
  }

  /** 描述本适配器拥有的 provider 路由。 */
  providerInfo(provider: string): LlmProviderInfo {
    const id = typeof provider === 'string' && provider.length > 0 ? provider : this.product.id
    return { id, name: this.product.displayName }
  }

  /**
   * 完整目录（**不套黑名单**），带最终展示名。
   *
   * 管理端需要它渲染被关闭的模型 —— 否则那些条目只能凭黑名单的 key 补回，
   * 而那条路径拿不到展示名，会退化成裸 id（倍率与模型名随之丢失）。
   */
  listAllModels(): readonly { id: string; name: string }[] {
    const source = this.remoteModels ?? this.product.fallbackModels.map(fallbackToRemote)
    return source.map((model) => ({ id: model.id, name: model.name }))
  }

  /** 取（并缓存）远端模型目录；失败时回退兜底表。 */
  private async loadModels(): Promise<RaccoonRemoteModel[]> {
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

  private inputModalitiesFor(model: RaccoonRemoteModel | undefined): readonly ('text' | 'image')[] {
    return model?.supportsImage === true ? ['text', 'image'] : ['text']
  }

  async listModels(_provider: string): Promise<readonly LlmModelInfo[]> {
    const all = await this.loadModels()
    const disabled = this.options.accountPool?.disabledModelsFor(this.product.id)
    const listed = disabled === undefined || disabled.size === 0
      ? all
      : all.filter((model) => !disabled.has(model.id))

    return listed.map((model) => ({
      provider: this.product.id,
      id: model.id,
      // 倍率拼进 name（不是 description）：模型切换菜单只渲染 name。
      name: model.name,
      inputModalities: this.inputModalitiesFor(model),
    }))
  }

  async resolveModel(provider: string, model: string, _signal?: AbortSignal): Promise<LlmResolvedModelInfo> {
    const all = await this.loadModels()
    const entry = all.find((item) => item.id === model)
    const fallback = this.fallbackIndex.get(model)
    // ⚠️ name **不带倍率**：价格只属于选择列表语境。
    const bareName = fallback !== undefined ? fallback.name.replace(/ · .*$/, '') : model
    const resolved: LlmResolvedModelInfo = {
      provider,
      id: model,
      name: entry !== undefined ? entry.name.replace(/ · .*$/, '') : bareName,
      inputModalities: this.inputModalitiesFor(entry),
    }
    const contextWindow = entry?.contextWindow ?? fallback?.contextWindow
    // 未知模型不编造 context（宁可让调用方用默认值，也不报一个假窗口）。
    if (contextWindow !== undefined && contextWindow > 0) {
      resolved.context = { contextWindow }
    }
    // ⚠️ 远端非法值必须过滤（见 positiveMaxTokens）：不声明就让调用方用默认值。
    const maxTokens = positiveMaxTokens(entry?.maxTokens ?? fallback?.maxTokens)
    if (maxTokens !== undefined) resolved.defaultMaxTokens = maxTokens
    return resolved
  }

  async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    // 图片能力按**模型**判定。不能放宽成「总是接受」：调用方按适配器播报的
    // `inputModalities` 决定要不要把图片投影成文本占位符，声明支持就必须真支持。
    const imageRefs = new Map<string, unknown>()
    for (const message of options.messages) {
      if (Array.isArray(message.content)) collectImages(message.content, imageRefs)
    }
    const all = await this.loadModels()
    const entry = all.find((item) => item.id === options.model)
    let imageUrls: Map<string, string> | undefined
    if (imageRefs.size > 0) {
      if (!this.inputModalitiesFor(entry).includes('image')) {
        throw new LlmError(`raccoon: 模型 "${options.model}" 不支持图片输入`, 'UNSUPPORTED_CONTENT')
      }
      if (this.options.readImage === undefined) {
        throw new LlmError('raccoon: 图片输入需要附件服务', 'UNSUPPORTED_CONTENT')
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

    // 1. 取凭据（过期则先续期）
    let credential = await this.options.resolveCredential()
    if (credential === undefined || isRaccoonExpired(credential)) {
      await this.options.refresh()
      credential = await this.options.resolveCredential()
    }
    if (credential === undefined || credential.access_token.length === 0) {
      throw new LlmError('raccoon: no usable credential; log in first', 'MISSING_CREDENTIAL')
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
      // ⚠️ tools 必须真的下发到请求体**顶层**：Qoder/TRAE 都因漏发而让模型
      // 在正文里臆造 XML 工具调用。
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

    const headers = (): Record<string, string> => ({
      Accept: 'text/event-stream',
      'Content-Type': 'application/json',
      Authorization: `Bearer ${credential?.access_token ?? ''}`,
      'X-Org-Code': credential?.office_identity ?? '',
      'X-Raccoon-Language': 'zh',
      'X-Client-Platform': this.product.clientPlatform,
    })

    /** 发送一次 chat 请求。 */
    const send = async (): Promise<Response> => {
      try {
        return await this.fetchImpl(
          `${this.product.apiBase}${this.product.llmApiPrefix}/chat/completions`,
          {
            method: 'POST',
            headers: headers(),
            body: buildBody(),
            signal: options.signal,
          },
        )
      } catch (error) {
        if (options.signal?.aborted) throw error
        if (isTransportError(error)) {
          throw new LlmError(
            `raccoon: transport error: ${error instanceof Error ? error.message : String(error)}`,
            'TRANSPORT',
            { cause: error as Error },
          )
        }
        throw error
      }
    }

    // 2. 发送请求（账号级失败自动换号，试完所有候选才报错）。
    //
    // ## 换号语义（对齐用户自写的 `xiaohuanxiong2api/raccoon-gateway.js`，实测判据）
    //
    // - **积分耗尽**（HTTP 402/403，或其他 4xx + 额度文案）→ 把该账号在该模型上
    //   标记到 UTC+8 当日 24:00（积分按自然日结算/发放），换下一个账号重试；
    // - **限流**（HTTP 429）→ 短冷却标记后换号；
    // - **401** → 先刷新当前账号（access token 自然过期是最常见原因，不能据此
    //   判定账号失效），仍失败则弃用该号换下一个；
    // - 其余（400 无额度文案、5xx…）与账号无关，换号也解决不了，原样抛出。
    //
    // ⚠️ 额度/限流标记落在 `modelRateLimits`（账号 × 模型）：选号时
    // `getAvailableAccount` 自动跳过未到期的标记，到期由 `sweepExpiredRateLimits`
    // 清理 —— 「当天锁」复用既有存储，不需要新的状态形态。
    //
    // ⚠️ 已试过的账号必须排除（`tried`）：池按手动顺序取「第一个可用」，
    // 刚失败的账号往往仍是第一，不排除就会原地打转、换号形同虚设。
    const tried = new Set<string>()
    for (;;) {
      let response = await send()
      let errorText = response.ok ? '' : await response.text().catch(() => '')

      if (!response.ok && response.status === 401) {
        // 凭证失效：先刷新当前账号再重试一次。
        let refreshed: RaccoonCredential | undefined
        try {
          await this.options.refresh()
          refreshed = await this.credentialOfAccount(currentAccountId)
        } catch (error) {
          // 刷新失败不致命：换号仍有机会，单个账号故障不该让整轮陪葬。
          console.warn(`[raccoon] 刷新账号 ${currentAccountId || '(current)'} 凭据失败，改用换号重试：${String(error)}`)
        }
        if (refreshed !== undefined && refreshed.access_token.length > 0) {
          credential = refreshed
          response = await send()
          errorText = response.ok ? '' : await response.text().catch(() => '')
        }
      }

      if (response.ok) {
        // ⚠️ 业务失败也可能以 HTTP 200 + SSE 内嵌错误帧返回，由 consumeOpenAiSse 处理
        //（流中途的错误不换号：此时可能已向客户端产出内容，重放会造成重复输出）。
        yield* consumeOpenAiSse(response, { signal: options.signal }, {
          label: 'raccoon',
          firstTokenTimeoutMs: resolveFirstTokenTimeoutMs(),
          chunkTimeoutMs: resolveChunkTimeoutMs(),
        })
        return
      }

      const quotaLike = response.status === 402 || response.status === 403
        || (response.status >= 400 && looksLikeQuotaError(errorText))
      const rateLimited = response.status === 429
      const authFailed = response.status === 401
      if (!quotaLike && !rateLimited && !authFailed) {
        throw new LlmError(`raccoon: ${errorDetail(errorText)}`, httpErrorCode(response.status), { status: response.status })
      }

      const pool = this.options.accountPool
      if (pool === undefined) {
        // 无账号池：无从换号，保持原有单账号行为。
        throw new LlmError(`raccoon: ${errorDetail(errorText)}`, httpErrorCode(response.status), { status: response.status })
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
          `raccoon: 所有账号均额度不足、受限或凭证失效（最后错误：${errorDetail(errorText)}）`,
          quotaLike ? 'QUOTA_EXCEEDED' : (rateLimited ? 'RATE_LIMIT' : 'AUTH'),
          { status: response.status },
        )
      }
      credential = next.credential as RaccoonCredential
      currentAccountId = next.entry.id
      // 登记实际用上的账号：定向续期（wiringRefresh）与用量记录都以它为准。
      recordCurrentAccount(this.product.id, currentAccountId)
      if (isRaccoonExpired(credential)) {
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
  private async credentialOfAccount(accountId: string): Promise<RaccoonCredential | undefined> {
    if (this.options.accountPool !== undefined && accountId !== '') {
      const resolved = await this.options.accountPool.resolveCredentialForAccount(accountId)
      if (resolved !== undefined) return resolved as RaccoonCredential
    }
    return await this.options.resolveCredential()
  }
}

/** 首 token 超时（毫秒）；可用环境变量覆盖（与其余适配器同约定）。 */
function resolveFirstTokenTimeoutMs(): number {
  const raw = Number(process.env.ALL_PROXY_RACCOON_FIRST_TOKEN_TIMEOUT_MS)
  return Number.isFinite(raw) && raw > 0 ? raw : 120_000
}

/** chunk 间隔超时（毫秒）。 */
function resolveChunkTimeoutMs(): number {
  const raw = Number(process.env.ALL_PROXY_RACCOON_CHUNK_TIMEOUT_MS)
  return Number.isFinite(raw) && raw > 0 ? raw : 120_000
}
