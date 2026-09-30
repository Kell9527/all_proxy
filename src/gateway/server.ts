/**
 * 网关 HTTP 服务。
 *
 * 端点：
 * | 路径 | 说明 |
 * |---|---|
 * | `POST /v1/chat/completions` | OpenAI 兼容（流式 / 非流式） |
 * | `POST /v1/messages` | Anthropic 兼容（由本服务翻译，见 `anthropic-protocol.ts`） |
 * | `GET  /v1/models` | OpenAI 模型列表（带 provider 前缀） |
 * | `GET  /health` | 健康检查（**不消耗上游额度**） |
 *
 * ⚠️ **`GET /health` 绝不发起上游请求**：规格 `gateway-api` 明确要求它不消耗
 * 额度。它只读内存里的账号池状态。
 */

import { randomBytes } from 'node:crypto'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AccountPool } from '../pool/account-pool.js'
import type { ProviderRegistry } from '../providers/registry.js'
import { ModelResolver, listAvailableModels, type ModelScope } from './model-resolver.js'
import { mapLlmErrorCode, openAiErrorBody, gatewayError, type GatewayError } from './errors.js'
import { collectOpenAiResponse, openAiModelList, streamOpenAiSse, type OpenAiStreamObserver } from './openai-protocol.js'
import { anthropicErrorBody, collectAnthropicResponse, streamAnthropicSse, translateAnthropicRequest } from './anthropic-protocol.js'
import { currentAccountIdFor } from '../providers/wiring.js'
import { readSystemText } from '../shared/message-shape.js'
import { LlmError, type GenerateOptions, type RequestMessage, type StreamChunk, type ToolSchema } from '../shared/llm.js'
import type { LogStage } from '../usage/logger.js'
import { serveStatic } from './static-files.js'

/**
 * 请求阶段日志的最小接口（与 `RotatingLogger` 结构兼容）。
 *
 * 用结构化类型而不是直接 import 类：网关只关心「能按请求写日志」，
 * 不关心日志写到文件还是内存——测试替身因此不需要实现 RotatingLogger 的
 * 全部方法（size / backupPaths …）。
 */
export interface RequestStageLogger {
  forRequest(requestId: string): {
    info(stage: LogStage, message: string, fields?: Record<string, unknown>): void
    warn(stage: LogStage, message: string, fields?: Record<string, unknown>): void
    error(stage: LogStage, message: string, fields?: Record<string, unknown>): void
  }
}

/**
 * 一次已通过鉴权的请求所携带的调用方信息。
 *
 * 网关**不关心**它从哪来（API Key / 管理凭据 / 测试替身），只消费这三个字段。
 */
export interface CallerContext {
  /** 调用方标识（如 API Key 的 id）。用于日志与用量归属。 */
  id: string
  /** 调用方名称（可读，供日志）。 */
  name: string
  /** 授权范围；省略表示不限制。 */
  scope?: ModelScope
}

/**
 * 入站鉴权结果。
 *
 * `ok: false` 时错误由鉴权方给出（可能带 `retryAfterMs`）。
 */
export type AuthResult =
  | { ok: true; caller: CallerContext }
  | { ok: false; error: GatewayError }

/** 服务配置。 */
export interface GatewayOptions {
  registry: ProviderRegistry
  pool: AccountPool
  /** 监听端口。 */
  port: number
  /** 监听地址。 */
  host: string
  /**
   * 入站鉴权。省略表示**不鉴权**（仅用于测试与纯本机场景）。
   *
   * ⚠️ 签名从「返回错误」升级为「返回调用方上下文」：key 级 provider/模型
   * 白名单必须让网关知道**是谁在调用**，只回一个「通过/不通过」无法实现范围过滤。
   */
  authenticate?: (req: IncomingMessage) => AuthResult | Promise<AuthResult>
  /**
   * 管理 API 处理器（`/api/*`）。
   *
   * 返回 `true` 表示已处理。它自带**独立**的管理口令鉴权，
   * 因此必须在入站 API Key 鉴权**之前**分流 —— 否则管理端请求会先被
   * 「必须是有效 API Key」拦下，管理员永远进不来。
   */
  admin?: (req: IncomingMessage, res: ServerResponse, url: URL) => Promise<boolean>
  /**
   * 用量与访问记录钩子。省略则不记录。
   *
   * 钩子**不得**抛错影响响应（网关内部已兜底），也**不得**记录消息正文。
   */
  onRequest?: (record: RequestRecord) => void
  /**
   * 请求阶段日志（与用量记录共享请求标识）。省略则不写请求日志。
   *
   * 与 `onRequest` 的分工：用量回答「花了多少」，日志回答「卡在哪」。
   * 两者共享同一个 `requestId`，于是「用量库里的那条失败记录」与
   * 「日志里的那个中断阶段」可以互相定位（规格 `usage-tracking`）。
   */
  requestLog?: RequestStageLogger
  /**
   * 管理端静态资源目录（生产态由本进程托管，design D7）。
   *
   * 仅对**非** `/v1/*`、`/api/*` 的 GET 生效；SPA 路由回退到 index.html。
   */
  staticRoot?: string
  /** 日志。 */
  logger?: { info(m: string): void; warn(m: string): void; error(m: string): void }
}

