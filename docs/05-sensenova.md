# 05 · SenseNova（商汤开放平台）账号管理 —— 实现步骤与回移植指南

> 平台：商汤开放平台 `https://token.sensenova.cn/v1`。**与 Raccoon（商汤小浣熊）是两个不同平台**
> ——展示名刻意做成 `SenseNova (商汤)` / `Raccoon (商汤)` 区分；DSH 侧 raccoon 已有
> `sn-senenova-6-8-flash` 模型 id（小浣熊的模型名），移植时注意别混淆。
>
> 写作时点：2026-10-14。**SenseNova 是本项目完全自写的第 11 个 provider（来源 DSH 没有）**，
> 回移植方向是**全新引入**。已确认来源仓库 grep "sensenova" 仅命中 raccoon 的模型 id，无 provider。

## 1. 形态：静态 API Key provider（与其余 provider 不同类）

凭据就是一把静态 `sk-...` key——**无登录、无 refresh、无积分端点**。故：

- **没有** `sensenova-oauth.ts` / `sensenova-auth.ts` / `sensenova-credits.ts`（刻意不存在）；
- 不进 `REFRESH_SUPPORTED_PROVIDERS`（那会让定时任务对不存在的续期端点发请求）；
- 账号一律 `refreshable: false`；`fetchBalances('sensenova')` 显式 reject「不支持积分余额查询」；
- 账号来源：管理端粘贴 key（`POST /api/accounts`）或环境变量 `SENSENOVA_API_KEYS` 首次引导。

## 2. 文件清单（本项目 `src/providers/`，3 文件）

| 文件 | 行数 | 职责 |
|---|---|---|
| `sensenova-product.ts` | 153 | 产品常量（零 IO）：`SENSENOVA`（id/displayName/apiBase/chatPath `/chat/completions`/modelsPath `/models`/defaultCredentialRef `SENSENOVA_ACCESS_TOKEN`/envVar `SENSENOVA_API_KEYS`/fallbackModels）；`SENSENOVA_REQUEST_TIMEOUT_MS = 120_000` |
| `sensenova.ts` | 143 | 凭据纯函数：`SensenovaCredential{access_token, api_key?, nickname?}`；`sensenovaToken`（优先 access_token 回退 api_key 别名）；`sensenovaNicknameFromKey`（脱敏：前 6 后 4，≤10 位原样）；`parseSensenovaModels`（只保留输出为文本的模型，出图模型被过滤） |
| `sensenova-adapter.ts` | 546 | LLM 适配器：OpenAI 兼容 + **请求级换号** + 远端目录 |

**兜底模型表**（6 条，2026-10-13 实测 `GET /v1/models` 照抄远端顺序，不含出图模型 `sensenova-u1.5-lite`）：

| id | contextWindow | maxTokens | supportsImage |
|---|---|---|---|
| `deepseek-v4-flash` | 1_048_576 | 65_536 | false |
| `glm-5.2` | 1_048_576 | 131_072 | false |
| `sensenova-6.8-flash-lite` | 262_144 | 65_536 | **true** |
| `kimi-k3` | 1_048_576 | 65_536 | false（主力模型，最易 429——换号逻辑正为它而设） |
| `deepseek-flash` | 1_048_576 | 65_536 | false |
| `deepseek-v4.1-flash` | 1_048_576 | 65_536 | false |

## 3. 请求级换号（sensenova-adapter.ts stream）

**换号语义（用户明确要求）**：正常情况**钉住手动顺序的第一个 key**（`getAvailableAccount` 按用户手动顺序取第一个未被排除、未在冷却的启用账号——第一把没被标记时每次都选它）；命中错误才换。

