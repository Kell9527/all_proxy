/**
 * API Key 管理与用量面板（tasks 11.7 / 11.8）。
 *
 * Jet Hub 原界面没有这两个面板（DSH 时代不需要对外发 key），故新写。
 * 风格保持与 jet-hub.js 一致：`React.createElement`（无 JSX），数据全部来自
 * 同源 `fetch('/api/...')`。
 *
 * ⚠️ **明文只出现一次**：创建成功后明文展示在结果区，用户复制保存；
 * 之后任何列表/编辑操作都拿不到它（后端只存哈希）。刷新页面明文即消失。
 */

import * as React from 'react'
import { adminFetch, restoreSecret, storeSecret, hasSecret } from './admin-auth.js'

/** 统一的 API 调用（走 admin-auth 层：自动带管理口令、401 回输入门）。 */
async function api(method, path, payload) {
  const init = { method, headers: {} }
  if (payload !== undefined) {
    init.headers['Content-Type'] = 'application/json'
    init.body = JSON.stringify(payload)
  }
  return adminFetch(path, init)
}

const TABS = [
  { id: 'providers', label: 'Provider 管理' },
  { id: 'keys', label: 'API Keys' },
  { id: 'usage', label: '用量与状态' },
  { id: 'sms', label: '短信登录' },
]

/** 页面外壳：口令门 + 顶部标签页 + 内容区。 */
export function AdminShell() {
  const [tab, setTab] = React.useState('providers')
  // gate 三态：locked（要口令）→ checking（验证存储的口令）→ authed。
  // checking 是为了「URL/会话里带了口令但服务端已换」时能立刻回到 locked，
  // 而不是渲染出一堆 401 错误的面板。
  const [gate, setGate] = React.useState('checking')
  const [input, setInput] = React.useState('')
  const [gateError, setGateError] = React.useState(null)

  const verify = React.useCallback(async (secret) => {
    if (secret.length === 0) return false
    storeSecret(secret)
    try {
      // 轻量只读端点：成功即认为口令有效。
      await adminFetch('/api/backup/status')
      return true
    } catch (error) {
      if (error?.code !== 'ADMIN_UNAUTHORIZED') throw error
      return false
    }
  }, [])

  React.useEffect(() => {
    let cancelled = false
    void (async () => {
      if (hasSecret()) {
        const ok = await verify(restoreSecret()).catch(() => false)
        if (!cancelled) setGate(ok ? 'authed' : 'locked')
      } else {
        if (!cancelled) setGate('locked')
      }
    })()
    return () => { cancelled = true }
  }, [verify])

  // 全局兜底：任何漏出 catch 的 401（口令被服务端更换）也回到口令门。
  React.useEffect(() => {
    const onRejection = (event) => {
      if (event?.reason?.code === 'ADMIN_UNAUTHORIZED') setGate('locked')
    }
    window.addEventListener('unhandledrejection', onRejection)
    return () => window.removeEventListener('unhandledrejection', onRejection)
  }, [])

  if (gate !== 'authed') {
    return React.createElement('div', { style: gateStyle },
      React.createElement('form', {
        style: gateCardStyle,
        onSubmit: (event) => {
          event.preventDefault()
          setGateError(null)
          setGate('checking')
          void verify(input.trim()).then((ok) => {
            if (ok) { setInput(''); setGate('authed') } else {
              setGateError('口令不正确（首次启动时打印过一次；也可用环境变量 ALL_PROXY_ADMIN_SECRET 自设）')
              setGate('locked')
            }
          }).catch((e) => {
            setGateError(e?.message || '验证失败')
            setGate('locked')
          })
        },
      },
        React.createElement('h2', { style: { margin: '0 0 6px', fontSize: 18 } }, 'all_proxy 管理端'),
        React.createElement('p', { style: { margin: '0 0 14px', color: 'var(--dsw-alias-label-secondary, #646a73)', fontSize: 13 } },
          '输入管理口令。首次启动时打印过一次；也可用环境变量 ALL_PROXY_ADMIN_SECRET 自设。'),
        React.createElement('input', {
          type: 'password',
          autoFocus: true,
          style: { ...inputStyle, width: '100%', boxSizing: 'border-box' },
          placeholder: '管理口令',
          value: input,
          onChange: e => setInput(e.target.value),
        }),
        gateError !== null && React.createElement('p', { style: { color: '#d54941', fontSize: 13, margin: '10px 0 0' } }, gateError),
        React.createElement('button', { type: 'submit', style: { ...primaryBtnStyle, width: '100%', marginTop: 14, padding: '8px 0' }, disabled: gate === 'checking' },
          gate === 'checking' ? '验证中…' : '进入'),
      ),
    )
  }

  return React.createElement('div', null,
    React.createElement('nav', { style: navStyle },
      TABS.map(t => React.createElement('button', {
        key: t.id,
        onClick: () => setTab(t.id),
        style: { ...tabStyle, ...(tab === t.id ? tabActiveStyle : {}) },
      }, t.label)),
    ),
    React.createElement('main', null,
      tab === 'keys' ? React.createElement(KeysPanel)
        : tab === 'usage' ? React.createElement(UsagePanel)
          : tab === 'sms' ? React.createElement(SmsPanel)
            : React.createElement(ProvidersSlot),
    ),
  )
}

