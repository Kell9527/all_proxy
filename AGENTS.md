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
5b. **Qoder 的模型目录走远端**（2026-10-20 移植来源 `8b41403` + 审计修复 `8901a4d`）：
   `GET {encryptedInferBase}/api/v2/model/list?Encode=1`，WASM 补 `/algo` 前缀、
   `Bearer COSY.<签名>`、无 body，响应 `{场景:[模型]}` 取 `chat`。
   改造前本家**恒用编译期兜底表**（国际版快照 2026-09-21 / CN 2026-09-27），
   上游改价 / 改免费额度 / 上下架一律不反映（用户报障「DeepSeek-Flash 上游已 0×，
   列表还显示 0.1」）。七个必守点：
   - **`Encode=1` 不保证响应加密**：两站实测都回明文，故解密必须走
     `decryptServerResponseOrRaw`（「失败即明文」是协议的一部分，不是容错洁癖）。
     它与 `decryptModelCatalog` 是**两把不同的锁**（那个解本地 `catalog-v6`、
     第二参是 machineId），混用会得 `AES-GCM decrypt failed`。
   - **档位白名单只有 6 个值、不含 `minimal`**（官方 `k3`）。中文名表保留它只为
     别显示成裸 id，**不要**据此加回白名单 —— 上游会静默丢弃。
   - **`efforts` 三形态都认**（数组 / 逗号或空格字符串 / 对象），且**不要排序**：
     对象键序就是官方 IDE 的渲染序（Issue IKLIDV）。
   - **`available_reasoning_effort` 是一个 `thinking_config` 形状的对象**，必须包一层
     `{thinking_config: …}` 再解析；且按官方 `??` 短路语义，**只在条目自身既无档位
     也无 `disabled` 时**才读它。
   - **`supportsDisable` 与 `efforts` 相互独立**：实测 `gfmodel` 有档位但不能关闭，
     `qmodel` 没有档位但能关闭。别由「有没有档位」反推。
   - **能力/元数据判据取「远端 ∪ 静态表」，菜单（`listModels`）仍远端独占**：
     目录是**按账号**下发的（一个免费额度号上游只给 2 条），若能力判据也只查远端，
     静态表里已知的模型会被判成「未知」⇒ **硬拒图片**、name 退化成裸 id。
     这是第一个提交的真缺陷，审计复现后修掉（见 `catalogModel()` 的表）。
   - **`isFree` 必须真的透出到 `LlmModelInfo`**：前端「免费额度」分组只认
     `model.isFree === true`，解析层产出了但装配层漏写，端到端仍只到「名字带 · 免费」。
   客户端版本闸门：`fast` 只在 `cli ≥ 1.1.70` / `app ≥ 1.1.66` 下发，本项目是
   `cli + COSY_VERSION 1.1.49` ⇒ 天然拿不到，**刻意不抬版本**（会连带改推理签名身份）。
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
12. **腾讯系 `code 11128` 有两个不同子原因，必须看 `msg` 不能只看 `code`**
    （2026-10-19，`docs/07-tencent-11128.md`）：
    - `msg:"request illegal"` / `"conversation id missing"` = **渠道校验**，判据是
      三枚 `X-Conversation-*` 头**同时存在且非空**（`tencent-conversation-headers.ts`）；
      ⚠️ **按账号生效**（来源实测 2/5、3/5 两种比例）⇒「本机不带三头也 200」
      **不能**论证「不必发」，缺任一即对那类账号整条渠道不可用。
      ⚠️ 该措辞**与 11140 共用** ⇒ 分类判据必须同时按 `code === 11128` 收窄。
    - `msg:"Illegal API invocation from an unapproved channel"` = **内容级风控**，
      拦 `system` 与 **`assistant` 正文**里的客户端模板句
      （`tencent-fingerprint.ts`）。⚠️ **`assistant` 那一格不能省**：历史里的正文
      每轮原样重放 ⇒ 「这个 provider 从此每轮都失败，换任何腾讯系模型都一样」
      （跟会话走，不跟模型走）。`user` / `tool` / `reasoning_content` /
      `tool_calls.arguments` 实测**都不拦**，改它们等于篡改用户原话与工具证据。
    - 三族的 `displayMsg` / `displayTips` **逐字相同** ⇒ 绝不能拿它判原因。
    - ⚠️ 指纹改写共**四个产出点**（`serializeMessages` 的 assistant / system 分支 +
      `stream()` 里 `options.system` 的 `unshift`）；`serializeMessages` 是独立函数，
      `provider` 必须作为第三参数传入。将来若新增直发 `/v2/chat/completions` 的代码，
      必须同样调用 `applyTencentConversationHeaders()` 与指纹改写。

