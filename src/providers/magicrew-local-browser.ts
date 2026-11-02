/**
 * 从**本机浏览器的 localStorage** 里读 magicrew 登录态 —— 不开窗口、不让用户粘任何东西。
 *
 * 这是超级麦吉三种登录方式里**最简单、无门槛**的一条：用户只要在 Edge / Chrome 里
 * 登录过 `www.letsmagic.cn`，凭据就已经躺在磁盘上了。
 *
 * ## ═══ 为什么需要这条路 ═══════════════════════════════════════════════
 *
 * magicrew 没有 OAuth 回调通道，所以「用户在网页上登录成功」这件事，插件原本只能靠
 * 「自己起的那个浏览器」知道。于是有一个反复被报的现象：**用户在自己浏览器里登好了，
 * 插件里却没有多出账号** —— 因为那是另一个浏览器。
 *
 * 但凭据其实就躺在本地：Chromium 系（Edge / Chrome / Brave / 国产 Chromium 系）把
 * localStorage 明文写在
 *
 *     <User Data>/<Default|Profile N>/Local Storage/leveldb/*.log|*.ldb
 *
 * 里，key 是 `_<origin>\x00\x01<name>`，值是 JSON。
 *
 * ## ═══ 读法（与参考实现逐条对齐）═══════════════════════════════════════
 *
 * 把 leveldb 目录按 **latin1** 拼成文本 → 以站点 host 出现的位置开一个 **2000 字节
 * 窗口** → 在窗口里找 `"key":"authorization"` 与 `"key":"organizationCode"`。
 *
 * ⚠️ LevelDB **按 key 排序**，同一 origin 的记录（theme / i18n / userInfo /
 * authorization / organizationCode …）挨在一起，所以窗口内配对是可靠的
 * （实测本机 Edge：`www.letsmagic.cn` 命中、`www.magicrew.ai` 不命中，不会串）。
 * ⚠️ 窗口必须按 **origin** 截断：两个站点的记录可能相邻（用户两个都登录过），
 * 2000 字节的窗口会把国际站的 org 配到国内站的 jwt 上。
 *
 * 成本：本机 Edge 27 MB / 34 ms；全扫通常 < 300 ms。
 *
 * ## ⚠️ 只读
 *
 * 不写文件、不改浏览器数据、不碰 cookie。本模块唯一的副作用是 `readdirSync` /
 * `readFileSync`。
 *
 * ## ⚠️ 不读 magpie 自己的目录
 *
 * 参考实现（`magpie-magicrew-auth/src/local-browser.mjs`）与它同目录，但**刻意不读**
 * `~/.config/magpie` —— 那是 magpie 的落点，本插件不该依赖另一个产品的私有目录。
 */

import { readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

import { registeredBrowserUserDataRoots } from './chromium-session.js'
import { leveldbText } from './leveldb-reader.js'

/**
 * 窗口宽度。
 *
 * 同一个 origin 的若干条记录挤在一起，2000 字节足够覆盖到 `organizationCode`；
 * 太小会漏、太大可能跨到另一个站点。
 */
export const MAGICREW_LOCAL_WINDOW = 2000

/** 登录态（本模块的产物）。⚠️ 字段名由调用方转成 `MagicrewCredential`（`jwt` 同名）。 */
export interface MagicrewLocalCreds {
  /** 网页 JWT。 */
  readonly jwt: string
  /** 组织码 —— 必须与 jwt 配对（错配会得到 HTTP 200 + `code:403`）。 */
  readonly organizationCode: string
  /** JWT `exp` 对应的毫秒时刻；解不出来就没有该字段（**不编造**）。 */
  readonly expiresAt?: number
}

export interface MagicrewLocalBrowserOptions {
  /** 时钟注入（毫秒），只用于「同一份数据里有多把凭据时挑哪把」。 */
  readonly now?: number
  /**
   * 注入的浏览器 User Data 根目录（**单测专用**）。
   *
   * ⚠️⚠️ 单测**绝不能**扫真实浏览器目录：那里的数据随机器而变，
   * 用例会「在开发机上绿、在 CI 上红」，还会读到真实用户的登录态。
   * 缺省走 {@link magicrewBrowserRoots}。
   */
  readonly roots?: readonly string[]
}

/** 一个浏览器的 User Data 根目录（`browser` 仅用于日志/诊断）。 */
export interface MagicrewBrowserRoot {
  readonly browser: string
  readonly root: string
}

/**
 * 各平台的浏览器 User Data 根目录；不存在就跳过。
 *
 * ⚠️ Windows 为主（本插件用户面），macOS / Linux 照参考实现给全 —— 少一行
 * 只意味着「那个浏览器上的已登录态读不到」，不会报错，极难发现。
 */
export function magicrewBrowserRoots(): readonly MagicrewBrowserRoot[] {
  const home = homedir()
  if (process.platform === 'win32') {
    const local = process.env.LOCALAPPDATA || join(home, 'AppData', 'Local')
    const roaming = process.env.APPDATA || join(home, 'AppData', 'Roaming')
    return dedupeBrowserRoots([
      // ── 国际主流 ──
      //
      // ⚠️⚠️ **Edge 的四个通道是四个互不相干的 User Data 目录**（2026-11-02 真机报障
      // 「MagiCrew (国际版) 我在网页登录了，为什么没识别到」）：
      //
      //     <local>\Microsoft\Edge         ← Stable
      //     <local>\Microsoft\Edge Beta    ← Beta
      //     <local>\Microsoft\Edge Dev     ← Dev
      //     <local>\Microsoft\Edge SxS     ← Canary（「SxS」= side-by-side）
      //
      // 只列 Stable 时，**用户装在 Beta/Dev/Canary 上的登录态一条都读不到**，而症状
      // 与「用户没登录」**完全同形**（`not-found` ⇒ 面板提示「请先登录」）——
      // 用户明明刚在网页上登好，却被反过来指引去重登，永远不可能成功。
      // 真机实测就是这样：Stable 里 `magicrew` 字样 0 命中，Beta 里
      // `https://www.magicrew.ai` 的记录**齐全**。
      //
      // ⚠️ 别用「Edge SxS 已被 App Paths 覆盖」来自我安慰：`App Paths` 登记的是
      // **可执行文件**，本模块要的是 **User Data 目录**，两条腿的取值完全不同。
      // 旧代码把它们混为一谈，才是这条一直没被发现的真因。
      { browser: 'Edge', root: join(local, 'Microsoft', 'Edge', 'User Data') },
      { browser: 'Edge Beta', root: join(local, 'Microsoft', 'Edge Beta', 'User Data') },
      { browser: 'Edge Dev', root: join(local, 'Microsoft', 'Edge Dev', 'User Data') },
      { browser: 'Edge Canary', root: join(local, 'Microsoft', 'Edge SxS', 'User Data') },
      { browser: 'Chrome', root: join(local, 'Google', 'Chrome', 'User Data') },
      // ⚠️ 同 Edge：Chrome 的 Beta / Dev / Canary 也是**各自独立的 User Data 目录**。
      { browser: 'Chrome Beta', root: join(local, 'Google', 'Chrome Beta', 'User Data') },
      { browser: 'Chrome Dev', root: join(local, 'Google', 'Chrome Dev', 'User Data') },
      { browser: 'Chrome Canary', root: join(local, 'Google', 'Chrome SxS', 'User Data') },
      { browser: 'Brave', root: join(local, 'BraveSoftware', 'Brave-Browser', 'User Data') },
      { browser: 'Chromium', root: join(local, 'Chromium', 'User Data') },
      { browser: 'Vivaldi', root: join(local, 'Vivaldi', 'User Data') },
      // Windows App Paths 会登记便携版 Chrome；其 `<install>/Data` 不在上面的固定目录里。
      // ⚠️ 便携版 **不注册** App Paths（那是安装器的行为）⇒ 这条腿在最需要它的
      //    场景下恒不产出；真兜底是下面的 `MAGICREW_CHROME_USER_DATA`。
      //    仍保留它：① 少数工具确实会登记；② `registeredBrowserUserDataRoots`
      //    对**已注册**的绿色版软件仍然有效。
      ...registeredBrowserUserDataRoots().map((root) => ({ browser: '已登记浏览器（含便携版）', root })),
      ...process.env.MAGICREW_CHROME_USER_DATA?.trim()
        ? [{ browser: 'Chrome 便携版', root: process.env.MAGICREW_CHROME_USER_DATA.trim() }]
        : [],
      // ── 国产 Chromium 系 ──
      // ⚠️ 参考实现 2026-10-28 实测：用户日常用的是 360 极速浏览器 X（360ChromeX），
      //   它的 localStorage 里确实有 www.letsmagic.cn 的记录。不加这一行，
      //   「本机浏览器已登录就直接认」这条首选路径对它永远不生效 ——
      //   用户明明在网页上登着，插件却还要他再登一次。
      { browser: '360极速浏览器X', root: join(local, '360ChromeX', 'Chrome', 'User Data') },
      { browser: '360浏览器', root: join(local, '360Chrome', 'Chrome', 'User Data') },
      { browser: '360安全浏览器', root: join(roaming, 'secoresdk', '360se6', 'User Data') },
      { browser: 'QQ浏览器', root: join(local, 'Tencent', 'QQBrowser', 'User Data') },
      { browser: '搜狗浏览器', root: join(local, 'SogouExplorer', 'User Data') },
      { browser: '2345浏览器', root: join(local, '2345Explorer', 'User Data') },
      { browser: '猎豹浏览器', root: join(local, 'liebao', 'User Data') },
      { browser: 'UC浏览器', root: join(local, 'UCBrowser', 'User Data') },
      { browser: '夸克浏览器', root: join(local, 'Quark', 'User Data') },
    ])
  }
  if (process.platform === 'darwin') {
    return dedupeBrowserRoots([
      { browser: 'Chrome', root: join(home, 'Library/Application Support/Google/Chrome') },
      { browser: 'Edge', root: join(home, 'Library/Application Support/Microsoft Edge') },
      { browser: 'Brave', root: join(home, 'Library/Application Support/BraveSoftware/Brave-Browser') },
      { browser: 'Chromium', root: join(home, 'Library/Application Support/Chromium') },
      { browser: 'Vivaldi', root: join(home, 'Library/Application Support/Vivaldi') },
    ])
  }
  return dedupeBrowserRoots([
    { browser: 'Chrome', root: join(home, '.config/google-chrome') },
    { browser: 'Chromium', root: join(home, '.config/chromium') },
    { browser: 'Edge', root: join(home, '.config/microsoft-edge') },
    { browser: 'Brave', root: join(home, '.config/BraveSoftware/Brave-Browser') },
    { browser: 'Vivaldi', root: join(home, '.config/vivaldi') },
  ])
}

/**
 * 按 `root` **不区分大小写**去重，保留**首次出现**的那条。
 *
 * ⚠️ 为什么需要它（2026-11-02 加新通道时实测发现）：`Edge SxS` 现在**既**被显式
 * 列在候选链里（Canary 通道），**又**会被 `registeredBrowserUserDataRoots()`
 * 经 App Paths 推导出来 —— 同一个目录出现两次。
 *
 * 重复本身不会读错（第二次遍历只是重复读同一份 leveldb，白费 IO），但它是一个
 * **信号**：说明有一行是「复制粘贴后忘改名」写出来的（例如把 `Edge Beta` 抄成
 * `Edge`，于是两条指向同一目录），而那种错会让某个通道**静默缺失**。
 * ⇒ 在源头去重，同时用回归用例把「无重复」锁住。
 *
 * ⚠️ 判据用 `toLowerCase()` 而不是 `winPathEquals`：本函数跨平台，
 *    而 `winPathEquals` 只在 win32 语义下成立（大小写不敏感 + 反斜杠归一）。
 */
function dedupeBrowserRoots(
  roots: readonly MagicrewBrowserRoot[],
): readonly MagicrewBrowserRoot[] {
  const seen = new Set<string>()
  const out: MagicrewBrowserRoot[] = []
  for (const entry of roots) {
    const key = entry.root.trim().replace(/[\\/]+$/, '').toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    out.push(entry)
  }
  return out
}

/** 一个 User Data 根目录下的 profile 目录名（`Default` / `Profile 1` …）。 */
export function magicrewProfilesOf(root: string): string[] {
  try {
    return readdirSync(root).filter((name) => name === 'Default' || /^Profile \d+$/.test(name))
  } catch {
    return []
  }
}

/**
 * 一个 profile 的 leveldb 文本视图。
 *
 * ⚠️⚠️ **必须走 {@link leveldbText}（结构化解析），不能把整文件当 latin1 正则扫**。
 *
 * 旧实现就是后者，它能跑通纯属侥幸：只读到那些**恰好落在未压缩块里、且没被块
 * 边界切开**的短值。而登录态 `{"key":"authorization","value":"eyJ…"}` 是 200+ 字节
 * 的长值 —— 在真实 Chromium 数据里它落在 **snappy 压缩块**内，明文正则**必然失配**
 * ⇒ `not-found` ⇒ 面板反过来提示「请先在浏览器里登录」。
 * 2026-11-02 用户报障「MagiCrew (国际版)：我在网页登录了，为什么没识别到」
 * 就是这个：用户照着提示重登一次、照样读不到（**不可能自愈**）。
 *
 * 本机实测对比（同一份 `User Data\Default`，22MB）：
 * - 旧做法：读出 111 条记录（全部来自未压缩的 `.log`），`.ldb` 一条都没有
 * - 新做法：读出 8692 条，`MAGIC:user:authorization` 与 `organizationCode` 齐全
 */
function leveldbTextForProfile(root: string, profile: string): string {
  return leveldbText(join(root, profile, 'Local Storage', 'leveldb'))
}

/**
 * 一个 User Data 根目录下**全部 profile** 的 leveldb 文本。
 *
 * ⚠️ 多 profile 之间用 `\n` 隔开：不隔开时前一个 profile 的尾部与后一个的头部
 * 会拼成一条**不存在的**记录（可能凭空造出一对 jwt × org）。
 */
export function leveldbTextFor(root: string): string {
  const texts = magicrewProfilesOf(root)
    .map((profile) => leveldbTextForProfile(root, profile))
    .filter((text) => text.length > 0)
  return texts.join('\n')
}

/** jwt 里的 `iat` / `exp`；解不出来返回 0（**不猜**）。 */
export function jwtTimes(jwt: string): { iat: number, exp: number } {
  try {
    const payload = String(jwt ?? '').split('.')[1] ?? ''
    const body = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as Record<string, unknown>
    return {
      iat: typeof body.iat === 'number' && Number.isFinite(body.iat) ? body.iat : 0,
      exp: typeof body.exp === 'number' && Number.isFinite(body.exp) ? body.exp : 0,
    }
  } catch {
    return { iat: 0, exp: 0 }
  }
}

/** LevelDB 里一条记录的前缀：`_https://<origin>\x00\x01<name>`。 */
const ORIGIN_RE = /_https?:\/\/([^\x00\x01"\\]{4,80})\x00\x01/g

/**
 * magicrew 的 localStorage 记录形态（与参考实现逐字一致）：
 *
 * ```
 * {"key":"authorization","value":"eyJ…"}
 * {"key":"organizationCode","value":"…"}
 * ```
 *
 * ⚠️ 两套形态：直接写在 leveldb 里的是**裸 JSON**；若整条记录被当成字符串再
 * 序列化一次（某些浏览器/写入路径会这样），引号会变成 `\"`。两套都认，
 * 且各自留了 `\s*` 容错（chromium 自己写的是紧凑格式，但不值得赌死）。
 */
const AUTHORIZATION_PATTERNS: readonly RegExp[] = [
  /"key"\s*:\s*"authorization"\s*,\s*"value"\s*:\s*"(eyJ[^"]+)"/g,
  /\\"key\\"\s*:\s*\\"authorization\\"\s*,\s*\\"value\\"\s*:\s*\\"(eyJ[^"\\]+)/g,
]
const ORGANIZATION_PATTERNS: readonly RegExp[] = [
  /"key"\s*:\s*"organizationCode"\s*,\s*"value"\s*:\s*"([^"]*)"/g,
  /\\"key\\"\s*:\s*\\"organizationCode\\"\s*,\s*\\"value\\"\s*:\s*\\"([^"\\]*)/g,
]

