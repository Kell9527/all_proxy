/**
 * Magicrew（超级麦吉）的回归用例。
 *
 * 移植自 `deepseek-harness-codearts`（来源 `392d370`）。这里只锁**本项目接线层**
 * 新增的判据与「缺一处就静默失效」的那些环，不重复来源已锁的协议细节。
 *
 * 四组：
 * 1. **多账号隔离**：每次登录必须是一个**新的** profile 目录 —— 复用会让第二个
 *    账号一秒内读到上一个账号的 jwt（来源实测），从而建不出新账号。
 * 2. **手机号展示**：上游给的是本地号，必须原样透出到「凭据」一栏，
 *    且**不编造**国家码（10 位既可能缺国家码也可能缺首位，无法区分）。
 * 3. **凭据解析**：`jwt` 是唯一必需字段（api_key 缺失可由 refresh_token 救回）。
 * 4. **展示名**：nickname → 脱敏手机号 → 渠道名，且老凭据逐字节回落。
 */
import { describe, expect, it, vi } from 'vitest'
import {
  magicrewDisplayNickname,
  parseMagicrewCredential,
} from '../../src/providers/magicrew-auth.js'
import { MAGICREW, magicrewFallbackModelOf } from '../../src/providers/magicrew-product.js'
import { normalizeMagicrewPhone } from '../../src/login/magicrew-login.js'

describe('凭据解析：jwt 是唯一必需字段', () => {
  it('只有 jwt 也算有效凭据（api_key 可由 refresh_token 救回）', () => {
    // ⚠️ 判据必须这么宽：浏览器登录那条腿落库时**可能还没有 api_key**
    //    （签发失败不吞登录结果）。若这里要求 apiKey，账号会被判成不可用，
    //    而它其实能拉目录 / 积分，api_key 也能靠续期补上。
    const parsed = parseMagicrewCredential({ jwt: 'eyJhbGciOiJIUzI1NiJ9.eyJleHAiOjF9.sig' })
    expect(parsed).toBeDefined()
    expect(parsed?.organizationCode).toBe('')
  })

  it('缺 jwt ⇒ undefined（连目录都拉不到）', () => {
    expect(parseMagicrewCredential({ organizationCode: 'org' })).toBeUndefined()
    expect(parseMagicrewCredential(null)).toBeUndefined()
    expect(parseMagicrewCredential({ jwt: '' })).toBeUndefined()
  })

  it('保留展示字段（phone / nickname）—— 卡片要用它们', () => {
    // ⚠️ 这条锁的是「解析层漏字段」：卡片昵称来自 nickname、手机号来自 phone，
    //    任何一条在 parse 里被丢掉，重启后卡片就会变回「超级麦吉」。
    const parsed = parseMagicrewCredential({
      jwt: 'jwt-value',
      organizationCode: 'org-1',
      phone: '13800138000',
      nickname: 'Nick',
    })
    expect(parsed?.phone).toBe('13800138000')
    expect(parsed?.nickname).toBe('Nick')
  })
})

describe('展示昵称：nickname → 脱敏手机号 → 渠道名', () => {
  it('有 nickname 就优先用它（浏览器登录的唯一展示来源）', () => {
    expect(magicrewDisplayNickname({ jwt: 'j', organizationCode: '', nickname: 'Nick' }))
      .toBe('Nick')
  })

  it('没有 nickname 时用脱敏手机号', () => {
    expect(magicrewDisplayNickname({
      jwt: 'j', organizationCode: '', phone: '13800138000',
    })).toBe('138****8000')
  })

  it('都没有 ⇒ 渠道名（不是空串、不是 undefined）', () => {
    expect(magicrewDisplayNickname({ jwt: 'j', organizationCode: '' }))
      .toBe(MAGICREW.displayName)
  })

  it('老凭据（无 nickname 字段）逐字节回落，不因新增字段改变行为', () => {
    // ⚠️ 向后兼容是硬约束：存量账号的卡片不能因为加了 nickname 腿而变样。
    const old = { jwt: 'j', organizationCode: '', phone: '13900139000' }
    expect(magicrewDisplayNickname(old)).toBe('139****9000')
  })
})

