# Spec Delta

## Purpose

定义 10 个 provider 的上游适配层必须满足的行为契约，包括端点、鉴权、请求体构造、SSE 消费与各 provider 特有的签名与转换要求。

## ADDED Requirements

### Requirement: Provider 注册表与配置驱动

系统 SHALL 为 10 个 provider 各提供一份配置，配置 SHALL 至少声明 provider 标识、显示名、上游基地址、chat 路径与鉴权方式。同一协议族的多个产品 SHALL 共享同一份实现代码，差异仅体现在配置中。

#### Scenario: 配置驱动的同族产品

- **WHEN** 系统注册 `qoder` 与 `qodercn`
- **THEN** 两者共用同一套适配实现与同一份 WASM 产物，仅配置中的基地址与 client id 不同

#### Scenario: 新增同族产品

- **WHEN** 新增一个与既有协议族同族的产品
- **THEN** 只需新增一份配置并登记，不需要复制任何适配实现文件

#### Scenario: provider 标识唯一

- **WHEN** 系统启动并注册全部 provider
- **THEN** 任何两个 provider 的标识 MUST NOT 相同

### Requirement: 上游请求鉴权

系统 SHALL 按各 provider 的要求设置鉴权头，且 MUST NOT 用通用的 `Bearer <token>` 覆盖需要原样透传的签名头。

#### Scenario: Bearer 鉴权

- **WHEN** 调用使用 Bearer 鉴权的 provider
- **THEN** 系统设置 `Authorization: Bearer <access_token>`

#### Scenario: 自定义鉴权头

- **WHEN** 调用使用非标准鉴权头的 provider
- **THEN** 系统按该 provider 的要求设置其专有头（例如 TRAE 的 `Cloud-IDE-JWT`、Cline 的 `Bearer workos:<jwt>`、Loomy 业务端点的 `token` 头）

#### Scenario: 身份头齐备

- **WHEN** 调用要求附带厂商身份头的 provider（如腾讯系、TRAE）
- **THEN** 系统按配置补齐全部必需头，且 SHALL NOT 混入其他厂商的身份头

### Requirement: 华为 CodeArts 的 HMAC-SHA256 签名

系统 SHALL 使用华为 `SDK-HMAC-SHA256` 方案对 CodeArts 的每个请求签名，签名 SHALL 覆盖 host、日期、内容摘要、安全令牌与内容类型。

#### Scenario: 签名请求被接受

- **WHEN** 系统向 CodeArts 发起 chat 请求
- **THEN** 请求携带形如 `Authorization: SDK-HMAC-SHA256 Access=<ak>,SignedHeaders=...,Signature=<hex>` 的头，并被上游接受

#### Scenario: benefit 模型必须带签名头

- **WHEN** 请求的模型属于 benefit（免费额度）模型
- **THEN** 系统 SHALL 添加 `maas_type: benefit` 头，且该头 SHALL 参与签名计算

#### Scenario: 非 benefit 模型不得带该头

- **WHEN** 请求的模型不属于 benefit 模型
- **THEN** 系统 MUST NOT 添加 `maas_type: benefit` 头

#### Scenario: 追加头不参与签名

- **WHEN** 系统添加仅用于标识用途的头（如 `Agent-Type`、`X-Language`）
- **THEN** 这些头 SHALL 在签名计算之后追加，MUST NOT 进入签名头列表

#### Scenario: 凭据轮换后立即回写

- **WHEN** CodeArts 的 `refresh_token` 被用于换取新凭据
- **THEN** 系统 SHALL 立即把新凭据写回存储，因为该 refresh token 一次性作废

### Requirement: Qoder 的 WASM 加密请求与信封剥离

系统 SHALL 通过随附的 WASM 产物生成 Qoder 的加密请求体与签名头，并 SHALL 原样透传签名头。

#### Scenario: 加密请求被接受