/**
 * 一次请求的元信息（供用量记录）。
 *
 * ⚠️ **刻意不含任何消息正文**：prompt / 模型输出可能含用户隐私，
 * 用量统计只需要「谁、用了哪个模型、花了多少 token、成功与否」。
 */
export interface RequestRecord {
  /** 请求标识（同时写入运行日志）。 */
  requestId: string
  /** 调用方标识；未鉴权时为 `anonymous`。 */
  callerId: string
  callerName: string
  /** 对外模型 ref；解析失败时为请求里的原始值。 */
  model: string
  provider?: string
  /** 上游原始模型 id。 */
  upstreamModel?: string
  stream: boolean
  status: number
  /** 成功时为空。 */
  errorCode?: string
  /** 输入 / 输出 token（失败或未知时为 0）。 */
  inputTokens: number
  outputTokens: number
  /** 缓存命中（读 / 写）token。 */
  cacheReadTokens: number
  cacheWriteTokens: number
  /** 总耗时（毫秒）。 */
  durationMs: number
  /** 首字节耗时（毫秒）；未产出任何内容时省略。 */
  firstByteMs?: number
  /** 结束原因（`stop` / `length` / `tool_calls` …）。 */
  finishReason?: string
  /** 实际完成该请求的账号 id（轮换后可能与池默认账号不同）。 */
  accountId?: string
}

/** 请求体上限（字节）。防止超大 body 打满内存。 */
const MAX_BODY_BYTES = 32 * 1024 * 1024

/**
 * 对外协议风味。
 *
 * OpenAI 与 Anthropic 共享同一条处理骨架（解析 → 鉴权 → 模型解析 → 上游流 →
 * 用量记录），差异只在「请求翻译」与「响应/错误形状」—— 全部收拢到按 flavor
 * 分派的几个小函数里，避免两份 150 行的近似代码各自演化出不同的 bug。
 */
type ProtocolFlavor = 'openai' | 'anthropic'

/** 按协议风味写错误响应。 */
function sendError(res: ServerResponse, error: GatewayError, flavor: ProtocolFlavor): void {
  if (flavor === 'anthropic') {
    const body = JSON.stringify(anthropicErrorBody(error))
    const headers: Record<string, string> = { 'Content-Type': 'application/json; charset=utf-8' }
    if (error.retryAfterMs !== undefined) {
      headers['Retry-After'] = String(Math.max(1, Math.ceil(error.retryAfterMs / 1000)))
    }
    res.writeHead(error.status, headers)
    res.end(body)
    return
  }
  sendOpenAiError(res, error)
}

/** 读取并解析 JSON 请求体。 */
async function readJsonBody(req: IncomingMessage): Promise<{ ok: true; value: Record<string, unknown> } | { ok: false; error: GatewayError }> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    const buf = chunk as Buffer
    size += buf.length
    if (size > MAX_BODY_BYTES) {
      return { ok: false, error: gatewayError(413, 'invalid_request_error', '请求体过大') }
    }
    chunks.push(buf)
  }
  const text = Buffer.concat(chunks).toString('utf-8')
  if (text.trim().length === 0) return { ok: false, error: gatewayError(400, 'invalid_request_error', '请求体为空') }
  try {
    const parsed = JSON.parse(text) as unknown
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      return { ok: false, error: gatewayError(400, 'invalid_request_error', '请求体必须是 JSON 对象') }
    }
    return { ok: true, value: parsed as Record<string, unknown> }
  } catch {
    return { ok: false, error: gatewayError(400, 'invalid_request_error', '请求体不是合法 JSON') }
  }
}

