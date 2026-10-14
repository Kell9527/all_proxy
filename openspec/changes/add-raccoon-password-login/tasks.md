# Tasks

- [x] 实测确认官网密码登录端点（`login_with_password`）的请求体、加密方式、
  错误码，并排除「Referer 校验」误判（受控实验）
- [x] `src/providers/raccoon-oauth.ts`：新增 `loginRaccoonWithPassword`
  （手机号与密码均 AES-128-CFB 加密；限流错误转可操作文案；凭据解析复用）
- [x] `tests/unit/raccoon-oauth.spec.ts`：密文提交、成功凭据、缺 token、
  账密错误、限流文案 5 条用例
- [x] `src/providers/raccoon-login-page.ts`：`RACCOON_LOGIN_PAGE_PATHS`
  加 `passwordLogin`；`/raccoon/password/login` 处理分支（手机号格式与空
  密码本地校验，失败不终止流程）；HTML 三 Tab + 密码 pane + 提交逻辑
- [x] `tests/unit/raccoon-login-page.spec.ts`：三 Tab 断言、密码登录成功落
  result、非法手机号 / 空密码拒绝、密码错误可重试 4 条用例
- [x] `src/login/orchestrator.ts`：`completePasswordLogin` 通道（对齐
  `completeSmsLogin`：协议调用 → `classifyLoginError` 归因 → `settle` 落库）
- [x] `src/admin/router.ts`：`POST /api/login/password/complete` 路由
- [x] `tests/unit/login-orchestrator.spec.ts`：加密提交 + 落库、账密错误归因、
  不支持 provider 3 条用例
- [x] `npm run typecheck` 通过；`npm test` 全量通过（116 文件 2910 用例）
- [x] 管理端「密码登录」面板（`web/src/admin-panels.js`）：新 Tab + `PasswordPanel`
  （Raccoon 手机号 + 密码 → `/api/login/password/complete`），SmsPanel 文案同步更新
- [x] `npm run build:all` 全量构建（tsc + WASM 资产 + vite），产物验证：
  后端含 `passwordLogin` 路由与 `loginRaccoonWithPassword`；前端 bundle 含
  「Raccoon 密码登录」面板与路由调用；管理端页面引用新 bundle；
  `POST /api/login/password/complete` 空 body 返回 401（存在）而非 404
- [x] 冒烟：本地登录页三 Tab 渲染、密码 pane、SVG 可解析、密码端点 200 凭据落定
