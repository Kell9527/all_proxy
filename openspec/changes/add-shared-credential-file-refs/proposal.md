# Proposal

## Why

用户报障「**Raccoon（商汤）账号管理容易过期**」，实际排查发现根因不是协议实现，而是**凭据保管方式**：

`raccoon`（以及 `codearts`、`trae`）的 `refresh_token` 是**一次性轮换**的 —— 用一次即作废、同时返回新的一对。而同一批账号的凭据在这台机器上被**多方各存一份副本**：

| 消费者 | 凭据位置 | 实测状态 |
|---|---|---|
| 本服务 | `data/credentials.json` | access 过期 13:19 |
| 参考网关 `xiaohuanxiong2api`（也在跑） | `~/.box-agent/config/auth-a.json` / `auth-b.json` | access 过期 12:06→15:06 |
| 官方 box-agent | `~/.box-agent/config/auth.json` | access 过期 13:14 |

三方是同一批账号（`RaccoonMia` / `RaccoonEmma`），但 JWT 的 `jti` 各不相同。**谁先刷新，谁的 refresh_token 就换新，其余各方的副本立刻变成死 token** —— 表现为日志里反复出现的「续期失败：登录态已过期，请重新登录」。用户看到的就是「账号老是失效」。

此外，本服务自身的刷新链路**没有任何并发保护**（全仓无单飞/互斥），请求路径与定时任务会同时刷同一个账号，第二次拿的是刚被自己消耗掉的旧 token。

参考项目 `xiaohuanxiong2api` 已经用正确方式解决了同一问题：**凭据存文件路径引用**，每次取用前重读文件、刷新前再重读、刷新后原子写回，于是所有消费者共享同一份最新 token。

## What Changes

- **新增「共享凭据文件引用」**：账号的 `credentialRef` 可以是 `FILE:<绝对路径>`，此时凭据本体存在那个**外部文件**里：
  - `resolve` **实时读盘**（不缓存）—— 其它消费者刷新后，本服务下次读取即拿到新 token；
  - `set` **原子写回**该文件（临时文件 + rename，权限 0600）—— 本服务的刷新对其它消费者立即可见；
  - `unset` / 删除账号 **绝不删除该文件**（它可能属于官方客户端或其它网关）。
- **该能力做在凭据存储层，不在 provider 层**：`src/providers/raccoon*.ts` 依旧零文件系统访问，`raccoon-client-independence.spec.ts` 的核心意图（provider 实现不依赖客户端）完整保留；默认行为不变，只有用户**显式绑定**才启用。
- **刷新增单飞（single-flight）保护**：按 `credentialRef` 为键，同一凭据的并发刷新共享一个 Promise，上游只被调用一次。
- **修掉一个真实的刷错账号缺陷**：原 `wiringRefresh` 用「provider 的首个可用账号」刷新，多账号时刷的是**别的账号**（真正在用的那个仍旧过期、而一个无关账号被白轮换 refresh_token）。改为按适配器**实际选中的账号**刷新。
- **刷新前锁内重读凭据**：三条路径（临期刷新、401 重试、定时任务）统一走一份实现，顺序固定为「重读最新 → 单飞 → 立即回写」。
- **管理端**：账号卡片显示凭据来源（内置 / 共享文件，路径脱敏为 `…/config/auth-a.json`），并提供绑定 / 解绑操作。解绑会把凭据**转存**为本服务内置存储，不丢凭据。
- **备份**：导出把文件引用的内容**内联**进备份（备份自包含）；导入按 ref 语义写回原路径，路径不可写时跳过并记入 `skipped`（不降级成内置副本，那会造成分叉）。

## Capabilities

### Modified Capabilities

- `account-pool`: 凭据引用新增「文件引用」形态及其读写语义；刷新按凭据单飞；续期作用于**实际选中的账号**；备份对文件引用内联往返。
- `admin-console`: 账号卡片展示凭据来源与脱敏路径；新增绑定 / 解绑共享凭据文件的操作。

## Impact

- **新增文件**：`src/pool/credential-ref-kind.ts`（ref 形态解析）、`src/pool/refresh-coordinator.ts`（单飞）、`src/refresh/refresh-account.ts`（统一的单账号续期三步）。
- **改动文件**：`src/pool/store.ts`（文件引用的读写语义）、`src/pool/types.ts`、`src/pool/account-pool.ts`（`rebindCredential`、`removeAccount`）、`src/refresh/runtime-helpers.ts`（并发 + 单飞）、`src/index.ts`（按选中账号刷新）、`src/admin/router.ts`（绑定端点、来源展示）、`src/providers/backup.ts`（注释与语义）、`web/src/rpc-bridge.js`、`plugin-src/client/jet-hub.js`。
- **新增测试**：`tests/unit/credential-file-ref.spec.ts`（含备份往返）、`tests/unit/refresh-coordinator.spec.ts`；扩充 `tests/unit/runtime-refresh.spec.ts`、`tests/unit/account-pool.spec.ts`；修订 `tests/unit/raccoon-client-independence.spec.ts`（措辞收紧为「不得把客户端路径写成默认值」）。
- **不涉及**：不改 provider 协议实现、不改 10 个 provider 的登录流程、不引入跨进程文件锁（两个网关同时临期刷新的窗口仍在，但失败方下次重读后即可成功）。
- **迁移**：`data/credentials.json` 里已被抢废的 raccoon 凭据需重新登录或改绑到共享文件；已失效的那两条 refresh_token 无法恢复。
