/**
 * 模型解析：把对外的 `<provider>/<model>` 解析为一个可调用的目标。
 *
 * 这是**硬拦截**的落地点（规格 `model-switching`）：三层开关任一层关闭即
 * 返回 `model_not_found`，且**不发起任何上游请求**。
 *
 * ⚠️ 与来源的关键差异：来源的开关只影响 `listModels` 的目录（AGENTS.md 明确
 * 记载「被关闭的模型仍可被 `resolveModel` 解析、仍能正常收发请求」）。对外提供
 * API 时那样等于开关形同虚设 —— 调用方知道模型名就能绕过。故本项目改为硬拦截。
 */

import type { AccountPool } from '../pool/account-pool.js'
import type { ProviderRegistry, RegisteredProvider } from '../providers/registry.js'
import { parseModelRef } from '../providers/registry.js'
import { gatewayError, type GatewayError } from './errors.js'
import { scopeAllows, type ModelScope } from '../shared/model-scope.js'

/**
 * 转发授权范围的类型与判定，让调用方继续从本模块 import。
 *
 * 实现体在 `shared/model-scope.ts`（网关与管理端共用同一份判定，
 * 避免「目录里看得到、调用时被拒」这类分叉）。
 */
export { scopeAllows } from '../shared/model-scope.js'
export type { ModelScope } from '../shared/model-scope.js'

/** 解析成功的结果。 */
export interface ResolvedTarget {
  ok: true
  provider: RegisteredProvider
  /** 上游原始模型 id。 */
  model: string
  /** 对外完整标识（`<provider>/<model>`）。 */
  ref: string
}

/** 解析失败的结果。 */
export interface ResolveFailure {
  ok: false
  error: GatewayError
}

/** 模型解析器。 */
export class ModelResolver {
  constructor(
    private readonly registry: ProviderRegistry,
    private readonly pool: AccountPool,
  ) {}

  /**
   * 解析对外模型标识。
   *
   * 检查顺序（**任一失败即返回，且不触达上游**）：
   * 1. 格式：必须是 `<provider>/<model>`；
   * 2. provider 已注册；
   * 3. **API Key 授权范围**（`scope`）；
   * 4. 三层模型开关。
   *
   * ⚠️ **授权先于开关**：范围外的模型一律回 `model_not_authorized`，与它是否
   * 被开关关闭无关。若先判开关，受限 key 就能通过「错误消息是 `已被关闭` 还是
   * `不存在`」探测出服务端有哪些模型被关闭 —— 那是它无权得知的配置。
   *
   * @param raw - 请求里的 `model` 字段。
   * @param scope - 调用方的授权范围；`undefined` 表示不限制。
   */
  resolve(raw: unknown, scope?: ModelScope): ResolvedTarget | ResolveFailure {
    const parsed = parseModelRef(raw)
    if (!parsed.ok) {
      // 裸名与缺字段都给同一条指引：告诉调用方正确写法。
      const message = parsed.reason === 'missing'
        ? 'model 字段缺失或不是字符串'
        : parsed.reason === 'no-prefix'
          ? `模型名必须是 "<provider>/<model>" 形式（收到 "${String(raw)}"）`
          : parsed.reason === 'empty-provider'
            ? '模型名的 provider 部分为空'
            : '模型名的 model 部分为空'
      return { ok: false, error: gatewayError(404, 'model_not_found', message) }
    }

    const provider = this.registry.get(parsed.provider)
    if (provider === undefined) {
      return {
        ok: false,
        error: gatewayError(
          404,
          'model_not_found',
          `未知 provider "${parsed.provider}"（可用: ${this.registry.ids().join(', ')}）`,
        ),
      }
    }

    // API Key 授权范围：403 而非 404 —— 模型确实存在，是这把 key 无权访问。
    if (!scopeAllows(scope, parsed.provider, parsed.model)) {
      return {
        ok: false,
        error: gatewayError(
          403,
          'model_not_authorized',
          `当前 API Key 无权访问 "${parsed.provider}/${parsed.model}"`,
        ),
      }
    }

    // 三层开关：全局 → provider → 单模型。硬拦截，不发上游请求。
    const availability = this.pool.modelAvailability(parsed.provider, parsed.model)
    if (!availability.allowed) {
      return {
        ok: false,
        error: gatewayError(
          404,
          'model_not_found',
          `模型 "${parsed.provider}/${parsed.model}" 已被关闭（${describeBlockLayer(availability.blockedBy)}）`,
        ),
      }
    }

    return { ok: true, provider, model: parsed.model, ref: `${parsed.provider}/${parsed.model}` }
  }
}

/** 把拦截层级翻译成可读原因。 */
function describeBlockLayer(layer: 'global' | 'provider' | 'model' | undefined): string {
  switch (layer) {
    case 'global': return '全局总开关已关闭'
    case 'provider': return '该 provider 已被关闭'
    case 'model': return '该模型开关已关闭'
    default: return '不可用'
  }
}

/**
 * 列出**全部**模型（含被关闭的），供管理端模型开关界面。
 *
 * ⚠️ 被关闭的模型**必须**出现在这里，否则用户无法重新开启（规格
 * `admin-console`：列出含已关闭的全部模型）。每项带 `disabled` 标注与
 * 最终可用性归因（`modelAvailability`），界面直接渲染即可。
 */
