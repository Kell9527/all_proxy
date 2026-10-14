# AGENTS.md — all_proxy 开发约定

## 语言约束

- **推理输出**（thinking / reasoning）一律使用中文。
- **正文输出**（正文回复、代码注释、文档、提交信息）一律使用中文。
- 代码标识符、关键字、类型名称、变量名保持英文不变。

## 项目概述

`all_proxy` 把 **13 个 AI 平台**的账号聚合成一套标准 **OpenAI + Anthropic 兼容 API**，
并自带一个网页管理端。目标形态是**独立 HTTP 服务**，不依赖 DeepSeek Harness 运行时。

单进程同时提供：对外 API（`/v1/*`）、管理 API（`/api/*`）、管理端页面。

## 移植来源（重要）

本项目的协议实现**移植自** DSH 插件 `dsh-codearts-auth`，而非从零重写。

| 项 | 值 |
|---|---|
| 来源仓库 | `https://gitee.com/iJetLi/deepseek-harness-codearts` |
| 本地检出 | `D:\Project\go\token_proxy\deepseek-harness-codearts` |
| **移植基线 commit** | **`3611a62094293fa06650dde2415cb84694414e2c`**（`3611a62`，2026-09-28） |

⚠️ **来源仓库保持不动**：本项目是独立代码库，移植后自由演化。DSH profile 里安装的那份
（`~/.dsh/profiles/web/node_modules/dsh-codearts-auth`）是同一仓库构建出的 `lib/` 产物，
**不含 `src/`**，因此移植的事实来源始终是上表的本地检出。

### 分叉点（本项目故意偏离来源的行为）

移植时**不要**把下列行为「修回去」——它们是为独立服务刻意做的取舍：

| 项 | 来源（DSH 插件） | 本项目 | 原因 |
|---|---|---|---|
| 模型开关语义 | **仅目录过滤**：关闭的模型仍可被解析、仍能收发请求 | **硬拦截**：调用被关闭的模型返回 `404 model_not_found` 且不发上游请求 | 对外提供 API 时，调用方知道模型名就能绕过开关，开关将形同虚设 |
| 模型寻址 | 裸模型 id（provider 由适配器路由隐含） | **强制 provider 前缀** `<provider>/<model>` | 13 个 provider 之间重名严重（`deepseek-v4-flash`、`glm-5.2` 等多处重复） |
| 凭据存储 | `ctx.credentials`（`$DSH_HOME/.credentials.yaml`） | 自持 JSON 凭据文件（可读写、可自由刷新回写） | 规避与 DSH 两边同时刷新导致一次性 `refresh_token` 互相作废 |
| 目录门控 `providerCatalogVisible` | 用于隐藏无账号的 provider 分组 | **整体删除** | 它只影响 DSH 模型选择器的分组显示，不改路由；对外 API 无此概念 |
| 续期调度 | 由 DSH 插件生命周期驱动 | 由本服务自己的定时器驱动 | 无 DSH 运行时 |
| loomy / raccoon 账号轮换 | **无轮换**：选一次号、发一次请求，失败直接抛 | **请求级换号**（2026-09-29 用户要求）：额度耗尽（402/403 或 4xx+额度文案）→ 当天锁（`modelRateLimits` 标到 UTC+8 当日 24:00）+ 换号；429 → 短冷却（30s）+ 换号；401 刷新失败 → 弃用换号；Loomy 另按余额分档选号（`loomy-balance-selector`） | 用户报障「积分不足不切号」：排首位的 0 积分账号每次都被选中。Raccoon 判据对齐用户实测的 `xiaohuanxiong2api/raccoon-gateway.js`；换号带 `tried` 排除集，不臆造的部分（流中途错误不换号）保持来源行为 |

### 移植时**必须保持**的来源约定

这些是来源在真实故障中总结出的结论，移植时不得「顺手简化」：

