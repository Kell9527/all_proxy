# 01 · Loomy（讯飞办公助手）账号管理 —— 实现步骤与回移植指南

> 平台：科大讯飞「Loomy（讯飞办公助手）」。业务基址 `https://loomyad.xunfei.cn/api/v1`，
> 讯飞账号（CAccount）基址 `https://account.xfinfr.com`，微信回调 `https://loomy.xunfei.cn/oauth/wechat/callback`。
> AccessKey 硬编码在 `loomy-product.ts`（`accessKeyId: '2thryby66wxi53sk'`，`appId: 'GM3LOOMY'`），
> 来源是官方 Electron 客户端 `.env.prod`。
>
> 写作时点：2026-10-14（all_proxy HEAD `27f2bc2`，DSH 基线 `3611a62` / HEAD `1080923`）。

## 1. 文件清单（本项目 `src/providers/`，13 文件约 3584 行）

| 文件 | 行数 | 职责 |
|---|---|---|
| `loomy.ts` | 232 | 协议常量与纯函数：`LOOMY_API_BASE` / `LOOMY_ACCOUNT_BASE` / `LOOMY_OK_CODE='000000'` / `LOOMY_AUTH_ERROR_CODE='100002'`；`LoomyCredential{access_token, userid, phone, nickname?, expires_at?}`；`parseLoomyEnvelope`（**业务失败恒 HTTP 200，只看 body.code**）；`splitLoomyRate`（倍率抽 取，认 `(x4.0)` 与 `· x4.0` 两种形态）；`isLoomyRefreshable`（恒 false）；`loomyChatHeaders`（Bearer + token 双头） |
| `loomy-product.ts` | 112 | 产品配置 `LOOMY` + 兜底模型表（8 个 chat 模型） |
| `loomy-sign.ts` | 148 | 讯飞 CAccount HMAC-SHA1 签名：9 段 `\n` 连接拼串（末两段恒空故以 `\n\n` 结尾）；RFC3986 转义补 `! ' ( ) *`；空 body 返回空串而非其 md5 |
| `loomy-oauth.ts` | 319 | 短信验证码 + 微信绑定四步（端点见 §3） |
| `loomy-wechat.ts` | 301 | 微信二维码获取与长轮询（纯 HTTP 无浏览器）：`pollLoomyWechatOnce` 状态码语义 **408=待扫码 / 404=已扫码待确认 / 405=已确认带 wx_code / 403=取消 / 402=失效** |
| `loomy-wechat-login.ts` | 512 | 微信扫码编排（本地服务器承载弹窗页，`/wechat/qr`、`/wechat/poll`、`/wechat/complete` 三端点） |
| `loomy-login-page.ts` | 329 | **手机号验证码本地登录页（本项目新增文件）**：`/loomy/login`、`/loomy/login/send`、`/loomy/login/verify`；msgid 只存宿主侧内存；60 秒重发倒计时 |
| `loomy-auth.ts` | 475 | `LoomyAuth extends Service`（服务名 `loomyAuth`）：`sendSmsCode` / `startWechatLogin` / `loginWithSmsCode` / `refresh`（只探测不续期）/ `refreshAll`（只探测已过期账号）；`RefreshTokenExpiredError`（name 精确匹配供结构化判据） |
| `loomy-credits.ts` | 244 | 积分两池：`fetchLoomyCreditDetail`（只读 `/points/records`）；`claimLoomyDailyQuota`（写 `POST /points/first-login`，幂等判据 `alreadyProcessed`） |
| `loomy-onboarding.ts` | 237 | 新手任务（合计 10000 积分纯 API 直领）：`claimAllLoomyOnboardingTasks` 串行逐个 |
| `loomy-balance-rank.ts` | 135 | 余额分档纯函数：`loomyBalanceTier`（daily>0 → daily；permanent>0 → permanent；否则 none）；`rankLoomyAccountsByBalance`（稳定排序，档内保持传入顺序） |
| `loomy-balance-selector.ts` | 182 | 余额缓存（TTL 60s）+ 选号 `select(candidates, {allowPermanent})` |
| `loomy-adapter.ts` | 518 | LLM 适配器 + **请求级换号**（本项目新增逻辑，见 §4） |

## 2. 与来源仓库的 diff 基线

**先纠正一个容易搞错的事实**：`loomy-balance-rank.ts` / `loomy-balance-selector.ts`
**不是本项目新增**——它们在来源基线 `3611a62` 之前（commit `c252192`/`e4fd649`，2026-09-26
「按余额做负载均衡」）就已存在，本项目**逐字节原样移植**。回移植这两份**不需要**做任何事。

