/**
 * 从 DSH 导入账号、凭据与模型开关。
 *
 * ## 只读保证
 *
 * ⚠️ 本模块**永不写入** DSH 的数据文件（`.credentials.yaml` / `jet-hub/state.json`）。
 * 导入是单向的：DSH → all_proxy。这样即使导入逻辑有 bug，也不影响用户当前的
 * DSH 使用。见 AGENTS.md 的「数据与安全」。
 *
 * ## 为什么不用 YAML 解析库
 *
 * `.credentials.yaml` 是外部文档，本项目**只能读、不能依赖其结构稳定性**。
 * 引入 `yaml` 依赖只为读一个文件不值得，且来源已用最小文本扫描验证过可行
 * （见 `jet-hub-store.ts` 的 `extractCredentialRefNames`）。
 * 这里沿用同一思路并**修正了来源的一个缺口**（见 {@link ACCOUNT_REF_RE}）。
 *
 * ## 一次性 refresh token 的警告
 *
 * `codearts` 与 `trae` 的 `refresh_token` **用一次即作废**。导入后若两边都刷新，
 * 会互相作废、把两边的账号都弄死。故导入结果里对这两类 provider 给出显式警告。
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { AccountPool } from '../pool/account-pool.js'
import type { PoolState } from '../pool/state-store.js'
import type { ProviderAccountEntry } from '../pool/types.js'
import type { CredentialStore } from '../pool/types.js'
import type { Logger } from '../pool/store.js'

/**
 * 账号凭据 ref 的前缀 → provider id。
 *
 * ⚠️ **比来源多四个**：来源的 `PROVIDER_BY_REF_PREFIX` 只列了 6 个
 * （CODEARTS / BUDDY / WORKBUDDY / LOBSTERAI / QODER / TRAE），遗漏了
 * `QODERCN` / `CLINE` / `LOOMY` / `RACCOON` —— 于是那四类账号在来源的
 * 「从凭据文件恢复账号索引」路径上会被**静默丢弃**。
 *
 * 用户的凭据文件里确实有 `LOOMY_ACCOUNT_*` / `RACCOON_ACCOUNT_*` /
 * `QODERCN_ACCOUNT_*`，故这里必须补全。
 */
const PROVIDER_BY_REF_PREFIX: Record<string, string> = {
  CODEARTS: 'codearts',
  BUDDY: 'buddy',
  WORKBUDDY: 'workbuddy',
  LOBSTERAI: 'lobsterai',
  QODER: 'qoder',
  QODERCN: 'qodercn',
  TRAE: 'trae',
  CLINE: 'cline',
  LOOMY: 'loomy',
  RACCOON: 'raccoon',
  OFFICEACE: 'officeace',
  ACCIO: 'accio',
  // SenseNova（商汤开放平台）：静态 API Key，DSH 里本无其登录态，
  // 但本项目的「粘贴 key 建号」会造出 `SENSENOVA_ACCOUNT_*` ref，
  // 故登记以保证 ACCOUNT_REF_RE 与本表一致（否则自建 ref 会被判为不可识别）。
  SENSENOVA: 'sensenova',
}

/**
 * 账号凭据 ref 形态：`{PREFIX}_ACCOUNT_{HEX}`。
 *
 * ⚠️ 前缀集合必须与 {@link PROVIDER_BY_REF_PREFIX} 一致 —— 少一个就会让那类
 * 账号在导入时被静默丢弃（来源正是如此漏掉了四个）。
 */
const ACCOUNT_REF_RE = /^(CODEARTS|BUDDY|WORKBUDDY|LOBSTERAI|QODER|QODERCN|TRAE|CLINE|LOOMY|RACCOON|OFFICEACE|ACCIO|SENSENOVA)_ACCOUNT_([0-9A-Fa-f]{6,})$/

/**
 * `refresh_token` 一次性轮换的 provider。
 *
 * ⚠️ 这些 provider 的 refresh token **用一次即作废**（华为实测
 * `STS5.1806 the refresh token has been used`；TRAE 每次 `ExchangeToken` 都轮换）。
 * OfficeAce（华为 MDS）同样一次性；Accio（阿里）参考实现明确记录「刷新会轮换
 * refresh_token」。导入后若 DSH 与 all_proxy 都去刷新，会互相作废。
 */
