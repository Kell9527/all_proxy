# 06 · 短信登录 / 密码登录 tab 页与登录编排 —— 实现步骤与回移植指南

> 覆盖两处「tab」：① 管理端**顶层 tab 页**（`web/src/admin-panels.js` 的 `SmsPanel` /
> `PasswordPanel`，直连 REST 端点）；② **弹窗内本地登录页的 tab**（Loomy 手机验证码页、
> Raccoon 三 tab 页——这两份在 01/02 文档里，本文只列索引）。
> 核心是后端**登录编排**（`src/login/orchestrator.ts`）的完整设计。
>
> 写作时点：2026-10-14（all_proxy HEAD `27f2bc2`，DSH HEAD `1080923`）。

## 1. 总体架构

```
前端 jet-hub.js「+ 新建账号」──rpc──▶ /api/login/start ──▶ LoginOrchestrator.start()
   │  立即拿 loginUrl + sessionId                              │ startUrlFlow(provider)（各 provider 工厂）
   │  window.open(loginUrl)（OfficeAce 除外）                   │ 返回 {loginUrl, result: Promise, cancel}
   ▼                                                            ▼
本地登录页（loomy/raccoon 弹窗 tab）            loopback 回调（codearts/accio 等）
   │ 完成登录 → result 落定 → orchestrator.settle()（判重 → 先凭据后索引 → 落账号条目）
   ▼
前端每 1s 轮询 /api/login/poll ──▶ {status: pending | done{account, reused?} | failed{message}}
```

另有**两条直连通道**（不经 URL 弹窗）：

- `POST /api/login/sms/send` + `/api/login/sms/complete`（loomy / raccoon）→ 管理端 `SmsPanel` tab；
- `POST /api/login/password/complete`（仅 raccoon）→ 管理端 `PasswordPanel` tab。

## 2. 后端登录编排（src/login/orchestrator.ts，627 行）

### 设计原则（文件头声明）

1. **两步式契约**：`start` 立即返回 `loginUrl`，绝不阻塞到授权完成（浏览器只在用户手势后的短暂窗口允许 `window.open`）；
2. **落账号条目**：先写凭据、再写索引（顺序颠倒会出现「索引里有账号但凭据不存在」的半截状态）；
3. **失败可读归因** `classifyLoginError()` 三类：非 JSON → 「上游服务返回了非预期响应」；401/403/unauthorized/forbidden → 「凭据已失效或无权限，请重新登录」；缺字段 → 原样透传。

### 关键常量与类型

- `LOGIN_SESSION_TTL_MS = 30 * 60 * 1000`（**2026-10-14 从 10 分钟提到 30 分钟**——不自动开窗后授权链变长：复制链接→换浏览器→登华为（密码+2FA）→授权，10 分钟经常不够；超时 `cancel` 清理 loopback/轮询）；
- `SMS_PROVIDERS = new Set(['loomy', 'raccoon'])`；
- `ChannelOutcome`：`{access, expires, refreshable, nickname?}`；
- 会话状态机：`pending → done{account} | failed{message}`；`poll` 幂等只读，会话不存在 throw（router 转 404 `login_session_not_found`）。

### provider × 登录方式矩阵（以 `startUrlFlow` / SMS / 密码通道登记为准）

| provider | 链接式（弹窗+轮询） | 短信验证码 | 密码 | 扫码 | 备注 |
|---|---|---|---|---|---|
| codearts | OAuth loopback | — | — | — | |
| buddy / workbuddy | 后端轮询式 | — | — | — | |
| lobsterai / trae | loopback | — | — | — | |
| qoder / qodercn | 设备码轮询 | — | — | — | |
| cline | 设备码（带 userCode） | — | — | — | |
| **loomy** | **默认 = 手机验证码本地页**；`method:'wechat'` = 扫码页 | ✅ | — | ✅ | 主路径手机号（D12：微信 openid 绑死单号） |
| **raccoon** | 本地登录页（三 tab 全含） | ✅（需阿里云滑块） | ✅（**唯一密码 provider**） | ✅ | |
| **officeace** | 云侧轮询（**不自动开窗**，只给链接） | — | — | — | SSO 静默复用 + accountId 判重 |
| **accio** | PKCE loopback | — | — | — | **region 预选**（cn/global） |
| sensenova | —（静态 key，`POST /api/accounts`） | — | — | — | |

### 落账号条目（settle / settleInternal / settleNew）

