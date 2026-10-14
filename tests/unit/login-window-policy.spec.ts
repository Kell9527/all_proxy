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
  it('OfficeAce 的提示必须点明「不能选账号」与「不同的华为账号」', () => {
    const hint = loginLinkHint('officeace')
    // 用户 2026-10-14 卡点：在无痕窗口登的还是同一个华为账号，授权出来的
    // 自然是已加过的那一个（判重提示「已在池中」）。不说「不能选账号 +
    // 要登不同的账号」，用户会一直对着「欢迎使用」回调页困惑。
    expect(hint).toContain('不能选账号')
    expect(hint).toContain('不同的华为账号')
    expect(hint).toContain('无痕')
    expect(hint).toContain('其他浏览器')
  })

  it('OfficeAce 的提示要说明「欢迎使用」回调页即授权成功（不是错误）', () => {
    expect(loginLinkHint('officeace')).toContain('欢迎使用OfficeAce')
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

  it('判重命中时前端提示「已在池中」并指引如何加新账号（reused 一路透传）', () => {
    // rpc-bridge：login.poll 透传 reused
    expect(bridgeSource).toContain('reused: r.reused === true')
    // jet-hub：done 时消费 reused
    const start = hubSource.indexOf('const createAccount = async (region)')
    const body = hubSource.slice(start, hubSource.indexOf('\n  };', start))
    expect(body).toContain('pollRes.reused === true')
    expect(body).toContain('未重复添加')
    // ⚠️ 提示必须带「怎么加新账号」的指引：用户 2026-10-14 在这里卡了一整轮
    // —— 他在无痕窗口登的还是同一个华为账号，授权出来的自然是同一个。
    expect(body).toContain('不同的华为账号')
  })
})

describe('授权等待时长（源码级断言）', () => {
  const here = dirname(fileURLToPath(import.meta.url))
  const hubSource = readFileSync(resolve(here, '../../plugin-src/client/jet-hub.js'), 'utf8')

  it('前端轮询上限与后端会话 TTL 对齐（30 分钟）', () => {
    // 用户报障「授权后账号没添加」的形态之一：前端 5 分钟就停轮询，后端
    // 10 分钟才清会话 —— 后端落了账号而界面不刷新，用户看到的是旧列表。
    expect(hubSource).toContain('const LOGIN_POLL_TIMEOUT_MS = 30 * 60 * 1000;')
    // 不得再出现写死的 300000（5 分钟）
    expect(hubSource).not.toContain('}, 300000);')
  })

  it('等待期间显示「已等待」与超时提示', () => {
    expect(hubSource).toContain('已等待 ${Math.floor(waitSeconds / 60)} 分')
    expect(hubSource).toContain('等待已超时（30 分钟），此链接已失效')
  })
})

describe('登录失败必须停损并显示（源码级断言）', () => {
  const here = dirname(fileURLToPath(import.meta.url))
  const hubSource = readFileSync(resolve(here, '../../plugin-src/client/jet-hub.js'), 'utf8')
  const bridgeSource = readFileSync(resolve(here, '../../web/src/rpc-bridge.js'), 'utf8')

  it('rpc-bridge 的业务失败返回标记而不是 throw', () => {
    // 2026-10-14 用户连续三次报障「授权成功但账号没加进来」的真相：
    // 另一个华为账号没开通 ModelArts MaaS，后端明确 reject 了，但这里
    // throw 之后被 createAccount 的 catch 静默吞掉，用户只看到沉默。
    expect(bridgeSource).toContain("failed: true")
    expect(bridgeSource).not.toContain("if (r.status === 'failed') throw new Error")
    // 会话不存在（重启/超时）也是终态：转成 failed 标记，别每秒重放 404
    expect(bridgeSource).toContain('登录会话不存在')
  })

  it('createAccount 收到 failed 后停损（停轮询）+ 显示原因', () => {
    const start = hubSource.indexOf('const createAccount = async (region)')
    expect(start).toBeGreaterThan(-1)
    const body = hubSource.slice(start, hubSource.indexOf('\n  };', start))
    expect(body).toContain('pollRes.failed === true')
    // 停损：清掉轮询与计时器（不能继续轮到一个已失败的会话）
    const failIndex = body.indexOf('pollRes.failed === true')
    const afterFail = body.slice(failIndex, failIndex + 1200)
    expect(afterFail).toContain('clearInterval(pollTimer)')
    expect(afterFail).toContain('clearInterval(waitTicker)')
    // 显示：错误原因 + 可操作的下一步
    expect(afterFail).toContain('登录失败')
    expect(afterFail).toContain('新建账号')
  })
})
