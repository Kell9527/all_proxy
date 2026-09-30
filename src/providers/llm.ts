/**
 * 本地词汇表转发。
 *
 * 从来源移植的 provider 文件里，`@deepseek-ai/dsh-llm` 被统一替换为 `./llm.js`
 * （见 `scripts/port-providers.mjs`），而本文件位于 `src/providers/` 下，
 * 故这里把 `src/shared/llm.ts` 原样转发出去。
 *
 * ⚠️ 只做转发，**不要**在这里加任何实现 —— 真正的定义在 `src/shared/llm.ts`。
 */
export * from '../shared/llm.js'
