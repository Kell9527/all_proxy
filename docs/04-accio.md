# 04 · Accio（阿里 Accio Work）账号管理 —— 实现步骤与回移植指南

> 平台：阿里 Accio Work。网关 `https://phoenix-gw.alibaba.com`（两区域恒同一个）；
> 登录域 `cn → https://www.accio-ai.com`、`global → https://zh.accio.com`。
> 公开客户端 `client_id='accio-work'`（无 secret）。推理协议是 **Gemini 族**。
>
> 写作时点：2026-10-14。**Accio 是 2026-10-14 从来源 HEAD（`1080923`）移植的，超出基线
> `3611a62`**——来源已有此 provider（含 935 行逆向笔记 `docs/agent-notes/providers-accio.md`），
> 回移植方向是**差异合并**。

## 1. 文件清单（本项目 `src/providers/`，8 文件 2772 行；来源 7 文件 4054 行）

| 文件 | 行数 | 职责 | 与来源 diff |
|---|---|---|---|
| `accio-product.ts` | 144 | 端点路径、超时、区域→登录域映射、兜底模型表（15 条） | **逐字节一致** |
| `accio.ts` | 211 | 凭据结构与纯函数（`buildAccioBody`、`accioToSnake`、`accioHeaders`） | **逐字节一致** |
| `accio-oauth.ts` | 217 | OAuth+PKCE 登录/续期网络层 | **逐字节一致** |
| `accio-messages.ts` | 507 | SSE 帧归一化（Gemini 族薄适配）+ 工具分片合并 | 仅 import 落点 |
| `accio-credits.ts` | 620 | 三积分端点聚合 | 仅 import 落点 |
| `accio-auth.ts` | 178 | 目录解析与凭据纯函数 | 来源是 1007 行 cordis Service，本项目大幅裁剪 |
| `accio-login.ts` | 155 | loopback 回调编排 | **本项目独有**（从来源 accio-auth 拆出） |
| `accio-adapter.ts` | 740 | LLM 适配器 | 裁剪 + 重构（协议层逐字保留） |

## 2. 登录链路：OAuth 2.0 + PKCE + 自有 loopback

- PKCE：`code_verifier` = **48 随机字节** base64url（对齐官方客户端），`challenge = base64url(SHA-256(verifier))`，方法恒 **S256**；`state` = 32 字节 hex；
- 授权 URL：`{loginBase}/login?return_url=&state=&code_challenge=&code_challenge_method=S256&client_id=accio-work&ttid=ttid_{16字节hex}&language=zh`——**Accio 对 `return_url` 无白名单校验**，可以完全脱离 IDE 用自己的 loopback；
- 回调：`server.listen(0, '127.0.0.1')` **随机端口**，`redirectUri = http://127.0.0.1:{port}/auth/callback`；**先监听拿端口再拼授权 URL**；
- 兑换：`POST {gateway}/api/oauth/token`，JSON body `{code, codeVerifier, clientId, redirectUri}`，信封 `{success, code, message, data}` → `data.accessToken/refreshToken/expiresAt/sgcookie`；
- ⚠️ **`expiresAt` 上游是秒**，归一成毫秒只在 `accio-oauth.ts` 的 `toTokenResult` 做一次；忘了 ×1000 ⇒ 凭据被判「1970 年过期」⇒ 每请求都续期 ⇒ 并发消费 refresh_token ⇒ `invalid_grant` ⇒ 账号标死；
- 成功时凭据 JSON 写入 `{access_token, refresh_token, expires_at, sgcookie?, region}`——**region 写进凭据**，续期/推理按它选登录域（gateway 恒同一个，region 不参与 URL）；
- ⚠️ **打开浏览器绝不能用 `cmd /c start`**：cmd.exe 把 URL 里的 `&` 当命令分隔符，URL 在第一个 `&` 处截断（`code_challenge` 丢失 → 登录页 legacy 门禁弹「请升级客户端」），还会弹文件管理器。必须 `rundll32 url.dll,FileProtocolHandler`（Windows）；`execFile` 空回调是 error 事件消费者**不能删**。有源码级防回退测试。

### region 透传链（两层归一都要移植）

前端 radio（cn/global，默认 cn）→ `account.create {provider, region}` → `POST /api/login/start` → `orchestrator.start(provider, method, {region})` → 两层归一：

1. orchestrator：`flowOptions.region === 'global' ? 'global' : 'cn'`（缺省与非法值都归 cn，不报错不臆造）；
2. `normalizeAccioRegion(raw)`（accio-auth.ts）：`ACCIO_REGIONS.includes(raw) ? raw : 'cn'`（来源此函数还会在未识别时 warn 留痕）。