const ROTATING_REFRESH_PROVIDERS = new Set(['codearts', 'trae', 'officeace', 'accio'])

/** 导入来源路径。 */
export interface DshPaths {
  /** DSH home（默认 `~/.dsh`）。 */
  home: string
  /** 凭据文件（`$DSH_HOME/.credentials.yaml`）。 */
  credentials: string
  /** 账号状态文件（`$DSH_HOME/jet-hub/state.json`）。 */
  state: string
}

/** 解析 DSH 数据路径（可用 `DSH_HOME` 覆盖）。 */
export function resolveDshPaths(home?: string): DshPaths {
  const base = home
    ?? (process.env['DSH_HOME']?.trim().length ? process.env['DSH_HOME'].trim() : join(homedir(), '.dsh'))
  return {
    home: base,
    credentials: join(base, '.credentials.yaml'),
    state: join(base, 'jet-hub', 'state.json'),
  }
}

/**
 * 从 `.credentials.yaml` 的 `refs:` 段提取 ref 名与值。
 *
 * 判据：缩进 ≥2 且以大写标识符开头；回到顶格键时结束。值取该行冒号后的部分，
 * 去掉 YAML 单引号包裹（内部 `''` 表示一个 `'`）。
 *
 * ⚠️ 只做**最小、保守**的扫描：凭据文件是外部文档，不保证可被严格解析。
 * 解析不出的行**跳过而不是报错** —— 一个坏行不该让整个导入失败。
 */
export function parseCredentialRefs(text: string): Map<string, string> {
  const refs = new Map<string, string>()
  let inRefs = false
  for (const line of text.split(/\r?\n/)) {
    if (/^refs:\s*$/.test(line)) {
      inRefs = true
      continue
    }
    if (!inRefs) continue
    // 回到顶格键（如 `records:`）即结束 refs 段。
    if (/^\S/.test(line)) break
    const match = /^\s{2,}([A-Z][A-Z0-9_]*):\s*(.*)$/.exec(line)
    if (match === null) continue
    const [, name, rawValue] = match
    if (name === undefined) continue
    let value = (rawValue ?? '').trim()
    // 去掉 YAML 单引号包裹。
    if (value.startsWith("'") && value.endsWith("'") && value.length >= 2) {
      value = value.slice(1, -1).replace(/''/g, "'")
    }
    refs.set(name, value)
  }
  return refs
}

/** 由一个账号凭据 ref 合成账号条目（昵称缺失时退回账号 id）。 */
export function accountFromCredentialRef(ref: string, value?: string): ProviderAccountEntry | undefined {
  const match = ACCOUNT_REF_RE.exec(ref)
  if (match === null) return undefined
  const provider = PROVIDER_BY_REF_PREFIX[match[1] ?? '']
  const suffix = match[2]
  if (provider === undefined || suffix === undefined) return undefined
  const id = `${provider}-${suffix.toLowerCase()}`

  // 尽量从凭据里取更友好的昵称与过期时间；取不到就退回 id。
  let nickname = id
  let expiresAt: number | undefined
  if (value !== undefined && value.length > 0) {
    try {
      const parsed = JSON.parse(value) as Record<string, unknown>
      if (typeof parsed['nickname'] === 'string' && parsed['nickname'].length > 0) {
        nickname = parsed['nickname']
      }
      const raw = parsed['expires_at'] ?? parsed['expire_time']
      const num = typeof raw === 'string' ? Number(raw) : typeof raw === 'number' ? raw : Number.NaN
      if (Number.isFinite(num) && num > 0) expiresAt = num
    } catch {
      // 凭据值不是 JSON：保留 id 作昵称，不阻断导入。
    }
  }

  return {
    id,
    provider,
    nickname,
    enabled: true,
    credentialRef: ref,
    createdAt: Date.now(),
    refreshable: true,
    ...expiresAt === undefined ? {} : { expiresAt },
  }
}

/** 导入结果。 */
export interface ImportResult {
  /** 新增的账号数。 */
  added: number
  /** 更新（已存在）的账号数。 */
  updated: number
  /** 导入的凭据数。 */
  credentials: number
  /** 导入的模型黑名单条目数（provider 数）。 */
  disabledModelProviders: number
  /** 导入前备份文件路径（若产生了备份）。 */
  backupPath?: string
  /** 需要用户注意的警告。 */
  warnings: string[]
  /** 跳过原因摘要（便于排查「为什么少了一个账号」）。 */
  skipped: string[]
}

