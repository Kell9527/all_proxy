# Spec Delta

## Purpose

定义账号池的账号组织、凭据存储、选号优先级与限流轮换行为，以及从 DSH 单向导入凭据与状态的规则。

## ADDED Requirements

### Requirement: 账号条目与凭据分离存储

系统 SHALL 把账号索引与凭据本体分开存储：账号索引保存标识、provider、昵称、启用状态、凭据引用、有效期与限流标记；凭据本体保存 token 等敏感值。

#### Scenario: 账号条目字段

- **WHEN** 系统保存一个账号
- **THEN** 该条目含唯一 id、所属 provider、凭据引用、启用状态与可续期标记

#### Scenario: 凭据引用格式

- **WHEN** 系统为某账号生成凭据引用
- **THEN** 引用形如 `<PROVIDER>_ACCOUNT_<HEX>`，且在同一 provider 内唯一

#### Scenario: 删除账号连带清理凭据

- **WHEN** 用户删除一个账号
- **THEN** 系统 SHALL 同时删除该账号的凭据本体，不留下孤立凭据

### Requirement: 数组顺序即选号优先级

系统 SHALL 以账号在列表中的顺序作为自动选号与轮换的实际优先级，MUST NOT 依据任何服务端字段重排候选顺序。

#### Scenario: 优先使用靠前账号

- **WHEN** 某 provider 有多个可用账号
- **THEN** 系统选择列表中最靠前的可用账号

#### Scenario: 手动顺序优先于限流时间

- **WHEN** 用户把某账号拖到首位，而另一账号的限流重置时间更早
- **THEN** 系统 SHALL 选择被拖到首位的账号（若其不在限流期内）

#### Scenario: 限流账号被跳过

- **WHEN** 排在首位的账号正处于限流期内
- **THEN** 系统跳过它并选择下一个可用账号

#### Scenario: 重排只影响本 provider

- **WHEN** 用户重排某 provider 的账号顺序
- **THEN** 其他 provider 的账号相对位置 SHALL 保持不变

#### Scenario: 重排参数必须是完整排列

- **WHEN** 重排请求提供的 id 集合与该 provider 现有账号集合不一致
- **THEN** 系统拒绝该请求并说明原因，MUST NOT 静默忽略或部分应用

### Requirement: 同一 provider 内轮换账号

系统 SHALL 仅在同一 provider 的账号之间轮换，MUST NOT 把请求改道到其他 provider。

#### Scenario: 限流后换号重试

- **WHEN** 当前账号返回限流错误
- **THEN** 系统标记该账号并把请求重发给下一个可用账号

#### Scenario: 排除已试过的账号

- **WHEN** 系统在轮换中取下一个账号
- **THEN** 系统 SHALL 传入本次已尝试的账号集合，避免重复取回刚失败的账号

#### Scenario: 尝试集合跨重试保留

- **WHEN** 系统进行多轮换号重试
- **THEN** 已尝试集合 SHALL 跨轮次保留，避免在多个账号之间无限来回

#### Scenario: 全部账号耗尽

- **WHEN** 该 provider 的所有账号都已尝试且均失败
- **THEN** 系统如实返回错误，MUST NOT 无限轮换

#### Scenario: 不跨 provider 改道

- **WHEN** 请求指定 `codearts/deepseek-v4-flash` 且 CodeArts 全部账号不可用
- **THEN** 系统返回错误，MUST NOT 静默改用其他 provider 的同名模型

### Requirement: 限流标记与冷却

系统 SHALL 为限流账号记录其模型维度的重置时间，并在重置时间之前不选用该账号的该模型。

#### Scenario: 从错误文案解析重置时间

- **WHEN** 上游错误文案中包含重置时间
- **THEN** 系统解析该时间并作为标记的失效时刻

#### Scenario: 无重置时间时自行推算

- **WHEN** 上游错误不含重置时间但额度按自然日结算
- **THEN** 系统 SHALL 按上游账期的时区自行推算当日结束时刻，MUST NOT 退回「一小时」这类与账期无关的兜底值

#### Scenario: 时区不取本机

- **WHEN** 系统推算按日结算的额度重置时刻
- **THEN** 系统 SHALL 使用上游账期的固定时区，MUST NOT 使用本机时区

#### Scenario: 只标记该模型

- **WHEN** 某账号在某模型上额度受限
- **THEN** 系统只标记「该账号 + 该模型」，该账号在其他模型上仍可被选用

#### Scenario: 标记持久化

- **WHEN** 服务重启
- **THEN** 限流标记 SHALL 仍然生效

### Requirement: 续期不按启用状态过滤

系统 SHALL 对所有可续期的账号执行凭据续期，MUST NOT 因账号处于停用状态而跳过续期。

#### Scenario: 停用账号仍续期

- **WHEN** 某账号被停用但其凭据可续期
- **THEN** 系统 SHALL 继续为其续期，避免 refresh token 在停用期间失效

#### Scenario: 全部停用时调度器仍运行

- **WHEN** 某 provider 的所有账号都被停用
- **THEN** 续期调度 SHALL 仍然启动

#### Scenario: 停用不影响登录判定

- **WHEN** 系统判断某 provider 是否有已登录账号
- **THEN** 判据 SHALL 是「凭据能否解析」，MUST NOT 看启用状态

### Requirement: 从 DSH 单向导入

系统 SHALL 支持从 DSH 的凭据文件与账号状态文件单向导入账号、凭据、账号顺序与模型开关，且 SHALL 在导入前备份现有数据。

#### Scenario: 导入凭据与状态

- **WHEN** 用户触发从 DSH 导入
- **THEN** 系统读取 DSH 的凭据文件与账号状态文件，创建对应的账号条目与凭据，并保留其原有顺序与启用状态

#### Scenario: 导入模型开关

- **WHEN** DSH 状态文件中记录了某 provider 的模型黑名单
- **THEN** 系统 SHALL 一并导入，避免导入后暴露用户刻意关闭的模型

#### Scenario: 导入前备份

- **WHEN** 用户触发导入且本地已有数据
- **THEN** 系统 SHALL 先备份现有数据，并允许回退

#### Scenario: 轮换型凭据警告

- **WHEN** 导入的账号属于 `refresh_token` 一次性轮换的 provider
- **THEN** 系统 SHALL 明确提示导入后 DSH 侧的那份凭据可能失效

#### Scenario: 不自动定时同步

- **WHEN** 系统已导入过一次
- **THEN** 系统 MUST NOT 自动定时重新导入，同步只能由用户手动触发

#### Scenario: 幂等导入

- **WHEN** 用户对同一批账号重复触发导入
- **THEN** 系统 SHALL 按凭据引用识别已存在的账号并更新而非重复创建

### Requirement: 凭据读写与原子落盘

系统 SHALL 把凭据与账号状态写入自身数据目录，并 SHALL 以原子方式落盘。

#### Scenario: 原子写入

- **WHEN** 系统保存凭据或账号状态
- **THEN** 系统先写临时文件再重命名替换，避免进程中断导致文件损坏

#### Scenario: 可自由刷新回写

- **WHEN** 系统刷新了某账号的凭据
- **THEN** 系统 SHALL 把新凭据写回自身存储，MUST NOT 写入 DSH 的数据文件

#### Scenario: 敏感字段不落日志

- **WHEN** 系统记录日志或返回错误
- **THEN** 凭据、refresh token 与 API Key MUST NOT 以明文出现在日志或错误响应中
