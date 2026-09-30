/**
 * `credentialRef` 的本地实现。
 *
 * DSH 用它把字符串标记为 branded 的 `CredentialRef`（编译期品牌，运行时恒等）。
 * 本项目的凭据存储直接以字符串为键，故这里就是恒等函数 —— 这样从来源移植过来
 * 的 `credentialRef(entry.credentialRef)` 调用点**无需任何改动**。
 */

/** 凭据引用（运行时是普通字符串）。 */
export type CredentialRef = string & { readonly __brand?: 'CredentialRef' }

/** 把字符串标记为凭据引用（运行时恒等）。 */
export function credentialRef(value: string): CredentialRef {
  return value as CredentialRef
}