13. **`resolveCredential` 必须透传 `modelId`，否则「额度用尽自动换号」形同虚设**
    （2026-10-26 用户报障「用完一个账号的额度，是不是不会自动调度到下一个」）：
    `AccountPool.getAvailableAccount(provider, modelId)` 对**空串**会**整体短路**
    模型级限流过滤 ——

    ```ts
    // src/pool/account-pool.ts
    // 空 modelId（未知目标模型）：无可比对的键，保持候选不变。
    if (modelId.length === 0) return true
    ```

    ⇒ 适配器若用 `resolveCredential()`（不传参）取号，`wiring.ts` 就只能
    `ctx.resolveCredential(provider)`（同样不传 model），于是**刚被标记「该模型额度
    已用尽」的账号在每个新请求里仍被优先选中**。表现：当次请求靠适配器内的换号
    逻辑（`switchAccountOnQuota` / `tried` 排除集）确实切到了下一个账号并成功，
    但**下一个请求又从受限账号开始** —— 每个请求都多打一次必然失败的请求。
    用户体感是「用完额度不会自动换号，得手动把账号拖下去」，而拖拽只是碰巧避开，
    不是机制在起作用。

    **判据与修复**：凡是适配器会调 `accountPool.updateModelRateLimit(...)` 写
    「账号+模型」限流标记的 provider，`resolveCredential` 就**必须**接受并透传
    `modelId`。三处一起改，少一处就漏：
    ① 适配器选项签名 `resolveCredential: (modelId?: string) => ...`；
    ② 适配器**所有**调用点传 `options.model`（首次取号 / 过期续期后重取 /
    认证失败刷新后重取 —— 第三处最容易漏，它在重试循环深处）；
    ③ `wiring.ts` 接线 `(modelId?: string) => ctx.resolveCredential(id, modelId)`。

    **2026-10-26 实测**（临时目录复制真实账号数据，`qodercn` 三账号）：
    把账号 A 的 `dfmodel` 标记为受限后，
    `getAvailableAccount('qodercn', '')` → 仍返回 **A**（错），
    `getAvailableAccount('qodercn', 'dfmodel')` → 正确返回 **B**。
    修复后 `qoder`（CN + 国际版）已合规，回归用例
    `qoder-adapter.spec.ts` 的「resolveCredential 必须收到本次请求的 model」
    锁死这一环（已反向验证：回退调用点后该用例立即失败）。

    ⚠️ **当前仍未修的 5 个**（本次刻意不动，遇到再改）：`buddy` / `workbuddy`
    （共用 `buddy-adapter.ts`）/ `cline` / `lobsterai` / `raccoon` / `sensenova`
    —— 它们**都写** `modelRateLimit`，但 `resolveCredential` 签名是
    `() => Promise<...>`（不接受参数），调用点也全部无参。
    已合规的只有 **`qoder` / `qodercn` / `trae` / `loomy`**。
    修某个 provider 时按上面①②③三处一起改，并补一条同类回归用例。

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
**管理端粘贴入口**（2026-10-15 用户报障「点新建账号提示：provider sensenova
  不支持链接式登录」）：后端能力一直齐全（`POST /api/accounts` +
  `createStaticKeyAccount` + `account.addKey` + `supportsStaticKey`），
  **缺的只是面板里的入口** —— 「+ 新建账号」只有链接式登录一条路，点下去
  必然被 orchestrator 拒绝。已补：`plugin-src/client/static-key-entry.js`
  （纯函数：按钮文案 / 忙碌标签 / 弹窗说明 / 输入归一）+ `jet-hub.js` 的
  分叉（`supportsStaticKey(provider)` → 开粘贴弹窗 → `account.addKey` → 刷新列表）。
  ⚠️ 三条纪律：① 能力判定**只认** `supportsStaticKey`，不另写 provider 名单
  （否则后端新增静态 key provider 时会出现「后端认、按钮不认」）；② 输入先过
  `normalizeApiKeyInput` 剥空白 —— 从控制台复制极易带上换行，原样提交会得到
  一个「看起来对却 401」的账号，而日志不能打印 key 明文，等于无头案；
  ③ 建号**不校验 key 有效性**（后端只写凭据与索引，不打上游），故弹窗常驻一句
  提示把验证手段指到面板既有的「重测」。
**SenseNova 的模型目录走远端 + 兜底表，且远端 `name` 是纯回显**（2026-10-23
  用户提「这个模型列表更新了，刷新一下」时发现）：目录经 `fetchRemoteCatalog`
  三级缓存（内存 → `data/catalogs/sensenova.json` → 兜底表，TTL **6 小时**，
  失败冷却 10 分钟），上游 `GET /v1/models` 现为 **7 条**（6 个文本输出 +
  `sensenova-u1.5-lite` 出图模型，后者被 `parseSensenovaModels` 按
  `output_modalities` 正确滤掉）。三个必守点：
  ① **远端 `name` 逐字等于 `id`**（实测 `{"id":"deepseek-v4-flash","name":
  "deepseek-v4-flash"}`），不是展示名 ⇒ `loadModels` 里有一层 `enrichDisplayName`
  补名：远端的 name 与 id 相同时改用兜底表的美化名，兜底表也没有（上游新增）
  才留裸 id，远端给出**不同** name 时以远端为准。漏了这层，模型选择器会从
  `DeepSeek-V4-Flash` 退化成裸 id —— 接入远端目录时最容易忽略的体验回退。
  ② **目录是全 key 共享的**（2026-10-23 实测 8 把 key 返回同一组 7 条），
  故不存在「某个号看到的不一样」；面板少显示模型先查 `state.json` 的
  `disabledModels.sensenova`（关闭的模型仍可被 `listAllModels` 列出，
  但不出现在 `listModels`）。
  ③ **手动刷新入口**（2026-10-23 用户要求「加一个「刷新模型目录」按钮」）：
  面板「模型列表」弹窗内的「刷新模型目录」按钮 →
  `POST /api/models/refresh-catalog` → `refreshModelCatalog`
  （`src/providers/wiring.ts`）。**必须清三层缓存**，少一层就「点了没反应」：
  ① `catalogMemory`（模块级内存）；② **磁盘快照的新鲜度**（`catalogForceRefresh`
  标记，让 `fetchRemoteCatalog` 跳过「快照新鲜就直接返回、一个字节的网络都不发」
  那条短路 —— 首版正是漏了这层，表现为「刷新看似成功、列表纹丝不动」）；
  ③ **各适配器自己的 `remoteModels`**（`invalidateModelCatalog()`，10 个适配器
  全部覆盖 + 基类 `src/shared/llm.ts` 默认空实现）。另外**失败冷却必须绕过**
  （`catalogFailedAt`），否则「上一次失败后 10 分钟内点按钮」会静默不动。
  ⚠️ **成功判据不能是「listModels 是否抛错」**：所有适配器都在内部吞掉远端
  失败并回退兜底表，远端挂了也会正常返回一份旧目录。真正的判据是**磁盘快照被
  重写**（比较刷新前后的 `fetchedAt`）；据此区分 `succeeded` / `error` /
  `fellBack`，让用户知道看到的是新数据还是旧快照。

