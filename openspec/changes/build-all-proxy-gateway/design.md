# Design

## Context

参见 `proposal.md` 的 Why。以下是影响技术方案的现状与约束。

**来源仓库**：`D:\Project\go\token_proxy\deepseek-harness-codearts` 是 gitee `origin` 的本地检出（`master` @ `3611a62`），含完整 `src/`（TypeScript）。DSH profile 里装的那份（`~/.dsh/profiles/web/node_modules/dsh-codearts-auth`）是从同一 gitee 仓库拉取后构建的 `lib/` 产物（306 个文件），**不含 `src/`**。因此移植的事实来源是本地检出。

**待移植代码的实际耦合面**（已逐文件核实）：8 个 adapter 文件各自 `import` 自 `@deepseek-ai/*` 的只有 6 个值符号（`LlmAdapter`、`LlmError`、`ToolCallId`、`attributionHeaders`、`ReasoningEffortId`、`CONTEXT_WINDOW_EXCEEDED_CODE`/`isContextWindowExceededError`）加若干纯类型；另传递依赖 3 个本地模块（`account-pool`、`settings-compat`，以及 `providerCatalogVisible` 门控）。`LlmAdapter` 基类只有 6 个方法，`LlmError` 只需 code + message。以下文件**零 DSH 依赖、可近乎逐字节复制**：`message-shape.ts`、`model-queue.ts`、`sign.ts`、`refresh.ts`，以及全部 `*-product.ts` / `*-credits.ts` / `*-oauth.ts` / `*-auth.ts` / `*-errors.ts` / `buddy.ts` / `qoder.ts` / `trae.ts` / `loomy*.ts` / `raccoon*.ts` / `oauth.ts` / `models.ts` / `login.ts`。`openai-compat.ts` 与 `sse.ts` 各只需替换 1 处 DSH 导入。

**协议分布**：10 个 provider 中 7 个上游已是 OpenAI 兼容（`codearts`、`buddy`、`workbuddy`、`lobsterai`、`cline`、`loomy`、`raccoon`），仅需 URL 与鉴权头改写；`qoder`/`qodercn` 需 WASM 加密请求体 + 响应信封剥离；`trae` 需 SOLO 请求体与 SOLO SSE 全量转换。**没有任何一个上游是 Anthropic 原生的**——Anthropic 兼容必须由本服务翻译。

**运行环境**：Node `v24.9.0`、pnpm `12.4.1`、npm `11.6.0`、git `2.45.1`。实测 `node:sqlite` 在本机**无需显式 flag** 即可用（`DatabaseSync` 正常，仅有 experimental 警告），故用量库不需要原生编译依赖。

**已有数据**：`C:\Users\pan\.dsh\.credentials.yaml`（v1 布局，`refs:` 下已有 10 个 provider 共 14 个账号的凭据，含 TRAE 的 `machine_id`/`device_id`、Qoder 的 `security_oauth_token`）；`C:\Users\pan\.dsh\jet-hub\state.json`（14 条账号条目，顺序即优先级；以及 6 个 provider 的 `disabledModels` 黑名单）。两者均为只读导入源。

**来源中的既有约定（必须保持）**：续期只看 `refreshable` 不看 `enabled`；账号顺序即优先级且不得按限流重置时间重排；`providerCatalogVisible` 只影响 DSH 目录门控、不改路由（在独立服务中可整体删除）；Qoder 额度错误需自算 UTC+8 当日 24:00；`refresh_token` 一次性轮换的 provider 必须立即回写。

## Goals / Non-Goals

**Goals：**

- 用一份 Node + TypeScript 代码库同时提供：对外 API（OpenAI + Anthropic）、10 个 provider 的聚合路由、网页管理端。
- 最大化复用来源仓库的协议知识，把移植成本压在「替换 DSH 词汇」这一层，不重新推导协议。
- 让模型开关、API Key、账号池三者的状态都可在网页上管理并立即生效。
- 单进程部署：一条命令起服务，管理端同源，无跨域与反代配置。

**Non-Goals：**

