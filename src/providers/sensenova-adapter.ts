/**
 * SenseNova（商汤）LLM 适配器。
 *
 * ## 与既有 provider 的关系
 *
 * SenseNova 的推理端点是**标准 OpenAI 兼容**的
 * （`POST /v1/chat/completions`，实测标准 SSE + `reasoning_content`），
 * 故 OpenAI 协议层（消息序列化 / SSE 消费 / 错误归类）**完全复用**
 * `shared/openai-compat.ts` —— 与 Qoder / Cline 同做法。
 *
 * 与其余 10 个 provider 的**根本差异**是凭据：SenseNova 用**静态 API Key**
 * （`Bearer sk-...`），没有登录、没有 refresh、也就没有「凭据过期」。
 * 因此本适配器**不实现** 401→续期 的路径（静态 key 续期毫无意义），
 * 401 一律按「这把 key 失效」处理：标记后换下一把。
 *
 * ## 换号语义（本 provider 的核心，用户明确要求）
 *
 * > 「K3 模型经常容易 429，遇到 429 就轮询，没遇到就继续。」
 *
 * 落地为：
 * - **没遇到错误 → 一直用同一个（排在最前的）账号**。选号走
 *   `AccountPool.getAvailableAccount`，它按**用户手动顺序**取第一个可用账号
 *   （来源约定：不得按限流重置时间重排），故正常情况天然「钉住」第一把 key。
 * - **命中 429（tpm/rpm 限流）→ 把该账号在该模型上标记短冷却，换下一把
 *   key 重试**；顺序尝试，失败的账号进 `tried` 排除集，绝不原地打转。
 * - **配额类错误（402/403 或额度文案）→ 同样换号**（额度按自然日结算，
 *   标记到 UTC+8 当日 24:00）。
 * - **全部账号都失败 → 抛出**，错误里带上「最后错误」与已试账号数，
 *   而不是静默重试。
 *
 * ⚠️ **为什么不重试同一个账号**：429 是账号级限流（`ModelAccountTpm/Rpm
 * RateLimitExceeded`，实测三把 key 里两把会 429、一把正常），同一把 key
 * 立即重试只会再次 429，白白拖慢失败反馈。换号才是有效的恢复手段 ——
 * 这也正是用户要「轮询」的原因。
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
import { looksLikeQuotaError } from '../shared/account-failover.js'
import { nextUtc8DayStartMs } from '../shared/model-queue.js'
import { recordCurrentAccount } from './current-account.js'
import { SENSENOVA, SENSENOVA_REQUEST_TIMEOUT_MS, type SensenovaFallbackModel, type SensenovaProduct } from './sensenova-product.js'
import {
  isSensenovaCredentialUsable,
  parseSensenovaModels,
  sensenovaChatUrl,
  sensenovaModelsUrl,
  sensenovaToken,
  type SensenovaCredential,
  type SensenovaRemoteModel,
} from './sensenova.js'
import type { AccountPool } from '../pool/account-pool.js'

/** 本适配器注册的 provider 路由名（等价于 `SENSENOVA.id`）。 */
export const PROVIDER = 'sensenova'

/**
 * 上游认可的思考档位白名单。
 *
 * ⚠️ 来源是上游**自己的报错文案**（2026-10-23 实测，`reasoning_effort` 传非法值）：
 * > `field ReasoningEffort invalid, should be one of:
 * >  none, minimal, low, medium, high, xhigh, max, ultra`
 *
 * 它证明两件事：① 上游**真的消费**这个参数（不是忽略）；② 非法值直接 **400**。
 * 故透传前必须过白名单 —— 超出范围时**静默丢弃**，不能照发：档位不是请求的
 * 必要条件，为用户选了个上游不认识的档位而整条请求失败是明确的优先级倒置。
 */
export const SENSENOVA_REASONING_EFFORTS: ReadonlySet<string> = new Set([
  'none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra',
])

/** 兜底表条目转远端形状。 */
function fallbackToRemote(model: SensenovaFallbackModel): SensenovaRemoteModel {
  return {
    id: model.id,
    name: model.name,
    contextWindow: model.contextWindow,
    maxTokens: model.maxTokens,
    supportsImage: model.supportsImage,
  }
}