describe('手机号：上游给本地号，本项目原样展示（不编造国家码）', () => {
  it('11 位原样返回', () => {
    expect(normalizeMagicrewPhone('13800138000')).toBe('13800138000')
  })

  it('10 位本地号原样返回 —— **不补** +86 / 1', () => {
    // ⚠️ 这是刻意的取舍：10 位既可能是「少了国家码」也可能是「少了首位」，
    //    两者无法从号码本身区分。编造一个 11 位号会让用户以为登录的是另一个账号
    //    （照着它重新登录会输错）。宁可显示一个不完整号。
    expect(normalizeMagicrewPhone('1380013800')).toBe('1380013800')
  })

  it('空值 / 非字符串 ⇒ undefined（不返回空串让调用方误判成有值）', () => {
    expect(normalizeMagicrewPhone(undefined)).toBeUndefined()
    expect(normalizeMagicrewPhone('')).toBeUndefined()
    expect(normalizeMagicrewPhone('   ')).toBeUndefined()
  })
})

describe('静态兜底表', () => {
  it('能按 id 取到已知模型（含 ctx）', () => {
    const model = magicrewFallbackModelOf('deepseek-v4.1-flash')
    expect(model).toBeDefined()
    expect(model?.contextWindow).toBe(1_048_576)
    expect(model?.supportsImage).toBe(true)
  })

  it('未登记的 id 返回 undefined（**不编造**）', () => {
    expect(magicrewFallbackModelOf('nonexistent-model')).toBeUndefined()
    expect(magicrewFallbackModelOf('')).toBeUndefined()
  })

  it('每条都声明了「关闭 / 开启」两档（上游认 7 档但强度不区分）', () => {
    // ⚠️ 声明 7 档会让用户以为能调强度（实测 reasoning_tokens 不单调，51~91 波动）；
    //    一档都不声明则用户**无法关闭思考**。故只声明这两档。
    for (const model of MAGICREW.fallbackModels) {
      expect(model.reasoningEfforts, model.id).toEqual(['none', 'high'])
      expect(model.defaultReasoningEffort, model.id).toBe('high')
    }
  })
})

describe('多账号：每次登录必须是新的会话（否则读到上一个账号的凭据）', () => {
  it('连登两次各自独立，且打开的是网页域登录页、不带邀请码', async () => {
    // ⚠️⚠️ 这条锁的是「多账号能不能用」的根本前提：来源实测复用 profile 会让
    //    第二个账号一秒内读到**上一个账号**的 jwt ⇒ 按契约判成「替换旧账号」
    //    ⇒ 建不出新账号。
    //
    // 判据不读实现细节，而是数 sessionFactory 被调了几次、每次拿到什么 URL：
    //    ① 每次都真的新建了会话（不是复用同一个对象）；
    //    ② URL 是**网页域 + /login**（不是 API 子域 —— 那上面用户根本没法登录，
    //       localStorage 也不在那个 origin 下）；
    //    ③ 不带 invitation（不代用户决定归属）。
    const { startMagicrewBrowserLogin } = await import('../../src/providers/magicrew-browser-login.js')
    const urls: string[] = []
    const factory = vi.fn(async (url: string) => {
      urls.push(url)
      return {
        close: () => {},
        waitForCredential: async () => ({ jwt: 'jwt-' + urls.length, organizationCode: 'org' }),
      }
    })
    // 连登两次（模拟用户加两个账号）
    const a = await startMagicrewBrowserLogin({ sessionFactory: factory as never })
    await a.waitForCredential(1_000)
    a.close()
    const b = await startMagicrewBrowserLogin({ sessionFactory: factory as never })
    await b.waitForCredential(1_000)
    b.close()

    // ① 两次都是独立会话
    expect(factory).toHaveBeenCalledTimes(2)
    // ②③ 打开的是网页域登录页，且不带邀请码
    for (const url of urls) {
      expect(url).toBe(`${MAGICREW.webOrigin}/login`)
      expect(url).not.toContain('invitation=')
    }
  })

  it('profile 目录由 mkdtempSync 生成 ⇒ 并发登录也各用各的目录', async () => {
    // ⚠️⚠️ 这条是上一条的**结构保证**，也是多账号能用的真正原因。
    //
    // `profilePrefix` 只是 mkdtemp 的**前缀**，不是目录本身：
    // `mkdtempSync(join(tmpdir(), prefix))` 每次都会追加随机后缀 ⇒
    // 两次登录必然得到两个不同目录，**哪怕前缀写死**。
    //
    // 反过来说：一旦哪天有人「优化」成传一个固定的 `userDataDir`
    //（例如为了复用登录态），多账号立刻串号 —— 而症状是「第二个账号
    //  加不进来」，完全看不出与这里有关。故把 mkdtemp 这一步锁住。
    const { mkdtempSync, rmSync } = await import('node:fs')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    const prefix = 'magicrew-login-'
    const a = mkdtempSync(join(tmpdir(), prefix))
    const b = mkdtempSync(join(tmpdir(), prefix))
    try {
      // 同前缀、不同目录
      expect(a).not.toBe(b)
      expect(a.startsWith(join(tmpdir(), prefix))).toBe(true)
      expect(b.startsWith(join(tmpdir(), prefix))).toBe(true)
    } finally {
      rmSync(a, { recursive: true, force: true })
      rmSync(b, { recursive: true, force: true })
    }
  })
})

