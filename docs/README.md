# all_proxy 相对 deepseek-harness-codearts（DSH）的移植文档

本目录记录本项目（all_proxy）相对来源仓库 [deepseek-harness-codearts](https://gitee.com/iJetLi/deepseek-harness-codearts)
（本地检出 `D:\Project\go\token_proxy\deepseek-harness-codearts`，移植基线 commit `3611a62`，2026-09-28）
的**主要实现步骤与差异**，供日后**回移植**（更新 DSH 项目、基于本项目重新实现）时对照。

> 写作时点：2026-10-14（all_proxy HEAD `27f2bc2`，DSH HEAD `1080923`）。
> 下次回移植前请先重跑差异核对（见各文档末尾「核对清单」）。

## 文档索引

| 文档 | 内容 | 移植性质 |
|---|---|---|
| [01-loomy.md](01-loomy.md) | Loomy（讯飞）账号管理：手机验证码主路径、微信扫码、余额分档选号、请求级换号 | 增强回移植 |
| [02-raccoon.md](02-raccoon.md) | Raccoon（商汤小浣熊）账号管理：请求级换号、共享凭据文件、每日积分保活、密码登录 | 增强回移植 + 新增能力 |
| [03-officeace.md](03-officeace.md) | OfficeAce（华为云 ModelArts MaaS）账号管理：DPoP 登录、V11 签名积分、账号判重 | 差异合并（来源 HEAD 已有） |
| [04-accio.md](04-accio.md) | Accio（阿里 Accio Work）账号管理：PKCE 登录、Gemini 族协议、region 预选 | 差异合并（来源 HEAD 已有） |
| [05-sensenova.md](05-sensenova.md) | SenseNova（商汤开放平台）静态 API Key provider：请求级换号 | **全新引入**（来源没有） |
| [06-login-tabs.md](06-login-tabs.md) | 短信登录 / 密码登录 tab 页（管理端顶层 tab + 弹窗内 tab）与登录编排 | 混合（新架构 + 新端点） |

## 总原则（回移植前必读）

### 1. 移植方向与文件落点

本项目 provider 源码在 `src/providers/<name>*.ts`；DSH 侧是**扁平的 `src/<name>*.ts`**。
回移植时文件大体可以整块搬（本项目移植进来时只改了 import 行，反向搬运同理）：

- 本项目 `src/shared/*.ts` ↔ DSH `src/*.ts`（如 `model-queue.ts` 两边都有，`nextUtc8DayStartMs` 同名同实现）；
- 本项目 `src/providers/<name>-*.ts` ↔ DSH `src/<name>-*.ts`；
- import 改写：本项目 `../shared/llm.js` / `./cordis.js` / `./credential-ref.js` → DSH `@deepseek-ai/dsh-llm` / `@deepseek-ai/cordis` / `@deepseek-ai/dsh-credentials`。

### 2. 本项目相对 DSH 的架构级差异（不能按文件级照搬的部分）

| 差异点 | 本项目（all_proxy） | DSH 来源 | 回移植策略 |
|---|---|---|---|
| 服务形态 | 独立 HTTP 服务（`/v1/*` 对外 API + `/api/*` 管理 API + 管理端页面） | VS Code 插件（DSH 插件，跑在宿主里） | 本项目的 `src/gateway/`、`src/admin/router.ts` 在 DSH 侧无对应物，**不搬**；DSH 侧等价能力在 `src/jet-hub-rpc.ts`（约 4000 行） |
| 登录编排 | `src/login/orchestrator.ts`（独立类，两步式会话 + SMS/密码直连通道 + dedupe 钩子） | `src/jet-hub-rpc.ts` 内联各 provider 启动逻辑 + **先登记占位条目** | 本项目 orchestrator 是**新架构**，DSH 侧要按 RPC 分支形式重写（见 06） |
| 凭据存储 | 自持 JSON 凭据文件（`src/pool/store.ts`，可读写、可刷新回写） | `ctx.credentials`（`$DSH_HOME/.credentials.yaml`） | `FILE:` 共享凭据文件机制（见 02）在 DSH 侧落在 `ctx.credentials` 体系上重做 |
| 刭换判据 | `src/shared/account-failover.ts`（本项目**自写**，来源没有） | 各 provider 自己的 `classify*Failure` 表 | 见下「换号判据」节 |

### 3. 换号判据（回移植时最容易撞车的点）

本项目为 loomy / raccoon / sensenova 的请求级换号**自写**了共享判据模块
`src/shared/account-failover.ts`（来源仓库没有此文件）：

- `looksLikeQuotaError(text)` / `QUOTA_ERROR_RE`：中文「积分/点数/余额/额度 + 不足/用完/耗尽/为零/欠费」间隔 ≤12 字，英文 `insufficient points/balance/credit/quota` 等；
- `RATE_LIMIT_FALLBACK_MS = 30_000`（429 短冷却兜底）。

而**来源 HEAD 自己也演化出了一套**（与本项目不同）：

- `classifyLoomyFailure` / `classifyRaccoonFailure`：quota/rate/auth/other 四分类；
- 401/403 **优先判 auth**（防 2026-10-06「403 + insufficient permissions 被误判 quota 写 24h 冷却导致全池被封」事故）；
- quota 冷却 24h、rate 冷却 1h、轮换上限 `MAX_ROTATE=8`、auth 绝不写冷却。

**回移植时必须二选一并写清取舍**，推荐对齐来源 HEAD 的分类器（它记录了真实事故教训），
本项目判据的差异（403 归 quota、当天锁替代 24h、429 用 30s 而非 1h、无轮换上限）在 01/02 文档里逐条列出。

### 4. 通用坑位（所有 provider 共享，先读这条再读分文档）

- **凭据身份字段必须是 `access_token`**：`AccountPool.findAccountIdByCredential` 对非 codearts 一律取该字段（换号、限流、用量归属全靠它）。
- **`refresh_token` 一次性轮换的 provider（codearts/trae/raccoon/officeace/accio）**：刷新必须按凭据**单飞**（`RefreshCoordinator`）+ 锁内重读 → 刷新 → 立即回写，多方各存副本会互相作废。
- **流中途错误不换号**：HTTP 200 + SSE 内嵌错误帧不重放（可能已向客户端产出内容，重放会重复输出）。
- **续期只看 `refreshable`，不看 `enabled`**：按 enabled 过滤会让停用账号的 refresh_token 放到失效。
- **账号数组顺序即选号优先级**：不得按限流重置时间重排候选。
- **账号探测分派表**（DSH 侧 `account-probe`）：新增 provider 必须同步补分支，漏了会落到 CodeArts 华为 HMAC 签名分支必然失败（已两次踩坑：workbuddy、trae）。
- **`tools` 必须下发请求体顶层**，工具历史保留 `tool_calls` / `tool_call_id`。
- **模型寻址**：本项目强制 `<provider>/<model>` 前缀（DSH 无此概念，回移植时丢弃）。

### 5. 回移植操作步骤（建议流程）

1. 在 DSH 仓库 `git log --oneline -- src/<name>*.ts` 确认来源侧该 provider 的最新 HEAD，与本文档记录的「差异基线」比对是否已演化；
2. 按各分文档「回移植清单」逐文件搬运 / 合并，import 落点按上文映射改写；
3. 架构级差异（登录编排、凭据存储、gateway/admin）按 DSH 形态重写，不照搬本项目文件；
4. 移植后跑 DSH 侧对应单测（各分文档列出测试名与断言要点），必要时把本项目 `tests/unit/<name>*.spec.ts` 一并移植（注意路径与 import 改写）;
5. 更新本文档与分文档的「写作时点」与差异基线。
