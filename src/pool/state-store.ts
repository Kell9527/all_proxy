/**
 * 账号索引 + 模型黑名单的持久化文档。
 *
 * ## 与来源的差异
 *
 * 来源 `jet-hub-store.ts` 有三条后端（老 settings / 文件 / 内存），因为它要
 * 兼容 DSH 的版本差异。本项目是独立服务，**只需要文件后端** —— 但**保留
 * 「整体写入」这一核心约定**：
 *
 * ⚠️ **三个字段必须一起写回**（账号 / 黑名单 / 全局开关）。只写其中一个会把
 * 同一文档里的另外两个抹掉。来源在这上面踩过两次（`disabledModels` 与
 * `loomyPermanentLocked` 各一次），故这里把它写进类型与每个写入点。
 */

import { join } from 'node:path'
import type { ProviderAccountEntry } from './types.js'
import { readJsonFile, writeFileAtomic, type Logger } from './store.js'

/**
 * 模型黑名单：provider id → **被关闭**的模型 id → true。
 *
 * **黑名单制**：只有键存在且为 `true` 的模型被隐藏，未记录的模型默认打开。
 * 这样上游新增模型时无需任何配置就会自动出现，不会被静默挡在门外。
 */
export type ModelDisableMap = Record<string, Record<string, boolean>>

/** 持久化文档结构。 */
export interface PoolState {  accounts: ProviderAccountEntry[]
  disabledModels: ModelDisableMap
  /** 全局总开关：关闭后所有模型都不可用（规格 `model-switching` 的第一层）。 */
  globalModelsEnabled?: boolean
  /**
   * provider 级开关（规格 `model-switching` 的第二层）：provider id → 是否关闭。
   *
   * **刻意与 {@link disabledModels} 分开**：模型黑名单的语义是「键存在且为 true
   * 即隐藏该模型」，若把「整个 provider 关闭」塞进同一张表（例如用哨兵键），
   * 该哨兵会出现在 `listDisabledModels` 的返回里、被管理端渲染成一个不存在的
   * 模型条目。两者是不同维度，分开存更清晰。
   */
  disabledProviders?: Record<string, boolean>
  /**
   * 「锁定永久积分」开关（**按 provider**，Loomy 与 OfficeAce 各自独立）。
   *
   * 锁定后选号**只允许消耗临时/临期额度**，永久积分不参与 —— 只剩永久积分的
   * 账号在锁定期间等同于不可用。
   *
   * ⚠️ 这是**全局**开关（不分账号），也是本状态文档的字段之一：每个写入点都
   * 必须携带它，漏一处就会被整体写入抹掉。
   */
  permanentLocks?: Record<string, boolean>
  /**
   * Loomy「锁定永久积分」的**兼容镜像**（由 `permanentLocks.loomy` 同步写出）。
   *
   * 保留它只为读旧文档与旧备份：载入时若 `permanentLocks` 缺席而该字段为
   * true，等价于 `permanentLocks.loomy = true`。
   */
  loomyPermanentLocked?: boolean
  /**
   * 开关变更审计记录（**只保留最近若干条**）。
   *
   * 用途：排查「模型突然不可用」——用户需要知道是**谁/什么时候**把它关掉的。
   * 只记元数据（时间、层级、目标），**不记凭据**。
   *
   * ⚠️ 刻意限制长度：这是诊断信息，不是业务数据；无限增长会让状态文档膨胀。
   */
  switchAudit?: SwitchAuditEntry[]
}

/** 一条开关变更记录。 */
export interface SwitchAuditEntry {
  /** 变更时刻（ISO 字符串）。 */
  at: string
  /** 被修改的层级。 */
  layer: 'global' | 'provider' | 'model'
  /** 目标标识（provider id，或 `provider/model`）。 */
  target: string
  /** 变更后的状态：`true` = 可用（打开），`false` = 不可用（关闭）。 */
  enabled: boolean
}

/** 审计记录保留条数上限。 */
export const SWITCH_AUDIT_LIMIT = 200

/**
 * 归一化审计记录。
 *
 * 文档可能被手工编辑过，故逐条校验字段；坏条目直接丢弃而不是让整次载入失败。
 */
export function sanitizeSwitchAudit(raw: unknown): SwitchAuditEntry[] {
  if (!Array.isArray(raw)) return []
  const out: SwitchAuditEntry[] = []
  for (const entry of raw) {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) continue
    const candidate = entry as Partial<SwitchAuditEntry>
    if (typeof candidate.at !== 'string' || candidate.at.length === 0) continue
    if (candidate.layer !== 'global' && candidate.layer !== 'provider' && candidate.layer !== 'model') continue
    if (typeof candidate.target !== 'string') continue
    if (typeof candidate.enabled !== 'boolean') continue
    out.push({
      at: candidate.at,
      layer: candidate.layer,
      target: candidate.target,
      enabled: candidate.enabled,
    })
  }
  // 只保留最近 N 条（按时间字符串排序即可，ISO 格式字典序等于时间序）。
  return out.slice(-SWITCH_AUDIT_LIMIT)
}

/**
 * 把读到的原始值归一化为 provider 级开关表。
 *
 * 只保留显式 `true`（关闭）的 provider；未记录即视为开启。
 */