// ───────────────────────── 短信登录（loomy 主路径） ─────────────────────────

/**
 * 短信验证码登录面板。
 *
 * ⚠️ **Loomy 以手机号验证码为主路径**（design D12）：微信 openid 绑死单一
 * 微信号，扫码只能登一个账号；手机号路径可多账号共存。raccoon 也可以走
 * 短信，但更推荐用它的链接式登录（弹窗页内含扫码与短信两种方式）。
 */
function SmsPanel() {
  const [provider, setProvider] = React.useState('loomy')
  const [phone, setPhone] = React.useState('')
  const [code, setCode] = React.useState('')
  const [ticket, setTicket] = React.useState('')
  const [sent, setSent] = React.useState(false)
  const [busy, setBusy] = React.useState(false)
  const [message, setMessage] = React.useState(null)

  const sendCode = async () => {
    setBusy(true)
    setMessage(null)
    try {
      const r = await api('POST', '/api/login/sms/send', { provider, phone })
      setTicket(r.ticket ?? '')
      setSent(true)
      setMessage({ tone: 'ok', text: '验证码已发送，请查收短信' })
    } catch (e) {
      setMessage({ tone: 'error', text: e.message })
    } finally {
      setBusy(false)
    }
  }

  const complete = async () => {
    setBusy(true)
    setMessage(null)
    try {
      const entry = await api('POST', '/api/login/sms/complete', { provider, phone, code, ticket })
      setMessage({ tone: 'ok', text: `登录成功：${entry.nickname}（${entry.id}）已加入账号池` })
      setSent(false)
      setPhone('')
      setCode('')
      setTicket('')
    } catch (e) {
      setMessage({ tone: 'error', text: e.message })
    } finally {
      setBusy(false)
    }
  }

  return React.createElement('div', { style: { padding: 16, maxWidth: 620, margin: '0 auto' } },
    React.createElement('section', { style: sectionStyle },
      React.createElement('h3', { style: headingStyle }, '短信验证码登录'),
      React.createElement('p', { style: { color: 'var(--dsw-alias-label-secondary, #646a73)', fontSize: 13, margin: '0 0 12px' } },
        '适用于 Loomy（主路径，可登录多个账号）与 Raccoon。Raccoon 也可用「Provider 管理 → 新建账号」的弹窗页（内含扫码与短信）。'),
      React.createElement('div', { style: rowStyle },
        React.createElement('select', { style: inputStyle, value: provider, onChange: e => setProvider(e.target.value) },
          React.createElement('option', { value: 'loomy' }, 'Loomy'),
          React.createElement('option', { value: 'raccoon' }, 'Raccoon')),
        React.createElement('input', { style: inputStyle, placeholder: '手机号', value: phone, onChange: e => setPhone(e.target.value) }),
        React.createElement('button', { style: btnStyle, disabled: busy || phone.length === 0 || sent, onClick: sendCode }, '发送验证码'),
      ),
      sent && React.createElement('div', { style: rowStyle },
        React.createElement('input', { style: inputStyle, placeholder: '短信验证码', value: code, onChange: e => setCode(e.target.value) }),
        React.createElement('button', { style: primaryBtnStyle, disabled: busy || code.length === 0, onClick: complete }, '完成登录'),
      ),
      message !== null && React.createElement('p', { style: { fontSize: 13, color: message.tone === 'ok' ? '#9fdca4' : '#ff8f8f' } }, message.text),
    ),
  )
}


