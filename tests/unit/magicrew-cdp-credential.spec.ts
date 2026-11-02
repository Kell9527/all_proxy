/**
 * Magicrew **CDP 读实时 localStorage 凭据**的回归用例（2026-11-02 真机报障
 * 「一直处于等待状态」）。
 *
 * ## 这个缺陷长什么样
 *
 * 用户在网页里登录**完全成功**（已经在 workspace 页面里，右上角显示 150 积分），
 * 服务端窗口一直开着、CDP 通道也通，但面板永远停在「请在弹出的窗口中完成登录」，
 * 等到超时后报：
 *
 * ```
 * CDP 与磁盘都没读到凭据（CDP 尝试 426 次 / 最后一次 CDP 失败原因：…超时）
 * ```
 *
 * ## 两个叠加的事实（任缺其一都读不到）
 *
 * ### ① 键名带 `MAGIC:user:` 前缀
 *
 * 上游把登录态写在 `MAGIC:user:authorization` / `MAGIC:user:organizationCode` 下，
 * **裸名 `authorization` 根本不存在**。真机实测（真实登录态 22 个键）：
 * 授权相关的三个键全部带前缀，裸名零命中。
 *
 * ### ② 值本身又是一层 JSON 信封
 *
 * ```
 * localStorage['MAGIC:user:authorization']
 *   = {"key":"authorization","value":"eyJhbGciOiJIUzI1NiJ9.eyJleHAiOjF9.sig"}
 * ```
 *
 * ⇒ 取出来必须再解一层拿 `.value`。只修键名、不解信封，`isJwtShaped` 会因
 * 开头是 `{` 而判否 —— **仍然读不到**。这正是为什么「看起来只差一点」的改动
 * 会留下一个完全静默的缺陷。
 *
 * ## 用例策略
 *
 * 全部用**注入的假 CDP 通道**，`Runtime.evaluate` 返回一段 JSON 字符串
 * （与真浏览器的返回同形），绝不真起浏览器。假通道按**调用顺序**返回，
 * 从而也能验证「一次 evaluate 取完四个值」这条纪律。
 */
import { describe, expect, it } from 'vitest'

import { readCredentialViaCdpDetailed } from '../../src/providers/magicrew-browser-login.js'

const JWT = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJleHAiOjE3OTYxOTAwMDB9.c2lnbmF0dXJl'

/**
 * 造一个假 CDP 通道。
 *
 * @param evaluateValue `Runtime.evaluate` 的 `result.value`（真浏览器里是
 *   我们那条表达式 `JSON.stringify(...)` 的产物，即**一个 JSON 字符串**）。
 */
function stubCdp(evaluateValue: string | undefined, options: {
  targets?: Array<{ type: string, targetId: string, url: string }>
  noSessionId?: boolean
} = {}) {
  const calls: Array<{ method: string, params?: Record<string, unknown>, sessionId?: string }> = []
  const cdp = {
    async send(method: string, params?: Record<string, unknown>, _t?: number, sessionId?: string): Promise<unknown> {
      calls.push({ method, params, ...(sessionId === undefined ? {} : { sessionId }) })
      if (method === 'Target.getTargets') {
        return {
          targetInfos: options.targets ?? [
            { type: 'page', targetId: 'p1', url: 'https://www.magicrew.ai/global/super/workspace/1' },
          ],
        }
      }
      if (method === 'Target.attachToTarget') {
        return options.noSessionId === true ? {} : { sessionId: 'sess-1' }
      }
      if (method === 'Runtime.evaluate') {
        return evaluateValue === undefined ? {} : { result: { value: evaluateValue } }
      }
      return {}
    },
  }
  return { cdp, calls }
}

/** 造出与页面表达式**同形**的返回值（外层 JSON 字符串）。 */
function evaluateResult(payload: Record<string, unknown>): string {
  return JSON.stringify(payload)
}

