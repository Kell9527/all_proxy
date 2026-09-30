/**
 * `settings-compat.js` 的转发 shim。
 *
 * 来源用它做 DSH settings 服务的**版本兼容**（≤0.1.6 有 `register`、
 * 0.1.7+ 换成 SettingsForms）。本项目是独立服务，**没有 settings 服务**，
 * 故这里给出最小等价实现：命名空间按来源的约定派生，其余能力探测一律
 * 返回「不可用」。
 *
 * ⚠️ 移植的 provider 文件只在一个地方用它 —— `register*Llm()` 里算
 * `settingsNs`。本项目不用那个字段（注册表由 `src/providers/registry.ts`
 * 负责），故这里的返回值**不参与任何实际行为**。
 */

/**
 * 派生一个 provider 的 settings 命名空间。
 *
 * 来源语义：0.1.7+ 下命名空间只能是 profile 条目 id；这里保留同样的
 * 前缀形态，纯粹为了让移植文件不必改实现。
 */
export function settingsNamespaceFor(_ctx: unknown, fallback: string): string {
  return fallback
}

/** 取 settings 服务。本项目恒无。 */
export function settingsOf(_ctx: unknown): undefined {
  return undefined
}

/** 老契约（settings 支持插件注册 namespace）是否可用。本项目恒否。 */
export function hasLegacyNamespaceRegistration(_settings: unknown): boolean {
  return false
}

/** 抑制 DSH 自动生成的设置页。本项目无此概念，空实现。 */
export function suppressAutoSettingsPage(_ctx: unknown): void {}

/** 读取任意宿主服务。本项目无此概念，恒返回 undefined。 */
export function readService(_ctx: unknown, _name: string): undefined {
  return undefined
}