| 情形 | 处理 |
|---|---|
| 429（tpm/rpm 限流） | 写 **5 秒**冷却（`ALL_PROXY_SENSENOVA_RATE_LIMIT_COOLDOWN_MS`，默认 5_000）+ 换下一把。⚠️ 刻意不用 shared 的 `RATE_LIMIT_FALLBACK_MS`（30 秒）——tpm/rpm 是**每分钟窗口**，30 秒会让 key 白白闲置 |
| 配额类（HTTP 402/403，或 4xx + `looksLikeQuotaError` 文案） | 换号 + 锁到 **UTC+8 当日 24:00**（`nextUtc8DayStartMs`） |
| 401（静态 key 失效） | 换下一把，**不写限流标记**（仅本次请求 tried 排除） |
| 400 请求格式错 / 5xx | 不换号，原样抛 |
| **全部账号都在冷却** | **不报错**——`shortestCooldownMs` 算最早解禁的剩余毫秒，`await sleep(wait, signal)`（可被 abort 打断）后 `tried.clear()` 继续循环，直到成功或超出**轮询预算**（`ALL_PROXY_SENSENOVA_ROTATE_BUDGET_MS`，默认 5 分钟） |
| 无启用账号 | 抛 `MISSING_CREDENTIAL`（「请先在管理端粘贴 API Key」） |
| 预算耗尽 | 按 `lastKind` 抛 `QUOTA_EXCEEDED` / `AUTH` / `RATE_LIMIT`，文案带「已轮询 Xs；最后错误：…」 |

其他细节：请求体必带 `stream_options: {include_usage: true}`（**真实缺陷修复**：SenseNova 上游默认不在流末尾发 usage 帧，不带它 Token 记账恒为 0）；`tools` 下发顶层；图片按模型判定（不支持的模型收图直接 `UNSUPPORTED_CONTENT`）；流中途错误不换号；首 token / chunk 超时默认 120 秒（环境变量 `ALL_PROXY_SENSENOVA_FIRST_TOKEN_TIMEOUT_MS` / `CHUNK_TIMEOUT_MS`）。

## 4. 新增静态 API Key provider 的步骤（已在代码逐一核实，回移植 DSH 时照此清单）

**步骤 ①**：新建 `<name>-product.ts`（基地址、chat 路径、models 路径、兜底模型表、引导环境变量名、defaultCredentialRef）+ `<name>.ts`（凭据类型 + token 提取 / 可用判定 / 脱敏昵称 / 目录解析纯函数）。**不建** oauth/auth/credits 文件。

**步骤 ②**：新建 `<name>-adapter.ts`。OpenAI 兼容时复用 `shared/openai-compat.ts` 的 `serializeMessages` / `consumeOpenAiSse` / `collectImages` 等；换号走 `pool.getAvailableAccount(provider, model, tried)`；全部冷却时 `shortestCooldownMs` + `sleep` 等解禁轮询。

**步骤 ③**：注册（本项目在 wiring.ts；DSH 侧在其 provider 注册机制）：

```ts
descriptorFor('sensenova', SENSENOVA.displayName, SENSENOVA.apiBase, { rotatesAccounts: true }),
new SensenovaAdapter({
  resolveCredential: () => ctx.resolveCredential('sensenova'),
  refresh: async () => {},            // no-op：静态 key 无续期
  accountPool: ctx.pool,
  product: SENSENOVA,
  readImage: ctx.readImage,
  fetchRemoteModels: () => fetchRemoteCatalog('sensenova', ...),
})
```

**不进 `REFRESH_SUPPORTED_PROVIDERS`**；账号一律 `refreshable: false`；provider id 列表（本项目 `ALL_PROVIDER_IDS`）末尾追加并与注册顺序同步。

**步骤 ④**：管理端建号通道：