- 不修改、不重建、不替换 `deepseek-harness-codearts` 插件；它继续在 DSH 里独立工作。
- 不替换现有的 `xiaohuanxiong2api` 与 `loomy/loomy-gateway`（可并存）。
- 不做跨 provider 的自动降级链（已明确排除，见 Decisions）。
- 不引入数据库服务（不装 Postgres/Redis）、不做多租户、不做计费结算。
- 不追求与 DSH 的模型目录、会话、工具调用语义完全等价——对外只保证 OpenAI/Anthropic 协议层面正确。

## Decisions

### D1：移植而非 shim，而非重写

**选择**：把插件的 TypeScript 源码复制进 `all_proxy`，替换掉 DSH 专有词汇（`LlmAdapter` 基类 → 本地抽象类；`LlmError` → 本地错误类；`ctx.credentials` → 本地凭据存储；`ctx.llm` 注册 → 本地 provider 注册表）。

**理由**：耦合面已核实极小（6 个值符号 + 3 个本地模块），替换是机械性的；而 10 套协议的知识（Qoder 三层嵌套业务码、TRAE 档位合并规则、腾讯促销时段推算、华为 `maas_type` 必须参与签名等）全在可复制的文件里，重写等于重踩一遍已记录的坑。

**已考虑并否决的替代方案**：

- **写 DSH 兼容 shim 宿主**：要让插件 `index.ts` 原样运行，得忠实模拟 `ctx.llm` / `ctx.credentials` / `ctx.settings` / `ctx.fiber` / `ctx.effect` / `connection.fetch` 等一整套内部契约；DSH 升级后会静默失配。且它把「服务端」与「DSH 内部模型」绑死，与「独立服务」目标相悖。
- **全新重写**：架构最干净，但需重新推导 10 套协议，工期与回归风险都高得多。
- **只移植在用的 provider**：会让「新增 provider」变成每加一个都要动架构，而 10 个 provider 的实现文件本就已存在，逐个搬的成本低于先设计再补齐。

### D2：模型寻址用强制 provider 前缀

**选择**：对外模型标识一律为 `<provider>/<model>`；provider 名取第一个 `/` 之前的部分，其余整体为模型 id。裸名一律 `404 model_not_found`。

**理由**：10 个 provider 之间重名严重（`deepseek-v4-flash` 同时存在于 codearts / buddy / workbuddy / trae / lobsterai；`glm-5.2` 亦多处）。前缀是唯一无歧义的寻址方式，且新增 provider 不会与既有名冲突。

**已考虑并否决的替代方案**：

- **裸名走默认路由 + 前缀可强制**：老客户端不改配置即可用，但同名模型只能命中优先级最高的那个，想指定其他必须改配置，反而更难预测；且「默认路由」本身需要一个用户不易理解的优先级概念。
- **完全隐藏 provider、平铺模型名**：客户端看到干净清单，但无法表达「我就要 codearts 的那个」，且自动消歧后缀会随上游上新而漂移。

### D3：模型开关是硬拦截，而非仅目录过滤

**选择**：三层开关（全局 / provider / 单模型），任一层关闭即 `404 model_not_found`，且不发起上游请求；黑名单制（未记录即默认可用）。

**理由**：来源插件的开关**只影响目录**（AGENTS.md 明确记载「被关闭的模型仍可被 `resolveModel` 解析、仍能正常收发请求」），那是 DSH 对 `listModels` 的约定。但对外提供 API 时，调用方知道模型名就能绕过开关，开关形同虚设。既然用户要的是「能设置开关」，就必须真实可控。

**已考虑并否决的替代方案**：

- **与插件行为一致（仅目录过滤）**：语义最省事，但开关没有实际约束力。
- **显示与可调用分成两个维度**：最灵活，但 UI 与存储复杂度翻倍，而实际需求里没有「可见但禁止调用」这种组合。

**代价与保留**：来源插件的「开关不影响路由」契约在 all_proxy 中**故意不保留**；但「重新开启后立即生效」与「被关闭的模型在管理端仍可见（否则无法重新开启）」这两点保留。

### D4：凭据自持，从 DSH 单向导入 + 手动同步

