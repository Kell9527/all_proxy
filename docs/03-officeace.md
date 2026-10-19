# 03 · OfficeAce（华为云 ModelArts MaaS）账号管理 —— 实现步骤与回移植指南

> 平台：华为云 ModelArts MaaS（客户端品牌 OfficeAce / AgentArts）。
> 授权域 `https://agentarts.cn-southwest-2.myhuaweicloud.com`（下称 CLAW_BASE）、
> token 端点 `https://sts.cn-north-4.myhuaweicloud.com/v1/oauth2/tokens`、
> 管理面默认域 `https://officeace.cn-southwest-2.huaweicloud-agentarts.com`。
> 公开客户端 `client_id='pdp5_for_agentarts'`（PKCE，无 secret）。
>
> 写作时点：2026-10-14。**OfficeAce 是 2026-10-14 从来源 HEAD（`1080923`）移植的，超出基线
> `3611a62`**——即来源已有此 provider，本项目的价值在于：裁掉不适配独立服务形态的部分 +
> 修掉登录链路多个真实 bug。回移植方向是**差异合并**而非全新引入。

## 1. 文件清单（本项目 `src/providers/`，5 文件 1460 行）

| 文件 | 行数 | 职责 |
|---|---|---|
| `officeace-product.ts` | 89 | 产品常量：`OFFICEACE`（id/displayName `'OfficeAce (华为云)'`/defaultBaseUrl）、`OFFICEACE_MODELS`（8 模型静态表 + multimodal 实测表） |
| `officeace-auth.ts` | 452 | 协议层：华为云 OAuth（PKCE+DPoP）+ SDK-HMAC-SHA256 签名 + STS 刷新：`startLogin` / `pollLoginCode` / `completeLogin` / `refreshOfficeAceCredential` / `basicAuthorization` / `isExpiring` |
| `officeace-login.ts` | 142 | 登录编排：把轮询式 OAuth 包成两步式 `{loginUrl, result, close}`；**两阶段错误分离** |
| `officeace-adapter.ts` | 376 | LlmAdapter：OpenAI 兼容 + `maasBaseUrlOf` + `max_tokens` 下限丢弃 |
| `officeace-credits.ts` | 401 | 积分：V11-HMAC-SHA256 云侧直读 + 每日福利自动领取 + 分桶归一化 |

## 2. 登录链路（协议五步，2026-10-12 实测验证）

1. `POST {CLAW_BASE}/v1/claw/auth/state`（body `{}`，15s 超时）→ 云侧登记 state（匿名）。**state 必须用云侧签发的**——自造的 state 回调后查不到。
2. 浏览器打开 `https://auth.huaweicloud.com/authui/login.html?service=<encodeURIComponent(authui/v1/oauth2/authorize?…)>`，参数含 `client_id / code_challenge / code_challenge_method=SHA-256 / state / scope=openid / redirect_uri / response_type=code`。
3. `GET {CLAW_BASE}/v1/claw/auth/code?state=` 轮询取 code（匿名，**秒级时效**）。
4. `POST {TOKEN_URL}` 用 code + verifier + DPoP 换 token（30s 超时）。
5. `GET {CLAW_BASE}/v1/claw/client-permission-validate`（AK/SK SDK-HMAC-SHA256 签名）→ `subscription.model_info.model_auth_info.{model_app_key, model_app_secret}` + `model_api_url_base` ⇒ 推理凭据。

### pollLoginCode —— 勿加 status===200 判据（华为云实测）

未就绪时服务端回 **HTTP 202 + 无 code 字段**（`Response.ok` 含 202）。判定靠「`r.ok` 且响应体取得到非空 `code` 字段」；**不能**加 `status === 200` 判据——202 是合法的「未就绪」响应，加了会把 202 误判。返回 `undefined` = 用户还没授权，前端继续轮询。

### fetchModelInfo —— 未开通 MaaS 的报错文案（用户三次报障的真相）

当 `model_app_key/secret` 不是字符串时抛：