- **判重钩子**（`options.dedupe`，OfficeAce 注入 `findExistingOfficeAceAccount`）在**所有**落条目路径生效（URL 会话、SMS、密码三通道）；命中 → 不建新条目、**新凭据写回既有 ref**（refresh_token 一次性，不写回下次刷新必失败）、返回 `{entry, reused: true}`；
- `settleNew` 生成 `PROVIDER_ACCOUNT_8hex` 凭据 ref + `provider-8hex` 账号 id，**先 `credentials.set` 再 `pool.addAccount`**；
- 昵称优先级：通道显式 → 凭据 JSON（nickname/user_name/userName/display_name）→ displayNames → provider，统一过 `sanitizeNickname`（手机号 `138****5678`，幂等）。

### REST 端点（src/admin/router.ts）

| 端点 | body | 说明 |
|---|---|---|
| `POST /api/login/start` | `{provider, method?, region?}` | 立即返回；method 只对 loomy 有意义（缺省手机验证码）；region 只对 accio 有意义 |
| `POST /api/login/poll` | `{sessionId}` | 三态轮询 |
| `POST /api/login/cancel` | `{sessionId}` | 幂等 |
| `POST /api/login/sms/send` | `{provider, phone, captchaParam?}` | → `{ticket}`（loomy=msgid；raccoon 空串） |
| `POST /api/login/sms/complete` | `{provider, phone, code, ticket?}` | → 账号条目 |
| `POST /api/login/password/complete` | `{provider:'raccoon', phone, password}` | → 账号条目 |

写操作经 `runWrite(action, target, fn)` 串行化并留审计。

## 3. 管理端顶层 tab（web/src/admin-panels.js）

`TABS = ['Provider 管理', 'API Keys', '用量与状态', '短信登录', '密码登录']`。

- **`SmsPanel`**：provider 下拉（loomy/raccoon）+ 手机号 + 验证码；`sendCode()` → `POST /api/login/sms/send` 拿 ticket；`complete()` → `/api/login/sms/complete`。文案注明 raccoon 也可用「Provider 管理 → 新建账号」弹窗页（内含三方式）。
- **`PasswordPanel`**：手机号 + 密码（`type:'password'`）；**无 provider 下拉**（目前只有 raccoon）→ `POST /api/login/password/complete`。

前端轮询契约（`web/src/rpc-bridge.js` 的 `login.poll`，**本项目改动的核心**）：

- `r.status === 'failed'` → 返回 `{done:false, failed:true, message}` **不 throw**（早期 throw 且调用方 catch 静默继续轮询 ⇒ 用户对着沉默界面等到超时——2026-10-14 三次报障的真因之一）；
- 「登录会话不存在」404（服务重启/超时清理）→ 同样转 `failed` 不 throw（否则每秒重放必然 404）；网络抖动才 throw 静默重试；
- `done` 时透传 `reused`。

前端轮询行为（jet-hub.js `createAccount`）：

- `LOGIN_POLL_TIMEOUT_MS = 30 分钟`（**必须与后端 TTL 对齐**——前端先停 = 后端落了账号界面却不刷新）；
- 每秒 `login.poll`；`failed === true` → **停损**：清 interval + 红色 notice 显示原因；
- `reused === true` → warn「该账号已在账号池中，未重复添加」+ 指引（无痕窗口登**不同的华为账号**）；
- 「已等待 X 分 Y 秒」每秒跳动；超时不丢链接（提示刷新页面看账号是否已添加）。

## 4. 弹窗内 tab（本地登录页，细节见 01/02 文档）

| 页面 | tab | 要点 |
|---|---|---|
| Loomy `/loomy/login`（本项目新增文件） | 手机号 + 验证码（主路径） | msgid 只存宿主侧内存；60 秒重发倒计时；`/^1[3-9]\d{9}$/` 校验 |
| Raccoon `/raccoon/login` | 微信扫码（默认）/ 短信 / 密码（**密码 tab 本项目新增**） | 宿主侧生成 SVG 二维码（零 QR 库零 CDN）；短信 tab 需阿里云滑块；敏感状态全宿主侧 |

两页共同安全约束（单测断言）：只绑 `127.0.0.1` 随机端口；页面不含任何密钥/token；超时 5 分钟、结果落定即关服务器。

## 5. OfficeAce 不自动开窗（login-window-policy.js，本项目新增文件）