1. **续期只看 `refreshable`，不看 `enabled`**。停用只影响自动选号，与凭据是否需要保持新鲜无关。
   按 `enabled` 过滤会让停用期间的 `refresh_token` 一路放到失效，用户重新启用后拿到的是死凭据。
2. **账号数组顺序即选号优先级**。不得重新引入「按限流重置时间重排候选」的 sort——
   那会让用户的手动排序形同虚设。
3. **`refresh_token` 一次性轮换的 provider（`codearts`、`trae`）必须立即回写新凭据**，
   否则该账号只能重新登录。只读探针**不得**触发刷新（会白白消耗掉 refresh token）。
4. **Qoder 的额度错误（业务码 `110`）必须归为不可重试**，不能落到可重试的 `SERVER`
   （会让「今日额度已用尽」这种确定性错误被白重试 5 次）。排队错误（`10605`）则要按服务端
   给的延迟等待后重试，两者语义完全不同。
5. **Qoder 的额度受限要自算「UTC+8 当日 24:00」**，不能用「1 小时后」兜底——额度按自然日结算。
   时区必须写死 UTC+8，不取本机时区（用户出差/改系统时区会算出错的解禁时刻）。
6. **上游错误体的嵌套深度不可假设**。用「先按某字段判门禁、再解析」的写法，一旦真实结构
   比预期深一层就静默失效；应让解析函数自己递归判定。
7. **`tools` 必须真的下发到请求体顶层**，且工具历史要保留 `tool_calls` / `tool_call_id`。
   Qoder 与 TRAE 都因漏发/丢失而让模型在正文里臆造 XML 工具调用，harness 认不出 → 任务终止。
8. **图片走 `messages[].content` 的多模态数组**，`chat_context.imageUrls` 是死的（客户端官方
   实现就恒置 `null`，是忠实复刻不是缺陷）。
9. **腾讯系模型的促销必须按 `schedule` 本地推算此刻是否生效**，不能只看 `enabled`；
   `factor: 0` 是「免费」而不是「已结束」。
10. **`credits` 与 `discountedCredits` 的 `x` 位置相反**（`"x0.29"` vs `"0.50x"`），
    解析必须同时认两种写法。
11. **一次性轮换 `refresh_token` 的 provider（`codearts`、`trae`、`raccoon`）应使用
    「共享凭据文件」**，而不是各自持副本。这三个 provider 的 refresh token 用一次即作废，
    多方各存一份会互相作废（用户报障「账号老是失效」的真因）。账号的 `credentialRef`
    可写成 `FILE:<绝对路径>`，此时凭据存于该外部文件：取用前**实时读**（不缓存）、
    刷新后**原子写回**、删除账号时**绝不删文件**。刷新还必须按凭据**单飞**
    （`src/pool/refresh-coordinator.ts`）——同账号并发刷新会让第二次拿着刚作废的
    token 去打。该能力做在**凭据存储层**，`src/providers/raccoon*.ts` 依旧零文件访问
    （`raccoon-client-independence.spec.ts` 锁死这条，勿在 provider 内加 `readFileSync`）。

### 已移植文件清单（基线 `3611a62`）

移植方式是**只改 import 行**（`@deepseek-ai/*` → 本地等价物），实现逐字保留。
脚本化执行：`node scripts/port-providers.mjs --group adapters|credentials`。
日后按基线 commit cherry-pick 时对照此表。

**本项目自有的（新写，非移植）**：

