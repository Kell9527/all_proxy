# 02 · Raccoon（商汤小浣熊）账号管理 —— 实现步骤与回移植指南

> 平台：商汤「Raccoon Work / 小浣熊」个人办公版，API 基址 `https://xiaohuanxiong.com`。
> 客户端是 Electron 桌面端（自定义协议 `office-raccoon://auth/callback`，数据目录 `%APPDATA%\office-raccoon`）。
> 手机号/密码加密密钥 `RACCOON_PHONE_CIPHER_SECRET = 'senseraccoon2023'`（AES-128-CFB，来自客户端渲染层）。
> 换号判据对齐用户自写的 `xiaohuanxiong2api/raccoon-gateway.js`（本地检出 `D:\Project\go\token_proxy\xiaohuanxiong2api`）。
> 注意与本项目另一个 provider **SenseNova（商汤开放平台，静态 key）** 是两个不同平台。
>
> 写作时点：2026-10-14（all_proxy HEAD `27f2bc2`，DSH 基线 `3611a62` / HEAD `1080923`）。

## 1. 文件清单（本项目 `src/providers/`，9 文件）

| 文件 | 行数 | 职责 |
|---|---|---|
| `raccoon.ts` | 345 | 协议常量 + 纯函数：`RACCOON_API_BASE`；前缀 `RACCOON_AUTH_PREFIX='/api/web/auth/v1'`、`RACCOON_LLM_PREFIX='/api/web/llm/v2'`、`RACCOON_POINTS_PREFIX='/api/web/points/v1'`、`RACCOON_DESKTOP_PREFIX`、`RACCOON_OFFICE_PREFIX='/api/web/office/v3'`（**本项目新增**）；`decodeJwtExpMs`；`encryptRaccoonPhone`（AES-128-CFB 固定 iv 可解密还原）；`raccoonHeaders`（含 **`orgCodeOf` 折叠 personal**）；`isRaccoonAuthVerifyError`（**本项目新增**） |
| `raccoon-product.ts` | 182 | 产品配置：`clientPlatform:'desktop-windows'`、`userAgent:'Raccoon Work/1.0.35 (Windows)'`、阿里云验证码 `sceneId:'1pkmy0x3', prefix:'hk1r5l'`、兜底模型表（6 个可见模型） |
| `raccoon-oauth.ts` | 410 | 纯 API 层（无本地服务器无持久化）：`generateQrCode` / `pollRaccoonQrLogin` / `sendRaccoonSmsCode` / `loginRaccoonWithSmsCode` / **`loginRaccoonWithPassword`（本项目新增）** / `refreshRaccoonCredential` / `fetchRaccoonUserInfo` |
| `raccoon-auth.ts` | 657 | cordis `Service`（服务名 `raccoonAuth`）：登录编排、凭据落盘、续期、批量续期、昵称修复 |
| `raccoon-login-page.ts` | 652 | 本地登录页（127.0.0.1 随机端口）：**三 Tab**（微信扫码/短信/密码）；宿主侧持有全部敏感状态 |
| `raccoon-qr.ts` | 562 | 零依赖 QR 生成（byte 模式、纠错 M、版本 1-10，SVG 内联；与来源逐字相同） |
| `raccoon-adapter.ts` | 422 | LLM 适配器（OpenAI 兼容 SSE）+ **请求级换号** |
| `raccoon-credits.ts` | 743 | 积分：余额（带原因**三态**）、登录奖励、onboarding、**每日积分保活 `keepAliveRaccoonDailyPoints`（本项目新增）** |

## 2. 与来源仓库的 diff 基线

### 本项目新增（来源 HEAD `1080923` 完全没有）

1. **密码登录全链路**：`loginRaccoonWithPassword`（`POST /api/web/auth/v1/login_with_password`，手机号与密码都 AES 加密）+ 登录页第三 Tab + 编排通道（见 06）。
2. **`RACCOON_OFFICE_PREFIX` + `officeApiPrefix`** + **每日积分保活全套**（见 §5）。
3. **`isRaccoonAuthVerifyError`** 三取或判据（见 §6）。
4. **`orgCodeOf`**（X-Org-Code 折叠 personal，见 §7）。
5. **credits 大扩容**（来源 268 行 → 本项目 743 行）：`fetchRaccoonCreditBalanceDetailed` 三态、保活五态、信封加 `status`/`authFailed` 字段。
6. **换号判据换血**：`looksLikeQuotaError` + `nextUtc8DayStartMs`（当天锁）+ 30 秒限流冷却。

