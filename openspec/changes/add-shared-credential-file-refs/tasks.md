# Tasks

## 1. 凭据引用形态与存储层

- [x] 1.1 新增 `src/pool/credential-ref-kind.ts`：`parseCredentialRef` / `formatFileRef` / `isFileRef` / `expandHome` / `validateFileRefInput` / `maskCredentialPath`，验证 `FILE:` 前缀识别、`~` 展开、相对路径被拒、以及「不含前缀的路径字符串不被误判为文件引用」
- [x] 1.2 `FileCredentialStore.resolve` 对文件引用**每次实时读盘**，验证「外部改动下一次读取即反映」（不缓存、不持死副本）
- [x] 1.3 `FileCredentialStore.set` 对文件引用原子写回外部文件（临时文件 + rename + 0600），验证写入落在外部文件且不产生 `.tmp` 残留
- [x] 1.4 `FileCredentialStore.describe` 区分 `file-ref` 与 `file`，验证文件不存在时返回 `exists: false`
- [x] 1.5 `FileCredentialStore.unset` 对文件引用是**无操作**（绝不删除外部文件），验证删除后文件内容不变
- [x] 1.6 `snapshot` / `listRefs` 不含文件引用；`replaceAll` 对文件引用按引用语义写回原路径，路径不可写时跳过而不中断，验证三种情形

## 2. 账号池

- [x] 2.1 `removeAccount` 对文件引用账号只摘除条目、不删外部文件，验证文件仍存在
- [x] 2.2 新增 `AccountPool.rebindCredential`：目标引用无内容时迁移、有内容时不覆盖、解绑时转存为内置引用，验证四个分支
- [x] 2.3 `rebindCredential` 拒绝空引用、账号不存在时报错，验证两条错误路径

## 3. 刷新链路

- [x] 3.1 新增 `src/pool/refresh-coordinator.ts`：按 key 单飞的 `run`，验证同一 key 并发只执行一次、不同 key 并行、失败不缓存、完成后条目清除
- [x] 3.2 新增 `src/refresh/refresh-account.ts`：统一的「锁内重读 → 刷新 → 立即回写」三步，并把结果**返回**给单飞等待者，验证各账号的 `expiresAt` 都被更新
- [x] 3.3 `refreshDueAccounts` 改为并发执行以让单飞生效，验证多账号共享同一凭据时上游只被调用一次
- [x] 3.4 修掉 `wiringRefresh` 刷错账号的缺陷：改按适配器**实际选中的账号**（`currentAccountIdFor`）刷新，无记录时退回首个可用账号
- [x] 3.5 `index.ts` 建立单例 `RefreshCoordinator` 并在请求路径与定时任务之间共享，验证两条路径共用同一单飞

## 4. 备份与管理端

- [x] 4.1 备份导出把文件引用内容内联进备份（键保留该引用），验证备份自包含
- [x] 4.2 备份导入按引用语义写回原路径、不在凭据文件留下该键；路径不可写时记入 `skipped` 并计为凭据缺失，验证两条路径
- [x] 4.3 新增 `POST /api/accounts/credential-file`（绑定 / 换绑 / 解绑），验证返回 `bound` / `credentialRef` / `displayPath` / `readable` / `migrated`
- [x] 4.4 `GET /api/accounts` 返回 `credentialKind` 与脱敏后的 `credentialDisplay`，验证文件引用与内置引用两种形态
- [x] 4.5 `rpc-bridge` 增加 `account.credentialFile` 映射，验证前端调用到达该端点
- [x] 4.6 账号卡片展示凭据来源（含「共享文件」标记）与脱敏路径，完整引用放在提示里
- [x] 4.7 账号卡片提供绑定 / 解绑操作：解绑前确认、绑定后按 `readable` 给出成功或「文件读不到」的提示

## 5. 约束与回归防线

- [x] 5.1 修订 `raccoon-client-independence.spec.ts`：把「不得出现 box-agent」的措辞收紧为「不得把客户端路径写成默认值」，并新增 `FILE:` 不得出现在 provider 源码的断言，验证原有用例（不读环境变量、不做文件系统读取、不解析 leveldb）全部保留
- [x] 5.2 确认 provider 源码零文件系统访问：`src/providers/raccoon*.ts` 的代码部分不含 `node:fs` / `readFileSync` / `FILE:`

## 6. 验证

- [x] 6.1 全量 `npm test` 通过（新增 credential-file-ref 21 条、refresh-coordinator 8 条，扩充 runtime-refresh 与 account-pool）
- [x] 6.2 `npm run typecheck` 与 `npm run build` 通过
- [x] 6.3 `npm run build:web` 通过（前端产物含新增 UI）
- [x] 6.4 隔离实例端到端验证（用**副本**文件，绝不触碰真实 `~/.box-agent`）：
  - 绑定账号到副本文件后，`GET /api/accounts` 返回 `credentialKind=file` 与脱敏路径；
  - 外部改动副本文件后，服务侧读取立即反映新值（证明无死副本）；
  - 用假上游驱动一次续期：请求携带**文件里的最新** refresh token，且新 token 写回同一文件、账号 `expiresAt` 回填；
  - 两个账号共享同一文件时续期只调用上游一次（单飞生效）
- [x] 6.5 确认用户真实数据未被改动（`data/` 与 `~/.box-agent/config/*.json` 的内容与时间戳保持原样）

## 7. 文档

- [x] 7.1 `README.md` 新增「共享凭据文件」章节：说明一次性 refresh_token 的互抢问题、绑定方法与注意事项
- [x] 7.2 `AGENTS.md` 在「移植时必守约定」补充：一次性轮换 refresh_token 的 provider 应使用共享凭据文件。
