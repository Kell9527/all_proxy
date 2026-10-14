/**
 * OfficeAce 登录的**账号判重**（防「重复登录多次」变成重复条目）。
 *
 * ## 它解决什么（用户 2026-10-14 报障）
 *
 * 「OfficeAce 新建账号每次都会自动登录同一个账号，且重复登录多次」—— 除了
 * 前端不再自动开窗（见 `plugin-src/client/login-window-policy.js`），还有
 * 一个后果要兜底：用户不小心把**同一个账号**授权了 N 次，账号池里就出现 N
 * 条指向同一账号的条目。它们看起来是 N 个账号，实际是 1 个 —— 选号时反复
 * 选中同一个上游账号，用户却以为在轮换。
 *
 * ## 判据
 *
 * OfficeAce 凭据里的 `accountId`（`fetchModelInfo` 从
 * `/v1/claw/client-permission-validate` 响应的 `account_id` 写入，**按账号
 * 稳定**）。池里已有同 `accountId` 的条目 ⇒ 判为同一账号，**不新建条目**，
 * 沿用既有条目（前端据此提示「该账号已在池中」）。
 *
 * ⚠️ 读不到 `accountId` 时（老条目/迁移凭据）**不判重**：宁可重复也不误判
 * —— 把两个不同账号合成一个，用户会直接丢掉一个账号。
 */

import type { AccountPool } from '../pool/account-pool.js'
import type { ProviderAccountEntry } from '../pool/types.js'

/** 从序列化凭据里读 `accountId`；读不到返回 undefined（不判重）。 */
function readAccountId(credentialJson: string): string | undefined {
  try {
    const parsed = JSON.parse(credentialJson) as { accountId?: unknown }
    return typeof parsed.accountId === 'string' && parsed.accountId.length > 0
      ? parsed.accountId
      : undefined
  } catch {
    return undefined
  }
}

/**
 * 在账号池里找**同一个 OfficeAce 账号**的既有条目。
 *
 * @param pool - 账号池（只读）。
 * @param credentialJson - 本次登录刚落定的凭据 JSON（含 `accountId`）。
 * @returns 既有条目；没有（或判据读不到）时返回 undefined。
 */
export async function findExistingOfficeAceAccount(
  pool: AccountPool,
  credentialJson: string,
): Promise<ProviderAccountEntry | undefined> {
  const accountId = readAccountId(credentialJson)
  if (accountId === undefined) return undefined
  for (const entry of pool.accountsOf('officeace')) {
    const credential = await pool.resolveCredentialByRef(entry.credentialRef)
    if (credential?.['accountId'] === accountId) return entry
  }
  return undefined
}
