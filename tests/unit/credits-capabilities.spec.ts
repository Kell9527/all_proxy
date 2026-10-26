import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import {
  CREDITS_CAPABILITIES,
  checkinProviders,
  supportsCreditBalance,
  supportsDailyBonus,
  supportsDailyCheckin,
  supportsDailyKeepalive,
  supportsOnboardingTasks,
  supportsPermanentLock,
} from '../../plugin-src/client/credits-capabilities.js'

/**
 * 取出某个顶层函数/常量的**完整**源码体。
 *
 * ⚠️ 不要用「起点 + 固定字符数」来截取：函数体会随功能增长，写死的窗口迟早
 * 把真实存在的代码切在窗口外，于是断言**假失败**（源码明明是对的）。
 * 这里改为按「下一个顶层声明」定界 —— 源码怎么长都不会漏。
 *
 * 顶层声明 = 行首无缩进的 `function` / `const` / `let` / `export`。
 */
function sliceTopLevel(normalized: string, declaration: string): string {
  const start = normalized.indexOf(declaration)
  if (start < 0) return ''
  // 从声明之后找下一个行首无缩进的声明起点。
  const rest = normalized.slice(start + declaration.length)
  const next = /\n(?:function |const |let |export )/.exec(rest)
  return next === null ? rest : rest.slice(0, next.index)
}

/**
 * 积分能力矩阵的回归测试。
 *
 * 真实缺陷（用户报障）：打开 Jet Hub 的 **CodeArts** 面板时控制台必现
 * ```
 * [jet-hub] load credits failed: Error: unsupported provider: codearts
 * ```
 * 根因是客户端 `loadCredits()` 在面板挂载时**对所有 provider 无条件**调用
 * `credits.balances`，而当时该端点以 `productById()` 判能力，CodeArts 根本
 * 不是 BuddyProduct，必定返回 bad-request。
 *
 * 修法是「请求前按能力门控」。因此这里守两件事：
 * 1. 能力矩阵本身正确（尤其 WorkBuddy 余额真/签到假、未登记项默认关闭）；
 * 2. 客户端源码里**不存在绕过门控的调用点** —— UI 组件无法在单测里渲染
 *    （react 不在本仓库依赖内），故用源码级断言锁死守卫存在。
 *
 * 注：CodeArts 后来已接入真实实现（`src/codearts-credits.ts`，华为云签名），
 * 故其能力由全假变为全真；**门控机制本身不变**，仍是防止「对不支持的
 * provider 发必然失败的请求」的那道闸。
 */