> 华为云未返回 MaaS 推理凭据 —— 该华为账号尚未开通 ModelArts MaaS（OfficeAce 的推理走 ModelArts MaaS）。请在华为云控制台开通后重试，或换一个已开通的华为账号。

（用户在无痕窗口登的是**另一个没开通 MaaS 的华为账号**，token 交换成功但拿不到推理凭据；早期前端把失败吞了，用户只看到华为云「欢迎使用」页和沉默界面。）

### 两阶段错误分离（本项目修的 bug ①）

轮询与换 token **绝不能合在一个 try**：

- 阶段一（`pollLoginCode`）失败可容忍：`console.warn` 后继续轮询到超时；
- 阶段二（拿到 code 后 `completeLogin`）失败是**终态**：立刻 `reject` 带原文（`华为云 token 交换失败：${message}。请重新点「+ 新建账号」再试一次`），**不再继续轮询**——code 很可能一次性，吞掉后空转到超时。

### cancelled 留痕（bug ②）

token 交换完成但会话已被取消（TTL 超时/服务重启）→ 必须 `console.warn` 留痕后丢弃凭据，不能静默 return——否则「授权成功但账号没进来」变成无头案。

### 超时 30 分钟（bug ③）

`OFFICEACE_LOGIN_TIMEOUT_MS = 30*60*1000`（从 10 分钟提到 30——授权链现在是「复制链接→无痕窗口→登华为（密码+2FA）→授权」，10 分钟经常不够），与编排会话 TTL、前端轮询上限**三处对齐**。轮询间隔 2 秒（code 秒级时效故取短）。

## 3. DPoP 与 refresh_token 一次性轮换

- **私钥**：`startLogin` 时与 `codeVerifier` 同批生成（ECDSA P-256，导出 JWK），随凭据 JSON **整体落盘**（`dpopPrivateJwk` 是 `OfficeAceCredential` 的字段）——刷新必须用**同一把**签 proof；
- proof 形态：header `{typ:'dpop+jwt', alg:'ES256', jwk:{kty,x,y,crv}}`，payload `{htm, htu, iat, jti}`，publicJwk 从私钥 JWK 推回；
- **refresh_token 一次性**（STS5.1806 "has been used"）：进 `ROTATING_REFRESH_PROVIDERS`（与 codearts/trae/accio 同组，导入时警告「只让一边刷新」）+ `RefreshCoordinator` 单飞 + 统一三步续期（锁内重读 → 刷新 → 立即回写）；
- 刷新失败 `console.warn` 留痕后返回 undefined（需重新登录），**必须留痕**；
- 刷新成功后内部再调 `fetchModelInfo` 更新 MaaS Basic 凭据（失败不回滚）。

## 4. 适配器要点（officeace-adapter.ts）

### maasBaseUrlOf —— 阻断级缺陷修复

**必须优先用凭据里按账号下发的 `maasBaseUrl`**：华为按账号下发专属网关（`modelgw-0004.officeace…`），同一 Basic 凭据打硬编码默认域回 **401 `APIG.1009`**（`/v2/models` 与 `/v2/chat/completions` 都 401），打专属网关 200。后果链：probe 401 → `listModels` 返回 `[]` → 模型选择器空分组。凭据没带时回退默认域（零行为变化）。probe / stream / 401 重试三处全部走它。

⚠️ 但**订阅/倍率等 V11 管理面 API 打默认域**（不随推理 host 改），有专门测试断言这一点。

### max_tokens < 4096 直接丢弃

```ts
const MAX_TOKENS_FLOOR = 4096
const maxTokens = options.maxTokens !== undefined && options.maxTokens >= MAX_TOKENS_FLOOR ? options.maxTokens : undefined
```

原因（2026-10-12 实测定位「渠道老是停」）：OfficeAce 全系模型带思考链，**思考 token 计入 max_tokens 预算**。实测 max_tokens=32 → reasoning_tokens=32、content 0 字；小预算被思考链烧光，正文零产出，外部表现是「回复是空的/渠道停了」。低于下限的预算直接丢弃（交给端点默认上限兜底），`max_tokens` 字段仅在非 undefined 时写入。

