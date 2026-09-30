/**
 * 刷新单飞（single-flight）协调器。
 *
 * ## 为什么必需
 *
 * 部分 provider 的 `refresh_token` 是**一次性轮换**的：一次刷新请求就会让旧
 * token 作废、返回新的。于是「同一账号被并发刷新」不是性能问题，而是**正确性
 * 问题** —— 第二次请求拿着已作废的旧 token 去打，要么失败、要么拿到另一份
 * 新 token，而两次结果都会各自回写，**最后写者胜**，落盘的可能是失效的那份。
 *
 * 真实触发路径有多条且会重叠：
 * - 适配器在请求前判定「凭据已过期」→ 刷新（`raccoon-adapter` 等）；
 * - 适配器遇 401/403 → 刷新一次并重试；
 * - 每小时定时任务 `refreshDueAccounts` 扫全量账号；
 * - 启动时立即跑一次定时任务的那份逻辑。
 *
 * 因此在**账号粒度**（键为 `credentialRef`）做互斥：同一账号的并发刷新共享
 * 同一个 Promise，上游只会被调用一次。
 *
 * ## 为什么不用队列串行化全部刷新
 *
 * 不同账号之间没有共享状态，串行化只会让 10 个账号的刷新耗时相加。按账号单飞
 * 既消除了同账号竞态，又保留了跨账号并行。
 *
 * ## 键的选取
 *
 * 用 `credentialRef` 而不是账号 id：**文件引用**下多个账号条目可能指向同一个
 * 凭据文件（共享同一份 token），那种情形同样必须互斥 —— 按账号 id 单飞会漏掉
 * 这一层。
 */

/** 单飞协调器。 */
export class RefreshCoordinator {
  /** 进行中的刷新：key → Promise。完成后立即移除。 */
  private readonly inFlight = new Map<string, Promise<unknown>>()

  /**
   * 以 `key` 为粒度执行 `task`；同一 key 的并发调用复用同一个 Promise。
   *
   * ⚠️ **失败不缓存**：`finally` 里立刻移除条目，故一次失败不会让后续调用
   * 永久拿到同一个 rejected Promise（那会让账号在进程生命周期内再也刷不动）。
   * 代价是「失败后立刻重试」会重新打上游，但上游失败本身有服务端限流兜底，
   * 且这条路径只在 401 重试与定时任务上出现，量级很小。
   */
  async run<T>(key: string, task: () => Promise<T>): Promise<T> {
    const existing = this.inFlight.get(key)
    if (existing !== undefined) return existing as Promise<T>
    const promise = (async () => task())()
    this.inFlight.set(key, promise)
    try {
      return await promise
    } finally {
      // 只有自己还是「当前那条」时才删：极端情况下（task 同步完成并被立刻
      // 替换）避免误删后来者的条目。
      if (this.inFlight.get(key) === promise) this.inFlight.delete(key)
    }
  }

  /** 当前进行中的刷新数量（供测试与诊断）。 */
  get pendingCount(): number {
    return this.inFlight.size
  }
}