interface IndexedMatch {
  readonly index: number
  readonly value: string
}

function* matchesWithIndex(
  patterns: readonly RegExp[],
  chunk: string,
): Generator<IndexedMatch> {
  for (const pattern of patterns) {
    // ⚠️ `matchAll` 会克隆正则内部状态，模块级 `/g` 正则因此可安全复用。
    for (const match of chunk.matchAll(pattern)) {
      if (match.index === undefined) continue
      yield { index: match.index, value: match[1] ?? '' }
    }
  }
}

/** host 的全部写法：`www.letsmagic.cn` / `letsmagic.cn`（去重、保持顺序）。 */
function hostsFor(hostname: string): string[] {
  const host = String(hostname ?? '').trim()
  if (host.length === 0) return []
  const bare = host.replace(/^www\./, '')
  const hosts = [host, bare, `www.${bare}`]
  return hosts.filter((value, index) => value.length > 0 && hosts.indexOf(value) === index)
}

/**
 * 在 host 每一次出现的位置开窗，取窗口内同一 origin 的 `jwt × organizationCode`。
 *
 * 截断点 = 「下一个**不同站点**的 origin」，同站点的多条记录不截断。
 *
 * ⚠️ 每把 jwt 配**它自己后面**最近的那个组织码：LevelDB 按 key 排序
 * （`authorization` < `organizationCode`），同一批写入的挨在一起；取「窗口内第一个
 * org」会在同一站点存过多套凭据时配错（症状：HTTP 200 + `code:403` 且极难归因）。
 */