| 路径 | 作用 |
|---|---|
| `src/shared/llm.ts` | 本地 LLM 词汇表（替代 `@deepseek-ai/dsh-llm`） |
| `src/providers/llm.ts` | 上面那份的转发 shim（让移植文件的 `./llm.js` 可用） |
| `src/providers/credential-ref.ts` | `credentialRef` 的恒等实现 |
| `src/providers/cordis.ts` | cordis `Context`/`Service` 最小 shim（含最小服务容器） |
| `src/providers/account-pool.ts` | 转发 shim + `providerCatalogVisible` **恒放行** |
| `src/providers/settings-compat.ts` | DSH settings 兼容层的空实现 |
| `src/providers/{sse,openai-compat,message-shape,model-queue,sign,refresh}.ts` | 转发 shim → `src/shared/` |
| `src/pool/` | 账号池、凭据存储、状态文档（替代 `ctx.credentials` + `jet-hub-store`） |
| `src/pool/credential-ref-kind.ts` | 凭据引用形态解析：内置 ref 与 `FILE:<路径>` 共享凭据文件 |
| `src/pool/refresh-coordinator.ts` | 按凭据引用单飞的刷新互斥（一次性 refresh token 必需） |
| `src/refresh/refresh-account.ts` | 单账号续期的统一三步：锁内重读 → 刷新 → 立即回写 |
| `src/gateway/` | 对外 HTTP 端点、模型解析、错误映射、OpenAI / Anthropic 协议层 |
| `src/providers/registry.ts` | provider 注册表 + 模型寻址解析 |

**从来源移植的（`src/providers/` 下，脚本改写 import）**：约 60 个文件，
覆盖 10 个 provider 的协议、适配器、登录与积分（`buddy*` / `product` /
`lobsterai*` / `qoder*` / `trae*` / `cline*` / `loomy*` / `raccoon*` /
`llm-adapter` / `models` / `service` / `oauth` / `login` / `credits` /
`*credits` / `account-probe` / `backup` / `types`）。

**本项目自写的第 11 个 provider —— SenseNova（商汤开放平台，`token.sensenova.cn`）**：
与既有 10 个**不同类**，凭据是**静态 API Key**（一把 `sk-...`，无登录、无 refresh）。
文件：`sensenova-product.ts`（配置）/ `sensenova.ts`（凭据与纯函数）/
`sensenova-adapter.ts`（OpenAI 兼容 + **请求级换号**：正常钉住手动顺序的第一个账号，
命中 429（tpm/rpm 限流）写 **5 秒**冷却并换下一把；全部账号都在冷却时**不报错** ——
等到最早一把解禁继续轮询，直到成功或超出预算（默认 5 分钟）；配额类错误换号并锁到
UTC+8 当日 24:00）。
账号来源是**管理端粘贴 key**（`POST /api/accounts`，见 `src/admin/router.ts` 的
`STATIC_KEY_PROVIDERS`）或环境变量 `SENSENOVA_API_KEYS` 首次引导，故它**没有**
`*-oauth.ts` / `*-auth.ts`，也不在 `REFRESH_SUPPORTED_PROVIDERS` 里。

**第 12、13 个 provider —— OfficeAce（华为云 ModelArts MaaS）与 Accio（阿里 Accio Work）**
（2026-10-14 从来源 HEAD 移植，均超出移植基线 `3611a62`，故不走 `port-providers.mjs`）：

- **OfficeAce**（`officeace-product.ts` / `officeace-adapter.ts` / `officeace-auth.ts` /
  `officeace-login.ts`）：华为云 OAuth + PKCE + **DPoP** 登录，推理走
  `Authorization: Basic base64(app_key:app_secret)`；**OpenAI 兼容**（复用
  `shared/openai-compat.ts`）。两个必须记住的点：① **`maasBaseUrl` 必须优先用凭据里
  按账号下发的 host**（硬编码默认域会 401 `APIG.1009`）；② `max_tokens < 4096` 直接
  丢弃（否则思考链烧光预算、正文零产出）。**DPoP 私钥随凭据 JSON 落盘**（刷新必须
  同一把），refresh_token **一次性**（进 `ROTATING_REFRESH_PROVIDERS` + `RefreshCoordinator`）。
  裁掉了来源的 Windows 迁移桥（Redis 6399 / DPAPI / PowerShell）与 V11 签名
  （余额/倍率，故 `credits-capabilities.js` 登记为无积分能力）。
