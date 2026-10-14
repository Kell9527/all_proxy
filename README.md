# all_proxy

把 **13 个 AI 平台**的账号聚合成一套标准 **OpenAI + Anthropic 兼容 API** 的本地网关，自带网页管理端。

```
13 个 provider 账号池 ──┐
                        ├──> all_proxy（单进程）──> OpenAI 兼容  /v1/chat/completions  /v1/models
凭据自持、自动续期 ────┘            │                Anthropic 兼容 /v1/messages
                                    └──> 网页管理端（同源，账号 / 模型开关 / API Key / 用量 / 备份）
```

支持的 provider：`codearts`（华为云）、`buddy`（腾讯 CodeBuddy）、`workbuddy`、`lobsterai`、`qoder`、`qodercn`、`trae`、`cline`、`loomy`、`raccoon`、`sensenova`（商汤开放平台，静态 API Key）。

## 环境要求

- **Node.js ≥ 22.5**（用量库使用内置 `node:sqlite`；本机 24.9 实测可用）。启动时会打印一条 SQLite experimental 警告，属预期。
- 不需要任何数据库、原生编译依赖。

## 安装与构建

```bash
npm install          # 本机 pnpm 会崩溃，请用 npm
npm run build        # 编译后端到 dist/
npm run build:assets # 复制 qoder-auth-wasm.wasm 到 dist/（Qoder 必需）
npm run build:web    # 构建网页管理端到 web/dist/
# 或一次执行全部：npm run build:all
```

> 若 `npm install` 报 `EPERM ... spawn`，加 `--ignore-scripts`（本项目依赖无原生编译步骤）。

## 首次启动

```bash
npm start
```

默认监听 `http://127.0.0.1:3877`。首次启动会**自动生成管理口令并打印一次**，请立即保存：

```
all_proxy: 管理口令（仅本次启动打印，请立即保存）：xxxxxxxxxxxxxxxxxxxxxxxx
all_proxy: 已监听 http://127.0.0.1:3877 ...
```

用浏览器打开 `http://127.0.0.1:3877/`，输入管理口令即可进入管理端。

常用环境变量：

| 变量 | 说明 | 默认 |
|---|---|---|
| `ALL_PROXY_DATA_DIR` | 数据目录（账号、凭据、API Key、用量库） | `<仓库>/data` |
| `ALL_PROXY_PORT` | 监听端口 | `3877` |
| `ALL_PROXY_HOST` | 监听地址 | `127.0.0.1` |
| `ALL_PROXY_ADMIN_SECRET` | 管理口令（自设；本机监听至少 4 字符，对外监听至少 12 字符） | 自动生成 |
| `SENSENOVA_API_KEYS` | SenseNova（商汤）静态 API Key，逗号分隔；仅在**尚无 sensenova 账号**时首次初始化 | 无 |

⚠️ **口令长度分级**：仅本机监听(默认 `127.0.0.1`)时口令至少 **4** 位(本机场景够用，少点记不住)；一旦对外监听(`0.0.0.0` / 局域网 IP)，**必须至少 12 位**且服务未设口令时拒绝启动——管理端能导出全部账号凭据，暴露到网络时短口令等于没有保护。

设置示例(变量与服务在**同一个终端**，或 `setx` 后新开终端)：

```bash
# Git Bash（本机自用）
export ALL_PROXY_ADMIN_SECRET='1234' && node dist/index.js serve

# CMD
set ALL_PROXY_ADMIN_SECRET=1234 && node dist/index.js serve
```

也可以先创建一把 API Key 再接入客户端：

```bash
curl -X POST -H "Authorization: Bearer <管理口令>" \
     -H "Content-Type: application/json" \
     -d '{"name":"我的客户端"}' \
     http://127.0.0.1:3877/api/keys
# 返回 {"key":"sk-all-…","data":{…}} —— 明文只出现这一次
```

## 从 DSH 导入（可选）

如果你在用 DSH 插件（`deepseek-harness-codearts`），可以把已有账号与模型开关**单向**导入：

