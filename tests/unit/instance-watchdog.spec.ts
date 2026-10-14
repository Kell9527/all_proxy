import { describe, expect, it, vi } from 'vitest'
import {
  RELOAD_DELAY_MS,
  WATCHDOG_INTERVAL_MS,
  shouldReload,
  startInstanceWatchdog,
} from '../../web/src/instance-watchdog.js'

/**
 * 「重启看门狗」的回归测试。
 *
 * 背景（用户 2026-10-14 提问）：`proxy.bat restart` 只换 node 进程，浏览器里
 * 已打开的管理页不会自知，继续把 RPC 打给死上下文。看门狗轮询 `/health` 的
 * `instanceStartedAt` 识别实例切换并自动刷新。
 *
 * 三条边界是测试重点：首轮只记基线、读不到不动作、页面不可见时跳过。
 */

describe('shouldReload', () => {
  it('首轮只记基线，不刷新（否则每次打开页面都白刷一次）', () => {
    expect(shouldReload(null, 1_800_000_000_000)).toBe(false)
    expect(shouldReload(undefined, 1_800_000_000_000)).toBe(false)
  })

  it('实例启动时刻变了才刷新', () => {
    expect(shouldReload(1_800_000_000_000, 1_800_000_000_000)).toBe(false)
    expect(shouldReload(1_800_000_000_000, 1_800_000_060_000)).toBe(true)
  })

  it('本轮读不到（服务正在重启 / 载荷缺字段）⇒ 不动作', () => {
    // 启动中的服务同样 fetch 失败，此刻刷新只会得到连接错误页。
    expect(shouldReload(1_800_000_000_000, null)).toBe(false)
    expect(shouldReload(1_800_000_000_000, undefined)).toBe(false)
    // 载荷被缓存/篡改成的非数字值同样不触发
    expect(shouldReload(1_800_000_000_000, 'x')).toBe(false)
    expect(shouldReload(1_800_000_000_000, 0)).toBe(false)
  })
})

/** 造一个可手动触发的假定时器。 */
function fakeTimers() {
  const jobs: Array<() => void> = []
  return {
    setTimer: (fn: () => void, _ms: number) => { jobs.push(fn); return jobs.length },
    clearTimer: () => {},
    /**
     * 触发所有已注册的定时任务（模拟一次「间隔到点」）。
     *
     * ⚠️ **不清空任务**：真实 `setInterval` 会反复触发同一批任务，清空会让
     * 第二次起全部空转（看门狗只在启动时注册一次，不会自己补注册）。
     */
    runAll: () => { for (const job of [...jobs]) job() },
    count: () => jobs.length,
  }
}

/** 造按序返回的 /health 替身。 */
function fakeFetcher(sequence: Array<number | Error>) {
  let index = 0
  return vi.fn(async () => {
    const next = sequence[Math.min(index, sequence.length - 1)]!
    index += 1
    if (next instanceof Error) throw next
    return { ok: true, json: async () => ({ instanceStartedAt: next }) } as unknown as Response
  })
}

describe('startInstanceWatchdog', () => {
  it('启动即取基线；实例不变则不刷新', async () => {
    const timers = fakeTimers()
    const fetcher = fakeFetcher([1000])
    const reload = vi.fn()
    startInstanceWatchdog({ fetcher, reload, setTimer: timers.setTimer, clearTimer: timers.clearTimer })
    // 立即取基线（不等第一个间隔）
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve()
    expect(fetcher).toHaveBeenCalledTimes(1)
    // 只注册了一个轮询任务（runAll 会消费掉它，故在消费前断言）
    expect(timers.count()).toBe(1)
    timers.runAll()
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve()
    // 同一实例：只多一次查询，绝不刷新
    expect(fetcher).toHaveBeenCalledTimes(2)
    expect(reload).not.toHaveBeenCalled()
  })

  it('实例启动时刻变化 ⇒ 提示 + 延迟刷新（给用户看到那一一眼）', async () => {
    vi.useFakeTimers()
    try {
      const timers = fakeTimers()
      const fetcher = fakeFetcher([1000, 2000])
      const reload = vi.fn()
      const notify = vi.fn()
      const stop = startInstanceWatchdog({
        fetcher, reload, notify, setTimer: timers.setTimer, clearTimer: timers.clearTimer,
      })
      await vi.advanceTimersByTimeAsync(0)
      // 第一轮：记基线
      timers.runAll()
      await vi.advanceTimersByTimeAsync(0)
      expect(reload).not.toHaveBeenCalled()
      // 第二轮：实例变了
      timers.runAll()
      await vi.advanceTimersByTimeAsync(0)
      expect(notify).toHaveBeenCalledTimes(1)
      // 刷新是**延迟**的（横幅要能被看到）
      expect(reload).not.toHaveBeenCalled()
      await vi.advanceTimersByTimeAsync(RELOAD_DELAY_MS)
      expect(reload).toHaveBeenCalledTimes(1)
      stop()
    } finally {
      vi.useRealTimers()
    }
  })

  it('服务重启期间 fetch 失败 ⇒ 不刷新，恢复后按新实例刷新', async () => {
    const timers = fakeTimers()
    // 1000 → 连接被拒（重启中）→ 1000（还是老实例，不刷）→ 2000（新实例，刷）
    const fetcher = fakeFetcher([1000, new Error('ECONNREFUSED'), 1000, 2000])
    const reload = vi.fn()
    const notify = vi.fn()
    startInstanceWatchdog({
      fetcher, reload, notify, setTimer: timers.setTimer, clearTimer: timers.clearTimer,
    })
    const settle = async () => { for (let i = 0; i < 6; i += 1) await Promise.resolve() }
    await settle()            // 基线 1000
    timers.runAll(); await settle()   // ECONNREFUSED：不动作
    timers.runAll(); await settle()   // 仍是 1000：不刷
    expect(notify).not.toHaveBeenCalled()
    timers.runAll(); await settle()   // 2000：换了实例
    expect(notify).toHaveBeenCalledTimes(1)
    // reload 走真实 setTimeout（RELOAD_DELAY_MS），等它到点
    await new Promise((r) => setTimeout(r, RELOAD_DELAY_MS + 50))
    expect(reload).toHaveBeenCalledTimes(1)
  })

  it('页面不可见时跳过本轮（省请求，也不在后台标签页刷新用户）', async () => {
    const timers = fakeTimers()
    const fetcher = fakeFetcher([1000])
    const reload = vi.fn()
    startInstanceWatchdog({
      fetcher, reload, isHidden: () => true,
      setTimer: timers.setTimer, clearTimer: timers.clearTimer,
    })
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve()
    timers.runAll()
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve()
    expect(fetcher).not.toHaveBeenCalled()
    expect(reload).not.toHaveBeenCalled()
  })

  it('停止后不再轮询（热更新/卸载安全）', async () => {
    const timers = fakeTimers()
    const fetcher = fakeFetcher([1000])
    const stop = startInstanceWatchdog({ fetcher, setTimer: timers.setTimer, clearTimer: timers.clearTimer })
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve()
    stop()
    const before = fetcher.mock.calls.length
    timers.runAll()
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve()
    expect(fetcher.mock.calls.length).toBe(before)
  })

  it('默认间隔 5 秒（重启是低频人为操作，不需要更密）', () => {
    expect(WATCHDOG_INTERVAL_MS).toBe(5000)
  })
})