**第 12、13 个 provider —— OfficeAce（华为云 ModelArts MaaS）与 Accio（阿里 Accio Work）**
（2026-10-14 从来源 HEAD 移植，均超出移植基线 `3611a62`，故不走 `port-providers.mjs`）：

- **OfficeAce**（`officeace-product.ts` / `officeace-adapter.ts` / `officeace-auth.ts` /
  `officeace-login.ts` / **`officeace-credits.ts`**）：华为云 OAuth + PKCE + **DPoP**
  登录，推理走 `Authorization: Basic base64(app_key:app_secret)`；**OpenAI 兼容**（复用
  `shared/openai-compat.ts`）。必须记住的点：① **`maasBaseUrl` 必须优先用凭据里
  按账号下发的 host**（硬编码默认域会 401 `APIG.1009`）；② `max_tokens < 4096` 直接
  丢弃（否则思考链烧光预算、正文零产出）；③ **DPoP 私钥随凭据 JSON 落盘**（刷新必须
  同一把），refresh_token **一次性**（进 `ROTATING_REFRESH_PROVIDERS` + `RefreshCoordinator`）。
  裁掉了来源的 Windows 迁移桥（Redis 6399 / DPAPI / PowerShell）与本地 `127.0.0.1:3004`
  API / 订阅磁盘缓存（多账号下本地 cookie 无法按 ref 区分账号，缓存则是第二个数据源）。
  **模型目录走远端**（2026-10-27 修，用户报障「为什么这个不会刷新缓存？」）：
  面板「模型列表」恒显示 `8 个模型` + `远端未返回目录，仍显示本地缓存（8 个模型）`，
  点「刷新模型目录」纹丝不动。根因是 `wiring.ts` 注册时**从未**传
  `fetchRemoteModels`，适配器连这个选项都不存在，`listModels` 恒返回
  `OFFICEACE_MODELS` 里 2026-10-13 写死的 8 条 —— 而上游 `/v2/models` 实测已返回
  **26 条**（新增 kimi-k3 系列、openpangu、deepseek-v4-pro、glm-5.3-flash 等）。
  那句「远端未返回目录」是**误导性文案**：不是远端挂了，而是根本没有远端请求。
  ⚠️ 这是同一个缺陷的**第 5 次重演**（codearts / raccoon / sensenova / loomy 之后），
  模板与另外四家同构：`fetchRemoteModels` 选项 + `remoteModels` 缓存 +
  `invalidateModelCatalog()` + `wiring.ts` 的 `fetchRemoteCatalog('officeace', …)`。
  六个必守点：
  - **目录端点与 probe 是同一个 `/v2/models`**，只能靠请求头区分：`probe()` 只发
    `Authorization`，`fetchOfficeAceRemoteModels()` 另发 `Accept: application/json`。
    两者语义**不可合并**：probe 判「凭据还有效」，失效时返回**空目录**（隐藏分组，
    与未登录同形）；拿它当目录来源的话，凭据一失效就退化成播报兜底表，用户看到
    8 个模型、点了却全 401。
  - **目录取号不能走 `ctx.resolveCredential('officeace')`**：那条路径是
    `officeaceExpirySelector`（按积分到期分档），今日额度用尽或锁定永久积分时会
    **抛错**，把「拉目录」连坐成失败。用 `firstUsableOfficeAceCredential`
    （`listAccountsByProvider` 顺序、不按 `enabled`/积分过滤），与 Loomy/Raccoon 同源。
  - **必须用凭据里按账号下发的 `maasBaseUrl`**（打硬编码默认域 = 401 `APIG.1009`
    ⇒ 静默退兜底表，与本文件第 ① 条同因）。
  - **上游只返回 `{id, object, created, owned_by}`，没有 `name`** ⇒ 展示名必须本地生成
    （`officeaceDisplayName`：兜底表命中用表里的美化名，否则按 `-`/`.` 分段、
    厂商段查词表、其余段首字母大写）。漏了这层，模型选择器会从 `DeepSeek-V4.1-Flash`
    退化成裸 id `deepseek-v4.1-flash-1017` —— 与 SenseNova 接远端目录时踩过的体验回退同型。
  - **`-test` 档必须过滤**（`glm-5.3-test`、`kimi-k3-test-1009`）：兜底表从来没暴露过
    上游灰度条目，接了远端不滤就会涌进选择器。实测 26 条过滤后是 **24 条**。
  - **`catalogSource` 改成 `remote-first`**（原为 `static-only`）。注意这个字段本身
    **没有行为消费点**（只是描述），真正的行为来自 `fetchRemoteModels` 是否注入 ——
    所以只改描述不接线等于没改。
  回归用例：`tests/unit/officeace-remote-catalog.spec.ts`（14 条，含
  `refreshModelCatalog` 端到端「刷新后能看到上游新增」）。⚠️ 写这类用例时注意
  `probe` 走的是**全局 `fetch`**，不是注入的 `fetcher`，必须同时 `vi.stubGlobal('fetch', …)`。
  **积分**（2026-10-14 补齐，用户报障「本地仅显示登录状态，无其它显示」）：V11-HMAC-SHA256
  签名云侧直读 `GET {defaultBaseUrl}/v1/subscription`（`officeace-credits.ts`，三条签名
  规则见文件头），**每日福利**走 `POST /v1/subscription/bonus/claim`（实测活动
  `bonus-daily-checkin-2026` = **100 分/天**，`expired_time` 折合 UTC+8 当日 23:59:59
  作废；UI 上没有手动签到这回事）；分桶「永久/长期/临期」由前端按 `expiredTime` 与
  `windowDays` 算。「锁定永久积分」已泛化为 per-provider
  （`pool.setPermanentLocked` + `PATCH /api/permanent-lock`）。
  **每日福利必须由定时器领，不能只在拉余额时领**（2026-10-23 修正）：原实现的唯一
  调用点是管理端拉积分余额，于是「用户不开面板」= 当天额度白作废（用户报障
  「刚刚我在客户端打开了，然后登录领了 100 分」—— 是**打开面板那个动作**领的，
  不是服务自己领的）。现由 `claimOfficeAceDailyBonuses`
  （`src/refresh/runtime-helpers.ts`）在**启动时 + 每小时**兜底，去重按 **UTC+8
  自然日**（`officeAceDayKey`，不取本机时区）。三条纪律：① 只领 `enabled` 账号
  （与续期相反 —— 续期不看 `enabled` 是因为 refresh_token 会一路放到失效，而这里
  只是少一份当天额度，越界给用户弃用的账号发写请求更糟）；② **失败不记日期**
  （早期「先标记再请求」的实现，一次网络抖动就把当天记成已领，该账号整天不再
  重试）；③ 领取前按需续期（STS 寿命约 2 小时，走 `refreshAccountOnce` 与定时
  续期共用同一单飞协调器）。
  **手动补领**（2026-10-23 用户要求「加个手动，防止定时任务没领到」）：
  `POST /api/credits/daily-bonus` → `claimOfficeAceDailyBonuses({ force: true })`，
  面板按钮「补领今日福利」（`supportsDailyBonus` 能力位，只有 officeace 为 true）。
  为什么需要它：定时任务只在**进程活着**时跑，用户关掉服务过夜、或跨天后才启动
  时会错过当天窗口（额度按 UTC+8 自然日作废）。三条纪律：① 手动必须 **`force`**
  跳过去重闸门 —— 否则「今天定时任务已经试过」会让按钮点了毫无反应，看起来就是
  坏的；② 领取后**仍更新去重表**，故定时任务不会因此重复打上游（上游对重复领取
  幂等：回 HTTP 200 + 空桶）；③ 响应形状是 `{summary, results}`，与
  `keepAliveDailyPoints` 对齐 —— 直接把 sweep 结果吐出会让前端 `summary`
  变 undefined（已由 `credits-daily-bonus-api.spec.ts` 锁死）。
  ⚠️ 它是**第三类**积分操作，三个能力位不可混用：`balance`（查余额）、
  `dailyCheckin`（OfficeAce 恒 false，每天必须手动点的语义会误导）、
  `dailyKeepalive`（raccoon 专用，把已到账积分延长有效期，**不产生新分**）。
  **新建账号不自动开窗**（2026-10-14 用户报障「每次都会自动登录同一个账号」）：
  华为云授权页是 **SSO 页面**，浏览器里已登录的账号被**静默复用**（授权瞬间完成，
  用户看不到选账号的界面），自动 `window.open` 等于替用户决定用哪个账号。来源的解法
  是宿主 spawn 无痕窗口（`openIncognitoWindow`），但 Web 服务可能跑在远程/无 GUI
  机器上，spawn 的是服务端浏览器——不可行。故本项目**只展示链接**，由用户自己决定
  在哪个浏览器/无痕窗口打开（`plugin-src/client/login-window-policy.js`；
  轮询式授权在任意机器上完成都会落账号）。另加**账号判重**
  （`src/login/officeace-dedupe.ts`，按凭据 `accountId`）：用户不小心把同一账号
  授权多次时不堆重复条目，新凭据写回既有 ref（refresh_token 一次性轮换，旧那份
  已作废），`poll` 报 `reused` 让前端提示「该账号已在池中」。
  **授权成功但账号没添加**（2026-10-14 用户报障「网页提示欢迎使用 OfficeAce，
  请返回客户端体验，但账号没有添加」）——授权其实成功了，问题在收割端，三处
  缺陷叠加：① 前端轮询 **5 分钟**就停、后端会话 10 分钟才清 ⇒「后端落了账号、
  界面不刷新」，用户看到旧列表；② `officeace-login.ts` 把「轮询 code」与
  「换 token」放同一个 try，换 token 失败被当成「本轮没授权」吞掉后继续轮询，
  而 code 很可能一次性 ⇒ 之后每轮取不到，空转到超时且**零错误提示**（原注释
  还写着「由下面的分支区分」而分支根本不存在）；③ 不自动开窗后授权链变长
  （复制链接→换浏览器→登华为→授权），10 分钟经常不够。现修为：两阶段错误
  分离（换 token 失败立刻 reject 带原文并记日志）、两端超时统一 **30 分钟**、
  前端显示「已等待 X 分 Y 秒」与超时后可操作提示。华为云侧实测：state 注册
  匿名 200，未授权时 `/auth/code` 返 **HTTP 202 + `not ready`**（`Response.ok`
  含 202，靠「无 code 字段」判未就绪 —— 改动 `pollLoginCode` 时勿「顺手」加
  `status === 200` 判据）。
  **「授权后账号没加进来」的最终结论**（2026-10-14 用户二次报障，日志实证）：
  授权链路完全正常（`已取得授权码 → 登录成功 accountId=bca660e1…`），账号
  **本来就加过**——用户在无痕窗口里登的仍是**同一个华为账号**，判重正确生效
  （`已在池中，未重复添加`）。⚠️ 华为授权页**不提供选账号**，它直接用浏览器
  已登录的账号授权 ⇒ 加新账号必须在无痕窗口登**不同的华为账号**。这条已写进
  链接提示与判重提示的文案（用户看不到区别就会一直困惑）。另：`completeLogin`
  成功后 `cancelled`（会话被 TTL 取消/服务重启）时必须留痕，静默丢弃凭据会把
  「授权成功但账号没进来」变成无头案。
  **「另一个账号也加不进来」的真相**（2026-10-14 用户三次报障，`err.log` 实证）：
  授权与 token 交换都成功，但 `fetchModelInfo` 拿不到 `model_app_key/secret` ——
  **那个华为账号没有开通 ModelArts MaaS**（OfficeAce 的推理走 MaaS）。后端早
  就明确 reject 了，是**前端把失败吞了**（rpc-bridge 的 `login.poll` 对业务
  failed 用 throw，而 `createAccount` 的 catch 静默继续轮询）⇒ 用户只看到华为
  云「欢迎使用」页和沉默的界面。已修：业务失败返回 `failed` 标记（不再 throw）、
  前端停损并显示原因；`fetchModelInfo` 的错误文案讲清「未开通 + 怎么办」。
  ⚠️ 排查这类问题的顺序：先看 `data/run/all-proxy.out.log` / `all-proxy.err.log`
  （console 日志走 stdout，proxy.bat 只重定向 out/err 两个文件，**warn 在 out**）。
  **积分按到期顺序消耗**（2026-10-15 用户要求「先消耗临期的，等所有账号临期的没有了，
  再消耗长期的，最后才是永久的」）：OfficeAce 的积分是「一组带到期时间的包」，按账号
  数组顺序取第一个会把排首位的**永久**积分先烧掉，而别的账号里的**临期**积分到期作废。
  实现与 Loomy 的 `loomy-balance-selector.ts` 同构：`officeace-expiry-rank.ts`（纯函数：
  分桶 `splitOfficeAceCreditGroups` + 分档 `officeaceExpiryTier` + 稳定排序
  `rankOfficeAceAccountsByExpiry`）与 `officeace-expiry-selector.ts`（60 秒 TTL 缓存 +
  查询），接线在 `wiring.ts` 的 `resolveCredential` 里。三条纪律：① **档内保持手动顺序**
  （`expiring` → `longTerm` → `permanent` → `unknown` → `empty`，档内不重排，拖拽仍然有效）；
  ② **查询失败归 `unknown` 档而不是抛错** —— 全部查不到时稳定排序退化成手动顺序，
  与加本模块之前的行为一致；③ **查询走只读的 `fetchOfficeAceCloudSubscription`**，不用
  `fetchOfficeAceBalanceDetailed`（后者会在查询前触发「自动领当日福利」的 POST，推理
  请求路径上不该有写操作）。分桶口径必须与面板逐字同源（同一份 `creditGroups`、同一个
  `OFFICEACE_EXPIRY_WINDOW_DAYS = 15`、同一条「已失效/剩余 ≤ 0 不计入」），否则用户会
  在面板看到「临期 2000」却被永久账号抢走请求。顺带把**锁定永久积分**在 OfficeAce 上
  真正接上了（按钮前端早就有，后端此前不认）：锁定时 `permanent` / `unknown` / `empty`
  一律不可用，全部不可用即报「没有可用账号」而不是烧永久积分。
  面板说明（≥ 2 个账号时常驻）在 `plugin-src/client/officeace-consume-order.js`。