⚠️ `userinfo.routeRegion`（服务端按账号下发，实测 `CN`）与登录时选的区域**是两回事**。

### 本项目实现的已知缺口（回移植时补上）

本项目 `accio-login.ts` **没有 state 校验**（只取 code/error）；来源 `startLoginFlow` 校验 state 原样匹配（防本地进程伪造回调）并区分 error/缺 code 三种失败页。**回移植时恢复 state 校验。**

## 3. 推理协议（Gemini 族）五大坑位（必须原样移植）

端点：`POST {gateway}/api/adk/llm/generateContent?sg_k={md5(requestId)}`；
请求头：`Content-Type: application/json`、`Accept: text/event-stream`、`utdid`、`version: '0.34.4'`、`appKey: 'OneChat'`、（有则带）`sgcookie`——**不需要 SecurityGuard 签名**（不带 `pctb-x-*` 同样 200，参考实现把它当必需是过度依赖）。

**① token 必须在请求 body**。放 Authorization 头 ⇒ 恒 `HTTP 200` + 流内 `{"turn_complete":true,"error_code":"402","error_message":"unauthorized"}`。401/403 刷新重试后**必须把新 token 写回 body**。流内 `'402'`（字符串或数字）⇒ 抛 `QUOTA_EXCEEDED`；**字面量必须是 `'QUOTA_EXCEEDED'` 而非 harness 常量 `'QUOTA'`**——DSH 客户端对 `QUOTA`/`ACCOUNT_QUOTA`/`AUTH` 三码会丢弃适配器 message 换固定文案，上游原文到不了用户眼前。

**② `system_instruction` 必须是字符串**。对象形态 `{parts:[{text}]}` 恒 HTTP 200 + 流内 `{"error_code":"400","error_message":"Invalid request format"}`。权威证据是官方 proto 的 `globalThis.String(e.systemInstruction)`。空串时不产出该键。

**③ 对外 id 是「人话」slug、上行须反查上游 `modelCode`**。上游 `modelCode` 形如 `1Drift-F8hS3mK7pL2n`（非人类可读）；对外 id = `normalizeNameKey(model.name)`（剥倍率后缀、小写、空格/`.`→`-`），如 `Qwen 3.8 Flash → qwen-3-8-flash`。**没有静态映射表**——靠远端目录（失败回退兜底表）里 `find(m => accioModelIdOf(m) === slug)` 反查；查不到原样返回。**漏映射症状是「模型不回复」**（不是参数错误）。目录动态拉取：`POST /api/llm/config/v2`，token 在 body，解析 `data[].modelList[]`，`visible !== true` 剔除。

**④ HTTP 200 也可能是风控拦截页**。必须校验 `content-type` 含 `text/event-stream`；不是则显式抛 SERVER 错误并带 content-type 与前 200 字节原文——不校验会把 HTML 拦截页喂给 SSE 解析器，报「模型未返回任何内容块」，真因（风控）被掩盖。

**⑤ 图片通路未实测**。`inputModalities` 恒省略（三态里的「未知」，写 `['text']` 是把未知写成明确不支持）；收到图片显式抛 `UNSUPPORTED_CONTENT`。

### body 构造细节（`buildAccioBody`）

- `empid`/`tenant`/`iai_tag` **恒空串**（真实值会被拒）；
- `message_id` **必填**（缺它上游 400；md5 hex 掺随机量防同 requestId 去重）；
- `incremental: true`；`stop_sequences: []`；
- `properties: {utdid, version, appKey, normalized_response:'true'}`——**该子树刻意不参与 snake 转换**（appKey 保持驼峰、normalized_response 是 snake，混用是实测形状）；
- 整体经 `accioToSnake` 递归转 snake_case（会丢 undefined 键）。

### 帧归一化（accio-messages.ts，「薄」在哪）

Accio 帧与标准 Gemini 帧的差异：帧 `{content:{parts}, usage_metadata, partial}` 在**顶层**（标准是 `candidates:[{content}]`）；工具是 `function_call.args_json`（字符串，snake）而非 `functionCall.args`（对象）。

`normalizeAccioFrame` 做：顶层 content 包成 `candidates[0].content`；usage snake→camel；`args_json` 字符串解析成对象、**无名调用整块丢弃**（产出无名调用会 400）；**「无 content ≠ 无用帧」**（2026-10-13 真实缺陷「思考一下就中断」的根因：顶层 `function_call` 无信封、终帧 `usage_metadata`/`finish_reason` 必须保住，否则 MAX_TOKENS 截断被伪装成正常 stop、usage 恒归零）。

