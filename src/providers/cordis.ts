/**
 * `@deepseek-ai/cordis` 的最小本地 shim。
 *
 * ## 为什么需要它
 *
 * 从来源移植的 provider 文件里：
 * - `*-auth.ts` 继承 cordis 的 `Service` 基类，构造时 `super(ctx, name)`，
 *   并通过 `ctx.credentials` 读写凭据；
 * - 适配器 import `type Context` 仅作类型标注；
 * - 若干文件用 `declare module '@deepseek-ai/cordis'` 给 `Context` 增补服务字段。
 *
 * 本项目的 auth 类**不再自注册**（由 `src/providers/registry.ts` 统一装配），
 * 但为了不改动移植文件的实现，这里提供语义等价的最小基类与上下文形状。
 *
 * ## 与真实 cordis 的差异（有意）
 *
 * | 能力 | cordis | 本 shim |
 * |---|---|---|
 * | 服务容器（`provide`/`get`/按名注册） | 完整实现 | **不实现**：本项目无插件树 |
 * | `Service` 生命周期 | `start`/`stop`/`dispose` | 保留同名方法，签名放宽 |
 * | `ctx.credentials` | DSH 凭据服务 | 由调用方注入本项目的凭据存储适配器 |
 * | `ctx.logger` | 宿主注入 | 可选，缺省静默 |
 *
 * 差异是**刻意的**：本项目是独立 HTTP 服务，没有插件树与依赖注入需求。
 * 保留同名形状只为让移植文件不必改实现。
 *
 * ⚠️ **`declare module` 增补**：多个移植文件对 `'@deepseek-ai/cordis'` 做模块
 * 增补（给 `Context` 加 `buddyAuth` 等字段）。TypeScript 要求被增补的模块
 * **真实存在**，故这里通过 `declare module` 反向声明一个同名模块别名 ——
 * 见文件末尾的兼容声明。
 */

import type { CredentialStore } from '../pool/types.js'

/** 日志接口。 */
export interface LoggerLike {
  info(message: string): void
  warn(message: string): void
  error(message: string): void
  debug?(message: string): void
}

/**
 * DSH 凭据服务的最小形状。
 *
 * 移植的 auth 类只用到 `resolve` / `set` / `unset` / `describe`，故这里只声明
 * 这四个方法，由调用方注入本项目的 {@link CredentialStore} 适配器。
 */
export interface CredentialsLike {
  resolve(ref: unknown): Promise<{ value: string; source?: string } | undefined>
  describe(ref: unknown): Promise<{ source?: string; exists?: boolean; configured?: boolean; writable?: boolean }>
  set(ref: unknown, value: string): Promise<void>
  unset(ref: unknown): Promise<void>
  [key: string]: unknown
}

/**
 * 宿主上下文。
 *
 * ⚠️ 它同时是**接口**与**类**：来源的测试普遍写 `const ctx = new Context()`
 * 再 `ctx.provide('credentials', fake)`（cordis 的 `Context` 是类）。为了让
 * 那些测试无需改写即可运行，这里提供一个**最小服务容器**实现。
 *
 * ## 容器语义（刻意最小）
 *
 * | 方法 | 行为 |
 * |---|---|
 * | `provide(name, value)` | 注册一个服务 |
 * | `get(name)` | 取服务；未注册返回 undefined |
 * | `inject` / `effect` | **不实现**（本项目无插件树；调用会抛错以便尽早暴露） |
 *
 * ⚠️ 这**不是**通用 DI 容器，只是让移植的 auth 类与它们的测试能跑起来。
 * 本项目的正式装配走 `src/providers/registry.ts`，不依赖这里。
 */
export class Context {
  /** 日志（可选）。 */
  logger?: LoggerLike
  /** 已注册的服务（name → value）。 */
  private readonly services = new Map<string, unknown>()

  constructor(seed: Record<string, unknown> = {}) {
    for (const [key, value] of Object.entries(seed)) this.services.set(key, value)
  }

  /**
   * 注册一个服务。
   *
   * ⚠️ **同时写进 Map 与实例属性**：cordis 的 `ctx` 用 Proxy 让
   * `ctx.<serviceName>` 直接可读，移植的 auth 类与它们的测试都按属性访问
   * （`ctx.buddyAuth` / `ctx.credentials`）。只写 Map 会让那些访问拿到
   * `undefined`，而测试报的是「expected undefined to be an instance of …」，
   * 看起来像构造没执行，实际是服务查找没走通。
   */
  provide(name: string, value: unknown): void {
    this.services.set(name, value)
    ;(this as unknown as Record<string, unknown>)[name] = value
  }