- **WHEN** 系统向 Qoder 发起 chat 请求
- **THEN** 请求携带由 WASM 生成的 `Authorization: Bearer COSY.<payload>.<signature>`，并被上游接受

#### Scenario: 请求体必带 business 字段

- **WHEN** 系统构造 Qoder 加密请求体
- **THEN** 请求体 SHALL 含 `business` 字段，否则部分模型会被路由到故障节点

#### Scenario: 响应信封剥离

- **WHEN** 上游返回被信封包裹的 SSE
- **THEN** 系统剥离外层信封后得到标准 OpenAI SSE，且 SHALL NOT 尝试解密响应内容

#### Scenario: 错误帧保真转发

- **WHEN** 信封内层是错误帧
- **THEN** 系统 SHALL 保留其业务码字段转发，MUST NOT 把业务码并入消息文本而丢失该字段

#### Scenario: WASM 产物随构建分发

- **WHEN** 系统构建或启动
- **THEN** WASM 产物 SHALL 与编译产物处于同一目录，且路径 SHALL 相对模块自身解析

#### Scenario: 模型目录不发网络请求

- **WHEN** 系统列出 Qoder 的模型
- **THEN** 系统 SHALL 使用内置静态目录，MUST NOT 发起需要签名的目录请求

#### Scenario: 中国版目录独立

- **WHEN** 系统列出 `qodercn` 的模型
- **THEN** 系统 SHALL 使用中国版专属目录，MUST NOT 复用国际版目录

### Requirement: TRAE 的 SOLO 协议转换

系统 SHALL 把 OpenAI 风格的请求体转换为 TRAE 的 SOLO 格式，并 SHALL 把 SOLO 的 SSE 事件转换为标准 OpenAI chunk。

#### Scenario: 请求体字段转换

- **WHEN** 系统向 TRAE 发起请求
- **THEN** 请求体含该模型所属 channel 的 `function` 与 `config_name`，工具的参数 schema SHALL 被序列化为 JSON 字符串

#### Scenario: 按模型选择 channel

- **WHEN** 请求的模型只在其所属 channel 中可用
- **THEN** 系统 SHALL 使用该 channel 发起请求，否则上游会在流内返回参数无效错误

#### Scenario: SOLO 事件转换

- **WHEN** 上游返回 SOLO 自定义事件（如 `output`、`token_usage`、`done`、`error`）
- **THEN** 系统转换为 OpenAI chunk，并把 `error` 事件转换为可抛出的错误而非静默结束

#### Scenario: 设备标识持久化

- **WHEN** 系统保存 TRAE 账号凭据
- **THEN** 凭据 SHALL 含 `machine_id` 与 `device_id`，且不同账号的 `device_id` SHALL 互不相同

### Requirement: 模型目录来源

系统 SHALL 以远端目录为优先来源，并在远端不可用时回退到内置兜底目录。

#### Scenario: 远端目录可用

- **WHEN** 某 provider 的远端目录接口返回有效模型列表
- **THEN** 系统使用该列表，并把其中的上下文窗口与倍率等元数据归一化

#### Scenario: 远端目录不可用

- **WHEN** 远端目录请求失败或返回空
- **THEN** 系统回退到内置兜底目录，且 SHALL NOT 因目录失败而让整个 provider 报错

#### Scenario: 多端点目录取并集

- **WHEN** 某 provider 的模型与促销信息分布在不同端点
- **THEN** 系统 SHALL 取各端点模型 id 的并集，MUST NOT 因只采信其中一个端点而丢失模型

#### Scenario: 无已登录账号

- **WHEN** 某 provider 没有任何可解析的凭据
- **THEN** 系统 SHALL 从目录中省略该 provider 的模型，且 SHALL NOT 以抛错方式表达该状态

### Requirement: SSE 消费与统一 chunk 词汇

系统 SHALL 以统一的内部 chunk 词汇消费所有 provider 的流式响应，并把 provider 差异收敛在各自适配层。

#### Scenario: 增量字段为 null