### 来源有、本项目没有（回移植时注意别丢）

| 来源能力 | 说明 |
|---|---|
| `classifyRaccoonFailure` 四分类 | 401/403 **优先判 auth**（防 `403 + insufficient permissions` 被误判 quota 写 24h 冷却——2026-10-06「全池被封」事故）；quota 判 `14018`/`credits exhausted`/中文额度词共现；`RACCOON_MAX_ROTATE=8` |
| 401/403 预刷新 + 刷新后重查账号 id | 刷新后 `findAccountIdByCredential` 反查，防「冷却记在旧账号头上」（PR !71 审计结论） |
| 思考档位（`extra_body.thinking`） | 本项目删除 |
| 499 → aborted 归类 | 本项目没有 |
| 图片预算链路 | `readImageRequest` + `image-budget.ts` + `RACCOON_IMAGE_CAPABILITY_OVERRIDES`（强制两款 flash 模型支持图片）；本项目是简单 readImage 回调 |
| `expiry-sync.ts` 共享同步 | 本项目内联为 `RaccoonAuth.syncAccountExpiry`（含存量账号校正） |

## 3. 请求级换号（`raccoon-adapter.ts` stream）

```
tried = new Set<string>()
for (;;) {
  response = send(credential)   // Authorization: Bearer + X-Org-Code 等头
  401 → refresh() 一次，credentialOfAccount(账号id) 定向取新凭据重发；失败 → 弃用换号
  ok → yield* consumeOpenAiSse(...) 并 return   // 流中途错误不换号
  quotaLike   = 402 || 403 || (4xx && looksLikeQuotaError(errorText))   // 判据对齐 xiaohuanxiong2api
  rateLimited = 429
  authFailed  = 401
  三者皆非 → 原样抛
  无账号池 → 原样抛（单账号行为）
  currentAccountId 非空且 !authFailed → pool.updateModelRateLimit(账号, 模型, resetAt)
    quotaLike  → nextUtc8DayStartMs()          // UTC+8 当日 24:00（积分按自然日结算）
    rateLimited→ Date.now() + 30_000           // RATE_LIMIT_FALLBACK_MS
  tried.add(currentAccountId)
  next = pool.getAvailableAccount('raccoon', model, tried)
  next null 或已 tried → 抛「所有账号均额度不足、受限或凭证失效」（QUOTA_EXCEEDED/RATE_LIMIT/AUTH）
  换凭据 + recordCurrentAccount('raccoon', next.id)
  新凭据已过期 → 就地再 refresh 一次
}
```

- `tried` 是本地 `Set<string>` 传给 `getAvailableAccount` 第三参——池按手动顺序取「第一个可用且不在排除集」，不排除就会原地打转（刚失败的号往往仍是手动顺序第一）；
- **401 不写标记**：token 过期与限流/额度语义不同（别的账号可能仍有效）；
- 首 token / chunk 超时默认 120 秒（环境变量 `ALL_PROXY_RACCOON_*_TIMEOUT_MS` 可覆盖；DSH 侧变量名是 `DSH_RACCOON_*`）。

**与来源 HEAD 的判据表差异**（回移植时二选一，见 README 总原则 3）：

| 情形 | 本项目 | 来源 HEAD |
|---|---|---|
| 403 | 归 quotaLike（当天锁） | **优先判 auth**（先刷新重试，防误伤） |
| 额度冷却 | UTC+8 当日 24:00 | 24h |
| 429 冷却 | 30 秒 | 1h |
| 轮换上限 | 无（试完全池） | 8 |
| 额度判据 | `looksLikeQuotaError` 正则 | `14018`/`credits exhausted`/词共现表 |

## 4. 共享凭据文件机制（一次性 refresh_token 的根治方案）

**背景**：raccoon 的 `refresh_token` 一次性轮换（用一次即作废）。官方客户端/其它网关/本服务各持副本会互相作废（用户报障「账号老是失效」的真因）。**官方客户端退出还会删 `auth.json`、每次重启轮换整组凭据**——所以 provider 层必须零客户端文件依赖。

