/**
 * 腾讯系渠道的**内容级**风控指纹改写。
 *
 * 移植自 `deepseek-harness-codearts` 的 `src/openai-gateway/tencent-fingerprint.ts`
 * （本地检出 `D:\Project\go\token_proxy\deepseek-harness-codearts`）。
 * 那边的每一条判据都来自真实端点实测，本文件只做移植、不重新发明。
 *
 * ## 现象
 *
 * 经本网关调 `buddy`（CodeBuddy 中国版）/ `workbuddy`（WorkBuddy 国际版）时，
 * 只要 `system` 或 **`assistant` 正文**里带着某些**客户端自带的模板句**，
 * 腾讯网关就稳定回：
 *
 * ```json
 * {"code":11128,"msg":"Illegal API invocation from an unapproved channel", ...}
 * ```
 *
 * ## ⚠️ 11128 有多个同码子原因，先看 `msg`
 *
 * | `msg` | 归类 | 修法 |
 * |---|---|---|
 * | `request illegal` / `conversation id missing` | **渠道校验**（按账号要求三枚 `X-Conversation-*` 头） | `conversation-headers.ts` |
 * | `Illegal API invocation from an unapproved channel` | **内容级**（本文件） | 字面量等义改写 |
 * | `first message is not system prompt` | 结构校验 | 补首条 system |
 *
 * 三族的 `displayMsg` / `displayTips` **逐字相同**（都是「请求被拦截」「没通过
 * 渠道校验」）⇒ **绝不能拿 `displayTips` 判原因**。
 *
 * ## 实测出来的三条不能违反的约束
 *
 * 1. **改 `system` 与 `assistant` 正文两处**，其余一概不碰：
 *    `user` / `tool` 结果 / `reasoning_content` / `tool_calls[].arguments`
 *    实测**都不拦**。改它们换不来任何放行，却会篡改用户原话、工具输出
 *    （那是要回读给模型看的证据）与模型自己的思考。
 *    ⚠️ 反向也要守住：**别把 `assistant` 这一格「简化」掉** —— 会话历史里的
 *    assistant 正文含指纹是**必然**：一旦用户让 agent 排查这类风控问题，模型会
 *    先 `read` 记录该指纹的文档（`tool` 结果，不拦），再把它**逐字复述进自己的
 *    正文**（拦）。那条 assistant 消息从此每轮原样重放 ⇒ 症状是「这个 provider
 *    从此每轮都失败，换任何一个腾讯系模型都一样」—— **跟会话走，不跟模型走**。
 * 2. **改写所有** `system` 消息，不只 `messages[0]`（非首位的 system 同样被拦）。
 * 3. **大小写不敏感的精确匹配**：全小写与全大写都被拦，所以字面量比对必须带 `i`；
 *    但**只差一个词**或**多一个空格**都放行 ⇒ 服务端认的是**逐字符的字面量**，
 *    **不能**把它泛化成正则/关键词。
 *
 * ⚠️ 而「逐字符的精确字面量」不等于「每条指纹的锚点相同」：已登记的三条位置语义
 * 并不一致（ZCode 那条位置无关；Claude Code 身份句行首锚定；反馈句位置无关）。
 * ⇒ **绝不能把任一条的锚点结论推给新指纹**，新增时必须两侧都实测。
 *
 * ⚠️ 而「`find` 该写多长」也不统一 —— 取决于该条指纹的**最小充分串**，只能逐条实测。
 * 照抄别条的 `find` 长度是错的：写短了等于**空跑**（登记了却仍每轮 400），
 * 而空跑的症状极难归因。
 */

/** 受影响的 provider：腾讯系两个后端（`buddy` = CodeBuddy 中国版，`workbuddy` = WorkBuddy 国际版）。 */
const TENCENT_PROVIDERS: readonly string[] = ['buddy', 'workbuddy']

interface ContentFingerprint {
  /** 被拦的**字面量**（匹配时**大小写不敏感**，但不做任何模式泛化）。 */
  readonly find: string
  /** 等义改写。两个端点均实测 200。 */
  readonly replace: string
  /** 来源与证据，写死在代码里，免得后人「顺手」把它改成正则或删掉。 */
  readonly note: string
}

