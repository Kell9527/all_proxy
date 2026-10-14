/**
 * AccountPool —— 多账号管理核心。
 *
 * 移植自来源 `src/account-pool.ts`，**去掉 DSH 依赖**（`ctx.credentials` /
 * `ctx.logger` / `declare module`）与**目录门控**（`providerCatalogVisible`，
 * 那是 DSH 模型选择器的展示优化，对外 API 无此概念）。
 *
 * 职责：
 * - 账号列表 CRUD（索引走 {@link FileStateStore}，凭据走 {@link CredentialStore}）
 * - 取指定 provider + 模型的下一个可用账号
 * - 更新模型重置时间（收到限流错误后调用）
 * - 三层模型开关的存储与判定（全局 / provider / 单模型）
 *
 * ⚠️ **移植时保持的两条来源约定**（见 AGENTS.md）：
 * 1. 数组顺序即选号优先级，**不得**按限流重置时间重排候选；
 * 2. 续期只看 `refreshable`，**不看** `enabled`。
 */

import { join } from 'node:path'
import type { CredentialStore, ProviderAccountEntry, ProviderAccountStatus } from './types.js'
import type { ModelDisableMap, PoolState, SwitchAuditEntry } from './state-store.js'
import { FileStateStore, SWITCH_AUDIT_LIMIT, sanitizeAccounts, sanitizeDisabledModels } from './state-store.js'
import type { Logger } from './store.js'

/**
 * 空黑名单的共享只读实例。
 *
 * 适配器的 `listModels` 每次都会被模型目录调用，绝大多数 provider/时刻都
 * 没有黑名单；共享同一个冻结集合可以避免每次调用都分配一个新 Set。
 */
const EMPTY_MODEL_SET: ReadonlySet<string> = new Set<string>()

/** {@link AccountPool} 的构造参数。 */
export interface AccountPoolOptions {
  /** 凭据存储。 */
  credentials: CredentialStore
  /**
   * 状态文档目录（`state.json` 落在这里）。
   *
   * 省略时用 `ALL_PROXY_DATA_DIR`，再退到进程工作目录下的 `data/`。
   * 生产装配总是显式传它；省略只用于测试替身与一次性脚本。
   */
  dataDir?: string
  /** 日志；省略则静默。 */
  logger?: Logger
}

export class AccountPool {
  private readonly store: FileStateStore
  private readonly credentials: CredentialStore
  private readonly logger: Logger | undefined
  /**
   * 账号列表的**权威进程内副本**。
   *
   * 不直接把后端的读取结果当读源：本类的每次写入都是「读 → 改 → 整体写回」，
   * 若以滞后快照为读源，并发/连续的 `updateModelRateLimit` 会互相覆盖
   * （典型表现：多个账号触发限流后，落盘文档里一条 `modelRateLimits` 都没有）。
   * 因此首次载入后，这份副本即为唯一读源。
   */
  private cache: ProviderAccountEntry[] = []
  /** 模型黑名单的权威进程内副本（与 {@link cache} 同理）。 */
  private modelCache: ModelDisableMap = {}
  /** provider 级开关的权威进程内副本（与 {@link cache} 同理）。 */
  private providerOffCache: Record<string, boolean> = {}
  /** 全局总开关：关闭后所有模型都不可用。 */
  private globalModelsEnabledCache = true
  /**
   * 「锁定永久积分」的权威进程内副本（**按 provider**，Loomy / OfficeAce 各自独立）。
   *
   * 与 {@link cache} 同理：`ensureLoaded` 时从状态文档载入，`buildState` 时写回。
   */
  private permanentLocksCache: Record<string, boolean> = {}
  /** 开关变更审计（只保留最近若干条）。 */
  private switchAuditCache: SwitchAuditEntry[] = []
  /** 是否已完成首次载入。 */
  private loaded = false

  constructor(options: AccountPoolOptions) {
    this.credentials = options.credentials
    this.logger = options.logger
    // 数据目录：显式传入优先，否则读环境变量，最后退到 cwd/data。
    // ⚠️ 这里**不抛错**：池是「账号 + 开关」的持有者，即使状态目录暂时拿不到，
    // 也应该能构造出来（读路径会在写入时暴露问题），否则装配阶段一处配置缺失
    // 就会让整个服务起不来。
    const dataDir = options.dataDir
      ?? process.env['ALL_PROXY_DATA_DIR']
      ?? join(process.cwd(), 'data')
    this.store = new FileStateStore(
      dataDir,
      options.logger ?? { info: () => {}, warn: () => {}, error: () => {} },
    )
  }

