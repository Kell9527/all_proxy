/**
 * 账号卡片「凭据」一栏的展示串解析：**能显示手机号就显示手机号**。
 *
 * ## 为什么需要它
 *
 * 内置凭据的 ref 名是 `RACCOON_ACCOUNT_738F4780` 这类**机器生成**的标识，
 * 用户看不出「这条凭据是哪个号」。Loomy 只能靠手机号验证码重新登录，过期时
 * 用户必须对照手机号才知道该登哪个号 —— 所以 Loomy 的卡片「凭据」一栏直接
 * 显示手机号（凭据 JSON 里的 `phone` 字段，登录时就写好了）。
 *
 * raccoon / accio 的凭据里**没有**手机号（登录响应不回传），但两者都有
 * **只读**的身份端点能拿到：
 *
 * | provider | 端点 | 字段 | 形态 |
 * |---|---|---|---|
 * | raccoon | `GET {apiBase}/v1/user_info` | `phone` | 完整 11 位 |
 * | accio | `POST /api/auth/userinfo` | `maskedMobile` | 上游脱敏 `+86 189****3950` |
 *
 * 取不到时按 provider 回退：officeace 显示华为 `accountId`（上游**没有**任何
 * 手机号来源，见下），其余显示 ref 名 —— 与改动前完全一致。
 *
 * ## 为什么只做内存缓存、绝不写回凭据
 *
 * 「读 → 补字段 → 写回」这段读-改-写**不在**刷新单飞锁
 * （`pool/refresh-coordinator.ts`）内：raccoon / officeace / trae 的
 * `refresh_token` 一次性轮换，只要有一次并发刷新落在这段窗口里，写回就会把
 * 新 token 整份覆盖掉，好账号当场刷死。手机号又是几乎不变的展示数据，故只在
 * 进程内缓存、不落盘；服务重启后第一次打开面板各查一次。
 *
 * ## 为什么不做掩码
 *
 * 用户的用途是**照着重新登录**，掩码号（`138****8000`）没法直接输入，等于没
 * 显示。这里是本地管理端（默认仅监听 127.0.0.1），且凭据文件里本来就明文存着
 * 同一个手机号，展示明文不新增任何泄露面。accio 的 `maskedMobile` 是**上游**
 * 脱敏后的值，本地原样呈现（不臆造完整号，也没有别的端点能拿到）。
 *
 * ## 已知限制：OfficeAce 拿不到手机号
 *
 * 华为云 OAuth（client_id `pdp5_for_agentarts`，scope 仅 `openid`）不下发
 * 手机号，实测（2026-10-14）：
 *
 * - `client-permission-validate` 只回 `account_id` / `principal_urn` /
 *   `principal_id` 与订阅信息；
 * - `/v1/subscription` 只回 `domain_id` / `subscribe_status` / `skus` 等；
 * - `/v1/claw/{user,user_info,userinfo,account,profile,client-info,auth/user}`
 *   全部 `404 APIGW.0101 The API does not exist`。
 *
 * 故 OfficeAce 退一档显示 `accountId`：它与服务日志里
 * 「登录成功（accountId=…）」同源，用户可对照排查是哪个华为账号。
 */

import type { CredentialStore } from '../pool/types.js'
import type { Logger } from '../pool/store.js'
import { RACCOON } from '../providers/raccoon-product.js'
import { fetchRaccoonUserInfo } from '../providers/raccoon-oauth.js'
import type { RaccoonCredential } from '../providers/raccoon.js'
import { fetchAccioUserInfo } from '../providers/accio-credits.js'
import type { AccioCredential } from '../providers/accio.js'

/** 取到过的手机号：几乎不变，缓存 6 小时。 */
const PHONE_HIT_TTL_MS = 6 * 60 * 60 * 1000

/**
 * 取不到的 TTL：**短**（1 分钟）。
 *
 * 凭据刚续期好、或上游刚刚抖动时，用户刷新一下面板就能拿到，不必重启服务；
 * 又不至于在每次轮询里反复打上游。
 */
const PHONE_MISS_TTL_MS = 60 * 1000

/**
 * 凭据 JSON 里可直接用作展示的手机号字段（按序取第一个非空串）。
 *
 * `phone`：loomy / raccoon（trae 也有，但是上游脱敏形态）；`maskedMobile`：
 * accio（`accio-credits.ts` 的字段名，与官方 schema 逐字对应）。`mobile` 是
 * 防御性预留 —— 目前没有任何 provider 用它。
 */