- **Accio**（`accio-product.ts` / `accio.ts` / `accio-oauth.ts` / `accio-messages.ts` /
  `accio-adapter.ts` / `accio-auth.ts` / `accio-login.ts`）：标准 OAuth 2.0 + **PKCE**
  （回调落本项目自己的 loopback），推理是 **Gemini 族协议**（复用 `gemini-messages.ts`
  的 `consumeGeminiSse` + 一层薄归一化）。四个必须记住的点：① **`token` 必须在请求
  body**（放 Authorization 头恒流内 402）；② **`system_instruction` 必须是字符串**
  （对象形态恒 HTTP 200 + 流内 400）；③ **对外 id 是「人话」slug、上行须反查上游
  `modelCode`**（漏映射症状是「模型不回复」这种误导性形态）；④ **HTTP 200 也可能是
  风控拦截页**（必须校验 `content-type: text/event-stream`）。refresh_token **轮换**
  （同样进 `ROTATING_REFRESH_PROVIDERS`）。图片通路未实测 ⇒ `inputModalities` 恒省略、
  收到图片显式 `UNSUPPORTED_CONTENT`。

**测试**：来源 `tests/unit/` 的 84 个文件经 `scripts/port-tests.mjs` 移植，
加上本项目自写的（`llm` / `account-pool` / `gateway` / `divergence-gating` /
`sensenova*` / `officeace*` / `accio*` / `trae-cooldown-table` / `serial-queue` /
`expiry-sync`）。当前 **128 个文件 3139 条用例**（2026-10-14 实测；其中
`buddy-oauth.spec.ts` 有 1 条**时间相关的既有用例**失败 —— 其促销 fixture 的
`validUntil` 为 `2026-10-11`，已过期，与本项目改动无关）。

**未移植的测试**（来源里依赖 DSH 服务容器或断言 DSH 源码结构，本项目无对应物）：
`plugin.spec` / `jet-hub-rpc.spec` / `jet-hub-store.spec` / `backup.spec` /
各 `*-wiring.spec` / 各 `*-rpc-dispatch.spec` / `account-probe-adapter.spec` /
`session-replay.spec` / `smoke.spec` / `cline-icon.spec` / `loomy-docs.spec` /
`raccoon-nickname*.spec`。

## 目录结构

```
all_proxy/
├── src/                    后端 TypeScript 源码
│   ├── index.ts            入口（CLI 与 serve 组装）
│   ├── gateway/            对外 HTTP 端点（OpenAI / Anthropic 协议、静态托管）
│   ├── providers/          13 个 provider 的适配层
│   ├── pool/               账号池与凭据存储
│   ├── auth/               API Key 存储与入站鉴权
│   ├── admin/              管理 API 与管理端鉴权
│   ├── login/              登录编排（两步式会话、落账号条目）
│   ├── usage/              用量记录（SQLite）与运行日志
│   ├── refresh/            provider 级续期接线
│   └── shared/             零依赖纯工具（从来源移植）
├── web/                    管理端（Vite + React，复用 Jet Hub 界面）
├── plugin-src/client/      Jet Hub 界面源码（web 打包时直接引用）
├── tests/unit/             单元测试
├── scripts/                构建辅助脚本（复制 WASM 等）
├── data/                   运行时数据（已 gitignore，含凭据，绝不提交）
└── openspec/               规格与变更提案
```

## 新增一个 provider 的步骤

**同族产品**（与既有 provider 共用协议实现，如 `qodercn` 之于 `qoder`）：

1. 在对应 `*-product.ts` 里新增一份产品常量（基地址、client id 等差异项）；
2. 在 `src/providers/wiring.ts` 的 `registerAllProviders` 里加一段
   `registry.register(descriptorFor(...), new 同族Adapter({ product: 新常量, ... }))`；
3. 在 `src/pool/dsh-import.ts` 的 `ACCOUNT_REF_RE` 与 `PROVIDER_BY_REF_PREFIX` 补凭据 ref 前缀；
4. 测试：`tests/unit/provider-wiring.spec.ts` 的 `EXPECTED` 清单 + 目录可列出测试。