解法：`credentialRef` 写成 `FILE:<绝对路径>`，多方读写同一份文件。全部能力做在**凭据存储层**：

| 组件 | 文件 | 要点 |
|---|---|---|
| 形态解析 | `src/pool/credential-ref-kind.ts` | `parseCredentialRef` / `formatFileRef`（展开 `~`）/ `validateFileRefInput`（只校验形态，**允许先绑定后创建**）/ `maskCredentialPath`（展示脱敏）。存进 ref 的是**展开后的绝对路径** |
| 存储行为 | `src/pool/store.ts` | `resolve`：**每次实时 readFileSync，绝不缓存**（缓存一次就退化成死副本）；`set`：**原子写**（临时文件带 `process.pid` 防多消费者互踩 + `renameSync`，权限 0600）；`unset`：**直接 return 绝不删文件**（文件可能被官方客户端共享，删掉波及外部） |
| 刷新单飞 | `src/pool/refresh-coordinator.ts` | 键是 **credentialRef**（不是账号 id——多个账号条目可能指向同一文件）；同 key 共享同一 Promise；失败不缓存。**全进程必须共用一个实例** |
| 三步续期 | `src/refresh/refresh-account.ts` | 锁内重读（拿此刻文件里的最新 refresh_token）→ 刷新 → **立即回写**（新 refresh_token 只在响应里）。顺序不可颠倒 |

provider 层（`raccoon*.ts`）依旧零文件访问，由 `tests/unit/raccoon-client-independence.spec.ts` **源码扫描锁死**：不得读 APPDATA 等目录、不得用 `readFileSync`/`node:fs`、不得把 `FILE:` 客户端路径写成默认值、凭据只经存储层读写。回移植到 DSH 时这套机制落在 `ctx.credentials` 体系上重做（架构级，不是文件拷贝），而「客户端独立性」测试**强烈建议一并移植**。

## 5. 每日积分保活（`keepAliveRaccoonDailyPoints`，raccoon-credits.ts）

**官方规则**（跨日对照实验确证，脚本 `scripts/probe-raccoon-daily-extension.mjs`，存档 `data/logs/raccoon-daily-extension-probe.json`）：

- 每日 300 积分服务端自动发放（账单 `biz_type:'daily_grant'`，**无签到端点**——绝不能实现成签到按钮）；
- 不登录当天 24:00 清零；**「当日登录」才延长到 7 天**；
- ✅ 触发端点确证为 `GET /api/web/office/v3/setting_info`（只调它 → 记录从无到有且 `created_at` 为真实时刻）；
- ❌ 读 `/bills` 不触发（带鉴权反复读 14 分钟的反证）；❌ 续期不算登录（`/auth/v1/refresh` 不带 Authorization 头，三天每小时续期积分照样清零）；
- ⚠️ 当天的 `daily_grant` 记录**并非 00:00 就存在**，而是「当天首次登录态动作」时才创建——「今天尚无记录」是干净初始态。

**实现要点**：

- 候选链 `setting_info` → `balance`（兜底），全部 GET 只读；遇 `authFailed` 立即收手（换候选无意义）；
- **自验证**：判定依据是**账单前后对比**（`GET /points/v1/bills?paging.limit=30`，找当日 `daily_grant`），不是「我调了谁」——服务端改口径会如实返回 `not-extended` 而非谎报；已延长判据是 `created_at` 含真实时刻（整点 `T00:00:00` = 未延长，字面量判断避免时区依赖）；
- 返回**五态**：`already-extended`（本次未发任何请求，防假阳性——可能是用户自己开了官方客户端）/ `extended` / `not-extended` / `unavailable`（服务级错误如 503 `200903`，稍后重试）/ `auth-expired`（凭据已作废，重试永远无效）；
- 无定时器，**纯手动按钮**（定时任务依赖机器整夜开机）：前端「保活今日积分」→ `rpcCall('credits.dailyKeepalive')` → `POST /api/credits/daily-keepalive` → 逐账号先按需续期再保活，汇总六计数（extended/alreadyExtended/notExtended/unavailable/authExpired/failed）；
- 能力位：`credits-capabilities.js` 的 `raccoon: {balance:true, onboardingTasks:true, dailyKeepalive:true}`（dailyKeepalive 仅 raccoon 有）。

## 6. 鉴权失效判据（`isRaccoonAuthVerifyError`，raccoon.ts）