- 数据源：`~/.dsh/.credentials.yaml`（凭据）与 `~/.dsh/jet-hub/state.json`（账号顺序与模型黑名单）。
- 导入是**只读**的：永不写回 DSH 的任何文件。
- 导入前自动备份现有数据；重复导入按凭据引用识别、更新而不重复创建。

⚠️ **`codearts` / `trae` 的 refresh token 是一次性轮换的**：导入后 DSH 侧的那份凭据可能失效。导入完成后请**只让一边刷新**（见下文「一次性 refresh token 注意事项」）。

## 接入客户端

所有模型地址格式为 `<provider>/<model>`（如 `codearts/deepseek-v4-flash`、`qoder/gfmodel`）。
可用模型列表：`GET /v1/models`（需 API Key）。

### OpenAI 兼容客户端

```bash
curl http://127.0.0.1:3877/v1/chat/completions \
  -H "Authorization: Bearer sk-all-你的key" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "raccoon/sn-glm-5-3",
    "messages": [{"role": "user", "content": "你好"}],
    "stream": true
  }'
```

或任何 OpenAI SDK：

```python
from openai import OpenAI
client = OpenAI(base_url="http://127.0.0.1:3877/v1", api_key="sk-all-你的key")
resp = client.chat.completions.create(
    model="qoder/gfmodel",
    messages=[{"role": "user", "content": "你好"}],
)
```

### Anthropic 兼容客户端（Claude Code 等）

```bash
curl http://127.0.0.1:3877/v1/messages \
  -H "x-api-key: sk-all-你的key" \
  -H "anthropic-version: 2023-06-01" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "buddy/glm-5.3",
    "max_tokens": 1024,
    "messages": [{"role": "user", "content": "你好"}]
  }'
```

Claude Code 配置示例（环境变量）：

```bash
export ANTHROPIC_BASE_URL=http://127.0.0.1:3877
export ANTHROPIC_API_KEY=sk-all-你的key
export ANTHROPIC_MODEL=buddy/glm-5.3   # <provider>/<model> 形式
```

两种头 `Authorization: Bearer <key>` 与 `x-api-key: <key>` 等价。

## 模型开关

管理端「Provider 管理 → 显示列表」可以逐个或批量开关模型。语义是**硬拦截**：

- 被关闭的模型**不出现在** `GET /v1/models`；
- 直接调用也返回 `404 model_not_found`，且**不发起任何上游请求**（零额度消耗）；
- 三层开关（全局 → provider → 单模型），任一层关闭即不可用；变更立即生效，无需重启。

## 账号与凭据

- 账号按 provider 分组管理，**数组顺序即选号优先级**（拖拽排序直接决定先用哪个账号）。
- 同一 provider 内自动轮换：限流的账号按模型维度跳过并冷却；全部账号耗尽时如实报 `503`。
- 续期调度**只看账号是否可续期，不看启用状态**：停用的账号凭据照常保持新鲜。
- 新增账号走管理端「新建账号」：codearts / lobsterai / qoder / qodercn / trae / cline / raccoon 是链接式登录（先弹窗后轮询；raccoon 弹窗内含扫码与短信）；**loomy 主路径是手机号验证码**（本地弹窗页输入手机号与验证码，可登录多个账号，与 design D12 一致），微信扫码保留为可选路径。
- **`sensenova`（商汤开放平台）是静态 API Key provider**：它的「新建账号」按钮改为**粘贴 `sk-...`**（不需要登录）。可添加多把 key，顺序即轮询优先级 —— 正常情况钉住第一把；命中 `429`（tpm/rpm 限流）就写 **5 秒**冷却并换下一把；**若所有 key 都在冷却，不会直接报错，而是等到最早一把解禁继续轮询**（默认最多轮询 5 分钟），真正做到「不通就一直试」。配额类错误（额度耗尽）换号并锁到 UTC+8 当日 24:00。也可用环境变量 `SENSENOVA_API_KEYS`（逗号分隔）在**首次启动且尚无该 provider 账号**时批量初始化。

## SenseNova（商汤开放平台）接入

