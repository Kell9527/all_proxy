/**
 * 「当前选中账号」的登记处。
 *
 * 独立成模块的原因：适配器在**换号重试**后必须把实际用上的账号登记回来，
 * 否则两处依赖「当前账号」的逻辑都会指错人 ——
 * 1. `index.ts` 的 `wiringRefresh` 按「当前账号」定向续期：换号后不登记，
 *    401 刷新路径会去刷**旧账号**，一次性轮换 `refresh_token` 的 provider
 *    （raccoon 等）会把仅剩的一次刷新机会白白烧在错误的账号上；
 * 2. 网关的用量记录（`accountIdFor`）会归属到旧账号。
 *
 * ⚠️ 不能放回 `wiring.ts`：wiring import 各适配器，适配器再回头 import
 * wiring 就成了模块循环依赖。抽到无依赖的独立模块，两边都能安全引用。
 */

/** 当前选中的账号 id（provider → accountId），供适配器标注限流与用量记录。 */
const currentAccountIds = new Map<string, string>()

/** 记录本次实际选中的账号。 */
export function recordCurrentAccount(provider: string, accountId: string): void {
  currentAccountIds.set(provider, accountId)
}

/** 读取当前选中的账号 id。 */
export function currentAccountIdFor(provider: string): string | undefined {
  return currentAccountIds.get(provider)
}
