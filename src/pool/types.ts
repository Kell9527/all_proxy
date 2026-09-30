/**
 * 账号池相关的核心类型。
 *
 * 移植自来源 `src/types.ts` 的账号部分（去掉了与本项目无关的 RPC/登录类型）。
 */

/** 单模型限流标记。 */
export interface ModelRateLimit {
  modelId: string
  /** 重置时间戳（毫秒）；0 或缺失 = 不在重置期 */
  resetAtMs: number
}

/** 账号索引条目（凭据本体单独存于凭据存储）。 */
export interface ProviderAccountEntry {
  /** 账号唯一标识：`{provider}-{shortid}`（如 `codearts-a1b2c3d4`） */
  id: string
  /** provider 名称：`codearts` | `buddy` | ... */
  provider: string
  /** 用户可读昵称 */
  nickname: string
  /** 是否启用（停用不参与自动选号，但**仍参与续期**） */
  enabled: boolean
  /** 对应的凭据 ref 名称：`{PROVIDER}_ACCOUNT_{HEX}` */
  credentialRef: string
  /** 创建时间（毫秒时间戳） */
  createdAt: number
  /** 凭据过期时间（毫秒时间戳），用于展示 */
  expiresAt?: number
  /** 是否可静默续期 */
  refreshable: boolean
  /** 每个模型的重置时间，key = 模型 id（毫秒时间戳） */
  modelRateLimits?: Record<string, number>
  /**
   * TRAE 签到设备轮换代次（仅 `trae` provider 使用）。
   *
   * 业务码 `9074`（签到人数过多）的限流范围是 **device_id 而非账号**：
   * 命中后把代次 +1，即可由 `device_id` 派生出全新的签到设备号绕开它。
   *
   * 这里只存**整数代次**而不是新设备号本身：派生结果由
   * `(credential.device_id, generation)` 唯一决定，故无需改写凭据本体
   * （登录凭据里的 `device_id` 是设备指纹，动它会牵涉风控）。
   *
   * 缺省/0 = 使用凭据原始 `device_id`，既有账号行为完全不变。
   */
  traeCheckinDeviceGeneration?: number
}

/** 账号详细状态（返回给管理端展示）。 */
export interface ProviderAccountStatus extends ProviderAccountEntry {
  /** 最近刷新错误 */
  refreshError?: string
  /** 凭据来源（`file` / `env` 等） */
  source?: string
}

/**
 * 凭据存储接口。
 *
 * 语义与 DSH 的 `ctx.credentials` 对齐（`resolve` / `describe` / `set` / `unset`），
 * 这样移植过来的账号池只需替换调用目标、逻辑不变。
 *
 * ## 两种 ref 形态（见 `credential-ref-kind.ts`）
 *
 * - **内置**（默认，形如 `RACCOON_ACCOUNT_443D46EE`）：值存在本项目自己的
 *   凭据文件里；
 * - **文件引用**（`FILE:<绝对路径>`）：值存在**外部文件**里，`resolve` 实时读、
 *   `set` 原子写回、`unset` 绝不删文件。
 *
 * 调用方**无需区分**：同一套接口对两种形态都成立。唯一需要留意的是
 * `snapshot` / `replaceAll` **不含**文件引用（备份由 `providers/backup.ts`
 * 专门内联处理）。
 */
export interface CredentialStore {
  /** 读取凭据原文；不存在时 `undefined`。 */
  resolve(ref: string): Promise<{ value: string; source?: string } | undefined>
  /** 读取凭据元信息（不返回敏感值）。 */
  describe(ref: string): Promise<{ source?: string; exists: boolean }>
  /** 写入凭据（整体替换）。 */
  set(ref: string, value: string): Promise<void>
  /**
   * 删除凭据。
   *
   * ⚠️ 对**文件引用**是**无操作**：外部文件可能被其它消费者共享，删除会破坏
   * 本服务之外的凭据。摘除引用由账号池从账号索引里移除条目完成。
   */
  unset(ref: string): Promise<void>
  /**
   * 全部内置凭据的深拷贝（供备份导出）。
   *
   * ⚠️ 返回值**含凭据明文**，调用方必须妥善处理（只写入受保护的备份文件，
   * 绝不写日志、绝不出现在错误响应里）。
   * ⚠️ **不含文件引用**；备份需要它时由 `providers/backup.ts` 逐个内联。
   */
  snapshot?(): Record<string, string>
}
