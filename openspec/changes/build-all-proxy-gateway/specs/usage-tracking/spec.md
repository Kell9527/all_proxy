# Spec Delta

## Purpose

定义请求日志与用量统计的记录口径、持久化与查询能力，使用户能看清额度被谁、以什么方式消耗。

## ADDED Requirements

### Requirement: 每次请求记录一条用量日志

系统 SHALL 为每次完成的模型请求记录一条日志，且 SHALL 在请求失败时也记录失败结果。

#### Scenario: 成功请求的记录字段

- **WHEN** 一次模型请求完成
- **THEN** 该记录 SHALL 含时间、API Key 标识、provider、模型、实际使用的账号、prompt token 数、completion token 数、是否流式、总耗时、首字节耗时与结束原因

#### Scenario: 失败请求的记录字段

- **WHEN** 一次模型请求失败
- **THEN** 该记录 SHALL 含时间、API Key 标识、provider、模型、HTTP 状态码与错误码，且 token 字段 SHALL 为空或零

#### Scenario: 记录缓存命中

- **WHEN** 上游返回了缓存命中的 token 数
- **THEN** 该记录 SHALL 含缓存命中 token 数，并可据此算出命中率

#### Scenario: 记录真实账号

- **WHEN** 请求在轮换后由某个账号完成
- **THEN** 该记录 SHALL 记录实际完成请求的那个账号，MUST NOT 记录池的默认账号

#### Scenario: 不记录消息正文

- **WHEN** 系统写入用量日志
- **THEN** 日志 MUST NOT 包含用户消息正文与模型输出正文，避免隐私与体积问题

### Requirement: 用量持久化

系统 SHALL 把用量日志持久化到可查询的存储中，并 SHALL 支持数据保留策略。

#### Scenario: 落盘持久化

- **WHEN** 服务重启
- **THEN** 此前的用量记录 SHALL 仍可查询

#### Scenario: 保留策略

- **WHEN** 用量记录超过配置的保留期限或总量上限
- **THEN** 系统 SHALL 按策略清理最旧的记录，避免无限增长

#### Scenario: 写入失败不阻断请求

- **WHEN** 用量写入失败
- **THEN** 系统 SHALL 记录一条内部告警，且 SHALL NOT 因此让客户端的请求失败

#### Scenario: 并发写入安全

- **WHEN** 多个请求并发完成并写入用量
- **THEN** 系统 SHALL 保证记录不丢失、不串行阻塞请求处理

### Requirement: 用量查询与汇总

系统 SHALL 提供用量查询能力，支持按时间范围与维度筛选，并给出汇总数值。

#### Scenario: 按时间范围查询

- **WHEN** 用户指定起止时间查询用量
- **THEN** 系统返回该范围内的记录与汇总

#### Scenario: 按维度筛选

- **WHEN** 用户按 API Key、provider 或模型筛选
- **THEN** 系统只返回匹配的记录

#### Scenario: 汇总口径

- **WHEN** 系统给出汇总
- **THEN** 汇总 SHALL 至少含请求总数、成功数、失败数、prompt token 合计、completion token 合计与平均首字节耗时

#### Scenario: 按 key 查看消耗

- **WHEN** 用户查看某把 API Key 的用量
- **THEN** 系统返回该 key 的累计 token 与请求数，用于判断额度分配

#### Scenario: 分页

- **WHEN** 查询结果超过一页
- **THEN** 系统 SHALL 支持分页，MUST NOT 一次性返回全部历史记录

### Requirement: 运行日志与请求关联

系统 SHALL 为每个请求分配可关联的标识，使运行日志与用量记录能够互相定位。

#### Scenario: 请求标识贯穿

- **WHEN** 系统处理一次请求
- **THEN** 该请求的运行日志与用量记录 SHALL 共享同一标识

#### Scenario: 日志可定位阶段

- **WHEN** 请求出现异常
- **THEN** 运行日志 SHALL 能看出请求停在哪一阶段（未连接上游、已连接无首字节、传输中断等）

#### Scenario: 日志轮转

- **WHEN** 运行日志达到配置的大小上限
- **THEN** 系统 SHALL 轮转日志并保留有限个备份，避免占满磁盘

#### Scenario: 敏感信息脱敏

- **WHEN** 系统写入运行日志
- **THEN** 凭据、refresh token 与 API Key 明文 MUST NOT 出现
