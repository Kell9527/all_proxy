/**
 * Magicrew（超级麦吉）的**登录腿**：开一个独立 profile 的浏览器窗口 →
 * 等用户在里面登完 → 读回凭据 → 签发 `mgw_` key → 取昵称/手机号。
 *
 * 移植自 `deepseek-harness-codearts` 的 `magicrew-auth.ts`（`loginViaBrowser`）
 * 与 `magicrew-browser-login.ts`。**浏览器那一层原样保留**（判据逐条真机取证），
 * 本文件只做「把它接到本项目的登录编排契约上」这一层适配。
 *
 * ## ⚠️⚠️ 多账号：靠「每次登录一个一次性 profile」
 *
 * 上游没有 OAuth 回调，凭据只存在于浏览器 localStorage。于是登录 =
 * 「起一个干净窗口，用户自己登，我们把凭据读回来」。
 *
 * **复用 profile 会让第二个账号一秒内读到上一个账号的 jwt**（来源记过这条：
 * 同一个 accountId/uid 被按契约判成「替换旧账号」⇒ 建不出新账号）。
 * 故 `profilePrefix` 每次登录都是新目录 —— 这一步在 `magicrew-browser-login.ts`
 * 里（`mkdtempSync`），**不要**在本文件传一个固定 profile 路径进来。
 *
 * ## ⚠️⚠️ 签新 key 会吊销旧 key
 *
 * 本家硬约束（来源模块头第 1 条）⇒ 整个 provider 只允许**两个**签发入口：
 * 「登录」（本文件）与「续期」（`magicrew-auth.ts` 的 `refreshMagicrewKey`）。
 * **绝不在热路径**（推理前）签发：热路径签一次，正在并发的另一次请求立刻拿到
 * 死 key（症状：偶发「token无效」，而重试又能成 —— 极难复现的那种）。
 *
 * ## ⚠️ 手机号：上游给的是**本地号码（10 位）**，要归一成 11 位
 *
 * 来源刻意**不**把 `phone` 写进凭据（那条字段的消费者是 11 位脱敏判据，
 * 填 10 位进去只会得到错位的掩码串）。本项目对手机号有统一展示机制
 * （`src/admin/account-phone.ts`），故这里把它写进凭据的 `phone` 字段，
 * 但**必须先补上国家码**（`state_code`）—— 见 {@link normalizeMagicrewPhone}。
 */

import {
  issueMagicrewGatewayKey, magicrewExpiresAtMs, type MagicrewCredential,
} from '../providers/magicrew-auth.js'
import { startMagicrewBrowserLogin } from '../providers/magicrew-browser-login.js'
import { fetchMagicrewProfile } from '../providers/magicrew-profile.js'
import { MAGICREW, type MagicrewProduct } from '../providers/magicrew-product.js'

/** 登录结果（本项目 `ChannelOutcome` 的上游形状，由调用方映射）。 */
export interface MagicrewLoginResult {
  /** 凭据 JSON（`MagicrewCredential` 的序列化）。 */
  readonly access: string
  /** 到期时刻（毫秒）；`undefined` = 未知（如实留空，不编造）。 */
  readonly expires?: number
  /** 展示昵称（上游 profile 的 `nickname` / `real_name`）。 */
  readonly nickname?: string
  /**
   * 展示手机号（**已归一成 11 位**，可直接用于卡片展示与重新登录对照）。
   *
   * ⚠️ 同时也会写进凭据 JSON 的 `phone` 字段 —— `account-phone.ts` 的
   * `PHONE_FIELDS` 会读它，故面板「凭据」一栏直接显示手机号。
   */
  readonly phone?: string
}