/**
 * 已知会被腾讯网关拦下的客户端模板句。
 *
 * ⚠️ **每一条都必须有实发证据**（被拦 + 改写后放行，两条都要），
 * 照抄别家客户端的常量而没实测过 = 给上游加了一条没人验证过的改写。
 */
const CONTENT_FINGERPRINTS: readonly ContentFingerprint[] = [
  {
    // ZCode 内建常量：`$Js="Main branch (you will usually use this for PRs)"`。
    // 每个 git 仓库里的会话都会被注入（拼在 `Main branch … : <分支名>` 这一行）。
    find: 'Main branch (you will usually use this for PRs)',
    replace: 'Main branch (PRs usually go here)',
    note: 'Gitee IKJNA1；workbuddy / CodeBuddy 双端点实测复现',
  },
  {
    // Claude Code 内建常量：`"You are Claude Code, Anthropic's official CLI for Claude."`
    //
    // ⚠️ **`find` 刻意不带尾句点**，一条同时覆盖两个常量（实测两者改写后都放行）：
    //   - `yl`  = `You are Claude Code, Anthropic's official CLI for Claude.`
    //   - `sf`  = 同句 + `, running within the Claude Agent SDK.`
    // 第三个常量 `af`（`You are a Claude agent, built on Anthropic's Claude Agent SDK.`）
    // 实测**不被拦**，故刻意不登记（多一条就是替上游无谓改写用户提示词）。
    //
    // ⚠️⚠️ 本条的匹配语义**不是**「位置无关」，而是**行首锚定**（与 ZCode 那条相反）：
    // 裸串被拦，但前接任意一个字符（空格 / 换行 / 中文前言）即放行；后缀完全自由。
    // 这不影响改写本身（`replaceAll` 照样生效），但**影响怎么为新指纹做探针**：
    // 只测「夹在句中」会得到「已放行」的**假阴性**。
    // ⇒ 改写范围宁可略宽 —— 漏改一处就换来整轮 400，多改一处只是语义等价的措辞变化。
    find: "You are Claude Code, Anthropic's official CLI for Claude",
    replace: "You are Claude Code, Anthropic's CLI for Claude",
    note: 'Gitee IKLS2L；system 与 assistant 正文位置均 400/11128，改写后两端点均 200',
  },
  {
    // Claude Code system prompt 的「帮助 / 反馈」段默认句（Gitee issue IKLYCT）。
    //
    // ⚠️ 与身份句不同：这一条**每轮必带**，不是概率性泄漏 —— 身份句只有
    // cc-switch 的探测路径漏传前缀时才注入（约 34%），而本句属于 Claude Code
    // system prompt 的**固定段落**，只要客户端把默认 system 整份发过来就必然带上
    // ⇒ **漏登记 = 必然命中**。用户侧实测：单日因它白撞 647 次。
    //
    // ⚠️ 匹配语义：**位置无关**（与身份句相反）。裸串 / 前接 `Note: ` /
    // 前接行首 `  - ` 均被拦。
    //
    // ⚠️⚠️ **`find` 必须写整句**：实测「砍掉前半 / 砍掉后半」即放行 ⇒
    // 子串本身不触发，写短了等于空跑。
    find: 'To give feedback, users should report the issue at '
      + 'https://github.com/anthropics/claude-code/issues',
    replace: 'To give feedback, users should report the issue at the project issue tracker',
    note: 'Gitee IKLYCT；system（含非首位）与 assistant 正文均 400/11128，'
      + 'user / reasoning_content / tool 结果放行，改写后两端点均 200',
  },
  {
    // **DSH 自己的 system prompt 身份首句**（`base` 段的
    // `You are an AI agent powered by DeepSeek Harness.`）。
    //
    // ## 与上三条的本质差别：这不是外部客户端泄漏，而是 DSH **每轮必带**的首句
    //
    // ⇒ 无法靠「换会话 / 清历史」规避，只能靠本表。这也是为什么它比前三家更急：
    // 前三家是概率性命中，这一条是**确定性**命中。
    //
    // ## ⚠️⚠️ 匹配语义：**行首锚定**（与 Claude Code 身份句同族，与另两条相反）
    //
    // 2026-10-20 对 `copilot.tencent.com` 逐格实测：
    //   | 形态 | 结果 |
    //   |---|---|
    //   | 裸串作整个 system（绝对行首） | ❌ 400/11128 |
    //   | 前接任意前缀（`You are a helpful assistant.\n\n` + 裸串） | ✅ 200 |
    //   | 改写后裸串（无句点 / 带句点 / 后接正文） | ✅ 200 |
    //   | 整段真实 system（首句改写，8683 字符） | ✅ 200 |
    //   | 整段真实 system（首句删除，8624 字符） | ✅ 200 |
    //
    // ⇒ 与身份句同理**不做行首锚定正则**：改写范围宁可略宽。漏改 = 整轮 400，
    //    多改 = 语义等价的措辞变化。
    //
    // ## ⚠️ `replace` 为什么是「官方同形 + 官方原生兜底措辞」
    //
    // 取证方式不是读源码推的，而是拿 CodeBuddy 客户端自己的**一条真实会话**
    // 落盘（assistant 的 reasoning 逐字复述了自己的 system）+ 客户端提示词资产
    // （`extensions/genie/product.json` 的 `craft-agent-prompt` 首行
    // `You are an AI coding assistant,{{ ModelNamePrompt }}.`）两条独立来源拼出
    // 同一串字节：`You are an AI coding assistant, powered by Hy4 preview model.`
    //
    // ⇒ 与我们那句**结构完全同形**（`You are <名词> powered by <Y>`），差别只在
    // Y 填什么：官方填**模型展示名**，我们填 **harness 名**。而等义改写若把
    // `DeepSeek Harness` 这个 token 原样留着，属于「只躲开字面量、没解决身份」
    // —— 上游一旦把名单放宽成关键词/正则，立刻失效。
    //
    // 三条取舍：① 出站 system 里**彻底不再出现 `DeepSeek Harness`**（本条的
    // 真正收益）；② 措辞取自官方资产而**不是自造** ⇒ 与官方首帧同形；
    // ③ **刻意不带具体模型名**（要透传 model，且我们的展示名与官方不一定一致）。
    //
    // ## ⚠️ 本句**是站点相关的**（2026-10-21 两站对照，登记时只测过 buddy 站）
    //
    // | 站点 | step-5-preview | deepseek-v4.1-flash |
    // |---|---|---|
    // | copilot.tencent.com（buddy） | ❌ 400/11128 | ❌ 400/11128 |
    // | www.workbuddy.ai（workbuddy） | ✅ 200 | ✅ 200 |
    //
    // 两个模型都测过 ⇒ **站点差异**、不是模型差异。对 workbuddy **仍保留**本条：
    // 措辞语义等义、对该站无害，国际站哪天也上名单时它就是现成的防线。
    // ⚠️ 别把「workbuddy 没被拦」读成「这条登记多余」。
    //
    // ⚠️ 也**别把本条读成「封号」判据**：实测到的通道门控是**按账号 + 三个请求头**
    //    （见 `tencent-conversation-headers.ts`），而 11128 的内容级那一支是
    //    **字面量黑名单**、不读语义。换措辞的已验证收益只有「不再命中那条字面量、
    //    出站不带自家 token」两条。
    //
    // `find` 刻意不带尾句点：一条同时覆盖带句点与不带句点两种形态。
    find: 'You are an AI agent powered by DeepSeek Harness',
    replace: 'You are an AI coding assistant, powered by a large language model',
    note: '2026-10-20 对 copilot.tencent.com 实测：system 绝对行首 400/11128，'
      + '前接任意字符放行；2026-10-21 换成官方同形措辞后实测放行（buddy 站 / '
      + 'deepseek-v4.1-flash），另实测该句在 www.workbuddy.ai 两模型均不拦（站点相关）',
  },
  {
    // **DSH Web 运行面的开头两句** —— 来自 `@deepseek-ai/dsh-harness-dev-context`
    // 的 `WEB_SURFACE_PROMPT`。该插件**只在 Web 运行时挂载** ⇒ CLI / 桌面面的
    // system 里没有这句，这也是它长期没被发现的原因。
    //
    // ## 现象（2026-10-21 真实报障「buddy: 请求被拦截，请重新发送」）
    //
    // 真实会话的 system（5780 字符）里 `DeepSeek Harness` 出现 **3 次**：
    // 第 1 行（上一条）、第 33 行（`HARNESS_SOURCE_PROMPT`）、第 35 行（本句）。
    // 前四条只覆盖第 1 行 ⇒ **修复前发出的形态仍被整轮 400/11128**。
    //
    // ## ⚠️⚠️ `find` 为什么是 221 字符、不能更短
    //
    // 前缀二分给出 **220 放行 / 221 拦**；而把这一行**按句切开**后，前一句
    // （107 字符）与后七句（894 字符）**各自都放行** ⇒ 触发串**跨了句边界**，
    // 它是**前两句的并集**。切开任何一半都会**空跑**（症状：登记了却仍每轮 400）。
    // 这正是本仓库那条纪律的又一例：**非单调现象只能逐格实测，不能凭直觉切。**
    //
    // ## 逐格实测（2026-10-21；copilot.tencent.com + deepseek-v4.1-flash；
    //    载荷逐字节取自真实会话落盘；另用**三个不同账号**复测，结论一致）
    //
    // | 载荷 | 结果 |
    // |---|---|
    // | 真实整段（3 处都在） | ❌ 400/11128 |
    // | 真实整段 + **只改第 1 行**（= 修复前形态） | ❌ **400/11128** |
    // | 真实整段 + 三处全改 | ✅ 200 |
    // | **只发第 33 行那句**（`HARNESS_SOURCE_PROMPT`） | ✅ 200 ⇒ **不登记它** |
    // | 正向：整个 system 就是 `DeepSeek Harness` 两个词 | ✅ 200 ⇒ **不是「认 token」** |
    // | 本行**前 220 字符**前缀 | ✅ 200 |
    // | 本行**前 221 字符**前缀 | ❌ 400/11128 ⇒ **字面量 = 前两句（本 `find`）** |
    // | 去掉行首 38 字符后再发 | ✅ 200 ⇒ 字面量**从行首开始** |
    // | 中性前言 + 本字面量 | ❌ 400/11128 ⇒ **位置无关**（与上一条的行首锚定**相反**） |
    // | 本字面量放 **assistant 正文** | ❌ 400/11128 ⇒ 现有改写范围已覆盖 |
    // | www.workbuddy.ai 站同一载荷 | ✅ 200 ⇒ **站点相关**（与上一条同型） |
    // | 旧版形态 `…Web GUI at http://127.0.0.1:3080.` | ✅ 200 ⇒ **刻意不登记** |
    // | 真实整段 + 第 1 行改写 + **只把本句品牌串去掉** | ✅ **200**（本 `replace` 的来历） |
    //
    // ## 本条的**脆弱性**（如实登记）
    //
    // 上游认的是**逐字符**的长字面量 ⇒ DSH 哪天改动这两句里的任一字符，本规则会
    // **静默停止匹配**（症状 = 该渠道整轮 400 复发，且行为与「完全没登记」同形）。
    // 要做真漂移检测得上「出站 system 里若仍出现 `DeepSeek Harness` 就报警」
    // 那类运行时闸门 —— **尚未实现**。
    find: 'You are interacting with the user through the DeepSeek Harness Web GUI '
      + 'whose URL the runtime context names. When the user refers to "this page", "this GUI", '
      + 'or "this app" without naming another target, they mean this GUI.',
    // 只去掉品牌串，语义不变：仍是「你在一个 Web GUI 里，它的 URL 由 runtime context 给出」。
    replace: 'You are interacting with the user through the harness Web GUI '
      + 'whose URL the runtime context names. When the user refers to "this page", "this GUI", '
      + 'or "this app" without naming another target, they mean this GUI.',
    note: '真实报障 2026-10-21（修复前形态在 buddy 站整轮 400/11128）；逐格实测：'
      + '221 字符字面量被拦、220 前缀放行、位置无关、assistant 正文同样被拦、'
      + 'www.workbuddy.ai 不拦、旧版 at <url> 形态不拦；去掉品牌串后真实整段 200',
  },
  {
    // **DSH 的 `@` 文件引用说明句**（`FILE_REFERENCE_PROMPT`；2026-10-28 真实报障）。
    //
    // ## 现象
    //
    // 真实会话每轮 `400/11128 Illegal API invocation from an unapproved channel`。
    // 关键观察：**前五条全部命中并被改写**（身份句、Web 面两句都在出站文本里确认
    // 消失），**仍然被拦** ⇒ 触发物不在已登记的清单里。
    //
    // ## 出处（写在这里是因为它极易被漏第二次）
    //
    // `packages/context/file-reference/src/index.ts` 的 `FILE_REFERENCE_PROMPT`，
    // 由 `@deepseek-ai/dsh-file-reference-local` 注入为 `context:file-reference` 段。
    // 该段在 agent 有 `read` 工具时**恒非空** ⇒ **每轮必带**，与加载了哪些插件、
    // 哪些 skill **完全无关**（曾误判为「superpowers 把 system 撑大导致」，
    // 实测删掉 superpowers 整段后**仍被拦**，该假设已被证伪）。
    //
    // ## ⚠️⚠️ 本条**不含任何品牌词** —— 这就是它被前五条漏掉的原因
    //
    // 没有 `DeepSeek Harness`、没有 `dsh`、没有 `DeepSeek`。前五条的普查方式是
    // 「找出带品牌名的句子」，而这条是**纯功能描述**，按品牌名筛选**必然漏掉**。
    // ⇒ **判据不是品牌名，是「`@` 路径引用语法说明」这个 DSH 独有写法。**
    // 以后新增登记时请回来读这一行：**别只按品牌名普查**。
    //
    // ## 逐格实测（2026-10-28；copilot.tencent.com；deepseek-v4.1-flash）
    //
    // 固定一个基线放行的账号（先用中性 system 筛掉限流/渠道门控的账号），
    // 每格发 2–3 次确认确定性。
    //
    // | 探针 | 结果 | 结论 |
    // |---|---|---|
    // | 中性句 `You are a helpful assistant.` | ✅ 200 ×6 | 基线 |
    // | **真实整段 system（18383 字符）** | ❌ 400/11128 ×6 | 复现 |
    // | **同一 system，仅把本句改成 `replace`** | ✅ **200 ×3** | **修法有效** |
    // | 完全不发 system | ✅ 200 ×3 | 对照（变量在 system 内） |
    // | 真实 system 逐行二分 | 第 160 行为临界 | 定位 |
    // | 该行**前 110 字符** | ✅ 200 | — |
    // | 该行**前 111 字符** | ❌ 400 | ⇒ 字面量 = 111 字符 |
    // | 只发**前半句**（48 字符） | ✅ 200 | ⇒ 半句空跑 |
    // | 只发**后半句**（44 字符） | ✅ 200 | ⇒ 半句空跑 |
    // | 裸串作整个 system（绝对行首） | ❌ 400 | — |
    // | 前接 1 空格 / 前接换行 / 前接中文 | ❌ 400 | ⇒ **位置无关** |
    // | 嵌在句中（`Note: … here.`） | ❌ 400 | ⇒ **位置无关** |
    // | 整行跳到第 50 字符之后 | ✅ 200 | ⇒ 锚点从行首起算 |
    // | 全小写 / 全大写 | ❌ 400 | ⇒ **大小写不敏感** |
    //
    // ## `find` 为什么是 111 字符、不能更短
    //
    // 前缀二分给出 **110 放行 / 111 拦**；而按句切开后**两半各自都放行**
    // ⇒ 触发串**跨了句边界**，是前两句的**并集**。切开任一半都会**空跑**。
    // 与上一条同型，同一条纪律：**非单调现象只能逐格实测，不能凭直觉切。**
    //
    // ## ⚠️ 位置语义与身份首句**相反**
    //
    // 身份首句是**行首锚定**（前接任意字符即放行）；本条是**位置无关**。
    // ⇒ 改写范围**不做**行首锚定正则 —— 宁可略宽：漏改 = 整轮 400，
    // 多改 = 语义等价的措辞变化。**别拿一条的锚点结论推给另一条。**
    find: 'Tokens prefixed with @ are paths the user explicitly referenced. '
      + 'Relative paths resolve from the workspace root',
    // 只调整语序：`相对路径从工作区根解析` → `路径相对工作区根解析`。语义不变，
    // 且**整句其余 402 字符逐字不动** —— 后半段（目录 list / 用 read /
    // 不得声称已读过 / 引号语法）是防模型编造文件内容的核心约束，一个字都不许删。
    replace: 'Tokens prefixed with @ are paths the user explicitly referenced. '
      + 'Paths resolve relative to the workspace root',
    note: '真实报障 2026-10-28；逐格实测：真实整段 18383 字符 400×6，仅改本句语序后 '
      + '200×3；111 字符字面量（110 放行）、位置无关、大小写不敏感、切句两半各自放行；'
      + '⚠️ 本条不含品牌词，按「找含 DeepSeek Harness 的句子」普查必漏',
  },
]

