/**
 * `account-pool.js` 的转发 shim。
 *
 * 从来源移植的 provider 文件写的是 `from './account-pool.js'`（它们与来源的
 * `account-pool.ts` 同目录）。本项目的账号池在 `src/pool/account-pool.ts`，
 * 故这里转发出去，让移植文件**无需改动 import 路径**。
 *
 * ⚠️ 只做转发与补齐来源有、本项目已删的导出。
 */
export { AccountPool } from '../pool/account-pool.js'
export type { AccountPoolOptions } from '../pool/account-pool.js'

/**
 * 模型目录门控（来源用它决定 DSH 是否隐藏整个 provider 分组）。
 *
 * ⚠️ 本项目**刻意不实现该门控**（见 AGENTS.md 的分叉点表）：它只影响 DSH
 * 模型选择器的分组显示，不改路由；对外 API 的可见性由 `GET /v1/models` 与
 * 三层模型开关决定。
 *
 * 这里保留同名导出并**恒返回 true**（= 门控放行），原因有二：
 * 1. 移植的适配器文件在 `listModels` 里调用它，删掉会让每个文件都要改实现；
 * 2. 恒 true 恰好等于「不隐藏任何 provider」，正是本项目想要的行为。
 *
 * ⚠️ 参数刻意保留（虽然不使用）：移植文件传的是
 * `(this.options.accountPool, this.product.id)`，改签名会让 8 个适配器都要改。
 */
export async function providerCatalogVisible(
  _accountPool?: unknown,
  _provider?: string,
): Promise<boolean> {
  return true
}