const PHONE_FIELDS = ['phone', 'mobile', 'maskedMobile'] as const

/** {@link AccountPhoneResolver} 的依赖。 */
export interface AccountPhoneDeps {
  credentials: CredentialStore
  /** 注入的 fetch（上游身份查询用；测试替身注入点）。省略时用全局 `fetch`。 */
  fetcher?: typeof fetch
  logger?: Logger
}

/**
 * 账号 → 展示用手机号（进程内缓存）。
 *
 * 每个 `createAdminHandler` 一份；测试可自建独立实例以隔离缓存。
 */
export class AccountPhoneResolver {
  private readonly cache = new Map<string, { phone: string | undefined; until: number }>()

  constructor(private readonly deps: AccountPhoneDeps) {}

  /**
   * 解析账号的展示串。
   *
   * @param provider - provider id（决定上游查询走哪条链）。
   * @param ref - 账号的 `credentialRef`（**仅内置 ref**；文件引用由调用方
   *   展示脱敏路径，与 Loomy 的既有行为一致，不会进到这里）。
   * @returns 手机号 / 次优标识；一律取不到时 `undefined`（调用方回退 ref 名）。
   *   **不抛错** —— 账号列表不能因为某个凭据读不了就整页 500。
   */
  async resolve(provider: string, ref: string): Promise<string | undefined> {
    const key = `${provider}\u0000${ref}`
    const hit = this.cache.get(key)
    if (hit !== undefined && hit.until > Date.now()) return hit.phone

    const phone = await this.lookup(provider, ref)
    this.cache.set(key, {
      phone,
      until: Date.now() + (phone === undefined ? PHONE_MISS_TTL_MS : PHONE_HIT_TTL_MS),
    })
    return phone
  }

  /** 缓存未命中时的实际解析（读凭据 → 取字段 → 打上游）。 */
  private async lookup(provider: string, ref: string): Promise<string | undefined> {
    const resolved = await this.deps.credentials.resolve(ref).catch((error: unknown) => {
      // 凭据读失败不是错误：账号可能刚被删、或共享文件还没被官方客户端写出来。
      this.deps.logger?.warn?.(`[account-phone] 读取凭据失败（${ref}）: ${String(error)}`)
      return undefined
    })
    if (resolved === undefined) return undefined

    let credential: Record<string, unknown>
    try {
      const parsed: unknown = JSON.parse(resolved.value)
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return undefined
      credential = parsed as Record<string, unknown>
    } catch {
      // 凭据值不保证是 JSON（各 provider 形态不一），解析失败即视为「没有」。
      return undefined
    }

    const stored = storedDisplayOf(provider, credential)
    if (stored !== undefined) return stored
    return this.fetchUpstream(provider, credential)
  }

  /**
   * 上游**只读**身份查询（仅 raccoon / accio 有）。
   *
   * 两个函数内部都不抛错（失败按「取不到」降级），这里的 `catch` 是兜底：
   * 凭据形状意外（如缺 `access_token`）也不该让账号列表失败。
   */
  private async fetchUpstream(provider: string, credential: Record<string, unknown>): Promise<string | undefined> {
    const fetcher = this.deps.fetcher ?? fetch
    try {
      if (provider === 'raccoon') {
        const info = await fetchRaccoonUserInfo(RACCOON, credential as unknown as RaccoonCredential, fetcher)
        return normalizePhone(info.phone)
      }
      if (provider === 'accio') {
        const info = await fetchAccioUserInfo(credential as unknown as AccioCredential, { fetcher })
        return normalizePhone(info?.maskedMobile)
      }
    } catch (error) {
      this.deps.logger?.warn?.(`[account-phone] ${provider} 查询账号身份失败: ${String(error)}`)
    }
    return undefined
  }
}

/** 去空白；空串按「没有」处理（不返回空串让调用方误判成有值）。 */
function normalizePhone(value: string | undefined): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : undefined
}

/** 凭据 JSON 里**已存在**的展示字段。 */
function storedDisplayOf(provider: string, credential: Record<string, unknown>): string | undefined {
  if (provider === 'officeace') {
    // 上游没有手机号（见文件头「已知限制」），退到华为账号 id。
    return normalizePhone(
      typeof credential['accountId'] === 'string' ? (credential['accountId'] as string) : undefined,
    )
  }
  for (const field of PHONE_FIELDS) {
    const value = normalizePhone(typeof credential[field] === 'string' ? (credential[field] as string) : undefined)
    if (value !== undefined) return value
  }
  return undefined
}