**选择**：all_proxy 在自己的数据目录维护凭据与账号状态（可读写、可自由刷新回写）；提供手动「从 DSH 导入」入口，导入 `refs:` 与 `state.json`（含账号顺序与 `disabledModels`），导入前备份；**不做定时自动同步**；对一次性轮换 refresh token 的 provider（`codearts`、`trae`）明确警告。

**理由**：`refresh_token` 一次性轮换是硬约束——华为 codearts 用一次即作废（`STS5.1806`），TRAE 每次 `ExchangeToken` 都轮换。若两边都自动刷新，会互相作废，可能把两边的账号都弄死。自持凭据让 all_proxy 能安全地长期运行与续期，而手动同步把「哪边持有有效凭据」的决定权交给用户。

**已考虑并否决的替代方案**：

- **直读 DSH 的 `.credentials.yaml`（只读共享）**：零迁移且账号永远一致，但 all_proxy 的刷新无法回写，长期运行会因 token 过期失效。
- **共享且可回写（同一份文件）**：token 最新，但并发写入可能互相覆盖，且会改动 DSH 的数据文件（与「插件不动」的决定冲突）。
- **定时自动同步**：DSH 新登录的账号自动出现，但在轮换型 provider 上会互相作废，风险不可接受。

**保留项**：导入 `state.json` 时**必须一并导入 `disabledModels`**——用户已关闭大量模型（例如 trae 关掉 34 个、lobsterai 关掉 25 个），若只导账号不导黑名单，导入后会突然暴露一批用户刻意关闭的模型。

### D5：对外双协议，Anthropic 由本服务翻译

**选择**：`POST /v1/chat/completions`（OpenAI）、`POST /v1/messages`（Anthropic）、`GET /v1/models`、`POST /v1/images/generations`、`GET /health`。OpenAI 侧基本是透传上游 + 前缀解析；Anthropic 侧做完整双向翻译（请求体映射、SSE 事件序列、错误信封）。

**理由**：上游 10 个里没有一个是 Anthropic 原生，所以 Anthropic 兼容只能自己实现；但它的收益是 Claude Code 等客户端可直连，而这正是「给其它位置调用」的主要场景。

**已考虑并否决的替代方案**：只做 OpenAI（Claude Code 走其 OpenAI 兼容层，可行但语义会绕一层）；再加 Gemini 等更多格式（当前无实际调用方，属于投机）。

**Anthropic 翻译要点**（实现时不得简化）：`system` 顶层参数要映射成上游 system 消息而非用户消息；SSE 必须按 `message_start` → `content_block_start` → `content_block_delta` → `content_block_stop` → `message_delta` → `message_stop` 输出且带 `event:` 行；工具调用用 `tool_use` 块表达，历史里的 `tool_result` 要能翻回上游格式；错误必须是 Anthropic 信封 `{"type":"error","error":{...}}`。

### D6：账号池只在同一 provider 内轮换

**选择**：保留来源插件的池语义（数组顺序即优先级、手动顺序优先于限流时间、限流账号跳过、`tried` 集合跨重试保留），全部账号耗尽时如实报错（`503`）。**不做跨 provider 改道。**

**理由**：请求写的是 `codearts/deepseek-v4-flash`，静默换成 `buddy/deepseek-v4-flash` 是意外行为——同名模型在质量、上下文窗口、计费上并不等价，用户无法预期。可用性让位于可预测性。

**已考虑并否决的替代方案**：可选的自定义降级链（配置等价模型组，主 provider 全挂时改道）。它确实能提升可用性，但需要用户显式配置，且同名模型不等价的问题依然存在；当前无明确需求，先不做，架构上不堵死（provider 注册表天然允许后续加一层解析）。

**保留项（2026-09-29 更新）**：来源插件中 `loomy` 与 `raccoon` 起初**没有轮换逻辑**，移植时保持了这一现状（不臆造轮换）。后因真实故障——Loomy 排首位的 0 积分账号**每次**都被选中并失败（用户报障「积分余额不足，不自动切换别的账号」），应用户要求为两者补上**请求级换号**：

- 额度耗尽（402/403，或 4xx + 额度文案）→ 在 `modelRateLimits` 上标记到 **UTC+8 当日 24:00**（「当天锁」，次日自动回到池中）+ 换下一个账号；
- 429 限流 → 短冷却（30 秒）标记 + 换号；
- 401 → 先刷新当前账号，仍失败则弃用该号换下一个（不写标记）；
- 其余错误（400 无额度文案、5xx）与账号无关，原样抛出。

