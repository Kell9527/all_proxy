# AGENTS.md — all_proxy 开发约定

## 语言约束

- **推理输出**（thinking / reasoning）一律使用中文。
- **正文输出**（正文回复、代码注释、文档、提交信息）一律使用中文。
- 代码标识符、关键字、类型名称、变量名保持英文不变。

## 项目概述

`all_proxy` 把 **15 个 AI 平台**的账号聚合成一套标准 **OpenAI + Anthropic 兼容 API**，
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
| 模型寻址 | 裸模型 id（provider 由适配器路由隐含） | **强制 provider 前缀** `<provider>/<model>` | 15 个 provider 之间重名严重（`deepseek-v4-flash`、`glm-5.2` 等多处重复） |
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
   ⚠️ **排队等待是「每账号 1 分钟」且超时即换号**（2026-10-27 用户要求，已偏离来源的
   「死等同一账号」）—— 见「已知限制」的 Qoder 排队条目。额度换号会**写限流标记**，
   排队换号**不写**（排队是暂时状态，标记会锁掉好账号一整天）。
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

14. **入站 `image_url` 块必须原样透传，不能只认 harness 原生附件块**
    （2026-10-29 用户报障「qoder cn 的 DeepSeek-Flash · 免费 无法识别图片」）：
    网关把图片交成上游要的 `{type:'image_url', image_url:{url}}` 形态
    （`/v1/messages` 由 `anthropic-protocol.ts` 翻译，OpenAI 原生请求本就如此），
    **没有** harness 的 `{type:'image', attachment}` 块。而共享序列化层只认后者，
    于是两处同因、缺一不可：
    ① `collectImages()` 对 `image_url` **零命中** ⇒ 适配器认为「本请求无图」⇒
    传给 `serializeMessages` 的 `imageUrls` 是 `undefined`；
    ② `serializeMessages` 又在 `imageUrls === undefined` 时**整段跳过**
    `userContentParts` ⇒ 那些块连 `[image unavailable]` 占位符都没有，直接消失。
    **症状极具误导性**：HTTP 200、正文正常、上游零报错，只有答案是「我看不到图片」
    —— 用户会误判成「这个模型不能识图」，而目录里 `is_vl` 明明是 `true`。
    ⇒ 修法两半：`userContentParts` 加 `image_url` 分支（原样放进 parts）；
    `serializeMessages` 的判据改成「有映射表 **或** 内容里本来就带 `image_url` 块」。
    ⚠️ **四处副本都要改**：`shared/openai-compat.ts`（qoder / cline / loomy /
    raccoon / sensenova 共用）+ `buddy-adapter.ts` / `lobsterai-adapter.ts` /
    `trae-adapter.ts` 各自内联的 `userContentParts`/`serializeMessages`
    —— 只改共享那份，另外三家的识图同样是坏的（且症状一模一样）。
    ⚠️ **纯文本仍必须输出字符串**：无图时把 content 包成
    `[{type:'text',…}]` 会被上游以 `model_param_invalid` 400 拒收整个请求。
    回归用例 `tests/unit/inbound-image-passthrough.spec.ts`（6 条 + 1 条
    `collectImages` 通路隔离）。⚠️ 这与插件侧 `analyzeImage` 那条已修缺陷
    （`9acddc7`）**完全同型** —— 移植时只搬了「附件块」那条腿。

15. **腾讯风控指纹有三条是 DSH 自己注入的**（2026-10-30 从来源 `82d007a` 等补齐）：
    `You are an AI agent powered by DeepSeek Harness`（身份首句）、
    `You are interacting with the user through the DeepSeek Harness Web GUI …`（Web 运行面两句）、
    `Tokens prefixed with @ are paths the user explicitly referenced. …`（`@` 文件引用说明句）。
    前三条（ZCode / Claude 身份句 / 反馈句）是**概率性**命中，这三条是 DSH **每轮必带**
    ⇒ 漏登记 = 必然 400，且无法靠「换会话 / 清历史」规避。四条必守点：
    - **`find` 的长度本身就是判据**：后两条是**跨句边界**的并集（Web 面 220 放行 /
      221 拦；@ 句 110 放行 / 111 拦），**按句切开任一半都会空跑**（症状：登记了却仍
      每轮 400）。故用例里把长度写成硬断言。
    - **位置语义不能互推**：身份首句是**行首锚定**（前接任意字符即放行），
      Web 面 / @ 句是**位置无关**。别拿一条的锚点结论推给另一条。
    - ⚠️ **@ 句不含任何品牌词**（没有 `DeepSeek Harness` / `dsh` / `DeepSeek`）——
      这正是它被漏掉五轮的原因。**判据不是品牌名，是「`@` 路径引用语法说明」这个
      DSH 独有写法**。以后新增登记时别只按品牌名普查。
    - 三条的 `replace` 都取自上游实测放行的形态：身份句换成**官方同形兜底措辞**
      （收益是出站 system 里彻底不再出现 `DeepSeek Harness`）；Web 面只去品牌串；
      @ 句只调整语序（后半段是防模型编造文件内容的约束，一个字都不许删）。
    回归用例 `tests/unit/tencent-channel.spec.ts` 的「DSH 自身模板句」组（7 条）。

