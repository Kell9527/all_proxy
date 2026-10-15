/**
 * OfficeAce 账号管理页的**积分消耗顺序**说明（2026-10-15 用户指定）。
 *
 * ## 它说明什么
 *
 * OfficeAce（华为云 ModelArts MaaS）的积分不是「一个数」，而是**一组带到期
 * 时间的积分包**（面板分「永久 / 长期 / 临期」三桶）。多账号时服务端按
 *
 * 1. 临期（距到期不足 15 天）→ 2. 长期 → 3. 永久
 *
 * 的顺序选号。不这么做的话，排在首位的账号会先把**自己的永久积分**烧掉，
 * 而另一个账号里的**临期积分**到期作废 —— 用户要的恰恰是反过来。
 *
 * ## 什么时候不显示
 *
 * - 非 OfficeAce provider：这句话与它们无关；
 * - 账号数 < 2：只有一个号可发，排序没有意义，显示出来只是噪音。
 *
 * ⚠️ 判据必须是「账号数」而不是「积分桶数」：选号发生在**服务端**，账号
 * 少于两个时它根本无从选择。
 */

/** 「长期 / 临期」的分界天数（与后端、`credit-expiry.js` 同值，仅用于文案）。 */
export const OFFICEACE_EXPIRY_WINDOW_DAYS_HINT = 15;

/**
 * @param provider - 当前面板的 provider id。
 * @param accountCount - 该 provider 的账号数（含已停用，与列表同源）。
 * @returns 说明文案；不该显示时返回 `null`（调用方据此整块不渲染）。
 */
export function officeaceConsumeOrderNotice(provider, accountCount) {
  if (provider !== 'officeace') return null;
  const count = Number(accountCount);
  if (!Number.isFinite(count) || count < 2) return null;
  return `积分按到期顺序消耗：先用临期（${OFFICEACE_EXPIRY_WINDOW_DAYS_HINT} 天内到期）→ 再用长期 → `
    + '最后永久；同一档内按上面的账号顺序（拖拽排序仍然有效）。'
    + '各账号的三档余额见卡片「积分」行。';
}