export interface MagicrewLoginOptions {
  readonly product?: MagicrewProduct
  readonly fetchImpl?: typeof fetch
  /** 等待用户完成登录的上限（毫秒）。 */
  readonly timeoutMs?: number
  /** 诊断输出（超时那一行「CDP 与磁盘都没读到凭据」靠它留痕）。 */
  readonly log?: (message: string) => void
  /**
   * 注入点：**单测用假会话，绝不真起浏览器**。
   *
   * ⚠️ 缺省 = 真起浏览器。单测**必须**注入它 —— 本仓库记过两次
   * 「单测弹出真实浏览器窗口」的真实污染。
   */
  readonly sessionFactory?: Parameters<typeof startMagicrewBrowserLogin>[0] extends
    { sessionFactory?: infer F } | undefined ? F : never
  /**
   * 账号资料取数器（**注入点，单测专用**；缺省 = 真发请求）。
   *
   * ⚠️ 为什么需要注入：昵称与手机号都要额外一次网络往返，不注入的话
   * 「取到就写进凭据」「取不到不挡登录」这两条判据只能靠真发请求断言。
   */
  readonly profileFetcher?: (params: {
    jwt: string
    organizationCode: string
    product: MagicrewProduct
  }) => Promise<{ nickname: string; realName: string; phone: string }>
}

/**
 * 把上游的**本地号码**归一成 11 位大陆手机号（补国家码）。
 *
 * ## ⚠️ 为什么必须归一（而不是原样展示）
 *
 * 来源实测：上游 `phone` 是**本地号码（10 位）**，不带国家码。而本项目
 * `account-phone.ts` 的脱敏判据是 `/^\d{11}$/`（完整大陆号才脱敏），
 * 填 10 位进去**既不会脱敏、也不是用户认识的形态**（`1301111222` 少一位，
 * 用户照着重新登录会输错）。
 *
 * ## 判据（四条腿，与 `magicrew-phone` 的登录归一**方向相反**）
 *
 * 1. 已经是 11 位 ⇒ **原样返回**（上游将来可能直接给完整号）；
 * 2. 10 位 ⇒ 补 `1` 前缀？**不猜**。中国大陆手机号恒 11 位且以 `1` 开头，
 *    10 位必然是「少了国家码」或「少了首位」—— 两者无法从号码本身区分。
 *    ⇒ 只在 `stateCode` 是 `86` 且号码以 `1` 开头时补首位以外的部分…
 *    **实际上：10 位且以 1 开头 ⇒ 就是缺了国家码以外的形态，无法安全补全。**
 *    故这里**只做一件事**：11 位就展示、其余**原样展示**并保留上游值，
 *    让用户自己判断（宁可显示一个不完整号，也不编造一个错号）。
 *
 * ⚠️ 这与「展示」的定位一致：手机号在这里的唯一用途是**让用户认出是哪个号**。
 * 编造一个 11 位号会让用户以为登录的是另一个账号。
 */
export function normalizeMagicrewPhone(phone: string | undefined): string | undefined {
  if (typeof phone !== 'string') return undefined
  const trimmed = phone.trim()
  if (trimmed.length === 0) return undefined
  return trimmed
}

/**
 * 走一次网页版登录（开窗 → 等用户 → 读凭据 → 签发 key → 取资料）。
 *
 * @returns 登录结果；**用户没登完 / 超时 ⇒ `undefined`**（不是失败 ——
 *   用户可能只是关掉了窗口，调用方不得据此弹错）。
 */