describe('积分能力矩阵', () => {
  it('CodeArts 余额与签到都支持（华为云 SDK-HMAC-SHA256 签名协议）', () => {
    // 华为云走 `snap-access` 的签名端点，与腾讯系协议完全不同源，
    // 但**能力上两项都具备**（见 src/codearts-credits.ts）。
    expect(CREDITS_CAPABILITIES.codearts).toEqual({ balance: true, dailyCheckin: true })
    expect(supportsCreditBalance('codearts')).toBe(true)
    expect(supportsDailyCheckin('codearts')).toBe(true)
  })

  it('CodeBuddy 余额与签到都支持', () => {
    expect(supportsCreditBalance('buddy')).toBe(true)
    expect(supportsDailyCheckin('buddy')).toBe(true)
  })

  it('WorkBuddy 国际版支持余额但不支持签到（余额与签到是彼此独立的能力）', () => {
    // 这条断言专治「因为国际版没有签到，就推断也查不到余额」的错误推断。
    expect(supportsCreditBalance('workbuddy')).toBe(true)
    expect(supportsDailyCheckin('workbuddy')).toBe(false)
  })

  it('Qoder 两项能力都有（余额 + 每日领取）', () => {
    // ⚠️ 早期把 qoder 误判为「两项皆无」，随后又误判为「有余额、无签到」，
    // 两次都值得记录：
    //
    // ① 余额：只按 `/api/` 前缀搜端点，而它挂在 `/sash/api/v2/me/usage`，
    //    且**只需 Bearer + Cosy-ClientType**（不需要模型列表那样的 WASM 签名）。
    // ② 签到：曾依据 `/sash/api/v1/me/campaigns` 返回 `claimable:false,
    //    campaigns:[]` 判定「没有签到端点」。真相是**那天已领** ——
    //    活动每日 10:00（UTC+8）刷新。2026-09-21 用 keylog 解密抓包拿到了
    //    领取端点（`POST …/{campaignId}/claim`）与幂等证据（`replayed:true`）。
    //
    // 教训：「某次实测没看到」不能推广成「不存在」。
    expect(CREDITS_CAPABILITIES.qoder).toEqual({ balance: true, dailyCheckin: true })
    expect(supportsCreditBalance('qoder')).toBe(true)
    expect(supportsDailyCheckin('qoder')).toBe(true)
  })

  it('Qoder 中国版：余额与签到都支持，与国际版同形', () => {
    // 依据（设计文档 E7/E10）：CN 的 `/sash/api/v2/me/usage` 与
    // `/sash/api/v1/me/campaigns` 零凭据实测返回 `401 {"code":"TOKEN_INVALID",
    // "message":"missing authorization token"}`，与国际版**逐字节同形**；
    // CN asar 里同样是 `Fh = Object.freeze({ clientType: 10, … })`。
    //
    // ⚠️ 「端点存在」不等于「活动一定下发」—— 真实领取由
    // `pnpm test:e2e:qodercn-credits` 验证。若将来确认 CN 无签到，改这里时
    // 必须换成强证据（扫 CN asar 无 claim 端点），**不要**写「某次没看到」
    // —— 上面那条 qoder 用例的教训正是这样来的。
    expect(CREDITS_CAPABILITIES.qodercn).toEqual({ balance: true, dailyCheckin: true })
    expect(supportsCreditBalance('qodercn')).toBe(true)
    expect(supportsDailyCheckin('qodercn')).toBe(true)
  })

  it('中国版出现在一键签到的遍历渠道里（由能力表推导，非硬编码）', () => {
    // 页头「一键签到」遍历 `checkinProviders()`；漏登记的表现是
    // 「新渠道永远不被签到」，而不是报错 —— 故必须显式断言在里面。
    expect(checkinProviders()).toContain('qodercn')
    // 顺序紧跟国际版（本表声明顺序即请求顺序）。
    expect(checkinProviders().indexOf('qodercn')).toBe(checkinProviders().indexOf('qoder') + 1)
  })

  it('Loomy 三项能力：余额 + 每日签到 + 新手任务', () => {
    expect(CREDITS_CAPABILITIES.loomy)
      .toEqual({ balance: true, dailyCheckin: true, onboardingTasks: true })
    expect(supportsCreditBalance('loomy')).toBe(true)
    expect(supportsDailyCheckin('loomy')).toBe(true)
    expect(supportsOnboardingTasks('loomy')).toBe(true)
  })

  /**
   * ⚠️ `onboardingTasks` 与 `dailyCheckin` **语义独立**，不能互相推断：
   * - `dailyCheckin` = 每日额度刷新（每天有收益）
   * - `onboardingTasks` = 新手任务 10000 分（**一次性**，每号只能领一次）
   * 故只有 Loomy 同时具备两者，其余 provider 的 onboardingTasks 必须为 false。
   */
  it('onboardingTasks 只对 Loomy 为 true（新手任务是一次性的）', () => {
    for (const id of ['codearts', 'buddy', 'workbuddy', 'lobsterai', 'qoder', 'trae', 'cline']) {
      expect(supportsOnboardingTasks(id), `${id} 不应支持新手任务`).toBe(false)
    }
  })

  it('未登记的 provider 的 onboardingTasks 默认关闭', () => {
    for (const unknown of ['', 'newprovider', '__proto__']) {
      expect(supportsOnboardingTasks(unknown), unknown).toBe(false)
    }
  })

  it('未登记的 provider 默认不支持任何积分能力（默认关闭）', () => {
    // 新增 provider 时若忘记登记，最坏结果是暂时看不到积分，
    // 而不是每次打开面板都发一个必然失败的请求。
    for (const unknown of ['', 'newprovider', 'CODEARTS', '__proto__']) {
      expect(supportsCreditBalance(unknown), unknown).toBe(false)
      expect(supportsDailyCheckin(unknown), unknown).toBe(false)
      expect(supportsDailyKeepalive(unknown), unknown).toBe(false)
    }
  })

  /**
   * `dailyKeepalive`（每日积分保活）是与签到、新手任务都不同的第三种能力：
   * 积分**已自动发放**，本操作只是保住它不过期。
   *
   * ⚠️ 目前只有 raccoon 具备 —— 其余渠道要么没有「自动发放 + 当日作废」的
   * 积分模型，要么已有可调用的签到端点。误登记会让面板渲染一个必然失败的
   * 按钮（与 CodeArts 早期「无条件发请求」是同一类缺陷）。
   */
  it('dailyKeepalive 只对 raccoon 为 true', () => {
    expect(supportsDailyKeepalive('raccoon')).toBe(true)
    for (const id of ['codearts', 'buddy', 'workbuddy', 'lobsterai', 'qoder', 'qodercn', 'trae', 'cline', 'loomy']) {
      expect(supportsDailyKeepalive(id), `${id} 不应支持每日积分保活`).toBe(false)
    }
  })

  it('能力矩阵覆盖 PROVIDERS 中的每一个 provider', () => {
    // 客户端 PROVIDERS 列表与能力表必须同步：漏登记的 provider 会静默失去
    // 积分能力（默认关闭），而多登记的条目则是死配置。
    const source = readClientSource()
    const providerIds = [...source.matchAll(/\{\s*id:\s*'([a-z]+)',\s*label:/g)].map((m) => m[1]!)
    expect(providerIds.length).toBeGreaterThan(0)
    for (const id of providerIds) {
      expect(CREDITS_CAPABILITIES, `缺少 ${id} 的能力登记`).toHaveProperty(id)
    }
    expect(Object.keys(CREDITS_CAPABILITIES).sort()).toEqual([...providerIds].sort())
  })

  /**
   * Accio / OfficeAce（2026-10-14 接入余额查询）。
   *
   * 此前两项皆 false 的根因是「只移植了推理」：Accio 的三个只读端点与
   * OfficeAce 的 V11-HMAC-SHA256 签名都没移植，面板于是只剩登录态
   * （用户报障「本地仅显示登录状态，无其它显示」）。
   */
  it('Accio 支持余额但不支持签到（每日积分由登录触发服务端发放）', () => {
    expect(CREDITS_CAPABILITIES.accio).toEqual({ balance: true, dailyCheckin: false })
    expect(supportsCreditBalance('accio')).toBe(true)
    expect(supportsDailyCheckin('accio')).toBe(false)
  })

  it('OfficeAce 支持余额但不支持签到（定时任务自动领，另给手动补领按钮）', () => {
    expect(CREDITS_CAPABILITIES.officeace).toEqual({ balance: true, dailyCheckin: false, dailyBonus: true })
    expect(supportsCreditBalance('officeace')).toBe(true)
    // ⚠️ 仍为 false：绑成签到按钮会让用户以为「每天必须手动点」，
    // 实际服务端每小时自动领一次。
    expect(supportsDailyCheckin('officeace')).toBe(false)
    // 手动兜底：定时任务只在进程活着时跑，关掉服务过夜会错过当天窗口。
    expect(supportsDailyBonus('officeace')).toBe(true)
    // 与「每日积分保活」（把已到账积分延长有效期）是不同能力，不可混用。
    expect(supportsDailyKeepalive('officeace')).toBe(false)
  })

  it('补领能力只对 OfficeAce 开放（其余渠道没有「按自然日发放」的福利）', () => {
    expect(supportsDailyBonus('raccoon')).toBe(false)
    expect(supportsDailyBonus('accio')).toBe(false)
    expect(supportsDailyBonus('loomy')).toBe(false)
    expect(supportsDailyBonus('unknown-provider')).toBe(false)
  })

  it('SenseNova 仍无任何积分能力（OpenAI 兼容按 token 计费，无 balance 端点）', () => {
    expect(supportsCreditBalance('sensenova')).toBe(false)
    expect(supportsDailyCheckin('sensenova')).toBe(false)
  })

  /**
   * 「锁定永久积分」按 provider 白名单（Loomy / OfficeAce）。
   *
   * 白名单必须与后端 `permanentLocked(provider)` 支持的集合一致：前端给了
   * 按钮、后端不认，会得到一个必然失败的开关。
   */
  it('锁定永久积分只对 Loomy 与 OfficeAce 为 true', () => {
    expect(supportsPermanentLock('loomy')).toBe(true)
    expect(supportsPermanentLock('officeace')).toBe(true)
    for (const id of ['codearts', 'buddy', 'workbuddy', 'lobsterai', 'qoder', 'qodercn', 'trae', 'cline', 'raccoon', 'accio', 'sensenova']) {
      expect(supportsPermanentLock(id), `${id} 不应支持锁定永久积分`).toBe(false)
    }
  })
})

/** 读取客户端 bundle 的源码（未打包的 plugin-src 版本）。 */
function readClientSource(): string {
  const here = dirname(fileURLToPath(import.meta.url))
  return readFileSync(resolve(here, '../../plugin-src/client/jet-hub.js'), 'utf8')
}

describe('客户端积分请求门控（源码级回归）', () => {
  const source = readClientSource()

  it('引用了能力矩阵，而不是在本文件里另写一份 provider 字面量判断', () => {
    expect(source).toContain("from './credits-capabilities.js'")
    expect(source).toContain('supportsCreditBalance')
    expect(source).toContain('supportsDailyCheckin')
    // 历史实现里的 CREDITS_PROVIDERS 白名单已删除，不得复辟。
    // 只查「非注释行」：文件里保留了叙述该缺陷的注释，注释提及名字是合理的。
    const codeLines = source
      .split('\n')
      .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
      .join('\n')
    expect(codeLines).not.toContain('CREDITS_PROVIDERS')
  })

  it('loadCredits 在发起 credits.balances 之前先判能力', () => {
    const start = source.indexOf('const loadCredits = React.useCallback')
    expect(start).toBeGreaterThan(-1)
    const body = source.slice(start, start + 1200)
    const guardIndex = body.indexOf('if (!canLoadCredits) return;')
    const callIndex = body.indexOf("rpcCall('credits.balances'")
    expect(guardIndex, 'loadCredits 缺少能力守卫').toBeGreaterThan(-1)
    expect(callIndex).toBeGreaterThan(-1)
    // 守卫必须出现在请求之前，否则等于没守
    expect(guardIndex).toBeLessThan(callIndex)
  })

  it('挂载副作用只在支持余额时才拉积分（CodeArts 连 loading 状态都不翻）', () => {
    const start = source.indexOf("void loadAccounts();")
    expect(start).toBeGreaterThan(-1)
    const body = source.slice(start, start + 400)
    const guardIndex = body.indexOf('if (canLoadCredits) void loadCredits();')
    expect(guardIndex, '挂载副作用缺少能力门控').toBeGreaterThan(-1)
    // 不能存在无条件的 void loadCredits() 调用
    expect(body).not.toMatch(/^\s*void loadCredits\(\);/m)
  })

  it('claimCredits 在发起 credits.claimAll 之前先判能力', () => {
    const start = source.indexOf('const claimCredits')
    expect(start).toBeGreaterThan(-1)
    const body = source.slice(start, start + 600)
    const guardIndex = body.indexOf('if (!supportsCredits) return;')
    const callIndex = body.indexOf("rpcCall('credits.claimAll'")
    expect(guardIndex, 'claimCredits 缺少能力守卫').toBeGreaterThan(-1)
    expect(callIndex).toBeGreaterThan(-1)
    expect(guardIndex).toBeLessThan(callIndex)
  })

  it('「刷新积分」按钮与账号卡片的「积分」行都按能力渲染', () => {
    // 归一化 CRLF：本仓库源码在 Windows 上是 CRLF，直接比对多行字面量会假失败。
    const normalized = source.replace(/\r\n/g, '\n')
    expect(normalized).toMatch(/canLoadCredits\s*\n\s*\? React\.createElement\('button'/)
    expect(normalized).toContain('showCredits: canLoadCredits')
    // AccountCard 必须真的消费 showCredits，否则传了也没用。
    const cardBody = sliceTopLevel(normalized, 'function AccountCard(')
    expect(cardBody.length).toBeGreaterThan(0)
    expect(cardBody).toContain('showCredits')
    expect(cardBody).toMatch(/showCredits\s*\n?\s*\?[\s\S]*CreditBalanceRow/)
  })

  /**
   * 领取结果必须逐账号显示**原因**，不能只给计数。
   *
   * 真实教训：CodeArts 的领取曾因「数字 campaignId 被当成字符串解析」而
   * 全部失败，但 UI 只显示「1 个失败」，用户与排查者都无从判断是凭据问题、
   * 活动未开、还是解析 bug —— 只能靠翻代码 + 抓包定位。
   * 后端一直返回 `results[].outcome.message`，前端不该把它丢掉。
   */
  it('claimCredits 汇总逐账号原因并在面板渲染', () => {
    const normalized = source.replace(/\r\n/g, '\n')
    const start = normalized.indexOf('const claimCredits = async () => {')
    expect(start).toBeGreaterThan(-1)
    const body = normalized.slice(start, start + 3000)
    // 必须读取 results（而不只是 summary）
    expect(body, 'claimCredits 未消费 results').toContain('results')
    // 必须为失败条目带上 outcome.message
    expect(body).toContain('outcome.message')
    // 必须把 details 交给 notice
    expect(body).toContain('details')
    // 渲染层必须真的消费 claimNotice.details
    const renderStart = normalized.indexOf('claimNotice\n')
    expect(renderStart).toBeGreaterThan(-1)
    const renderBody = normalized.slice(renderStart, renderStart + 900)
    expect(renderBody, 'claimNotice 的 details 未被渲染').toContain('claimNotice.details')
    expect(renderBody).toContain('dim-jh-probeDetails')
  })
})
