/**
 * 静态 API Key 建号入口的文案与输入校验（纯函数）。
 *
 * ## 为什么需要这个模块（用户 2026-10-15 报障）
 *
 * 「SenseNova 点新建账号提示：provider sensenova 不支持链接式登录」——
 * 根因是面板的「+ 新建账号」只有**链接式登录**一条路（`account.create` →
 * 弹窗 → 轮询 `login.poll`），而 SenseNova 是**静态 API Key** provider
 * （一把 `sk-...` 作 Bearer，无登录、无 refresh），后端 orchestrator 只能
 * 拒绝（`src/login/orchestrator.ts`）。
 *
 * 后端的能力其实一直齐全：`supportsStaticKey`（credits-capabilities.js）、
 * `POST /api/accounts`（src/admin/router.ts）、`account.addKey`
 * （web/src/rpc-bridge.js）都在，**缺的只是面板里的入口**。本模块补上那一层，
 * 并把文案与输入归一做成纯函数，让「按钮长什么样、输入怎么处理」可被单测
 * 锁死 —— 这类缺陷的教训正是「后端有、前端忘了接」，源码级断言才守得住。
 *
 * ⚠️ 能力判定的唯一真相源仍是 `credits-capabilities.js` 的
 * `supportsStaticKey`（它与后端 `STATIC_KEY_PROVIDERS` 对齐）；本模块只做
 * 展示与输入处理，**不另写一份 provider 名单** —— 否则将来后端新增一个静态
 * key provider 时，会出现「后端认、按钮不认」的半通状态。
 */

import { supportsStaticKey } from './credits-capabilities.js'

/**
 * 「+ 新建账号」按钮文案。
 *
 * 静态 key provider 必须点明录入形态：只说「新建账号」会让用户以为是登录，
 * 点进去才发现在要一个自己并没有的东西（浏览器授权页）。
 */
export function newAccountButtonLabel(provider) {
  return supportsStaticKey(provider) ? '+ 新建账号 (粘贴 API Key)' : '+ 新建账号'
}

/**
 * 「+ 新建账号」按钮的悬停提示。
 *
 * 静态 key provider 返回空串，由调用方 fallback 到既有文案
 * （OfficeAce 的 SSO 说明 / 其余 provider 的通用说明）。
 */
export function newAccountButtonTitle(provider) {
  if (!supportsStaticKey(provider)) return ''
  return 'SenseNova 用静态 API Key 认证（请求头 Bearer sk-...），没有浏览器登录。'
    + '把开放平台控制台里的 key 粘贴进来即可加入账号池，可重复添加多把 key。'
}

/**
 * 「+ 新建账号」按钮在三种忙碌/常态下的文案。
 *
 * 单独成函数而不是在 JSX 里写嵌套三元：那条表达式要收 button、按钮组、
 * 面板头三层括号，多写一层少写一层都不会立刻报错（JSX 只是少个参数），
 * 而它恰恰是用户找入口时唯一看见的东西。
 *
 * @param provider - 当前面板的 provider。
 * @param busy - `creating`：链接式登录进行中；`addingKey`：粘贴 key 提交中。
 */
export function newAccountBusyLabel(provider, busy) {
  if (busy.creating) return '正在登录…'
  if (busy.addingKey) return '正在添加…'
  return newAccountButtonLabel(provider)
}

/** 粘贴弹窗的标题。 */
export function staticKeyDialogTitle(provider) {
  return `添加 ${provider} 账号（粘贴 API Key）`
}

/** 粘贴弹窗里 key 输入框的说明。 */
export function staticKeyFieldHint() {
  return 'API Key（必填）：在商汤开放平台控制台复制，形如 sk-...；'
    + '粘贴即可，无需登录。'
}

/** 粘贴弹窗里昵称输入框的说明。 */
export function staticKeyNicknameHint() {
  return '昵称（可选）：留空则按 key 自动生成脱敏昵称，便于区分多把 key。'
}

/**
 * 弹窗底部的常驻说明：**建号时不校验 key 是否有效**。
 *
 * 后端 `POST /api/accounts` 只写凭据与账号索引，不打上游（不引入网络依赖，
 * 也不让「添加」因一次抖动而失败）。代价是一把无效/已注销的 key 会安静落库，
 * 直到调用模型时才 401 —— 而 401 出现在网关侧，用户很难联想到「key 粘错了」。
 * 故在此处前置说明，并把验证手段指到面板上既有的「重测」。
 */
export function staticKeyVerifyHint() {
  return '添加时不会校验 key 是否有效。若之后调用返回 401，说明这把 key 无效或已注销：'
    + '用面板上的「重测」验证，或删掉本账号重新粘贴。'
}

/** 账号列表空态里的第二行提示（静态 key provider）。 */
export function emptyAccountsHint(provider) {
  return supportsStaticKey(provider)
    ? '点击「+ 新建账号 (粘贴 API Key)」录入 sk-... 开头的 API Key。'
    : ''
}

/**
 * 归一化用户粘贴进来的 API Key。
 *
 * 从控制台网页复制 key 时极易带上**不可见字符**（行尾换行、行首空格、
 * 全角空格），原样提交会得到一个「看起来对却 401」的账号 —— 排查时因为
 * 日志不能打印 key 明文，几乎是无头案。故提交前先剥掉首尾与内部空白。
 *
 * @returns `{ ok: true, apiKey }` 或 `{ ok: false, message }`
 */
export function normalizeApiKeyInput(raw) {
  const apiKey = typeof raw === 'string' ? raw.replace(/\s+/g, '').trim() : ''
  if (apiKey.length === 0) {
    return { ok: false, message: '请先粘贴 API Key（形如 sk-...）' }
  }
  return { ok: true, apiKey }
}