/** 导入选项。 */
export interface ImportOptions {
  pool: AccountPool
  credentials: CredentialStore
  logger?: Logger
  /** DSH 数据路径；省略则按 {@link resolveDshPaths} 解析。 */
  paths?: DshPaths
  /** 备份写出目录；省略则不备份（测试用）。 */
  backupDir?: string
}

/**
 * 执行导入。
 *
 * 语义（规格 `account-pool`）：
 * - 读 DSH 的凭据与状态文件（**只读**）；
 * - 账号按凭据 ref **幂等**：已存在则更新（保留用户在本项目里的启用状态与顺序）；
 * - 一并导入 `disabledModels`（否则会暴露用户刻意关闭的模型）；
 * - 导入前备份本项目现有数据；
 * - 对一次性 refresh token 的 provider 给出警告。
 */
export async function importFromDsh(options: ImportOptions): Promise<ImportResult> {
  const paths = options.paths ?? resolveDshPaths()
  const warnings: string[] = []
  const skipped: string[] = []

  if (!existsSync(paths.credentials)) {
    throw new Error(`未找到 DSH 凭据文件: ${paths.credentials}`)
  }

  // ── 1. 解析凭据 ──
  const refs = parseCredentialRefs(readFileSync(paths.credentials, 'utf-8'))
  if (refs.size === 0) {
    throw new Error(`DSH 凭据文件的 refs 段为空: ${paths.credentials}`)
  }

  // ── 2. 备份本项目现有数据 ──
  let backupPath: string | undefined
  if (options.backupDir !== undefined) {
    backupPath = backupCurrent(options.backupDir, options.pool, options.credentials)
  }

  // ── 3. 导入凭据 ──
  // ⚠️ **只导入本项目会用到的凭据**：账号 ref（`*_ACCOUNT_*`）与各 provider 的
  // 单凭据回退 ref。其余（如 `OPENCODE_API_KEY` / `ROUTER999_API_KEY`）是 DSH
  // 自己或其它插件的凭据，导入过来毫无用处，只会让本项目的凭据文件膨胀、
  // 扩大敏感面。
  const singleCredentialRefs = new Set([
    'CODEARTS_ACCESS_TOKEN', 'BUDDY_ACCESS_TOKEN', 'WORKBUDDY_ACCESS_TOKEN',
    'LOBSTERAI_ACCESS_TOKEN', 'QODER_ACCESS_TOKEN', 'QODERCN_ACCESS_TOKEN',
    'TRAE_ACCESS_TOKEN', 'CLINE_ACCESS_TOKEN', 'LOOMY_ACCESS_TOKEN', 'RACCOON_ACCESS_TOKEN',
    'OFFICEACE_ACCESS_TOKEN', 'ACCIO_ACCESS_TOKEN', 'SENSENOVA_ACCESS_TOKEN',
  ])
  let credentialCount = 0
  for (const [ref, value] of refs) {
    const isAccountRef = ACCOUNT_REF_RE.test(ref)
    if (!isAccountRef && !singleCredentialRefs.has(ref)) {
      skipped.push(`${ref}: 与本项目无关的凭据，未导入`)
      continue
    }
    if (value.length === 0) {
      skipped.push(`${ref}: 值为空`)
      continue
    }
    await options.credentials.set(ref, value)
    credentialCount++
  }

  // ── 4. 合并账号条目（幂等：按 id 更新而非重复创建） ──
  const existing = await options.pool.listAllAccounts()
  const existingById = new Map(existing.map(entry => [entry.id, entry]))
  const incoming: ProviderAccountEntry[] = []
  for (const [ref, value] of refs) {
    const entry = accountFromCredentialRef(ref, value)
    if (entry === undefined) {
      skipped.push(`${ref}: 不是可识别的账号凭据 ref`)
      continue
    }
    incoming.push(entry)
  }

  let added = 0
  let updated = 0
  const merged = [...existing]
  for (const entry of incoming) {
    const prior = existingById.get(entry.id)
    if (prior === undefined) {
      merged.push(entry)
      added++
    } else {
      // ⚠️ 保留用户在本项目里的**启用状态**（停用是用户的决定，不该被导入覆盖）。
      const index = merged.findIndex(e => e.id === entry.id)
      merged[index] = { ...entry, enabled: prior.enabled }
      updated++
    }
  }

  // ── 5. 导入模型开关（若状态文件存在） ──
  let disabledModels: PoolState['disabledModels'] = {}
  let disabledModelProviders = 0
  if (existsSync(paths.state)) {
    try {
      const parsed = JSON.parse(readFileSync(paths.state, 'utf-8')) as Record<string, unknown>
      const raw = parsed['disabledModels']
      if (typeof raw === 'object' && raw !== null && !Array.isArray(raw)) {
        for (const [provider, models] of Object.entries(raw as Record<string, unknown>)) {
          if (typeof models !== 'object' || models === null || Array.isArray(models)) continue
          const perProvider: Record<string, boolean> = {}
          for (const [modelId, flag] of Object.entries(models as Record<string, unknown>)) {
            if (flag === true) perProvider[modelId] = true
          }
          if (Object.keys(perProvider).length > 0) {
            disabledModels[provider] = perProvider
            disabledModelProviders++
          }
        }
      }
    } catch (error) {
      warnings.push(`读取 DSH 状态文件失败，模型开关未导入: ${String(error)}`)
    }
  } else {
    warnings.push(`未找到 DSH 状态文件（${paths.state}），模型开关未导入`)
  }

  // ── 6. 写回本项目（整体替换，保留既有开关） ──
  const snapshot = options.pool.getStateSnapshot()
  await options.pool.replaceAll({
    accounts: merged,
    // 若 DSH 侧有开关则用 DSH 的，否则保留本项目现有开关。
    disabledModels: disabledModelProviders > 0 ? disabledModels : snapshot.disabledModels,
    globalModelsEnabled: snapshot.globalModelsEnabled,
    disabledProviders: snapshot.disabledProviders,
    permanentLocks: snapshot.permanentLocks,
    loomyPermanentLocked: snapshot.loomyPermanentLocked,
  })

  // ── 7. 一次性 refresh token 的警告 ──
  const rotating = [...new Set(incoming
    .map(entry => entry.provider)
    .filter(provider => ROTATING_REFRESH_PROVIDERS.has(provider)))]
  if (rotating.length > 0) {
    warnings.push(
      `以下 provider 的 refresh_token 是**一次性轮换**的：${rotating.join(', ')}。`
      + ' 导入后建议**只让一边刷新**（要么用 all_proxy，要么用 DSH），'
      + '否则两边会互相作废、导致账号需要重新登录。',
    )
  }

  options.logger?.info(
    `[import] 从 DSH 导入完成: 新增 ${added}、更新 ${updated}、凭据 ${credentialCount}、`
    + `模型开关 ${disabledModelProviders} 个 provider`,
  )
  for (const warning of warnings) options.logger?.warn(`[import] ${warning}`)

  return {
    added,
    updated,
    credentials: credentialCount,
    disabledModelProviders,
    ...backupPath === undefined ? {} : { backupPath },
    warnings,
    skipped,
  }
}

/**
 * 备份本项目当前数据到一个 JSON 文件。
 *
 * ⚠️ **备份内容含凭据明文**（refresh token 等同账号凭证），故文件名带时间戳、
 * 且文档中明确提示妥善保管。备份是导入前的安全网：导入逻辑有误时可据此回退。
 */
export function backupCurrent(
  backupDir: string,
  pool: AccountPool,
  credentials: CredentialStore,
): string {
  mkdirSync(backupDir, { recursive: true })
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const path = join(backupDir, `backup-${stamp}.json`)
  const payload = {
    // ⚠️ 含凭据明文，请妥善保管。
    warning: '本文件含账号凭据（refresh token 等同账号凭证），请妥善保管、勿外泄。',
    createdAt: new Date().toISOString(),
    state: pool.getStateSnapshot(),
    credentials: credentials.snapshot?.() ?? {},
  }
  writeFileSync(path, JSON.stringify(payload, null, 2), 'utf-8')
  return path
}