```ts
if (status === 401) return true
if (code === 200003) return true            // RACCOON_AUTH_VERIFY_ERROR_CODE
return /authorization_verify_error/i.test(message)
```

三条**取或**——文案这条非冗余（实测同一故障有时只体现在 message 里，业务码会缺失）。语义上与「上游整体不可用」（503 / `200903 service_unavailable`，应稍后重试）严格区分。使用点：`refreshRaccoonCredential`（401 → 抛「登录态已过期，请重新登录」不重试）、credits 信封的 `authFailed` 字段。**来源只有前两条判据**，回移植时把文案判据带上。

## 7. X-Org-Code（`orgCodeOf`，raccoon.ts 的 `raccoonHeaders`）

`office_identity` 为 `'personal'`（大小写不敏感）或空/非字符串 → 折叠成**空串**；否则原样发（真正的组织码）。

原因（2026-10-14 实测）：官方客户端往共享凭据文件写 `office_identity:'personal'`，原样发会被服务端当组织码查库，`/points/v1/balance` 回 `HTTP 400 code=200022 org_not_found_error`。客户端对个人账号发空串。

⚠️ **回移植注意**：本项目 adapter 的 `headers()` 直发 `credential?.office_identity ?? ''`（仅 credits 路径经 `raccoonHeaders` 折叠），来源的 `raccoonHeaders` 也是直发——两边都要改成 `orgCodeOf`，别只改一处。

`raccoonHeaders` 其余头：`Authorization: Bearer`、`X-Raccoon-Language:'zh'`、可选 `X-Client-Platform`（**points/grant 必需**，值必须 `desktop-windows/macos/linux`）、`X-Client-Version`、`X-Client-Device-ID`（凭据有 `device_id` 时）。

## 8. 登录方式（三 Tab，本地登录页 `raccoon-login-page.ts`）

本地服务器五条路径：`/raccoon/login`（页面）、`/raccoon/poll`（扫码轮询）、`/raccoon/sms/send`、`/raccoon/sms/verify`、`/raccoon/password/login`。

| 方式 | 端点 | 关键点 |
|---|---|---|
| 微信扫码（默认 Tab） | 二维码 URL `https://xiaohuanxiong.com/login/mp?code=<32位hex>&appname=商汤小浣熊官网`；轮询 `login_with_qrcode_code` | 宿主侧生成 SVG 二维码内联（`raccoon-qr.ts`，页面零 QR 库零 CDN）；状态 pending/logging/canceled（换新 code 重新下发）/success |
| 短信验证码 | `POST /auth/v1/send_sms`（`{captcha_param, nation_code:'86', phone: encryptRaccoonPhone(phone)}`）→ `login_with_sms` | **手机号必须 AES-128-CFB 加密**（key `senseraccoon2023`，base64(iv‖密文)），否则 `100003 params_encryted_error`；发码需阿里云滑块 captchaParam（页面加载 `AliyunCaptcha.js`），缺失 → `100006 captcha_verify_error` |
| 密码登录（**本项目新增**） | `POST /auth/v1/login_with_password`（`{nation_code:'86', phone:密文, password:密文}`） | **密码与手机号同一加密函数**；错误码 `200004` 账密错、`200101` 限流（`retry after:Ns` 转成可读文案）；不校验 Referer/Origin/UA |

安全约束（单测断言）：只绑 127.0.0.1 随机端口；页面不含任何密钥/token；`phone` 只在发码成功后记宿主侧。超时 5 分钟，结果落定即关服务器。

## 9. 积分余额三态（`fetchRaccoonCreditBalanceDetailed`）

旧实现把「鉴权失效」并入「上游不可用」，用户照着「请稍后重试」提示重试无数次依旧失败（2026-10-14 报障）。现返回带原因的三态：

- `auth-expired`（401/200003/文案 → **重试永远不会好**，必须重新登录）；
- `unavailable`（503/200903 等服务级错误 → 稍后重试即可）；
- `no-data`（服务端没给积分数据）。

前端汇总单独计 `summary.authExpired`。桶拍平：`available_points` → total，各池独立 package；`claimRaccoonLoginReward`（3000 分桌面端登录奖励，必须带 `X-Client-Platform`，幂等 already-claimed）；onboarding 状态里「新人注册礼包」不算登录奖励。

## 10. 集成点（本项目）

