# Tasks

## 1. 项目脚手架与移植管道

- [x] 1.1 初始化 `all_proxy` 的 Node + TypeScript 项目：`package.json`（`type: module`、Node `>=22.5` engines）、`tsconfig.json`、`vitest.config.ts`、`.gitignore`（忽略 `node_modules` / `dist` / `data`），验证 `pnpm install` 与 `pnpm typecheck` 均成功
- [x] 1.2 配置构建与运行脚本（`build` / `dev` / `start` / `test`），验证 `pnpm build` 产出 `dist/` 且 `node dist/index.js --version` 可运行
- [x] 1.3 在 `AGENTS.md` 记录移植来源仓库 URL 与基线 commit `3611a62`、已移植文件清单、分叉点说明，验证文档中的 commit 与来源仓库 `git log -1` 一致
- [x] 1.4 移植零依赖纯模块 `message-shape.ts`、`model-queue.ts`、`sign.ts`、`refresh.ts` 并确认文件内无 `@deepseek-ai/*` 导入，验证 `grep -r "@deepseek-ai" src/` 对这四文件无命中
- [x] 1.5 把上述四模块的来源单测一并移植并跑通，验证 `pnpm test` 全部通过（这是「移植管道可用」的第一个证据）

## 2. 替换 DSH 词汇（适配层本地化）

- [x] 2.1 实现本地 `LlmAdapter` 抽象基类，提供 `providerInfo` / `listModels` / `resolveModel` / `prepareCall` / `stream` 五个可覆盖方法，验证基类的单元测试覆盖默认实现与 `stream` 抽象约束
- [x] 2.2 实现本地 `LlmError` 等价类（含 `code`、`message`、可选 `status`、可选 `cause`）与本地 `StreamChunk` / `GenerateOptions` 类型，验证错误类可被 `instanceof` 判别且序列化后不含敏感字段
- [x] 2.3 移植 `openai-compat.ts` 与 `sse.ts`，把各自的 `@deepseek-ai/dsh-llm` 导入替换为本地实现，验证这两文件内 `grep "@deepseek-ai"` 无命中且来源单测通过
- [x] 2.4 移植 `account-pool` 的纯逻辑部分（`sanitizeAccounts`、`sanitizeDisabledModels`、选号 `getAvailableAccount`、`reorderAccounts`、`updateModelRateLimit`）并去掉 `ctx.credentials` / `ctx.logger` / `declare module` 依赖，验证选号与重排的单测通过
- [x] 2.5 实现本地凭据存储（`resolve` / `describe` / `set` / `unset`，JSON 临时文件 + 重命名原子写），验证原子写测试通过（写入过程中断不产生损坏文件）

## 3. Provider 协议层（先打通单个 provider）

- [x] 3.1 建立 provider 注册表与配置类型（标识、显示名、基地址、chat 路径、鉴权方式、模型目录来源），验证注册表拒绝重复 provider 标识
- [x] 3.2 移植 `raccoon` 的协议实现（`raccoon.ts` / `raccoon-product.ts` / `raccoon-adapter.ts`），验证 `grep "@deepseek-ai"` 对其无命中
- [x] 3.3 实现 `POST /v1/chat/completions` 的非流式路径并接通 raccoon，验证对真实账号发一次请求能拿到含 `choices[].message.content` 的合法响应
- [x] 3.4 实现流式路径（SSE 输出 `chat.completion.chunk` + `[DONE]`），验证对真实账号的流式请求逐块到达且以 `[DONE]` 结束
- [x] 3.5 实现 `GET /v1/models`（OpenAI 列表格式）并接通 raccoon 的远端目录与兜底目录，验证返回条目含 provider 前缀与上下文窗口元数据
- [x] 3.6 实现模型寻址解析（provider 前缀、裸名拒绝、模型名含斜杠的处理），验证四种情形的单元测试全部通过（合法前缀、provider 不存在、缺前缀、模型名含斜杠）
- [x] 3.7 实现统一错误映射（`401 authentication_error` / `429 quota_exceeded` / `503` 无可用账号 / 排队等待重试 / 4xx 原样透传不换号），验证各分支的单元测试通过
- [x] 3.8 实现 `GET /health`，验证该端点不触发任何消耗上游额度的请求（用替身断言 fetch 未被调用）

