import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import {
  groupProviders,
  providerCloseConfirmCopy,
  providerSwitchRows,
  providerSwitchState,
  providerToggleSummary,
  summarizeProviderToggle,
} from '../../plugin-src/client/provider-toggle.js'

/**
 * 供应商总开关的纯逻辑 + 接线回归。
 *
 * 语义基准（AGENTS.md 分叉点表）：本项目的 provider 开关是 `disabledProviders`
 * 里的**独立键**，关闭即**硬拦截 404**——与来源的「目录过滤（仍可按 id 调用）」
 * 不同。故：
 * - 判据是 `enabled !== false`（不是来源的 closed 推导）；
 * - 关闭**不停用账号**（来源会 setAccountsEnabled(false)）；
 * - 确认文案必须讲 404，不能抄来源的「从模型选择里移除」。
 */

const PROVIDERS = [
  { id: 'codearts', label: 'CodeArts (华为云)' },
  { id: 'buddy', label: 'CodeBuddy (腾讯)' },
  { id: 'officeace', label: 'OfficeAce (华为云)' },
  { id: 'accio', label: 'Accio (阿里)' },
]

describe('groupProviders', () => {
  it('按 enabled 分组且组内保持声明顺序', () => {
    const { open, closed } = groupProviders(PROVIDERS, {
      codearts: { enabled: true },
      buddy: { enabled: false },
      officeace: { enabled: true },
      accio: { enabled: false },
    })
    expect(open.map(p => p.id)).toEqual(['codearts', 'officeace'])
    expect(closed.map(p => p.id)).toEqual(['buddy', 'accio'])
  })

  it('状态缺失归「已打开」（宁多勿少：把已关的显示成开会让人以为功能坏了）', () => {
    const { open, closed } = groupProviders(PROVIDERS, { buddy: { enabled: false } })
    expect(open.map(p => p.id)).toEqual(['codearts', 'officeace', 'accio'])
    expect(closed.map(p => p.id)).toEqual(['buddy'])
  })

  it('判据只认显式 false（undefined / 非布尔都按打开）', () => {
    const { open, closed } = groupProviders(PROVIDERS, {
      codearts: {},
      buddy: { enabled: undefined },
      officeace: { enabled: 'false' },
      accio: { enabled: 0 },
    })
    expect(closed).toHaveLength(0)
    expect(open).toHaveLength(4)
  })

  it('statuses 整体缺失 / 非对象 / providers 为空都不抛错', () => {
    expect(groupProviders(PROVIDERS, undefined).open).toHaveLength(4)
    expect(groupProviders(PROVIDERS, null).open).toHaveLength(4)
    expect(groupProviders(PROVIDERS, 'nope').open).toHaveLength(4)
    expect(groupProviders([], { codearts: { enabled: false } }).closed).toHaveLength(0)
  })
})

describe('providerSwitchState', () => {
  it('明确状态 ⇒ checked 跟随 enabled', () => {
    expect(providerSwitchState({ enabled: true }).checked).toBe(true)
    expect(providerSwitchState({ enabled: false }).checked).toBe(false)
    expect(providerSwitchState({}).checked).toBe(true)
  })

  it('状态未知 ⇒ known:false + 原因（界面据此禁用该行，而不是放一个会误关的开关）', () => {
    const state = providerSwitchState(undefined)
    expect(state.known).toBe(false)
    expect(state.reason).toContain('状态未知')
    // 未知时仍按「打开」显示（保守方向），但行会被禁用
    expect(state.checked).toBe(true)
  })
})

describe('providerSwitchRows', () => {
  it('已打开组在前、计数透传、缺失时为 null（「不知道」≠「0」）', () => {
    const rows = providerSwitchRows(PROVIDERS, {
      codearts: { enabled: true, accountCount: 3, enabledAccountCount: 2 },
      buddy: { enabled: false, accountCount: 1, enabledAccountCount: 0 },
      officeace: { enabled: true },
    })
    expect(rows.map(r => r.id)).toEqual(['codearts', 'officeace', 'accio', 'buddy'])
    expect(rows[0]!.accountCount).toBe(3)
    expect(rows[0]!.enabledAccountCount).toBe(2)
    // officeace / accio 没有计数数据：null 而不是 0
    expect(rows[1]!.accountCount).toBeNull()
    expect(rows[3]!.checked).toBe(false)
  })

  it('行数据带禁用原因（状态未知的行）', () => {
    const rows = providerSwitchRows([{ id: 'x', label: 'X' }], undefined)
    expect(rows[0]!.known).toBe(false)
    expect(rows[0]!.reason).toContain('状态未知')
  })
})