- **wiring.ts**（行 480-490）：`descriptorFor('raccoon', …, { rotatesAccounts: true })` + `new RaccoonAdapter({resolveCredential, refresh, accountPool, product, readImage})`；
- **login/orchestrator.ts**：`case 'raccoon'` 调 `startRaccoonLoginFlow`；SMS 通道（`sendRaccoonSmsCode`/`loginRaccoonWithSmsCode`）；密码通道（`loginRaccoonWithPassword`）；
- **account-probe.ts**：raccoon 分支 `new RaccoonAdapter({resolveCredential: async()=>credential, refresh: async()=>{}})`——**不传 accountPool**（探测不产生换号/限流副作用）。该分派表已两次因「新增 provider 没同步」出缺陷（workbuddy、trae），raccoon 是第三个会写 modelRateLimits 的；
- **admin/account-phone.ts**：raccoon 登录响应不回传手机号，补一层**只读**上游查询 `GET /api/web/auth/v1/user_info`（fetchRaccoonUserInfo）取完整 11 位 phone；**只在进程内缓存、绝不写回凭据**（读-改-写不在刷新单飞锁内，会与一次性 refresh_token 轮换互相覆盖）。缓存 hit 6h / miss 60s；
- **refresh/provider-refresher.ts**：`case 'raccoon'` → `refreshRaccoonCredential`；属一次性轮换组；
- **admin/credits-endpoint.ts**：余额循环用三态 + 每错误态独立文案；`keepAliveDailyPoints` 端点。

## 11. 测试（tests/unit/，12 个）

`raccoon.spec`（JWT 解码/加密还原/倍率「1 倍也要显示」）/ `raccoon-product.spec`（对照 `.env.electron` 逐条）/ `raccoon-oauth.spec`（**密码登录组**：双加密、200004 透传、200101 冷却秒数）/ `raccoon-login-page.spec`（三 Tab、页面无密钥、**密码端点密文提交**）/ `raccoon-auth.spec`（persistLogin、refreshAll 只按 refreshable）/ `raccoon-refresh-expiry.spec`（续期后写回账号池、按凭据反查、存量校正）/ `raccoon-adapter.spec`（**换号组**：402/403/400+文案换号当天锁、429 短冷却、401 刷新失败弃用不写标记）/ `raccoon-credits.spec`（**保活组**：already-extended 不发请求、账单自验证、auth-expired 与 unavailable 区分、X-Org-Code personal 折叠、isRaccoonAuthVerifyError 三判据）/ `raccoon-qr.spec` / `raccoon-client-independence.spec`（**源码扫描锁死零客户端文件访问**）/ `raccoon-client-panel.spec`（面板能力、无 dailyCheckin、保活失败分类文案）。

## 12. 回移植清单（DSH ← all_proxy）

按优先级（1-4 为来源没有的实质增强）：

1. **密码登录**：`loginRaccoonWithPassword` 协议函数 + 登录页第三 Tab（`/raccoon/password/login` 端点）+ jet-hub-rpc 的密码通道。DSH 侧登录页当前只有两个 Tab。
2. **每日积分保活**：`RACCOON_OFFICE_PREFIX` + `keepAliveRaccoonDailyPoints` 全套（五态、候选链、账单自验证）+ RPC/端点 + `dailyKeepalive` 能力位 + 面板按钮。
3. **`isRaccoonAuthVerifyError`** 三取或（替换 refresh 里只看 401/200003 的两条判据）。
4. **`orgCodeOf`**（X-Org-Code 折叠 personal）——**两处都要改**：来源 `raccoon.ts` 的 raccoonHeaders 与 adapter headers。
5. **余额三态**：`fetchRaccoonCreditBalanceDetailed` + 前端 `summary.authExpired` 独立计数。
6. 换号判据：**推荐对齐来源 HEAD 的 `classifyRaccoonFailure`**（有事故教训），可选并入本项目「429 → 30s」「quota 锁 UTC+8 当日 24:00」两参数。
7. 共享凭据文件（`FILE:`）机制：DSH 侧要落在 `ctx.credentials` 上架构级重做；`raccoon-client-independence.spec` 一并移植。
8. 手机号显示：DSH 侧若需要账号卡片手机号，参考 account-phone 的「只读 + 进程内缓存 + 绝不写回凭据」三原则。