export async function startMagicrewLoginFlow(
  options: MagicrewLoginOptions = {},
): Promise<{ loginUrl: string; result: Promise<MagicrewLoginResult | undefined>; cancel: () => Promise<void> }> {
  const product = options.product ?? MAGICREW
  const fetchImpl = options.fetchImpl ?? fetch
  const session = await startMagicrewBrowserLogin({
    product,
    ...options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs },
    ...options.log === undefined ? {} : { log: options.log },
    ...options.sessionFactory === undefined ? {} : { sessionFactory: options.sessionFactory },
  })
  const result = (async (): Promise<MagicrewLoginResult | undefined> => {
    try {
      const found = await session.waitForCredential(options.timeoutMs ?? 240_000)
      // ⚠️ `undefined` = 用户没登完（超时 / 关窗），**不是失败**。
      if (found === undefined) return undefined
      const base: MagicrewCredential = {
        jwt: found.jwt,
        organizationCode: found.organizationCode,
      }
      let credential = base
      try {
        const key = await issueMagicrewGatewayKey({
          jwt: found.jwt,
          organizationCode: found.organizationCode,
          product,
          fetchImpl,
        })
        credential = {
          ...base,
          apiKey: key.apiKey,
          ...key.apiKeyExpiresAt === undefined ? {} : { apiKeyExpiresAt: key.apiKeyExpiresAt },
          ...key.refreshToken === undefined ? {} : { refreshToken: key.refreshToken },
          ...key.refreshTokenExpiresAt === undefined
            ? {} : { refreshTokenExpiresAt: key.refreshTokenExpiresAt },
        }
      } catch (error) {
        // ⚠️ 签发失败**不吞掉登录结果**（jwt 能拉目录 / 积分，api_key 可由续期或
        //    重登救回），但**不许静默** —— 否则用户看到「账号建好了却每请求报
        //    未登录」，而日志里什么都没有。
        options.log?.(
          '[magicrew] 登录成功但签发 gateway key 失败'
          + '（先用 jwt 继续；api_key 可由续期或重新登录救回）：' + String(error),
        )
      }
      // ⚠️ 昵称与手机号在**签发之后**取：浏览器登录的凭据里没有它们。
      const profile = await readProfile(credential, {
        product,
        fetchImpl,
        ...options.profileFetcher === undefined ? {} : { profileFetcher: options.profileFetcher },
        ...options.log === undefined ? {} : { log: options.log },
      })
      const phone = normalizeMagicrewPhone(profile?.phone)
      const nickname = profile !== undefined && profile.nickname.length > 0
        ? profile.nickname
        : undefined
      // ⚠️ 手机号写进凭据的 `phone` 字段：`account-phone.ts` 的 `PHONE_FIELDS`
      //    会读它，于是面板「凭据」一栏直接显示手机号（用户要求）。
      const stored: MagicrewCredential = {
        ...credential,
        ...phone === undefined ? {} : { phone },
        ...nickname === undefined ? {} : { nickname },
      }
      const expires = magicrewExpiresAtMs(stored)
      return {
        access: JSON.stringify(stored),
        // ⚠️ 到期时刻**复用** `magicrewExpiresAtMs`（api_key 优先、其次 JWT exp）——
        //    不在这里另算一份：两处各算一次必然漂移（本仓库红线）。
        ...expires === undefined ? {} : { expires },
        ...nickname === undefined ? {} : { nickname },
        ...phone === undefined ? {} : { phone },
      }
    } finally {
      // ⚠️ 必须收窗（否则窗口与进程残留）。`close()` 幂等。
      session.close()
    }
  })()
  // ⚠️ 吞掉未处理的 rejection：结果由 `poll` 收割，这里再抛一次会变成
  //    进程级 unhandledRejection（Node 22 默认崩进程）。
  result.catch(() => {})
  return {
    // ⚠️ 登录页地址（网页域 + `/login`，**不是** API 子域）。
    loginUrl: `${product.webOrigin}/login`,
    result,
    cancel: async () => { session.close() },
  }
}

/** 取账号资料（昵称 / 手机号）。失败 ⇒ `undefined`，**不挡登录**，但留痕。 */
async function readProfile(
  credential: MagicrewCredential,
  deps: {
    product: MagicrewProduct
    fetchImpl: typeof fetch
    profileFetcher?: MagicrewLoginOptions['profileFetcher']
    log?: (message: string) => void
  },
): Promise<{ nickname: string; realName: string; phone: string } | undefined> {
  if (credential.jwt.length === 0) return undefined
  try {
    const fetchProfile = deps.profileFetcher ?? ((params) => fetchMagicrewProfile(params))
    return await fetchProfile({
      jwt: credential.jwt,
      organizationCode: credential.organizationCode,
      product: deps.product,
    })
  } catch (error) {
    // ⚠️ 留痕：本仓库记过「静默停摆、功能上线起一次都没成功过」的教训。
    deps.log?.(
      '[magicrew] 读取账号资料失败（昵称回落为手机号/渠道名，手机号不展示；不影响登录）：'
      + String(error),
    )
    return undefined
  }
}