  /** 取一个服务；未注册返回 undefined。 */
  get(name: string): unknown {
    return this.services.get(name)
  }

  /**
   * 凭据服务（由装配方通过 `provide('credentials', ...)` 注入）。
   *
   * ⚠️ 声明为**可写字段**而不是只读 getter：移植的测试会写
   * `ctx.provide('credentials', fake)`，若定义成 getter，赋值会抛
   * `Cannot set property credentials of #<Context> which has only a getter`。
   *
   * ⚠️ 类型上声明为**非可选**（`CredentialsLike`）：移植的 auth 类直接写
   * `this.ctx.credentials.resolve(...)`，不做空值判断。若这里声明成可选，
   * 它们会全部报「Object is possibly 'undefined'」，而那需要改动几十处实现 ——
   * 与本项目的移植策略相悖。缺凭据服务属**装配错误**，由装配方保证；
   * 真忘了注入时会在第一次读写凭据时抛 TypeError，而不是静默出错。
   */
  credentials!: CredentialsLike

  /**
   * DSH 的 LLM 服务。
   *
   * ⚠️ **本项目不实现它**：注册 provider 由 `src/providers/registry.ts` 负责。
   * 这里给出空实现，只为让移植过来的 `register*Llm(ctx, ...)` 能通过类型检查；
   * 本项目的装配**不调用那些函数**，故它们永不会被执行。
   */
  get llm(): {
    registerConfigurableProviders(entries: unknown[]): void
    registerAdapter(providers: readonly string[], adapter: unknown): void
    [key: string]: unknown
  } {
    return {
      registerConfigurableProviders: () => {},
      registerAdapter: () => {},
    }
  }

  /** 账号池（由装配方注册）。 */
  get accountPool(): unknown {
    return this.services.get('accountPool')
  }
}

/**
 * 服务基类（最小等价实现）。
 *
 * ⚠️ `stop` 的签名放宽为「同步或异步皆可」：来源各 auth 类的 `stop()`
 * 有的是 `() => void`、有的是 `async`。真实 cordis 的基类没有 `stop`，
 * 这些方法是子类**自己新增**的；本 shim 若把它声明成 `Promise<void>`，
 * 子类的同步实现就会报类型不兼容。
 */
export class Service {
  constructor(
    protected readonly ctx: Context,
    /** 服务名（移植的 auth 类用它自注册为 `ctx.<name>`）。 */
    protected readonly name: string = 'service',
  ) {
    // 与真实 cordis 一致：构造时把自身注册进上下文，使 `ctx.<name>` 可读。
    // 移植的 auth 类依赖这一点（`ctx.buddyAuth` / `ctx.qoderAuth` 等），
    // 且它们的测试直接断言「构造后 ctx 上有该服务」。
    this.ctx?.provide?.(name, this)
  }

  /** 启动钩子（空实现）。 */
  async start(): Promise<void> {}

  /** 停止钩子（空实现）。 */
  stop(): void | Promise<void> {}

  /** 释放钩子（空实现）。 */
  [Symbol.dispose](): void {}
}

/**
 * 供调用方构造一个最小上下文（测试与装配用）。
 *
 * ⚠️ 返回值经过一次 `as unknown as Context` 断言：多个移植的 auth 文件对
 * `Context` 做了**模块增补**（各自加上 `buddyAuth` / `qoderAuth` 等字段），
 * 于是 `Context` 在类型层面要求那些字段存在。本函数构造的是「通用最小上下文」，
 * 那些 provider 专属字段由各自的装配补上 —— 且它们在本项目的运行路径上
 * **从不被读取**（服务容器不存在）。
 */
export function makeContext(credentials: CredentialsLike, logger?: LoggerLike): Context {
  const ctx = new Context({ credentials })
  if (logger !== undefined) ctx.logger = logger
  return ctx as unknown as Context
}

/** 把本项目的凭据存储适配成 DSH 形状的 `CredentialsLike`。 */
export function credentialsFromStore(store: CredentialStore): CredentialsLike {
  return {
    resolve: (ref) => store.resolve(String(ref)),
    describe: async (ref) => {
      const info = await store.describe(String(ref))
      return { source: info.source, exists: info.exists, configured: info.exists, writable: true }
    },
    set: (ref, value) => store.set(String(ref), value),
    unset: (ref) => store.unset(String(ref)),
  }
}