/** 写一个 OpenAI 形状的错误响应。 */
function sendOpenAiError(res: ServerResponse, error: GatewayError): void {
  const body = JSON.stringify(openAiErrorBody(error))
  const headers: Record<string, string> = { 'Content-Type': 'application/json; charset=utf-8' }
  // 限流类错误带上 Retry-After（秒，向上取整），让客户端知道何时可重试。
  if (error.retryAfterMs !== undefined) {
    headers['Retry-After'] = String(Math.max(1, Math.ceil(error.retryAfterMs / 1000)))
  }
  res.writeHead(error.status, headers)
  res.end(body)
}

/** 生成一个短请求标识（贯穿运行日志与用量记录）。 */
function newRequestId(): string {
  return `req-${randomBytes(8).toString('hex')}`
}

/**
 * 把请求体里的 OpenAI 参数转成内部 `GenerateOptions`。
 *
 * ⚠️ **`tools` 必须原样透传**：适配器负责下发到上游请求体顶层（来源的
 * Qoder/TRAE 都因漏发而让模型臆造 XML 工具调用）。
 */
function buildGenerateOptions(
  body: Record<string, unknown>,
  provider: string,
  model: string,
  signal: AbortSignal,
): GenerateOptions {
  const options: GenerateOptions = {
    provider,
    model,
    messages: Array.isArray(body['messages']) ? body['messages'] as RequestMessage[] : [],
    signal,
  }
  // 顶层 system：认**字符串**与**内容块数组**两种形态，与 Anthropic 翻译层同口径。
  //
  // ⚠️ 早期只认字符串（真实缺陷，2026-09-29）：客户端用数组形式传 system 时，
  // 指令被**静默丢弃**，wire 首条不再是 system。WorkBuddy 强制要求
  // `messages[0]` 是 system，于是直接 400 `code 11128`，而该错误被上游
  // `displayMsg` 伪装成「请求被安全策略拦截」，与真实原因毫无关系。
  // 共用 `readSystemText` 可确保两条入站路径不会再各写一份而分叉。
  const system = readSystemText(body['system'])
  if (system !== undefined) options.system = system
  if (Array.isArray(body['tools']) && body['tools'].length > 0) {
    options.tools = (body['tools'] as Array<Record<string, unknown>>).flatMap((raw): ToolSchema[] => {
      // OpenAI 形状：{type:'function', function:{name, description, parameters}}
      const fn = raw['function'] as Record<string, unknown> | undefined
      if (fn === undefined || typeof fn['name'] !== 'string') return []
      return [{
        name: fn['name'],
        description: typeof fn['description'] === 'string' ? fn['description'] : '',
        parameters: typeof fn['parameters'] === 'object' && fn['parameters'] !== null
          ? fn['parameters'] as Record<string, unknown>
          : { type: 'object', properties: {} },
      }]
    })
  }
  const maxTokens = body['max_tokens'] ?? body['max_completion_tokens']
  if (typeof maxTokens === 'number' && Number.isSafeInteger(maxTokens) && maxTokens > 0) options.maxTokens = maxTokens
  if (typeof body['temperature'] === 'number') options.temperature = body['temperature']
  if (Array.isArray(body['stop'])) options.stop = (body['stop'] as unknown[]).filter((s): s is string => typeof s === 'string')
  else if (typeof body['stop'] === 'string') options.stop = [body['stop']]
  if (typeof body['reasoning_effort'] === 'string') options.reasoningEffort = body['reasoning_effort']
  return options
}

/** 把内部错误转成对外错误。 */
function toGatewayError(error: unknown): GatewayError {
  if (error instanceof LlmError) {
    const mapped = mapLlmErrorCode(error.code, error.failure.status)
    return { status: mapped.status, code: mapped.code, message: error.message }
  }
  const message = error instanceof Error ? error.message : String(error)
  return gatewayError(500, 'internal_error', message)
}

