/**
 * 腾讯系渠道的**会话头族**注入（`X-Conversation-*` 三枚）。
 *
 * 移植自 `deepseek-harness-codearts` 的 `src/buddy-adapter.ts`（`send()` 里的三行
 * `headers.set('X-Conversation-…')`）。
 *
 * ## 现象
 *
 * 经本网关调 `workbuddy` / `buddy` 时，部分账号回：
 *
 * ```json
 * {"code":11128,"msg":"request illegal",
 *  "displayMsg":{"zh":"请求被拦截，请重新发送"},
 *  "displayTips":{"zh":"这次调用没通过渠道校验，可能不是官方客户端发出的。请用官方版本重新发送。"}}
 * ```
 *
 * ## 判据（实测，不是推断）
 *
 * 腾讯网关对**部分账号**做「渠道校验」：三枚官方会话头必须**同时存在且非空**。
 *
 * - **不校验值语义**：三枚同值 / 各自不同 / 填 `abc-123` **全部放行**；
 * - **不要求三者一致**；
 * - **填空串 = 缺**（仍 400）；
 * - **逐请求判定**：带三头 → 紧接无头，`200 → 400` 可来回切（**非封禁、非状态粘性**）；
 * - **内容无关**：换 system、换最简 body 仍 400；
 * - 仅补一枚仍 400（必须三枚齐全）。
 *
 * ⚠️⚠️ **生效范围是「按账号」的，不是全局**：参考实现用同一份 e2e、只换账号，
 * 实测出 2/5 与 3/5 两种比例。所以「某些账号不带三头也 200」**不能**用来论证
 * 「三头不必发」—— 对要求三头的账号，缺任一即**整条渠道不可用**。
 * 这也是本缺陷长期未被发现的原因：换一台机器、换一批账号就复现不了。
 *
 * ⚠️ 该拒绝**同时以 HTTP 400 与 403 出现**，且 `msg` 与 11140（账号级安全策略
 * 拦截）**共用** `request illegal` 这句措辞 ⇒ 分类判据必须**同时**按 `code` 精确
 * 等于 11128 收窄（见 `buddy-adapter.ts` 的 `isChannelVerificationRejection`）。
 *
 * ⚠️ 语义：三枚是**逐请求一次性 id**，不是会话身份。参考实现实测上游**不做**
 * 跨轮状态机（同一 `prompt_cache_key` 连发三轮、每轮换三头值，上游 3/3 接受）。
 * 故本模块每次调用都生成新值，不复用 `sessionId` —— 那是 `prompt_cache_key`
 * 的语义（前缀缓存分桶键），两件不同的事共用一个值会导致缓存分桶漂移。
 */

/** 官方客户端的会话头名（大小写不敏感，按官方源码的驼峰形态写）。 */
export const TENCENT_CONVERSATION_HEADERS = [
  'X-Conversation-ID',
  'X-Conversation-Request-ID',
  'X-Conversation-Message-ID',
] as const

/** 生成 32 位无横线 hex，对齐官方 `X-Conversation-Message-ID` 的取值形态。 */
function hex32(): string {
  return crypto.randomUUID().replace(/-/g, '')
}

/**
 * 把三枚会话头写进 headers。
 *
 * @param headers 目标请求头对象（原地修改）
 * @returns 同一个 headers 对象
 */
export function applyTencentConversationHeaders(headers: Headers): Headers {
  // ⚠️ 三枚必须**同时非空**才算满足判据 ⇒ 一次生成一组、一起写。
  // ⚠️ 逐请求新值：实测上游不做跨轮状态机，且这三枚是「一次性 id」语义。
  const conversationId = hex32()
  headers.set('X-Conversation-ID', conversationId)
  headers.set('X-Conversation-Request-ID', conversationId)
  headers.set('X-Conversation-Message-ID', conversationId)
  return headers
}
