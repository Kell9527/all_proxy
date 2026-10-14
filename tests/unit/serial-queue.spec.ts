/**
 * `serial-queue.spec.ts` —— 串行队列原语的单测。
 *
 * ## 为什么需要它
 *
 * 用于需要严格串行的场景（例如 `refresh_token` 一次性轮换的 provider：并发
 * 刷新会让第二次拿着刚作废的 token 去打）。
 *
 * 关键不变量：**先来先服务**（按调用顺序，不是按完成顺序抢）且**失败也必须
 * 放行下一个**（`run()` 的 `finally` 无条件释放尾巴）—— 少了后者，一个失败的
 * 任务会把整条队列**永久焊死**。
 */
import { describe, expect, it } from 'vitest'

import { QueueAbortedError, SerialQueue } from '../../src/providers/serial-queue.js'

const tick = async (ms = 5): Promise<void> => {
  await new Promise((resolve) => setTimeout(resolve, ms))
}

describe('SerialQueue', () => {
  it('★ 串行：并发任务里同时在飞的永远只有 1 个', async () => {
    const queue = new SerialQueue()
    let inFlight = 0
    let maxInFlight = 0
    const task = async (): Promise<void> => {
      inFlight += 1
      maxInFlight = Math.max(maxInFlight, inFlight)
      await tick(5)
      inFlight -= 1
    }

    await Promise.all([queue.run(task), queue.run(task), queue.run(task)])
    expect(maxInFlight).toBe(1)
    expect(queue.stats().pending).toBe(0)
    expect(queue.stats().completed).toBe(3)
  })

  it('★ 先进先出（公平）：按**调用顺序**执行，不是按完成顺序抢', async () => {
    const queue = new SerialQueue()
    const order: number[] = []
    await Promise.all([
      queue.run(async () => { await tick(20); order.push(1) }),
      queue.run(async () => { order.push(2) }),
      queue.run(async () => { order.push(3) }),
    ])
    // 第 1 个最慢，但它先入队 ⇒ 必须先完成，后两个才轮到。
    expect(order).toEqual([1, 2, 3])
  })

  it('★ 失败必须放行下一个（否则一条失败任务把队列永久焊死）', async () => {
    const queue = new SerialQueue()
    const done: string[] = []
    await expect(queue.run(async () => { throw new Error('boom') })).rejects.toThrow('boom')
    await queue.run(async () => { done.push('second') })
    expect(done).toEqual(['second'])
  })

  it('enabled=false 时直接执行（不排队）', async () => {
    const queue = new SerialQueue({ enabled: false })
    let inFlight = 0
    let maxInFlight = 0
    const task = async (): Promise<void> => {
      inFlight += 1
      maxInFlight = Math.max(maxInFlight, inFlight)
      await tick(5)
      inFlight -= 1
    }
    await Promise.all([queue.run(task), queue.run(task), queue.run(task)])
    // 不排队 ⇒ 三个同时在飞。
    expect(maxInFlight).toBe(3)
  })

  it('等待期间中断 → 抛 QueueAbortedError（不执行任务）', async () => {
    const queue = new SerialQueue()
    const controller = new AbortController()
    let ranSecond = false
    const first = queue.run(async () => { await tick(30) })
    const second = queue.run(async () => { ranSecond = true }, { signal: controller.signal })
    controller.abort()
    await expect(second).rejects.toBeInstanceOf(QueueAbortedError)
    await first
    expect(ranSecond).toBe(false)
  })
})