**新协议族**（来源仓库有对应实现，如新增一个全新平台）：

1. 从来源检出复制协议文件（`*-product.ts` / `*-adapter.ts` / `*-auth.ts` /
   `*-oauth.ts` / `*-credits.ts`），只改 `@deepseek-ai/*` 导入行为本地等价物；
2. 在 `src/providers/wiring.ts` 注册（authKind / catalogSource / rotatesAccounts
   按实际如实登记，没有轮换就写 `rotatesAccounts: false`，不要臆造）；
3. 管理端：`plugin-src/client/jet-hub.js` 的 `PROVIDERS` 加图标与条目；
4. 登录编排：在 `src/login/orchestrator.ts` 的 `startUrlFlow` 或 SMS 通道加分支；
5. 如有静默续期，在 `src/refresh/provider-refresher.ts` 接线刷新函数。

**静态 API Key provider**（如 `sensenova`；上游直接给一把 `sk-...`，无登录）：

1. 新建 `*-product.ts`（基地址、chat 路径、兜底模型表、引导环境变量名）与
   `*.ts`（凭据类型 + 解析/脱敏纯函数）；
2. 新建 `*-adapter.ts`：OpenAI 兼容时复用 `shared/openai-compat.ts`；换号走
   `AccountPool.getAvailableAccount(exclude)`（429 → 短冷却标记 + 换号；全部冷却
   时可等到最早解禁继续轮询，见 `sensenova-adapter.ts`）；
3. `wiring.ts` 注册（`refresh: async () => {}`，静态 key 无续期）；
   **不要**登记 `REFRESH_SUPPORTED_PROVIDERS`（那会让定时任务对一个不存在的
   端点发请求），账号一律 `refreshable: false`；
4. 管理端新增账号：把 provider 加进 `src/admin/router.ts` 的
   `STATIC_KEY_PROVIDERS`，前端 `supportsStaticKey()` 才会渲染「粘贴 API Key」按钮；
5. **凭据字段必须写 `access_token`**（值是 key）——`findAccountIdByCredential`
   对非 codearts 一律取该字段，改字段名会让账号永远登记不上（换号/限流/用量全失效）；
6. `account-probe.ts` 的探测分派表补该 provider（否则「重测」会落到 CodeArts 签名分支）；
7. `dsh-import.ts` 的 `ACCOUNT_REF_RE` / `PROVIDER_BY_REF_PREFIX` 补前缀（自建 ref 才可识别）。

## 开发命令

```bash
npm install          # 本机 pnpm 会崩溃，见下
npm run typecheck    # 类型检查
npm test             # 单元测试
npm run build        # 编译到 dist/
npm start            # 运行
npm run dev          # 开发态（tsx watch）
```

### ⚠️ 本机安装与运行注意事项

- **pnpm 在本机会以 `tokio worker stack overflow` 崩溃**，故本项目用 **npm** 安装。
- npm 默认缓存目录在用户 `AppData` 下，可能被文件沙箱拒绝写入，故 `.npmrc` 把缓存
  指向仓库内的 `.npm-cache/`（已 gitignore）。
- 若安装报 `EPERM ... spawn`，加 `--ignore-scripts`（本项目依赖无原生编译步骤）。
- **`npx vitest run` 需要放开沙箱权限**：vitest 经 vite 调用 esbuild，而 esbuild 会
  以 **piped stdio 启动子进程**，在受限文件沙箱下被命名管道限制拒绝，报
  `EPERM: spawn EPERM`（即使 `esbuild.transformSync` 也一样失败）。这是**环境边界
  而非代码缺陷** —— 遇到时以放宽权限的方式运行测试，不要试图改写测试框架绕开。
  （已验证：放开权限后 4 个测试文件 55 条用例全部通过。）
- **`tsc` 与 `node` 不受该限制**（纯进程内工作），故 `npm run build` / `npm run typecheck`
  在默认沙箱下即可正常运行。