- 上游：`https://token.sensenova.cn/v1`，标准 OpenAI 兼容（`/v1/chat/completions`、`/v1/models`，标准 SSE）。
- 模型按 `<provider>/<model>` 寻址，例如 **`sensenova/kimi-k3`**（即用户口语里的「K3」，最容易 429 的那个）、`sensenova/glm-5.2`、`sensenova/deepseek-v4-flash`、`sensenova/sensenova-6.8-flash-lite`（支持图片）等。模型目录**远端优先**（`/v1/models`），失败回退内置兜底表；出图模型（`sensenova-u1.5-lite`）不作为对话模型列出。
- 一把 key 一个账号，key 明文只存在本地 `data/credentials.json`（已在 `.gitignore` 内），**绝不出现在日志、错误响应、备份之外的任何地方**；管理端卡片只显示脱敏昵称（前 6 后 4）。

## 一次性 refresh token 注意事项（重要）

`codearts`、`trae` 与 `raccoon` 的 refresh token 是**一次性轮换**的：每次刷新都会作废旧 token 并下发新 token。

1. **同一账号的凭据只能让一边刷新**。如果 DSH 插件与本服务各自持有同一账号的凭据，两边同时静默续期会互相作废，最终两边都要重新登录。
2. 推荐做法：把账号的凭据**绑定到共享凭据文件**（见下节），让所有消费者读写同一份；或选定**一个**长期运行方，在其它地方停用自动续期。
3. 从本服务导出备份迁移时，备份里的 refresh token 是导出时刻的快照，请尽快导入；若导入时已失效，需重新登录。
4. 其余 provider（buddy / workbuddy / lobsterai / qoder / qodercn / cline）的 refresh token 可反复使用，不受此限制；`loomy` 没有 refresh 端点，token 过期只能重新登录（手机号验证码成本很低）。

## 共享凭据文件（解决「账号老是失效」）

**症状**：Raccoon / TRAE / CodeArts 的账号反复提示「续期失败：登录态已过期，请重新登录」，而重新登录后过一阵又失效。

**原因**：这些 provider 的 refresh token **一次性轮换**。如果同一账号的凭据被多方各存一份副本（本服务、官方客户端、另一个网关），谁先刷新谁的副本就换新，**其余副本立刻变成死 token**。

**做法**：把账号的凭据**指向一个共享文件**，所有消费者读写同一份：

```
管理端 → Provider 管理 → 账号卡片「凭据」行 → 「绑定文件」
```

填入绝对路径即可（支持 `~` 表示用户主目录）。绑定后卡片会显示 `…/config/auth-a.json` 这样的脱敏路径与「共享文件」标记。

- **读**：每次取用都重新读该文件 —— 别人刷新后，本服务下一次读取就拿到新 token，不再持死副本。
- **写**：本服务刷新后原子写回该文件，别的消费者同样立刻可见。
- **不删**：删除账号或解绑都**不会**删除该文件（它可能属于官方客户端或其它网关）。
- **解绑**：会把当前凭据转存到本服务自己的存储，账号继续可用，只是不再与外部文件同步。

**注意事项**

- 文件必须存在且内容可解析（例如官方客户端的 `auth.json`）。绑到一个空路径不会报错，但该账号会被视为「凭据缺失」，界面会明确提示。
- **多个账号各自绑独立的文件**。多个账号共用同一个文件会共享同一份 token —— 如果那本来就是同一账号的两个条目，这正是想要的；如果是两个不同账号，会互相覆盖。
- 本服务**不做跨进程文件锁**。两个网关恰好同时刷新时，仍可能有一方失败；失败方下次读取会拿到获胜方写的新 token，随即自动恢复。
- 默认仍是本服务自己的存储（**不绑定就不会依赖任何外部文件**），没装官方客户端也能正常使用。

## 管理 API（供脚本调用）

所有 `/api/*` 端点要求管理口令（`Authorization: Bearer <口令>` 或 `x-admin-secret: <口令>`），普通 API Key 一律 403。常用端点：