/** 正则元字符转义：把字面量安全地变成**精确**匹配，而不是模式。 */
function escapeRegExp(literal: string): string {
  return literal.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

interface CompiledFingerprint {
  readonly replace: string
  /** 小写形态，用于 `includes` 预检（不命中就不必跑正则，字符串**原样**返回）。 */
  readonly findLower: string
  readonly pattern: RegExp
}

const COMPILED: readonly CompiledFingerprint[] = CONTENT_FINGERPRINTS.map((rule) => ({
  replace: rule.replace,
  findLower: rule.find.toLowerCase(),
  // `g` = 全部出现都改写；`i` = 大小写不敏感（实测全小写 / 全大写同样被拦）。
  pattern: new RegExp(escapeRegExp(rule.find), 'gi'),
}))

/** 该 provider 是否走腾讯系后端（有这套内容级风控）。 */
export function isTencentContentFingerprintProvider(provider: string): boolean {
  return TENCENT_PROVIDERS.includes(provider)
}

/**
 * 把一段文本里已知的腾讯风控指纹做**窄改写**。
 *
 * ## 契约
 *
 * - **非腾讯系 provider 原样返回**（同一份字符串内容）；
 * - **不含任何指纹的文本逐字符不变** —— 这一条是硬要求：腾讯侧按前缀缓存，
 *   无谓地重建字符串会让每一轮都算作新前缀，白白吃掉缓存命中；
 * - 只改**内容**，不删句子、不改结构：`Main branch (PRs usually go here)` 与原句
 *   语义等价，模型读到的仍是「主分支（提 PR 通常走这里）」。
 *
 * ## 本函数**刻意不认识角色**
 *
 * 「哪些角色该送进来」是**调用方**的策略（见文件头约束 1），不是这里的职责。
 * 当前该送的是 **`system` 正文**与 **`assistant` 正文**两处；
 * 该**不**送的是 `user` / `tool` 结果 / `reasoning_content` /
 * `tool_calls[].function.arguments`（实测都不拦）。
 * 新增调用点时请回到文件头核对实测行，别凭「统一一下」扩大范围。
 *
 * @param text 已取出的纯文本（system 或 assistant 正文）
 * @param provider `parseModelRoute` 得到的 provider 段，或产品的 id
 */
export function rewriteTencentContentFingerprints(text: string, provider: string): string {
  if (!isTencentContentFingerprintProvider(provider)) return text
  if (typeof text !== 'string' || text.length === 0) return text
  let out = text
  for (const rule of COMPILED) {
    // 预检：不含（小写化后的）字面量就整条跳过，`out` 保持同一份字符串内容。
    if (!out.toLowerCase().includes(rule.findLower)) continue
    // `String.replace` 配 `g` 正则会在调用前后把 lastIndex 归零，不会串状态。
    out = out.replace(rule.pattern, rule.replace)
  }
  return out
}

/** 供测试与文档引用：已登记的指纹表（只读）。 */
export const TENCNET_CONTENT_FINGERPRINTS_FOR_TESTS = CONTENT_FINGERPRINTS
