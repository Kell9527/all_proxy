# Spec Delta

## Purpose

定义网页管理端的信息架构与操作能力，使用户能在一个页面里完成账号、模型开关、API Key、用量与备份的全部管理。

## ADDED Requirements

### Requirement: 单进程同源提供管理端

系统 SHALL 由同一个服务进程同时提供 API 端点与管理端页面，使管理端与后端同源。

#### Scenario: 同源访问

- **WHEN** 用户在浏览器打开服务地址
- **THEN** 管理端页面由该服务直接提供，且其对后端的请求 SHALL 是同源请求

#### Scenario: 不需要额外跨域配置

- **WHEN** 管理端调用后端管理 API
- **THEN** SHALL NOT 需要配置跨域或反向代理

#### Scenario: 静态资源可缓存

- **WHEN** 浏览器重复加载管理端静态资源
- **THEN** 系统 SHALL 通过缓存头或内容哈希避免重复下载

### Requirement: 账号管理界面

系统 SHALL 提供账号管理界面，按 provider 分组展示账号，并支持启用、停用、删除、排序与续期。

#### Scenario: 按 provider 分组

- **WHEN** 用户打开管理端
- **THEN** 账号 SHALL 按其 provider 分组展示，每组显示该 provider 的账号数与可用状态

#### Scenario: 启用与停用

- **WHEN** 用户切换某账号的启用状态
- **THEN** 系统持久化该状态，且 SHALL NOT 因此中断该账号的凭据续期

#### Scenario: 拖拽排序

- **WHEN** 用户拖动账号卡片调整顺序
- **THEN** 系统 SHALL 按落点位置（目标卡片上半或下半）决定前插或后插，并持久化新顺序

#### Scenario: 排序乐观更新

- **WHEN** 用户完成一次拖拽
- **THEN** 界面 SHALL 先本地更新再提交，失败时回滚并提示

#### Scenario: 单账号不启用拖拽

- **WHEN** 某 provider 只有一个账号
- **THEN** 界面 SHALL 不启用拖拽，因为排序无意义

#### Scenario: 展示凭据状态

- **WHEN** 界面渲染账号卡片
- **THEN** 每张卡片 SHALL 展示昵称、凭据引用、有效期、可续期标记与限流状态

### Requirement: 模型开关界面

系统 SHALL 提供模型开关界面，按 provider 展示全部模型及其当前开关状态。

#### Scenario: 展示被关闭的模型

- **WHEN** 用户展开某 provider 的模型列表
- **THEN** 系统 SHALL 列出该 provider 的全部模型（含已被关闭的），否则用户无法重新开启

#### Scenario: 逐个开关

- **WHEN** 用户切换某个模型的开关
- **THEN** 系统立即持久化，并在下次目录读取时生效

#### Scenario: 批量开关

- **WHEN** 用户执行某 provider 的全部开启或全部关闭
- **THEN** 系统按该 provider 当前目录逐项应用

#### Scenario: 展示倍率与上下文

- **WHEN** 界面渲染模型条目
- **THEN** SHALL 展示其展示名（含计费倍率）与上下文窗口

#### Scenario: 同名模型可区分

- **WHEN** 同一 provider 下存在展示名相同但 id 不同的模型
- **THEN** 界面 SHALL 使它们在视觉上可区分

### Requirement: API Key 管理界面

系统 SHALL 提供 API Key 管理界面，支持创建、查看、禁用、删除与配置范围。

#### Scenario: 创建后展示一次明文

- **WHEN** 用户创建一把 API Key
- **THEN** 界面 SHALL 展示其明文值并提示仅此一次可见

#### Scenario: 配置范围与限制

- **WHEN** 用户编辑某把 key
- **THEN** 界面 SHALL 允许配置名称、provider 范围、模型范围、速率限制与额度

#### Scenario: 展示用量

- **WHEN** 界面渲染 key 列表
- **THEN** 每把 key SHALL 展示其累计请求数与 token 消耗

### Requirement: 用量与状态展示界面

系统 SHALL 提供用量与运行状态展示界面。

#### Scenario: 用量筛选

- **WHEN** 用户选择时间范围与筛选维度
- **THEN** 界面展示匹配的记录列表与汇总数值

#### Scenario: 按 key 汇总

- **WHEN** 用户查看某把 key 的用量
- **THEN** 界面展示该 key 的 token 与请求数汇总

#### Scenario: provider 状态总览

- **WHEN** 用户打开状态页
- **THEN** 界面展示每个 provider 的已启用账号数、可用账号数与最近错误摘要

#### Scenario: 展示账号池当前选择

- **WHEN** 用户查看某 provider
- **THEN** 界面 SHALL 标出当前会被优先选用的账号

### Requirement: 备份导入导出

系统 SHALL 提供账号、凭据与模型开关的备份导出与导入能力。

#### Scenario: 导出备份

- **WHEN** 用户触发导出
- **THEN** 系统生成自包含的备份文件，含账号、凭据与开关状态

#### Scenario: 导入备份

- **WHEN** 用户导入备份文件
- **THEN** 系统 SHALL 在导入前备份现有数据，并按备份内容替换

#### Scenario: 加密导出

- **WHEN** 用户为导出设置口令
- **THEN** 系统 SHALL 以口令派生的密钥加密备份内容

#### Scenario: 导入失败可回退

- **WHEN** 导入过程中出现错误
- **THEN** 系统 SHALL 保持原有数据可用，并给出失败原因

### Requirement: 管理端可离线开发

系统 SHALL 使管理端能够独立构建与本地开发，而不依赖运行中的网关进程。

#### Scenario: 本地开发

- **WHEN** 开发者启动管理端开发服务器
- **THEN** SHALL 能通过配置把后端请求代理到网关，实现热更新开发

#### Scenario: 独立构建产物

- **WHEN** 执行构建
- **THEN** 产出的静态资源 SHALL 可被服务进程直接托管