| 方法与路径 | 说明 |
|---|---|
| `GET /api/providers` | provider 清单与账号计数 |
| `GET /api/accounts?provider=` | 账号列表（含状态、凭据来源与脱敏路径） |
| `POST /api/accounts` | 用静态 API Key 新增账号（`provider` + `apiKey` [+ `nickname`]；仅 `sensenova`） |
| `PATCH/DELETE /api/accounts/:id` | 停用/启用、删除账号 |
| `POST /api/accounts/credential-file` | 绑定/解绑共享凭据文件（`accountId` + `filePath`，空 `filePath` = 解绑） |
| `POST /api/accounts/reorder` | 调整选号优先级 |
| `GET /api/models` | 全部模型（含被关闭的） |
| `PATCH /api/models` | 三层开关（全局/provider/单模型） |
| `GET/POST/PATCH/DELETE /api/keys` | API Key 管理 |
| `GET /api/usage` | 用量查询（时间/维度筛选 + 汇总） |
| `GET /api/usage/keys` | 按 key 汇总消耗 |
| `POST /api/backup/export` / `import` | 备份导出/导入 |
| `GET /api/admin/audit` | 操作留痕与开关审计 |
| `POST /api/login/start` + `POST /api/login/poll` | 两步式新增账号 |
| `POST /api/login/sms/send` + `complete` | 短信验证码登录（loomy/raccoon） |

所有写操作都会记录留痕（时间、操作、目标，**不含凭据明文**），可在 `/api/admin/audit` 查看。

## 数据与安全

- `data/` 目录含账号凭据（refresh token 等同账号凭证）、API Key 哈希与用量库：**绝不提交、绝不外泄**。
- API Key 落盘的是 `sha256(明文)`，明文只在创建响应里出现一次；丢了就重建，没有找回。
- 运行日志（`data/logs/app.log`，按大小轮转）写入前统一脱敏，凭据、refresh token 与 API Key 明文不会出现。
- 日志按「请求阶段」记录（未连接上游 / 已连接无首字节 / 传输中断 / 完成），与用量记录共享同一请求标识，出问题能互相定位。

## 已知限制

- **Loomy 没有 refresh 端点**：token 过期只能重新登录（手机号验证码路径成本低）。
- **`codearts` / `trae` 一次性 refresh token**：见上文注意事项。
- **`node:sqlite` 是 experimental**：启动时打印警告，属预期。
- 账号、模型开关、API Key、用量、备份、**积分（余额查询 / 每日签到 / 新手任务，各 provider 按能力矩阵分派）**均可用；不支持签到或余额的 provider（workbuddy / cline / raccoon 的部分能力、sensenova 的全部积分能力）会返回明确提示而不假装成功。

### 模型目录快照（`data/catalogs/`）

带**促销倍率**的模型目录来自腾讯/TRAE 等厂商的远端接口（`/v3/config`、`batch_get_detail_param`）。为了「拉一次就存在本项目，之后不再联网」：

- 首次成功拉取后，完整目录(含倍率)写入 `data/catalogs/<provider>.json`；
- 之后读取**只走本地快照**（内存缓存 → 磁盘快照），不发网络，管理端列表与 `/v1/models` 均在毫秒级；
- 远端拉取失败(凭据失效、无账号)时也直接用快照；失败进入 10 分钟冷却期，期间不再重试；
- 没有任何快照时才回退各 provider 内置兜底表(无倍率)；
- 想强制重新拉取：删掉 `data/catalogs/` 下的对应文件即可(快照有效期 6 天)。
- **凭据静默续期已接全部九个可续期 provider**（codearts / buddy / workbuddy / lobsterai / qoder / qodercn / trae / cline / raccoon）：启动时与每小时扫描一次，对 24 小时内过期的可续期账号（**含停用账号**）自动刷新并回写；loomy 无续期端点，过期需重新登录。

## 开发

```bash
npm run dev        # 后端开发态（tsx watch）
npm run dev:web    # 管理端热更新（/api 代理到网关）
npm test           # 单元测试（Vitest）
npm run typecheck  # 类型检查
```

移植来源与开发约定见 [AGENTS.md](AGENTS.md)；规格与变更提案见 [openspec/](openspec/)。