本项目相对基线 `3611a62` 的实质差异只有两处：

| 项 | 内容 | 性质 |
|---|---|---|
| `loomy-login-page.ts` | 手机号验证码本地登录页（329 行），成为**主路径**（基线里手机号登录只有 `LoomyAuth.loginWithSmsCode`，无本地页） | **本项目新增文件** |
| `loomy-adapter.ts` | 请求级换号（145 行 diff）：基线是「单次请求 + 401/403 刷新一次，失败即抛」；本项目改 `for(;;)` 循环换号 + `tried` 排除集 + `recordCurrentAccount` 登记 + 限流标记 | **本项目增强** |

其余文件（`loomy.ts` / `loomy-product.ts` / `loomy-oauth.ts` / `loomy-wechat.ts` /
`loomy-wechat-login.ts` / `loomy-credits.ts` / `loomy-onboarding.ts` / `loomy-sign.ts` /
`loomy-balance-rank.ts` / `loomy-balance-selector.ts`）与基线**逐字节相同**（仅行尾符）；
`loomy-auth.ts` 仅 3 处 import 路径改写。

### ⚠️ 来源 HEAD 已演化的部分（本项目没有，回移植时要决定要不要）

来源 HEAD（`1080923`）在基线之后给 loomy 加了：

1. **adapter 换号**（commit `0abaf1a` 等）：`classifyLoomyFailure(errorText, status)` 四分类，401/403 **优先判 auth**（防 2026-10-06「全池被封」事故——401 写 24h 冷却导致整池不可用），quota 冷却 24h、rate 冷却 1h、`LOOMY_MAX_ROTATE=8` 上限、auth 绝不写冷却、换到的号绕过余额选号器。**实现与本项目不同**。
2. **balance-selector**：失败短缓存 5s、`LoomyNoAccountReason`（exhausted/unknown 分开报）、`LoomySelectionResult` 联合类型。本项目保持基线版（失败也缓存 60 秒、返回 undefined）。
3. **expiry-sync**：`LOOMY_EXPIRY_ACCESSORS` 同步 expiresAt 到账号池（本项目无此文件，凭据构造时直接算好）。
4. **product**：spark-x 上下文窗口按 262144 落地（本项目采信远端 1048576）。
5. **index.ts 接线**：`fetchRemoteModels`（`GET {apiBase}/models`）；本项目 wiring **不传** fetchRemoteModels，loomy 模型目录恒用兜底表 8 模型。

**推荐**：回移植时换号逻辑对齐来源 HEAD 的 `classifyLoomyFailure`（有事故教训），把本项目「429 → 30 秒冷却」这一点作为可选参数并入（见 §4 对比表）。

## 3. 登录方式（两种，无密码登录）

### 3.1 手机号短信验证码（**主路径**）

讯飞 CAccount 端点（HMAC-SHA1 签名，非 PKCE、非 Bearer）：

```
POST {accountBase}/login/phone/sendMsgCode   body: { base, param:{ ccode:'86', phone, expire:300 } }
POST {accountBase}/login/phone/checkCode     body: { base, param:{ ccode:'86', phone, mcode, msgid, expire:1209600 } }
```

- `sendMsgCode` 返回 `msgid`，`checkCode` 必须原样带回；返回 `{session(32位hex), userid(18位数字串)}`；
- `expire:1209600` 只是向服务端**声明** 14 天有效期，响应不带到期时间戳，`expires_at` 由本地按登录时刻 +14 天推算；
- 入口 1：`loomy-login-page.ts` 的 `startLoomyLoginFlow`（本地弹窗页，主路径）；
- 入口 2：登录编排的 SMS 直连通道（`POST /api/login/sms/send` / `complete`，ticket = msgid）。

`buildLoomyAccountBody` 信封：`{base:{appid, modelid:'Web', version:'1.0.0', devid:'web', ua:'Loomy|Desktop|Electron|macOS', traceid}, param}`——**ua 硬编码 macOS 不改**（官方客户端如此）。

### 3.2 微信扫码（可选路径，`method='wechat'`）

三层结构：

