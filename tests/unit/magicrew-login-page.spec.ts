/**
 * Magicrew 浏览器登录的**空白页导航**判据（来源 `bd73592` 四路审计 P1 D-05/D-06）。
 *
 * 锁三件事：
 * 1. **只导航空白页** —— 「兜底 `pages[0]`」会冲掉用户正在看的标签页；
 * 2. **空白页判据是前缀而不是全等** —— 真机实测空白形态远不止三种；
 * 3. **导航失败不抛** —— 抛了会让整条登录腿失败并删掉占位账号，而窗口明明还开着。
 *
 * 全部用**注入的假 CDP 通道**验证，绝不真起浏览器（本仓库记过两次
 * 「单测弹出真实浏览器窗口」的污染）。
 */
import { describe, expect, it } from 'vitest'

import {
  ensureMagicrewLoginPage,
  isBlankPageUrl,
} from '../../src/providers/magicrew-browser-login.js'

const LOGIN_URL = 'https://www.letsmagic.cn/login'

/** 造一个假 CDP 通道：记录调用，按需返回/抛错。 */
function stubCdp(options: {
  targets?: Array<{ type: string, targetId: string, url: string }>
  targetsError?: string
  navigateErrorText?: string
  navigateThrows?: string
  noSessionId?: boolean
} = {}) {
  const calls: Array<{ method: string, params?: Record<string, unknown>, sessionId?: string }> = []
  const cdp = {
    async send(method: string, params?: Record<string, unknown>, _timeoutMs?: number, sessionId?: string): Promise<unknown> {
      calls.push({ method, params, ...(sessionId === undefined ? {} : { sessionId }) })
      if (method === 'Target.getTargets') {
        if (options.targetsError !== undefined) throw new Error(options.targetsError)
        return { targetInfos: options.targets ?? [] }
      }
      if (method === 'Target.attachToTarget') {
        return options.noSessionId === true ? {} : { sessionId: 'sess-1' }
      }
      if (method === 'Page.navigate') {
        if (options.navigateThrows !== undefined) throw new Error(options.navigateThrows)
        return options.navigateErrorText === undefined ? {} : { errorText: options.navigateErrorText }
      }
      return {}
    },
  }
  return { cdp, calls }
}

describe('isBlankPageUrl：空白页判据是前缀而不是全等', () => {
  it('各种真机实测的空白形态都认', () => {
    for (const url of [
      'about:blank',
      'about:blank#x',
      'chrome://newtab/',
      'chrome://new-tab-page/',
      'chrome://new-tab-page/?foo=1',
      'chrome://new-tab-page-third-party/',
      'chrome-search://local-ntp/local-ntp.html',
      'edge://newtab/',
      'brave://newtab/',
      'vivaldi://newtab/',
    ]) {
      expect(isBlankPageUrl(url), `${url} 应判为空白页`).toBe(true)
    }
  })

  it('正常网页不是空白页', () => {
    for (const url of ['https://www.letsmagic.cn/login', 'https://example.com', 'about:srcdoc']) {
      expect(isBlankPageUrl(url), `${url} 不应判为空白页`).toBe(false)
    }
  })
})