/** {@link SensenovaAdapter} 的构造选项。 */
export interface SensenovaAdapterOptions {
  /** 解析当前可用凭据（首个可用账号；静态 key 无续期）。 */
  resolveCredential: () => Promise<SensenovaCredential | undefined>
  /**
   * 刷新凭据的占位（静态 key 无 refresh 端点）。
   *
   * 保留此字段只为与其余适配器**构造签名一致**；实现应传 no-op。
   * 本适配器**不会**调用它（静态 key 没有可续期的东西）。
   */
  refresh?: () => Promise<void>
  /** 拉取远端模型目录；失败时适配器回退兜底表。 */
  fetchRemoteModels?: () => Promise<SensenovaRemoteModel[]>
  /** 读取图片附件的原始字节（内联为 data URL 用）。 */
  readImage?: (attachment: unknown) => Promise<{ data: Uint8Array; mediaType: string } | undefined>
  /** 账号池（用于换号重试与模型黑名单）。 */
  accountPool?: AccountPool
  /** 产品配置；默认 {@link SENSENOVA}。 */
  product?: SensenovaProduct
  /** 注入的 fetch（测试用）。 */
  fetchImpl?: typeof fetch
}

/** SenseNova 模型适配器。 */
export class SensenovaAdapter extends LlmAdapter {
  private readonly product: SensenovaProduct
  private readonly fetchImpl: typeof fetch
  /** 兜底模型索引（id → 条目）。 */
  private readonly fallbackIndex: ReadonlyMap<string, SensenovaFallbackModel>
  /** 远端模型缓存；未拉取时为 undefined。 */
  private remoteModels: SensenovaRemoteModel[] | undefined

  /**
   * 丢弃已缓存的远端模型目录，供管理端「刷新模型目录」按钮强制重拉。
   * 见 `src/providers/llm-adapter.ts` 与 `wiring.ts` 的 `refreshModelCatalog`。
   */
  override invalidateModelCatalog(): void {
    this.remoteModels = undefined
  }