export function sanitizeDisabledProviders(raw: unknown): Record<string, boolean> {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return {}
  const result: Record<string, boolean> = {}
  for (const [provider, flag] of Object.entries(raw as Record<string, unknown>)) {
    if (flag === true) result[provider] = true
  }
  return result
}

/**
 * 归一化「锁定永久积分」表：只收**显式布尔**（`true` 才入表）。
 *
 * 与 {@link sanitizeDisabledProviders} 同形（键存在即真值），但多一层：
 * 非布尔值（字符串 `'true'` / 数字 `1`）一律丢弃 —— 锁是**写操作的门控**，
 * 手改文档时一个 loosely-truthy 值会让用户在不知情时被锁上。
 */
export function sanitizePermanentLocks(raw: unknown): Record<string, boolean> {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return {}
  const result: Record<string, boolean> = {}
  for (const [provider, flag] of Object.entries(raw as Record<string, unknown>)) {
    if (flag === true) result[provider] = true
  }
  return result
}

/**
 * 来源里这个类型叫 `JetHubState`。
 *
 * 保留别名是为了让从来源移植过来的 `backup.ts` 等文件**无需改动 import**。
 */
export type JetHubState = PoolState

/**
 * 把读到的原始值归一化为 {@link ModelDisableMap}。
 *
 * 文档可能被手工编辑过、或残留老版本格式（如数组），因此逐层校验：任何一层
 * 不是对象就丢弃那一层，只保留「provider → 模型 → true」。**只把显式 `true`
 * 视为关闭**，其余值一律忽略，避免与 `disabledModelsFor` 的判定产生分歧。
 */
export function sanitizeDisabledModels(raw: unknown): ModelDisableMap {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return {}
  const result: ModelDisableMap = {}
  for (const [provider, value] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) continue
    const perProvider: Record<string, boolean> = {}
    for (const [modelId, flag] of Object.entries(value as Record<string, unknown>)) {
      if (flag === true) perProvider[modelId] = true
    }
    // 空表不保留：不让文档里留下 `{ provider: {} }` 这类无意义噪音。
    if (Object.keys(perProvider).length > 0) result[provider] = perProvider
  }
  return result
}

/**
 * 归一化账号条目数组。
 *
 * 判据刻意保守：只保留同时具备 `id` / `provider` / `credentialRef` 三个非空
 * 字符串的条目 —— 缺任何一个都无法解析凭据，留着只会在选号时反复失败。
 * 其余字段按原样透传（`enabled` / `modelRateLimits` 等由下游各自判空）。
 */
export function sanitizeAccounts(raw: unknown): ProviderAccountEntry[] {
  if (!Array.isArray(raw)) return []
  const accounts: ProviderAccountEntry[] = []
  for (const entry of raw) {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) continue
    const candidate = entry as Partial<ProviderAccountEntry>
    if (typeof candidate.id !== 'string' || candidate.id.length === 0) continue
    if (typeof candidate.provider !== 'string' || candidate.provider.length === 0) continue
    if (typeof candidate.credentialRef !== 'string' || candidate.credentialRef.length === 0) continue
    accounts.push({
      ...candidate,
      enabled: candidate.enabled !== false,
      refreshable: candidate.refreshable !== false,
      nickname: typeof candidate.nickname === 'string' ? candidate.nickname : candidate.id,
      createdAt: typeof candidate.createdAt === 'number' ? candidate.createdAt : Date.now(),
    } as ProviderAccountEntry)
  }
  return accounts
}

/**
 * 账号状态的 JSON 文件后端（原子写）。
 *
 * 与凭据存储对称：内存里保留权威副本，写路径「改内存 → 整体落盘」。
 */
export class FileStateStore {
  private readonly path: string
  private cache: PoolState | undefined

  constructor(
    dataDir: string,
    private readonly logger: Logger,
    filename = 'state.json',
  ) {
    this.path = join(dataDir, filename)
  }

  /** 状态文件路径（供备份与测试断言）。 */
  get filePath(): string {
    return this.path
  }

  /** 同步载入；文档不存在时返回 `undefined`（等价于「空」）。 */
  load(): PoolState | undefined {
    if (this.cache !== undefined) return this.cache
    const parsed = readJsonFile<Record<string, unknown>>(this.path, this.logger)
    if (parsed === undefined) return undefined
    this.cache = {
      accounts: sanitizeAccounts(parsed['accounts']),
      disabledModels: sanitizeDisabledModels(parsed['disabledModels']),
      globalModelsEnabled: parsed['globalModelsEnabled'] !== false,
      disabledProviders: sanitizeDisabledProviders(parsed['disabledProviders']),
      permanentLocks: sanitizePermanentLocks(parsed['permanentLocks']),
      loomyPermanentLocked: parsed['loomyPermanentLocked'] === true,
      switchAudit: sanitizeSwitchAudit(parsed['switchAudit']),
    }
    return this.cache
  }

  /** 整体写入（账号 / 黑名单 / 全局开关必须一起携带）。 */
  save(state: PoolState): void {
    this.cache = state
    writeFileAtomic(this.path, JSON.stringify(state, null, 2))
  }
}
