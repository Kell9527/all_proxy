# Spec Delta

## Purpose

定义入站鉴权的多 API Key 体系，使用户能把访问权限分发给不同用途或不同调用方，并可按 key 限制额度与可访问范围。

## ADDED Requirements

### Requirement: 多 API Key 管理

系统 SHALL 支持创建多把 API Key，每把 SHALL 有独立标识与名称，并可单独禁用与删除。

#### Scenario: 创建 key

- **WHEN** 用户创建一把 API Key 并指定名称
- **THEN** 系统返回该 key 的明文值（仅此一次）与标识

#### Scenario: 列表不返回明文

- **WHEN** 用户查看 API Key 列表
- **THEN** 列表 SHALL 只展示标识、名称、状态与用量，MUST NOT 返回完整明文

#### Scenario: 禁用与删除

- **WHEN** 用户禁用或删除某把 key
- **THEN** 使用该 key 的后续请求 SHALL 被拒绝，且删除后该 key 不可恢复

#### Scenario: key 泄露只废一把

- **WHEN** 某把 key 泄露需要作废
- **THEN** 系统 SHALL 允许只作废该 key，其他 key 不受影响

### Requirement: 入站鉴权校验

系统 SHALL 对所有 API 端点校验入站凭据，并 SHALL 同时接受 `Authorization: Bearer <key>` 与 `x-api-key: <key>` 两种携带方式。

#### Scenario: 缺少凭据

- **WHEN** 请求未携带任何入站凭据
- **THEN** 系统返回 `401`，且 SHALL NOT 发起上游请求

#### Scenario: 无效凭据

- **WHEN** 请求携带的 key 不存在或已被禁用
- **THEN** 系统返回 `401`，且错误消息 SHALL NOT 泄露是否存在该 key 的细节

#### Scenario: 两种携带方式等价

- **WHEN** 同一把 key 分别以 `Authorization: Bearer` 与 `x-api-key` 提交
- **THEN** 系统 SHALL 都能正确识别

#### Scenario: 健康检查豁免

- **WHEN** 请求 `GET /health`
- **THEN** 系统 SHALL 允许在无凭据时返回最小化的存活信息

### Requirement: Key 级 provider 与模型白名单

系统 SHALL 允许为每把 API Key 配置可访问的 provider 与模型范围，未配置时 SHALL 视为不限制。

#### Scenario: 限制到指定 provider

- **WHEN** 某 key 被限制为只能访问 `raccoon`
- **THEN** 该 key 调用其他 provider 的模型 SHALL 被拒绝，且 SHALL NOT 发起上游请求

#### Scenario: 限制到指定模型

- **WHEN** 某 key 被限制为只能访问一组模型
- **THEN** 该 key 调用范围外的模型 SHALL 被拒绝

#### Scenario: 目录按 key 过滤

- **WHEN** 受限 key 调用 `GET /v1/models`
- **THEN** 返回列表 SHALL 只含该 key 可访问且未被模型开关关闭的模型

#### Scenario: 未配置即不限制

- **WHEN** 某 key 未配置 provider 或模型范围
- **THEN** 该 key SHALL 可访问所有已启用模型

### Requirement: Key 级额度与速率限制

系统 SHALL 支持为每把 API Key 配置额度与速率限制，并在超限时返回明确错误。

#### Scenario: 速率超限

- **WHEN** 某 key 在单位时间内的请求数超过其速率限制
- **THEN** 系统返回 `429`，并 SHALL 在响应中给出可重试的时间提示

#### Scenario: 额度用尽

- **WHEN** 某 key 的累计用量超过其配置额度
- **THEN** 系统返回 `429`，错误码为 `quota_exceeded`，且 SHALL NOT 发起上游请求

#### Scenario: 未配置即不限

- **WHEN** 某 key 未配置速率或额度限制
- **THEN** 该 key SHALL 不受这两项限制

### Requirement: 管理端鉴权

系统 SHALL 保护管理端与其管理 API，使其不能被普通 API Key 访问。

#### Scenario: 管理端需要独立凭据

- **WHEN** 请求管理端页面或管理 API
- **THEN** 系统 SHALL 要求管理专用凭据，普通 API Key SHALL 不足以访问

#### Scenario: 管理端默认仅本机

- **WHEN** 服务以默认配置启动
- **THEN** 管理端 SHALL 只监听本机地址

#### Scenario: 管理操作留痕

- **WHEN** 通过管理端执行创建、删除、导入等写操作
- **THEN** 系统 SHALL 记录操作时间与目标，且 MUST NOT 记录凭据明文