  /** 首次访问时从后端载入账号列表与黑名单。 */
  private ensureLoaded(): void {
    if (this.loaded) return
    this.loaded = true
    const state = this.store.load()
    if (state === undefined) return
    this.cache = state.accounts
    // 黑名单是后来才加入的字段：老文档里没有它，缺失时保持空表
    // （等价于「全部模型默认打开」），而不是报错或让整次载入失败。
    this.modelCache = state.disabledModels
    this.providerOffCache = state.disabledProviders ?? {}
    // 同理：这些开关也是后加的字段，缺失即视为默认值（既有行为）。
    this.globalModelsEnabledCache = state.globalModelsEnabled !== false
    this.permanentLocksCache = { ...state.permanentLocks }
    // 兼容旧文档：`permanentLocks` 缺席而老字段为 true 时，等价于 loomy 上锁。
    if (state.loomyPermanentLocked === true) {
      this.permanentLocksCache['loomy'] = true
    }
    this.switchAuditCache = state.switchAudit ?? []
  }

  /** 读取账号列表（进程内权威副本）。 */
  private readAccounts(): ProviderAccountEntry[] {
    this.ensureLoaded()
    return this.cache
  }

  /**
   * 组装完整的落盘状态。
   *
   * ⚠️ **所有写入点都必须经过这里**：整体写入漏掉任一字段就会把它抹掉。
   */
  private buildState(overrides: Partial<PoolState> = {}): PoolState {
    const permanentLocks = overrides.permanentLocks ?? this.permanentLocksCache
    return {
      accounts: overrides.accounts ?? this.cache,
      disabledModels: overrides.disabledModels ?? this.modelCache,
      globalModelsEnabled: overrides.globalModelsEnabled ?? this.globalModelsEnabledCache,
      disabledProviders: overrides.disabledProviders ?? this.providerOffCache,
      permanentLocks,
      // 兼容镜像：老读者（备份/旧版前端）读 loomyPermanentLocked。
      loomyPermanentLocked: permanentLocks['loomy'] === true,
      switchAudit: overrides.switchAudit ?? this.switchAuditCache,
    }
  }

  /**
   * 记录一条开关变更（供排查「模型突然不可用」）。
   *
   * ⚠️ **只记元数据**（时间、层级、目标、新状态），**不记凭据**。
   * 超过 {@link SWITCH_AUDIT_LIMIT} 时丢最旧的。
   */
  private recordSwitchAudit(layer: SwitchAuditEntry['layer'], target: string, enabled: boolean): void {
    const next = [...this.switchAuditCache, {
      at: new Date().toISOString(),
      layer,
      target,
      enabled,
    }]
    this.switchAuditCache = next.slice(-SWITCH_AUDIT_LIMIT)
  }

  /** 读取开关变更审计（最新在后）。 */
  switchAudit(): readonly SwitchAuditEntry[] {
    this.ensureLoaded()
    return this.switchAuditCache
  }

  /** 持久化账号列表（同时更新进程内权威副本）。 */
  private async writeAccounts(accounts: ProviderAccountEntry[]): Promise<void> {
    this.cache = accounts
    this.loaded = true
    this.store.save(this.buildState({ accounts }))
  }

  // ───────────────────────── 模型开关（三层） ─────────────────────────

  /**
   * 全局总开关是否开启。
   *
   * 关闭后所有模型都不可用（`GET /v1/models` 返回空、调用一律 404）。
   */
  globalModelsEnabled(): boolean {
    this.ensureLoaded()
    return this.globalModelsEnabledCache
  }

  /** 设置全局总开关（持久化）。 */
  async setGlobalModelsEnabled(enabled: boolean): Promise<void> {
    this.ensureLoaded()
    this.globalModelsEnabledCache = enabled === true
    this.recordSwitchAudit('global', '*', this.globalModelsEnabledCache)
    this.store.save(this.buildState({ globalModelsEnabled: this.globalModelsEnabledCache }))
  }

  /**
   * 读取某 provider 的模型黑名单（被关闭的模型 id 集合）。
   *
   * 适配器只调用这一个方法，因此进程内副本就是它们的读源：管理端改开关后，
   * 下一次 `listModels` 立即生效，无需重启或重新注册适配器。
   */
  disabledModelsFor(provider: string): ReadonlySet<string> {
    this.ensureLoaded()
    const perProvider = this.modelCache[provider]
    if (perProvider === undefined) return EMPTY_MODEL_SET
    const disabled = Object.keys(perProvider).filter((id) => perProvider[id] === true)
    return disabled.length > 0 ? new Set(disabled) : EMPTY_MODEL_SET
  }

  /**
   * 列出某 provider 的模型黑名单，供管理端渲染开关。
   *
   * 返回**全部键**（含显式设为 false 的），以便 UI 区分「从未设置过」与
   * 「曾被关闭又打开」。
   */
  listDisabledModels(provider: string): Record<string, boolean> {
    this.ensureLoaded()
    return { ...(this.modelCache[provider] ?? {}) }
  }