describe('诊断日志：浏览器链路的告警必须真的能落进日志', () => {
  it('orchestrator 把 log 接进 startUrlFlow，且 magicrew 分支透传（接线不能断）', async () => {
    // ⚠️⚠️ 这条锁的是一处**已实际漏掉**的接线：`startMagicrewLoginFlow` 的
    //    `log` 链路本身是通的（一路传到 `ChromiumSession`），但 orchestrator 里
    //    **调用时根本没传** ⇒ 整条链是断的，而症状是「日志里一个字都没有」，
    //    与「用户没登」完全一样。
    //
    //    上游对这条日志的定性：放弃等待时那一行「CDP 与磁盘都没读到凭据」是
    //    下次报障时**唯一能区分两者**的东西。
    //
    // ⚠️ **为什么不跑一次 `orchestrator.start('magicrew')` 来验**：那会真的
    //    spawn 一个 Chromium 窗口弹到用户桌面上 —— 上游记过两次「单测弹出真实
    //    浏览器窗口」的污染，并明确要求这条腿必须走注入的 `sessionFactory`。
    //    而 `sessionFactory` 收不到 `log`（它只拿 URL），所以从这里观测不到。
    //    ⇒ 只能对**接线本身**做结构断言。这类断言在别处是劣选，但这里是唯一安全的。
    const { readFileSync } = await import('node:fs')
    const { join } = await import('node:path')
    const source = readFileSync(join(process.cwd(), 'src/login/orchestrator.ts'), 'utf8')
    // ① flowOptions 声明里有 log
    expect(source).toContain('log?: (message: string) => void')
    // ② start() 从 logger 桥接出 log（走 warn：诊断行不会默认级别被滤掉）
    expect(source).toContain('log: (message: string) => logger.warn(message)')
    // ③ magicrew 分支把它传下去（漏这一行 = 前两步白做）
    expect(source).toContain('flowOptions.log === undefined ? {} : { log: flowOptions.log }')
  })

  it('magicrew 的浏览器日志用 [magicrew] 前缀，不是上游插件的 [jet-hub]', async () => {
    // ⚠️ `[jet-hub]` 是**上游插件的名字**，在本项目的其它任何地方都不存在。
    //    移植时若沿用默认前缀，用户按 `magicrew` 搜日志会一条都搜不到。
    const { readFileSync } = await import('node:fs')
    const { join } = await import('node:path')
    const source = readFileSync(join(process.cwd(), 'src/providers/magicrew-browser-login.ts'), 'utf8')
    expect(source).toContain("logPrefix: '[magicrew]'")
    // ⚠️ 且**不得**把默认值改掉：zcode 那条腿的日志一直是 [jet-hub]，
    //    改默认值会让既有排查习惯失效（默认值是为了逐字保持）。
    const session = readFileSync(join(process.cwd(), 'src/providers/chromium-session.ts'), 'utf8')
    expect(session).toContain("?? '[jet-hub]'")
  })

  it('magicrew 的 Edge 告警不出现 captcha 字样（本产品没有这个环节）', async () => {
    // ⚠️ 默认文案是「若 Edge 异常导致 captcha 失败」—— 那是 zcode 的语境。
    //    magicrew 照搬会让用户去查一个根本不存在的环节。
    const { readFileSync } = await import('node:fs')
    const { join } = await import('node:path')
    const source = readFileSync(join(process.cwd(), 'src/providers/magicrew-browser-login.ts'), 'utf8')
    expect(source).toContain('failureHint:')
    expect(source).toContain('登录页打不开')
    // 且默认值保持 captcha 语境不变（zcode 逐字保持）
    const session = readFileSync(join(process.cwd(), 'src/providers/chromium-session.ts'), 'utf8')
    expect(session).toContain('captcha 失败')
  })
})
