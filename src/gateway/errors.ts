/**
 * 对外错误映射。
 *
 * 规格 `gateway-api` 要求把上游与内部错误映射为**稳定的** HTTP 状态码与错误码。
 * 调用方（客户端）只应按状态码与 `error.code` 分支，**不要**解析文案。
 *
 * ## 与来源的关键差异
 *
 * 来源运行在 DSH 里，错误码由 harness 的重试策略消费（`AUTH` / `QUOTA_EXCEEDED`
 * / `SERVER` / `QUEUE` …）。本项目对外提供 API，故在保留那些**语义**的同时，
 * 额外映射为 OpenAI / Anthropic 两个协议各自认识的 HTTP 状态与错误形状。
 */

/** 对外错误码（稳定字符串，客户端可据此分支）。 */
export type GatewayErrorCode =
  /** 入站鉴权失败（缺 key / key 无效 / key 被禁用）。 */
  | 'invalid_api_key'
  /** 上游凭据全部失效且无法刷新。 */
  | 'authentication_error'
  /** 当日额度或积分已用尽（**不可重试**）。 */
  | 'quota_exceeded'
  /** 被限流（可重试）。 */
  | 'rate_limit_exceeded'
  /** 该 provider 当前无可用账号。 */
  | 'no_available_account'
  /** 模型不存在，或已被模型开关关闭（硬拦截）。 */
  | 'model_not_found'
  /**
   * 模型存在且未被关闭，但**当前 API Key 的授权范围**不允许访问。
   *
   * 刻意与 `model_not_found` 区分：前者是「服务端不提供」，后者是「你这把 key
   * 没有权限」。合并会让受限 key 的持有者误以为模型不存在而反复换名字试。
   */
  | 'model_not_authorized'
  /** 请求参数有误。 */
  | 'invalid_request_error'
  /** 上游排队超时或等待过久。 */
  | 'upstream_timeout'
  /** 上游传输失败。 */
  | 'upstream_error'
  /** 服务内部错误。 */
  | 'internal_error'

/** 对外错误载荷。 */
export interface GatewayError {
  status: number
  code: GatewayErrorCode
  message: string
  /**
   * 建议的重试等待（毫秒）。仅限流类错误会带它。
   *
   * 服务端据此下发 `Retry-After` 头 —— 没有它，客户端只能盲目退避，
   * 要么过早重试继续被拒、要么等得过久。
   */
  retryAfterMs?: number
}

/** 构造一个错误载荷。 */
export function gatewayError(status: number, code: GatewayErrorCode, message: string): GatewayError {
  return { status, code, message }
}

/**
 * 构造一个带重试提示的错误载荷。
 *
 * `retryAfterMs` 会原样转成 `Retry-After` 响应头（秒，向上取整），
 * 让客户端知道「什么时候可以再试」而不是盲目退避。
 */
export function gatewayErrorWithRetry(
  status: number,
  code: GatewayErrorCode,
  message: string,
  retryAfterMs: number,
): GatewayError {
  return { status, code, message, retryAfterMs }
}

/**
 * 把内部 `LlmError.code` 映射为对外状态码与错误码。
 *
 * 映射表（**顺序即优先级**，前面的先匹配）：
 *
 * | 内部 code | HTTP | 对外 code |
 * |---|---|---|
 * | `MISSING_CREDENTIAL` / `AUTH` | 401 | `authentication_error` |
 * | `QUOTA_EXCEEDED` | 429 | `quota_exceeded` |
 * | `RATE_LIMIT` | 429 | `rate_limit_exceeded` |
 * | `TIMEOUT` / `QUEUE` | 504 | `upstream_timeout` |
 * | `TRANSPORT` | 502 | `upstream_error` |
 * | `CONTEXT_WINDOW_EXCEEDED` | 400 | `invalid_request_error` |
 * | `UNSUPPORTED_CONTENT` | 400 | `invalid_request_error` |
 * | 其余 | 500 | `internal_error` |
 *
 * ⚠️ **`QUOTA_EXCEEDED` 必须与 `RATE_LIMIT` 分开**：前者是「当天耗尽、重试无用」，
 * 后者是「暂时受阻、可重试」。合并会让客户端对确定性错误无限重试。
 *
 * ⚠️ **上游的 4xx（参数错误）必须原样透传**，不能一律变成 500 —— 那是客户端
 * 自己的问题，映射成 5xx 会让人误以为是服务端故障。
 */
export function mapLlmErrorCode(code: string, status?: number): { status: number; code: GatewayErrorCode } {
  switch (code) {
    case 'MISSING_CREDENTIAL':
    case 'AUTH':
      return { status: 401, code: 'authentication_error' }
    case 'QUOTA_EXCEEDED':
      return { status: 429, code: 'quota_exceeded' }
    case 'RATE_LIMIT':
      return { status: 429, code: 'rate_limit_exceeded' }
    case 'TIMEOUT':
    case 'QUEUE':
      return { status: 504, code: 'upstream_timeout' }
    case 'TRANSPORT':
      return { status: 502, code: 'upstream_error' }
    case 'CONTEXT_WINDOW_EXCEEDED':
    case 'UNSUPPORTED_CONTENT':
    case 'INVALID_REQUEST':
      return { status: 400, code: 'invalid_request_error' }
    case 'EMPTY_RESPONSE':
      // 退化补全（上游正常结束但零内容）：归 502 让客户端重试，
      // 而不是伪装成成功返回一个空回答。
      return { status: 502, code: 'upstream_error' }
    case 'SERVER':
      return { status: 502, code: 'upstream_error' }
    default:
      // 上游给了明确的 4xx：原样透传，别把客户端错误说成服务端故障。
      if (status !== undefined && status >= 400 && status < 500) {
        return { status, code: 'invalid_request_error' }
      }
      return { status: 500, code: 'internal_error' }
  }
}

/**
 * 构造 OpenAI 形状的错误响应体。
 *
 * 形状：`{"error":{"message":...,"type":...,"code":...}}`。
 */
export function openAiErrorBody(error: GatewayError): Record<string, unknown> {
  return {
    error: {
      message: error.message,
      type: error.code === 'invalid_api_key' ? 'invalid_request_error' : error.code,
      code: error.code,
      // 部分客户端（含官方 SDK）会读 param 字段；给 null 而非省略。
      param: null,
    },
  }
}

/**
 * 构造 Anthropic 形状的错误响应体。
 *
 * 形状：`{"type":"error","error":{"type":...,"message":...}}`。
 *
 * ⚠️ **与 OpenAI 形状不同**，不能复用：Claude 系客户端按 `error.type` 分支，
 * 拿到 OpenAI 形状会报解析错误。
 */
export function anthropicErrorBody(error: GatewayError): Record<string, unknown> {
  return {
    type: 'error',
    error: {
      type: anthropicErrorType(error.code),
      message: error.message,
    },
  }
}

/** 把对外错误码映射为 Anthropic 的错误类型枚举。 */
export function anthropicErrorType(code: GatewayErrorCode): string {
  switch (code) {
    case 'invalid_api_key':
    case 'authentication_error':
      return 'authentication_error'
    case 'quota_exceeded':
    case 'rate_limit_exceeded':
      return 'rate_limit_error'
    case 'model_not_found':
      return 'not_found_error'
    case 'model_not_authorized':
      // Anthropic 有 permission_error（403 语义），比 not_found 更准确。
      return 'permission_error'
    case 'invalid_request_error':
      return 'invalid_request_error'
    default:
      // Anthropic 的 5xx 统一叫 api_error。
      return 'api_error'
  }
}