- **WHEN** 上游 chunk 中 `delta.content` 或 `delta.reasoning_content` 为 `null`
- **THEN** 系统 SHALL 按「无该字段」处理，MUST NOT 输出字符串 `"null"`

#### Scenario: 工具调用分片合并

- **WHEN** 上游把一次工具调用拆成多个分片，且只有首个分片带真实 id
- **THEN** 系统按分片序号缓存并复用该真实 id，保证同一次调用的所有分片 id 一致

#### Scenario: 孤儿工具调用剔除

- **WHEN** 历史消息中的工具调用没有配对的工具结果
- **THEN** 系统在发往上游之前剔除该工具调用，避免上游返回 400

#### Scenario: 入站形态归一

- **WHEN** 入站消息使用**标准 OpenAI 线格式**：assistant 的工具调用挂在消息顶层的
  `tool_calls`（`content` 为 `null`），工具结果是一等 `role:'tool'` 消息且 id 用
  蛇形 `tool_call_id`
- **THEN** 系统 SHALL 在发往上游之前把它们归一为内部形状（工具调用进 `content`
  数组、工具结果 id 统一为内部字段），使工具调用与结果**能配对成功**并原样下发；
  且 MUST NOT 因为字段名是蛇形而把 id 读成 `undefined`（那会让
  「孤儿工具调用剔除」把整批 `tool_calls` 与结果一并剔除，模型看不到自己的历史）

#### Scenario: assistant 字符串正文保真

- **WHEN** 入站 assistant 消息的 `content` 是**字符串**（而非内容块数组）
- **THEN** 系统 SHALL 保留该正文，MUST NOT 按空内容处理
  （否则纯文本多轮会话里模型的每句历史回复都会消失）

#### Scenario: 顶层 system 参数的两形态

- **WHEN** 请求体顶层 `system` 是**字符串**或**内容块数组**
- **THEN** 系统 SHALL 都映射为上游 system 消息，MUST NOT 静默丢弃任一种形态
  （丢弃会让 wire 首条不是 system，对强制要求该形态的上游直接 400）

#### Scenario: 首条 system 兜底

- **WHEN** 构造出的上游请求体首条不是 `role:'system'`
- **THEN** 适配器 SHALL 补一条最小 system 提示，避免上游以
  「first message is not system prompt」拒绝（该错误常被上游伪装成安全策略拦截，
  极易误导排查）

#### Scenario: 输出额度收敛

- **WHEN** 调用方索要的 `max_tokens` 超过该模型声明的输出上限
- **THEN** 系统 SHALL 收敛到上限后下发（只降不升），MUST NOT 把必然被上游拒绝的
  额度原样透传

#### Scenario: 空响应可诊断

- **WHEN** 上游正常结束但没有任何内容
- **THEN** 系统返回可诊断的错误原因，而非静默的成功空响应

#### Scenario: 流空闲超时

- **WHEN** 上游在首字节或分片之间超过配置的超时时间没有任何数据
- **THEN** 系统主动中断该请求并返回超时错误

### Requirement: 上游错误分类

系统 SHALL 把上游错误分为可重试与不可重试两类，并 SHALL 依据业务语义而非仅凭 HTTP 状态码判断。

#### Scenario: 业务码嵌在多层结构中

- **WHEN** 上游错误体的业务码嵌在多层 JSON 字符串中
- **THEN** 系统 SHALL 递归解析直至找到业务码，MUST NOT 仅按顶层字段做门禁判断

#### Scenario: 额度耗尽不可重试

- **WHEN** 上游表示额度已用尽
- **THEN** 系统 SHALL 立即失败，MUST NOT 对其重试

#### Scenario: 瞬时故障可重试

- **WHEN** 上游返回连接失败、超时或 5xx
- **THEN** 系统 SHALL 按退避策略重试或切换账号

#### Scenario: 限流文案兼容中英文

- **WHEN** 上游以中英文任一形式表达限流
- **THEN** 系统 SHALL 都能识别为限流
