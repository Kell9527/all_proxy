/**
 * RPC 桥：把 Jet Hub 界面的 `rpcCall(method, payload)` 词汇翻译成
 * 本服务的 REST 管理 API（`fetch('/api/...')`）。
 *
 * ## 为什么需要这层
 *
 * Jet Hub 界面（2130 行，design D8）最初面向 DSH 的
 * `connection.rpc.call('/api', 'jet-hub', {method, payload})` 编写。
 * 界面逻辑与其中的交互沉淀（弹窗时机、乐观更新、错误兜底）值得原样复用，
 * 只有**传输层**需要换 —— 本模块就是那层薄替换（tasks 11.3）。
 *
 * 命名映射的对应关系：
 * | jet-hub method | REST |
 * |---|---|
 * | `account.list` | `GET /api/accounts?provider=` |
 * | `account.create` | `POST /api/login/start`（两步式，返回 loginUrl） |
 * | `login.poll` | `POST /api/login/poll` |
 * | `account.update` / `delete` / `reorder` | `PATCH`/`DELETE`/`POST` 对应端点 |
 * | `model.list` | `GET /api/models`（**含被关闭的模型**） |
 * | `model.setDisabled` / `setAllDisabled` | `PATCH /api/models` / `POST /api/models/bulk` |
 * | `backup.export` / `import` / `status` | `POST`/`POST`/`GET /api/backup/*` |
 * | `credits.balances` | 返回空余额（积分查询尚未接入，面板照常渲染） |
 */

import { adminFetch } from './admin-auth.js'

// adminFetch 统一负责：自动携带管理口令（x-admin-secret 头）、JSON 解析、
// 非 2xx 抛可读错误、401 时清口令抛 AdminUnauthorizedError（回到输入门）。

function get(url, signal) {
  return adminFetch(url, { signal })
}

function post(url, payload, signal) {
  return adminFetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload ?? {}),
    signal,
  })
}

function patch(url, payload, signal) {
  return adminFetch(url, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload ?? {}),
    signal,
  })
}

function del(url, signal) {
  return adminFetch(url, { method: 'DELETE', signal })
}

/** 创建 Jet Hub 兼容的 `rpcCall(method, payload, signal)`。 */
export function createRpcBridge() {
  return async function rpcCall(method, payload = {}, signal) {
    switch (method) {
      case 'account.list': {
        const provider = payload.provider ?? ''
        const r = await get(`/api/accounts?provider=${encodeURIComponent(provider)}`, signal)
        return { accounts: r.data ?? [] }
      }
      case 'account.create': {
        // 两步式：start **立即**返回 loginUrl；结果由 login.poll 收割。
        // method（可选）：loomy 默认手机号验证码（主路径），传 'wechat' 走扫码。
        const r = await post('/api/login/start', {
          provider: payload.provider,
          ...(payload.method ? { method: payload.method } : {}),
        }, signal)
        return { accountId: r.sessionId, loginUrl: r.loginUrl ?? '', userCode: r.userCode }
      }
      case 'login.poll': {
        const r = await post('/api/login/poll', { sessionId: payload.accountId }, signal)
        if (r.status === 'failed') throw new Error(r.message || '登录失败')
        return { done: r.status === 'done', account: r.account }
      }
      case 'account.update':
        return patch(`/api/accounts/${encodeURIComponent(payload.accountId)}`, payload.patch ?? {}, signal)
      case 'account.delete':
        return del(`/api/accounts/${encodeURIComponent(payload.accountId)}`, signal)
      case 'account.reorder':
        return post('/api/accounts/reorder', {
          provider: payload.provider,
          orderedIds: payload.orderedIds ?? [],
        }, signal)
      case 'account.retest':
        return post(`/api/accounts/${encodeURIComponent(payload.accountId)}/retest`, {}, signal)
      case 'account.retestAll':
        return post('/api/accounts/retest-all', { provider: payload.provider }, signal)
      case 'account.reset':
        return post(`/api/accounts/${encodeURIComponent(payload.accountId)}/reset`, {}, signal)
      case 'account.credentialFile':
        // 绑定 / 解绑共享凭据文件（filePath 为空串表示解绑）。
        return post('/api/accounts/credential-file', {
          accountId: payload.accountId,
          filePath: payload.filePath ?? '',
        }, signal)
      case 'account.resetAll': {
        const r = await get(`/api/accounts?provider=${encodeURIComponent(payload.provider ?? '')}`, signal)
        for (const account of r.data ?? []) {
          await post(`/api/accounts/${encodeURIComponent(account.id)}/reset`, {}, signal)
        }
        return { ok: true }
      }
      case 'model.list': {
        // 返回**全部**模型（含被关闭的），jet-hub 用 `m.id`（上游模型 id）渲染。
        const r = await get('/api/models', signal)
        const models = (r.data ?? [])
          .filter(m => payload.provider === undefined || m.provider === payload.provider)
          .map(m => ({ id: m.model, name: m.name, disabled: m.disabled, context: m.contextWindow }))
        return { models }
      }
      case 'model.setDisabled':
        return patch('/api/models', {
          provider: payload.provider,
          modelId: payload.modelId,
          disabled: payload.disabled === true,
        }, signal)
      case 'model.setAllDisabled': {
        if (payload.disabled === true) {
          // 「全部关闭」：按当前目录逐项应用（规格 model-switching）。
          const r = await get('/api/models', signal)
          const ids = (r.data ?? [])
            .filter(m => m.provider === payload.provider)
            .map(m => m.model)
          return post('/api/models/bulk', { provider: payload.provider, modelIds: ids }, signal)
        }
        // 「全部开启」：直接清空该 provider 的单模型黑名单（并恢复 provider 开关）。
        return post('/api/models/bulk', { provider: payload.provider, clear: true }, signal)
      }
      case 'loomy.permanentLock':
        return patch('/api/loomy-lock', { locked: payload.locked === true }, signal)
      case 'backup.export':
        return post('/api/backup/export', {}, signal)
      case 'backup.import':
        return post('/api/backup/import', { payload: payload.payload }, signal)
      case 'backup.status':
        return get('/api/backup/status', signal)
      case 'credits.balances':
        // 逐账号查余额；单账号失败带原因（error 字段），卡片显示原因而非 0。
        return post('/api/credits/balances', { provider: payload.provider }, signal)
      case 'credits.claimAll':
        return post('/api/credits/claim-all', { provider: payload.provider }, signal)
      case 'onboarding.claim':
        return post('/api/credits/onboarding', { provider: payload.provider, accountId: payload.accountId }, signal)
      default:
        throw new Error(`未知管理方法: ${method}`)
    }
  }
}