## 4. Provider 协议层（补齐其余九个）

- [x] 4.1 移植 OpenAI 兼容族 `loomy`（`loomy.ts` / `loomy-product.ts` / `loomy-adapter.ts` / `loomy-sign.ts`），验证 chat 与非流式请求均返回合法响应
- [x] 4.2 移植 `buddy` 与 `workbuddy`（共用 `buddy.ts` / `product.ts` / `buddy-adapter.ts`，差异仅在配置），验证两个 provider 各自能列出模型且 `X-Domain` 等身份头按产品正确切换
- [x] 4.3 移植 `lobsterai`，验证 chat 请求携带 `X-LobsterAI-Client-Capabilities` 与 `X-LobsterAI-Client-Version`，且 `stream` 恒为 true
- [x] 4.4 移植 `cline`，验证鉴权头保留 `workos:` 前缀且 403 区域封锁在刷新凭据之前被判定
- [x] 4.5 移植 `codearts` 的 HMAC-SHA256 签名（`sign.ts` 接线）与 `maas_type: benefit` 逻辑，验证 benefit 模型带该头且参与签名、非 benefit 模型不带该头
- [x] 4.6 移植 `codearts` 的 DSML 工具模式与 `deepseek-v4-*` 特殊处理，验证该族模型的请求体不含标准 `tools` 而改为注入 system 提示
- [x] 4.7 移植 `trae` 的 SOLO 请求体转换（`transformToSOLOBody` / `normalizeTools` / `normalizeToolChoice`），验证转换后的请求体含 `function`、`config_name`，且工具参数被序列化为 JSON 字符串
- [x] 4.8 移植 `trae` 的 SOLO SSE 转换（`parseTraeSSELine` / `buildOpenAIChunk`），验证 `output` / `token_usage` / `done` / `error` 四类事件都被正确转换为 OpenAI chunk，且 `error` 事件抛出错误而非静默结束
- [x] 4.9 移植 `trae` 的多通道档位合并规则（空档位不得覆盖有档位、两侧都有档位按通道优先级），验证合并规则的单元测试通过（含「空档位不覆盖」的反向用例）
- [x] 4.10 移植 `qoder` 与 `qodercn` 的 WASM 加密请求体构造（`qoder-wasm.ts` / `qoder-envelope.ts`），验证加密请求被上游接受且响应信封被正确剥离
- [x] 4.11 在构建脚本中复制 `qoder-auth-wasm.wasm` 到产物目录，并在启动时自检该文件存在（缺失时给出明确错误），验证删除该文件后启动报出可读错误
- [x] 4.12 移植 Qoder 的排队（`10605`）与额度（`110`）业务码识别，验证两种下发通道（HTTP 403 体、HTTP 200 SSE 帧）都能识别，且额度错误抛 `QUOTA_EXCEEDED` 且不重试
- [x] 4.13 移植 Qoder 的 UTC+8 当日 24:00 推算（不取本机时区），验证日界纯函数测试通过且与账期时区一致
- [x] 4.14 为全部十个 provider 各补一条「模型目录可列出」的集成测试，验证无 provider 因目录失败而整体报错

## 5. 账号池与凭据导入

