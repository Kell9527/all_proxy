# Spec Delta

## Purpose

定义 all_proxy 对外暴露的 HTTP 端点契约，使任意 OpenAI 或 Anthropic 兼容客户端无需改造即可接入 10 个聚合 provider。

## ADDED Requirements

### Requirement: OpenAI 兼容 Chat Completions 端点

系统 SHALL 提供 `POST /v1/chat/completions`，接受标准 OpenAI Chat Completions 请求体，并返回标准 OpenAI 响应或 SSE 流。

请求体 SHALL 支持 `model`、`messages`、`stream`、`max_tokens`、`temperature`、`top_p`、`stop`、`tools`、`tool_choice`、`reasoning_effort`。未知字段 SHALL 被忽略而非报错。

#### Scenario: 非流式请求

- **WHEN** 客户端以 `stream: false` 或不传 `stream` 调用 `POST /v1/chat/completions`
- **THEN** 系统返回单个 JSON 对象，含 `id`、`object: "chat.completion"`、`created`、`model`、`choices[].message`、`choices[].finish_reason` 与 `usage`

#### Scenario: 流式请求

- **WHEN** 客户端以 `stream: true` 调用 `POST /v1/chat/completions`
- **THEN** 系统返回 `Content-Type: text/event-stream`，逐块输出 `data: {...}` 形式的 `chat.completion.chunk`，并以 `data: [DONE]` 结束

#### Scenario: 流式响应携带用量

- **WHEN** 客户端在流式请求中传入 `stream_options: {include_usage: true}`
- **THEN** 系统在 `[DONE]` 之前输出一个 `choices` 为空数组、`usage` 已填充的 chunk

#### Scenario: 思考内容透传

- **WHEN** 上游返回思考内容
- **THEN** 系统以 `choices[].delta.reasoning_content`（流式）或 `choices[].message.reasoning_content`（非流式）字段透出，不混入 `content`

### Requirement: Anthropic 兼容 Messages 端点

系统 SHALL 提供 `POST /v1/messages`，接受 Anthropic Messages 请求体，并返回 Anthropic 格式的响应或 SSE 流，且 SHALL 通过把请求翻译为 provider 的上游格式、再把上游响应翻译回 Anthropic 格式来实现。

#### Scenario: 非流式请求

- **WHEN** 客户端携带 `x-api-key` 与 `anthropic-version` 调用 `POST /v1/messages`
- **THEN** 系统返回含 `id`、`type: "message"`、`role: "assistant"`、`content` 数组、`stop_reason` 与 `usage: {input_tokens, output_tokens}` 的 JSON

#### Scenario: 流式事件序列

- **WHEN** 客户端以 `stream: true` 调用 `POST /v1/messages`
- **THEN** 系统按 `message_start` → `content_block_start` → `content_block_delta` → `content_block_stop` → `message_delta` → `message_stop` 的顺序输出带 `event:` 行的 SSE

#### Scenario: system 参数映射

- **WHEN** 请求体顶层含 `system`（**字符串或内容块数组**）
- **THEN** 系统把它翻译成上游的 system 角色消息，且不把它当作用户消息

- **AND** 两种形态对 `POST /v1/messages` 与 `POST /v1/chat/completions` **都**适用
  （共用同一解析口径）；任一路径静默丢弃数组形态，都会让上游收到首条非 system
  的请求体，对强制要求该形态的上游直接 400

#### Scenario: OpenAI 入站的消息历史保真

- **WHEN** 客户端以标准 OpenAI 格式提交 `messages`：assistant 的工具调用在**顶层**
  `tool_calls`（`content` 为 `null`）、工具结果用一等 `role:'tool'` 消息且 id 为
  蛇形 `tool_call_id`、assistant 的正文是**字符串**
- **THEN** 系统 SHALL 保留这些历史：工具调用与结果配对后下发、字符串正文不被吞
- **AND** `messages` 的形状归一是**适配器层**职责（规格 design D5 规定 OpenAI 侧
  由网关**透传**），网关 MUST NOT 在此层做有损翻译

#### Scenario: 工具调用往返

- **WHEN** 请求含 `tools`，且上游返回工具调用
- **THEN** 系统以 `content` 中的 `tool_use` 块（含 `id`、`name`、`input`）表达，并 SHALL 能把历史中的 `tool_result` 块翻译回上游可识别的工具结果消息

#### Scenario: Anthropic 风格错误

