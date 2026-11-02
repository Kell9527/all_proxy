/**
 * Magicrew 两站（`magicrew` / `magicrewintl`）的**账号判重**。
 *
 * ## 它解决什么（来源 `bd73592` 的 `findMagicrewAccountByFingerprint`）
 *
 * 超级麦吉有三个「建号」入口，而**同一个上游账号**可以反复经过它们：
 *
 * | 入口 | 后端 `mode` | 拿到的东西 |
 * |---|---|---|
 * | 「导入」（读本机浏览器登录态） | `local-browser` | 浏览器 localStorage 里那份 jwt |
 * | 「网页登录」（服务端开窗让用户登） | `browser` | 用户在窗口里登出的 jwt |
 * | 重新登录既有的同一个账号 | 同上 | **新的一份** jwt |
 *
 * 前两种走的是**同一份** jwt ⇒ 指纹相同 ⇒ 必须判重。不判的话，用户
 * 「导入一次、再网页登录一次」就会得到两张指向同一上游账号的卡片：
 * 选号时反复命中同一个号（额度是同一个账号的，用完就一起用完），而面板
 * 显示「2 个账号」。用户视角就是「怎么多了一个账号」（来源 2026-10-29 报障）。
 *
 * ## 判据：`sha256(jwt)` 前 16 位（{@link magicrewCredentialFingerprint}）
 *
 * ⚠️ **不能用 `apiKey`**：它 2 小时一换，会把同一个账号认成新账号。
 * jwt 在 30 天有效期内稳定（续期只换 `mgw_` key、不动 jwt —— 见
 * `magicrew-auth.ts` 的模块头）。
 *
 * ## 三条边界（来源在真实数据上踩过，逐字保留）
 *
 * 1. **读不到凭据的账号要跳过**：`resolveCredentialByRef` 返回 undefined、
 *    或值不是合法 JSON、或没有 `jwt` ⇒ **跳过该账号**（既不判「重复」也不判
 *    「不重复」）。本仓库既定口径：**无法判定 ≠ 失配** —— 判成「不重复」会造出
 *    重复卡片，判成「重复」会**覆盖掉别人的凭据**（后者不可逆）。
 * 2. **按 `provider` 隔离**：两站的 jwt 来自不同 host，指纹本来不会撞；但
 *    不限定 provider 就会**跨站扫池** —— 一旦将来指纹口径变化（例如退化成
 *    「同手机号」），就会出现「登录国际站却把国内站的卡改掉」这种错位。
 * 3. **ref 名不参与判据**：遍历的是该 provider 名下**全部**条目并各自 resolve，
 *    而不是只看 `MAGICREW_ACCOUNT_*` 形态的 ref。
 *
 * ## ⚠️ 已知边界：同一账号**重新登录会拿到新 jwt**
 *
 * 来源实测同一账号两把 jwt（`iat` 差 56 秒、`jti` 不同）⇒ 这种情形**拦不住**，
 * 会各成一张卡。要真正闭合需要上游的稳定账号标识（当前没有）。
 * 故本模块**只**覆盖「导入 + 网页登录用的是同一份 jwt」这一主流形态。
 */

import type { AccountPool } from '../pool/account-pool.js'
import type { ProviderAccountEntry } from '../pool/types.js'
import { magicrewCredentialFingerprint } from '../providers/magicrew-auth.js'
import { isMagicrewProvider } from '../providers/magicrew-product.js'

/**
 * 在账号池里找**同一个超级麦吉账号**的既有条目。
 *
 * @param pool - 账号池（只读）。
 * @param provider - `magicrew` 或 `magicrewintl`（判重只在同 provider 内进行）。
 * @param fingerprint - 本次凭据的 {@link magicrewCredentialFingerprint}；空串 ⇒ 不判重。
 * @param skipAccountId - 需要跳过的条目 id（占位账号场景用；见模块头边界 ③）。
 * @returns 既有条目；provider 不在支持范围、或判据读不到时返回 undefined。
 */
export async function findExistingMagicrewAccount(
  pool: AccountPool,
  provider: string,
  fingerprint: string,
  skipAccountId?: string,
): Promise<ProviderAccountEntry | undefined> {
  // ⚠️ 用 `isMagicrewProvider`（全仓唯一判据）而不是字面量比较：散落写
  //    `provider === 'magicrew'` 会让国际站静默漏掉判重。
  if (!isMagicrewProvider(provider)) return undefined
  if (typeof fingerprint !== 'string' || fingerprint.length === 0) return undefined
  /**
   * ⚠️ **判重失败绝不能挡住建号**（本函数是「建号之前」的一个优化，不是前置条件）：
   * 池实现缺少 / 变更了遍历能力时，本函数必须**退化为「不判重」**而不是抛错
   * —— 抛错会让一次本来完全正常的导入变成「导入失败」，而用户完全无从理解
   * （症状：点导入就报错，凭据其实好好的）。
   *
   * ⚠️ 这类防御**不做成静默**：留一条 warn 让「判重不生效」在日志里可见，
   * 否则重复卡片会以「看不出原因」的形态复发（本仓库记过多次「静默降级」事故）。
   */
  const entries = typeof pool.listAccountsByProvider === 'function'
    ? pool.listAccountsByProvider(provider)
    : undefined
  if (entries === undefined) return undefined
  for (const entry of entries) {
    if (entry.id === skipAccountId) continue
    const credential = await pool.resolveCredentialByRef(entry.credentialRef)
    // ⚠️ 边界 ①：读不到 ⇒ 跳过（既不判「重复」也不判「不重复」）。
    if (credential === undefined) continue
    const jwt = credential['jwt']
    if (typeof jwt !== 'string') continue
    if (magicrewCredentialFingerprint(jwt) === fingerprint) return entry
  }
  return undefined
}