- [x] 5.1 实现账号条目的持久化（JSON，含 id / provider / 昵称 / 启用状态 / 凭据引用 / 有效期 / 可续期标记 / 限流标记），验证重启后账号与顺序保持一致
- [x] 5.2 实现凭据引用格式 `<PROVIDER>_ACCOUNT_<HEX>` 与唯一性约束，验证删除账号时其凭据被连带清理（不产生孤立凭据）
- [x] 5.3 实现「数组顺序即选号优先级」的选号逻辑，验证「手动顺序优先于限流重置时间」的回归用例通过（防止重新引入按重置时间重排）
- [x] 5.4 实现限流标记与冷却（含模型维度隔离、标记持久化），验证「只标记该模型」与「重启后标记仍生效」的测试通过
- [x] 5.5 实现同 provider 内轮换（含 `tried` 集合跨重试保留），验证「不在多个账号间无限来回」与「全部耗尽时如实报错」的测试通过
- [x] 5.6 实现续期调度且只按 `refreshable` 过滤（不看 `enabled`），验证「所有账号停用时调度器仍启动」与「停用账号仍被续期」的测试通过
- [x] 5.7 实现从 DSH 导入：读取 `.credentials.yaml` 的 `refs` 与 `jet-hub/state.json` 的 `accounts`，验证导入后账号数量、顺序与启用状态与来源一致
- [x] 5.8 实现导入时一并导入 `disabledModels` 黑名单，验证导入后原本被关闭的模型仍不出现在 `/v1/models`
- [x] 5.9 实现导入前自动备份与回退入口，验证备份文件可被用于恢复到导入前状态
- [x] 5.10 实现导入的幂等性（按凭据引用识别已存在账号并更新而非重复创建），验证连续导入两次不产生重复账号
- [x] 5.11 实现轮换型凭据（codearts、trae）的导入警告，验证导入这两类账号时返回的警告文案包含「DSH 侧凭据可能失效」
- [x] 5.12 验证导入过程永不写入 DSH 数据文件（对导入前后 `.credentials.yaml` 与 `state.json` 做校验和比对）

## 6. 模型开关与硬拦截

- [x] 6.1 实现三层开关的存储（全局 / provider / 单模型，黑名单制），验证「未记录的模型默认可用」与「新增模型自动出现」的测试通过
- [x] 6.2 实现三层开关的判定顺序（任一层关闭即不可用），验证四种组合（全开、全局关、provider 关、单模型关）的判定测试全部通过
- [x] 6.3 实现硬拦截：被关闭的模型调用返回 `404 model_not_found` 且不发起上游请求，验证用替身断言 fetch 未被调用
- [x] 6.4 实现开关变更的即时生效（无需重启），验证变更后下一次 `/v1/models` 与调用判定立即反映
- [x] 6.5 实现开关的批量操作（某 provider 全部开启 / 全部关闭），验证批量操作结果与逐项操作一致
- [x] 6.6 实现开关变更审计记录（时间、层级、目标标识），验证记录中不含凭据明文
- [x] 6.7 实现「查询某模型最终可用性并说明是哪一层导致不可用」，验证该查询在四种组合下都返回正确归因

## 7. 入站鉴权（多 API Key）

- [x] 7.1 实现 API Key 的创建（返回一次性明文）、列表（不含明文）、禁用与删除，验证列表中任何字段都不含完整 key 明文
- [x] 7.2 实现入站校验并同时接受 `Authorization: Bearer` 与 `x-api-key`，验证两种携带方式对同一 key 等价
- [x] 7.3 实现无凭据与无效凭据的 `401` 响应，验证错误消息不泄露「该 key 是否存在」
- [x] 7.4 实现 key 级 provider / 模型白名单，验证受限 key 调用范围外模型被拒绝且不发起上游请求
- [x] 7.5 实现 `/v1/models` 按调用 key 的范围过滤（且与模型开关取交集），验证受限 key 只看到自己可访问且未被关闭的模型
- [x] 7.6 实现 key 级速率限制与额度限制，验证超限返回 `429` 且额度耗尽时不发起上游请求
- [x] 7.7 实现管理端独立凭据与默认仅本机监听，验证普通 API Key 无法访问管理 API
- [x] 7.8 实现管理端写操作的留痕，验证留痕记录不含凭据明文

## 8. 用量记录与运行日志