export function credsNear(
  text: string,
  hostname: string,
  window: number = MAGICREW_LOCAL_WINDOW,
): { jwt: string, organizationCode: string }[] {
  const host = String(hostname ?? '').trim()
  if (text.length === 0 || host.length === 0) return []
  const bare = host.replace(/^www\./, '')
  const origins: { host: string, at: number }[] = []
  for (const match of text.matchAll(ORIGIN_RE)) {
    origins.push({ host: match[1] ?? '', at: match.index ?? 0 })
  }

  const out: { jwt: string, organizationCode: string }[] = []
  const seen = new Set<string>()
  let at = -1
  while ((at = text.indexOf(host, at + 1)) !== -1) {
    let stop = Math.min(text.length, at + window)
    for (const origin of origins) {
      if (origin.at > at && !origin.host.includes(bare)) {
        stop = origin.at
        break
      }
    }
    const slice = text.slice(at, stop)
    const jwts = [...matchesWithIndex(AUTHORIZATION_PATTERNS, slice)]
      .sort((left, right) => left.index - right.index)
    const orgs = [...matchesWithIndex(ORGANIZATION_PATTERNS, slice)]
      .sort((left, right) => left.index - right.index)
    for (const jwt of jwts) {
      const org = orgs.find((candidate) => candidate.index > jwt.index)
      // ⚠️ 没有 org 就**不产出**：宁可读不到（调用方降级去开窗口登录），
      // 也绝不编造空串 —— 空 organizationCode 与 jwt 配对在上游是
      // HTTP 200 + `code:403`，比「没读到」难查得多。
      if (org === undefined || org.value.length === 0) continue
      const key = `${jwt.value}\u0000${org.value}`
      if (seen.has(key)) continue
      seen.add(key)
      out.push({ jwt: jwt.value, organizationCode: org.value })
    }
  }
  return out
}