- **Accio**（`accio-product.ts` / `accio.ts` / `accio-oauth.ts` / `accio-messages.ts` /
  `accio-adapter.ts` / `accio-auth.ts` / `accio-login.ts` / **`accio-credits.ts`**）：
  标准 OAuth 2.0 + **PKCE**（回调落本项目自己的 loopback），推理是 **Gemini 族协议**
  （复用 `gemini-messages.ts` 的 `consumeGeminiSse` + 一层薄归一化）。必须记住的点：
  ① **`token` 必须在请求 body**（放 Authorization 头恒流内 402）；② **`system_instruction`
  必须是字符串**（对象形态恒 HTTP 200 + 流内 400）；③ **对外 id 是「人话」slug、上行须
  反查上游 `modelCode`**（漏映射症状是「模型不回复」这种误导性形态）；④ **HTTP 200 也可能
  是风控拦截页**（必须校验 `content-type: text/event-stream`）；⑤ **三个积分端点传参方式
  各不相同**（`userinfo` POST + body、`currentSubscription`/`quota` GET + query，用错即
  405/400，见 `accio-credits.ts` 文件头），且 `code` 可能是**数字**（判未登录必须标量归一）。
  refresh_token **轮换**（进 `ROTATING_REFRESH_PROVIDERS`）。图片通路未实测 ⇒
  `inputModalities` 恒省略、收到图片显式 `UNSUPPORTED_CONTENT`。
  **登录区域**（`cn`/`global`）经 `POST /api/login/start` 的 `region` 字段透传
  （`orchestrator.start(provider, method, { region })`），管理端「+ 新建账号」先弹区域
  预选；缺省与非法值归一成 `cn`。

