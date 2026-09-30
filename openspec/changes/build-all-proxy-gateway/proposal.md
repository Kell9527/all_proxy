# Proposal

## Why

现有两个网关（`xiaohuanxiong2api`、`loomy/loomy-gateway`）各自只能代理**一个**平台，账号池、故障转移、模型开关都要重复实现一遍；而 `deepseek-harness-codearts` 插件虽然已经聚合了 **10 个** provider（协议细节、签名、WASM 加密、登录流程、积分签到全都打通），却只能作为 DSH 插件在 harness 内部使用，外部客户端无法调用。

需要把插件的聚合能力从「DSH 插件」形态改造成**独立 HTTP 服务**：对外提供标准 API 供任意客户端调用，并配一个网页管理端，同时把「模型开关」做成真实生效的硬拦截。

## What Changes

- 新建独立仓库 `all_proxy`（Node + TypeScript），从 `deepseek-harness-codearts` **移植** provider 协议实现，不再依赖 DSH 运行时（去除 `LlmAdapter` / `LlmError` / `ctx.credentials` / `ctx.llm` 耦合）。原插件保持不动。
- 对外暴露 **OpenAI 兼容**（`POST /v1/chat/completions`、`GET /v1/models`、`POST /v1/images/generations`）与 **Anthropic 兼容**（`POST /v1/messages`）双协议端点，外加 `/health`。
- **模型寻址采用强制 provider 前缀** `<provider>/<model>`（如 `raccoon/sn-glm-5-3`、`codearts/deepseek-v4-flash`），消除 10 个 provider 之间大量重名模型的歧义。
- **三层模型开关**（总开关 → provider 开关 → 单模型开关），语义为**硬拦截**：关闭的模型既不出现在 `/v1/models`，直接调用也返回 `404 model_not_found`。
- **多 API Key 管理**：可创建多把 key，每把带名称、可选额度/速率限制、可选可访问的 provider/模型白名单，可单独禁用与删除；同时认 `Authorization: Bearer` 与 `x-api-key`。
- **账号池**：同一 provider 内按用户指定顺序轮换账号（手动顺序优先、限流豁免），全部用尽时如实报错；**不做跨 provider 自动改道**。
- **凭据自持**：all_proxy 维护自己的凭据副本（可读写、可自由刷新回写），支持从 DSH 的 `.credentials.yaml` + `jet-hub/state.json` **单向导入 + 手动同步**，对 `refresh_token` 一次性轮换的 provider（codearts、trae）明确警告。
- **完整移植 10 套登录流程**，网页端可直接新增账号。其中 **Loomy 以手机号 + 短信验证码为主路径**（插件 Jet Hub 面板默认走微信扫码，受 `openid` 限制只能登一个账号；手机号路径可多账号）。
- **用量记录**：每次请求记录时间、API Key、provider、model、账号、prompt/completion tokens、耗时、首字节时间、状态/错误码、是否流式、缓存命中；网页可按维度筛选与汇总。
- **网页管理端**：复用插件的 Jet Hub React 界面（约 2130 行，含 10 个 provider 图标、账号卡片、拖拽排序、模型开关、积分面板、备份导入导出），把 `connection.rpc.call` 换成普通 HTTP，用 Vite 打包。
- **单进程部署**：网关与管理端由同一个 Node 进程提供，管理端与后端同源。
- **存储**：账号/API Key/模型开关等配置用 JSON 文件（原子写）；用量日志用 SQLite（优先 Node 内置 `node:sqlite`，避免原生编译依赖）。

## Capabilities

### New Capabilities

- `gateway-api`: 对外 HTTP 端点契约——OpenAI 与 Anthropic 双协议、`/v1/models` 目录、模型寻址与解析规则、错误响应与状态码映射、流式与非流式行为。
- `provider-routing`: 10 个 provider 的上游适配层——端点/鉴权头/请求体构造/SSE 消费与转换（含华为 HMAC-SHA256 签名、Qoder WASM 加密信封、TRAE SOLO 转换），以及每个 provider 的模型目录来源。
- `account-pool`: 账号池与凭据存储——账号条目、凭据 ref 与凭据本体分离、顺序即优先级、限流标记与冷却、同 provider 内轮换、从 DSH 导入与手动同步。
- `model-switching`: 三层模型开关的持久化与硬拦截语义，以及开关状态变更后的目录生效行为。
- `provider-login`: 10 套登录流程——浏览器回调服务器、设备码轮询、短信验证码、微信扫码、DPoP/OAuth 交换，以及登录产物如何落成账号条目。
- `access-control`: 多 API Key 的创建/禁用/删除、额度与速率限制、provider/模型白名单、入站鉴权校验。
- `usage-tracking`: 请求日志与用量统计的记录字段、持久化、查询与汇总口径。
- `admin-console`: 网页管理端的信息架构与操作能力（账号、模型开关、API Key、用量、备份），以及它与后端 API 的交互契约。

### Modified Capabilities

（无。本变更全部为新增能力，`openspec/specs/` 当前为空。）

## Impact

- **新增代码库**：`D:\Project\go\token_proxy\all_proxy`（当前仅有 `openspec/` 脚手架）。后端 TypeScript 服务 + 前端 Vite 构建产物 + `data/` 运行时目录。
- **被移植的来源**：`deepseek-harness-codearts/src/`（协议知识集中在 `*-product.ts` / `*-auth.ts` / `*-oauth.ts` / `*-credits.ts` / `buddy.ts` / `qoder.ts` / `trae.ts` / `loomy*.ts` / `raccoon*.ts` / `openai-compat.ts` / `sse.ts` / `sign.ts` / `model-queue.ts` / `message-shape.ts`）与 `plugin-src/client/`（Jet Hub 界面）。**原仓库不改动**。
- **依赖**：`jose`（CodeArts DPoP 登录）、`qoder-auth-wasm.wasm`（298 KB，必须与编译产物同目录）、前端 `react` / `react-dom` / Vite；用量库优先 Node 内置 `node:sqlite`（实验性，需 `--experimental-sqlite` 或 Node ≥ 22.5 的相应开关）。
- **读取的外部数据**：`C:\Users\pan\.dsh\.credentials.yaml`（凭据，只读导入）与 `C:\Users\pan\.dsh\jet-hub\state.json`（账号顺序与模型开关，只读导入）。
- **已知风险**：`refresh_token` 一次性轮换的 provider（codearts、trae）在 DSH 与 all_proxy 两边同时刷新会互相作废；Loomy 没有 refresh 端点（token 过期只能重新登录）。
- **不涉及**：不修改 DSH 插件、不替换现有两个单 provider 网关（可并存）。