### 其余要点

- 推理鉴权：`Authorization: Basic base64(modelAppKey + ':' + modelAppSecret)`；401 时若注入 refresh 则续期一次重发；
- 目录：静态表 + 探测门控（`GET {maasBaseUrl}/v2/models`，8s 超时，200 且 JSON 才算过；`catalogSource:'static-only'`——`/v2/models` 只返回 id 无能力元数据）；
- 图片准入：multimodal 实测表只有 `deepseek-v4.1-flash` 与 `kimi-k2.6`；纯文本模型收图 → 早失败 `UNSUPPORTED_CONTENT`（文案点名支持的模型）；
- `rotatesAccounts: false`（无请求级换号、不写 modelRateLimits）；
- 华为 STS `expiration` 是 **ISO 8601 字符串**不是数值时间戳——`officeaceExpiresAtMs` 不做秒→毫秒归一化，这不是 bug；凭据字段是 **camelCase**（`refreshToken`/`modelAppKey`）。

## 5. 积分（officeace-credits.ts）

### V11-HMAC-SHA256 三条签名规则（逐字复刻客户端 chunk 的 B()/F()）

1. **头集合**：GET 请求**不发 `Content-Type`**（多这一个头签名串就多一行，服务端重算必不匹配）；POST 必须带 `application/json;charset=utf8`（不带实测 HTTP 500 `OfficeAce.11020001`）。
2. **密钥派生**：`u = HMAC(sha256, accessKey).update(secretKey)`；`a = scope 字节 + 0x01`；`derive = HMAC(sha256, u).update(a)` 取**前 32 字节**；最后**以 derive 的 hex 字符串（不是 raw bytes）作为 key** 签 stringToSign。
3. **分隔符**：canonical 头行与 stringToSign 都是 **LF**；canonical 路径**强制尾斜杠**。

其余：region `'cn-southwest-2'`、service `'apic'`、scope `{yyyyMMdd}/{region}/{service}`；固定头 `x-subscription-type:'v2'`、`X-Sdk-Date`、`X-Security-Token`、`Host`；非 2xx / 网络异常返回空串（按「读不到」降级）。

⚠️ 区分两套签名：`fetchModelInfo` 用的是 **SDK-HMAC-SHA256**（华为云标准，canonical 路径尾斜杠、签名密钥是**裸 Secret 无 scope 派生**、头名小写排序、值 trim）。

### 端点与流程

- 订阅直读：`GET {defaultBaseUrl}/v1/subscription`（**打默认域**）；`skus[].quotas[]` 里 `sku_attr_code==='officeace_points'` 进 plan 桶（`sku_code` 以 `.trial` 结尾视为永久），`bonus_skus[]` 进 bonus 桶；`expiresAt` 缺席 = 真·永久桶；
- 每日福利：`POST {defaultBaseUrl}/v1/subscription/bonus/claim`（body 空），失败返回空数组**不抛错**；**按 ref 每小时节流**（多账号各自都要领，共用一把锁会让第二个账号领不到；当日 1000 分不领 23:59:59 就作废；进程内 Map 重启补领一次，幂等）；
- 查询顺序 `fetchOfficeAceBalanceDetailed`：**先自动领当日福利再云侧直读**（顺序不能反：先查就永远少显示那一份）；三条失败路径全部 `balance: null` + 原因，**绝不编造 0**；凭据由**入参显式指定**（多账号下「该读哪份」的猜测必错——来源踩过串号坑）。

### 分桶「永久/长期/临期」——前端算

`plugin-src/client/credit-expiry.js` 的 `splitCreditsByExpiry(packages, windowDays, now)`：无到期时间 → 永久（绿）；距现在 ≥ windowDays → 长期（黄）；< windowDays → 临期（红 + 最早到期倒计时）。`windowDays` 后端随余额下发（`CREDIT_EXPIRY_WINDOW_DAYS = 15`）。失效包（`active !== true`）与剩余 ≤ 0 不计入任何档。