Raccoon 的错误判据对齐用户自写的 `../xiaohuanxiong2api/raccoon-gateway.js`（在线实测：402/403 = 额度错误）。换号带 `tried` 排除集，不会反复重试同一账号；`rotatesAccounts` 相应改登记为 `true`。Loomy 另按来源既有接线补上**按余额分档选号**（`loomy-balance-selector`：有今日额度 → 只剩永久 → 无余额/查不到，档内保持手动顺序），从源头避开 0 积分账号。

### D7：单进程同源提供管理端

**选择**：一个 Node 进程同时服务 API 与管理端静态资源；管理端在开发态由 Vite dev server 提供并把 `/api` 代理到网关，生产态由网关托管构建产物。

**理由**：管理端调后端即同源 `fetch`，不需要 CORS 与反代；与现有两个单文件网关「一个进程搞定」的风格一致；部署面最小。

**已考虑并否决的替代方案**：前后端分离两个进程。开发热更新更顺，但生产部署多一层配置，且用户场景是本地自用，收益不抵复杂度。

### D8：管理端复用 Jet Hub 的 React 界面

**选择**：把 `plugin-src/client/jet-hub.js`（2130 行）及其纯逻辑模块（`account-order.js`、`model-filter.js`、`model-bulk.js`、`account-model-link.js`、`credits-capabilities.js`、`backup-crypto.js`）搬过来，用 Vite + esbuild 打包；只替换两处宿主耦合：`management-rpc.mjs` 的 `connection.rpc.call` → 普通 `fetch('/api/...')`；`index.js` 的 slots 注册与 `build.mjs` 的 `window.__ModuleLoader__` 包装 → 普通 Vite 入口。

**理由**：界面逻辑只依赖两个 prop（`JetHubPage({close, rpcCall})`），`rpcCall(method, payload, signal)` 是纯函数接口，换成 HTTP 很薄。这样能直接复用 10 个 provider 的图标、账号卡片、拖拽排序、模型开关、积分面板与备份面板，省下大量 UI 工作，且功能与用户在 DSH 里熟悉的完全一致。

**已考虑并否决的替代方案**：用 Vue 3 + Arco Design Vue 重写界面。代码更短更好维护，但要重写 2130 行，且用户在 DSH 里已熟悉现有交互，重写会引入不必要的学习成本。

**代价**：界面是 `React.createElement` 风格（无 JSX），后续修改略繁；这是可接受的取舍，且不排除日后局部改造。

### D9：存储分层——配置用 JSON，用量用 SQLite

**选择**：账号索引、凭据、API Key、模型开关等小配置存 JSON（临时文件 + 重命名原子替换，沿用来源 `FileStore` 思路）；用量日志存 SQLite。

**理由**：配置数据量小、人可能想直接看或改、且需要整体备份导出，JSON 最合适；用量日志会持续增长且需要按时间/维度聚合查询，JSON 会退化。实测 `node:sqlite` 在本机可用且**无需显式 flag**，因此不引入 `better-sqlite3` 这类需要原生编译的依赖（在本机 shell 一度不可用的背景下，少一个编译依赖就少一类风险）。

**已考虑并否决的替代方案**：全部 SQLite（配置不再能用文本编辑器改）；全 JSON/JSONL（日志量大后查询慢）。

**注意**：`node:sqlite` 仍是 experimental，会打印警告。需在启动时按需抑制该警告，并在文档中记录 Node 版本要求（≥ 22.5，本机 24.9 实测通过）。

### D10：多 API Key 入站鉴权

**选择**：可创建多把 key（名称、可选速率限制、可选额度、可选 provider/模型白名单、可禁用删除）；同时接受 `Authorization: Bearer <key>` 与 `x-api-key: <key>`；管理端用独立凭据且默认仅监听本机。

**理由**：对外提供 API 后，单一固定 key 无法区分调用方、泄露即全废、也无法按用途限权。多 key 让「给谁、能用什么、能用多少」可控。

