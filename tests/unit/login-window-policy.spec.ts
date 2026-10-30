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

  it('Magicrew 不自动开窗（凭据在服务端那扇一次性 profile 的窗口里）', () => {
    // ⚠️⚠️ 用户 2026-10-30 报障：「我点进去链接后 …/login 也没有响应回来，而且这种
    //    情况在同个浏览器，只能一个账号」。
    //
    //    根因：magicrew 没有 OAuth 回调，凭据只存在于浏览器的 localStorage。它的主
    //    登录路径是**服务端** spawn 一个一次性 profile 的窗口让用户登。在前端再开
    //    一个链接 = 在**用户自己的**浏览器里登，而服务端读的是它自己那个 profile
    //    ⇒ 永远读不到，界面表现就是「点了没反应」，直到 4 分钟超时。
    //
    //    与 officeace 的 false **理由不同**：那个是 SSO 静默复用（怕替用户选账号），
    //    这个纯粹是「那条链接对 magicrew 没有任何作用」。
    expect(shouldAutoOpenLoginWindow('magicrew')).toBe(false)
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

  it('Magicrew 的提示必须点明「窗口在服务端」与「加新账号用无痕窗口」', () => {
    // ⚠️ 三件事缺一不可，每一条都对应一次真实误解：
    //    ① 窗口由**服务端**开 —— 否则用户去点链接、在自己浏览器里登（本次报障）；
    //    ② 远程部署看不到那个窗口 ⇒ 改用「从本机浏览器导入」；
    //    ③ 一个浏览器只存一份登录态 —— 否则用户以为同一窗口能加多个账号
    //      （原话「只能一个账号」）。
    const hint = loginLinkHint('magicrew')
    expect(hint).toContain('服务端')
    expect(hint).toContain('从本机浏览器导入')
    expect(hint).toContain('无痕')
    // ⚠️ 且**不得**出现「授权回调」这类误导措辞：magicrew 没有回调，
    //    凭据靠**读浏览器**拿到。
    expect(hint).not.toContain('授权回调')
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

  it('rpc-bridge 必须登记 account.importLocalBrowser（否则「未知管理方法」）', () => {
    // ⚠️⚠️ 这条锁的是用户 2026-10-30 实测踩到的坑：面板按钮接好了、后端端点也写好了，
    //    但 **rpc-bridge 的方法分派表漏登记** ⇒ 点按钮得到一句
    //    「未知管理方法: account.importLocalBrowser」。
    //
    //    为什么极易漏：`rpcCall` 有两层 —— 面板里写 'rpcCall(method)'，
    //    而这层 bridge 负责把**方法名**翻译成 HTTP 路径。只加后端端点、只改面板
    //    调用，中间这张表不会报错，只会在运行时给一句「未知方法」。
    //
    //    ⚠️ 断言用方法名 + 路径**两个**串：只断言方法名可能是注释里出现的（本文件
    //    就有大量注释提到它），那会变成一条永远为真的假断言。
    const caseAt = bridgeSource.indexOf("case 'account.importLocalBrowser':")
    expect(caseAt).toBeGreaterThan(-1)
    // 路径必须在同一个 case 里（取该 case 到下一个 case 之间的片段）
    const after = bridgeSource.slice(caseAt)
    const nextCase = after.indexOf("case ", 10)
    const body = nextCase > 0 ? after.slice(0, nextCase) : after
    expect(body).toContain('/api/accounts/import-local-browser')
  })

  it('Magicrew 不展示登录链接（那条链接对它毫无作用）', () => {
    // ⚠️ 在用户自己的浏览器里打开 magicrew 的登录页毫无作用 —— 凭据要落在
    //    **服务端**那扇窗的 localStorage 里才读得到。展示它只会让用户以为
    //    「点了就该有反应」，然后对着没反应的页面反复点。
    expect(hubSource).toContain("provider !== 'magicrew' && loginUrlForManual")
  })

  it('Magicrew 的新建账号按钮走导入而不是 createAccount', () => {
    // ⚠️ 走 createAccount 会去调 /api/login/start 让**服务端**开窗，而服务端
    //    没有桌面时用户看不见那个窗口。
    expect(hubSource).toContain("provider === 'magicrew') void importLocalBrowserAccount()")
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