16. **流内 `event:error` 必须走结构化码表，不能 JSON 化喂文案表**（2026-10-30 从来源
    `63a5c3f` 补齐）：上游用 HTTP 200 + SSE 下发 `code=1005` 且 **`message` 为空串**，
    而 `classifyTraeError` 的 `hard-plan` 判据要求「`1005` 且含 `plan` 关键词」
    ⇒ 判 `none` ⇒ `traeCooldownFor('none') = 0ms` ⇒ 限流标记写在**失败那一刻**
    ⇒ 下次选号立刻又选回同一个号。
    ⚠️ **别「顺手」把文案表的 `plan` 关键词要求去掉**：正文里恰好出现的数字 `1005`
    不该被当成权益不足（同仓 zcode 的裸子串判据就因此误伤过可用账号）。
    **两条判据语义不同**：文案表猜正文，结构化码表（`classifyTraeStreamCode`）读上游枚举。
    ⚠️ `isRotatableTraeStreamCode` 与类别表必须**共用同一张表**，两处各写一份必然漂移。

17. **换号预算不等于「不记账」：先写冷却、再判预算**（2026-10-30 从来源 `f8ecc0f` P1 补齐）：
    流内分支原顺序是「`rotateBudget <= 0` → 直接 throw」，而 `updateModelRateLimit`
    在它**之后** ⇒ 撞到的**最后一个账号从不写冷却**。实测（3 号池）第一轮只标 2 个
    ⇒ 下次请求立刻选回那个号、又撞同一个错误。
    ⚠️ 写这类用例时注意：**只造单账号池测不出来** —— 那条路径走的是
    「`getAvailableAccount` 返回 null」，与预算分支是**两个不同的出口**
    （实测：把顺序改回去仍然全绿）。必须造 3 个账号真正耗尽预算才有牙。

18. **额度耗尽（14018）与频率限流（6004 / 429）必须分开判、共用换号分支**
    （2026-10-30 从来源 `9f76d46` 的 IKQ6HJ 补齐）：两者动作相同（换号 + 写冷却）
    但**冷却终点语义相反** —— 频率限流是分钟级滚动窗口（服务端时刻或 +1h 兜底），
    额度耗尽要**等次日配额 / 充值**（**UTC+8 当日 24:00**）。
    写成 +1h 的后果：账号每小时被重新选中一次、必然再失败，用户看到
    「面板说可以用了，一试又不行」。
    - **码值腿必须认三层嵌套**（`code` / `error.code` / `error.data.code`）：
      buddy 的真实报文是 `{"error":{"data":{"code":14018,…}}}`，只看顶层会让码值腿
      在这家**恒不命中**、只剩英文文案腿，上游一改文案就静默失效。
    - **文案腿刻意窄**：不收 `insufficient` 这类泛词 —— 上下文超长报文里的
      `the context window is insufficient` 会被误伤，而那是「换号无益」的另一类失败。
    - 两个函数放**共享层**（`llm-adapter.ts`）而非渠道适配器：`account-probe` 也要用，
      而探测层不得反向依赖渠道适配器（那些 spec 普遍 `vi.mock` 该适配器，
      形成依赖后会把该函数一起变成 `undefined`）。
    - 换号分支里的 `creditExhausted` 必须**每轮重算**：换号后新账号的失败原因可能
      不同（A 额度耗尽、B 频率限流），沿用旧值会把 B 也锁到当天 24:00。
    回归用例 `tests/unit/credit-exhausted-cooldown.spec.ts`（14 条，含一条**反向**断言
    `isRateLimited(14018) === false`，锁住「为什么必须新开判据而不是放宽文案表」）。

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

**第 14、15 个 provider —— Magicrew（超级麦吉）+ MagiCrew（国际版）**
（2026-11-02 从来源 `bd73592` 补齐）：本项目**第一个必须借本机 Chromium 登录**的
provider —— 上游没有 OAuth 回调通道，凭据（网页 JWT + `organizationCode`）只存在于
浏览器的 localStorage 里。文件：`magicrew-product.ts` / `magicrew-auth.ts` /
`magicrew-catalog.ts` / `magicrew-credits.ts` / **`magicrew-checkin.ts`**（新人奖励）/
**`magicrew-expiry-rank.ts`**（三档分档 + 选号）/ **`magicrew-number.ts`**（数值解析，
签到与积分共用一份）/ `magicrew-profile.ts` / `magicrew-adapter.ts` /
`magicrew-local-browser.ts` / `magicrew-browser-login.ts` /
**`chromium-session.ts`**（浏览器设施，零第三方依赖）+ `src/login/magicrew-login.ts`。

### ⚠️ 两站是一个 provider 家族，不是「国际站是参数」