/** 创建网关 HTTP 服务（尚未监听）。 */
export function createGatewayServer(options: GatewayOptions): Server {
  const resolver = new ModelResolver(options.registry, options.pool)
  const logger = options.logger

  return createServer((req, res) => {
    void handle(req, res).catch((error: unknown) => {
      logger?.error(`[gateway] 未捕获异常: ${String(error)}`)
      if (!res.headersSent) sendOpenAiError(res, gatewayError(500, 'internal_error', '内部错误'))
      else res.end()
    })
  })

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://localhost')
    const path = url.pathname

    // ── 健康检查：**不鉴权、不触达上游** ──
    // 规格 access-control 明确豁免：未携带凭据时也要能读到最小存活信息
    // （否则监控探针必须先配一把 key，而探针通常只需要知道「进程活着吗」）。
    if (path === '/health' && req.method === 'GET') {
      sendJson(res, 200, healthPayload(options))
      return
    }

    // ── 管理 API：**独立**鉴权，必须先于 API Key 鉴权分流 ──
    if (path.startsWith('/api/') && options.admin !== undefined) {
      const handled = await options.admin(req, res, url)
      if (handled) return
    }

    // ── 管理端静态资源（同源托管；SPA 回退 index.html）──
    // ⚠️ 必须在 API Key 鉴权**之前**：浏览器加载页面时手里没有 API Key，
    // 页面本身若被 401 挡住，管理端就永远进不去（管理 API 另有口令保护）。
    if (options.staticRoot !== undefined && req.method === 'GET'
      && !path.startsWith('/v1/') && !path.startsWith('/api/')) {
      if (serveStatic(options.staticRoot, url.pathname + url.search, res)) return
    }

    // ── 入站鉴权 ──
    let caller: CallerContext = ANONYMOUS_CALLER
    if (options.authenticate !== undefined) {
      const result = await options.authenticate(req)
      if (!result.ok) {
        // 错误形状跟随端点协议：Anthropic 客户端的 SDK 按自己的信封解析错误，
        // 收到 OpenAI 形状会把 401 误报成「未知错误」。
        sendError(res, result.error, path === '/v1/messages' ? 'anthropic' : 'openai')
        return
      }
      caller = result.caller
    }

    // ── 模型列表 ──
    if (path === '/v1/models' && req.method === 'GET') {
      const models = await listAvailableModels(options.registry, options.pool, caller.scope)
      sendJson(res, 200, openAiModelList(models))
      return
    }

    // ── Chat Completions ──
    if (path === '/v1/chat/completions' && req.method === 'POST') {
      await handleCompletion(req, res, caller, 'openai')
      return
    }

    // ── Anthropic Messages（同一骨架，仅协议层不同）──
    if (path === '/v1/messages' && req.method === 'POST') {
      await handleCompletion(req, res, caller, 'anthropic')
      return
    }

    sendOpenAiError(res, gatewayError(404, 'invalid_request_error', `未知端点 ${req.method ?? ''} ${path}`))
  }

  async function handleCompletion(req: IncomingMessage, res: ServerResponse, caller: CallerContext, flavor: ProtocolFlavor): Promise<void> {
    const startedAt = Date.now()
    const requestId = newRequestId()
    /** 用量与结束原因的收集点（流式与非流式共用）。 */
    const usage = newUsageAccumulator()
    /** 请求阶段日志（与用量记录共享 requestId）。 */
    const log = options.requestLog?.forRequest(requestId)

    /**
     * 上报一次请求。
     *
     * ⚠️ 刻意接收**完整记录**而不是「基类 + 补丁」：解析失败的分支里
     * `target` 尚未赋值，若让本函数去引用它，闭包会在那几条路径上撞进
     * 暂时性死区（TDZ）而抛错 —— 也就是「记录一次 400 反而变成 500」。
     * 让调用方把已知字段填齐，本函数只负责兜底与容错。
     */
    function report(record: Partial<RequestRecord> & Pick<RequestRecord, 'status' | 'model' | 'stream'>): void {
      if (options.onRequest === undefined) return
      const full: RequestRecord = {
        requestId,
        callerId: caller.id,
        callerName: caller.name,
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        durationMs: Date.now() - startedAt,
        ...record,
      }
      try {
        options.onRequest(full)
      } catch (error) {
        // 记录失败绝不能影响客户端已经拿到的响应。
        logger?.warn(`[gateway] 请求记录失败 ${requestId}: ${String(error)}`)
      }
    }

    const parsed = await readJsonBody(req)
    if (!parsed.ok) {
      // 未连接上游：请求在网关本地就被拒了。
      log?.warn('rejected', `请求体无效: ${parsed.error.code}`, { status: parsed.error.status })
      report({ status: parsed.error.status, errorCode: parsed.error.code, model: '', stream: false })
      sendError(res, parsed.error, flavor)
      return
    }
    const body = parsed.value
    const rawModel = String(body['model'] ?? '')
    const stream = body['stream'] === true
    log?.info('received', 'chat 请求', { caller: caller.id, model: rawModel, stream })

    // 模型解析（授权范围 + 三层开关硬拦截）：失败时**不发起任何上游请求**。
    const target = resolver.resolve(body['model'], caller.scope)
    if (!target.ok) {
      // 同样是「未连接上游」——硬拦截的意义就在于请求出不了网关。
      log?.warn('rejected', `模型不可用: ${target.error.code}`, { model: rawModel, status: target.error.status })
      report({ status: target.error.status, errorCode: target.error.code, model: rawModel, stream })
      sendError(res, target.error, flavor)
      return
    }

    const streamOptions = body['stream_options']
    const includeUsage = typeof streamOptions === 'object' && streamOptions !== null
      && (streamOptions as Record<string, unknown>)['include_usage'] === true

    // 客户端断开时取消上游请求，避免白烧额度。
    const controller = new AbortController()
    req.on('close', () => { controller.abort() })

    const providerId = target.provider.descriptor.id
    /** 协议层的响应元信息（两套形状不同，分开构造）。 */
    const openAiMeta = { model: String(body['model']), stream, includeUsage }
    const anthropicMeta = { model: String(body['model']) }

    // 请求翻译：OpenAI 直接从 body 提参；Anthropic 先过翻译层
    // （system / tool_use / tool_result 的映射都在那边）。
    let generateOptions: GenerateOptions
    if (flavor === 'anthropic') {
      const translated = translateAnthropicRequest(body)
      if (!translated.ok) {
        const error = gatewayError(400, 'invalid_request_error', translated.message)
        log?.warn('rejected', `请求翻译失败: ${translated.message}`, { model: rawModel })
        report({ status: error.status, errorCode: error.code, model: rawModel, stream })
        sendError(res, error, flavor)
        return
      }
      const value = translated.value
      generateOptions = {
        provider: providerId,
        model: target.model,
        messages: value.messages,
        signal: controller.signal,
        ...(value.system !== undefined ? { system: value.system } : {}),
        ...(value.tools !== undefined ? { tools: value.tools } : {}),
        ...(value.maxTokens !== undefined ? { maxTokens: value.maxTokens } : {}),
        ...(value.temperature !== undefined ? { temperature: value.temperature } : {}),
        ...(value.stop !== undefined ? { stop: value.stop } : {}),
      }
    } else {
      generateOptions = buildGenerateOptions(body, providerId, target.model, controller.signal)
    }

    try {
      // 首字节计时：包一层迭代器，**流式与非流式共用**。
      // 放在这里而不是流式循环里，是因为非流式同样有「上游多久才吐出第一个
      // chunk」这个指标，而它恰恰是最能反映上游健康度的数字。
      const chunks = trackFirstChunk(target.provider.adapter.stream(generateOptions), usage, startedAt)
      if (!stream) {
        const response = flavor === 'anthropic'
          ? await collectAnthropicResponse(chunks, anthropicMeta, usage)
          : await collectOpenAiResponse(chunks, openAiMeta, usage)
        const collected = usage.snapshot()
        report({
          status: 200,
          model: rawModel,
          stream,
          provider: providerId,
          upstreamModel: target.model,
          ...collected,
          // 适配器没发 finish chunk 时，响应体里的兜底值（`stop`）才是权威。
          // （仅 OpenAI 形状有 finish_reason 字段可读；Anthropic 侧 stop_reason
          // 已由协议层从 finish chunk 换算。）
          ...(flavor === 'openai' && collected.finishReason === undefined ? finishFromResponse(response) : {}),
          accountId: accountIdFor(providerId),
        })
        log?.info('completed', '请求完成', { model: rawModel, stream })
        sendJson(res, 200, response)
        return
      }
      // 流式：先发头，再逐帧写。一旦开始写就不能再改成错误响应。
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        // 阻止反向代理缓冲，否则流式会被攒成一次性响应。
        'X-Accel-Buffering': 'no',
      })
      try {
        const frames = flavor === 'anthropic'
          ? streamAnthropicSse(chunks, anthropicMeta, usage)
          : streamOpenAiSse(chunks, openAiMeta, usage)
        for await (const frame of frames) {
          if (controller.signal.aborted) break
          res.write(frame)
        }
        res.end()
        report({
          status: 200,
          model: rawModel,
          stream,
          provider: providerId,
          upstreamModel: target.model,
          ...usage.snapshot(),
          accountId: accountIdFor(providerId),
        })
        log?.info('completed', '流式完成', { model: rawModel, stream })
      } catch (error) {
        // 已发头：只能把错误作为 SSE 内的事件下发（无法改状态码）。
        const gw = toGatewayError(error)
        // ⚠️ **必须带 `gw.message`**（真实缺陷，2026-09-29）：早期只记错误码，
        // 结果 workbuddy 那 3 次「invalid_request_error」完全无法定位 —— 错误码
        // 只说「上游拒绝了请求」，而**上游到底说了什么**（缺 system / 孤儿 tool /
        // 额度超限）全在 message 里。日志器已统一走 `redactString` 脱敏，
        // 故带上完整报文不会泄露凭据。
        logger?.warn(`[gateway] 流式中断 ${requestId}: ${gw.code} ${gw.message}`)
        if (flavor === 'anthropic') {
          // Anthropic 官方流内错误：event: error + 错误信封。
          const body = JSON.stringify(anthropicErrorBody(gw))
          res.write(`event: error\ndata: ${body}\n\n`)
        } else {
          res.write(`data: ${JSON.stringify(openAiErrorBody(gw))}\n\n`)
          res.write('data: [DONE]\n\n')
        }
        res.end()
        // 阶段归因：拿到过首字节说明问题出在传输途中；一个字节都没有
        // 说明上游连上了但没吐内容 —— 两者的排查方向完全不同。
        //
        // 同样带上 `gw.message`：只记码会让「上游连上了但 400」这类情况
        // 失去唯一的线索（见上方流式分支的同款说明）。
        const hadFirstByte = usage.snapshot().firstByteMs !== undefined
        log?.warn(hadFirstByte ? 'transfer-aborted' : 'upstream-connected', `流式中断: ${gw.code} ${gw.message}`, { model: rawModel })
        report({
          status: gw.status,
          errorCode: gw.code,
          model: rawModel,
          stream,
          provider: providerId,
          upstreamModel: target.model,
          ...usage.snapshot(),
        })
      }
    } catch (error) {
      const gw = toGatewayError(error)
      logger?.warn(`[gateway] chat 失败 ${requestId}: ${gw.code} ${gw.message}`)
      const hadFirstByte = usage.snapshot().firstByteMs !== undefined
      log?.warn(hadFirstByte ? 'transfer-aborted' : 'upstream-connected', `请求失败: ${gw.code} ${gw.message}`, { model: rawModel })
      report({
        status: gw.status,
        errorCode: gw.code,
        model: rawModel,
        stream,
        provider: providerId,
        upstreamModel: target.model,
        accountId: accountIdFor(providerId),
      })
      sendError(res, gw, flavor)
    }
  }
}