- **WHEN** 请求失败
- **THEN** 系统返回 Anthropic 错误信封 `{"type":"error","error":{"type":...,"message":...}}`，而非 OpenAI 的 `{"error":{"message":...}}`

### Requirement: 模型目录端点

系统 SHALL 提供 `GET /v1/models`，返回 OpenAI 风格的 `{"object":"list","data":[...]}`，其中每个条目的 `id` 为带 provider 前缀的完整模型标识。

#### Scenario: 列出已启用模型

- **WHEN** 客户端调用 `GET /v1/models`
- **THEN** 返回的列表仅包含三层开关均未关闭的模型

#### Scenario: 携带上下文与能力元数据

- **WHEN** 某个模型在 provider 目录中声明了上下文窗口或图片能力
- **THEN** 该条目的元数据中体现这些信息

### Requirement: 模型寻址使用 provider 前缀

系统 SHALL 以 `<provider>/<model>` 形式寻址模型，其中 `<provider>` 为 10 个 provider 标识之一，`<model>` 为上游原始模型 id。

#### Scenario: 带前缀的合法请求

- **WHEN** 请求 `model` 为 `raccoon/sn-glm-5-3`
- **THEN** 系统路由到 `raccoon` provider 并以 `sn-glm-5-3` 调用上游

#### Scenario: provider 不存在

- **WHEN** 请求 `model` 为 `nonexistent/some-model`
- **THEN** 系统返回 `404`，错误码为 `model_not_found`，且不发起任何上游请求

#### Scenario: 缺少前缀

- **WHEN** 请求 `model` 为裸名（不含 `/`）
- **THEN** 系统返回 `404 model_not_found`，并在错误消息中提示应使用 `<provider>/<model>` 形式

#### Scenario: 模型名本身含斜杠

- **WHEN** 上游模型 id 本身含 `/`
- **THEN** 系统按第一个 `/` 之前的部分识别 provider，其余部分整体作为模型 id

### Requirement: 错误响应与状态码映射

系统 SHALL 把上游与内部错误映射为稳定的 HTTP 状态码与错误码，且 SHALL 不在错误响应中泄露账号凭据或 refresh token。

#### Scenario: 凭据失效

- **WHEN** 某 provider 的全部账号凭据均失效且无法刷新
- **THEN** 系统返回 `401`，错误码为 `authentication_error`

#### Scenario: 额度耗尽

- **WHEN** 上游明确表示当日额度或积分已用尽
- **THEN** 系统返回 `429`，错误码为 `quota_exceeded`，且 SHALL NOT 对该错误进行自动重试

#### Scenario: 全部账号不可用

- **WHEN** 该 provider 的所有账号都处于限流或冷却中
- **THEN** 系统返回 `503`，并在消息中说明该 provider 当前无可用账号

#### Scenario: 请求被排队

- **WHEN** 上游以排队业务码响应并给出建议等待时间
- **THEN** 系统在返回给客户端之前 SHALL 先按该时间等待并重试，且等待时长 SHALL 受上限约束

#### Scenario: 上游参数错误

- **WHEN** 上游返回与请求内容相关的 4xx 错误
- **THEN** 系统原样透传该状态码与可读原因，且 SHALL NOT 因此切换账号

### Requirement: 健康检查端点

系统 SHALL 提供 `GET /health`，返回服务自身状态、各 provider 的账号可用数与版本信息。

#### Scenario: 健康检查成功

- **WHEN** 客户端调用 `GET /health`
- **THEN** 返回 `200` 与 JSON，包含每个 provider 的已启用账号数、可用账号数与最近一次错误摘要

#### Scenario: 健康检查不消耗上游额度

- **WHEN** 客户端调用 `GET /health`
- **THEN** 系统 SHALL NOT 发起任何会消耗上游额度的请求

### Requirement: 图片生成端点

系统 SHALL 提供 `POST /v1/images/generations`，并把请求转发给支持生图的 provider。

#### Scenario: 生图请求

- **WHEN** 客户端以带 provider 前缀的生图模型调用 `POST /v1/images/generations`
- **THEN** 系统转发到对应 provider 并按请求的 `response_format` 返回图片数据或 URL

#### Scenario: provider 不支持生图

- **WHEN** 请求的 provider 未实现生图能力
- **THEN** 系统返回 `404` 或 `400`，并明确说明该 provider 不支持生图
