/**
 * 管理端「重启看门狗」：服务进程被换掉时自动刷新界面。
 *
 * ## 它解决什么（用户 2026-10-14 提问）
 *
 * 「通过 proxy.bat 重启，不会刷新界面吗？」—— **不会**。`proxy.bat restart`
 * 只换 node 进程，浏览器里已打开的 SPA 对此一无所知，会继续把 RPC 打给
 * 一个已经死掉的上下文：账号面板一片「查询失败」、新建账号卡在轮询，
 * 而用户以为功能坏了。手动 F5 才能恢复。
 *
 * ## 判据
 *
 * 轮询 `GET /health`（**不鉴权、不触达上游**，规格本就豁免）读
 * `instanceStartedAt` —— 后端在**进程启动时**取一次的时间戳。值变了
 * 就是「换了实例」，此时才 reload。
 *
 * 三条边界：
 * 1. **首轮只记基线不刷新**（否则每次打开页面都白刷一次）；
 * 2. **本轮读不到（服务正在重启 / 网络抖动）不动作** —— 启动中的服务同样
 *    fetch 失败，此刻刷新只会得到一个连接错误页，不如等它起来；
 * 3. **页面不可见时跳过本轮**（`document.hidden`）—— 省请求，也避免用户
 *    在别的标签页时被刷新。
 */

/** 轮询间隔（毫秒）。5 秒：重启是低频人为操作，不需要更密。 */
export const WATCHDOG_INTERVAL_MS = 5000

/**
 * 检测到实例变化后、reload 前的展示停顿（毫秒）。
 *
 * 给用户看到「服务已重启，正在刷新」的那一眼 —— 否则页面自己抽动一下，
 * 用户只会觉得「界面刚才是不是闪了」。
 */
export const RELOAD_DELAY_MS = 1200

/**
 * 是否应该重载页面（**纯函数**，单测直接守）。
 *
 * @param previous - 上一轮成功读到的实例启动时刻；首轮为 `null`。
 * @param current - 本轮读到的实例启动时刻；读不到为 `null`。
 * @returns `true` 表示服务换了实例，应 reload。
 */
export function shouldReload(previous, current) {
  // 本轮没读到：等下一次成功（见文件头边界 2）。
  if (typeof current !== 'number' || !Number.isFinite(current) || current <= 0) return false
  // 首轮只记基线（见文件头边界 1）。
  if (previous === null || previous === undefined) return false
  return current !== previous
}

/**
 * 重启提示横幅（真实浏览器里调用；单测经 `notify` 注入替身）。
 *
 * 用原生 DOM 而不是 React：这一刻 React 树还在但即将被整体丢弃，
 * 再走一遍 setState 既慢又可能被并发刷新打断。
 */
function showRestartBanner() {
  if (typeof document === 'undefined') return
  const bar = document.createElement('div')
  bar.setAttribute('data-instance-watchdog', 'restarting')
  bar.style.cssText = 'position:fixed;top:0;left:0;right:0;z-index:2147483647;'
    + 'padding:8px 16px;background:#1677ff;color:#fff;font:13px/1.5 system-ui,sans-serif;'
    + 'text-align:center;box-shadow:0 2px 8px rgba(0,0,0,.2)'
  bar.textContent = '服务已重启，正在刷新界面…'
  document.body.appendChild(bar)
}

/**
 * 看门狗的依赖注入（测试替身；生产全部走默认实现）。
 *
 * - `intervalMs`：轮询间隔；
 * - `fetcher`：取 `/health` 的函数（测试注入假实现）；
 * - `reload`：刷新动作（测试注入 spy）；
 * - `notify`：实例变化时的提示（测试据此断言「提示过」）；
 * - `isHidden`：页面是否不可见（默认读 `document.hidden`）；
 * - `setTimer` / `clearTimer`：定时器（测试注入假定时器，避免真实等待）。
 */

/**
 * 启动看门狗。
 *
 * @returns 停止函数（卸载/热更新时调用；幂等）。
 */
export function startInstanceWatchdog(options = {}) {
  const intervalMs = options.intervalMs ?? WATCHDOG_INTERVAL_MS
  const fetcher = options.fetcher ?? ((url, init) => fetch(url, init))
  const reload = options.reload ?? (() => { globalThis.location?.reload?.() })
  const notify = options.notify ?? showRestartBanner
  const isHidden = options.isHidden ?? (() => globalThis.document?.hidden === true)
  const setTimer = options.setTimer ?? ((fn, ms) => setInterval(fn, ms))
  const clearTimer = options.clearTimer ?? ((handle) => clearInterval(handle))

  /** 已确认的实例启动时刻；`null` = 还没拿到基线。 */
  let known = null
  let stopped = false

  const tick = async () => {
    if (stopped) return
    if (isHidden()) return
    let instanceStartedAt = null
    try {
      const res = await fetcher('/health', { cache: 'no-store' })
      if (res.ok) {
        const body = await res.json()
        if (typeof body.instanceStartedAt === 'number') instanceStartedAt = body.instanceStartedAt
      }
    } catch {
      // 服务正在重启（连接被拒）或网络抖动：不动作，等下一轮。
      return
    }
    if (instanceStartedAt === null) return
    if (shouldReload(known, instanceStartedAt)) {
      stopped = true
      clearTimer(handle)
      notify()
      setTimeout(reload, RELOAD_DELAY_MS)
      return
    }
    known = instanceStartedAt
  }

  const handle = setTimer(() => { void tick() }, intervalMs)
  // 立即取一次基线（不等第一个间隔）：页面打开期间服务就重启过也要能发现。
  void tick()
  return () => { stopped = true; clearTimer(handle) }
}