- 后端 `STATIC_KEY_PROVIDERS`（admin/router.ts，`Set(['sensenova'])`——白名单，其余 provider 是登录态凭据，手填会造坏账号）；
- `POST /api/accounts`，body `{provider, apiKey, nickname?}` → `createStaticKeyAccount`：ref 形如 `SENSENOVA_ACCOUNT_{8位HEX大写}`，**先写凭据再写索引**（与登录流程同约定），昵称缺省用脱敏函数，`refreshable: false`；**返回只含 id/provider/nickname，绝不回显 key**；
- 前端 `supportsStaticKey(provider)`（credits-capabilities.js）控制「+ 新建账号 (粘贴 API Key)」按钮 + rpc 桥 `account.addKey`。
- ⚠️ **本项目现状**：后端端点、RPC 桥、能力判定三件套已就绪，但 jet-hub.js 的按钮 UI **尚未接线**（`supportsStaticKey` 只有定义没有调用方）；当前实际建号途径是环境变量引导或直接 curl。回移植时要补按钮接线。

**步骤 ⑤**：**凭据字段必须写 `access_token`**（值是 key）。`findAccountIdByCredential` 对非 codearts 一律取该字段——改字段名会让账号永远登记不上（当前账号登记、用量归属、限流标记全失效）。写入点两处（createStaticKeyAccount、bootstrap），读取兼容 `api_key` 别名但写入统一 `access_token`。

**步骤 ⑥**：`account-probe.ts` 探测分派表补分支（`new SensenovaAdapter({resolveCredential: async () => credential})`，不传 accountPool——探测不产生换号/限流副作用）。**该分派表已两次因漏同步出缺陷**，漏了会落到 CodeArts 的华为 HMAC 签名分支必然失败。

**步骤 ⑦**：`dsh-import.ts` 的 `ACCOUNT_REF_RE` / `PROVIDER_BY_REF_PREFIX` 补 `SENSENOVA` 前缀（自建 ref `SENSENOVA_ACCOUNT_*` 才可识别）；单凭据回退 ref `SENSENOVA_ACCESS_TOKEN` 进白名单。

**步骤 ⑧**：环境变量 `SENSENOVA_API_KEYS` 首次引导（`bootstrapSensenovaKeys`，src/index.ts）三条硬约束：

1. **只在池中无 sensenova 账号时执行**（绝不覆盖/追加——否则删掉的 key 会被每次启动塞回来）；
2. 先写凭据再写索引；
3. 单把失败只跳过（warn）不阻断启动。

逗号分隔 → trim → 过滤空 → 逐把建号，成功后 log「已从 SENSENOVA_API_KEYS 引导 N 个账号（顺序即轮询优先级）」。

## 5. 集成点与测试

- **wiring.ts**（行 543-561）：`rotatesAccounts: true`；其余见步骤 ③；
- **测试**：`sensenova-product.spec`（基址/ref 名/环境变量名/兜底表含 kimi-k3 不含出图模型/脱敏不回显完整 key/目录解析过滤出图模型）、`sensenova-adapter.spec`（380 行，**换号组**：钉住第一个账号、429 换下一把写 5 秒冷却、首号 429 次号 200 成功、**全部冷却时不报错等到最早解禁继续轮询直到成功**、配额锁当日 24:00、401 不写标记、预算耗尽报 RATE_LIMIT、无池单凭据、**stream_options.include_usage**）、`provider-wiring.spec` / `dsh-import.spec` / `credits-capabilities.spec` 的对应断言。

## 6. 回移植清单（DSH ← all_proxy）

全新引入，按 §4 八步走。DSH 侧需要适配的差异：

1. **注册形态**：本项目 `ProviderRegistry` + `descriptorFor` → DSH 侧用其 provider 注册机制（参考 DSH 已有 provider 的 `register*Llm` 形态）；
2. **管理端建号**：DSH 侧是 RPC（`jet-hub-rpc`）不是 REST——`account.addKey` 方法要加进 RPC 分发表，前端按钮按 `supportsStaticKey` 渲染（记得把本项目缺的按钮接线补上）；
3. **换号判据**：`looksLikeQuotaError` / `nextUtc8DayStartMs` 在 DSH 侧落点不同（DSH 无 `src/shared/`，函数在 `src/` 根）；
4. **ref 识别**：DSH 侧凭据导入路径按其自有机制登记 `SENSENOVA_ACCOUNT_*` 前缀；
5. 测试三个 spec 一并移植（改 import 落点）。