  /**
   * 某 provider 是否被整体关闭（第二层开关）。
   *
   * 与模型黑名单**分开存储**：若把「整个 provider 关闭」塞进黑名单表，
   * 那个哨兵键会出现在 `listDisabledModels` 里、被管理端渲染成一个不存在的
   * 模型条目。两者是不同维度。
   */
  providerEnabled(provider: string): boolean {
    this.ensureLoaded()
    return this.providerOffCache[provider] !== true
  }

  /** 打开/关闭整个 provider（持久化）。 */
  async setProviderEnabled(provider: string, enabled: boolean): Promise<void> {
    this.ensureLoaded()
    const next = { ...this.providerOffCache }
    if (enabled) delete next[provider]
    else next[provider] = true
    this.providerOffCache = next
    this.recordSwitchAudit('provider', provider, enabled)
    this.store.save(this.buildState({ disabledProviders: next }))
  }

  /**
   * 打开/关闭某个模型。
   *
   * 关闭时写入 `true`；打开时**删除该键**而不是写 `false` —— 保持黑名单
   * 里只留真正被关闭的模型，`disabledModelsFor` 的语义因此始终是
   * 「键存在且为 true 即隐藏」，配置文件也不会随开关操作无限膨胀。
   */
  async setModelDisabled(provider: string, modelId: string, disabled: boolean): Promise<void> {
    const next: ModelDisableMap = { ...this.modelCache }
    const perProvider = { ...(next[provider] ?? {}) }
    if (disabled) perProvider[modelId] = true
    else delete perProvider[modelId]
    if (Object.keys(perProvider).length === 0) delete next[provider]
    else next[provider] = perProvider
    this.recordSwitchAudit('model', `${provider}/${modelId}`, !disabled)
    await this.writeModels(next)
  }

  /**
   * 批量关闭一批模型（管理端的「关闭全部」）。
   *
   * 语义是**按当前列表逐项加入黑名单**，与 {@link setModelDisabled} 的关闭
   * 方向一致，只是**一次落盘**：逐条调用会写 N 次完整文档，且中途失败会留下
   * 「关了一半」的黑名单。
   *
   * 空列表直接返回、不落盘：没有变更就不该产生一次无意义的写入。
   */
  async setModelsDisabled(provider: string, modelIds: readonly string[]): Promise<void> {
    if (modelIds.length === 0) return
    // ⚠️ 必须先确保已载入：本类只在**读**方法里调 `ensureLoaded()`，若首次访问
    // 就是写操作，`this.modelCache` 还是初始空表 —— 一次「关闭全部」会把
    // 磁盘上已有的黑名单整体覆盖掉。
    this.ensureLoaded()
    const next: ModelDisableMap = { ...this.modelCache }
    // 与已有条目合并：先前单独关闭的模型不能因为一次「关闭全部」而丢失。
    const perProvider = { ...(next[provider] ?? {}) }
    for (const id of modelIds) perProvider[id] = true
    next[provider] = perProvider
    await this.writeModels(next)
  }

  /**
   * 清空某 provider 的全部关闭项（管理端的「打开全部」）。
   *
   * ⚠️ **刻意不看模型目录**：直接删掉该 provider 在黑名单里的**全部**键，
   * 而不是按当前目录逐个删。理由是「曾被关闭、后来从服务端目录里下线」的
   * 历史遗留键 —— 按目录删的话它们永远清不掉，黑名单会积累死键，残留键
   * 将来若被同名模型复用还会莫名隐藏它。
   *
   * ⚠️ 同时清除「该 provider 被整体关闭」的标记（否则「打开全部」之后
   * provider 仍是关闭状态，用户会以为操作没生效）。
   */
  async clearDisabledModels(provider: string): Promise<void> {
    // 同 setModelsDisabled：写路径必须自己保证已载入。
    this.ensureLoaded()
    const hadModels = this.modelCache[provider] !== undefined
    const wasProviderOff = this.providerOffCache[provider] === true
    // 两者都无事可做时直接返回、不落盘。
    if (!hadModels && !wasProviderOff) return
    const next: ModelDisableMap = { ...this.modelCache }
    delete next[provider]
    const nextProviders = { ...this.providerOffCache }
    // ⚠️ 同时清除「该 provider 被整体关闭」的标记（否则「打开全部」之后
    // provider 仍是关闭状态，用户会以为操作没生效）。
    delete nextProviders[provider]
    this.modelCache = next
    this.providerOffCache = nextProviders
    this.loaded = true
    this.store.save(this.buildState({ disabledModels: next, disabledProviders: nextProviders }))
  }

  /** 持久化模型黑名单（同时更新进程内权威副本）。 */
  private async writeModels(disabledModels: ModelDisableMap): Promise<void> {
    this.modelCache = disabledModels
    this.loaded = true
    // 与 writeAccounts 对称：整体写入必须携带账号列表，否则会被清空。
    this.store.save(this.buildState({ disabledModels }))
  }

