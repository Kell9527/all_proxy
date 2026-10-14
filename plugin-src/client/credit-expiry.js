/**
 * 积分包的**到期分桶**与倒计时纯函数（永久 / 长期 / 临期）。
 *
 * 移植自来源 `plugin-src/client/credit-expiry.js` 的同名函数，**判据字段做了
 * 一处适配**：来源读包上的 `deductionEndTime`（数值毫秒），本项目后端把到期
 * 时间放在 `CreditPackage.expiredTime`（ISO 字符串）—— 解析点收敛到本文件的
 * {@link packageExpiryMs}，调用方无感。
 *
 * ## 三档口径（与后端 `CREDIT_EXPIRY_WINDOW_DAYS` 同源）
 *
 * | 档位 | 判据 | 色调 |
 * |---|---|---|
 * | 永久 | 包**没有**到期时间（`expiredTime` 空/不可解析） | ok（绿） |
 * | 长期 | 有到期时间，且距现在 ≥ `windowDays` 天 | warn（黄） |
 * | 临期 | 有到期时间，且距现在 < `windowDays` 天 | error（红） |
 *
 * 已失效（`active !== true`）与剩余 ≤ 0 的包**不计入任何一档** —— 它们要么
 * 不能用、要么没有余额，算进去会让「永久」虚高。
 */

/** 分桶窗口天数默认值（后端 `/api/credits/balances` 会带 `windowDays`，优先用它的）。 */
export const CREDIT_EXPIRY_WINDOW_DAYS = 15

/** Accio 每日桶的包名（与后端 `accio-credits.ts` 的 label 逐字一致）。 */
export const ACCIO_DAILY_BUCKET = '每日积分'

/**
 * 读一个包的到期时刻（毫秒）。
 *
 * @returns 有限正数；包没有到期时间（或不可解析）时返回 `null` —— 那正是
 *   「真·永久」的判据，**不能**用 0 冒充（0 会被当成已过期）。
 */
export function packageExpiryMs(pkg) {
  if (!pkg) return null;
  const raw = pkg.expiredTime;
  if (typeof raw !== 'string' || raw.length === 0) return null;
  const end = Date.parse(raw);
  return Number.isFinite(end) && end > 0 ? end : null;
}

/**
 * 把积分包按到期时间分到三档。
 *
 * @param packages - `CreditBalance.packages`（可含失效包）。
 * @param windowDays - 「长期 / 临期」的分界天数。
 * @param now - 当前时刻（测试注入）。
 * @returns 三档各自剩余合计 + 最早的临期到期时刻（无临期包时为 null）。
 */
export function splitCreditsByExpiry(packages, windowDays, now = Date.now()) {
  const windowMs = Math.max(0, Number(windowDays)) * 24 * 60 * 60 * 1000;
  const split = { permanent: 0, longTerm: 0, expiring: 0, earliestExpiringAt: null };
  for (const pkg of packages || []) {
    if (!pkg || pkg.active !== true) continue;
    const remaining = Number(pkg.remaining);
    if (!Number.isFinite(remaining) || remaining <= 0) continue;
    const end = packageExpiryMs(pkg);
    if (end === null) {
      split.permanent += remaining;
    } else if (end - now < windowMs) {
      split.expiring += remaining;
      if (end > now && (split.earliestExpiringAt === null || end < split.earliestExpiringAt)) {
        split.earliestExpiringAt = end;
      }
    } else {
      split.longTerm += remaining;
    }
  }
  return split;
}

/**
 * 把分桶结果格式化成**带色调的一段段**（供账号卡片的「积分」行内联展示）。
 *
 * @param split - {@link splitCreditsByExpiry} 的结果。
 * @param formatForUnit - 数值格式化函数（调用方传 `formatCredits`）。
 * @param now - 当前时刻（算临期倒计时用）。
 * @returns 只含**非零**档的段；全零时返回空数组（调用方据此不渲染该行）。
 */
