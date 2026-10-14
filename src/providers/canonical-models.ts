/**
 * 跨渠道模型**归一化**（本项目只移植 Accio 用到的部分）。
 *
 * ## 为什么只搬这两个函数
 *
 * 来源的 `canonical-models.ts` 主要服务**聚合 provider**（跨渠道归组、规范键、
 * 显示名补丁）。本项目**没有**跨渠道聚合，故那些能力整体不适用。
 *
 * 但 Accio 的**对外 id** 需要「把展示名归一成 slug」（`qwen-3-8-flash`）——
 * 这正是 `normalizeNameKey` 的职责，且来源明确要求它与聚合**共用同一套规则**
 * （两处各写一份必然漂移）。故这里**逐字保留**该归一化，供 `accio-adapter.ts`
 * 使用。将来若引入聚合，可把来源其余部分补齐。
 */

/**
 * 把一个模型 id 归一成候选键。
 *
 * 步骤（顺序有意为之）：
 * 1. 剥命名空间前缀（取最后一个 `/` 之后）：`cline-free/x` → `x`；
 * 2. 去 `:free` 后缀；
 * 3. 剥 `sn-` 前缀（raccoon）；
 * 4. **所有点号转连字符**；
 * 5. 空格转连字符（展示名通道会用到）；
 * 6. 全小写。
 *
 * ⚠️ 第 4 步是「所有点号」而不是「版本号里的点号」—— `deepseek-v4.1-flash` →
 * `deepseek-v4-1-flash`，而 `deepseek-v4-flash` 保持原样，两者仍不同（安全）。
 */
export function normalizeModelKey(raw: string): string {
  let s = raw.trim().toLowerCase()
  const slash = s.lastIndexOf('/')
  if (slash >= 0) s = s.slice(slash + 1)
  s = s.replace(/:free$/, '')
  s = s.replace(/^sn-/, '')
  s = s.replace(/\./g, '-')
  s = s.replace(/\s+/g, '-')
  return s
}

/**
 * 把一条**展示名**归一成候选键：先剥掉非模型信息，再走 {@link normalizeModelKey}。
 *
 * 要剥掉：倍率后缀 ` · x0.75`（`·` 是倍率分隔符 U+00B7）、「免费」标注。
 */
export function normalizeNameKey(name: string): string {
  const stripped = name
    .replace(/\s*·.*$/, '')
    .replace(/免费/g, '')
    .trim()
  return normalizeModelKey(stripped)
}