  /**
   * 判定某模型最终是否可用，并说明是**哪一层**导致不可用。
   *
   * 三层顺序：全局 → provider → 单模型。任一层关闭即不可用。
   *
   * @returns `allowed` 为最终结论；不可用时 `blockedBy` 指出层级。
   */
  modelAvailability(provider: string, modelId: string): {
    allowed: boolean
    blockedBy?: 'global' | 'provider' | 'model'
  } {
    this.ensureLoaded()
    if (!this.globalModelsEnabledCache) return { allowed: false, blockedBy: 'global' }
    if (!this.providerEnabled(provider)) return { allowed: false, blockedBy: 'provider' }
    if (this.disabledModelsFor(provider).has(modelId)) return { allowed: false, blockedBy: 'model' }
    return { allowed: true }
  }

  // ───────────────────────── 全局开关 ─────────────────────────

  /**
   * 某 provider 的「锁定永久积分」是否开启（Loomy / OfficeAce 等各自独立）。
   *
   * 锁定后只允许消耗临时/临期额度：Loomy 是「每日赠送」，OfficeAce 是
   * 「有到期时间的桶」（永久桶不参与）。
   */
  permanentLocked(provider: string): boolean {
    this.ensureLoaded()
    return this.permanentLocksCache[provider] === true
  }

  /**
   * 设置某 provider 的「锁定永久积分」开关（持久化）。
   *
   * 解锁时**删键**而不是存 `false`：表里只留「已锁定」的 provider，
   * 状态文档不随开关反复切换而累积死条目。
   *
   * ⚠️ **必须连同账号与黑名单一起写回**（由 {@link buildState} 保证）。
   */
  async setPermanentLocked(provider: string, locked: boolean): Promise<void> {
    this.ensureLoaded()
    const next = { ...this.permanentLocksCache }
    if (locked === true) next[provider] = true
    else delete next[provider]
    this.permanentLocksCache = next
    this.store.save(this.buildState({ permanentLocks: next }))
  }

  /** Loomy「锁定永久积分」是否开启（{@link permanentLocked} 的 Loomy 特例）。 */
  loomyPermanentLocked(): boolean {
    return this.permanentLocked('loomy')
  }

  /**
   * 设置 Loomy「锁定永久积分」开关（持久化）。
   *
   * ⚠️ **必须连同账号与黑名单一起写回**（由 {@link buildState} 保证）。
   */
  async setLoomyPermanentLocked(locked: boolean): Promise<void> {
    await this.setPermanentLocked('loomy', locked)
  }

  // ───────────────────────── 账号 CRUD ─────────────────────────

  /** 列出某个 provider 的所有账号（含状态信息）。 */
  async listAccounts(provider: string): Promise<ProviderAccountStatus[]> {
    const filtered = this.readAccounts().filter(a => a.provider === provider)
    const results: ProviderAccountStatus[] = []
    for (const entry of filtered) {
      const status: ProviderAccountStatus = { ...entry }
      try {
        const info = await this.credentials.describe(entry.credentialRef)
        if (info.source !== undefined) status.source = info.source
      } catch {
        // 凭据可能已被外部删除
      }
      results.push(status)
    }
    return results
  }

  /** 列出所有 provider 的账号。 */
  async listAllAccounts(): Promise<ProviderAccountEntry[]> {
    return this.readAccounts()
  }

  /** 添加新账号（登录成功后调用）。 */
  async addAccount(entry: ProviderAccountEntry): Promise<void> {
    const accounts = [...this.readAccounts(), entry]
    await this.writeAccounts(accounts)
  }

  /** 更新账号部分字段。 */
  async updateAccount(
    id: string,
    patch: Partial<Pick<ProviderAccountEntry, 'nickname' | 'enabled' | 'expiresAt' | 'refreshable'>>,
  ): Promise<void> {
    const accounts = this.readAccounts()
    const idx = accounts.findIndex(a => a.id === id)
    if (idx === -1) throw new Error(`Account ${id} not found`)
    const next = [...accounts]
    next[idx] = { ...next[idx], ...patch }
    await this.writeAccounts(next)
  }

