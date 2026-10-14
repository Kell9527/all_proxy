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
 * | `provider.list` / `setEnabled` | `GET /api/providers` / `PATCH /api/models {provider, enabled}` |
 * | `backup.export` / `import` / `status` | `POST`/`POST`/`GET /api/backup/*` |
 * | `loomy.permanentLock` | `PATCH /api/permanent-lock`（按 provider；locked 省略=只读） |
 * | `credits.balances` | `POST /api/credits/balances`（逐账号余额 + windowDays + extra） |
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
        // region（可选）：accio 的登录区域（cn/global），其余 provider 忽略。
        const r = await post('/api/login/start', {
          provider: payload.provider,
          ...(payload.method ? { method: payload.method } : {}),
          ...(payload.region ? { region: payload.region } : {}),
        }, signal)
        return { accountId: r.sessionId, loginUrl: r.loginUrl ?? '', userCode: r.userCode }
      }
      case 'account.addKey': {
        // 静态 API Key 建号（仅 SenseNova 等）：直接写凭据 + 落账号，无登录。
        // ⚠️ apiKey 明文只在本次请求体里出现，返回体不含它（见后端 /api/accounts）。
        return post('/api/accounts', {
          provider: payload.provider,
          apiKey: payload.apiKey,
          ...(payload.nickname ? { nickname: payload.nickname } : {}),
        }, signal)
      }
      case 'login.poll': {
        let r;
        try {
          r = await post('/api/login/poll', { sessionId: payload.accountId }, signal)
        } catch (caught) {
          // ⚠️ 会话不存在（服务重启 / 已超时清理）是**终态**：返回 failed 标记
          // 让调用方停损，而不是每秒重放一个必然 404 的请求直到前端超时。
          // 网络抖动才 throw 给调用方静默重试（两者必须分开）。
          const message = caught?.message || '';
          if (message.includes('登录会话不存在')) {
            return {
              done: false,
              failed: true,
              message: '登录会话已过期（服务可能重启过），请重新点「+ 新建账号」。',
              reused: false,
            };
          }
          throw caught;
        }
        // 业务失败（如「华为云未返回 MaaS 凭据」）**不 throw**：返回标记让
        // 调用方停损并显示原因。早期这里 throw，而调用方 catch 里静默继续
        // 轮询 ⇒ 用户看到的是沉默（报障「授权成功但账号没加进来」的形态）。
        if (r.status === 'failed') {
          return { done: false, failed: true, message: r.message || '登录失败', reused: false };
        }
        // reused：判重命中（该账号已在池中，未新建条目）——前端据此提示，
        // 否则用户登完发现账号没多一个，会以为操作失败了。
        return { done: r.status === 'done', account: r.account, reused: r.reused === true }
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
      case 'provider.list': {
        // 供应商总开关弹窗的状态源：每项带 enabled / 账号数。
        // ⚠️ 零网络：只读账号池与注册表的内存状态，不触发任何 provider 的
        // 远端目录拉取（打开弹窗不该打上游）。
        const r = await get('/api/providers', signal)
        return { providers: r.data ?? [] }
      }
      case 'provider.setEnabled':
        // 供应商总开关（写）。复用 /api/models 的 { provider, enabled } 分支 ——
        // 后端对 provider 开关与模型黑名单共用该端点（审计操作名 model-set）。
        return patch('/api/models', {
          provider: payload.provider,
          enabled: payload.enabled === true,
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
        // 「锁定永久积分」：**按 provider**（Loomy / OfficeAce 各自独立）。
        // locked 省略 = 只读查询（后端 /api/permanent-lock 兼容两种语义）。
        return patch('/api/permanent-lock', {
          provider: payload.provider ?? 'loomy',
          ...(payload.locked === undefined ? {} : { locked: payload.locked === true }),
        }, signal)
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
      case 'credits.dailyKeepalive':
        // 每日积分保活（仅 raccoon）：模拟「当日登录」把每日积分有效期延长到 7 天。
        return post('/api/credits/daily-keepalive', { provider: payload.provider }, signal)
      default:
        throw new Error(`未知管理方法: ${method}`)
    }
  }
}