  constructor(private readonly options: SensenovaAdapterOptions) {
    super()
    this.product = options.product ?? SENSENOVA
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
   * 而那条路径拿不到展示名，会退化成裸 id。
   */
  listAllModels(): readonly { id: string; name: string }[] {
    const source = this.remoteModels ?? this.product.fallbackModels.map(fallbackToRemote)
    return source.map((model) => ({ id: model.id, name: model.name }))
  }

  /**
   * 取（并缓存）远端模型目录；失败时回退兜底表。
   *
   * ⚠️ **远端 `name` 对 SenseNova 是无用的回显**：实测 `GET /v1/models` 返回
   * `{"id":"deepseek-v4-flash","name":"deepseek-v4-flash"}` —— `name` 逐字等于
   * `id`，不是给人看的展示名。若直接用，模型选择器会显示 `deepseek-v4.1-flash`
   * 这种裸 id，而兜底表里明明写着 `DeepSeek-V4.1-Flash`。
   * 故这里做一层**补名**：远端 `name` 与 `id` 相同时，改用兜底表的美化名；
   * 兜底表也没有该模型（上游新增）时才退回裸 id（此时确实没有更好的信息）。
   * 远端若给出**不同的** `name`（将来上游改了），以远端为准。
   */
  private async loadModels(): Promise<SensenovaRemoteModel[]> {
    if (this.remoteModels !== undefined) return this.remoteModels
    if (this.options.fetchRemoteModels !== undefined) {
      try {
        const fetched = await this.options.fetchRemoteModels()
        if (fetched.length > 0) {
          this.remoteModels = fetched.map((model) => this.enrichDisplayName(model))
          return this.remoteModels
        }
      } catch {
        // 远端失败静默回退兜底表：模型目录是展示信息，不该让整个 provider 报错。
      }
    }
    const fallback = this.product.fallbackModels.map(fallbackToRemote)
    this.remoteModels = fallback
    return fallback
  }

  /** 远端 `name === id`（纯回显）时，用兜底表的美化名覆盖（见 {@link loadModels}）。 */
  private enrichDisplayName(model: SensenovaRemoteModel): SensenovaRemoteModel {
    if (model.name !== model.id) return model
    const fallback = this.fallbackIndex.get(model.id)
    if (fallback === undefined) return model
    return { ...model, name: fallback.name }
  }

  private inputModalitiesFor(model: SensenovaRemoteModel | undefined): readonly ('text' | 'image')[] {
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
      name: model.name,
      inputModalities: this.inputModalitiesFor(model),
    }))
  }

  async resolveModel(provider: string, model: string, _signal?: AbortSignal): Promise<LlmResolvedModelInfo> {
    const all = await this.loadModels()
    const entry = all.find((item) => item.id === model)
    const fallback = this.fallbackIndex.get(model)
    const resolved: LlmResolvedModelInfo = {
      provider,
      id: model,
      // ⚠️ name 不带任何后缀：这里是「会话记录」语境，价格/能力标注只属于
      // 选择列表（与 raccoon/cline 的 resolveModel 约定一致）。
      name: entry?.name ?? fallback?.name ?? model,
      inputModalities: this.inputModalitiesFor(entry),
    }
    const contextWindow = entry?.contextWindow ?? fallback?.contextWindow
    // 未知模型不编造 context（宁可让调用方用默认值，也不报一个假窗口）。
    if (contextWindow !== undefined && contextWindow > 0) {
      resolved.context = { contextWindow }
    }
    const maxTokens = entry?.maxTokens ?? fallback?.maxTokens
    if (maxTokens !== undefined && maxTokens > 0) resolved.defaultMaxTokens = maxTokens
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
        throw new LlmError(`sensenova: 模型 "${options.model}" 不支持图片输入`, 'UNSUPPORTED_CONTENT')
      }
      if (this.options.readImage === undefined) {
        throw new LlmError('sensenova: 图片输入需要附件服务', 'UNSUPPORTED_CONTENT')
      }
      // 保留**空 Map**（而非 undefined）：图片存在但全部读取失败时，空 Map
      // 仍会让 userContentParts 产出 [image unavailable] 占位符。
      imageUrls = new Map()
      for (const [id, ref] of imageRefs) {
        const image = await this.options.readImage(ref)
        if (image === undefined) continue
        imageUrls.set(id, `data:${image.mediaType};base64,${Buffer.from(image.data).toString('base64')}`)
      }
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
      // ⚠️ **必须显式索取流式 usage**（真实缺陷，用户报障 2026-10-13
      // 「为什么没有透传使用量」）：SenseNova 上游**默认不在流末尾发 usage 帧**，
      // 只有请求带 `stream_options.include_usage: true` 时，才会在 `[DONE]` 前
      // 补一个 `{"choices":[],"usage":{prompt_tokens,completion_tokens,...}}` 帧。
      // 不带它 → 消费层（shared/openai-compat.ts）收不到 `data.usage` → 用量
      // 记录里 Token 恒为 0（截图里 sensenova/kimi-k3 一行「0」就是这个原因）。
      // 实测：不带 → 无 usage 帧；带上 → 末尾出现 usage 帧。
      stream_options: { include_usage: true },
      ...options.maxTokens !== undefined ? { max_tokens: options.maxTokens } : {},
      ...options.temperature !== undefined ? { temperature: options.temperature } : {},
      ...options.stop !== undefined && options.stop.length > 0 ? { stop: options.stop } : {},
      // 思考等级：只发上游认的档位（见 {@link SENSENOVA_REASONING_EFFORTS}
      // 的实测依据）。白名单外的值静默丢弃，避免变成一条 400。
      ...SENSENOVA_REASONING_EFFORTS.has(options.reasoningEffort ?? '')
        ? { reasoning_effort: options.reasoningEffort }
        : {},
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
    const body = buildBody()

    /** 用一把 key 发送一次 chat 请求。 */
    const send = async (token: string): Promise<Response> => {
      try {
        return await this.fetchImpl(sensenovaChatUrl(this.product), {
          method: 'POST',
          headers: {
            Accept: 'text/event-stream',
            'Content-Type': 'application/json',
            Authorization: `Bearer ${token}`,
          },
          body,
          signal: options.signal,
        })
      } catch (error) {
        if (options.signal?.aborted) throw error
        if (isTransportError(error)) {
          throw new LlmError(
            `sensenova: transport error: ${error instanceof Error ? error.message : String(error)}`,
            'TRANSPORT',
            { cause: error as Error },
          )
        }
        throw error
      }
    }

    const pool = this.options.accountPool

    /**
     * 选一把 key（返回 token 与账号 id）。
     *
     * 有账号池时走 {@link AccountPool.getAvailableAccount}（按手动顺序取第一个
     * 未被排除、未被限流标记的账号）—— 这正是「没遇到错误就一直用同一个」的
     * 实现：只要第一把 key 没被标记，它每次都会被选中。
     *
     * 无账号池时退化为 `resolveCredential()`（单凭据情形，无从换号）。
     */
    const pick = async (tried: ReadonlySet<string>): Promise<{ token: string; accountId: string } | undefined> => {
      if (pool !== undefined) {
        const next = await pool.getAvailableAccount(this.product.id, options.model, tried)
        if (next === null) return undefined
        const credential = next.credential as SensenovaCredential
        const token = sensenovaToken(credential)
        if (token.length === 0) return undefined
        recordCurrentAccount(this.product.id, next.entry.id)
        return { token, accountId: next.entry.id }
      }
      const credential = await this.options.resolveCredential()
      if (!isSensenovaCredentialUsable(credential)) return undefined
      return { token: sensenovaToken(credential), accountId: '' }
    }

    // ── 发送并处理：账号级失败换号；全部冷却时等到最早解禁再继续（「一直轮询」）──
    //
    // 语义（用户 2026-10-13 明确要求）：
    // 1. 正常情况**钉住**手动顺序的第一个账号（无错误不换号）；
    // 2. 命中 429 → 给该账号写 **5 秒**短冷却（tpm/rpm 是每分钟窗口），换下一把；
    // 3. 轮到最后一把握了还全 429 → **不直接报错**，等到最早那把解禁再继续，
    //    直到成功或超出预算（默认 5 分钟）—— 这就是「不通就一直轮询」；
    // 4. 配额类（402/403）锁到 UTC+8 当日 24:00、401 不写标记：等它们远超预算，
    //    故直接如实报错（等待无意义）。
    const budgetMs = resolveRotateBudgetMs()
    const startedAt = Date.now()
    const deadline = startedAt + budgetMs
    const tried = new Set<string>()
    let lastErrorText = ''
    let lastStatus = 0
    let lastKind: 'rate' | 'quota' | 'auth' = 'rate'

    for (;;) {
      // 选号。无可选候选（都被 tried 排除，或正处于冷却）时见下方分支。
      const picked = await pick(tried)
      if (picked === undefined) {
        const enabledCount = pool === undefined
          ? 0
          : pool.listAccountsByProvider(this.product.id).filter((a) => a.enabled).length
        if (enabledCount === 0) {
          throw new LlmError(
            'sensenova: 没有可用账号（请先在管理端粘贴 API Key）',
            'MISSING_CREDENTIAL',
          )
        }
        // 只剩「冷却中」一种可能：等到最早一把解禁再继续（除非超出预算）。
        const wait = pool === undefined ? 0 : shortestCooldownMs(pool, this.product.id, options.model)
        const remaining = deadline - Date.now()
        if (wait > 0 && wait <= remaining) {
          await sleep(wait, options.signal)
          tried.clear()
          continue
        }
        // 等待无望（配额锁到明天 >> 预算，或本轮全部 401 无标记）：如实报错。
        const elapsedSec = Math.round((Date.now() - startedAt) / 1000)
        throw new LlmError(
          `sensenova: 所有账号均不可用（已轮询 ${elapsedSec}s；最后错误：${errorDetail(lastErrorText)}）`,
          lastKind === 'quota' ? 'QUOTA_EXCEEDED' : (lastKind === 'auth' ? 'AUTH' : 'RATE_LIMIT'),
          { status: lastStatus },
        )
      }

      let response = await send(picked.token)
      let errorText = response.ok ? '' : await response.text().catch(() => '')

      if (response.ok) {
        // ⚠️ 业务失败也可能以 HTTP 200 + SSE 内嵌错误帧返回，由 consumeOpenAiSse
        // 处理（流中途的错误不换号：此时可能已向客户端产出内容，重放会造成重复输出）。
        yield* consumeOpenAiSse(response, { signal: options.signal }, {
          label: 'sensenova',
          firstTokenTimeoutMs: resolveFirstTokenTimeoutMs(),
          chunkTimeoutMs: resolveChunkTimeoutMs(),
        })
        return
      }

      // 账号级失败判定。
      const quotaLike = response.status === 402 || response.status === 403
        || (response.status >= 400 && looksLikeQuotaError(errorText))
      const rateLimited = response.status === 429
      // 401:静态 key 失效（没有续期可言）。归为目标账号失效，换下一把。
      const authFailed = response.status === 401

      if (!quotaLike && !rateLimited && !authFailed) {
        // 与账号无关（400 请求格式错、5xx 服务端故障…）：换号解决不了，原样抛。
        throw new LlmError(
          `sensenova: ${errorDetail(errorText)}`,
          httpErrorCode(response.status),
          { status: response.status },
        )
      }

      if (pool === undefined) {
        // 无账号池：无从换号，保持单账号行为、如实报错。
        throw new LlmError(
          `sensenova: ${errorDetail(errorText)}`,
          httpErrorCode(response.status),
          { status: response.status },
        )
      }

      // 标记失败账号，让后续选号自动跳过它。
      // - 限流（429）：**5 秒**短冷却（tpm/rpm 是每分钟窗口，标太久会让 key 白白闲置）；
      // - 配额（402/403/额度文案）：按自然日锁到 UTC+8 当日 24:00；
      // - 401：不作限流标记（key 失效与限流语义不同），仅排除本次请求。
      if (picked.accountId !== '' && !authFailed) {
        const resetAt = rateLimited
          ? Date.now() + resolveRateLimitCooldownMs()
          : nextUtc8DayStartMs()
        await pool.updateModelRateLimit(picked.accountId, options.model, resetAt)
      }

      // 记住最后一次账号级失败，供「围全部试完」或「预算耗尽」时的错误文案使用。
      lastErrorText = errorText
      lastStatus = response.status
      lastKind = quotaLike ? 'quota' : (rateLimited ? 'rate' : 'auth')

      if (picked.accountId !== '') tried.add(picked.accountId)
      // 回到循环顶部：pick 自动跳过已标记/已试的账号；全试完则进入等待-重试分支。
    }
  }
}