## 技术栈与约束

- **Node.js**：`>=22.5`（`node:sqlite` 需要；本机 24.9.0 实测可用）。
- **TypeScript**：`strict`，`module: NodeNext`。**刻意不开 `noUncheckedIndexedAccess`** ——
  来源仓库也没开，而本项目的移植策略是「只改 import 行」，开它会让每个移植文件都要
  逐处补类型断言，既增加改动面、也让日后按基线 commit cherry-pick 时处处冲突。
  代价是索引访问不强制判空；已知取舍，接受。
- **测试**：Vitest。`tests/unit/**/*.spec.ts`。
- **依赖**：运行时仅 `jose`（CodeArts DPoP 登录）；**刻意不引入** `better-sqlite3` 等
  需要原生编译的依赖，用量库用 Node 内置 `node:sqlite`。
- **Qoder WASM**：`qoder-auth-wasm.wasm`（约 298 KB）必须与编译产物同目录，
  由构建脚本复制；启动时自检存在性。

## 数据与安全

- `data/` 含账号凭据（refresh token 等同账号凭证）、API Key 与用量库：**绝不提交、绝不外泄**。
- 日志与错误响应中**不得**出现凭据、refresh token、API Key 明文。
- 管理端默认只监听 `127.0.0.1`；改为对外监听时必须强制设置管理凭据。
- 导入 DSH 数据是**只读**的：永不写回 `.credentials.yaml` 或 `jet-hub/state.json`。

## 已知限制

- **Loomy 没有 refresh 端点**：token 过期只能重新登录（故主路径用手机号验证码，成本低）。
- **`codearts` / `trae` 的 refresh token 一次性轮换**：从 DSH 导入后，建议只让一边刷新，
  否则两边会互相作废。
- **Raccoon 每日 300 积分的「当日登录」触发端点已确证为 `GET /api/web/office/v3/setting_info`**
  （2026-10-11 跨日对照实验）：每日积分由服务端自动发放（账单 `biz_type: 'daily_grant'`，
  **没有签到端点**），但不登录就**当天 24:00 清零**，只有「当日登录」才延长到 7 天
  （官方文案 `dailyGrantRule` 原文如此）。判定依据是账单里 `daily_grant.created_at`：
  整点 `00:00:00` = 未延长，真实时刻 = 已延长。三条实测结论：
  - ✅ **`setting_info` 触发延长**（实验组只调它 → 记录从无到有、`created_at` 为真实时刻）；
  - ❌ **读 `/bills` 不触发**（对照组只读账单状态始终不变；另有一轮带鉴权反复读 14 分钟的反证）；
  - ❌ **续期不算登录**（`/auth/v1/refresh` 不带 `Authorization` 头；实证 10-05~07 三天每小时都在续期，积分照样当天清零）。
  ⚠️ 当天的 `daily_grant` 记录**并非 00:00 就存在**，而是「当天首次登录态动作」时才由服务端创建
  —— 故「今天尚无记录」是干净初始态，不是「服务端还没发放」。
  实现见 `keepAliveRaccoonDailyPoints`（候选链 `setting_info` → `balance`，按账单前后对比自验证）；
  实验脚本 `scripts/probe-raccoon-daily-extension.mjs`，结果存档
  `data/logs/raccoon-daily-extension-probe.json`。面板按钮「保活今日积分」供
  「半夜电脑没开机」的用户次日手动补一次。
- **`node:sqlite` 是 experimental**：启动时会打印警告，属预期。
- **来源与本项目会逐渐分叉**：来源的缺陷修复不会自动同步；需要时按上表基线 commit
  对照 cherry-pick。

## 工作方式

- 规格与变更提案在 `openspec/`，实现前先读对应 change 的 `proposal.md` / `design.md` / `tasks.md`。
- 每完成一个任务就更新 `tasks.md` 的复选框。
- 实现与规格冲突时**先停下来说明**，不要静默缩小或延后规格中已写明的要求。
