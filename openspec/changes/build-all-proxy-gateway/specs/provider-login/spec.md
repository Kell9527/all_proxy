# Spec Delta

## Purpose

定义 10 个 provider 的登录流程行为，使用户能直接在管理网页完成新增账号，无需依赖 DSH 或平台桌面客户端。

## ADDED Requirements

### Requirement: 登录流程分类

系统 SHALL 为 10 个 provider 各提供登录流程，且 SHALL 按其协议归入以下机制之一：本地回调服务器收取授权码、后端轮询式外部链接、设备码轮询、短信验证码、微信扫码。

#### Scenario: 本地回调服务器

- **WHEN** provider 使用回调式授权
- **THEN** 系统在本地 `127.0.0.1` 启动临时回调端点收取授权码，并在结果落定后关闭该端点

#### Scenario: 后端轮询式外部链接

- **WHEN** provider 不起本地端口而是轮询后端获取令牌
- **THEN** 系统按该 provider 的轮询端点与就绪判据获取令牌，并把「未就绪」错误码视为继续轮询

#### Scenario: 设备码轮询

- **WHEN** provider 使用设备码流程
- **THEN** 系统按轮询间隔查询授权状态，并把「用户尚未完成授权」的状态视为继续轮询而非失败

#### Scenario: 短信验证码

- **WHEN** provider 使用短信验证码登录
- **THEN** 系统提供「下发验证码」与「提交验证码」两步，并把下发返回的标识原样带入第二步

#### Scenario: 微信扫码

- **WHEN** provider 使用微信扫码登录
- **THEN** 系统展示二维码并轮询扫码状态，直至确认或超时

### Requirement: 两步式登录避免弹窗被拦截

系统 SHALL 在用户完成授权之前就返回登录链接，使前端能在用户点击产生的手势窗口内打开弹窗。

#### Scenario: 立即返回登录链接

- **WHEN** 用户点击新增账号
- **THEN** 系统 SHALL 在授权完成之前返回登录链接，MUST NOT 阻塞到授权结束才返回

#### Scenario: 弹窗被拦截时的兜底

- **WHEN** 前端弹窗被浏览器拦截
- **THEN** 系统 SHALL 提供可手动打开的登录链接，且轮询 SHALL 照常进行

#### Scenario: 授权超时清理

- **WHEN** 登录流程超时或被取消
- **THEN** 系统 SHALL 关闭回调端点并释放监听端口，不留泄漏

### Requirement: Loomy 以手机号验证码为主路径

系统 SHALL 为 Loomy 提供手机号 + 短信验证码登录作为主要登录方式，使用户能登录多个 Loomy 账号。

#### Scenario: 手机号验证码登录

- **WHEN** 用户输入手机号并请求验证码
- **THEN** 系统调用讯飞账号的验证码下发接口并返回可用于后续提交的标识

#### Scenario: 提交验证码完成登录

- **WHEN** 用户提交手机号、验证码与该标识
- **THEN** 系统换取 session 与 userid 并创建账号条目

#### Scenario: 多账号共存

- **WHEN** 用户用不同手机号重复登录
- **THEN** 系统 SHALL 创建彼此独立的账号条目，MUST NOT 覆盖已有 Loomy 账号

#### Scenario: 验证码接口需签名

- **WHEN** 系统调用讯飞账号接口
- **THEN** 请求 SHALL 携带按该平台要求生成的账号签名

#### Scenario: 微信扫码作为可选路径

- **WHEN** 用户选择微信扫码登录
- **THEN** 系统提供该路径，并 SHALL 在需要绑手机号时引导完成绑定

### Requirement: 登录产物落成账号条目

系统 SHALL 把登录成功的结果转换为账号条目与凭据，并 SHALL 在凭据中就位后再把账号标记为可用。

#### Scenario: 写入凭据与条目

- **WHEN** 登录成功
- **THEN** 系统写入凭据本体与账号索引，并回填可解析的昵称与有效期

#### Scenario: 昵称脱敏

- **WHEN** 服务端下发的昵称是手机号形态
- **THEN** 系统 SHALL 按既定规则脱敏后展示

#### Scenario: 非手机号昵称原样保留

- **WHEN** 服务端下发的昵称不是手机号形态
- **THEN** 系统 SHALL 原样保留，MUST NOT 误改

#### Scenario: 设备标识唯一

- **WHEN** 系统为某 provider 生成设备标识
- **THEN** 不同账号的设备标识 SHALL 互不相同

### Requirement: 凭据有效期与可续期性

系统 SHALL 在账号条目中记录凭据的有效期与是否可续期，并据此驱动续期调度。

#### Scenario: 记录有效期

- **WHEN** 登录或续期成功
- **THEN** 账号条目中的有效期 SHALL 被更新为新的到期时刻

#### Scenario: 不可续期的 provider

- **WHEN** 某 provider 没有续期端点
- **THEN** 其账号条目的可续期标记 SHALL 为假，且系统 SHALL 在凭据过期时提示重新登录

#### Scenario: 过期前静默续期

- **WHEN** 某账号的凭据接近过期且可续期
- **THEN** 系统 SHALL 在无需用户操作的情况下完成续期

### Requirement: 登录流程失败可诊断

系统 SHALL 在登录失败时给出可读原因，且 SHALL 区分「用户尚未操作」「凭据无效」「上游返回非 JSON」等不同情形。

#### Scenario: 上游返回非 JSON

- **WHEN** 登录过程中上游返回 HTML 错误页而非 JSON
- **THEN** 系统 SHALL 给出「服务端返回了非预期响应」类提示，MUST NOT 抛出 JSON 解析异常原文

#### Scenario: 凭据失效

- **WHEN** 上游以 401/403 拒绝
- **THEN** 系统 SHALL 提示凭据已失效并引导重新登录

#### Scenario: 缺少必要字段

- **WHEN** 上游响应缺少完成登录所必需的字段
- **THEN** 系统 SHALL 明确报出缺少哪个字段，MUST NOT 以空值继续后续步骤

### Requirement: 一次性轮换的 refresh token

系统 SHALL 对使用一次性轮换 refresh token 的 provider 立即回写新凭据。

#### Scenario: 刷新后立即回写

- **WHEN** 系统用一次性 refresh token 换取新凭据成功
- **THEN** 系统 SHALL 立即把新凭据落盘，避免该账号因丢失新 token 而只能重新登录

#### Scenario: 只读探针不得消耗 refresh token

- **WHEN** 系统执行只读的状态或余额探测
- **THEN** 该探测 MUST NOT 触发凭据刷新