  /**
   * 换绑账号的凭据引用（管理端「绑定/解绑凭据文件」）。
   *
   * ## 语义
   *
   * - **绑定/换绑**：把 `credentialRef` 指向新 ref（通常是 `FILE:<路径>`）。
   *   若该 ref 下**尚无可读凭据**，而旧 ref 有 —— 把旧凭据内容**迁移**过去，
   *   避免换绑动作本身把账号变成无凭据；若新 ref 已有内容（例如指向一个已被
   *   官方客户端写入的共享文件），**以文件内容为准**，不覆盖它。
   * - **解绑**（`nextRef` 为内置 ref）：把当前内容**转存**到那个内置 ref，使
   *   账号脱离外部文件而继续可用 —— 直接摘除会让用户莫名丢掉凭据。
   *
   * ⚠️ 迁移是「读旧 → 写新」，不是「改指针」。文件引用下的写会落到外部文件，
   * 这正是我们要的效果（与共享该文件的其他消费者继续保持同一步调）。
   */
  async rebindCredential(id: string, nextRef: string): Promise<{ migrated: boolean }> {
    if (nextRef.trim().length === 0) throw new Error('新的凭据引用不能为空')
    const accounts = this.readAccounts()
    const idx = accounts.findIndex(a => a.id === id)
    if (idx === -1) throw new Error(`Account ${id} not found`)
    const entry = accounts[idx]!
    if (entry.credentialRef === nextRef) return { migrated: false }

    // 新 ref 已有内容 → 尊重它（典型情形：指向官方客户端已写好的共享文件）。
    const existingNext = await this.credentials.resolve(nextRef).catch(() => undefined)
    let migrated = false
    if (existingNext === undefined) {
      const previous = await this.credentials.resolve(entry.credentialRef).catch(() => undefined)
      if (previous !== undefined) {
        await this.credentials.set(nextRef, previous.value)
        migrated = true
      }
    }

    const next = [...accounts]
    next[idx] = { ...entry, credentialRef: nextRef }
    await this.writeAccounts(next)
    return { migrated }
  }

  /**
   * 删除账号（同时清理凭据，不留孤立凭据）。
   *
   * ⚠️ 凭据是**文件引用**（`FILE:<路径>`）时，存储层的 `unset` 是**无操作** ——
   * 那个文件可能被官方客户端或其它网关共享，删除会波及本服务之外的东西。
   * 这里只需停手：不删文件、也不额外报错，账号条目照常摘除。
   */
  async removeAccount(id: string): Promise<void> {
    const accounts = this.readAccounts()
    const entry = accounts.find(a => a.id === id)
    if (!entry) return
    try {
      await this.credentials.unset(entry.credentialRef)
    } catch { /* 凭据可能已被删除 */ }
    await this.writeAccounts(accounts.filter(a => a.id !== id))
  }

  /**
   * 重排某 provider 下账号的顺序（管理端拖拽排序）。
   *
   * ## 为什么顺序有实际意义
   *
   * 账号列表的数组顺序就是 {@link getAvailableAccount} 的**候选优先级**：
   * 自动选号、限流后的换号重试都按这个顺序取「第一个可用账号」。
   * 因此拖拽不是 UI 装饰，它直接决定实际用哪个账号发请求。
   *
   * ## 只动本 provider 的槽位
   *
   * 账号存在**一个全局数组**里（各 provider 混排，靠 `provider` 字段区分），
   * 而管理端是按 provider 分组渲染的。因此这里取「该 provider 账号原本占用的
   * 那些下标」，把新顺序填回这些下标 —— 其他 provider 的账号**位置不变**。
   *
   * ## 校验：必须是同一集合的一个排列
   *
   * `orderedIds` 必须恰好包含该 provider 的**全部**账号 id（顺序可变、集合不可变）。
   * 不满足就抛错而不是「尽力而为」：
   * - 少了某个 id（前端列表过期）→ 若静默忽略，那个账号会莫名掉到末尾；
   * - 多了未知 id → 说明前端状态与服务端不一致。
   *
   * @param provider - provider id
   * @param orderedIds - 该 provider 全部账号 id 的目标顺序
   */
  async reorderAccounts(provider: string, orderedIds: readonly string[]): Promise<void> {
    const accounts = this.readAccounts()
    const indices: number[] = []
    const currentIds: string[] = []
    accounts.forEach((entry, index) => {
      if (entry.provider === provider) {
        indices.push(index)
        currentIds.push(entry.id)
      }
    })

    // 集合一致性校验（顺序无关）。
    const expected = new Set(currentIds)
    const got = new Set(orderedIds)
    const sameSet = orderedIds.length === currentIds.length
      && got.size === orderedIds.length
      && orderedIds.every(id => expected.has(id))
    if (!sameSet) {
      throw new Error(
        `账号列表已变化，请刷新后重试（期望 ${currentIds.length} 个账号，收到 ${orderedIds.length} 个）`,
      )
    }

    const next = [...accounts]
    // 按新顺序回填到该 provider 原本占用的下标上。
    indices.forEach((accountIndex, position) => {
      const id = orderedIds[position]
      const source = accounts.find(a => a.id === id)
      // 上面的集合校验已保证 source 必定存在；这里的判断只为类型收窄。
      if (source !== undefined) next[accountIndex] = source
    })
    await this.writeAccounts(next)
    this.logger?.info(`[pool] 已重排 ${provider} 账号顺序: ${orderedIds.join(', ')}`)
  }

