/**
 * 刷新单飞的单元测试。
 *
 * ## 为什么这组用例是「正确性」而非「性能」
 *
 * `codearts` / `trae` / `raccoon` 的 `refresh_token` 是**一次性轮换**的：一次
 * 刷新请求就让旧 token 作废。若同一账号被并发刷新两次，第二次拿着已作废的旧
 * token 去打上游 —— 要么失败，要么各拿到一份新 token，**最后写者胜**，落盘的
 * 可能是失效的那份。
 *
 * 触发路径本来就重叠：适配器请求前的临期刷新、遇到 401 的重试刷新、每小时的
 * 定时任务、启动时那次立即执行。因此「同一 key 只打一次上游」是硬要求。
 */

import { describe, expect, it, vi } from 'vitest'
import { RefreshCoordinator } from '../../src/pool/refresh-coordinator.js'

describe('RefreshCoordinator', () => {
  it('同一 key 的并发调用只执行一次任务，且拿到同一个结果', async () => {
    const coordinator = new RefreshCoordinator()
    let calls = 0
    const task = async (): Promise<string> => {
      calls++
      await new Promise((resolve) => setTimeout(resolve, 20))
      return 'refreshed'
    }

    const results = await Promise.all([
      coordinator.run('RACCOON_ACCOUNT_A', task),
      coordinator.run('RACCOON_ACCOUNT_A', task),
      coordinator.run('RACCOON_ACCOUNT_A', task),
    ])

    expect(calls).toBe(1)
    expect(results).toEqual(['refreshed', 'refreshed', 'refreshed'])
  })

  it('不同 key 并行执行（不互相串行化）', async () => {
    const coordinator = new RefreshCoordinator()
    const started: string[] = []
    let release: (() => void) | undefined
    const gate = new Promise<void>((resolve) => { release = resolve })

    const make = (key: string) => async (): Promise<string> => {
      started.push(key)
      await gate
      return key
    }

    const a = coordinator.run('key-a', make('key-a'))
    const b = coordinator.run('key-b', make('key-b'))
    // 两个都进入了任务体（说明没有被串行化等待前一个完成）。
    expect(started.sort()).toEqual(['key-a', 'key-b'])
    release?.()
    expect(await Promise.all([a, b])).toEqual(['key-a', 'key-b'])
  })

  it('完成后条目被清除，后续调用会重新执行（不是永久缓存）', async () => {
    const coordinator = new RefreshCoordinator()
    let calls = 0
    const task = async (): Promise<number> => ++calls

    expect(await coordinator.run('k', task)).toBe(1)
    expect(coordinator.pendingCount).toBe(0)
    expect(await coordinator.run('k', task)).toBe(2)
  })

  it('失败不缓存：一次失败不会让后续调用拿到同一个 rejected Promise', async () => {
    const coordinator = new RefreshCoordinator()
    let calls = 0
    const failing = async (): Promise<string> => {
      calls++
      throw new Error('refresh token has been used')
    }

    await expect(coordinator.run('k', failing)).rejects.toThrow('refresh token has been used')
    expect(coordinator.pendingCount).toBe(0)

    // 若不清理条目，这里会拿到同一个已 rejected 的 Promise —— 账号在进程
    // 生命周期内再也刷不动（静默失效）。
    let second = 0
    const ok = async (): Promise<number> => { second++; return 42 }
    expect(await coordinator.run('k', ok)).toBe(42)
    expect(second).toBe(1)
    expect(calls).toBe(1)
  })

  it('并发中的失败：所有等待者都收到同一个错误，且事后可重试', async () => {
    const coordinator = new RefreshCoordinator()
    const task = async (): Promise<string> => {
      await new Promise((resolve) => setTimeout(resolve, 10))
      throw new Error('boom')
    }

    const results = await Promise.allSettled([
      coordinator.run('k', task),
      coordinator.run('k', task),
    ])
    expect(results.map((r) => r.status)).toEqual(['rejected', 'rejected'])
    expect(coordinator.pendingCount).toBe(0)
  })

  it('pendingCount 反映进行中的 key 数（供诊断）', async () => {
    const coordinator = new RefreshCoordinator()
    let release: (() => void) | undefined
    const gate = new Promise<void>((resolve) => { release = resolve })
    const task = async (): Promise<void> => { await gate }

    const p1 = coordinator.run('a', task)
    const p2 = coordinator.run('b', task)
    expect(coordinator.pendingCount).toBe(2)
    release?.()
    await Promise.all([p1, p2])
    expect(coordinator.pendingCount).toBe(0)
  })

  it('按凭据 ref 为键：指向同一文件的两个账号也互斥（共享 token 必须同锁）', async () => {
    // 两个账号条目可以指向同一个凭据文件（共享同一份 token）。若按账号 id
    // 单飞就会漏掉这一层，两条刷新仍会互抢。
    const coordinator = new RefreshCoordinator()
    const sameRef = 'FILE:D:\\shared\\auth-a.json'
    const calls = vi.fn()
    const task = async (): Promise<void> => {
      calls()
      await new Promise((resolve) => setTimeout(resolve, 15))
    }
    await Promise.all([coordinator.run(sameRef, task), coordinator.run(sameRef, task)])
    expect(calls).toHaveBeenCalledTimes(1)
  })

  it('任务同步抛出也走 finally 清理（条目不留残）', async () => {
    const coordinator = new RefreshCoordinator()
    const syncThrow = (): Promise<never> => { throw new Error('sync') }
    await expect(coordinator.run('k', syncThrow)).rejects.toThrow('sync')
    expect(coordinator.pendingCount).toBe(0)
  })
})