**已考虑并否决的替代方案**：单一固定 key（与现有两个网关一致，但无隔离）；不做 key 仅靠监听本机（一旦需要局域网访问就完全裸奔）。

### D11：用量记录完整字段但不含正文

**选择**：每次请求记录时间、key 标识、provider、模型、**实际完成请求的账号**、prompt/completion token、缓存命中 token、是否流式、总耗时、首字节耗时、结束原因、状态码与错误码；失败请求也记录。**不记录消息正文与模型输出正文。**

**理由**：既能回答「额度被谁消耗」，又避免把用户对话内容落盘带来的隐私与体积问题。记录**实际账号**而非池默认账号，是因为轮换后二者可能不同（来源插件在 Qoder 上正因用了「池默认账号」而误标过无辜账号）。

### D12：Loomy 以手机号验证码为主路径

**选择**：Loomy 登录的**主路径**是手机号 + 短信验证码（`/login/phone/sendMsgCode` → `/login/phone/checkCode`，带讯飞账号 HMAC-SHA1 签名）；微信扫码作为可选路径保留。

**理由**：微信扫码的 `openid` 天然绑死单一微信号，因此只能登录一个 Loomy 账号；手机号路径可以登录多个。来源插件其实两套都有（`loomy-oauth.ts` 的 `sendLoomySmsCode` / `loginLoomyBySmsCode`，以及 `loomy-wechat-login.ts` 的扫码流程），但 Jet Hub 面板默认走扫码，用户在 DSH 里因此只登了一个账号。用户在 `loomy/loomy-gateway/loomy-login.mjs` 里已经用手机号路径验证过可行性。

### D13：完整移植 10 套登录流程

**选择**：移植全部 `*-auth.ts` / `*-oauth.ts`（含本地回调服务器、设备码轮询、短信、微信扫码、DPoP/jose、二维码），使管理端能直接新增账号。

**理由**：用户明确要求「完整移植 10 套登录流程」。这使 all_proxy 完全自给自足，不依赖 DSH 或平台桌面客户端。

**代价与约束**：登录流程是本次最大的工作量与风险面。必须保留来源已记录的若干硬约束——两步式登录（授权完成前就返回 `loginUrl`，否则弹窗被浏览器拦截）、轮询时「用户尚未完成授权」不是错误、一次性 refresh token 立即回写、只读探针不得消耗 refresh token。

### D14：单仓库，不动插件

**选择**：`all_proxy` 是独立仓库（`D:\Project\go\token_proxy\all_proxy`），从来源复制代码后自由演化；来源仓库不提交任何改动。

**理由**：不碰用户正在使用的 DSH 环境，风险最低；all_proxy 可以按服务端需要放开手脚重构（例如把「开关只影响目录」改成硬拦截）。代价是两边会逐渐分叉，来源的修复不会自动过来——由 `AGENTS.md` 记录来源版本与分叉点来缓解。

**已考虑并否决的替代方案**：抽公共核心包两边共用（修一处两边受益，但要改插件、有回归风险，且两者词汇不同：DSH 的 `StreamChunk` vs 网关的 SSE）；all_proxy 完全取代插件（会与 D2/D4 的取舍冲突，且用户没有要求停用插件）。

## Risks / Trade-offs

**[一次性 refresh token 在两边同时刷新会互相作废（codearts、trae）]** → 自持凭据（D4）+ 手动同步 + 导入时明确警告；文档中说明「导入后请只让一边刷新」。这是本方案最重要的操作约束。

**[Loomy 没有 refresh 端点，token 过期只能重新登录]** → 账号卡片明确展示有效期与「不可续期」标记；过期前提示；把手机号验证码登录做顺（D12），使重新登录成本足够低。

**[node:sqlite 是 experimental，未来 Node 版本可能变更 API]** → 把用量存储封装在一个薄接口后，必要时可换 `better-sqlite3` 或 JSONL；启动时探测可用性，不可用时降级为 JSONL 并告警，不阻断服务启动。

**[Qoder 的 WASM 必须与编译产物同目录]** → 构建脚本显式复制 `.wasm`；启动时自检该文件存在，缺失时给出明确错误而非运行到一半才失败。