/** 未鉴权场景下的匿名调用方（不限制范围）。 */
const ANONYMOUS_CALLER: CallerContext = { id: 'anonymous', name: '未鉴权' }

/**
 * 用量累加器（流式路径逐块累积）。
 *
 * 同时充当协议层的观察者与 {@link RequestRecord} 的字段来源 —— 这样
 * 「流式用了多少 token」只在一个地方换算，不会出现协议层与网关两套口径。
 *
 * ⚠️ **不能把它整个展开进记录**：它还带着 `onUsage` / `onFinish` 两个函数，
 * 展开会让记录里混入不可序列化的字段（写进 SQLite 会变成 `null` 或抛错）。
 * 取值一律走 {@link UsageAccumulator.snapshot}。
 */
interface UsageAccumulator extends OpenAiStreamObserver {
  /** 记录第一个 chunk 的到达耗时（毫秒）；只取第一次。 */
  markFirstChunk(elapsedMs: number): void
  /** 取出可写入记录的纯数据字段。 */
  snapshot(): Pick<RequestRecord, 'inputTokens' | 'outputTokens' | 'cacheReadTokens' | 'cacheWriteTokens' | 'finishReason' | 'firstByteMs'>
}

/** 新建一个用量累加器。 */
function newUsageAccumulator(): UsageAccumulator {
  let inputTokens = 0
  let outputTokens = 0
  let cacheReadTokens = 0
  let cacheWriteTokens = 0
  let finishReason: string | undefined
  let firstByteMs: number | undefined
  return {
    onUsage(usage) {
      // ⚠️ 字段口径与内部 `TokenUsage` 一致（counts are DISJOINT），
      // 换算成 OpenAI 口径是响应体构造的职责，不是记录的职责。
      inputTokens = usage.inputTokens
      outputTokens = usage.outputTokens
      cacheReadTokens = usage.cacheReadTokens ?? 0
      cacheWriteTokens = usage.cacheWriteTokens ?? 0
    },
    onFinish(reason) {
      finishReason = reason
    },
    markFirstChunk(elapsedMs) {
      // 只记第一次：后续 chunk 的到达时间对「上游多久开始响应」没有意义。
      if (firstByteMs === undefined) firstByteMs = elapsedMs
    },
    snapshot() {
      return {
        inputTokens,
        outputTokens,
        cacheReadTokens,
        cacheWriteTokens,
        ...finishReason === undefined ? {} : { finishReason },
        ...firstByteMs === undefined ? {} : { firstByteMs },
      }
    },
  }
}