  /**
   * 按凭据内容反查账号 id（供适配器记录「当前用的是哪个账号」）。
   *
   * 适配器不持有池，也不该直接访问凭据存储，因此这里集中做
   * 「遍历已启用账号 → 解析凭据 → 比对标识字段」。
   *
   * @param provider - provider 名称。
   * @param identity - 比对用的标识值：CodeBuddy 系传 `access_token`，
   *   CodeArts 传 `access_key_id`。
   * @returns 匹配到的账号 id；无匹配返回空串。
   */
  async findAccountIdByCredential(provider: string, identity: string): Promise<string> {
    if (identity.length === 0) return ''
    // 凭据中的唯一标识字段：CodeBuddy 系（buddy / workbuddy）用 access_token，
    // CodeArts 用 access_key_id。选错字段会导致匹配恒失败，限流记录无法归属账号。
    const identifierKey = provider === 'codearts' ? 'access_key_id' : 'access_token'
    for (const entry of this.readAccounts()) {
      if (entry.provider !== provider || !entry.enabled) continue
      const resolved = await this.resolveCredentialByRef(entry.credentialRef)
      if (resolved === undefined) continue
      if (resolved[identifierKey] === identity) return entry.id
    }
    return ''
  }

  /** 解析某个 credentialRef 下的凭据 JSON；不可用时返回 undefined。 */
  async resolveCredentialByRef(refName: string): Promise<Record<string, unknown> | undefined> {
    try {
      const resolved = await this.credentials.resolve(refName)
      if (!resolved) return undefined
      const parsed = JSON.parse(resolved.value) as unknown
      return typeof parsed === 'object' && parsed !== null ? parsed as Record<string, unknown> : undefined
    } catch {
      return undefined
    }
  }

  /** 按 id 查找账号条目（含已停用账号）。 */
  findAccount(id: string): ProviderAccountEntry | undefined {
    return this.readAccounts().find(a => a.id === id)
  }

  /** 列出某 provider 的全部账号（含已停用）。 */
  listAccountsByProvider(provider: string): ProviderAccountEntry[] {
    return this.readAccounts().filter(a => a.provider === provider)
  }

  /**
   * 按账号 id 解析凭据（**不检查 enabled**）。
   *
   * 限流重测必须能对已停用账号发请求，因此这里刻意与
   * {@link getAvailableAccount} 的过滤条件区分开：自动选择只认启用账号，
   * 而按 id 的显式探测认全部账号。
   *
   * @returns 凭据对象；账号不存在或凭据不可用时返回 undefined。
   *
   * ⚠️ 返回类型是 `unknown`（而不是 `Record<string, unknown>`）：调用方
   * （移植过来的适配器）会把它 `as` 成各自的凭据类型，而带必需字段的具体
   * 类型无法从 `Record<string, unknown>` 直接断言。用 `unknown` 保留
   * 「凭据形状由 provider 自己决定」这一事实。
   */
  async resolveCredentialForAccount(id: string): Promise<unknown> {
    const entry = this.findAccount(id)
    if (entry === undefined) return undefined
    return this.resolveCredentialByRef(entry.credentialRef)
  }

  /**
   * 清除限流标记。
   *
   * @param accountId - 目标账号。
   * @param modelIds - 要清除的模型；省略时清除该账号的**全部**标记。
   * @returns 实际清除的标记数。
   */
  async clearModelRateLimits(accountId: string, modelIds?: readonly string[]): Promise<number> {
    const accounts = this.readAccounts()
    const idx = accounts.findIndex(a => a.id === accountId)
    if (idx === -1) return 0
    const entry = accounts[idx]
    if (entry === undefined) return 0
    const current = entry.modelRateLimits
    if (!current || Object.keys(current).length === 0) return 0

    const limits = { ...current }
    let removed = 0
    const targets = modelIds ?? Object.keys(limits)
    for (const modelId of targets) {
      if (Object.prototype.hasOwnProperty.call(limits, modelId)) {
        delete limits[modelId]
        removed++
      }
    }
    if (removed === 0) return 0

    const next = [...accounts]
    const updated = { ...entry }
    // 清空后删除字段本身，避免文档里留下空对象噪音。
    if (Object.keys(limits).length === 0) delete updated.modelRateLimits
    else updated.modelRateLimits = limits
    next[idx] = updated
    await this.writeAccounts(next)
    this.logger?.info(
      `[pool] 已清除限流标记: 账号 ${accountId} 模型 ${targets.join(', ')}（共 ${removed} 条）`,
    )
    return removed
  }

