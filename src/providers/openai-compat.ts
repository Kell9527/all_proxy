/**
 * `openai-compat.js` 的转发 shim。
 *
 * 来源的 provider 文件与该模块同目录，故写 `./openai-compat.js`。本项目的实现在
 * `src/shared/`，这里转发出去，让移植文件**无需改动 import 路径**。
 *
 * ⚠️ 只做转发，不要在这里加实现。
 */
export * from '../shared/openai-compat.js'
