/**
 * **串行队列**：保证「同一时刻只有一个任务在跑」，其余排队。
 *
 * ## 为什么需要
 *
 * 用于需要严格串行的场景（例如 `refresh_token` 一次性轮换的 provider：并发
 * 刷新会让第二次拿着刚作废的 token 去打）。官方闭源版把同类操作用一个全局
 * promise 链串起来，本类把那份逻辑抽成**可复用的原语**。
 *
 * 与 `src/pool/refresh-coordinator.ts` 的分工：那个是**按凭据引用单飞**的
 * 互斥（同一凭据的并发刷新合并成一次），本类是**先来先服务的排队**（不合并、
 * 依次执行）。两者语义不同，按需选用。
 */

/** 中断时抛出的错误（调用方据类型识别，避免误当成业务失败）。 */
export class QueueAbortedError extends Error {
  constructor(message = '等待队列期间请求已取消') {
    super(message)
    this.name = 'QueueAbortedError'
  }
}

/** 队列统计（诊断用）。 */
export interface SerialQueueStats {
  /** 当前排队中的任务数（不含正在跑的）。 */
  pending: number
  /** 累计执行过的任务数。 */
  completed: number
}

/** 构造选项。 */
export interface SerialQueueOptions {
  /** 是否启用串行（false = 直接执行，用于一键回到引入前行为）。 */
  enabled?: boolean
  /** 取当前时刻（注入以便单测）。 */
  now?: () => number
}

/**
 * 先来先服务的串行队列（**公平**：按调用顺序，不是按完成顺序抢）。
 *
 * ⚠ **失败也必须放行下一个**：`run()` 的 `finally` 无条件释放尾巴。
 * 少了它，一个失败的任务会把整条队列**永久焊死**。
 */
export class SerialQueue {
  private readonly enabled: boolean
  private tail: Promise<void> = Promise.resolve()
  private pending = 0
  private completed = 0

  constructor(options: SerialQueueOptions = {}) {
    this.enabled = options.enabled ?? true
  }

  /** 队列统计。 */
  stats(): SerialQueueStats {
    return { pending: this.pending, completed: this.completed }
  }

  /**
   * 排到队尾并在轮到自己时执行 `task()`。
   *
   * @param task - 要串行执行的任务。
   * @param options.signal - 调用方中断信号；**等待期间**中断会抛
   *   {@link QueueAbortedError}（不执行任务）。
   */
  async run<T>(task: () => Promise<T>, options: { signal?: AbortSignal } = {}): Promise<T> {
    if (!this.enabled) return await task()

    this.pending += 1
    const previous = this.tail
    let release!: () => void
    this.tail = new Promise<void>((resolve) => {
      release = resolve
    })

    try {
      await this.awaitWithSignal(previous, options.signal)
      return await task()
    } finally {
      this.pending -= 1
      this.completed += 1
      release()
    }
  }

  /**
   * 等待前一个任务，但**响应当前调用方的中断**。
   *
   * ⚠ 不加这一层，前面某个任务挂住（例如网络僵死直到超时）会让**后面全部**
   * 一起干等 —— 而「等待期间的中断必须生效」是踩过的坑。
   */
  private async awaitWithSignal(promise: Promise<void>, signal?: AbortSignal): Promise<void> {
    if (signal === undefined) {
      await promise
      return
    }
    if (signal.aborted) throw new QueueAbortedError()
    await new Promise<void>((resolve, reject) => {
      const onAbort = (): void => {
        signal.removeEventListener('abort', onAbort)
        reject(new QueueAbortedError())
      }
      signal.addEventListener('abort', onAbort, { once: true })
      void promise.then(
        () => {
          signal.removeEventListener('abort', onAbort)
          resolve()
        },
        (error: unknown) => {
          signal.removeEventListener('abort', onAbort)
          reject(error as Error)
        },
      )
    })
  }
}