1. **二维码层**（`loomy-wechat.ts`，纯 HTTP）：`GET open.weixin.qq.com/connect/qrconnect`（`appid=wx18d60be432287cf8`，`redirect_uri` **必须官方地址**，本地地址被微信域名白名单拒绝）→ HTML 提取 uuid → `GET open.weixin.qq.com/connect/qrcode/<uuid>`（JPEG 转 data URL）→ `GET long.open.weixin.qq.com/connect/l/qrconnect` 长轮询。**回调页实测 404 且不被使用，code 从长轮询拿**。
2. **绑定层**（`loomy-wechat-login.ts` 编排 + `loomy-oauth.ts` 四步）：`bindLoomyThirdAccount`（`POST /login/thirdAccount/bind/auth`，`{tcode:{code}, type:'wx'}` → `{bind, rcode, isnew, nickname, headpic}`）→ bind=1 走 `bindLoomySkip`；bind=0 走 `bindLoomySendMsg` → `bindLoomyCheckCode`（绑手机号）。**微信 code 只在第 1 步用一次，后续只用 rcode**。
3. 本地服务器三端点，5 分钟总超时。

**主路径选手机号的理由**（design D12）：微信 openid 绑死单一微信号只能登一个账号，手机号可多账号。

## 4. 请求级换号（`loomy-adapter.ts` stream，本项目版）

```
tried = new Set<string>()
for (;;) {
  response = send(credential.access_token)
  401/403 → 先 refresh() 一次（Loomy 无端点多半抛错，不致命），credentialOfAccount(账号id) 定向取新凭据重发一次
  ok → yield* consumeOpenAiSse(...) 并 return   // 流中途错误不换号
  quotaLike    = 402 || (4xx && looksLikeQuotaError(errorText))   // 实测 Loomy 是 400 +「积分余额不足」
  rateLimited  = 429
  authFailed   = 401
  三者皆非 → 原样抛 LlmError（与账号无关）
  无账号池 → 原样抛（单账号行为）
  currentAccountId 非空且 !authFailed → pool.updateModelRateLimit(账号, 模型, resetAt)
  tried.add(currentAccountId)
  next = pool.getAvailableAccount('loomy', model, tried)
  next 为 null 或已 tried → 抛「所有账号均额度不足、受限或凭证失效」（QUOTA_EXCEEDED/RATE_LIMIT/AUTH）
  换凭据 + recordCurrentAccount('loomy', next.id)   // 定向续期与用量归属
  新凭据过期 → 就地再 refresh 一次
}
```

各状态处理与来源 HEAD 对比：

| 情形 | 本项目 | 来源 HEAD |
|---|---|---|
| 额度耗尽（402 / 4xx+额度文案） | 标记到 **UTC+8 当日 24:00**（`nextUtc8DayStartMs`）+ 换号 | 24h 冷却 + 换号，auth 优先判（401/403 先判 auth 防误伤） |
| 429 | **30 秒**（`RATE_LIMIT_FALLBACK_MS`）+ 换号 | **1h** 冷却 + 换号 |
| 401 | 先刷新重试一次；**不写标记**；失败换号 | auth 绝不写冷却，换号 |
| 裸 403（无额度文案） | **不标记不换号**，原样抛 | 优先判 auth → 刷新重试 |
| 轮换上限 | 无（试完全部候选） | `LOOMY_MAX_ROTATE=8` |
| 换到的号 | 经余额选号器（wiring 的 resolveCredential 闭包） | **绕过**余额选号器 |

当天锁的实现：复用既有 `modelRateLimits`（账号×模型 → resetAt 毫秒），无新存储形态；
`nextUtc8DayStartMs` 用算术而非 `setHours`（避免非 UTC+8 机器算错解禁时刻），两边仓库都有该函数。

## 5. 余额分档选号（来源已有，本项目原样移植——列出以备核对）

- 三档：`dailyBalance > 0`（每日赠送，优先）→ `permanentBalance > 0`（永久积分）→ 无余额/查询失败；
- **档内保持手动顺序不重排**；查询失败的账号归最后一档（不抛错）；
- `allowPermanent: false`（锁定永久积分，`pool.loomyPermanentLocked()`）时只剩永久积分的账号归 none 不可用；全部不可用 → 选号返回 undefined → **wiring 闭包直接抛明确错误**（「已锁定永久积分，而所有账号的今日赠送额度都已用尽」），绝不落通用兜底绕过锁定；
- 解锁时全部无余额仍返回第一个候选（既有行为，让上游报余额不足更准确）。

存在理由：Loomy 今日额度耗尽后服务端**静默继续扣永久积分不报错**。

## 6. 集成点（本项目；回移植时按 DSH 形态对照）