  /**
   * 获取指定 provider + 模型的下一个可用账号。
   *
   * `modelId` 为空串时**不做限流过滤**——调用方此时还不知道要发哪个模型，
   * 只能退化为「任取一个启用账号」。但 `enabled` 过滤在任何情况下都生效：
   * 停用账号绝不参与自动选择，空 modelId 也不例外。
   *
   * @param provider - provider id。
   * @param modelId - 目标模型；空串表示不按模型过滤。
   * @param excludeAccountIds - 需要跳过的账号 id。
   *
   * **为什么需要 `excludeAccountIds`**：调用方在「请求级轮换」时会逐个换号
   * 重试，必须能拿到**下一个**账号而不是每次都拿回同一个。当失败类别
   * **不写限流标记**时（如 5xx / 请求错误），刚失败的账号仍是排序第一，
   * 调用方若不排除它就会原地打转、换号形同虚设。
   *
   * 在池这一层排除（而非让调用方自己跳过）是必要的：调用方只能拿到
   * 「池认为最优的一个」，无法枚举候选自己去重。
   */
  async getAvailableAccount(
    provider: string,
    modelId: string,
    excludeAccountIds?: ReadonlySet<string>,
  ): Promise<{ entry: ProviderAccountEntry; credential: unknown } | null> {
    const candidates = this.readAccounts()
      .filter(a => a.provider === provider && a.enabled)
      .filter(a => excludeAccountIds === undefined || !excludeAccountIds.has(a.id))
      .filter((a) => {
        // 空 modelId（未知目标模型）：无可比对的键，保持候选不变。
        if (modelId.length === 0) return true
        if (!a.modelRateLimits) return true
        const resetAt = a.modelRateLimits[modelId]
        return resetAt === undefined || resetAt === 0 || Date.now() >= resetAt
      })
    if (candidates.length === 0) return null
    // 候选顺序即**用户手动设定的顺序**（`reorderAccounts` 写入）。
    //
    // 为什么不再按「限流重置时间最早到期」重排（来源早期实现如此）：
    // 那个排序会让手动顺序形同虚设 —— 用户把某账号拖到首位，只要另一个
    // 账号的限流重置时间更早，实际选中的仍是后者，拖拽变成纯 UI 装饰。
    // 现在的语义是「手动顺序优先，限流豁免」：顺序完全由用户决定，
    // 而当前正处于限流期的账号已被上面的 filter 排除，不会选到。
    //
    // 注意 candidates 来自 readAccounts() 的 filter，而 filter 保持原数组
    // 顺序，故这里天然就是手动顺序，无需任何排序。
    //
    // 逐个尝试解析凭据，跳过占位/损坏条目（并记录原因，避免静默失败）
    const failures: string[] = []
    for (const entry of candidates) {
      const resolved = await this.credentials.resolve(entry.credentialRef).catch((error: unknown) => {
        failures.push(`${entry.id}: 读取凭据失败 (${String(error)})`)
        return undefined
      })
      if (resolved === undefined) {
        if (!failures.some(f => f.startsWith(`${entry.id}:`))) failures.push(`${entry.id}: 凭据未配置`)
        continue
      }
      try {
        const credential = JSON.parse(resolved.value) as Record<string, unknown>
        if (failures.length > 0) {
          this.logger?.warn(
            `[pool] ${failures.length} 个 ${provider} 账号不可用，已跳过：${failures.join('; ')}`,
          )
        }
        return { entry, credential }
      } catch (error) {
        failures.push(`${entry.id}: 凭据 JSON 损坏 (${String(error)})`)
        continue
      }
    }
    if (failures.length > 0) {
      this.logger?.warn(`[pool] 没有可用的 ${provider} 账号：${failures.join('; ')}`)
    }
    return null
  }

  /**
   * 更新某账号某模型的重置时间。
   *
   * 关键：基于**读取到的最新账号列表**做局部合并，再把整个列表写回，
   * 避免「写 A 的限流 → 读旧快照 → 写 B 的限流」把 A 的记录抹掉。
   */
  async updateModelRateLimit(accountId: string, modelId: string, resetAtMs: number): Promise<void> {
    const accounts = this.readAccounts()
    const idx = accounts.findIndex(a => a.id === accountId)
    if (idx === -1) {
      this.logger?.warn(
        `[pool] updateModelRateLimit: 账号 ${accountId} 不在账号列表中（已知: ${accounts.map(a => a.id).join(', ') || '空'}）`,
      )
      return
    }
    const next = [...accounts]
    const entry = { ...next[idx] }
    entry.modelRateLimits = { ...entry.modelRateLimits, [modelId]: resetAtMs }
    next[idx] = entry
    await this.writeAccounts(next)
    this.logger?.info(
      `[pool] 已记录限流: 账号 ${accountId} 模型 ${modelId} 重置于 ${new Date(resetAtMs).toISOString()}`,
    )
  }