- [x] 8.1 接入 `node:sqlite` 并建表（时间、key 标识、provider、模型、账号、prompt/completion token、缓存命中 token、是否流式、总耗时、首字节耗时、结束原因、状态码、错误码、请求标识），验证建表与写入成功
- [x] 8.2 实现成功请求的用量落盘，验证记录中 prompt/completion token 与上游返回的 `usage` 一致
- [x] 8.3 实现失败请求的落盘（含状态码与错误码，token 字段为空或零），验证失败请求同样产生一条记录
- [x] 8.4 实现记录**实际完成请求的账号**（而非池默认账号），验证轮换场景下记录的账号与真正服务该请求的账号一致
- [x] 8.5 验证用量记录不含用户消息正文与模型输出正文（对记录做全文检索断言）
- [x] 8.6 实现用量写入失败不阻断请求（仅记内部告警），验证用替身让写入抛错后客户端仍收到正常响应
- [x] 8.7 实现保留策略（按期限或总量清理最旧记录），验证超限后最旧记录被清理且最新记录保留
- [x] 8.8 实现用量查询 API（时间范围 + key/provider/model 筛选 + 分页 + 汇总），验证汇总含请求总数、成功数、失败数、prompt/completion token 合计与平均首字节耗时
- [x] 8.9 实现请求标识贯穿运行日志与用量记录，验证同一次请求两处标识一致
- [x] 8.10 实现运行日志轮转（大小上限 + 有限备份），验证达到上限后产生轮转且备份数量受限
- [x] 8.11 实现日志阶段可定位（未连接上游 / 已连接无首字节 / 传输中断 / 完成），验证各阶段都能在日志中区分
- [x] 8.12 验证运行日志与错误响应中均不出现凭据、refresh token 与 API Key 明文（对日志文件做检索断言）

## 9. Anthropic 兼容端点

- [x] 9.1 实现 `POST /v1/messages` 非流式翻译（请求体映射 + 响应体构造），验证返回含 `type: "message"`、`content` 数组、`stop_reason` 与 `usage: {input_tokens, output_tokens}`
- [x] 9.2 实现顶层 `system` 参数映射为上游 system 消息（而非用户消息），验证映射后的上游请求体中 system 角色正确
- [x] 9.3 实现 Anthropic SSE 事件序列（`message_start` → `content_block_start` → `content_block_delta` → `content_block_stop` → `message_delta` → `message_stop`），验证事件顺序与 `event:` 行均正确
- [x] 9.4 实现工具调用双向翻译（响应侧 `tool_use` 块；历史侧 `tool_result` 翻回上游格式），验证一次完整的工具调用往返可用
- [x] 9.5 实现 Anthropic 错误信封 `{"type":"error","error":{...}}`，验证失败响应是 Anthropic 形状而非 OpenAI 形状
- [x] 9.6 用同一请求分别走 OpenAI 与 Anthropic 端点做对拍，验证两者正文与工具调用语义一致（差异仅在协议形状）

## 10. 登录流程（十个 provider）

- [x] 10.1 实现两步式登录契约（授权完成前即返回 `loginUrl`）与授权超时后的回调端点清理，验证「授权永不完成」的替身下立即返回且不泄漏监听端口
- [x] 10.2 实现本地回调服务器式登录并接通 `codearts`（含 `jose` 的 DPoP/ES256 与 PKCE），验证真实登录能拿到含 `refresh_token` 的凭据
- [x] 10.3 实现 `codearts` 的 `refresh_token` 一次性轮换立即回写，验证刷新后新凭据已落盘
- [x] 10.4 实现后端轮询式外部链接登录并接通 `buddy` 与 `workbuddy`，验证「未就绪」错误码被视为继续轮询而非失败
- [x] 10.5 实现 `lobsterai` 登录（本地回调收 `authCode` 后换 token），验证凭据中持久化 `uuid` / `first_keyfrom` / `latest_keyfrom`
- [x] 10.6 实现设备码轮询登录并接通 `qoder` 与 `qodercn`（含 prod 与 CN 各自的 `client_id`），验证「用户尚未完成授权」的 404 被视为继续轮询
- [x] 10.7 实现 `trae` 的 ExchangeToken 轮换登录，验证每次调用后新的 `refresh_token` 被立即回写且 `machine_id` / `device_id` 被持久化
- [x] 10.8 实现 `trae` 的每账号 `device_id` 唯一性，验证两个账号的 `device_id` 不相同
- [x] 10.9 实现 `cline` 的 WorkOS 设备流登录，验证凭据中的 token 保留 `workos:` 前缀
- [x] 10.10 实现 **Loomy 手机号 + 短信验证码登录为主路径**（`sendMsgCode` → `checkCode`，带讯飞账号 HMAC-SHA1 签名），验证真实手机号能完成登录并创建账号
- [x] 10.11 验证 Loomy 多账号共存：用两个不同手机号先后登录，验证产生两条独立账号条目且不覆盖
- [x] 10.12 实现 Loomy 微信扫码作为可选路径（含需绑手机号时的引导），验证扫码路径可完成登录
- [x] 10.13 实现 `raccoon` 登录（短信 / 微信二维码），验证登录产物落成账号条目
- [x] 10.14 实现登录产物落成账号条目（写凭据 + 写索引 + 回填昵称与有效期），验证凭据就位后账号才被标记为可用
- [x] 10.15 实现昵称脱敏（手机号形态脱敏、非手机号形态原样保留），验证两种输入的归一化结果正确且对已脱敏输入幂等
- [x] 10.16 实现登录失败的可读归因（上游返回非 JSON / 凭据失效 / 缺少必要字段三类），验证三类情形各返回可读提示而非异常原文
- [x] 10.17 验证只读的状态与余额探测不触发凭据刷新（对一次性 refresh token 的 provider 用替身断言刷新未被调用）

