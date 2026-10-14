# Proposal

## Why

用户报障：**Raccoon（商汤）新建账号只能走微信扫码 / 短信验证码**，但官网
（`https://xiaohuanxiong.com/login`）的登录卡片本来就有「密码登录」Tab。
对以「账号池」为核心用法的本项目来说，密码登录是最省事的通道：不用等短信、
不依赖阿里云滑块，账号密码直接可用。

与此同时排查确认一个既存事实：官网登录页的三条登录链路（扫码 / 短信 / 密码）
中，本服务只实现了前两条。

## What Changes

- **新增密码登录协议函数** `loginRaccoonWithPassword`
  （`src/providers/raccoon-oauth.ts`）：
  - `POST {apiBase}/api/web/auth/v1/login_with_password`；
  - 请求体 `{ nation_code: '86', phone: <AES 密文>, password: <同款 AES 密文> }`
    —— 手机号与密码用同一加密函数（`encryptRaccoonPhone`，key
    `senseraccoon2023`，CFB，base64(iv‖密文)），服务端逐字段解密；
  - 成功信封与短信登录同构（`access_token` / `refresh_token` / `office_identity`），
    直接复用 `credentialFromEnvelope`；
  - 错误码分流：`200004` 账密错误原样透传；`200101 retry after:N` 限流转为
    「请 N 秒后再试」；其余走信封通用文案。
- **本地登录页加第三个 Tab**「密码登录」（`src/providers/raccoon-login-page.ts`）：
  - 新路由 `POST /raccoon/password/login`（一步提交：手机号 + 密码，
    宿主持有并加密，页面无任何秘密）；
  - 失败不终止流程（与短信 Tab 一致：用户可改密重试）。
- **编排层加对称直连通道** `LoginOrchestrator.completePasswordLogin`
  与管理端路由 `POST /api/login/password/complete`（对齐既有 SMS 直连通道，
  供无本地登录页的场景使用）。
- 管理端 Jet Hub 前端**零改动**：新建账号的交互是 provider 通用的
  `window.open(loginUrl)`，方式选择发生在弹窗内的本地登录页。

## 实测结论（2026-10-08，官网登录页 + curl 受控实验）

| 项 | 结论 |
|---|---|
| 端点存在性与请求体形状 | 官网前端 bundle 静态分析 + 浏览器抓包双向确认 |
| `phone` / `password` 均需 AES 密文 | 明文直传回 `100003 params_encryted_error` |
| `Referer` / `Origin` / `UA` | **均不校验**（裸 curl 与浏览器同款响应；初期「来源校验」误判系测试号段非法 + 密码复杂度不足所致，已用受控实验排除） |
| 密码复杂度 | 服务端判定（实测纯小写/纯数字回 `100002 param password invalid`），本地不复刻规则，文案透传 |
| 频率限制 | `200101 limiter_phone_verify_error`（按手机号） |

## Non-goals

- 不改短信 / 扫码链路（实测均无需 `Referer` 等来源头）。
- 不在本地复刻密码复杂度规则（服务端判定、文案透传即可）。
- 不碰凭据存储与续期（一次性轮换 refresh 由既有共享凭据文件方案覆盖）。

## Capabilities

### Modified Capabilities

- `raccoon-login`: 登录方式集合从 {微信扫码, 短信验证码} 扩展为
  {微信扫码, 短信验证码, 密码登录}；本地登录页三 Tab；编排器新增
  密码登录直连通道。