describe('CDP 读凭据：键名与信封两道判据', () => {
  it('★ 带前缀键 + JSON 信封 ⇒ 读到（这就是真机的真实形态）', async () => {
    // ⚠️ 页面表达式已经把信封拆开了，故这里的 `a`/`o` 是**拆好后**的值。
    const { cdp, calls } = stubCdp(evaluateResult({
      a: JWT, ak: 'MAGIC:user:authorization',
      o: 'oda0jraic9hb', ok: 'MAGIC:user:organizationCode',
      n: 22,
    }))
    const result = await readCredentialViaCdpDetailed({ cdp }, ['www.magicrew.ai'])
    expect(result.credential).toBeDefined()
    expect(result.credential?.jwt).toBe(JWT)
    expect(result.credential?.organizationCode).toBe('oda0jraic9hb')
    // 一次 evaluate 取完四个值（不是四次）—— 见表达式头部的窗口纪律。
    expect(calls.filter((call) => call.method === 'Runtime.evaluate')).toHaveLength(1)
  })

  it('★ 页面表达式必须去读**带前缀**的键（防止有人「简化」回裸名）', async () => {
    // ⚠️ 这条是本缺陷的**直接**回归：裸名 `authorization` 在真机上不存在。
    //    断言表达式的**源码文本**而不是行为 —— 行为已经被上一条锁住，
    //    但「有人把前缀去掉」在行为层可能仍然绿（如果他同时改了假数据）。
    const { cdp, calls } = stubCdp(evaluateResult({ a: JWT, o: 'org1', n: 3 }))
    await readCredentialViaCdpDetailed({ cdp }, ['www.magicrew.ai'])
    const evaluate = calls.find((call) => call.method === 'Runtime.evaluate')
    const expression = String(evaluate?.params?.['expression'] ?? '')
    expect(expression).toContain('MAGIC:user:authorization')
    expect(expression).toContain('MAGIC:user:organizationCode')
    expect(expression).toContain('MAGIC:user:teamshareOrganizationCode')
  })

  it('★ 页面表达式必须**拆信封**（`.value`）', async () => {
    // ⚠️ 只修键名不解信封 ⇒ `isJwtShaped('{"key":…')` 判否 ⇒ 仍然读不到。
    const { cdp, calls } = stubCdp(evaluateResult({ a: JWT, o: 'org1', n: 3 }))
    await readCredentialViaCdpDetailed({ cdp }, ['www.magicrew.ai'])
    const evaluate = calls.find((call) => call.method === 'Runtime.evaluate')
    const expression = String(evaluate?.params?.['expression'] ?? '')
    // 判据：表达式里有 JSON.parse 与 .value 的处理（不写死具体写法）。
    expect(expression).toContain('JSON.parse')
    expect(expression).toContain('.value')
  })

  it('★ **真浏览器行为级**：带前缀 + 信封的原始 localStorage 值必须能解成凭据', async () => {
    /**
     * 上两条只断言表达式的**源码文本**，属于弱防护（有人换种写法就绕过）。
     * 这条用**真的页面表达式**跑一遍：把表达式当成函数体、喂给一个假的
     * `localStorage`（内容取真机的真实形态：带前缀键 + 值是信封）。
     *
     * ⇒ 这是本缺陷唯一**行为级**的守护：键名错或信封没拆，这里必红。
     */
    // 先抓出生产用的表达式源码（与生产**同一份**，不另写一份）。
    const { cdp: probeCdp, calls } = stubCdp(evaluateResult({ a: JWT, o: 'org1', n: 3 }))
    await readCredentialViaCdpDetailed({ cdp: probeCdp }, ['www.magicrew.ai'])
    const expression = String(calls.find((call) => call.method === 'Runtime.evaluate')?.params?.['expression'] ?? '')
    expect(expression.length).toBeGreaterThan(0)

    // 真机形态：键带 `MAGIC:user:` 前缀，值多包一层 `{"key":…,"value":…}`。
    const store = new Map<string, string>([
      ['MAGIC:user:authorization', JSON.stringify({ key: 'authorization', value: JWT })],
      ['MAGIC:user:organizationCode', JSON.stringify({ key: 'organizationCode', value: 'oda0jraic9hb' })],
      ['MAGIC:user:teamshareOrganizationCode', JSON.stringify({ key: 'teamshareOrganizationCode', value: 'oda0jraic9hb' })],
      ['MAGIC:config:theme', '"dark"'],
    ])
    const fakeLocalStorage = {
      getItem: (key: string) => store.get(key) ?? null,
      get length() { return store.size },
    }
    // 表达式里只用到 `localStorage`，用 Function 注入即可（不碰真浏览器）。
    // eslint-disable-next-line no-new-func
    const evaluate = new Function('localStorage', `return ${expression}`)
    const raw = evaluate(fakeLocalStorage) as string
    const parsed = JSON.parse(raw) as { a?: string, o?: string, n?: number }
    expect(parsed.a).toBe(JWT)
    expect(parsed.o).toBe('oda0jraic9hb')
    expect(parsed.n).toBe(4)
  })

  it('裸名键（历史形态）仍要能读到 —— 前缀是**优先**不是**唯一**', async () => {
    // 旧版 letsmagic.cn 落的是裸名形态，删掉兜底会把老账号读丢。
    const { cdp } = stubCdp(evaluateResult({
      a: JWT, ak: 'authorization',
      o: '6qro9gpiommv', ok: 'organizationCode',
      n: 5,
    }), {
      // ⚠️ 页面 target 必须是**当前要读的那个站**（`pickPageTarget` 按站点过滤）：
      //    给 magicrew.ai 的 target 却去读 letsmagic.cn，会走「页面还没出现」那条路。
      targets: [{ type: 'page', targetId: 'p1', url: 'https://www.letsmagic.cn/super' }],
    })
    const result = await readCredentialViaCdpDetailed({ cdp }, ['www.letsmagic.cn'])
    expect(result.credential?.organizationCode).toBe('6qro9gpiommv')
  })

  it('值没套信封（直接存 JWT）也要认 —— 不写死某一种形态', async () => {
    const { cdp } = stubCdp(evaluateResult({ a: JWT, o: 'org1', n: 3 }))
    expect((await readCredentialViaCdpDetailed({ cdp }, ['www.magicrew.ai'])).credential?.jwt).toBe(JWT)
  })

  it('组织码缺失 ⇒ **不产出**凭据（空 org 配 jwt 上游回 200 + code:403）', async () => {
    const { cdp } = stubCdp(evaluateResult({ a: JWT, o: '', n: 3 }))
    const result = await readCredentialViaCdpDetailed({ cdp }, ['www.magicrew.ai'])
    expect(result.credential).toBeUndefined()
    // ⚠️ 这是「用户还没登完」的正常未完成态 ⇒ **不记 failure**。
    expect(result.failure).toBeUndefined()
  })

  it('localStorage 为空（n===0）⇒ 未登完，不记 failure', async () => {
    const { cdp } = stubCdp(evaluateResult({ a: null, o: null, n: 0 }))
    const result = await readCredentialViaCdpDetailed({ cdp }, ['www.magicrew.ai'])
    expect(result.credential).toBeUndefined()
    expect(result.failure).toBeUndefined()
  })

  it('jwt 形状不对（例如信封没拆干净）⇒ 不产出，且不记 failure', async () => {
    // 这条正是「只修键名、没拆信封」会落到的地方：开头是 `{` ⇒ 判否。
    const { cdp } = stubCdp(evaluateResult({
      a: `{"key":"authorization","value":"${JWT}"}`,
      o: 'org1',
      n: 3,
    }))
    const result = await readCredentialViaCdpDetailed({ cdp }, ['www.magicrew.ai'])
    expect(result.credential).toBeUndefined()
    expect(result.failure).toBeUndefined()
  })

  it('页面还没出现 ⇒ 给出可指路的 failure（区分「用户没登」与「我们读坏了」）', async () => {
    const { cdp } = stubCdp(evaluateResult({ a: null, o: null, n: 0 }), { targets: [] })
    const result = await readCredentialViaCdpDetailed({ cdp }, ['www.magicrew.ai'])
    expect(result.failure).toContain('页面还没出现')
  })

  it('attach 没给出 sessionId ⇒ failure 说清步骤', async () => {
    const { cdp } = stubCdp(evaluateResult({ a: JWT, o: 'org1', n: 3 }), { noSessionId: true })
    expect((await readCredentialViaCdpDetailed({ cdp }, ['www.magicrew.ai'])).failure)
      .toContain('attachToTarget 没给出 sessionId')
  })

  it('CDP 通道未就绪 ⇒ failure（不是抛）', async () => {
    const result = await readCredentialViaCdpDetailed({ cdp: undefined }, ['www.magicrew.ai'])
    expect(result.failure).toContain('CDP 通道未就绪')
  })
})