## 11. 网页管理端

- [x] 11.1 搭建前端工程（Vite + React）并配置开发态 `/api` 代理到网关，验证开发服务器热更新可用且能拿到真实数据
- [x] 11.2 移植 Jet Hub 界面与纯逻辑模块（`jet-hub.js`、`account-order.js`、`model-filter.js`、`model-bulk.js`、`account-model-link.js`、`credits-capabilities.js`、`backup-crypto.js`）与十个 provider 图标，验证界面能渲染出全部 provider 分组
- [x] 11.3 把 `connection.rpc.call` 替换为普通 `fetch('/api/...')` 并去掉 `window.__ModuleLoader__` 包装，验证界面所有数据均来自真实 HTTP 请求
- [x] 11.4 实现账号管理界面（按 provider 分组、启用停用、删除、续期、展示凭据状态），验证各操作落盘并在重启后保持
- [x] 11.5 实现拖拽排序（按落点上半/下半决定前插后插、乐观更新与失败回滚、单账号不启用），验证排序结果与界面指示一致且失败时回滚
- [x] 11.6 实现模型开关界面（列出含已关闭的全部模型、逐个与批量开关、展示倍率与上下文、同 provider 内同名模型可区分），验证关闭后该模型从 `/v1/models` 消失且界面仍可见以便重新开启
- [x] 11.7 实现 API Key 管理界面（创建后展示一次性明文、编辑范围与限制、展示累计用量），验证创建后明文只出现一次且列表不含明文
- [x] 11.8 实现用量与状态界面（按时间与维度筛选、按 key 汇总、provider 状态总览、标出当前优先选用的账号），验证筛选结果与用量 API 返回一致
- [x] 11.9 实现备份导入导出界面（导出、口令加密导出、导入前备份、导入失败可回退），验证加密备份需口令才能导入且错误口令被拒绝
- [x] 11.10 配置生产构建并让网关托管构建产物（含缓存头或内容哈希），验证 `pnpm build` 后单进程访问页面即可完成一次账号查看与模型开关操作

## 12. 集成与端到端验证

- [ ] 12.1 端到端验证 OpenAI 路径：用真实账号对至少三个协议族（OpenAI 兼容族、codearts 签名族、qoder WASM 族）各跑一次流式与非流式请求，验证均返回合法响应
- [ ] 12.2 端到端验证 Anthropic 路径：用 Claude Code 或等价客户端接入 `POST /v1/messages`，验证一次带工具调用的完整对话可用
- [x] 12.3 端到端验证硬拦截与鉴权：用一个受限 API Key 请求被关闭的模型与范围外模型，验证两者都被拒绝且未消耗上游额度（对比请求前后的用量记录）
- [ ] 12.4 端到端验证导入链路：从 DSH 导入全部账号与黑名单后，验证 `/v1/models` 的可选集合与 DSH 中实际启用集合一致
- [ ] 12.5 端到端验证轮换与限流：人为让某 provider 的首个账号返回限流，验证请求自动由下一个账号完成且用量记录标注的是实际账号
- [ ] 12.6 端到端验证用量闭环：跑一批请求后，验证用量界面汇总的 token 数与各次响应的 `usage` 之和一致
- [x] 12.7 编写并验证 `README.md`：安装、首次启动、从 DSH 导入、接入客户端（OpenAI 与 Anthropic 各一例）、模型开关说明、一次性 refresh token 的操作注意事项；验证文档中的每条命令按原文执行均成功
- [x] 12.8 编写并验证 `AGENTS.md` 的开发约定：目录结构、provider 新增步骤（同族 vs 新族）、移植基线 commit、已知限制（Loomy 不可续期、node:sqlite experimental）；验证其中引用的路径与文件均真实存在