/**
 * Provider 管理标签的内容由调用方注入（Jet Hub 页面是重量级组件，
 * 切走时卸载以免它后台轮询）。用受控的 render prop 而不是直接 import，
 * 保持本模块与 jet-hub.js 解耦。
 */
let providersRenderer = () => null
export function setProvidersRenderer(render) { providersRenderer = render }
function ProvidersSlot() { return providersRenderer() }

// ───────────────────────── API Keys ─────────────────────────

const navStyle = { display: 'flex', gap: 8, padding: '10px 16px', borderBottom: '1px solid #2a2d33', background: 'var(--dsw-alias-bg-layer-2, #f7f8fa)', position: 'sticky', top: 0, zIndex: 10 }
const tabStyle = { padding: '6px 14px', borderRadius: 6, border: '1px solid var(--dsw-alias-border-l2, #eef0f3)', background: 'var(--dsw-alias-bg-layer-3, #fff)', color: 'var(--dsw-alias-label-primary, #1f2329)', cursor: 'pointer', fontSize: 13 }
const tabActiveStyle = { background: '#e8f1ff', color: '#1677ff', borderColor: '#1677ff' }
const tableStyle = { width: '100%', borderCollapse: 'collapse', fontSize: 13 }
const cellStyle = { padding: '6px 8px', borderBottom: '1px solid var(--dsw-alias-border-l2, #eef0f3)', textAlign: 'left', verticalAlign: 'top' }
const inputStyle = { padding: '5px 8px', borderRadius: 4, border: '1px solid var(--dsw-alias-border-l2, #eef0f3)', background: '#fff', color: 'var(--dsw-alias-label-primary, #1f2329)', width: 160 }
const btnStyle = { padding: '4px 10px', borderRadius: 4, border: '1px solid var(--dsw-alias-border-l2, #eef0f3)', background: 'var(--dsw-alias-bg-layer-3, #fff)', color: 'var(--dsw-alias-label-primary, #1f2329)', cursor: 'pointer', fontSize: 12 }
const primaryBtnStyle = { ...btnStyle, background: '#1677ff', borderColor: '#1677ff', color: '#fff' }