/** 首 token 超时（毫秒）；可用环境变量覆盖（与其余适配器同约定）。 */
function resolveFirstTokenTimeoutMs(): number {
  const raw = Number(process.env.ALL_PROXY_SENSENOVA_FIRST_TOKEN_TIMEOUT_MS)
  return Number.isFinite(raw) && raw > 0 ? raw : SENSENOVA_REQUEST_TIMEOUT_MS
}

/** chunk 间隔超时（毫秒）。 */
function resolveChunkTimeoutMs(): number {
  const raw = Number(process.env.ALL_PROXY_SENSENOVA_CHUNK_TIMEOUT_MS)
  return Number.isFinite(raw) && raw > 0 ? raw : SENSENOVA_REQUEST_TIMEOUT_MS
}

/**
 * 429 限流的冷却时长（毫秒）。
 *
 * ⚠️ **刻意不同于** `shared/account-failover.ts` 的 `RATE_LIMIT_FALLBACK_MS`
 * （30 秒，raccoon/loomy 在用）：SenseNova 的 tpm/rpm 是**每分钟**窗口，
 * 且用户明确要求「5 秒冷却，不行就切下一个，不通就一直轮询」。用 30 秒会
 * 让一把其实几秒后就恢复的 key 白白闲置。该常量只影响 sensenova。
 *
 * 可用环境变量覆盖（测试用短值；与其余超时同约定）。
 */