## 13. 入站形态保真（2026-09-29 真实故障修复）

背景：用户报障「访问 `loomy/qwen-3.8-max` 输入一直不变」（28 次请求
`prompt_tokens` 逐字节恒定在 20617）与「`workbuddy/deepseek-v4.1-flash` 报
HTTP 502」。定位为**标准 OpenAI 入站形态**未被归一：工具历史整段丢失、
assistant 字符串正文被吞；并牵扯出 WorkBuddy 的上游 400 两处成因。

- [x] 13.1 `normalizeHarnessMessages` 认**蛇形** `tool_call_id`（此前只认驼峰
      `toolCallId`）——否则工具结果 id 恒为 `undefined`，`resolveToolPairing`
      会把 `tool_calls` 与结果成对剔除
- [x] 13.2 `normalizeHarnessMessages` 把 assistant 的**顶层** `tool_calls`
      搬运为 content 数组里的 `tool-call` 块（与既有块合并、移除原字段），
      使 5 份序列化实现都能正确消费
- [x] 13.3 `normalizeHarnessMessages` 把 assistant 的**字符串** `content`
      升级为 `text` 块（此前被 `Array.isArray` 判成空数组而整段丢弃）
- [x] 13.4 `detectMessageShape` 新增 `openai-native` 形状（顶层 `tool_calls`
      即便在没有工具结果时也要触发归一）
- [x] 13.5 抽取共用 `readSystemText`（字符串 / 内容块数组），
      **网关与 Anthropic 翻译层共用**——此前 OpenAI 入站只认字符串，
      数组形态的 system 被静默丢弃
- [x] 13.6 buddy 适配器：wire 首条不是 `system` 时补兜底 system
      （WorkBuddy 硬性要求 `messages[0]` 为 system，否则 400 `code 11128`
      且被上游伪装成安全策略拦截）
- [x] 13.7 buddy 适配器：`max_tokens` 按模型输出上限收敛（对齐 TRAE 的
      `clampTraeMaxTokens`，含 `DSH_BUDDY_CLAMP_MAX_TOKENS` 逃生门）
- [x] 13.8 网关失败分支补记 `gw.message`（此前只记错误码，导致那次上游 400
      完全无法定位；日志器已统一脱敏）
- [x] 13.9 回归测试：`message-shape.spec`（OpenAI 原生形态 + `readSystemText`）、
      `message-shape-adapters.spec`（把该形态加入「跨形状逐字节等价」不变式）、
      `buddy-adapter.spec`（首条 system 兜底 + max_tokens 收敛）、
      `loomy-adapter.spec`（**出站 body 保真**，含「多轮历史逐轮增长」）、
      `gateway.spec`（system 两形态 + D5 透传契约）
## 14. Loomy / Raccoon 请求级换号与余额选号（2026-09-29）

背景：用户报障「loomy/qwen-3.8-max 报积分余额不足，但不自动切换别的账号」
（排首位的账号积分为 0，凭据有效，每次请求都被选中并失败）。定位为移植缺口：
来源「按余额选号」的接线段（来源 `src/index.ts:614-690`）未移植；
Raccoon 的故障转移则按用户提供的参考实现
`D:/Project/go/token_proxy/xiaohuanxiong2api/raccoon-gateway.js` 补齐。

- [x] 14.1 抽出 `src/providers/current-account.ts`（当前账号登记处独立成模块）：
      换号后适配器必须登记实际用上的账号，否则定向续期（`wiringRefresh`）会刷错
      账号——一次性轮换 `refresh_token` 的 provider 会把仅剩的刷新机会烧在
      错误的账号上。放 wiring 里会让适配器 import wiring 成模块循环依赖