  /** 清理已过期的重置时间记录。 */
  async sweepExpiredRateLimits(): Promise<void> {
    const accounts = this.readAccounts()
    let changed = false
    const next = accounts.map((entry) => {
      if (!entry.modelRateLimits) return entry
      const limits = { ...entry.modelRateLimits }
      for (const [modelId, resetAtMs] of Object.entries(limits)) {
        if (resetAtMs > 0 && Date.now() >= resetAtMs) {
          delete limits[modelId]
          changed = true
        }
      }
      return { ...entry, modelRateLimits: limits }
    })
    if (changed) await this.writeAccounts(next)
  }

  /**
   * 记录 TRAE 签到设备轮换代次（命中 9074 后由积分领取流程调用）。
   *
   * 只接受比现值**更大**的代次，防止乱序/重复回调把代次写回小值而让同一个
   * 被限流的设备号复活。
   */
  async updateTraeCheckinDeviceGeneration(accountId: string, generation: number): Promise<void> {
    if (!Number.isFinite(generation) || generation <= 0) return
    const accounts = this.readAccounts()
    const idx = accounts.findIndex(a => a.id === accountId)
    if (idx === -1) {
      this.logger?.warn(`[pool] updateTraeCheckinDeviceGeneration: 账号 ${accountId} 不在账号列表中`)
      return
    }
    const current = accounts[idx]?.traeCheckinDeviceGeneration ?? 0
    if (generation <= current) return
    const next = [...accounts]
    next[idx] = { ...next[idx]!, traeCheckinDeviceGeneration: generation }
    await this.writeAccounts(next)
    this.logger?.info(`[pool] 账号 ${accountId} 签到设备代次 → ${generation}`)
  }

  /** 读取 TRAE 签到设备轮换代次（未设置时为 0）。 */
  traeCheckinDeviceGenerationFor(accountId: string): number {
    const entry = this.readAccounts().find(a => a.id === accountId)
    const value = entry?.traeCheckinDeviceGeneration
    return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0
  }

  /**
   * 读取当前完整状态快照（账号列表 + 模型黑名单 + 开关）。
   *
   * 供备份导出使用：返回的副本与进程内权威副本解耦，调用方修改返回值
   * 不会污染池的运行时状态。`disabledModels` 是嵌套结构，必须深拷贝
   * （浅拷贝会让内层 provider 表仍共享引用）。
   */
  getStateSnapshot(): PoolState {
    this.ensureLoaded()
    const disabledModels: ModelDisableMap = {}
    for (const [provider, models] of Object.entries(this.modelCache)) {
      disabledModels[provider] = { ...models }
    }
    return {
      accounts: this.cache.map(entry => ({ ...entry })),
      disabledModels,
      globalModelsEnabled: this.globalModelsEnabledCache,
      disabledProviders: { ...this.providerOffCache },
      permanentLocks: { ...this.permanentLocksCache },
      loomyPermanentLocked: this.permanentLocksCache['loomy'] === true,
    }
  }

  /**
   * 整体替换账号列表与模型黑名单（备份导入用）。
   *
   * ⚠️ 导入数据来自用户提供的备份文件（可能被手工编辑），因此先经
   * `sanitizeAccounts` / `sanitizeDisabledModels` 归一化：只保留可用的
   * 账号条目与显式 `true` 的黑名单项，坏条目直接丢弃而不是写进池里
   * 反复触发选号失败。
   */
  async replaceAll(state: PoolState): Promise<void> {
    const next = sanitizeAccounts(state.accounts)
    this.cache = next
    this.modelCache = sanitizeDisabledModels(state.disabledModels)
    this.providerOffCache = state.disabledProviders ?? {}
    // 备份文件可能来自不含这些字段的旧版本：`undefined` 时**保持当前值**，
    // 而不是重置 —— 否则导入一份老备份会静默改变用户的开关状态。
    if (state.globalModelsEnabled !== undefined) {
      this.globalModelsEnabledCache = state.globalModelsEnabled !== false
    }
    if (state.permanentLocks !== undefined) {
      this.permanentLocksCache = { ...state.permanentLocks }
    } else if (state.loomyPermanentLocked !== undefined) {
      // 旧版备份只有 loomy 一个布尔：按老语义落到 per-provider 表上。
      this.permanentLocksCache = { ...this.permanentLocksCache, loomy: state.loomyPermanentLocked === true }
      if (this.permanentLocksCache['loomy'] !== true) delete this.permanentLocksCache['loomy']
    }
    this.loaded = true
    this.store.save(this.buildState())
  }

  /**
   * 只读地列出某 provider 的账号（同步；供适配器做同步判定）。
   *
   * 与 {@link listAccountsByProvider} 等价，但语义上强调「不触碰凭据存储」，
   * 因此没有 `async`。
   */
  accountsOf(provider: string): readonly ProviderAccountEntry[] {
    return this.listAccountsByProvider(provider)
  }
}
