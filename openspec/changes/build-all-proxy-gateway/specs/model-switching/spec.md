# Spec Delta

## Purpose

定义三层模型开关的持久化与硬拦截语义，使用户能真实控制哪些模型可被外部调用。

## ADDED Requirements

### Requirement: 三层模型开关

系统 SHALL 提供三层开关：全局总开关、provider 级开关、单模型级开关。任一层关闭即视为该模型不可用。

#### Scenario: 全局总开关关闭

- **WHEN** 全局总开关被关闭
- **THEN** 所有模型都不可用，`GET /v1/models` 返回空列表

#### Scenario: provider 级开关关闭

- **WHEN** 某 provider 被关闭
- **THEN** 该 provider 的全部模型都不可用，且不出现在 `GET /v1/models`

#### Scenario: 单模型开关关闭

- **WHEN** 某 provider 下的单个模型被关闭
- **THEN** 该模型不可用，同 provider 的其他模型不受影响

#### Scenario: 层级判定顺序

- **WHEN** 判断某模型是否可用
- **THEN** 系统 SHALL 依次检查全局、provider、单模型三层，任一层关闭即判为不可用

### Requirement: 开关采用黑名单制

系统 SHALL 以黑名单方式记录开关状态：只有被显式关闭的模型被隐藏，未记录的模型一律默认可用。

#### Scenario: 新增模型默认可用

- **WHEN** 上游新增了一个从未被记录过的模型
- **THEN** 该模型 SHALL 默认出现在 `GET /v1/models`，无需任何配置

#### Scenario: 按 provider 隔离

- **WHEN** 用户关闭 `trae` 下的某模型
- **THEN** 同名模型在其他 provider 下 SHALL 不受影响

#### Scenario: 重新开启

- **WHEN** 用户重新开启一个被关闭的模型
- **THEN** 该模型立即重新出现在 `GET /v1/models`

### Requirement: 开关是硬拦截

系统 SHALL 对被关闭的模型实施硬拦截：既不出现在模型目录，直接调用也 SHALL 被拒绝。

#### Scenario: 调用被关闭的模型

- **WHEN** 客户端请求一个已被关闭的模型
- **THEN** 系统返回 `404`，错误码为 `model_not_found`，且 SHALL NOT 发起任何上游请求

#### Scenario: 被关闭的模型不出现在目录

- **WHEN** 客户端调用 `GET /v1/models`
- **THEN** 被关闭的模型 SHALL NOT 出现在返回列表中

#### Scenario: 关闭的模型消耗零额度

- **WHEN** 客户端反复调用一个被关闭的模型
- **THEN** 系统 SHALL NOT 消耗任何上游额度

### Requirement: 开关状态持久化与即时生效

系统 SHALL 持久化三层开关状态，且变更 SHALL 在下一次目录读取与调用判定时立即生效。

#### Scenario: 变更立即生效

- **WHEN** 用户通过管理端关闭某模型
- **THEN** 后续的 `GET /v1/models` 与调用判定 SHALL 立即反映该变更，无需重启服务

#### Scenario: 重启后保持

- **WHEN** 服务重启
- **THEN** 开关状态 SHALL 与重启前一致

#### Scenario: 批量开关

- **WHEN** 用户对某 provider 执行「全部关闭」或「全部开启」
- **THEN** 系统按该 provider 当前目录逐项应用，或直接清空该 provider 的黑名单

### Requirement: 开关变更可审计

系统 SHALL 记录开关变更的来源与时间，以便排查「模型突然不可用」类问题。

#### Scenario: 记录变更

- **WHEN** 任一层开关被修改
- **THEN** 系统记录变更时间、被修改的层级与目标标识

#### Scenario: 查询当前有效状态

- **WHEN** 用户查询某模型的状态
- **THEN** 系统返回该模型的最终可用性以及是哪一层导致其不可用