- **wiring.ts**（行 416-478）：`descriptorFor('loomy', …, { rotatesAccounts: true })`；`resolveCredential` 闭包先按「未停用 + 该模型未受限」筛候选再交 `LoomyBalanceSelector.select`，选中后 `recordCurrentAccount` 登记；
- **login/orchestrator.ts**：`SMS_PROVIDERS = new Set(['loomy','raccoon'])`；URL flow `case 'loomy'`（`method==='wechat'` 走扫码，缺省走手机号本地页）；`loomyOutcome` 的 `refreshable` 恒 false；
- **pool**：`loomyPermanentLocked()` / `setLoomyPermanentLocked()`（兼容镜像，实存 `permanentLocks.loomy`）；`dsh-import.ts` 的 `LOOMY` 前缀映射；
- **admin**：`GET /api/accounts` 凭据栏直读 `phone` 字段显示手机号；`PATCH /api/loomy-lock`（兼容旧前端）与通用 `PATCH /api/permanent-lock`；积分端点有 balance / dailyCheckin / onboardingTasks 三能力。

## 7. 必须保持的坑位约定

1. **无 refresh 端点**：`isLoomyRefreshable` 恒 false；`refresh()` 只做有效性探测（`GET /points/records?pageNo=1&pageSize=1`），失效抛 `RefreshTokenExpiredError`（error.name 精确匹配）；`refreshAll` 只探测**已过期**账号；`scheduleRefresh`/`stop` 有意空实现。
2. **两套认证头**：`/chat/completions` 认 `Authorization: Bearer`（官方客户端 Bearer+token 双头都发，`loomyChatHeaders` 保持一致）；`/models`、`/points/*`、`/onboarding/*` 只认小写 `token` 头。带错得 HTTP 200 + `{"code":"100002"}`。
3. **业务失败恒 HTTP 200**，成败只看 body `code`（`000000` 成功；`100002` 登录失效不可重试；`100001` 参数错误）。
4. **倍率在 name 字符串里**（无独立字段），三种括号风格混用，`splitLoomyRate` 幂等。
5. **`dailyQuota` 只在 first-login 响应里有**，不要硬编码 5000；`dailyBalance = dailyQuota - dailyConsumed`，消耗后不回补；「一键签到」语义是「触发每日额度重置」。
6. **签名 body 必须先序列化一次**，签名与发送共用同一字符串。
7. **凭据字段**：`access_token`（session）、`userid`、`phone`（凭据栏显示手机号）、`expires_at`（毫秒时间戳字符串，本地 +14 天推算）。
8. **微信长轮询状态码 404/405 曾被读反**（已扫码待确认 = 404、已确认 = 405），这是来源已修的真实缺陷，别改回去。

## 8. 测试（tests/unit/，14 个）

`loomy.spec` / `loomy-product.spec` / `loomy-sign.spec`（9 段拼串格式锁死）/ `loomy-oauth.spec` /
`loomy-wechat.spec`（405/404/403/402/408 状态语义）/ `loomy-wechat-login.spec`（bind=1 直接完成 / bind=0 表单）/
`loomy-login-page.spec`（**本项目新增**）/ `loomy-auth.spec`（expires_at +14 天、探测语义、error.name 精确）/
`loomy-credits.spec`（alreadyProcessed → already-claimed）/ `loomy-onboarding.spec`（合计 10000）/
`loomy-balance-rank.spec` / `loomy-balance-selector.spec`（锁定时 undefined、解锁时全无余额仍返回第一个）/
`loomy-adapter.spec`（**换号组**：400+额度文案换号并标到当日 24:00、429 短冷却换号、全耗尽 QUOTA_EXCEEDED、400 无额度文案不换号）/
`loomy-client.spec`（前端源码断言）。DSH 侧另有 `loomy-docs.spec`（文档一致性）。

## 9. 回移植清单（DSH ← all_proxy）

按优先级：

1. **换号逻辑合并**：DSH HEAD 已有 `classifyLoomyFailure` 四分类——评估是否把本项目「429 → 30 秒冷却」「quota 锁到 UTC+8 当日 24:00（自然日结算更准）」两点并入其冷却表；**不建议**把本项目的简化判据反向覆盖来源分类器。
2. **可选**：`loomy-login-page.ts`（手机验证码本地页）——DSH 侧已有 `loginMode:'sms'` 表单路径，是否需要本地页看产品形态（DSH 是插件，弹窗由宿主承载，多半不需要）。
3. 核对项：余额选号（两边同源无需动）、`spark-x` 上下文窗口（来源按 262144 落地 vs 本项目采信远端 1048576，来源是对的）、`fetchRemoteModels`（来源有、本项目没接——若 DSH 侧已有则保留）。
4. 测试对照：把 `loomy-adapter.spec` 的换号组用例按 DSH 的 classify 语义改写后移植。