- [x] 14.2 新建 `src/shared/account-failover.ts`：额度不足文案判定
      （中英双语正则，移植自 xiaohuanxiong2api 的实测判据）+ 限流短冷却常量
- [x] 14.3 raccoon 适配器请求级换号：402/403 与额度文案 → 当天锁
      （`modelRateLimits` 标记到 UTC+8 当日 24:00，复用既有存储与选号过滤，
      次日自动回池）+ 换号；429 → 短冷却（30 秒）+ 换号；401 → 刷新当前账号
      一次，仍失败弃用换号（不写标记）；其余错误原样抛出。刷新后按账号 id
      定向取凭据（`resolveCredentialForAccount`），不用会拿回池首选的
      `resolveCredential()`
- [x] 14.4 loomy 适配器同款换号（差异：403 无账号级证据保持刷新后原样抛出，
      402 与 4xx + 额度文案才换号；用户实测形态为 400「积分余额不足」）
- [x] 14.5 loomy wiring 补上来源的按余额分档选号接线（`LoomyBalanceSelector`：
      有今日额度 → 只剩永久 → 无余额/查不到，档内保持手动顺序），并修复
      `modelId` 未透传给 `resolveCredential`（模型级限流过滤失效）
- [x] 14.6 `rotatesAccounts` 如实改登记为 `true`（换号带 `tried` 排除集，
      不会反复重试同一账号）
- [x] 14.7 测试：raccoon 适配器 8 条、loomy 适配器 5 条换号用例
      （402/403/400+文案换号、429 短冷却、试完报 QUOTA_EXCEEDED、
      无文案不换号、401 刷新失败换号、无池保持单账号），wiring 层 3 条
      余额选号接线用例（0 积分排首位也不被选中、modelId 透传过滤、
      锁定永久积分不落到通用兜底）；全量 116 文件 2886 条通过
- [x] 13.10 诊断遗留问题：13.7 只按模型上限收敛后，`workbuddy/deepseek-v4.1-flash`
      仍报同一 502。用 14:44 失败请求的完整 body 重放定位：上游 400
      `code 11133 model_param_invalid`（`extError.message` = "the request
      parameters were rejected by the model provider"，displayMsg 只有
      「请求参数不符合当前模型要求」），同一 body 将 `max_tokens` 从 128000
      降到 1024 即恢复 200 —— 真实成因是 **`prompt_tokens + max_tokens` 超出
      上下文窗口**（该会话 prompt≈929k token，上游 usage 实测，窗口 1048576）。请求的
      消息/工具/配对经逐项核查全部合规（215 个 tool_call 全部配对且具名）
- [x] 13.11 buddy 适配器：`max_tokens` 增加**剩余上下文预算**钳制
      （`clampBuddyMaxTokens` 的 `budget` 形参 = 上下文窗口 −
      `estimatePromptTokens(wire)`，窗口取 resolveModel 同款三级查找；
      预算为正取 min、耗尽保留 `BUDDY_MIN_MAX_TOKENS=1024` 做最后一搏；
      `DSH_BUDDY_CLAMP_MAX_TOKENS=0` 仍整体关闭）。抓取 EasyCLIProxyAPI
      的请求日志（`oauth/logs/error-v1-chat-completions-*.log`）获得失败
      body 的流程：上游原始错误体含 `code`/`extError`，而 `errorDetail`
      只展示 `displayMsg.zh`，两者配合才能定因
- [x] 13.12 buddy 适配器：400/11133 时以最小输出额度**重发一次**并成功即
      正常出流（prompt token 数只能按字符估算、对致密代码偏乐观，钳制后
      仍可能越界；400 不计费，代价仅一次重复上传）。已发过 ≤ 最小额度时
      不重发
- [x] 13.13 测试：`buddy.spec`（`estimatePromptTokens` + `clampBuddyMaxTokens`
      预算维度：只降不升/预算为正/耗尽保留最小额度/逃生门）、
      `buddy-adapter.spec`（大 prompt 预算钳制三态 + 11133 重发三例：
      重发成功出流、重发仍失败报错、已是最小额度不重发）