| 判据 | `magicrew`（超级麦吉） | `magicrewintl`（MagiCrew） |
|---|---|---|
| 网页 | `www.letsmagic.cn` | `www.magicrew.ai` |
| API host | `i-magic-service.letsmagic.cn` | **`magic-service.magicrew.ai`** |
| 每日签到 | +200 / 天 | **+50 / 天** |
| 强制 org | 否（缺了仍 200） | **是**（业务 API 回 `code 2182`；聊天网关形态**未定**） |
| 新人奖励 | 8 项、7 项可 PUT | **恒返回 `tasks: []`**（没被登记进引导计划，**不是**「已领完」） |

两站是**同一个 Go 服务的两个数据面**、账号体系物理隔离 ⇒ **必须各自登记一个
provider**（合并会让选号器与余额按错误的 host 取数）。实现**零复制**：适配器 /
目录 / 积分 / 签到 / 新人奖励全部共用，只有产品常量不同。

⚠️ **`isMagicrewProvider()` 是全仓唯一判据**（`magicrew-product.ts`）：散落写
`provider === 'magicrew'` 会让国际站**静默漏掉**（余额「查询失败」、签到不跑、
导入读错 host —— 症状全是「功能没生效」而不是报错）。已收口的七处：余额分支、
claimAll 分支、claimOnboarding、签到 sweep（`runtime-helpers`）、续期
（`provider-refresher`）、手机号查询（`account-phone`）、导入白名单（`router`）。

⚠️⚠️ **`dsh-import.ts` 的 `ACCOUNT_REF_RE` 里 `MAGICREWINTL` 必须排在 `MAGICREW`
之前**：正则交替最左优先，反了会让 `MAGICREWINTL_ACCOUNT_…` 匹配失败 ⇒ 国际站账号
在导入时被**静默丢弃**。

### ⚠️⚠️ 多账号的根本前提：**每次登录一个一次性 profile**

复用 profile 会让第二个账号**一秒内读到上一个账号的 jwt**（来源实测）⇒ 按契约判成
「替换旧账号」⇒ **建不出新账号**。隔离由
`mkdtempSync(join(tmpdir(), 'magicrew-login-'))` 保证（每次追加随机后缀，**哪怕前缀
写死**）。⚠️ 一旦哪天有人「优化」成传固定的 `userDataDir`（例如为了复用登录态），
多账号立刻串号 —— 而症状是「第二个账号加不进来」，完全看不出与这里有关。
`magicrew.spec.ts` 用两条用例分别锁「两次独立会话」与「mkdtemp 必得不同目录」。

### ⚠️ 读凭据必须「CDP 实时优先、磁盘兜底」

真机报障（来源 2026-10-29）：用户登录成功后仍显示「尚未配置账号」，白转 4 分钟。
根因不是路径错 —— Chromium **把 localStorage 缓在内存**，只有关窗才刷到 leveldb ⇒
「登录完那一刻」磁盘里还是空的。CDP（`Target.getTargets` →
`attachToTarget {flatten:true}` → `Runtime.evaluate` 带 `sessionId`）读实时值。
**两条腿都要留**：删磁盘那条 → 老 Chromium 上必然失败；删 CDP 那条 → 退回本次报障。
⚠️ 页面在登录中会导航，**不要缓存 `sessionId`**（导航即失效 ⇒ 永不恢复）。

### ⚠️ 打开的必须是**网页域 + `/login`**，不是 API 子域

网页在 `www.letsmagic.cn`、API 在 `i-magic-service.letsmagic.cn`。打开 API 子域会得到
一个没有页面的域名，且 localStorage 也不在那个 origin 下 ⇒ **恒读不到且完全静默**。
**不带邀请码**：`?invitation=` 会把新注册的号挂在某个邀请码下，不代用户决定归属。

### ⚠️ 只导航「空白页」，且失败**不抛**（2026-11-02 从来源 `bd73592` 补齐）

`ensureMagicrewLoginPage`（`magicrew-browser-login.ts`）把「CDP 就绪时首屏还是空白」的
窗口导航到登录页。三条必守点：

1. **空白页判据是「前缀」而不是「全等」**：真机实测形态远不止三种 ——
   `chrome://new-tab-page-third-party/`、`chrome-search://local-ntp/…`、
   `edge://newtab/`、`chrome://new-tab-page/?foo=1`、`about:blank#x` 全都会漏。
2. **没有空白页就**不**导航**：旧实现 `pages.find(about:blank) ?? pages[0]` 会拿第一个
   页面开刀，而 `chrome://newtab/` 的 `hostname` 是 **`'newtab'`**（非空、非同站点）
   ⇒ 它被当成普通页面 ⇒ **用户的标签页被劫**。
3. **导航失败只记诊断，不抛**：抛了会冒泡到登录层 ⇒ 删掉占位账号 ⇒ 用户看到
   「登录失败」却明明有个窗口在。**唯一例外**：`cdp === undefined`（通道没就绪）
   仍然抛 —— 那时连「窗口开着」都不成立。

### ⚠️ 本机浏览器导入：注册表 App Paths + 便携版（2026-11-02 补齐）

`chromium-session.ts` 新增 `windowsRegisteredBrowserPaths` 一族，
`magicrew-local-browser.ts` 把它们拼进 `magicrewBrowserRoots()`。四条必守点：

