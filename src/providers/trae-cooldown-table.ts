/**
 * TRAE 各错误类别的冷却时长（毫秒）。供 `trae-adapter.ts` 的轮换循环使用。
 *
 * ## 为什么按类别（2026-09-26 修，来源 pull request #64 审查后修订取值）
 *
 * 原实现一律用 `TRAE_RATE_LIMIT_FALLBACK_MS`（1 小时兜底）。但错误类别的
 * 「自然恢复周期」差好几个量级。取值**对齐 `trae-errors.ts` 的既有权威定义**：
 *   · `quota-exceeded`（4008，ide_credits **日配额**耗尽 —— 积分来自每日签到，
 *     余额 API 实测标「签到奖励/30 天到期」）→ 24 小时兜底（覆盖到下次签到）；
 *   · `hard-plan`（1005，套餐权益不足）→ 12 小时（既有定义的长冷却）；
 *   · `soft-rate`（4011，频率超限）→ 60 秒（频率类分钟级恢复，放大到小时级
 *     会白白损失多账号池的可用容量）。
 * 上游响应若给出明确重置时间应以那个为准；4008 没有可靠的重置字段，改的是兜底值。
 *
 * ⚠️ 本表与 `trae-credits.ts` 的签到错误分类 `classifyTraeCheckinError`
 * （PlanLimit 12h / SoftRate 60s / Server 10min，对齐 trae-mate `cooldown.rs`）
 * 是**两套不同的表、不同用途**：本表管 **chat 请求换号**，那张管**签到**。
 * **不要合并**，否则会把 chat 的 24h/12h 与签到的 12h/10min 搅在一起。
 */
export const TRAE_COOLDOWN_MS: Record<string, number> = {
  /** 配额耗尽：日配额（签到积分，余额 API 实测）⇒ 24 小时。 */
  'quota-exceeded': 24 * 3_600_000,
  /** Plan 权益不足：既有定义的长冷却 12h。 */
  'hard-plan': 12 * 3_600_000,
  /** 频率超限：既有定义的短冷却 60s。 */
  'soft-rate': 60_000,
  /** 404：1 小时（可能是暂时性路由问题）。 */
  'not-found': 3_600_000,
  /** 会话死亡：不靠冷却恢复（只能重登），记 0。 */
  'session-dead': 0,
  /** 5xx：1 小时。 */
  'server': 3_600_000,
  /** 4xx（其他）：1 小时。 */
  'client': 3_600_000,
  none: 0,
}

/** 按类别取冷却时长；未知类别回落 1 小时（保守，与旧行为一致）。 */
export function traeCooldownFor(kind: string): number {
  return TRAE_COOLDOWN_MS[kind] ?? 3_600_000
}