**测试**：来源 `tests/unit/` 的 84 个文件经 `scripts/port-tests.mjs` 移植，
加上本项目自写的（`llm` / `account-pool` / `gateway` / `divergence-gating` /
`sensenova*` / `officeace*` / `accio*` / `trae-cooldown-table` / `serial-queue` /
`expiry-sync` / `accio-credits` / `officeace-credits` /
`credits-endpoint-accio-officeace` / `credit-expiry` / `permanent-lock` /
`provider-toggle` / `provider-switch-api` / `instance-watchdog` /
`login-window-policy` / `officeace-dedupe` / `officeace-login` /
`account-phone` / `static-key-entry` / `officeace-expiry-rank` /
`officeace-expiry-selector` / `officeace-consume-order` /
`officeace-remote-catalog` / `qoder-catalog` /
`raccoon-remote-catalog` / `reasoning-effort-passthrough`）。
当前 **153 个文件 3515 条用例**（2026-10-27 实测；其中
`buddy-oauth.spec.ts` 1 条 + `officeace-expiry-selector.spec.ts` 3 条是
**时间相关的既有用例**失败 —— fixture 的到期时间锚在 2026-10-15，已过期，
与本项目改动无关，`git stash` 后在改动前的基线上复现同样 4 条；
`gateway-auth.spec.ts` 1 条偶发，单独跑通过）。

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
   `STATIC_KEY_PROVIDERS`，前端 `supportsStaticKey()` 才会渲染「粘贴 API Key」按钮
   （文案与输入归一在 `plugin-src/client/static-key-entry.js`，接线见 `jet-hub.js`
   的 `addStaticKeyAccount`；`supportsStaticKey` 目前在 `credits-capabilities.js`
   里按 provider 字面量判定，新增静态 key provider 时**两边都要加**）；
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
- **`proxy.bat` 启动前自动检测产物新鲜度**：`dist` 旧于 `src`、或 `web/dist` 旧于
  `web/src` 与 `plugin-src/client` 时，先重新构建再启动（2026-10-14 用户两次追问
  「通过这里的重启能生效吗？」——restart 只换进程、不编译，修复没进 dist 就不会
  生效）。改 `proxy.bat` 要改 `scripts/proxy.bat.src`（UTF-8 源）再转换：
  `sed 's/$/\r/' scripts/proxy.bat.src | iconv -f UTF-8 -t GBK > proxy.bat`。

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
  ⚠️ **`QoderEncryptedInfer` 每次用完必须 `dispose()`**（推理与目录请求都是）。
  它持有 wasm `QoderContext`，进程级共享的堆只增不减，长会话最终以裸
  `RuntimeError: unreachable` 暴毙。目录请求是**周期性**的，漏释放比推理路径
  累积更快。释放失败**不得**顶替 `try` 里的原始错误（`finally` 里 `throw` 会
  无条件覆盖，把上游 401 改写成「WASM 堆耗尽」并丢掉可重试性判据）。