1. **`reg.exe` 输出是系统 OEM 代码页，不是 UTF-8**（中文 Windows = GBK/936）。
   写死 `utf8` 会把中文路径解成 U+FFFD（**不可逆**）⇒ 拼出不存在的目录 ⇒
   整条腿**静默失效**。故取 `encoding: 'buffer'` 再按代码页解码。
2. **代码页的权威来源是注册表 `HKLM\…\Nls\CodePage` 的 `OEMCP`，不是 `Intl` 的 locale**：
   ja/ko/zh-TW 的 OEMCP 分别是 932/949/**950(Big5)**，按 locale 猜「CJK ⇒ GBK」会全错。
3. **`spawnSync` 必须带 `timeout`**：`reg` 卡住（网络路径上的 App Paths）会无限期
   冻结事件循环。同仓库 `taskkill` 早就带了 `10_000`，这条纪律当时漏了。
4. **必须缓存（5 分钟）**：一次查询 = 8 次 `spawnSync`、实测 399~550ms，而
   `magicrewBrowserRoots()` 每次导入都会被调用（且两个 hostname 各一次）。
   便携版 Chrome **不注册 App Paths** ⇒ 真兜底是环境变量
   **`MAGICREW_CHROME_USER_DATA`**（指向它的 User Data 目录）。

### 三层凭证与两处硬约束

| 层 | 有效期 | 用途 | 续期 |
|---|---|---|---|
| 网页 JWT | 30 天 | 目录 / 计费 / 积分 | 只能重登 |
| `mgw_` api_key | **2 小时** | 推理 | `PUT /tokens` |
| refresh_token | 7 天，**一次性轮换** | 换 api_key | 同上 |

1. **签新 key 会吊销旧 key** ⇒ 全 provider 只允许两个签发入口（登录 / 续期），
   **绝不在热路径**（推理前）签发 —— 否则并发请求拿到刚被吊销的 key（症状：偶发
   「token无效」，重试又能成，极难复现）。
2. **refresh_token 一次性轮换** ⇒ 已进 `ROTATING_REFRESH_PROVIDERS`（与 codearts /
   trae 同因：两边都刷会互相作废）。续期**只续 api_key、不动 jwt**，且 `PUT` 时
   **不带 JWT 头**（带上会在 JWT 过期时把「能续的」变成「不能续的」）。

### 手机号与昵称（用户要求「用手机号就把手机号展示出来」）

浏览器登录落库的凭据里**既没有 phone 也没有展示名** ⇒ 卡片恒显示「超级麦吉」。
故登录时主动取一次 `GET /api/v1/contact/accounts/me/users`（**带 `/users`**，不带的
实测 404；**两个头都要**：`authorization` + `organization-code`）：`nickname` 写进
凭据供卡片昵称，`phone` 写进凭据的 `phone` 字段 ⇒ `src/admin/account-phone.ts` 的
`PHONE_FIELDS` 读它，**面板「凭据」一栏直接显示手机号**。另给 `account-phone.ts`
加了 magicrew 上游查询腿（凭据里没有 phone 的存量账号也能显示）。
⚠️ **上游给的是本地号（10 位），原样展示、不编造国家码**：10 位既可能是「少了
国家码」也可能是「少了首位」，无法从号码本身区分；编一个 11 位号会让用户以为登录的
是另一个账号（照着它重新登录会输错）。宁可显示不完整号。

### 推理面四个必守点

- **成功判据是业务码，不是 HTTP 状态**：错配的 api_key 得到 **HTTP 200 +
  `{"code":403,"message":"token无效"}`**（content-type 是 application/json）⇒
  进流之前**先看 content-type**，否则会把 JSON 当 SSE 读、报「没收到任何内容」；
- **`max_tokens` 未提供就一个字都不发**（来源真账号实测：不发 → `stop` + 1491 字符
  完整；发 `512` → `length` + 916 字符截断）。修前恒发 512 ⇒ **每轮都被截断**；
- **`stream_options.include_usage` 必须显式要**：不发上游就不回 usage 帧，而 usage 是
  上下文占用条与 token 记账的唯一来源；
- **档位只声明 `none` / `high`**：上游认 7 档但 `reasoning_tokens` **不单调**（51~91
  波动）⇒ 声明 7 档是假的，一档不声明则用户**无法关闭思考**。非法档位**不发**。

图片走注入的 `readImage` 内联原始字节；**读不到就抛 `INVALID_REQUEST`，绝不降级成
占位文字**（那会让模型「看不到但以为看到了」）。⚠️ `WiringContext.readImage` 返回类型
不含 `undefined`（缺附件服务时直接抛），适配器要的是「读不到返回 `undefined`」⇒
`wiring.ts` 包了一层把抛错转 `undefined`，文案由适配器统一给出。

`rotatesAccounts: false` —— 本适配器**不写** `modelRateLimits`，无请求级换号。

积分：`balance: true` / `dailyCheckin: true` / `onboardingTasks: true`（两站同格）。
**每日登录积分：国内 200 分 / 国际 50 分，当天 23:59:59 作废、不累计**
（`expire_type: 1`；前端文案「奖励的积分在今日内有效，明天登录还能领取新的积分哦！」）。
领取端点 `POST /api/v1/login-gift`（**无请求体**，`GET` 回 `405 Allow: POST`）。

### 新人奖励（`magicrew-checkin.ts`，2026-11-02 从来源 `bd73592` 补齐）

`GET /api/v1/onboarding/tasks` + `PUT …/<code>/completion`。国内站 8 项、7 项可 PUT；
**每号一辈子一次**。五条必守点：

1. **`first_ai_work` 归 `manualRequired`，不是 `skipped`** —— 服务端固定回 **`9303`**
   「该新人引导任务不支持手动完成」，必须真发一条消息才置位。混进 `skipped` 会被
   渲染成「N 个此前已完成」，而它**既没完成也没领到分**（把没做写成做过）。
   本实现**不发那个 PUT**（省一次必然失败的请求）。
2. **部分成功不上抛**：有 `claimed` + 有 `errors` ⇒ 返回并带 `errors`；只有
   「零成功 + 有失败」才上抛。上抛会让整轮报成「失败」，而实际已领到大部分分。
3. **`earned` = 领之前的累计 + 本次新增**，不重新 GET（服务端延迟写会让 UI 显示「刚领完却 0」）。
4. **`total` 用 `max(读到的合计, earned)`** 只为不让进度条超 100%；**刻意不写死总分**
   （参考实现 README 写「8 项合计 500」而同页逐项相加是 450，两个数字自相矛盾）。
5. **码值判据要三腿**：数字 `code`、**十进制字符串 `code`**、HTTP 状态。
   顺序不可颠倒（HTTP 腿必须在码值腿之后，否则 9303 会被截胡成硬失败）。
   ⚠️ 字符串腿是来源二审的**真缺陷**：`{"code":"403"}` + HTTP 200 既不过数字腿也
   不过 HTTP 腿 ⇒ 一路判成功 ⇒ 静默漏领。
   ⚠️ 用 `DECIMAL_LITERAL_RE` 而不是裸 `Number()`：`Number('0x3E8') === 1000`。

### 三档积分 + 永久锁（`magicrew-expiry-rank.ts`）

上游余额 = **所有带到期时间的批次**（`expiring_quota_details`，含 2027 年的远期批次）
**+ 一个没有到期时间的残差**（实测国内 2661/1661/**1000**、国际 347/247/**100**）。
`fetchMagicrewBalance` 把残差合成为「**永久积分**」包，使 `sum(remaining) === total`。

⚠️ **原名「长期积分」是命名错误**：前端判据是「有没有到期时间」⇒ 没有就到 `permanent`
（绿）桶，名字却叫「长期」（黄），名字与落桶自相矛盾。已改名。

选号按「临期 → 长期 → 永久 → 未知 → 空」分档、**档内保持手动顺序**
（`rankMagicrewAccountsByExpiry` 稳定排序）。锁定永久积分时
`permanent` / `unknown` / `empty` **一律不可用** —— `unknown` 若可用，锁定就是一次
网络抖动即可绕过的装饰。三条口径必须与面板同源：窗口天数 15、`active !== true` 与
`remaining <= 0` 不计入、到期时间读 `expiredTime`（ISO 串）。

⚠️ **曾经这里写的是 `dailyCheckin: false`，「依据上游无签到端点」—— 那是错的。**
错因值得记住：当时只翻了 `app.asar` 找「签到」，而客户端 `Magic.exe` **只是加载
`https://www.letsmagic.cn/super` 的 Electron 网页壳**（主进程用 `${WebUrl}/super`
拼 URL），业务逻辑全在网页端 chunk 里 ⇒ 在 exe 里搜中文必然零命中，据此得出
「没有该端点」的结论等于**把「没找到」当成「不存在」**。
🔑 **以后核实某家有没有某端点，先确认客户端是不是远程网页壳**：若是，就得去
上游网页域拉 `/assets/index-*.js` 与懒加载 chunk 找真实调用点。

四条实现纪律（`src/providers/magicrew-credits.ts` 的 `parseMagicrewClaim`）：
1. **成功判据是 `data.granted === true` 且 `point_amount > 0`**，不是 HTTP 状态、
   也不是 `code`。实测三种情形**全是 HTTP 200 + `code:1000`(ok)**：领到 /「今日已
   领取登录积分」/「当前账号暂不符合活动参与条件」。拿 `res.ok` 当成功会每天报假的
   「+200 分」。
2. **`ineligible` 是独立状态**，既不是失败（重试无益，算失败会每小时打一次必然
   同样结果的上游），也不是已领（算已领会让用户以为拿到了 200 分）。
3. **上游对重复领取幂等**（同一账号连打两次同样回 `granted:false` + 零变化）⇒
   **不需要**像 Buddy / Trae 那样先查状态再领，没有预检竞态。
4. **失败不记日期**（只记尝试时刻做 10 分钟冷却）：早期「先标记再请求」会把一次
   网络抖动记成「整天已领」。去重按 **UTC+8 自然日**（`magicrewDayKey`）。
5. ⚠️ **未取证 `granted:true` 的真实报文**（实测三个账号当天都已领过）⇒ 解析按
   双条件，任一不满足当没领到，**绝不用「HTTP 200 就算加 200 分」兜底**。

领取入口两条，**共用 `maybeClaimMagicrewDaily`**：
- **定时**：`claimMagicrewDailyPoints`（`src/index.ts` 的 `tick`，小时级；启动即跑一次）。
  ⚠️ **刻意不走续期**：jwt 是网页登录态，刷新要开 Chromium 走浏览器登录，绝不能
  由定时任务自动化（会替用户决定登哪个账号）。
- **手动**：`credits.claimAll`（面板「一键领取积分」，能力位 `dailyCheckin`，force 跳闸门）。
  ⚠️ **刻意不挂 `daily-bonus`**：那是 OfficeAce「服务端自动发放」的手动兜底，语义不同，
  且两者汇总形状不同（`totalPoints` vs `totalCredit`、`skipped` vs `inactive`），
  混用只会多一处字段漂移面。

**测试**：来源 `tests/unit/` 的 84 个文件经 `scripts/port-tests.mjs` 移植，
加上本项目自写的（`llm` / `account-pool` / `gateway` / `divergence-gating` /
`sensenova*` / `officeace*` / `accio*` / `trae-cooldown-table` / `serial-queue` /
`expiry-sync` / `accio-credits` / `officeace-credits` /
`credits-endpoint-accio-officeace` / `credit-expiry` / `permanent-lock` /
`provider-toggle` / `provider-switch-api` / `instance-watchdog` /
`login-window-policy` / `officeace-dedupe` / `qoder-dedupe` / `officeace-login` /
`account-phone` / `static-key-entry` / `officeace-expiry-rank` /
`officeace-expiry-selector` / `officeace-consume-order` /
`officeace-remote-catalog` / `qoder-catalog` /
`raccoon-remote-catalog` / `reasoning-effort-passthrough`）。
当前 **163 个文件 3698 条用例，全绿**（2026-11-02 实测；较上次登记 +2 文件 +41 条，
含新增 `magicrew-onboarding-expiry.spec.ts`（27 条）与 `magicrew-login-page.spec.ts`（11 条），
以及 `magicrew-import.spec`（+2）/ `dsh-import.spec`（+1）/ `provider-wiring.spec` / `runtime-refresh.spec`（改 15 个 provider 与续期清单）。
⚠️ 之前登记的那 4 条「时间相关的既有失败」（`buddy-oauth.spec.ts` 1 条 +
`officeace-expiry-selector.spec.ts` 3 条，fixture 锚在 2026-10-15）**已修**：
把锚点改成「相对真实时钟」（`officeace` 的 `NOW` 取当前分钟、`buddy` 的促销
`schedule` 改成 `now ± 1 天`）。**写新 fixture 时别再写死日期** —— 那等于埋一颗
到点必爆的雷，而爆炸时机与改动完全无关，极难归因。
⚠️ `gateway.spec` / `anthropic.spec` / `loomy-wechat-login.spec` 在**全量并发**下
偶发 `bad port`（裸 `fetch` 在端口回收窗口内被拒）；单独跑均通过，重跑亦通过。
这是环境边界，不是代码缺陷。

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
│   ├── providers/          14 个 provider 的适配层
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

## 「卡住」的三种成因：排队 / 思考 / 静默（2026-10-27 补）

用户说「请求发出去了没反应」时，**先分清是哪种**，否则会改错地方。
⚠️ **三者在对外响应上长得一样**：`TIMEOUT` 与 `QUEUE` 都映射成
`504 upstream_timeout`（`src/gateway/errors.ts`），只有看**日志的 stage / 时延**
才能区分。

| 成因 | 判据（代码层） | 默认时限 | 到期行为 | 会换号吗 |
|---|---|---|---|---|
| **排队** | 上游**明确**给排队：HTTP 403 业务码 `10605`，或 HTTP 200 + SSE 内嵌 `{code:"10605", isQueued…}` 帧 | 每账号 **1 分钟**（`DSH_QODER_QUEUE_TIMEOUT_MS`） | 换下一个账号重排；全排不上 ⇒ `QUEUE` | **会**（不写限流标记） |
| **思考中** | 收到任意 `reasoning_content` / `reasoning` 帧即算「首字已到」 | 首字 **120 秒**（`DSH_QODER_SSE_FIRST_TOKEN_TIMEOUT_MS`） | —— 正常流入「流中」阶段，**不受排队预算约束** | 不会 |
| **静默无输出** | 上游一个字节都不发（连接活着但无帧） | 首字 120 秒 / 流中 **120 秒**（`DSH_QODER_SSE_CHUNK_TIMEOUT_MS`） | `TIMEOUT`（504） | **不会** |

三条纪律：

1. **思考 ≠ 排队，判据毫无交集**。`ModelQueuedError` 只在**解析出排队字段**时抛出
   （`src/shared/openai-compat.ts` 仅两处），而思考发的是 `reasoning_content` 帧。
   故「模型思考很久」绝不会触发排队换号 —— 已实测（构造纯 reasoning 帧的响应：
   请求 1 次、限流标记空、**换号 0 次**）。
2. **`firstTokenReceived` 的判据是「读到任意字节」**，不是「读到正文」。
   故纯思考帧一进来就退出首字阶段，之后按**流中**空闲计时。改动这段时
   不要把判据收窄成「有文本内容才算首字」—— 那会让长思考被误判成静默超时。
3. **首字超时（120 秒）比排队预算（60 秒）长**，这是有意的：排队是上游**明说**
   在排队，等一会儿合理；静默是上游**没说话**，只能靠空闲超时兜底，给足余量
   免得误杀慢启动。两者是**独立旋钮**，调一个不影响另一个。
   ⚠️ 若用户报「思考被当排队」，现实里更可能是思考期接近 120 秒触发了
   `TIMEOUT`（不是排队）—— 让它调大 `DSH_QODER_SSE_FIRST_TOKEN_TIMEOUT_MS`。
   ⚠️ 首字/chunk 超时是**全 provider 通用**的（buddy / cline / lobsterai /
   trae / qoder 默认 120 秒，codearts 300 秒），环境变量名按 provider 前缀区分。

## 日志与时间戳的时区口径（2026-10-27 补）

排查「时间线对不上」时**先统一口径**，否则会得出错误的因果。本项目同时存在
两套时间表示，混用必然误读：

| 载体 | 时区 | 例（同一时刻） |
|---|---|---|
| 日志 `at` 字段、用量库 `at` 列 | **UTC**（ISO 8601，带 `Z`） | `2026-10-27T08:32:30.355Z` |
| 日志文件 mtime、面板显示、用户时钟 | **本地（UTC+8）** | `2026-10-27 16:32:30` |
| 用量库 `at_ms` 列 | UTC 毫秒时间戳（与 `at` 同源，`Date.parse(at)` 恒相等） | `1793089950355` |

- 两套口径的**唯一权威**是 `at`（UTC）：`new Date(at)` 后按本地展示即为用户视角。
  跨日志与用量库对同一请求时，**以 `at` 为准**比对，不要拿 mtime 与 `at` 直接比。
- `at_ms` 是 `Date.parse(at)` 的落库副本（`src/usage/store.ts` 写库时算一次），
  存在的意义是让「按时间倒序 + 维度筛选」走索引（`idx_usage_at` 等）——
  **它不是第二个时间源**，两者不等只说明文档被手改过。
- 受限时刻一律按 **UTC+8 自然日 24:00** 算（`nextUtc8DayStartMs`，
  `src/shared/model-queue.ts`），**不取本机时区**。实测：本地 23:59:59 → 解禁
  间隔 0.00 小时；本地 00:00:00 → 24.00 小时，边界精确。
- ⚠️ **面板展示限流解禁时间用本地时钟**（`plugin-src/client/jet-hub.js` 的
  `formatTime`：`< 1 小时` 显示「N 分钟后」、`< 24 小时` 显示「N 小时后」，
  更远则 `toLocaleString`）。故「面板说 7 小时后、日志写 `16:00Z`」**不矛盾**
  —— 那是同一时刻的两种写法。

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

## 账号判重（重复登录不堆条目）

**Qoder 系（`qoder` / `qodercn`）与 OfficeAce 共用同一个判重钩子**
（`LoginOrchestratorOptions.dedupe`，接线在 `src/index.ts` 的
`new LoginOrchestrator({ …, dedupe })`）：

| provider | 判重键 | 模块 |
|---|---|---|
| `officeace` | 凭据 `accountId` | `src/login/officeace-dedupe.ts` |
| `qoder` / `qodercn` | 凭据 `uid`（兼容旧字段 `user_id`） | `src/login/qoder-dedupe.ts` |

**Qoder 为什么要判重**（2026-10-27 用户报障「Qoder (中国版) 账号管理 —— 同一个
账号可以多次登录，增加多个条目，这是不合理的」）：`data/state.json` 里实测有三条
`qodercn` 条目（`qodercn-699b9c20` / `cc8226cf` / `0eb78dfc`）的凭据 `uid`
**逐字相同**（`01a0b3…fa77`）—— 同一上游账号被登录三次堆成三条。危害与 OfficeAce
的重复条目同型：选号时反复命中同一个上游账号，用户以为在轮换，而额度其实是同一个
账号的，用完就一起用完。

四条纪律：

1. **判重键取 `uid` 不取 `machine_id`**：`machine_id` 是**本插件每次登录新生成**的
   随机 UUID（`createQoderDeviceSession`），重新登录必然不同 —— 拿它判重等于永远
   不命中。`uid` 来自设备码响应的 `user_id`，按账号稳定，且续期
   （`applyQoderRefresh`）会**保留**它，故登录与续期两条路径都能拿到同一个值。
2. **必须按 provider 隔离**：`qoder` 与 `qodercn` 是两个站点，各自下发自己的
   `uid`，数值相同**不**代表同一账号。「看起来相同的 uid 是否真是同一个账号」
   无法跨站推断，而判错方向会**丢账号**（把两个不同账号合成一个），代价远大于
   重复条目。故 `findExistingQoderAccount` 只在同 provider 的账号里比对。
3. **读不到 `uid` 时不判重**（宁可重复也不误判）—— 与 `officeace-dedupe.ts` 同款。
   新增判重 provider 时沿用这条，不要为了「看起来更干净」而在判据缺失时猜。
4. **判重命中时条目元数据也要跟上**：新凭据写回既有 ref 之后，若本次登录给出了
   不同的 `expires` / `refreshable`，`settleInternal` 会 `updateAccount` 同步到
   条目上 —— 否则面板显示的是上一份凭据的过期时间，`refreshDueAccounts` 也会按
   旧值判断续期（它读的正是条目上的 `expiresAt`）。⚠️ `updateAccount` 会**替换**
   池内对象，更新后必须回读（`findAccount`），不能沿用旧引用。

回归用例 `tests/unit/qoder-dedupe.spec.ts`（12 条），其中一条**反向**用例
（不接判重钩子时确实堆出重复条目）锁住「判重钩子是这条链路的必要环」。

⚠️ 用户现有的重复条目**不会**被本次改动自动清掉（判重只拦新登录）。要合并存量
重复条目需在面板里手动删除多余的那几条。

## 已知限制

- **`buddy` / `workbuddy` / `cline` / `lobsterai` / `raccoon` / `sensenova` 的
  「额度用尽后不自动跳过」**（2026-10-26 发现，刻意未修）：这些 provider 都会写
  `modelRateLimits`，但 `resolveCredential` 不接受 `modelId`、调用点也无参，
  导致 `getAvailableAccount(provider, '')` 短路限流过滤 ⇒ 额度已用尽的账号
  在每个新请求里仍被优先选中，每个请求都白打一次再换号。`qoder` / `qodercn`
  已于 2026-10-26 修复。**症状**：日志里同一账号的额度错误反复出现；
  **修法**见「移植时**必须保持**的来源约定」第 13 条（三处一起改）。
- **Loomy 没有 refresh 端点**：token 过期只能重新登录（故主路径用手机号验证码，成本低）。
- **Qoder 的排队等待**（业务码 `10605`）**会换号**，且预算是**每账号 1 分钟**
  （2026-10-27 用户要求；此前是「整请求共享预算、从不换号」，曾累积到 30 分钟）：
  > 排队超过 1 分钟就自动切账号，全部都要超过 1 分钟就直接报错
  `resolveQueueTimeoutMs()` 默认 **1 分钟**（`DEFAULT_QUEUE_TIMEOUT_MS`，
  `DSH_QODER_QUEUE_TIMEOUT_MS` 可覆盖，显式判 `undefined` 而非 `||`——
  `0` 是合法配置「不等，立即判超时 → 立刻换号」）。
  ⚠️ **每账号预算**：换号后**重新计时**，故一次请求的总上限是「账号数 × 1 分钟」，
  不是某个固定值。实现上 `queueDeadline` 是 `let`、换号时重算。
  ⚠️ **排队换号不写限流标记**（`switchAccountOnQueue`，与 `switchAccountOnQuota`
  的关键差异）：额度受限是**按自然日**的确定性状态，必须标到 UTC+8 当日 24:00；
  排队是**暂时**状态，队列随时会通，标记会把好账号锁掉一整天。故排队只用
  请求级的 `tried` 排除集（本请求不再试它，下个请求仍可选它）。
  ⚠️ **两条通道都要改**：排队有 HTTP 403 与 **HTTP 200 + SSE 内嵌帧**两种下发
  形态，换号逻辑两处各一份。只测 HTTP 那条会让 SSE 分支的缺陷潜伏 —— 本次
  反向验证时实测到：删掉 SSE 换号分支后，只留 HTTP 用例会**全部通过**。
  故 `qoder-adapter.spec.ts` 有并列的两条（HTTP / SSE 各一），另有「不写限流
  标记」「所有账号都排不上 ⇒ 报 QUEUE」「默认值 1 分钟」共 4 条锁住这组语义
  （均已反向验证：拆掉对应实现即失败）。
  排查依据（`qodercn/dfmodel`，`req-55f749e3136f3afd`）：旧实现死等同一账号，
  本地 16:32:30 收到 → 17:02:33 才以 `504 upstream_timeout` 结束
  （`duration_ms = 1802792`，30.05 分钟），全程零响应 —— 用户体感即「卡死」。
  而免费模型（`isFree`，如 `dfmodel` / `qfmodel`）免费池最挤，死等毫无意义：
  队列常与账号相关，换号往往立刻能跑。
- **排查时间线时先统一时区口径**（日志 `at` 是 **UTC**、面板与 mtime 是**本地**）
  ——见「日志与时间戳的时区口径」。2026-10-27 的误读正是混用两套口径所致。
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
