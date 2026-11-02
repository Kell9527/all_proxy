/**
 * Magicrew **本机浏览器导入**的回归用例（`magicrew-local-browser.ts`）。
 *
 * 这一组只锁一件事：**扫描的浏览器目录必须是「用户真正可能装的那个」**。
 *
 * ## 为什么单独一个 spec 文件
 *
 * 2026-11-02 用户报障「MagiCrew (国际版)：我在网页登录了，为什么没识别到」。
 * 排查结论不是登录链路坏了，而是**候选链漏了整整一个浏览器通道**：
 *
 * | 通道 | User Data 目录 |
 * |---|---|
 * | Edge Stable | `<local>\Microsoft\Edge\User Data` |
 * | Edge **Beta** | `<local>\Microsoft\Edge Beta\User Data` |
 * | Edge Dev | `<local>\Microsoft\Edge Dev\User Data` |
 * | Edge Canary | `<local>\Microsoft\Edge **SxS**\User Data` |
 *
 * 旧实现只列了 Stable。真机实测（本机）：Stable 的 leveldb 里 `magicrew` 字样
 * **0 命中**，Beta 里 `https://www.magicrew.ai` 的记录**齐全** —— 用户就是装在
 * Beta 上。而症状与「用户没登录」**完全同形**：`not-found` ⇒ 面板提示
 * 「请先登录 www.magicrew.ai」，用户照着做了、还是一样的提示，**永远不可能成功**。
 *
 * ⚠️ 这类缺陷**没有任何报错**：漏一行候选链 = 那个浏览器的登录态读不到，
 * 而 `readdirSync` 失败本来就被静默跳过（合法行为，目录不存在是常态）。
 * ⇒ 只能靠「候选链里必须有它」这种**静态断言**锁住。
 *
 * ⚠️ 断言**不写死完整路径**（那是把 Windows 目录布局抄一遍，改了就误报），
 * 只断言「某个候选目录的**末段**形如 `Edge Beta`」这种稳定特征。
 */
import { describe, expect, it } from 'vitest'

import { magicrewBrowserRoots } from '../../src/providers/magicrew-local-browser.js'

/** 取一个候选目录的「产品段」（`User Data` 的上一级目录名）。 */
function productOf(root: string): string {
  const parts = root.replace(/[\\/]+$/, '').split(/[\\/]/)
  const userDataAt = parts.lastIndexOf('User Data')
  return userDataAt > 0 ? parts[userDataAt - 1]! : parts[parts.length - 1]!
}

describe('本机浏览器候选链：必须覆盖 Edge 的四个通道', () => {
  /** ⚠️ 只在 Windows 上有意义（其他平台没有这四通道布局）。 */
  const isWindows = process.platform === 'win32'

  it.runIf(isWindows)('Edge Beta 必须在候选链里', () => {
    // ⚠️⚠️ 这条就是本次报障的直接回归：漏了它，装在 Beta 上的用户
    //   「网页登录了却永远识别不到」，且弹的是「请先登录」这种**反向指引**。
    const products = magicrewBrowserRoots().map((entry) => productOf(entry.root))
    expect(products).toContain('Edge Beta')
  })

  it.runIf(isWindows)('Edge Stable / Dev / Canary 也都要在', () => {
    const products = magicrewBrowserRoots().map((entry) => productOf(entry.root))
    // Stable 是旧实现唯一有的那一条（回归时不能反把它弄丢）。
    expect(products).toContain('Edge')
    expect(products).toContain('Edge Dev')
    // ⚠️ Canary 的目录名是 **`Edge SxS`**（side-by-side），不是 `Edge Canary`。
    //    写 `Edge Canary` 会得到一个**不存在**的目录 ⇒ 该通道永远读不到。
    expect(products).toContain('Edge SxS')
  })

  it.runIf(isWindows)('Chrome 的 Beta / Dev / Canary 同样要覆盖', () => {
    const products = magicrewBrowserRoots().map((entry) => productOf(entry.root))
    expect(products).toContain('Chrome')
    expect(products).toContain('Chrome Beta')
    expect(products).toContain('Chrome Dev')
    // Chrome 的 Canary 目录名是 `Chrome SxS`。
    expect(products).toContain('Chrome SxS')
  })

  it.runIf(isWindows)('候选链里没有重复的 User Data 目录', () => {
    // ⚠️ 重复本身不致命（读取会命中两次），但意味着有一行写错了产品段
    //   （典型的复制粘贴后忘改名），那种错**同样静默**。
    const roots = magicrewBrowserRoots().map((entry) => entry.root.toLowerCase())
    expect(new Set(roots).size).toBe(roots.length)
  })

  it('每个候选都带可读的 browser 名（诊断日志要用它指出是哪个浏览器）', () => {
    for (const entry of magicrewBrowserRoots()) {
      expect(entry.browser.trim().length).toBeGreaterThan(0)
      expect(entry.root.trim().length).toBeGreaterThan(0)
    }
  })
})