function KeysPanel() {
  const [keys, setKeys] = React.useState([])
  const [keyUsage, setKeyUsage] = React.useState({})
  const [error, setError] = React.useState(null)
  const [plaintext, setPlaintext] = React.useState(null)
  const [newName, setNewName] = React.useState('')
  const [newScope, setNewScope] = React.useState({ providers: '', rate: '', quota: '' })
  const [editing, setEditing] = React.useState(null)

  const load = React.useCallback(async () => {
    try {
      const [k, u] = await Promise.all([
        api('GET', '/api/keys'),
        api('GET', '/api/usage/keys').catch(() => ({ data: [] })),
      ])
      setKeys(k.data ?? [])
      const usage = {}
      for (const row of u.data ?? []) usage[row.keyId] = row
      setKeyUsage(usage)
      setError(null)
    } catch (e) {
      setError(e.message)
    }
  }, [])

  React.useEffect(() => { void load() }, [load])

  const create = async () => {
    setError(null)
    try {
      const body = { name: newName }
      const providers = newScope.providers.split(',').map(s => s.trim()).filter(Boolean)
      if (providers.length > 0) body.providers = providers
      const rate = Number(newScope.rate)
      if (Number.isFinite(rate) && rate > 0) body.rateLimitPerMinute = Math.floor(rate)
      const quota = Number(newScope.quota)
      if (Number.isFinite(quota) && quota > 0) body.quotaTokens = Math.floor(quota)
      const r = await api('POST', '/api/keys', body)
      // ⚠️ 明文只在这一次响应里；不落盘、不进任何列表。
      setPlaintext(r.key)
      setNewName('')
      setNewScope({ providers: '', rate: '', quota: '' })
      await load()
    } catch (e) {
      setError(e.message)
    }
  }

  const toggleDisabled = async (key) => {
    try { await api('PATCH', `/api/keys/${encodeURIComponent(key.id)}`, { disabled: !key.disabled }) ; await load() } catch (e) { setError(e.message) }
  }
  const remove = async (key) => {
    if (!confirm(`删除 API Key「${key.name}」？使用它的客户端将立即 401，且不可恢复。`)) return
    try { await api('DELETE', `/api/keys/${encodeURIComponent(key.id)}`); await load() } catch (e) { setError(e.message) }
  }
  const resetUsage = async (key) => {
    try { await api('POST', `/api/keys/${encodeURIComponent(key.id)}/reset-usage`, {}) ; await load() } catch (e) { setError(e.message) }
  }

  return React.createElement('div', { style: { padding: 16, maxWidth: 980, margin: '0 auto' } },
    error !== null && React.createElement('p', { style: { color: '#d54941' } }, error),
    // ── 创建 ──
    React.createElement('section', { style: sectionStyle },
      React.createElement('h3', { style: headingStyle }, '创建 API Key'),
      React.createElement('div', { style: rowStyle },
        React.createElement('input', { style: inputStyle, placeholder: '名称（如：Claude Code）', value: newName, onChange: e => setNewName(e.target.value) }),
        React.createElement('input', { style: inputStyle, placeholder: 'provider 白名单（逗号分隔，留空不限）', value: newScope.providers, onChange: e => setNewScope({ ...newScope, providers: e.target.value }) }),
        React.createElement('input', { style: inputStyle, placeholder: '速率（次/分钟，留空不限）', value: newScope.rate, onChange: e => setNewScope({ ...newScope, rate: e.target.value }) }),
        React.createElement('input', { style: inputStyle, placeholder: '额度（token，留空不限）', value: newScope.quota, onChange: e => setNewScope({ ...newScope, quota: e.target.value }) }),
        React.createElement('button', { style: primaryBtnStyle, onClick: create }, '创建'),
      ),
      plaintext !== null && React.createElement('div', { style: plaintextStyle },
        React.createElement('p', { style: { margin: '0 0 6px', fontWeight: 600 } }, '请立即保存（仅此一次可见，关闭后无法找回）：'),
        React.createElement('code', { style: { wordBreak: 'break-all' } }, plaintext),
        React.createElement('button', { style: { ...btnStyle, marginLeft: 10 }, onClick: () => setPlaintext(null) }, '我已保存'),
      ),
    ),
    // ── 列表 ──
    React.createElement('section', { style: sectionStyle },
      React.createElement('h3', { style: headingStyle }, `全部 Key（${keys.length}）`),
      React.createElement('table', { style: tableStyle },
        React.createElement('thead', null, React.createElement('tr', null,
          ['名称', '前缀', '状态', '限制', '累计消耗', '创建时间', '操作'].map(h => React.createElement('th', { key: h, style: cellStyle }, h)))),
        React.createElement('tbody', null, keys.map(key => {
          const usage = keyUsage[key.id]
          return React.createElement('tr', { key: key.id },
            React.createElement('td', { style: cellStyle }, key.name),
            React.createElement('td', { style: cellStyle }, React.createElement('code', null, `${key.prefix}…`)),
            React.createElement('td', { style: cellStyle }, key.disabled ? '已禁用' : '启用'),
            React.createElement('td', { style: cellStyle },
              key.providers !== undefined ? `provider: ${key.providers.join(', ')}；` : '',
              key.rateLimitPerMinute !== undefined ? `${key.rateLimitPerMinute}/分钟；` : '',
              key.quotaTokens !== undefined ? `额度 ${key.usedTokens}/${key.quotaTokens}` : ''),
            React.createElement('td', { style: cellStyle },
              usage !== undefined
                ? `${usage.requests} 次 / ${usage.promptTokens + usage.completionTokens} token`
                : `${key.usedTokens} token`),
            React.createElement('td', { style: cellStyle }, new Date(key.createdAt).toLocaleString()),
            React.createElement('td', { style: cellStyle },
              React.createElement('button', { style: btnStyle, onClick: () => toggleDisabled(key) }, key.disabled ? '启用' : '禁用'),
              ' ',
              React.createElement('button', { style: btnStyle, onClick: () => resetUsage(key) }, '清零额度'),
              ' ',
              React.createElement('button', { style: btnStyle, onClick: () => remove(key) }, '删除')),
          )
        })),
      ),
    ),
  )
}