**[移植面很大（10 套登录 + 10 套协议 + 2130 行界面），一次性做完风险高]** → 按 tasks 分阶段：先打通「一个 provider 的端到端链路 + 网关骨架 + 硬拦截开关」，再横向补齐其余 provider，最后做管理端与登录流程。每个阶段都有可验证的产出。

**[来源仓库与 all_proxy 分叉后，来源的缺陷修复不会自动同步]** → 在 `AGENTS.md` 记录来源仓库 URL 与移植基线 commit（`3611a62`），并把「已移植文件清单」显式列出，便于日后按需 cherry-pick。

**[Anthropic 翻译是新增逻辑，没有上游可直接对拍]** → 用「同一请求分别走 OpenAI 与 Anthropic 端点，比较正文与工具调用」的方式做对拍测试；对 SSE 事件序列写断言。

**[管理端默认仅监听本机，但用户可能需要局域网访问]** → 绑定地址可配置；一旦改为对外监听，启动时强制要求设置管理凭据并打印显著警告，避免裸奔。

**[用户已有 14 个账号、6 个 provider 的黑名单，导入出错会打乱现有 DSH 使用]** → 导入是只读 DSH + 写自身存储，永不回写 DSH；导入前备份；提供回退。这保证即使导入逻辑有误，DSH 侧也不受影响。

**[同名模型在不同 provider 下展示名可能重复，界面难以区分]** → 强制前缀（D2）已从标识层面消除歧义；界面上以 provider 分组展示，并保留来源插件对同 provider 内同名模型加后缀消歧的处理。

## Migration Plan

1. **脚手架与骨架**：初始化 `all_proxy` 的 TypeScript 项目（pnpm、tsconfig、vitest、构建脚本），移植零依赖的纯模块（`message-shape` / `model-queue` / `sign` / `refresh`）并先让它们的原有单测通过——这是「移植管道是通的」的第一个证据。
2. **替换 DSH 词汇**：写本地 `LlmAdapter` 抽象基类与 `LlmError` 等价类，移植 `openai-compat.ts` 与 `sse.ts` 并改掉各自的 1 处 DSH 导入。
3. **打通单 provider 端到端**：先接 `raccoon`（协议最简单、且现有 `xiaohuanxiong2api` 可作为对拍参考），实现 `POST /v1/chat/completions` + `GET /v1/models`，验证流式与非流式。
4. **补齐其余 provider**：按协议难度递进（OpenAI 兼容族 → codearts 签名 → trae 转换 → qoder WASM）。
5. **账号池与凭据**：自建凭据存储与账号池，实现从 DSH 导入（含 `disabledModels`）。
6. **模型开关硬拦截** + 多 API Key + 用量记录。
7. **Anthropic 端点** + 对拍测试。
8. **管理端**：搬运 Jet Hub 界面、替换 RPC 为 HTTP、Vite 构建、由服务托管。
9. **登录流程**：按 provider 逐个移植，Loomy 先做手机号路径。

**回滚策略**：每个阶段独立可验证，失败即回退该阶段改动；由于不触碰 DSH 与现有两个网关，任何阶段出问题都不影响用户当前的使用。数据层面，导入前的备份文件可用于回退到导入前状态。

## Open Questions

- **管理端是否需要多用户/登录态**：当前按「单用户 + 独立管理凭据」设计；若日后需要区分操作者，需在 `access-control` 增加操作者维度。不影响当前规格与任务拆解。
- **用量数据的默认保留期限**：先给一个可配置默认值（如 90 天 / 50 万条），实际数值待运行一段时间后按真实增长量调整。不影响规格（规格只要求「有保留策略」）。
- **生图端点的 provider 覆盖范围**：来源中明确支持生图的是 `raccoon` 与 `loomy`（`loomy` 还有配套的 MCP server）。是否要把其余 provider 的生图能力也接进来，待确认它们是否真有该能力后再定；当前规格只要求「不支持的 provider 明确报错」。
- **是否需要兼容现有两个网关的端点形状**（例如 `raccoon-gateway` 的 `/admin/accounts`）：若用户希望平滑迁移已有客户端配置，可另开一个兼容层；当前按新设计，不保证端点逐一对应。