/**
 * 包一层迭代器，记录**第一个 chunk 到达**的耗时。
 *
 * 为什么不放在写响应的循环里：非流式请求同样需要这个指标，而它在
 * `collectOpenAiResponse` 内部被消费完，外层看不到任何 chunk 边界。
 * 包在适配器输出这一层，两条路径就都能拿到。
 */
async function* trackFirstChunk(
  chunks: AsyncIterable<StreamChunk>,
  usage: UsageAccumulator,
  startedAt: number,
): AsyncGenerator<StreamChunk> {
  for await (const chunk of chunks) {
    usage.markFirstChunk(Date.now() - startedAt)
    yield chunk
  }
}

/** 从非流式响应体里取结束原因。 */
function finishFromResponse(response: Record<string, unknown>): Pick<RequestRecord, 'finishReason'> {
  const choices = response['choices']
  if (!Array.isArray(choices) || choices.length === 0) return {}
  const first = choices[0]
  if (typeof first !== 'object' || first === null) return {}
  const reason = (first as Record<string, unknown>)['finish_reason']
  return typeof reason === 'string' ? { finishReason: reason } : {}
}

/**
 * 取「当前服务该请求的账号」。
 *
 * ⚠️ 这是**尽力而为**的近似：真正的账号归属由适配器在内部轮换时决定，而适配器
 * 不回传它用了哪个账号。这里读池记录器里的当前账号（由适配器在取号时登记），
 * 在发生轮换的请求上可能滞后一个账号。精确归属需要适配器回传，
 * 属于后续可改进项（见 README 的已知限制）。
 */
