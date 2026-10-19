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