describe('ensureMagicrewLoginPage', () => {
  it('已有同站点页面 ⇒ 不导航（不打扰用户）', async () => {
    const { cdp, calls } = stubCdp({
      targets: [{ type: 'page', targetId: 't1', url: 'https://www.letsmagic.cn/workspace' }],
    })
    await ensureMagicrewLoginPage({ cdp }, LOGIN_URL)
    expect(calls.some((call) => call.method === 'Page.navigate')).toBe(false)
  })

  it('有空白页 ⇒ 导航它（且只在 attach 出的 session 上导航）', async () => {
    const { cdp, calls } = stubCdp({
      targets: [
        { type: 'page', targetId: 'blank', url: 'chrome://newtab/' },
        { type: 'page', targetId: 'other', url: 'https://other.example.com' },
      ],
    })
    await ensureMagicrewLoginPage({ cdp }, LOGIN_URL)
    const attach = calls.find((call) => call.method === 'Target.attachToTarget')
    expect(attach?.params?.['targetId']).toBe('blank')
    const navigate = calls.find((call) => call.method === 'Page.navigate')
    expect(navigate?.params?.['url']).toBe(LOGIN_URL)
    expect(navigate?.sessionId).toBe('sess-1')
  })

  it('**没有**空白页 ⇒ 不导航（绝不冲掉用户正在看的标签页）', async () => {
    // ⚠️ 这是 P1 D-05 的核心：旧实现 `pages.find(about:blank) ?? pages[0]`
    //    会拿第一个页面开刀，而 `chrome://newtab/` 的 hostname 是 'newtab'
    //    （非空、非同站点）⇒ 它被当成普通页面 ⇒ 用户标签页被劫。
    const { cdp, calls } = stubCdp({
      targets: [
        { type: 'page', targetId: 'a', url: 'https://a.example.com' },
        { type: 'page', targetId: 'b', url: 'https://b.example.com' },
      ],
    })
    await ensureMagicrewLoginPage({ cdp }, LOGIN_URL)
    expect(calls.some((call) => call.method === 'Page.navigate')).toBe(false)
  })

  it('纳管到用户当前所在页面（即便是 chrome://newtab）也不会导航该页', async () => {
    const { cdp, calls } = stubCdp({
      targets: [{ type: 'page', targetId: 'a', url: 'https://a.example.com' }],
    })
    await ensureMagicrewLoginPage({ cdp }, LOGIN_URL)
    expect(calls.some((call) => call.method === 'Page.navigate')).toBe(false)
  })

  it('读页面列表失败 ⇒ 只记诊断，**不抛**（窗口开着，用户可自己操作）', async () => {
    const { cdp } = stubCdp({ targetsError: 'CDP 断了' })
    const logs: string[] = []
    await expect(ensureMagicrewLoginPage({ cdp }, LOGIN_URL, (m) => logs.push(m))).resolves.toBeUndefined()
    expect(logs.join('\n')).toContain('读取浏览器页面列表失败')
  })

  it('导航报 errorText ⇒ 只记诊断，不抛', async () => {
    const { cdp } = stubCdp({
      targets: [{ type: 'page', targetId: 'blank', url: 'about:blank' }],
      navigateErrorText: 'net::ERR_ABORTED',
    })
    const logs: string[] = []
    await expect(ensureMagicrewLoginPage({ cdp }, LOGIN_URL, (m) => logs.push(m))).resolves.toBeUndefined()
    expect(logs.join('\n')).toContain('net::ERR_ABORTED')
  })

  it('导航抛错（黑洞地址 15 秒不返回那种）⇒ 只记诊断，不抛', async () => {
    const { cdp } = stubCdp({
      targets: [{ type: 'page', targetId: 'blank', url: 'about:blank' }],
      navigateThrows: 'Page.navigate 超时',
    })
    const logs: string[] = []
    await expect(ensureMagicrewLoginPage({ cdp }, LOGIN_URL, (m) => logs.push(m))).resolves.toBeUndefined()
    expect(logs.join('\n')).toContain('窗口仍开着')
  })

  it('attach 拿不到 sessionId ⇒ 不导航、不抛', async () => {
    const { cdp, calls } = stubCdp({
      targets: [{ type: 'page', targetId: 'blank', url: 'about:blank' }],
      noSessionId: true,
    })
    await ensureMagicrewLoginPage({ cdp }, LOGIN_URL)
    expect(calls.some((call) => call.method === 'Page.navigate')).toBe(false)
  })

  it('CDP 通道压根没就绪 ⇒ **抛**（那时连「窗口开着」都不成立）', async () => {
    await expect(ensureMagicrewLoginPage({ cdp: undefined }, LOGIN_URL)).rejects.toThrow(/调试通道未就绪/)
  })
})