function accountIdFor(provider: string): string | undefined {
  const id = currentAccountIdFor(provider)
  return id !== undefined && id.length > 0 ? id : undefined
}

/** 写 JSON 响应。 */
function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload)
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' })
  res.end(body)
}

/**
 * 构造健康检查载荷。
 *
 * ⚠️ **只读内存状态**，不发起任何上游请求（规格要求不消耗额度）。
 * 因此这里给出的是「账号配置层面」的可用性，不是上游实时探测结果。
 */
function healthPayload(options: GatewayOptions): Record<string, unknown> {
  const providers = options.registry.list().map(({ descriptor }) => {
    const accounts = options.pool.accountsOf(descriptor.id)
    const enabled = accounts.filter(a => a.enabled).length
    return {
      id: descriptor.id,
      displayName: descriptor.displayName,
      enabled: options.pool.providerEnabled(descriptor.id),
      accounts: accounts.length,
      enabledAccounts: enabled,
      // 只报「已配置且有启用账号」，不是上游探测结果（那会消耗额度）。
      ready: options.pool.providerEnabled(descriptor.id) && enabled > 0,
    }
  })
  return {
    status: 'ok',
    version: '0.1.0',
    globalModelsEnabled: options.pool.globalModelsEnabled(),
    providers,
  }
}