describe('providerToggleSummary', () => {
  it('计数两组', () => {
    expect(providerToggleSummary(PROVIDERS, {
      codearts: { enabled: true },
      buddy: { enabled: false },
    })).toEqual({ open: 3, closed: 1, known: true })
  })

  it('整体状态没读到 ⇒ known:false（界面不显示「已打开 0 个」）', () => {
    expect(providerToggleSummary(PROVIDERS, undefined)).toEqual({ open: 0, closed: 0, known: false })
  })
})

describe('结果与确认文案', () => {
  it('关闭文案讲清本项目语义：404 + 选号跳过 + 账号不受影响', () => {
    const text = summarizeProviderToggle('OfficeAce (华为云)', false, { accountCount: 2 })
    expect(text).toContain('已关闭')
    expect(text).toContain('404')
    expect(text).toContain('2 个账号')
    // ⚠️ 绝不能出现「已停用账号」——本项目不停用账号（来源才停）
    expect(text).not.toContain('停用')
  })

  it('打开文案说明恢复', () => {
    expect(summarizeProviderToggle('Accio (阿里)', true, { accountCount: 1 }))
      .toContain('自动选号恢复参与')
  })

  it('账号数读不到时省略括号（不显示「undefined 个账号」）', () => {
    expect(summarizeProviderToggle('Accio (阿里)', false, undefined)).not.toContain('个账号')
  })

  it('关闭确认带影响面（含账号数行）', () => {
    const copy = providerCloseConfirmCopy('CodeBuddy (腾讯)', { accountCount: 3 })
    expect(copy).toContain('确认关闭')
    expect(copy).toContain('404')
    expect(copy).toContain('影响 3 个已配置账号')
    // 无账号时不编造该行
    expect(providerCloseConfirmCopy('X', { accountCount: 0 })).not.toContain('影响 0 个')
  })
})

// ───────────────────────── 接线回归（源码级） ─────────────────────────

describe('供应商开关接线（源码级断言）', () => {
  const here = dirname(fileURLToPath(import.meta.url))
  const hubSource = readFileSync(resolve(here, '../../plugin-src/client/jet-hub.js'), 'utf8')
  const bridgeSource = readFileSync(resolve(here, '../../web/src/rpc-bridge.js'), 'utf8')

  it('页头有「供应商」按钮（破坏性批量操作进弹窗，不挤进行导航）', () => {
    // 按钮文字
    expect(hubSource).toContain("}, '供应商'),")
    // 左侧导航（rail）里**不得**出现 provider 级开关：来源的真实教训是
    // 「把开关挂在导航行尾，用户选择看哪个供应商时误点」。
    const railStart = hubSource.indexOf("React.createElement('nav', { className: 'dim-jh-rail'")
    expect(railStart).toBeGreaterThan(-1)
    const railBody = hubSource.slice(railStart, hubSource.indexOf('React.createElement(\'main\'', railStart))
    expect(railBody).toContain("role: 'tab'")
    expect(railBody).not.toContain('checkbox')
  })

  it('弹窗经 provider.list 读状态、provider.setEnabled 写开关', () => {
    const panelStart = hubSource.indexOf('function ProviderSwitchPanel(')
    expect(panelStart).toBeGreaterThan(-1)
    const body = hubSource.slice(panelStart, hubSource.indexOf('\nfunction ProviderPanel(', panelStart))
    expect(body).toContain("rpcCall('provider.list'")
    expect(body).toContain("rpcCall('provider.setEnabled'")
    // 关闭前必须确认（影响面最大的批量操作）
    expect(body).toContain('providerCloseConfirmCopy')
    // 读不到状态时显示重试而不是放一排会误关的开关
    expect(body).toContain('重试')
    // 弹窗行是 label + 恰好一个 checkbox（与 ModelToggle 同款约束）
    expect(body).toContain("role: 'switch'")
  })

  it('rpc-bridge 有 provider.list / provider.setEnabled 映射', () => {
    expect(bridgeSource).toContain("case 'provider.list':")
    expect(bridgeSource).toContain("case 'provider.setEnabled':")
    expect(bridgeSource).toContain("get('/api/providers'")
  })
})