## 数据与安全

- `data/` 含账号凭据（refresh token 等同账号凭证）、API Key 与用量库：**绝不提交、绝不外泄**。
- 日志与错误响应中**不得**出现凭据、refresh token、API Key 明文。
- 管理端默认只监听 `127.0.0.1`；改为对外监听时必须强制设置管理凭据。
- 导入 DSH 数据是**只读**的：永不写回 `.credentials.yaml` 或 `jet-hub/state.json`。

## 思考等级的观测口径（2026-10-23 补）

用户问「最近请求都用什么思考等级」时**查不到** —— 网关从请求体读了
`reasoning_effort` 却只传给适配器，既不落库也不进日志，`usage_records`
19 列里没有这一项。现已补采（列 `reasoning_effort`，`UsageRecord` /
`RequestRecord` 同名可选字段，面板「思考等级分布」+ 最近请求表格新增一列）。

四条必守点：

1. **记的是入参，不是上游实际生效的档位**。两者会分叉：① 部分适配器整段丢弃该
   参数（`sensenova` / `loomy` / `raccoon` / `officeace` / `accio` /
   `llm-adapter` 对 `reasoningEffort` 的引用数是 0，只有 `buddy` / `trae` /
   `cline` / `qoder` 真的下发）；② 模型自身声明 `defaultEffort` 时客户端不传
   也会有思考。故列名与文案都写「请求的等级」，**不要**改称「实际档位」。
2. **空串 = 未指定，不是「没有思考」**。客户端不传、走 Anthropic 协议（翻译层
   `translateAnthropicRequest` 不读 `thinking`，故该路径恒空串）、以及本列上线前
   的 7847 条历史记录都落在这一桶。面板因此把空串显示成 `--` 而不是 `none`。
3. **采集点在网关、由 `report()` 统一兜底**，不在每个 `report()` 调用点各写一遍
   —— 漏一处就会出现「某条分支显示未指定」，而这种缺失在数据里与真实情况长得
   一模一样，事后无法分辨。为此 `reasoningEffort` 用 `let` **先声明再赋值**：
   解析请求体失败的分支里 `report()` 在赋值前就被调用，用 `const` 会撞 TDZ
   （与 `target` 同款坑，见 `report()` 的注释）。采集位置在模型解析**之前**，
   故被开关拦掉的 404 也带着档位。
4. **旧库必须显式补列**：`CREATE TABLE IF NOT EXISTS` 对存量表毫无作用，加列语句
   整条被跳过，随后 `INSERT` 会因列不存在抛错并被 `record()` 吞成一条告警 ——
   表现是「用量页从此一条新记录都没有」，极难归因。故 `UsageStore.addMissingColumns()`
   每次启动按 `PRAGMA table_info` 比对补齐（新增列时追加到它的 `added` 表里）。
   实测在真实库（7847 条）副本上迁移：19 → 20 列、历史零丢失、写入与筛选正常。

筛选用 `?reasoningEffort=`，且**空值是有效查询**（筛「未指定」那批），故
`usageQueryFromUrl` 用 `has()` 判存在而不是判非空。

### 思考等级的上游透传：四个适配器、四张不同的能力表（2026-10-23 补）

同一批改动里给 `loomy` / `sensenova` / `raccoon` / `officeace` 补上了
`reasoning_effort` 透传（此前**整段丢弃**：`grep reasoningEffort` 零命中，
表现为「用户选了 max、实际按默认档跑」，而用量库记的是入参所以看不出来）。
`accio` **刻意不动**（用户明确要求）。