// ───────────────────────── 用量与状态 ─────────────────────────

const RANGES = [
  { id: 'all', label: '全部', ms: null },
  { id: '1h', label: '近 1 小时', ms: 3600_000 },
  { id: '24h', label: '近 24 小时', ms: 24 * 3600_000 },
  { id: '7d', label: '近 7 天', ms: 7 * 24 * 3600_000 },
]

function UsagePanel() {
  const [range, setRange] = React.useState('24h')
  const [outcome, setOutcome] = React.useState('all')
  const [records, setRecords] = React.useState([])
  const [summary, setSummary] = React.useState(null)
  const [health, setHealth] = React.useState(null)
  const [error, setError] = React.useState(null)

  const load = React.useCallback(async () => {
    try {
      const params = new URLSearchParams({ limit: '50' })
      const rangeDef = RANGES.find(r => r.id === range)
      if (rangeDef?.ms !== null && rangeDef !== undefined) {
        params.set('from', String(Date.now() - rangeDef.ms))
      }
      if (outcome === 'success' || outcome === 'failure') params.set('outcome', outcome)
      const [u, h] = await Promise.all([
        api('GET', `/api/usage?${params.toString()}`),
        api('GET', '/health').catch(() => null),
      ])
      setRecords(u.records ?? [])
      setSummary(u.summary ?? null)
      setHealth(h)
      setError(null)
    } catch (e) {
      setError(e.message)
    }
  }, [range, outcome])

  React.useEffect(() => {
    void load()
    const timer = setInterval(() => void load(), 15000)
    return () => clearInterval(timer)
  }, [load])

  return React.createElement('div', { style: { padding: 16, maxWidth: 980, margin: '0 auto' } },
    error !== null && React.createElement('p', { style: { color: '#d54941' } }, error),
    // ── 筛选 ──
    React.createElement('div', { style: rowStyle },
      RANGES.map(r => React.createElement('button', {
        key: r.id, style: { ...btnStyle, ...(range === r.id ? tabActiveStyle : {}) }, onClick: () => setRange(r.id),
      }, r.label)),
      React.createElement('select', { style: inputStyle, value: outcome, onChange: e => setOutcome(e.target.value) },
        React.createElement('option', { value: 'all' }, '全部结果'),
        React.createElement('option', { value: 'success' }, '仅成功'),
        React.createElement('option', { value: 'failure' }, '仅失败')),
      React.createElement('button', { style: btnStyle, onClick: load }, '刷新'),
    ),
    // ── 汇总 ──
    summary !== null && React.createElement('section', { style: sectionStyle },
      React.createElement('h3', { style: headingStyle }, '汇总'),
      React.createElement('div', { style: { display: 'flex', gap: 18, flexWrap: 'wrap', fontSize: 13 } },
        stat('请求总数', summary.total),
        stat('成功', summary.success),
        stat('失败', summary.failure),
        stat('prompt tokens', summary.promptTokens),
        stat('completion tokens', summary.completionTokens),
        stat('平均首字节', summary.avgFirstByteMs === null ? '--' : `${Math.round(summary.avgFirstByteMs)} ms`),
      ),
    ),
    // ── provider 状态总览 ──
    health !== null && React.createElement('section', { style: sectionStyle },
      React.createElement('h3', { style: headingStyle }, 'Provider 状态'),
      React.createElement('table', { style: tableStyle },
        React.createElement('thead', null, React.createElement('tr', null,
          ['Provider', '开关', '账号（启用/总数）', '可用'].map(h => React.createElement('th', { key: h, style: cellStyle }, h)))),
        React.createElement('tbody', null, health.providers.map(p => React.createElement('tr', { key: p.id },
          React.createElement('td', { style: cellStyle }, p.displayName),
          React.createElement('td', { style: cellStyle }, p.enabled ? '开' : '关'),
          React.createElement('td', { style: cellStyle }, `${p.enabledAccounts}/${p.accounts}`),
          React.createElement('td', { style: cellStyle }, p.ready ? '✓' : '--')))),
      ),
    ),
    // ── 最近记录 ──
    React.createElement('section', { style: sectionStyle },
      React.createElement('h3', { style: headingStyle }, `最近请求（${records.length}）`),
      React.createElement('table', { style: tableStyle },
        React.createElement('thead', null, React.createElement('tr', null,
          ['时间', 'Key', 'Provider', '模型', '账号', 'tokens', '耗时', '首字节', '状态'].map(h => React.createElement('th', { key: h, style: cellStyle }, h)))),
        React.createElement('tbody', null, records.map(r => React.createElement('tr', { key: r.requestId },
          React.createElement('td', { style: cellStyle }, new Date(r.at).toLocaleTimeString()),
          React.createElement('td', { style: cellStyle }, r.keyName),
          React.createElement('td', { style: cellStyle }, r.provider),
          React.createElement('td', { style: cellStyle }, r.model),
          React.createElement('td', { style: cellStyle }, r.accountId || '--'),
          React.createElement('td', { style: cellStyle }, `${r.promptTokens}/${r.completionTokens}`),
          React.createElement('td', { style: cellStyle }, `${r.durationMs} ms`),
          React.createElement('td', { style: cellStyle }, r.firstByteMs === null ? '--' : `${r.firstByteMs} ms`),
          React.createElement('td', { style: { ...cellStyle, color: r.status < 400 ? '#9fdca4' : '#ff8f8f' } },
            r.status, r.errorCode ? ` ${r.errorCode}` : '')))),
      ),
    ),
  )
}

function stat(label, value) {
  return React.createElement('div', null,
    React.createElement('div', { style: { color: 'var(--dsw-alias-label-secondary, #646a73)', fontSize: 12 } }, label),
    React.createElement('div', { style: { fontSize: 18, fontWeight: 600 } }, String(value)),
  )
}

const sectionStyle = { background: 'var(--dsw-alias-bg-layer-3, #fff)', border: '1px solid var(--dsw-alias-border-l2, #eef0f3)', borderRadius: 8, padding: 16, marginBottom: 16 }
const headingStyle = { margin: '0 0 10px', fontSize: 15 }
const rowStyle = { display: 'flex', gap: 8, marginBottom: 12, flexWrap: 'wrap', alignItems: 'center' }
const plaintextStyle = { marginTop: 10, padding: 12, background: '#f0faf3', border: '1px solid #a9ddba', borderRadius: 6, fontSize: 13 }
const gateStyle = { minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'var(--dsw-alias-bg-layer-2, #f7f8fa)' }
const gateCardStyle = { width: 360, padding: 24, background: 'var(--dsw-alias-bg-layer-3, #fff)', border: '1px solid var(--dsw-alias-border-l2, #eef0f3)', borderRadius: 10 }
