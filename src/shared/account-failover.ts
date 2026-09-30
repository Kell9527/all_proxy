/**
 * 账号级上游错误的判定（换号重试的触发依据）。
 *
 * ## 为什么需要它
 *
 * 「积分余额不足」这类错误是**账号级**的（换一个账号就能继续），
 * 但 HTTP 形态上只是普通的 4xx —— 不换号的话，请求会一直撞同一个
 * 耗尽的账号（Loomy 用户报障 2026-09-29：账号 1 积分为 0 排在首位，
 * 每次请求都被选中并失败，永远轮不到有积分的账号 2）。
 *
 * 判据移植自用户自写的 `xiaohuanxiong2api/raccoon-gateway.js`（对商汤
 * 小浣熊上游的实测结论，2026-09 在线运行验证）：
 * - **HTTP 402/403 = 额度错误**（该网关实测：这两态对应积分不足）；
 * - 其他 4xx + 额度类文案 = 额度错误（Loomy 实测：400 + 「积分余额不足，
 *   请获取积分后再试」）；
 * - HTTP 429 = 限流（短时，稍后重试即可恢复）。
 *
 * ⚠️ 只有**账号级**错误才触发换号。请求体错误（400 无额度文案）、
 * 5xx（服务端故障，与账号无关）换号也无法解决，原样抛出。
 */

/**
 * 额度不足的上游文案（中英双语，大小写不敏感）。
 *
 * ⚠️ 中文判据要求「积分/点数/余额/额度」与「不足/用完/耗尽/为零/欠费」
 * 之间的间隔不超过 12 个字符：既覆盖「积分余额不足」（间隔 2 字）这类
 * 紧凑形态，又不至于把长句里的无关词组误配。
 */
export const QUOTA_ERROR_RE = /(积分|点数|余额|额度)[^。；,，]{0,12}(不足|用完|耗尽|为零|欠费)|insufficient[_\s-]?(points|balance|credit|quota)|(points|balance|credit|quota)[_\s-]?(exhausted|insufficient|not[_\s-]?enough|depleted|reached)|no[_\s-]?available[_\s-]?points/i

/** 错误体是否命中**额度不足**文案。 */
export function looksLikeQuotaError(text: string): boolean {
  return QUOTA_ERROR_RE.test(text)
}

/**
 * 429 限流标记的兜底时长（毫秒）。
 *
 * 来源参照 `xiaohuanxiong2api` 的瞬时故障冷却（30 秒）：限流窗口通常很短，
 * 标太久会让账号白白闲置；届时上游若给出明确的重置时间，再行解析覆盖。
 */
export const RATE_LIMIT_FALLBACK_MS = 30_000