⚠️ **四家的合法取值各不相同，且非法值一律 400（不是忽略）** —— 白名单是硬需求，
不是洁癖。判据全部来自各上游**自己的报错文案**（2026-10-23 实测，传 `bogus_xyz`）：

| provider | 合法档位 | 上游原文 |
|---|---|---|
| `sensenova` | none, minimal, low, medium, high, xhigh, max, **ultra** | `field ReasoningEffort invalid, should be one of: …` |
| `officeace` | none, minimal, low, medium, high, xhigh, max（**无 ultra**） | `ModelArts.81001 … 可选值为：none、minimal、low、medium、high、xhigh、max` |
| `raccoon` | **仅 low / high / max** | `reasoning_effort must be one of low, high, or max.` |
| `loomy` | low, medium, high, max, xhigh（无 minimal / none / ultra） | `level "…" not supported, valid levels: low, medium, high, max, xhigh` |

三条纪律：

1. **白名单外的值静默丢弃**，不照发。档位不是请求的必要条件 —— 为它把整条请求
   打成 400 是明确的优先级倒置。四条实现都是 `SET.has(… ) ? {…} : {}` 的形状。
2. **`loomy` 的 `xhigh` 归一成 `max`**（参考实现 `loomy-gateway.js` 原文：
   「思考强度归一化：xhigh 视为 max」）。透传前不归一会让同一档位在
   「走参考网关」与「走本服务」两条链路上行为不一致。
3. **不要在这几家之间互相照抄档位表**：`sensenova` 有 `ultra` 而 `officeace`
   没有，两者同属商汤/华为系；`loomy` 与 `raccoon` 都只有三到五档。照抄会让
   合法档位被静默丢掉、或非法档位被发出去。

⚠️ **这与 ZCode 里「只显示 3 个档位」是同一件事的两面**：`raccoon` 那类模型
在客户端只出现 low/high/max，正是上游能力表如此（不是界面缺陷）。给 8317
这类中间层的模型声明 `thinking.levels` 时，**声明的也必须落在该上游的白名单内**——
声明了上游不认的档位（如给 raccoon 加 `medium`），网关会按自己的默认表夹取，
最终仍与预期不符。

## 已知限制

- **`buddy` / `workbuddy` / `cline` / `lobsterai` / `raccoon` / `sensenova` 的
  「额度用尽后不自动跳过」**（2026-10-26 发现，刻意未修）：这些 provider 都会写
  `modelRateLimits`，但 `resolveCredential` 不接受 `modelId`、调用点也无参，
  导致 `getAvailableAccount(provider, '')` 短路限流过滤 ⇒ 额度已用尽的账号
  在每个新请求里仍被优先选中，每个请求都白打一次再换号。`qoder` / `qodercn`
  已于 2026-10-26 修复。**症状**：日志里同一账号的额度错误反复出现；
  **修法**见「移植时**必须保持**的来源约定」第 13 条（三处一起改）。
- **Loomy 没有 refresh 端点**：token 过期只能重新登录（故主路径用手机号验证码，成本低）。
- **Loomy 的远端模型目录也曾漏接线**（2026-10-23 用户报障「loomy 模型刷新没，
  提示远端未返回目录，仍显示本地缓存（3 个模型）」）：`wiring.ts` 注册时**从未**
  传 `fetchRemoteModels`，`loadModels()` 永远走 `loomy-product.ts` 里 2026-09-26
  写死的 8 条兜底表 —— 上游后来上架的 `spark-x2.6` / `auto` 一律看不到。点「刷新
  模型目录」得到的「远端未返回目录」是**误导性文案**：不是远端挂了，而是根本没有
  远端请求。现已接上 `fetchLoomyRemoteModels`（`GET {apiBase}/models`）。三条必守点：
  ① **只发小写 `token` 头**（`loomyBusinessHeaders`），带 `Authorization: Bearer`
  会被判「缺少 token」；② 目录取号走 `firstUsableLoomyCredential`，**不能**用
  `ctx.resolveCredential` —— 后者按余额分档选号，今日额度用尽或锁定永久积分时会
  抛错，把「拉目录」连坐成失败；③ 上游实际 10 条 chat（含 `auto` 自动路由），
  比兜底表多 2 条。⚠️ 这是同一个缺陷的**第 4 次重演**（CodeArts 漏 `glm-5.3`、
  Raccoon 漏 `sn-deepseek-v4-1-flash-1017`、SenseNova 漏 `deepseek-v4.1-flash`、
  **OfficeAce 漏 24 条（2026-10-27，见上文 OfficeAce 条目）**）：
  新增 provider 时必须同时确认 `fetchRemoteModels` 接线，否则兜底表会永久冻结。
  ⚠️ **判据只有一条**：`grep -n "fetchRemoteModels" src/providers/wiring.ts` 里
  每个 provider 都必须命中。`catalogSource: 'remote-first'` **不能**作为依据 ——
  那个字段没有任何行为消费点，写对了也不代表真的会发请求（OfficeAce 一直写着
  `static-only`，改成 `remote-first` 本身也不会让它开始拉远端）。
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
- **Raccoon 的「候选端点都调不通」必须按根因分成两类提示**（2026-10-14 用户报障
  「3 个上游暂时不可用 — code=200003 authorization_verify_error（请稍后重试）」）：
  - **鉴权失效**（`HTTP 401` / `code=200003 authorization_verify_error`）⇒ 凭据已被
    服务端作废，**重试永远不会好**，必须重新登录。判据见 `isRaccoonAuthVerifyError`；
  - **上游暂时不可用**（`HTTP 503` / `code=200903 service_unavailable`）⇒ 稍后重试即可。
  旧实现把前者并入后者，用户照着重试无数次依旧失败、还误以为功能坏了。
  现在 `keepAliveRaccoonDailyPoints` 返回独立的 `auth-expired` 结果，
  `fetchRaccoonCreditBalanceDetailed` 返回 `auth-expired` / `unavailable` / `no-data`
  三种带原因的结果，前端 `jet-hub.js` 汇总里单独计 `summary.authExpired`。
  ⚠️ 判据不能只看业务码：实测同一故障有时只体现在 `message` 里，故三条判据（401 /
  `200003` / 文案含 `authorization_verify_error`）取或。
