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
 * 把积分包按到期时间分到三档（外加一个独立的「已过期」桶）。
 *
 * @param packages - `CreditBalance.packages`（可含失效包）。
 * @param windowDays - 「长期 / 临期」的分界天数。
 * @param now - 当前时刻（测试注入）。
 * @returns 三档各自剩余合计 + 最早的临期到期时刻/批次量（无临期包时为 null/0）
 *   + 已作废但仍 `active` 的量（`expired`，为 0 时**不出现**该键）。
 */
export function splitCreditsByExpiry(packages, windowDays, now = Date.now()) {
  const windowMs = Math.max(0, Number(windowDays)) * 24 * 60 * 60 * 1000;
  /**
   * ⚠️ `expired` 必须**独立一桶**，不能留在 `expiring` 里（来源对抗审计 B1）。
   *
   * 这类包是「`active: true` 但到期时刻已过」：服务端仍把它们算作有效、
   * 余额也照常返回，于是它们**一直会出现在 `packages` 里**（可达性不是假设
   * —— TRAE / Qoder 的 `active` 是**硬编码 true**，从不反映是否过期）。
   *
   * 混进 `expiring` 的后果是**面板与行为相反**：面板写「临期 7」却没有倒计时
   * （`earliestExpiringAt` 只取未来时刻），而同一个包的附注写「已过期」——
   * 一条数据两个说法。
   */
  let expired = 0;
  const split = {
    permanent: 0,
    longTerm: 0,
    expiring: 0,
    earliestExpiringAt: null,
    /**
     * **最早那批**到期时刻对应的量（与 {@link earliestExpiringAt} 配对）。
     *
     * ⚠️ 为什么必须有它（来源 2026-10-20 报障「怎么可能全都同一天到期」）：
     * 把窗口内**所有**批次累加成 `expiring`、而倒计时只指向**最早**那一批，
     * 显示成「临期 20856（4 天 20 小时）」会让用户以为**这 20856 会在
     * 4 天 20 小时后一起掉**，实际最早那批只有 19656。
     * ⇒ 文案改成「临期 20856（其中 19656 于 4 天 20 小时后到期）」。
     */
    earliestExpiringAmount: 0,
  };
  for (const pkg of packages || []) {
    if (!pkg || pkg.active !== true) continue;
    const remaining = Number(pkg.remaining);
    if (!Number.isFinite(remaining) || remaining <= 0) continue;
    const end = packageExpiryMs(pkg);
    if (end === null) {
      split.permanent += remaining;
    } else if (end <= now) {
      // ⚠️ 已作废：**不进** `expiring`，否则面板说「临期」而它扣不到。
      expired += remaining;
    } else if (end - now < windowMs) {
      split.expiring += remaining;
      if (split.earliestExpiringAt === null || end < split.earliestExpiringAt) {
        // 出现**更早**的批次 ⇒ 该量取代之前的（两批不是同一批，不能相加）。
        split.earliestExpiringAt = end;
        split.earliestExpiringAmount = remaining;
      } else if (end === split.earliestExpiringAt) {
        // 同一批次（同刻并列）⇒ 累加。
        split.earliestExpiringAmount += remaining;
      }
    } else {
      split.longTerm += remaining;
    }
  }
  // ⚠️ `expired` 只在**真有已作废额度时**才出现（与「无值即不写键」同款式）：
  //    否则每个调用方都要为「多一个恒 0 的键」改断言，而它对 0 值毫无信息量。
  return expired > 0 ? { ...split, expired } : split;
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
    /**
     * ★ 倒计时降级成「其中」限定语（来源 2026-10-20 + 后续修正）。
     *
     * 两个约束必须同时满足：
     * 1. **数字 = 临期总额**（三档合计守恒，用户一算就平）；
     * 2. **倒计时只覆盖其中一批**，必须说清「其中」——
     *    否则「临期 20856（4 天 20 小时）」会被读成「全部同时到期」。
     *
     * ⚠️ 「其中」只在**倒计时那批量 < 临期总额**时出现：否则「其中 3500 于…」
     * 里的「其中」是废话（它本来就是全部）。
     *
     * ⚠️ 全无日期的临期批次（`earliestExpiringAmount === 0`）⇒ **不编造倒计时**。
     */
    const earliestAmount = Number.isFinite(split.earliestExpiringAmount)
      && split.earliestExpiringAmount > 0
      ? split.earliestExpiringAmount
      : 0;
    const partial = earliestAmount > 0 && earliestAmount < split.expiring;
    const countdownText = countdown.length === 0
      ? ''
      : partial
        ? `其中 ${formatForUnit(earliestAmount)} 于 ${countdown}后到期`
        : countdown;
    parts.push({
      key: 'expiring',
      text: `临期 ${formatForUnit(split.expiring)}`,
      tone: 'error',
      ...(countdownText.length > 0 ? { countdown: countdownText } : {}),
    });
  }
  /**
   * ★ 「已过期」单列一段：那些额度**已经扣不到了**，但 `active` 仍是 true，
   * 所以会一直出现在 `packages` 里。与临期**必须分开** —— 混进去会得到
   * 「面板写临期、附注写已过期」这种一条数据两个说法。
   */
  if (Number.isFinite(split.expired) && split.expired > 0) {
    parts.push({
      key: 'expired',
      text: `已过期 ${formatForUnit(split.expired)}`,
      tone: 'dim',
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
 * 逐包明细的**排序 + 过滤**（对齐来源 `formatPackageTooltip` 的核心，2026-11-02 补齐）。
 *
 * ## 为什么必须重排（用户给的第二张截图）
 *
 * > hover 积分显示列表应该按照到期时间排序，最快到期的排到最上面
 *
 * 后端给的 `packages` 顺序是**上游返回顺序**（打包顺序或名称顺序），与「哪笔
 * 先作废」无关。用户要判断「现在该用哪个账号 / 先花哪一笔」，唯一有用的顺序
 * 就是**最快到期在前**。本项目此前直接按原顺序 `map`，等于把最该看的信息
 * 埋在末尾。
 *
 * ## 三条过滤（命中任一即不显示）
 *
 * 1. `active !== true` —— 已失效，扣不到；
 * 2. 剩余 ≤ 0 —— 没有余额，列出来只是噪音；
 * 3. 到期时刻已过 —— `active` 却没置 false 的包真实存在（TRAE / Qoder 的
 *    `active` 是硬编码 `true`，本仓库记过「面板写临期、附注写已过期」）。
 *
 * ⚠️ **不能只按 `active` 过滤**：三个判据是**独立**的。
 *
 * ## 排序
 *
 * - 主键：到期时刻**升序**（最快到期在上）。
 * - ⚠️ 无到期时间（真·永久）视为 `Infinity` **沉底** —— 语义上它就是
 *   「最晚到期」，按 0 处理会跑到最上面，**恰好说反**。
 * - 次键：同一到期时刻内按**剩余量降序**（先看还有钱的包），也让结果确定
 *   （不依赖引擎的稳定排序）。
 *
 * @param packages - `balance.packages`。
 * @param now - 当前时刻（过滤与排序都是时间的函数，渲染时传）。
 * @returns 新数组；无可用包时 `[]`（调用方据此不挂 title）。
 */
export function sortPackagesForTooltip(packages, now = Date.now()) {
  if (!Array.isArray(packages) || packages.length === 0) return [];
  const at = Number.isFinite(now) ? now : Date.now();
  const usable = packages.filter((pkg) => {
    if (!pkg || pkg.active !== true) return false;
    const remaining = Number(pkg.remaining);
    if (!Number.isFinite(remaining) || remaining <= 0) return false;
    const end = packageExpiryMs(pkg);
    // 到期时刻已过 ⇒ 扣不到，不显示（`end === null` = 真·永久，保留）。
    if (end !== null && end <= at) return false;
    return true;
  });
  return [...usable].sort((a, b) => {
    const endA = packageExpiryMs(a);
    const endB = packageExpiryMs(b);
    const keyA = endA === null ? Infinity : endA;
    const keyB = endB === null ? Infinity : endB;
    if (keyA !== keyB) return keyA - keyB;
    return (Number(b && b.remaining) || 0) - (Number(a && a.remaining) || 0);
  });
}

/**
 * 这个包属于哪一桶的中文标签（逐包明细的括号用）。
 *
 * ⚠️ **「已过期」必须先判**：`active: true` 但到期时刻已过的包会走到这里
 * （`jet-hub.js` 的 `all = balance?.packages || []` **不过滤**），而旧实现直接
 * `${Math.ceil(left)} 天内到期` ⇒ 渲染出 **「-3 天内到期」**，`-0.5 天` 更会因
 * `Math.ceil` 变成「0 天内到期」。
 * 顺序不能反：先判「未知」，再判「已过期」，最后才按窗口分档。
 *
 * @returns `null` = 拿不到窗口天数（调用方据退化成不显示括号）。
 */
export function expiryBucketLabel(pkg, windowDays, now = Date.now()) {
  const days = Number(windowDays);
  const left = daysUntilExpiry(pkg, now);
  if (left === null) return '到期时间未知';
  if (left <= 0) return '已过期';
  if (!Number.isFinite(days)) return null;
  return left < days ? `${Math.ceil(left)} 天内到期` : `还有 ${Math.ceil(left)} 天`;
}

/**
 * 逐包明细那一行的**到期附注**（`距到期 N 天（N 天内到期）`）。
 *
 * ⚠️ 拿不到窗口天数时也要给出「距到期 N 天」—— 它本身就解释了分类依据，
 * 比只显示一个周期结束时间更可读（套餐周期 ≠ 积分有效期）。
 *
 * ⚠️ **已过期必须在这里就截住**：`expiryBucketLabel` 修好「已过期」之后，
 * 本函数仍会拼出 **「距到期 -3 天（已过期）」** —— 一半修好一半没修比全错更难看。
 * 「还有几天到期」这个语义只在**未过期**时成立。
 *
 * @returns `''` = 该包没有到期时间（真·永久，不显示附注）。
 */
export function formatExpiryHint(pkg, windowDays, now = Date.now()) {
  const left = daysUntilExpiry(pkg, now);
  if (left === null) return '';
  if (left <= 0) return '已过期';
  const days = Math.ceil(left);
  const label = expiryBucketLabel(pkg, windowDays, now);
  return label ? `距到期 ${days} 天（${label}）` : `距到期 ${days} 天`;
}

/**
 * 该包距到期还剩多少天（小数）；`null` = 服务端没给到期时间（真·永久）。
 *
 * ⚠️ 与 {@link packageExpiryMs} **同一份判据**（本仓红线：同一语义不得两套判据）。
 */
export function daysUntilExpiry(pkg, now = Date.now()) {
  const end = packageExpiryMs(pkg);
  if (end === null) return null;
  const at = typeof now === 'number' && Number.isFinite(now) ? now : Date.now();
  return (end - at) / (24 * 60 * 60 * 1000);
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
