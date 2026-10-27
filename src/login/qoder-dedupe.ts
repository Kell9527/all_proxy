/**
 * Qoder 系（`qoder` 国际版 / `qodercn` 中国版）登录的**账号判重**。
 *
 * ## 它解决什么（用户 2026-10-27 报障）
 *
 * 「Qoder (中国版) 账号管理 —— 同一个账号可以多次登录，增加多个条目，
 * 这是不合理的」
 *
 * 实测证据：`data/state.json` 里的 `QODERCN_ACCOUNT_7163975E`、
 * `89A8A579`、`AC71826E` 三条条目，对应的凭据 `uid` **逐字相同**
 * （`01a0b3…fa77`）—— 同一个上游账号被登录三次，堆出三条看起来不同的
 * 条目。危害与 OfficeAce 那批重复条目同型：选号时反复命中同一个上游账号，
 * 用户以为在轮换（但额度是同一个账号的，用完就一起用完），而面板上却
 * 显示「3 个账号」。
 *
 * ## 判据
 *
 * Qoder 凭据里的 **`uid`**（设备码响应 `user_id` → `parseQoderTokenPayload`
 * → `buildQoderCredential` 写入，见 `qoder.ts`）。它按账号稳定，且续期
 * （`applyQoderRefresh`）会**保留**它 —— 故登录与续期两条路径都能拿到同一个值。
 *
 * ## 为什么判重必须**按 provider 隔离**
 *
 * `qoder` 与 `qodercn` 是两个独立站点（不同的 `openApiBase` / `authBase`），
 * 各自下发自己的 `uid`。「看起来相同的 uid 是否真是同一个账号」这件事
 * **无法跨站推断**，而判错方向会造成丢账号（把两个不同账号合成一个），
 * 代价远大于重复条目。故只在**同一个 provider** 的账号里比对。
 *
 * ⚠️ 读不到 `uid` 时（老凭据、迁移数据）**不判重**：与
 * `officeace-dedupe.ts` 同一条纪律 —— 宁可重复也不误判。
 */

import type { AccountPool } from '../pool/account-pool.js'
import type { ProviderAccountEntry } from '../pool/types.js'

/** 支持判重的 provider（同源两站，共用一个适配器与凭据形状）。 */
export const QODER_DEDUPE_PROVIDERS: ReadonlySet<string> = new Set(['qoder', 'qodercn'])

/** 从序列化凭据里读 `uid`；读不到返回 undefined（不判重）。 */
function readUid(credentialJson: string): string | undefined {
  try {
    const parsed = JSON.parse(credentialJson) as { uid?: unknown; user_id?: unknown }
    for (const value of [parsed.uid, parsed.user_id]) {
      if (typeof value === 'string' && value.length > 0) return value
    }
    return undefined
  } catch {
    return undefined
  }
}

/**
 * 在账号池里找**同一个 Qoder 账号**的既有条目。
 *
 * @param pool - 账号池（只读）。
 * @param provider - `qoder` 或 `qodercn`（判重只在同 provider 内进行）。
 * @param credentialJson - 本次登录刚落定的凭据 JSON（含 `uid`）。
 * @returns 既有条目；provider 不在支持列表、或判据读不到时返回 undefined。
 */
export async function findExistingQoderAccount(
  pool: AccountPool,
  provider: string,
  credentialJson: string,
): Promise<ProviderAccountEntry | undefined> {
  if (!QODER_DEDUPE_PROVIDERS.has(provider)) return undefined
  const uid = readUid(credentialJson)
  if (uid === undefined) return undefined
  for (const entry of pool.accountsOf(provider)) {
    const credential = await pool.resolveCredentialByRef(entry.credentialRef)
    if (credential?.['uid'] === uid) return entry
    // 迁移凭据可能只带 `user_id`（旧字段名），一并认。
    if (credential?.['user_id'] === uid) return entry
  }
  return undefined
}