`consumeAccioSse` 用 `TransformStream` 改写后交给 `consumeGeminiSse`。五条纪律：非 `data:` 行与 `[DONE]` 原样透传；归一化返回 undefined 的帧整帧丢弃；错误帧**先攒后抛**（同一 chunk 已攒的正常帧先 enqueue 完再抛）；结束时 flush 解码器且**尾行必须走同一条归一化路径**（上游流以终帧收尾、没有 `[DONE]`）。

`isAccioErrorFrame`：对象且带非空 `error_code`/`error_message`；**`error_code === '200'` 是成功哨兵必须先判**（实测正常帧也带）。

### 工具调用分片合并（accio-adapter.ts）

上游把一次调用拆成多帧（首帧 `{id,name}` 无参数，后续帧补 `args_json`）。`accioToolCallMergeTransform`：只缓冲工具调用 part；按 `id` 分组（无 id 用 `anon-N`）；`mergeAccioToolArgs` 处理累积式（后一份是前一份前缀 ⇒ 取最后一份）与增量式（拼接）两种形态；吸收帧的终帧元数据合并时 **usage 取 total 更大者**。请求侧 `toAccioTools` 产出**扁平形态** `{name, description, parametersJson}`——`parametersJson` 必须是 `JSON.stringify` 的字符串（`accioToSnake` 不下钻字符串，工具参数名是数据不是协议字段，改成对象会被递归 snake 化静默改写）。

## 4. 积分（accio-credits.ts）：三个端点传参方式各不相同

| 端点 | 方法 | token 位置 |
|---|---|---|
| `/api/auth/userinfo` | **POST** | **body**（`{accessToken}`） |
| `/api/entitlement/currentSubscription` | **GET** | **query**（`?accessToken=…`） |
| `/api/entitlement/quota` | **GET** | **query** |

用错即 405/400。**method 与 token 位置由同一个 `method` 参数决定**（调用点无法只改一处漏另一处）——刻意维持的形状，不要为「统一好看」收成公共形状。

- **`code` 可能是数字**：`readScalarString` 接受字符串或有限数字。判未登录的判据：`code` 为 `401`/`NOT_LOGIN`（大小写不敏感）或 HTTP 401/403 或 `message === 'NOT_LOGIN'`。只认字符串会把上游发 `code: 401`（数字）读成空串 ⇒ 误诊「查询失败」而真相是「未登录」——方向性误诊。官方客户端写的就是 `String(e.code) === '401'`。未登录实测形态是 **HTTP 200 + body `{success:false, code:'401', message:'NOT_LOGIN'}`**；
- 只发 `Accept` 头（POST 另加 Content-Type），不带推理端的 appKey/version/utdid；
- **失败语义：`balance: null` 表达查不到，绝不编造 0**（0 = 已用光）；
- 聚合顺序 `fetchAccioBalanceDetailed`：`currentSubscription`（必需，第一个发，未登录短路）→ 形状判据（既无桶也无 `data.remaining` 短路）→ `quota` + `userinfo` **并行**；总余额优先服务端自己算的 `data.remaining`；
- 三类桶 `daily/monthly/referral`（固定顺序不随响应键序漂移；值 0 保留、缺席不产出、remaining 读不到跳过）；`refreshCountdownSeconds` 现算成 ISO 落 daily 桶 `cycleEndTime`；
- `maskedMobile`（上游脱敏，实测 `+86 186****6665`）原样呈现到账号卡片（不臆造完整号）；`userLevel` → `extra.accountTier`，未登记的等级**原样展示**、查表用 Map 不用对象下标（防 `obj['constructor']` 命中原型链）；
- 只读无签到（每日积分由**登录**触发服务端发放，`dailyCheckin: false` 如实登记）；
- 前端命名池口径：三桶是**不同类型**额度不参与 officeace 式三档分桶，`每日 100 · 每月 0 · 推荐 700`；daily 桶倒计时不写死 86400。

## 5. refresh_token 轮换

- `ROTATING_REFRESH_PROVIDERS` 含 accio（依据参考实现「刷新会轮换」的记录；本项目尚未实测该端点）；
- 续期：`POST {gateway}/api/auth/refresh_token`，body `{accessToken, refreshToken}`；
- **串行保证**（三条入口：定时器/推理按需/面板按钮并发消费同一份 refresh_token，不串行必然「1 成功、其余 invalid_grant」）：本项目走统一 `RefreshCoordinator` 单飞 + 锁内重读；来源走 per-ref `SerialQueue`——回移植用 DSH 侧已有机制即可；
- **终态判据必须窄**（`ACCIO_TERMINAL_REFRESH_MARKERS`）：只认指向 refresh_token 本身的 `invalid_grant` / `invalid refresh token` / `refresh token has been used` / `refresh token expired` / `NOT_LOGIN` 等；`unauthorized`/`403` 这类泛化词**不在**此列（网关抖动/风控都可能回，判终态会把材料完好的账号标死）；
- 续期返回保留无变化字段（region/user_id/accio_id/nickname），region 缺失回退 `'cn'`。