### 永久积分锁定（per-provider）

`pool.setPermanentLocked(provider, locked)` / `permanentLocked(provider)`，解锁**删键**；端点 `GET|PATCH /api/permanent-lock?provider=…`（兼容旧前端的 `PATCH /api/loomy-lock`）；锁定语义：只消耗「有到期时间的桶」，永久桶不参与。前端 `PERMANENT_LOCK_PROVIDERS = ['loomy', 'officeace']`。

## 6. 账号判重（src/login/officeace-dedupe.ts）

- 判据：凭据里的 `accountId`（`fetchModelInfo` 从 `client-permission-validate` 响应的 `account_id` 写入，按账号稳定）；
- 读不到 accountId（老条目）**不判重**——宁可重复也不误判（把两个不同账号合成一个会直接丢账号）；
- 命中：**不建新条目，新凭据写回既有 ref**（refresh_token 一次性，旧那份已作废，不写回下次刷新必失败），`poll` 返回 `reused: true`；
- 前端提示讲清：华为授权页**不提供选账号**，直接用浏览器已登录的账号授权 ⇒ 加新账号必须在无痕窗口登**不同的华为账号**（用户看不到区别就会一直困惑「怎么每次都是同一个账号」）。

## 7. 不自动开窗（plugin-src/client/login-window-policy.js）

- `shouldAutoOpenLoginWindow(provider)`：`return provider !== 'officeace'`——仅 OfficeAce 不自动 `window.open`；
- 根因：华为授权页是 **SSO**，静默复用浏览器已登录账号，授权瞬间完成，用户连「选账号」界面都看不到；自动开窗等于替用户决定用哪个账号；
- 本项目（Web 服务，可能跑远程/无 GUI 机器）改为**只展示链接**让用户自己开 + `loginLinkHint` 三要素文案（无痕窗口/授权页不能选账号/「欢迎使用 OfficeAce」页 = 授权成功不是错误）；
- **轮询式授权跨机器成立**：code 由服务端轮询获取（不占本地端口、不依赖浏览器 cookie），授权在任意机器完成都会落账号；
- 前端收到 `failed === true` 时**停损并显示原因**（不再静默轮询）。

## 8. 手机号显示：OfficeAce 没有手机号可显示（2026-10-14 实测）

华为云 OAuth（scope 仅 `openid`）不下发手机号：`client-permission-validate` 只回 `account_id/principal_urn`；`/v1/subscription` 只回 `domain_id`；`/v1/claw/{user,user_info,account,profile}` 全部 404。故退一档显示 `accountId`（与登录日志同源）。别浪费时间去上游找手机号字段。

## 9. 本项目裁掉的来源能力（回移植时**不要**带回去）

| 来源能力 | 裁剪原因 |
|---|---|
| Windows 迁移桥（Redis 6399 / DPAPI / PowerShell 读凭据管理器） | 只对「装过 OfficeAce 客户端」的用户有意义且是兜底；迁移条目缺 DPoP 私钥不能刷新 |
| 本地 `127.0.0.1:3004` API（`GET /api/subscription/current`，自签 root-ca） | `oc_sid` cookie 是**全局单一账号**，多账号下所有卡片显示同一个账号的余额（来源实测两个账号都显示 6500） |
| 订阅磁盘缓存（`subscription-cache-<ref>.json`） | 缓存是第二个数据源：账号已删/凭据已换时显示**旧账号余额**，比报错更糟 |
| DSML 工具模式（`buildDsmlSystemPrompt`，开关 `OFFICEACE_DSML=1`） | 本项目走标准 `tools` 字段下发 |
| per-ref SerialQueue 续期三规则 | 由统一 `RefreshCoordinator` + `refresh-account.ts` 承担同等职责 |
| `fetchModelTokenRates`（倍率 `· x0.7`） | 本轮只做推理，倍率降级 |

