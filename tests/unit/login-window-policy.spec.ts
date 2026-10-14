import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import {
  loginLinkHint,
  shouldAutoOpenLoginWindow,
} from '../../plugin-src/client/login-window-policy.js'

/**
 * 登录窗口打开策略的回归测试。
 *
 * 背景（用户 2026-10-14 报障）：「OfficeAce 新建账号每次都会自动登录同一个
 * 账号」—— 华为云授权页是 SSO 页面，静默复用浏览器已登录的账号，自动开窗
 * 等于替用户决定用哪个账号。修法：OfficeAce 不自动开窗，链接交给用户
 * （要去其他浏览器/无痕窗口才登得了别的账号）。
 */

describe('shouldAutoOpenLoginWindow', () => {
  it('OfficeAce 不自动开窗（SSO 静默复用，自动开窗=替用户选账号）', () => {
    expect(shouldAutoOpenLoginWindow('officeace')).toBe(false)
  })

  it('其余 provider 保持自动开窗（省一次点击）', () => {
    for (const id of ['codearts', 'buddy', 'workbuddy', 'lobsterai', 'qoder', 'qodercn', 'trae', 'cline', 'loomy', 'raccoon', 'accio', 'sensenova']) {
      expect(shouldAutoOpenLoginWindow(id), `${id} 应自动开窗`).toBe(true)
    }
  })

  it('未知 provider 按自动开窗处理（保守：不改变既有交互）', () => {
    expect(shouldAutoOpenLoginWindow('newthing')).toBe(true)
  })
})

describe('loginLinkHint', () => {
  it('OfficeAce 的提示必须点明「静默复用」与「无痕窗口」', () => {
    const hint = loginLinkHint('officeace')
    expect(hint).toContain('无痕')
    expect(hint).toContain('其他浏览器')
    // 关键警告：不说这句话，用户在当前浏览器点链接还是登同一个账号
    expect(hint).toContain('复用')
  })

  it('其余 provider 的提示讲拦截与远程场景', () => {
    const hint = loginLinkHint('accio')
    expect(hint).toContain('本机浏览器')
    expect(hint).not.toContain('无痕')
  })
})

// ───────────────────────── 接线回归（源码级） ─────────────────────────

describe('登录开窗接线（源码级断言）', () => {
  const here = dirname(fileURLToPath(import.meta.url))
  const hubSource = readFileSync(resolve(here, '../../plugin-src/client/jet-hub.js'), 'utf8')
  const bridgeSource = readFileSync(resolve(here, '../../web/src/rpc-bridge.js'), 'utf8')

  it('createAccount 的开窗动作受 shouldAutoOpenLoginWindow 守卫', () => {
    const start = hubSource.indexOf('const createAccount = async (region)')
    expect(start).toBeGreaterThan(-1)
    const body = hubSource.slice(start, hubSource.indexOf('\n  };', start))
    expect(body).toContain('shouldAutoOpenLoginWindow(provider)')
    // 守卫必须在 window.open 之前（否则等于没守）
    expect(body.indexOf('shouldAutoOpenLoginWindow(provider)')).toBeLessThan(body.indexOf('window.open'))
  })

  it('登录链接区使用 loginLinkHint（OfficeAce 的无痕提示由此到达界面）', () => {
    expect(hubSource).toContain('loginLinkHint(provider)')
  })

  it('判重命中时前端提示「已在池中」（reused 一路透传）', () => {
    // rpc-bridge：login.poll 透传 reused
    expect(bridgeSource).toContain('reused: r.reused === true')
    // jet-hub：done 时消费 reused
    const start = hubSource.indexOf('const createAccount = async (region)')
    const body = hubSource.slice(start, hubSource.indexOf('\n  };', start))
    expect(body).toContain('pollRes.reused === true')
    expect(body).toContain('未重复添加')
  })
})