## 6. 与来源的架构差异（回移植对照）

| 方面 | 本项目 | 来源（DSH） | 回移植动作 |
|---|---|---|---|
| 协议纯文件 | `accio-product/accio/accio-oauth` 与来源逐字节一致；`accio-messages/accio-credits` 仅 import 落点 | — | **不用动**（来源已是最新） |
| `accio-auth.ts` | 只留纯函数（178 行） | 1007 行 cordis Service（含 `startLoginFlow`、SerialQueue、`syncAccountExpiry`、终态告警去重） | 这些逻辑**还原成 Service 形态**，本项目版不覆盖 |
| `accio-login.ts` | 本项目独有（loopback 编排） | 并在 accio-auth 的 `startLoginFlow` | **恢复 state 校验**（本项目没有） |
| adapter 目录 | 文件内缓存 + 兜底表（与 officeace/raccoon 同形） | `createModelCatalog` + `RemoteCatalogGate` + `broadcastCatalogChanged` / `registerAccioLlm` / `reportLedgerAccount` / `planSessionTitleThinking` | 目录骨架换回来源形态；**协议层（stream 五步、合并层、错误码映射）两边逐字相同** |
| region 归一 | orchestrator 静默归 cn | `normalizeAccioRegion` 未识别时 warn 留痕 | 保留 DSH 的 warn 行为 |

来源另有本项目没有的：`accio-wiring.spec`（index.ts 六处接线守护）、4 个 e2e 真机探针（双闸门 `DSH_ACCIO_CHAT_E2E=1` + `CONFIRM=yes`）、935 行逆向笔记 `docs/agent-notes/providers-accio.md`（§0~§10 含未验证项清单）——回移植时以它为事实来源。

## 7. 集成点（本项目）

- **wiring.ts**（行 514-541）：`descriptorFor('accio', ACCIO.displayName, ACCIO.gatewayBaseUrl, { authKind:'custom', catalogSource:'remote-first', supportsImages:false, rotatesAccounts:false })`；`resolveCredential` **透传 modelId**（空串会让限流过滤整体短路）；`fetchRemoteModels` 走三级目录缓存（内存 → 磁盘快照 `data/catalogs/accio.json` → 兜底表，失败冷却 10 分钟）；
- **login/orchestrator.ts**：`case 'accio'` region 归一后 `startAccioLoginFlow({fetcher, region})`；
- **account-probe.ts**：accio 分支（不传 accountPool / fetchRemoteModels）；
- **admin/account-phone.ts**：`fetchAccioUserInfo` → `maskedMobile` 原样呈现，只内存缓存绝不写回凭据；
- **dsh-import.ts**：`ACCIO` 前缀映射（`ACCIO_ACCOUNT_{HEX6+}`）+ `ACCIO_ACCESS_TOKEN` 单凭据回退白名单 + ROTATING_REFRESH_PROVIDERS。

## 8. 测试（tests/unit/）

`accio-product.spec`（**expiresAt 秒 ×1000**、buildAccioBody 硬约束、properties 混用键形）/ `accio-oauth.spec`（PKCE、**防回退锁：必须 rundll32 不得 cmd+start**）/ `accio-messages.spec`（851 行：归一化、**402 抛额度错误**、**200 成功哨兵**、无 [DONE] 尾行归一化、错误帧不被合并层吸收、MAX_TOKENS 不伪装 stop）/ `accio-adapter.spec`（**slug↔modelCode 映射**、**200+HTML 风控页显式报错**、401 刷新后新 token 写回 body）/ `accio-credits.spec`（userinfo POST+body、quota GET+query、**数字 code 标量归一**、null 不编造 0）/ `credits-endpoint-accio-officeace.spec`。

## 9. 回移植清单（DSH ← all_proxy）

来源 HEAD 已有 accio 且**协议层与本项目逐字相同**，回移植实际要做的：

1. **确认来源侧五大坑位无回归**（① token 在 body ② system_instruction 字符串 ③ slug 反查 modelCode ④ 200 风控页校验 ⑤ 图片 UNSUPPORTED_CONTENT）——本项目测试用例可作回归清单；
2. **无**本项目独有增强需要带回（accio-login 的 state 校验反而是本项目缺的，方向是**从来源带回本项目**）；
3. 若 DSH 侧将来加多账号轮换：注意本项目 `resolveCredential` 透传 modelId 的教训（空串短路限流过滤）。