回移植到 DSH 时的取舍：无痕窗口方案 DSH 侧已有（宿主 `openIncognitoWindow`，Chromium `--incognito --new-window`、Firefox `-private-window`，禁 `--app=`——被国产浏览器当域名解析；`NODE_ENV=test` 短路），**保留 DSH 形态**，但把本项目的 `loginLinkHint` 文案、failed 停损、30 分钟超时、两阶段错误分离、未开通 MaaS 文案带回去。

## 10. 集成点（本项目）

- **wiring.ts**（行 492-514）：`descriptorFor('officeace', …, { authKind:'custom', catalogSource:'static-only', supportsImages:true, rotatesAccounts:false })` + `new OfficeAceAdapter({resolveCredential, refresh, readImage})`；
- **login/orchestrator.ts**：`case 'officeace'` 调 `startOfficeAceLoginFlow`；**dedupe 钩子**（`src/index.ts` 注入 `findExistingOfficeAceAccount`）在所有落条目路径生效；
- **account-probe.ts**：officeace 分支（不传 accountPool、不传 refresh）；
- **admin/router.ts**：`/api/login/start|poll|cancel`；`/api/permanent-lock`；`GET /api/accounts`（credentialDisplay 退 accountId）；
- **admin/credits-endpoint.ts**：`credentialNeedsRefresh` 用 `isExpiring`（STS 寿命约 2 小时，10 分钟提前量）；逐账号 `resolveFreshCredential` → `fetchOfficeAceBalanceDetailed`。

## 11. 测试（tests/unit/）

`officeace-login.spec`（**两阶段错误分离**：换 token 失败立刻 reject 且 completeLogin 只调一次；轮询抖动容忍；超时；取消停摆）/ `officeace-dedupe.spec`（命中不建新条目 + 写回既有 ref）/ `officeace-credits.spec`（V11 签名三规则：GET 不带 Content-Type、hex-key 派生、POST 必带；订阅打默认域；先领福利再查；trial 不给 expiresAt）/ `officeace-refresh.spec`（DPoP 三段 JWT 真发出、返回轮换后 refreshToken、私钥保留、STS5.1806 终态）/ `officeace-base-url.spec`（**maasBaseUrlOf**：probe/推理都打账号专属 host）/ `officeace-adapter-image.spec`（多模态准入 + **max_tokens < 4096 丢弃**）/ `login-window-policy.spec` / `account-phone.spec` / `credits-endpoint-accio-officeace.spec` / `permanent-lock.spec`。

DSH 侧已有而本项目无：`officeace-expiry.spec`（余额折算判据）、`officeace-incognito-login.spec`（无痕窗口）、`officeace-refresh-guards.spec`（lead-time/串行/终态前重读）、`officeace-rpc-multi-account.spec`、`officeace-service-shape.spec`。

## 12. 回移植清单（DSH ← all_proxy）

来源 HEAD 已有 officeace 主体，回移植以**缺陷修复**为主：

1. **两阶段错误分离**（换 token 失败立刻 reject 带原文，不吞掉继续轮询）——来源 `login.poll` 的 officeace 代持分支要检查是否已把换 token 失败当终态；
2. **未开通 MaaS 的明确文案**（fetchModelInfo 抛错时讲清「未开通 + 怎么办」）+ **前端 failed 停损**（来源轮询 catch 静默继续）；
3. **超时三处对齐 30 分钟**（来源前端 deadline 5 分钟）+ `waitSeconds` 等待显示 + 链接无条件展示；
4. **cancelled 留痕**；
5. **`maasBaseUrlOf`**（若来源 adapter 还在用硬编码域——确认来源 HEAD 是否已修）；
6. **max_tokens < 4096 丢弃**；
7. **账号判重 + reused 提示**（来源 zcode 判重语义不同，officeace 按 accountId）；
8. **V11 积分**（来源已有但主路径是本地 3004 API——多账号串号；可参考本项目「云侧直读 + 每小时节流自动领福利 + 先领后查」的顺序）；
9. 裁剪项不带回（见 §9），除非 DSH 产品形态确实需要迁移桥。