export function expirySplitParts(split, formatForUnit, now = Date.now()) {
  const parts = [];
  if (split.permanent > 0) {
    parts.push({ key: 'permanent', text: `永久 ${formatForUnit(split.permanent)}`, tone: 'ok' });
  }
  if (split.longTerm > 0) {
    parts.push({ key: 'longTerm', text: `长期 ${formatForUnit(split.longTerm)}`, tone: 'warn' });
  }
  if (split.expiring > 0) {
    const countdown = expiryCountdown(split.earliestExpiringAt, now);
    parts.push({
      key: 'expiring',
      text: countdown.length > 0
        ? `临期 ${formatForUnit(split.expiring)}（${countdown}）`
        : `临期 ${formatForUnit(split.expiring)}`,
      tone: 'error',
    });
  }
  return parts;
}

/**
 * 到期倒计时文案（向上取整到分钟）。
 *
 * @returns `''` 表示「没有可倒计时的临期包」（调用方不渲染括号部分）。
 */
export function expiryCountdown(earliestExpiringAt, now = Date.now()) {
  if (earliestExpiringAt === null || earliestExpiringAt === undefined) return '';
  const ms = earliestExpiringAt - now;
  if (!Number.isFinite(ms) || ms <= 0) return '';
  const totalMinutes = Math.ceil(ms / 60000);
  const hours = Math.floor(totalMinutes / 60);
  const mins = totalMinutes % 60;
  if (hours > 0) return `${hours} 小时 ${mins} 分钟`;
  return `${mins} 分钟`;
}

/**
 * Accio 的**命名池一行**：「每日 100 · 每月 0 · 推荐 700」。
 *
 * 与三档分桶**互斥**（调用方二选一）：Accio 的三个桶是**不同类型**的额度
 * （每日/每月/推荐），不是「同一批额度的不同到期时间」—— 用三档口径会把
 * 每日桶误判成「临期」，而它其实是**周期性刷新**的。故 Accio 走本函数，
 * OfficeAce 走 {@link splitCreditsByExpiry}。
 *
 * 判据从宽：`active !== true` 的包跳过，剩余读不到（NaN）也跳过；
 * 剩余为 **0 照显**（用户要看到「还有 0」）。
 * 包名去掉结尾的「积分」二字做短标签（`每日积分` → `每日`）。
 */
export function formatNamedPoolLine(packages, formatForUnit) {
  const parts = [];
  for (const pkg of packages || []) {
    if (!pkg || pkg.active !== true) continue;
    const remaining = Number(pkg.remaining);
    if (!Number.isFinite(remaining)) continue;
    const name = String(pkg.name || '').replace(/积分$/, '');
    parts.push(`${name} ${formatForUnit(remaining)}`);
  }
  return parts.length > 0 ? parts.join(' · ') : null;
}

/**
 * Accio 每日额度的**重置倒计时**（秒）。
 *
 * 数据落在每日桶的 `cycleEndTime`（后端由 `quota.refreshCountdownSeconds`
 * 现算写入 —— 那正是「计量周期结束时间」的字段本义）。
 *
 * @returns 秒数；读不到 / 已过期时返回 `null`（调用方据此不渲染该行，
 *   **不写死 86400** —— 上游某天不给倒计时时不能假装知道）。
 */
export function accioResetSeconds(packages, now = Date.now()) {
  const daily = (packages || []).find((p) => p && p.name === ACCIO_DAILY_BUCKET);
  if (daily === undefined) return null;
  const raw = daily.cycleEndTime;
  if (typeof raw !== 'string' || raw.length === 0) return null;
  const end = Date.parse(raw);
  if (!Number.isFinite(end) || end <= 0) return null;
  return Math.floor((end - now) / 1000);
}

/**
 * 重置倒计时秒数 → 文案（`86400` → `24 小时 0 分`）。
 *
 * @returns `null` 表示不该显示（调用方不渲染「每日额度 … 后刷新」那一句）。
 */
export function formatAccioResetCountdown(seconds) {
  if (seconds === null || !Number.isFinite(seconds) || seconds <= 0) return null;
  const totalMinutes = Math.ceil(seconds / 60);
  const hours = Math.floor(totalMinutes / 60);
  const mins = totalMinutes % 60;
  if (hours > 0) return `${hours} 小时 ${mins} 分`;
  return `${mins} 分钟`;
}
