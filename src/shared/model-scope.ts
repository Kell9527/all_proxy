/**
 * API Key 授权范围的判定（provider / 模型白名单）。
 *
 * ## 为什么单独成文件
 *
 * 同一套判定有**两个消费方**：
 * 1. 网关的模型解析（决定这次调用放不放行）；
 * 2. 管理端与 `/v1/models` 的目录过滤（决定列表里出现什么）。
 *
 * 若两处各写一份，迟早分叉成「目录里看得到、调用时被拒」这类自相矛盾的行为
 * —— 用户完全无法从现象推断原因。故这里是**唯一实现**。
 *
 * 本文件零依赖，因此 `gateway/` 与 `admin/` 都能安全引用，不会形成循环。
 */

/**
 * 授权范围。
 *
 * ⚠️ **「省略」与「空数组」语义不同**：省略 = 不限制；空数组 = 一个都不许。
 * 把空数组当成「未配置」会让用户刻意设成「禁止一切」的 key 变成万能 key。
 */
export interface ModelScope {
  /** 允许的 provider 列表；省略 = 不限制。 */
  providers?: readonly string[]
  /** 允许的模型 ref 列表（支持 `<provider>/*` 通配）；省略 = 不限制。 */
  models?: readonly string[]
}

/**
 * 判断某模型是否落在授权范围内。
 *
 * 规则（两者都配置时**取交集**，都通过才放行）：
 * - `providers` 存在且不含该 provider → 拒绝；
 * - `models` 存在且无一命中该 ref → 拒绝。命中规则为**全等**或 `<provider>/*`。
 *
 * @param scope - 授权范围；`undefined` 表示不限制。
 * @param provider - provider id。
 * @param model - 上游原始模型 id（不含前缀）。
 */
export function scopeAllows(scope: ModelScope | undefined, provider: string, model: string): boolean {
  if (scope === undefined) return true
  if (scope.providers !== undefined && !scope.providers.includes(provider)) return false
  if (scope.models !== undefined) {
    const ref = `${provider}/${model}`
    const allowed = scope.models.some((pattern) => {
      if (pattern === ref) return true
      // `<provider>/*` 通配整个 provider。
      if (pattern.endsWith('/*')) return pattern.slice(0, -2) === provider
      return false
    })
    if (!allowed) return false
  }
  return true
}