- `shouldAutoOpenLoginWindow(provider)`：`return provider !== 'officeace'`；
- 本项目（Web 服务，可能跑远程/无 GUI）**只展示链接**（无条件展示，用户原话「给我 URL，让我自己去登」）+ `loginLinkHint` 三要素文案；
- 轮询式授权跨机器成立（code 由服务端轮询获取）；
- **DSH 侧对应物是宿主 `openIncognitoWindow`**（`src/login.ts`，spawn 默认浏览器：Chromium `--incognito --new-window`、Firefox `-private-window`、**禁用 `--app=`**——被国产浏览器当域名解析；`NODE_ENV=test` 短路），返回 `incognitoOpened` 标记供前端决定是否回退 `window.open`。回移植时**保留 DSH 的无痕 spawn**，把本项目的文案、failed 停损、30 分钟超时带回。

## 6. 与来源（DSH）的架构对照

| 方面 | 本项目 | 来源（DSH） | 回移植动作 |
|---|---|---|---|
| 编排位置 | `src/login/orchestrator.ts` 独立类 + REST | `src/jet-hub-rpc.ts`（约 4000 行）内联各 provider 启动逻辑 | 按 RPC 分支形式重写，**占位条目模式（先 `pool.addAccount` 后写凭据）不要学**——本项目「结果落定才落条目」更稳 |
| login.poll 语义 | 独立会话 Map，`pending/done/failed` 三态带 message | 查池条目 + 凭据 resolve；officeace 由 poll 代持轮询 | — |
| SMS 端点 | `login.sendSms`/`submitSms` 仅 Loomy 备用（主路径微信） | `/api/login/sms/*`，loomy + raccoon | **把 raccoon SMS + loomy 主路径手机验证码带回** |
| 密码登录 | **不存在**（raccoon 登录页只有两个 tab） | 全链路（协议函数 + 登录页第三 tab + 编排通道 + PasswordPanel） | **全新带回**（openspec change `add-raccoon-password-login` 有完整设计） |
| 前端超时 | 5 分钟 | 30 分钟 + 等待显示 + failed 停损 | **带回**（三处对齐） |
| Accio 预选 | zCode/Accio 通用下拉弹窗（`new-account.js`） | 只有 Accio（radio 内联） | DSH 形态已覆盖，无需动 |
| 传输层 | REST fetch（rpc-bridge） | DSH RPC（`connection.rpc.call`） | 端点按 RPC method 形式落 |

## 7. 测试（tests/unit/）

- `login-orchestrator.spec`：昵称脱敏幂等、`classifyLoginError` 三类、先凭据后索引、Loomy SMS（send→ticket→complete）、Raccoon SMS（captchaParam）、**Raccoon 密码登录**（加密提交、200004 归因）、两步式会话（start 立即返回、cancel 清理）、accio region 归一；
- `login-window-policy.spec`：不开窗判定、hint 文案要点、**源码级断言**（守卫在 `window.open` 之前、`LOGIN_POLL_TIMEOUT_MS` 与 TTL 对齐、rpc-bridge 业务失败不 throw、failed 停损）；
- `loomy-login-page.spec` / `raccoon-login-page.spec` / `officeace-login.spec` / `officeace-dedupe.spec`（见各分文档）。

## 8. 回移植清单（DSH ← all_proxy）

1. **Raccoon 密码登录全链路**（来源完全没有）：`loginRaccoonWithPassword` + 登录页第三 tab + jet-hub-rpc 密码通道（对应 `login.passwordComplete` 之类 method）+ 前端入口；
2. **Loomy 手机验证码主路径**：来源主路径是微信扫码（`login.sendSms`/`submitSms` 仅备用）——把「手机验证码本地页 + SMS 通道扶正」的设计带回（Loomy 多账号只能靠手机号，微信 openid 绑死单号）；
3. **登录 UI 三增强**：前端轮询 30 分钟（与后端对齐）+「已等待 X 分 Y 秒」+ `failed` 停损显示原因（rpc 桥业务失败不 throw 的语义改造）；
4. **OfficeAce 链接展示**：保留 DSH 无痕 spawn，但把「链接无条件展示 + `loginLinkHint` 文案 + reused 判重提示」带回；
5. **两阶段错误分离 + cancelled 留痕**（officeace 分支，见 03）；
6. 数据契约扩展：`RpcPollLoginResponse` 加 `failed?: boolean` / `message?: string` / `reused?: boolean` / `account?`。