- **Raccoon 的 `X-Org-Code` 只能放真正的组织码**（2026-10-14 实测）：官方客户端往
  共享凭据文件里写的 `office_identity` 是字面量 `'personal'`，原样发出去会让
  `/points/v1/balance` 回 `HTTP 400 code=200022 org_not_found_error`。个人账号必须
  折叠成空串（`raccoonHeaders` 里的 `orgCodeOf`）。
  ⚠️ **拉模型目录也吃这条**（2026-10-21 实测 `model_catalog` 同错）：`fetchModels`
  早期自己手写了请求头、没复用 `raccoonHeaders`，个人账号因此拿不到目录而静默
  回退兜底表。现统一走 `fetchRaccoonRemoteModels`（内部调 `raccoonHeaders`）。
- **Raccoon 的模型目录必须由 `wiring.ts` 注入 `fetchRemoteModels`**（2026-10-21
  用户报障「这个模型列表更新了，看看为什么没有跟进」）：不注入时适配器只播报
  `raccoon-product.ts` 里 2026-09-26 写死的 6 条兜底表，上游后来上架的
  `sn-deepseek-v4-1-flash-1017` 等一律看不到 —— 与 CodeArts 漏接 `glm-5.3`
  是同一类缺陷（`ee33dd2`）。
  三个必守点：① 账号无关 ⇒ 用 `firstUsableRaccoonCredential`（`listAccountsByProvider`
  顺序、**不按 `enabled`/限流过滤**，`getAvailableAccount` 会让全停用时目录退回兜底表）；
  ② 走 `fetchRemoteCatalog('raccoon', …)` 的三级缓存（内存 → `data/catalogs/raccoon.json`
  → 兜底表），别绕过缓存直连；③ 该解析函数是 `raccoon-auth.ts` 导出的纯函数 ——
  装配层没有 `RaccoonAuth` 实例，**不要**为接目录去 new 一个 service（会带出定时器）。
  回归用例：`tests/unit/raccoon-remote-catalog.spec.ts`
  （注意其每个用例都要 `vi.resetModules()`，因为目录缓存是模块级单例）。
- **Raccoon 账号的「重测」也必须分派适配器**：`account-probe.ts` 的分派表已两次因
  「新增 provider 没同步」出缺陷（workbuddy、trae），raccoon 是第三个会写
  `modelRateLimits` 的 provider，漏分支会让它落到 CodeArts 的华为 HMAC 签名分支。
- **账号卡片「凭据」一栏显示手机号**（2026-10-14，用户要求「跟 Loomy 一样」）：
  Loomy 的凭据 JSON 里本来就有 `phone`，`GET /api/accounts?provider=…` 的
  `credentialDisplay` 直接显示它。raccoon / accio 的登录响应**不回传**手机号，
  故 `src/admin/account-phone.ts` 对这两家补一层**只读**上游查询（raccoon
  `GET /v1/user_info` → 完整号；accio `POST /api/auth/userinfo` → 上游脱敏的
  `maskedMobile`，原样呈现），结果**只在进程内缓存、绝不写回凭据** ——
  读-改-写不在刷新单飞锁内，会与一次性 `refresh_token` 的轮换互相覆盖。
  ⚠️ **OfficeAce 没有手机号可显示**：华为云 OAuth（scope 仅 `openid`）不下发，
  `client-permission-validate` 只有 `account_id` / `principal_urn`，
  `/v1/subscription` 只有 `domain_id`，`/v1/claw/{user,user_info,account,profile}`
  全部 404（2026-10-14 实测）。故它退一档显示 `accountId`（与登录日志同源）。
  ⚠️ 文件引用（`FILE:`）仍显示脱敏路径，不显示手机号 —— 与 Loomy 的既有行为一致。
- **关闭的供应商不在左侧导航显示**（2026-10-15 用户要求「当供应商列表关闭时，直接不要在
  左侧显示」）：`JetHubPage` 挂载时读一次 `provider.list`（后端纯内存，不碰上游），左侧
  rail 只渲染 `visibleRailProviders` 的结果。配套的三个约束：① 状态**读不到时全量显示**
  （初始 `null` 即全量；读失败保持旧值）—— 藏不藏是展示层的事，不能因为一次失败让供应商
  「莫名消失」；② 选中的那个被关掉时换到第一个可见项（`resolveRailSelection`），否则右侧
  会显示一个左侧看不见、点不到的供应商；③ 全部关掉时导航与主区都给空态说明 + 「打开供应商
  总开关」入口，不留无说明的空白。弹窗每次成功切换后经 `onChanged` 回调刷新导航（不是
  `onClose`：用户可能连切几个再关）。
- **`node:sqlite` 是 experimental**：启动时会打印警告，属预期。
- **来源与本项目会逐渐分叉**：来源的缺陷修复不会自动同步；需要时按上表基线 commit
  对照 cherry-pick。

## 工作方式

- 规格与变更提案在 `openspec/`，实现前先读对应 change 的 `proposal.md` / `design.md` / `tasks.md`。
- 每完成一个任务就更新 `tasks.md` 的复选框。
- 实现与规格冲突时**先停下来说明**，不要静默缩小或延后规格中已写明的要求。
