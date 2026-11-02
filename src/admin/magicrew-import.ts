/**
 * Magicrew 的「**从本机浏览器导入**」建号助手。
 *
 * ## 为什么需要它（2026-10-30 用户报障）
 *
 * 用户原话：「我点进去链接后 https://www.letsmagic.cn/login 也没有响应回来，
 * 而且这种情况在同个浏览器，只能一个账号」。
 *
 * magicrew 没有 OAuth 回调，凭据（网页 JWT + organizationCode）**只存在于**
 * 浏览器的 localStorage 里。它的主登录路径是「**服务端** spawn 一个一次性 profile
 * 的窗口让用户登」（`magicrew-browser-login.ts`）—— 那条腿在服务端**有桌面**时
 * 很好用，但三种情形下失效：
 *
 * 1. 服务端跑在远程 / 容器 / 无 GUI ⇒ 那扇窗**用户根本看不见**；
 * 2. 用户在**自己**浏览器里登完，服务端读的是它自己那个一次性 profile ⇒
 *    永远读不到，界面上就是「点了链接没反应」，直到 4 分钟超时；
 * 3. 一个浏览器 profile 的 localStorage **只存得下一份 jwt** ⇒ 在同一窗口登
 *    第二个账号会覆盖第一个（用户说的「只能一个账号」正是这个）。
 *
 * 本模块把「本机浏览器已登录态」这条腿接出来：读**服务端本机**的 Chromium 系
 * 浏览器的 localStorage（`magicrew-local-browser.ts`，只读、不写、不碰 cookie），
 * 拿到 jwt 后签发一次 `mgw_` key，再落成一条**独立**账号。
 *
 * ## ⚠️⚠️ 多账号：一个浏览器 profile 只有一份登录态
 *
 * localStorage 按 origin 存，**一个 profile 只有一份**。所以要在同一台机器上加 N 个
 * 账号，必须让每个账号在不同浏览器 / 无痕窗口里各登一次、各导入一次。
 * 覆盖顺序由**浏览器**决定（最后登录的那个生效），服务端无法分辨 —— 故读到什么
 * 就导入什么，不猜「用户想要哪一个」。
 *
 * ## ⚠️ 只读，且只在本机有意义
 *
 * 扫的是**运行本服务那台机器**的浏览器目录。远程部署时它扫的是服务器的浏览器，
 * 通常什么也没有 ⇒ 老老实实返回「未读到登录态」，绝不伪装成成功。
 */

import { randomBytes } from 'node:crypto'

import type { AccountPool } from '../pool/account-pool.js'
import type { CredentialStore, ProviderAccountEntry } from '../pool/types.js'
import { issueMagicrewGatewayKey, magicrewCredentialFingerprint } from '../providers/magicrew-auth.js'
import { readMagicrewLocalCreds } from '../providers/magicrew-local-browser.js'
import { MAGICREW, MAGICREW_INTL } from '../providers/magicrew-product.js'
import { fetchMagicrewProfile } from '../providers/magicrew-profile.js'
import { findExistingMagicrewAccount } from './magicrew-dedupe.js'

/** 一次导入的结果（对外只回这几个字段，**绝不回显 jwt**）。 */
export interface MagicrewImportedAccount {
  readonly id: string
  readonly provider: string
  readonly nickname: string
  /** 是否顺带取到了手机号（UI 可据此提示「卡片上会显示手机号」）。 */
  readonly hasPhone: boolean
  /**
   * 是否成功签发 `mgw_` key。
   *
   * ⚠️ `false` ⇒ 账号能拉目录 / 积分，但**推理会报未登录**（适配器缺 apiKey
   * 时恒抛 `AUTH`）。UI 应当如实提示，而不是让用户以为已经可用。
   */
  readonly hasApiKey: boolean
  /**
   * 本次是否**复用了池里已有的那条账号**（判重命中）。
   *
   * ⚠️ 与「新建」必须让用户分得清：命中时**没有**新卡出现在列表里，若不说一句
   * 「该账号已在池中」，用户会以为导入失败了（来源 2026-10-29 报障）。
   */
  readonly reused: boolean
}

/** 导入失败的原因分类（调用方据此给不同文案，别压成一句「失败」）。 */
export type MagicrewImportFailure =
  /** 本机浏览器里没读到这个站的登录态。 */
  | { kind: 'not-found' }