export async function listAllModelsForAdmin(
  registry: ProviderRegistry,
  pool: AccountPool,
): Promise<Array<{
  id: string
  provider: string
  model: string
  name: string
  contextWindow?: number
  disabled: boolean
  /** 不可用时的归因层级（global / provider / model）。 */
  blockedBy?: string
}>> {
  const globalEnabled = pool.globalModelsEnabled()
  const out: Array<{
    id: string
    provider: string
    model: string
    name: string
    contextWindow?: number
    disabled: boolean
    blockedBy?: string
  }> = []
  for (const { descriptor, adapter } of registry.list()) {
    const providerEnabled = pool.providerEnabled(descriptor.id)
    const disabled = pool.disabledModelsFor(descriptor.id)
    let models: readonly { id: string; name: string }[]
    try {
      // ⚠️ 先调 listModels 再调 listAllModels：前者的副作用是把远端目录拉进
      // 缓存（ensureRemoteModels），后者才读得到；顺序反了就只有兜底表。
      await adapter.listModels(descriptor.id)
    } catch {
      // 目录拉取失败不阻断列表（该 provider 仍可能有缓存目录）。
    }
    // 显示列表必须**含被关闭的模型**（否则用户无法重新开启），且要带倍率
    // 展示名——listAllModels 正是为此存在（Buddy/Lobsterai 适配器实现，
    // 不受黑名单过滤）。没有该方法的适配器退化为 listModels。
    try {
      const listAll = (adapter as unknown as { listAllModels?: (provider: string) => readonly { id: string; name: string }[] }).listAllModels
      models = typeof listAll === 'function'
        ? listAll.call(adapter, descriptor.id)
        : await adapter.listModels(descriptor.id)
    } catch {
      continue
    }
    for (const model of models) {
      const modelDisabled = disabled.has(model.id)
      let contextWindow: number | undefined
      try {
        const resolved = await adapter.resolveModel(descriptor.id, model.id)
        contextWindow = resolved.context?.contextWindow
      } catch {
        // 解析失败不影响列出。
      }
      // 归因层级与 model-switching 的判定顺序一致：全局 → provider → 模型。
      const blockedBy = !globalEnabled
        ? 'global'
        : !providerEnabled
          ? 'provider'
          : modelDisabled
            ? 'model'
            : undefined
      out.push({
        id: `${descriptor.id}/${model.id}`,
        provider: descriptor.id,
        model: model.id,
        name: model.name,
        ...contextWindow === undefined ? {} : { contextWindow },
        disabled: blockedBy !== undefined,
        ...(blockedBy !== undefined ? { blockedBy } : {}),
      })
    }
  }
  return out
}

/**
 * 列出当前可用的全部模型（供 `GET /v1/models`）。
 *
 * 三层开关的过滤在这里体现：全局关闭 → 空列表；provider 关闭 → 跳过该
 * provider；单模型关闭 → 跳过该模型。
 *
 * @param registry - provider 注册表。
 * @param pool - 账号池（提供开关状态）。
 * @param scope - 调用方的授权范围；`undefined` 表示不限制。
 * @returns 每项含对外完整标识与展示名。
 */
export async function listAvailableModels(
  registry: ProviderRegistry,
  pool: AccountPool,
  scope?: ModelScope,
): Promise<Array<{
  id: string
  provider: string
  model: string
  name: string
  contextWindow?: number
  supportsImage: boolean
}>> {
  // 全局总开关：关闭后所有模型都不可用（返回空列表）。
  if (!pool.globalModelsEnabled()) return []

  const out: Array<{
    id: string
    provider: string
    model: string
    name: string
    contextWindow?: number
    supportsImage: boolean
  }> = []

  for (const { descriptor, adapter } of registry.list()) {
    if (!pool.providerEnabled(descriptor.id)) continue
    // provider 级范围：整组被排除时连目录都不必拉取（省一次上游请求）。
    if (scope?.providers !== undefined && !scope.providers.includes(descriptor.id)) continue
    const disabled = pool.disabledModelsFor(descriptor.id)
    let models: readonly { id: string; name: string; inputModalities?: readonly string[] }[]
    try {
      models = await adapter.listModels(descriptor.id)
    } catch {
      // 单个 provider 的目录失败不该让整个列表失败（规格 provider-routing）。
      continue
    }
    for (const model of models) {
      if (disabled.has(model.id)) continue
      // 模型级范围：与开关取交集（两者都放行才出现在列表里）。
      if (!scopeAllows(scope, descriptor.id, model.id)) continue
      // 上下文窗口要单独解析：`listModels` 的条目不含它（那是 `resolveModel` 的职责）。
      let contextWindow: number | undefined
      try {
        const resolved = await adapter.resolveModel(descriptor.id, model.id)
        contextWindow = resolved.context?.contextWindow
      } catch {
        // 解析失败不影响列出该模型。
      }
      out.push({
        id: `${descriptor.id}/${model.id}`,
        provider: descriptor.id,
        model: model.id,
        name: model.name,
        ...contextWindow === undefined ? {} : { contextWindow },
        supportsImage: model.inputModalities?.includes('image') === true,
      })
    }
  }
  return out
}
