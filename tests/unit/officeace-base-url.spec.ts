/**
 * `officeace-base-url.spec.ts` —— **推理/探测必须用凭据里按账号下发的 `maasBaseUrl`**。
 *
 * ## 背景：这是一个阻断级真实缺陷（2026-10-13 真机实测）
 *
 * 症状：provider 列表里有 OfficeAce、账号也在，但**对话的模型选择器里一个
 * OfficeAce 模型都看不到**。
 *
 * 根因：适配器一律打硬编码的 `OFFICEACE.defaultBaseUrl`，而华为**按账号下发
 * 专属网关** `modelgw-0004.officeace.cn-southwest-2...`。同一个 Basic 凭据：
 *
 * | host | `/v2/models` | `/v2/chat/completions` |
 * |---|---|---|
 * | `officeace…`（硬编码，修复前用的）| **401** `APIG.1009 AppKey or AppSecret is invalid` | **401** |
 * | `modelgw-0004.officeace…`（凭据里）| **200** | **200** |
 *
 * 后果链：`probe` 401 ⇒ `listModels` 返回 `[]` ⇒ 选择器**空分组**。
 *
 * ## 本文件守的不变量
 *
 * | # | 不变量 | 违反的后果 |
 * |---|--------|-----------|
 * | 1 | 有 `maasBaseUrl` 时，probe 与推理都打它 | 401 ⇒ 模型列表空（原始缺陷）|
 * | 2 | 没有 `maasBaseUrl` 时回退默认域 | 老凭据/异常形状下零行为变化 |
 * | 3 | 尾斜杠被规范化（不出现 `//v2/...`）| 部分网关对双斜杠 404 |
 *
 * ⚠️ 不发真实网络：`fetchImpl` 记录 URL 后回最小响应。
 */

import { describe, expect, it } from 'vitest'
import { OfficeAceAdapter, maasBaseUrlOf } from '../../src/providers/officeace-adapter.js'
import { OFFICEACE } from '../../src/providers/officeace-product.js'
import type { OfficeAceCredential } from '../../src/providers/officeace-auth.js'

const ACCOUNT_BASE = 'https://modelgw-0004.officeace.cn-southwest-2.huaweicloud-agentarts.com'

function cred(overrides: Partial<OfficeAceCredential> = {}): OfficeAceCredential {
  return {
    modelAppKey: 'k', modelAppSecret: 's', maasBaseUrl: ACCOUNT_BASE,
    access: 'ak', secret: 'sk', securityToken: 'tok', projectId: 'p',
    expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    refreshToken: 'r', dpopPrivateJwk: {},
    ...overrides,
  }
}

describe('maasBaseUrlOf（纯函数：选哪个 host）', () => {
  it('① 凭据带 maasBaseUrl ⇒ 用它（这是本缺陷的核心断言）', () => {
    expect(maasBaseUrlOf(cred())).toBe(ACCOUNT_BASE)
  })

  it('② 凭据缺 maasBaseUrl ⇒ 回退默认域（零行为变化，别让老凭据打挂）', () => {
    expect(maasBaseUrlOf(cred({ maasBaseUrl: '' }))).toBe(OFFICEACE.defaultBaseUrl)
    expect(maasBaseUrlOf(cred({ maasBaseUrl: '   ' })), '纯空白应按缺失处理')
      .toBe(OFFICEACE.defaultBaseUrl)
    expect(maasBaseUrlOf(cred({ maasBaseUrl: undefined as never }))).toBe(OFFICEACE.defaultBaseUrl)
  })

  it('③ 尾斜杠被规范化（避免出现 `//v2/chat/completions`）', () => {
    expect(maasBaseUrlOf(cred({ maasBaseUrl: `${ACCOUNT_BASE}/` }))).toBe(ACCOUNT_BASE)
    expect(maasBaseUrlOf(cred({ maasBaseUrl: `${ACCOUNT_BASE}///` }))).toBe(ACCOUNT_BASE)
  })
})

describe('适配器真的用了按账号下发的 host（端到端，mock fetch）', () => {
  /** 记录所有请求 URL，并按路径回最小可用响应。 */
  function makeAdapter(c: OfficeAceCredential) {
    const urls: string[] = []
    const adapter = new OfficeAceAdapter({
      resolveCredential: async () => c,
      fetchImpl: (async (input: RequestInfo | URL) => {
        const url = String(input)
        urls.push(url)
        if (url.includes('/v2/models')) {
          return new Response(JSON.stringify({ object: 'list', data: [] }), {
            status: 200, headers: { 'content-type': 'application/json' },
          })
        }
        return new Response('data: [DONE]\n\n', {
          status: 200, headers: { 'content-type': 'text/event-stream' },
        })
      }) as typeof fetch,
    })
    return { adapter, urls }
  }

  it('④ listModels 的 probe 打的是账号专属 host（打错 = 空列表 = 本缺陷）', async () => {
    const { adapter, urls } = makeAdapter(cred())
    await adapter.listModels('officeace')
    const probeUrls = urls.filter((u) => u.includes('/v2/models'))
    expect(probeUrls.length, 'probe 必须真的发出去过').toBeGreaterThan(0)
    // ⚠️ 这是本用例的关键：URL 必须以账号域名开头，而不是硬编码默认域。
    expect(probeUrls[0], 'probe 仍打默认域 ⇒ 401 ⇒ 模型列表为空（原始症状）')
      .toContain(ACCOUNT_BASE)
    expect(probeUrls[0], '不得再打硬编码默认域')
      .not.toContain(OFFICEACE.defaultBaseUrl)
  })

  it('⑤ 模型列表非空（probe 通过后按静态表返回，共 8 个）', async () => {
    const { adapter } = makeAdapter(cred())
    const models = await adapter.listModels('officeace')
    expect(models.length, 'probe 通过后应返回静态表全部模型').toBe(8)
    expect(models.every((m) => m.provider === 'officeace')).toBe(true)
  })

  it('⑥ 推理请求也打账号专属 host，且路径正确', async () => {
    const { adapter, urls } = makeAdapter(cred())
    const prepared = await adapter.prepareCall('officeace', 'glm-5.2')
    // 消费流（忽略内容，只要请求发出去）
    for await (const _ of prepared.stream({ model: 'glm-5.2', messages: [{ role: 'user', content: 'hi' }] } as never)) { /* drain */ }
    const chatUrls = urls.filter((u) => u.includes('/v2/chat/completions'))
    expect(chatUrls.length, '推理请求必须发出去').toBeGreaterThan(0)
    expect(chatUrls[0], '推理仍打默认域 ⇒ 401（与模型列表空同因）').toContain(ACCOUNT_BASE)
  })

  it('⑦ 凭据没带 maasBaseUrl 时回退默认域（不引入回归）', async () => {
    const { adapter, urls } = makeAdapter(cred({ maasBaseUrl: '' }))
    await adapter.listModels('officeace')
    const probeUrls = urls.filter((u) => u.includes('/v2/models'))
    expect(probeUrls[0]).toContain(OFFICEACE.defaultBaseUrl)
  })
})