function resolveRateLimitCooldownMs(): number {
  const raw = Number(process.env.ALL_PROXY_SENSENOVA_RATE_LIMIT_COOLDOWN_MS)
  return Number.isFinite(raw) && raw > 0 ? raw : 5_000
}

/**
 * 「一直轮询」的总时长上限（毫秒）。
 *
 * 用户要求「不通就一直轮询」，但**不能真的无限**：请求方（harness / HTTP 客户端）
 * 有自己的超时，且 `options.signal` 一旦中止就必须立刻退出。故给一个宽裕但有限的
 * 预算（默认 5 分钟，可用环境变量覆盖）。预算耗尽仍全 429 才报错 —— 那时错误里
 * 带上「已轮询多久 / 最近的限流原因」，便于用户判断。
 *
 * 单次等待不会超过冷却时长（~5s），所以预算通常能覆盖几十轮换号。
 */
function resolveRotateBudgetMs(): number {
  const raw = Number(process.env.ALL_PROXY_SENSENOVA_ROTATE_BUDGET_MS)
  return Number.isFinite(raw) && raw > 0 ? raw : 5 * 60 * 1000
}

/**
 * 可被 `signal` 中止的等待。
 *
 * ⚠️ **必须响应 abort**：若客户端断开，`stream()` 应尽快退出，而不是傻等
 * 冷却结束再发一个已经没人要的请求。中止时抛原因为 `signal.reason` 的异常
 * （与 `shared/sse.ts` 的约定一致）。
 */
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted === true) {
      reject(signal.reason ?? new Error('aborted'))
      return
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = (): void => {
      clearTimeout(timer)
      reject(signal?.reason ?? new Error('aborted'))
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

/**
 * 该 provider 全部**启用账号**里，某模型最早解除冷却所剩的毫秒数。
 *
 * 供「全部冷却 → 等到最早一把解禁再继续」的轮询分支使用。返回 0 表示
 * 「没有还在冷却的启用账号」（不该走到等待分支，属于异常态，调用方按无望处理）。
 *
 * ⚠️ 只看**启用账号**：停用账号不参与选号（`getAvailableAccount` 会跳过），
 * 等它的冷却毫无意义。
 */
function shortestCooldownMs(
  pool: NonNullable<SensenovaAdapterOptions['accountPool']>,
  provider: string,
  modelId: string,
): number {
  const now = Date.now()
  let earliest = 0
  for (const account of pool.listAccountsByProvider(provider)) {
    if (!account.enabled) continue
    const resetAt = account.modelRateLimits?.[modelId]
    if (typeof resetAt !== 'number' || resetAt <= 0 || resetAt <= now) continue
    const wait = resetAt - now
    if (earliest === 0 || wait < earliest) earliest = wait
  }
  return earliest
}

/**
 * 远端目录拉取（供 wiring 注入）。
 *
 * 用首个可用账号的 key 调 `GET /v1/models`；解析失败或非 2xx 抛错，
 * 由适配器回退兜底表。
 */
export async function fetchSensenovaRemoteModels(
  pool: AccountPool,
  product: SensenovaProduct,
  fetcher: typeof fetch = fetch,
): Promise<SensenovaRemoteModel[]> {
  const account = await pool.getAvailableAccount(product.id, '')
  if (account === null) throw new Error('sensenova: 没有可用账号，无法拉取远端目录')
  const token = sensenovaToken(account.credential as SensenovaCredential)
  if (token.length === 0) throw new Error('sensenova: 凭据缺 API Key')
  const response = await fetcher(sensenovaModelsUrl(product), {
    method: 'GET',
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
    signal: AbortSignal.timeout(SENSENOVA_REQUEST_TIMEOUT_MS),
  })
  if (!response.ok) throw new Error(`sensenova 远端目录 HTTP ${response.status}`)
  const models = parseSensenovaModels(await response.json() as unknown)
  if (models.length === 0) throw new Error('sensenova 远端目录为空，使用兜底表')
  return models
}