/**
 * 从**本机浏览器**读 magicrew 登录态并建一条账号。
 *
 * @returns 建号结果；**读不到登录态**返回 not-found（不抛、不建空账号）。
 *
 * ⚠️ 三种「不完美但可接受」的情形都**不失败**，但都会留痕：
 *
 * | 情形 | 后果 | 处理 |
 * |---|---|---|
 * | 签发 gateway key 失败 | 能拉目录/积分，**推理报未登录** | warn + 继续 |
 * | 取昵称/手机号失败 | 卡片显示渠道名、不显示手机号 | warn + 继续 |
 * | 手机号是 10 位本地号 | 卡片显示一个 10 位号 | 原样存（不补国家码，见下） |
 *
 * 理由：jwt 本身就能拉目录与积分，api_key 可由续期或重新登录救回；
 * 而「建号直接失败」会让用户连一条可救的账号都拿不到。
 */
export async function importMagicrewFromLocalBrowser(params: {
  pool: AccountPool
  credentials: CredentialStore
  /**
   * 站点（缺省国内站 `MAGICREW`）。
   *
   * ⚠️ **必须由调用方按 provider 传入**：两站的 `webOrigin` / `host` 与凭据
   * ref 前缀都不同。用国内站的 host 去读国际站的 localStorage 会**恒读不到**
   * （且完全静默 —— 症状与「用户没登录」同形）。
   */
  product?: import('../providers/magicrew-product.js').MagicrewProduct
  /** 用户显式给的昵称（空串 = 用 profile 昵称 / 手机号 / 渠道名）。 */
  nickname: string
  /** 注入的 fetch（测试替身）。 */
  fetcher?: typeof fetch
  /** 读浏览器的原语（**单测必须注入**，绝不扫真实浏览器目录）。 */
  readCreds?: typeof readMagicrewLocalCreds
  /** 取资料的注入点（单测用）。 */
  profileFetcher?: typeof fetchMagicrewProfile
  /** 签发 key 的注入点（单测用）。 */
  issueKey?: typeof issueMagicrewGatewayKey
  warn?: (message: string) => void
}): Promise<MagicrewImportedAccount | MagicrewImportFailure> {
  const warn = params.warn ?? ((message: string) => { console.warn(message) })
  const readCreds = params.readCreds ?? readMagicrewLocalCreds
  const issueKey = params.issueKey ?? issueMagicrewGatewayKey
  const fetchProfile = params.profileFetcher ?? fetchMagicrewProfile
  /**
   * ⚠️ 站点由调用方指定（缺省国内站）。
   *
   * ⚠️ 只传 **host**（如 `www.letsmagic.cn`），不带协议与路径：
   *    `readMagicrewLocalCreds` 拿它去 leveldb 文本里找站点记录。
   */
  const product = params.product ?? MAGICREW
  const host = product.webOrigin.replace(/^https?:\/\//, '')
  const found = readCreds(host)
  if (found === undefined) return { kind: 'not-found' }

  let credential: Record<string, unknown> = {
    jwt: found.jwt,
    organizationCode: found.organizationCode,
  }
  let hasApiKey = false
  try {
    const key = await issueKey({
      jwt: found.jwt,
      organizationCode: found.organizationCode,
      product,
      ...params.fetcher === undefined ? {} : { fetchImpl: params.fetcher },
    })
    hasApiKey = true
    credential = {
      ...credential,
      apiKey: key.apiKey,
      ...key.apiKeyExpiresAt === undefined ? {} : { apiKeyExpiresAt: key.apiKeyExpiresAt },
      ...key.refreshToken === undefined ? {} : { refreshToken: key.refreshToken },
      ...key.refreshTokenExpiresAt === undefined
        ? {} : { refreshTokenExpiresAt: key.refreshTokenExpiresAt },
    }
  } catch (error) {
    // ⚠️ 不吞掉导入结果，但**必须留痕**：否则「建号成功却每请求不回复」无从归因。
    warn(
      '[magicrew] 从本机浏览器读到登录态，但签发 gateway key 失败'
      + '（先用 jwt 继续；api_key 可由续期或重新登录救回）：' + String(error),
    )
  }

  // 昵称与手机号：浏览器登录的凭据里两者都没有 ⇒ 主动取一次（失败不挡建号）。
  let profileNickname: string | undefined
  let phone: string | undefined
  try {
    const profile = await fetchProfile({
      jwt: found.jwt,
      organizationCode: found.organizationCode,
      product,
      ...params.fetcher === undefined ? {} : { fetchImpl: params.fetcher },
    })
    if (profile.nickname.length > 0) profileNickname = profile.nickname
    // ⚠️ 上游给的是**本地号（10 位）**，原样写 —— **不补国家码**：
    //    10 位既可能「少了国家码」也可能「少了首位」，无法从号码本身区分；
    //    补错会让用户以为登录的是另一个账号（照着它重登会输错）。
    if (profile.phone.length > 0) phone = profile.phone
  } catch (error) {
    warn(
      '[magicrew] 读取账号资料失败（昵称回落为渠道名、手机号不展示；不影响建号）：'
      + String(error),
    )
  }
  if (phone !== undefined) credential = { ...credential, phone }
  if (profileNickname !== undefined) credential = { ...credential, nickname: profileNickname }

  /**
   * ⚠️⚠️ **建号之前先判重**（来源 `bd73592` 的纪律，用户 2026-10-29 明确要求）。
   *
   * 判据是 `sha256(jwt)` 指纹（`findExistingMagicrewAccount`，全仓唯一一份实现）：
   * 「导入」与「网页登录」拿到的是**同一份 jwt** ⇒ 指纹相同 ⇒ 不判就会攒出
   * 两张指向同一上游账号的卡片（选号反复命中同一个号，面板却显示「2 个账号」）。
   *
   * 命中时的动作：**只把新凭据写回它自己的 ref**（同一个 ref、同一个 id），
   * 并回填昵称 / 有效期 —— 而不是先造一张卡、再靠读取侧或 UI 去滤重。
   *
   * ⚠️ 必须写回：本次导入**新签发了一把 api_key**，而签发会吊销旧 key
   * （模块头硬约束）⇒ 不写回的话那条既有账号手里是刚被吊销的死 key，
   * 每个请求都会 401。这是「不建新账号」之外**不可省**的一半。
   */
  const existing = await findExistingMagicrewAccount(
    params.pool,
    product.id,
    magicrewCredentialFingerprint(found.jwt),
  )
  if (existing !== undefined) {
    // ⚠️ 写回**既有条目自己的** ref（不是新建一个 ref，否则凭据成了孤儿）。
    await params.credentials.set(existing.credentialRef, JSON.stringify(credential))
    const expiresAtOfReuse = credential['apiKeyExpiresAt']
    await params.pool.updateAccount(existing.id, {
      // 昵称只在用户显式给了、或既有条目还是渠道名时才覆盖：不要用一次
      // 「取不到 profile」的结果把用户自己改过的昵称冲掉。
      ...params.nickname.length > 0
        ? { nickname: params.nickname }
        : profileNickname === undefined ? {} : { nickname: profileNickname },
      ...typeof expiresAtOfReuse === 'number' && Number.isFinite(expiresAtOfReuse)
        ? { expiresAt: expiresAtOfReuse } : {},
    })
    return {
      id: existing.id,
      provider: existing.provider,
      nickname: params.nickname.length > 0
        ? params.nickname
        : profileNickname ?? existing.nickname,
      hasPhone: phone !== undefined,
      hasApiKey,
      reused: true,
    }
  }

  // ⚠️ ref 前缀**按站区分**（`MAGICREW_ACCOUNT_*` / `MAGICREWINTL_ACCOUNT_*`）：
  //    `dsh-import.ts` 的 `ACCOUNT_REF_RE` 用它反查 provider，前缀写错会让
  //    导入来的账号"看起来建好了但归属到错误的站"。
  const prefix = product.id === MAGICREW_INTL.id ? 'MAGICREWINTL_ACCOUNT_' : 'MAGICREW_ACCOUNT_'
  const ref = `${prefix}${randomBytes(4).toString('hex').toUpperCase()}`
  await params.credentials.set(ref, JSON.stringify(credential))
  const expiresAt = credential['apiKeyExpiresAt']
  const entry: ProviderAccountEntry = {
    id: `${product.id}-${randomBytes(4).toString('hex')}`,
    provider: product.id,
    nickname: params.nickname.length > 0
      ? params.nickname
      : profileNickname ?? phone ?? product.displayName,
    enabled: true,
    credentialRef: ref,
    createdAt: Date.now(),
    // ⚠️ true：本家 refresh_token 能换 api_key（一次性轮换，已进
    //    ROTATING_REFRESH_PROVIDERS）。
    refreshable: true,
    ...typeof expiresAt === 'number' && Number.isFinite(expiresAt) ? { expiresAt } : {},
  }
  await params.pool.addAccount(entry)
  return {
    id: entry.id,
    provider: entry.provider,
    nickname: entry.nickname,
    hasPhone: phone !== undefined,
    hasApiKey,
    reused: false,
  }
}