/**
 * 读本机浏览器里属于这个站点的登录态。
 *
 * @param hostname 站点 host，例如 `www.letsmagic.cn`（与 localStorage key 里的
 *                 origin 同源，**不是** API 子域）
 * @returns 取 iat 最新的那份凭据；读不到返回 `undefined`（调用方降级到窗口登录）。
 *
 * ⚠️⚠️ **过期与否不在这里拦**：同一份 leveldb 里可能同时留着一旧一新两套记录
 * （用户重登过），此时优先给**未过期**的那份；但如果**只有**过期的那份，照样返回
 * —— 「凭据过期」由调用方（以及上游）判定，在这里拦掉会让「刚过期但 refresh_token
 * 还能用」的账号**白丢一条自救路径**。
 */
export function readMagicrewLocalCreds(
  hostname: string,
  options: MagicrewLocalBrowserOptions = {},
): MagicrewLocalCreds | undefined {
  const host = String(hostname ?? '').trim()
  if (host.length === 0) return undefined
  const now = options.now ?? Date.now()
  const roots = options.roots ?? magicrewBrowserRoots().map((entry) => entry.root)
  const hosts = hostsFor(host)

  interface Candidate {
    readonly jwt: string
    readonly organizationCode: string
    readonly iat: number
    readonly expiresAt: number | undefined
    readonly expired: boolean
  }

  let best: Candidate | undefined
  for (const root of roots) {
    const text = leveldbTextFor(root)
    if (text.length === 0) continue
    for (const candidateHost of hosts) {
      for (const found of credsNear(text, candidateHost)) {
        const { iat, exp } = jwtTimes(found.jwt)
        const expiresAt = exp > 0 ? exp * 1000 : undefined
        const candidate: Candidate = {
          jwt: found.jwt,
          organizationCode: found.organizationCode,
          iat,
          expiresAt,
          expired: expiresAt !== undefined && expiresAt <= now,
        }
        if (best === undefined) {
          best = candidate
          continue
        }
        // 未过期的优先；同一档里取 iat 最新的。两者都缺（解不出 iat）时保留先找到的
        // —— 顺序取决于目录遍历，故不在无据可依时反复改选。
        if (best.expired !== candidate.expired) {
          if (!candidate.expired) best = candidate
          continue
        }
        if (candidate.iat > best.iat) best = candidate
      }
    }
  }
  if (best === undefined) return undefined
  return {
    jwt: best.jwt,
    organizationCode: best.organizationCode,
    ...best.expiresAt === undefined ? {} : { expiresAt: best.expiresAt },
  }
}
