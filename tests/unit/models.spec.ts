import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  fetchCodeArtsRemoteModels, freshRateLabel, isCodeArtsBenefitModel, loadBenefitCache, loadModelsCache,
  OPENGW_GATEWAY_CONFIG_URL, saveBenefitCache, saveModelsCache, setBenefitMemoryCache,
  SNAP_MODEL_BUILTIN_URL,
} from '../../src/providers/models.js'
import type { CodeArtsCredential } from '../../src/providers/types.js'

/** 构造一份最小可用凭据。 */
function makeCredential(): CodeArtsCredential {
  return {
    access_key_id: 'AKTEST',
    secret_access_key: 'SKTEST',
    security_token: 'STTEST',
    expires_at: '2026-12-31T00:00:00Z',
    refresh_token: 'rt',
    code_verifier: 'cv',
    dpop_private_key_jwk: 'jwk',
  } as CodeArtsCredential
}

/** 按 URL 路由返回不同响应的 mock fetch；记录每次请求的 URL 与头。 */
function makeFetcher(routes: Record<string, { status?: number; body: string }>) {
  const calls: Array<{ url: string; headers: Headers }> = []
  const fetcher = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    calls.push({ url, headers: new Headers(init?.headers) })
    const route = routes[url]
    if (route === undefined) return new Response('', { status: 404 })
    return new Response(route.body, { status: route.status ?? 200 })
  }
  return { fetcher: fetcher as unknown as typeof fetch, calls }
}

describe('fetchCodeArtsRemoteModels', () => {
  it('requests the /v1/model/builtin endpoint (not the old statistics/plugin)', async () => {
    const { fetcher, calls } = makeFetcher({
      [SNAP_MODEL_BUILTIN_URL]: {
        body: JSON.stringify({
          count: 2,
          builtinModels: [
            { model_id: 'GLM-5.2', model_name: 'GLM-5.2' },
            { model_id: 'openpangu-2.0-flash', model_name: 'openpangu-2.0-flash' },
          ],
        }),
      },
    })
    const models = await fetchCodeArtsRemoteModels(makeCredential(), fetcher)
    const snapCall = calls.find((c) => c.url === SNAP_MODEL_BUILTIN_URL)
    expect(snapCall).toBeDefined()
    expect(models).toContainEqual({ id: 'GLM-5.2', name: 'GLM-5.2' })
    expect(models).toContainEqual({ id: 'openpangu-2.0-flash', name: 'openpangu-2.0-flash' })
  })

  it('sends Agent-Type: PromptCenter and X-Language: zh-cn on the builtin request (unsigned headers)', async () => {
    const { fetcher, calls } = makeFetcher({
      [SNAP_MODEL_BUILTIN_URL]: { body: JSON.stringify({ builtinModels: [] }) },
    })
    await fetchCodeArtsRemoteModels(makeCredential(), fetcher)
    const snapCall = calls.find((c) => c.url === SNAP_MODEL_BUILTIN_URL)
    expect(snapCall?.headers.get('Agent-Type')).toBe('PromptCenter')
    expect(snapCall?.headers.get('X-Language')).toBe('zh-cn')
    expect(snapCall?.headers.get('Content-Type')).toBe('application/json')
  })

  it('parses builtinModels[] (not the old model_metrics field)', async () => {
    const { fetcher } = makeFetcher({
      [SNAP_MODEL_BUILTIN_URL]: {
        body: JSON.stringify({
          // 旧字段已废弃，不应被解析
          model_metrics: [{ model_id: 'OLD-SHOULD-NOT-APPEAR', model_name: 'old' }],
          builtinModels: [
            { model_id: 'GLM-5.2-ArkTS-SPARK', model_name: 'GLM-5.2 ArkTS SPARK' },
          ],
        }),
      },
    })
    const models = await fetchCodeArtsRemoteModels(makeCredential(), fetcher)
    expect(models).toContainEqual({ id: 'GLM-5.2-ArkTS-SPARK', name: 'GLM-5.2 ArkTS SPARK' })
    expect(models.find((m) => m.id === 'OLD-SHOULD-NOT-APPEAR')).toBeUndefined()
  })

  it('filters out VL (vision) multimodal models from the builtin list', async () => {
    const { fetcher } = makeFetcher({
      [SNAP_MODEL_BUILTIN_URL]: {
        body: JSON.stringify({
          builtinModels: [
            { model_id: 'GLM-5.2', model_name: 'GLM-5.2' },
            { model_id: 'Qwen3-VL-235B', model_name: 'Qwen3-VL-235B' },
            { model_id: 'something-VL', model_name: 'something-VL' },
            { model_id: 'glm-5.2-sft-harmony', model_name: 'glm-5.2-sft-harmony' },
          ],
        }),
      },
    })
    const models = await fetchCodeArtsRemoteModels(makeCredential(), fetcher)
    const ids = models.map((m) => m.id)
    expect(ids).toContain('GLM-5.2')
    expect(ids).toContain('glm-5.2-sft-harmony')
    expect(ids).not.toContain('Qwen3-VL-235B')
    expect(ids).not.toContain('something-VL')
  })

  it('merges opengw gateway/config benefit models with builtin models, deduped', async () => {
    const { fetcher } = makeFetcher({
      [OPENGW_GATEWAY_CONFIG_URL]: {
        body: JSON.stringify({
          result: {
            models: [
              { model_id: 'glm-5.3-flash', model_name: 'glm-5.3-flash' },
              { model_id: 'deepseek-v4-flash-0731', model_name: 'deepseek-v4-flash' },
            ],
          },
        }),
      },
      [SNAP_MODEL_BUILTIN_URL]: {
        body: JSON.stringify({
          builtinModels: [
            { model_id: 'GLM-5.2', model_name: 'GLM-5.2' },
            { model_id: 'glm-5.3-flash', model_name: 'glm-5.3-flash' },
          ],
        }),
      },
    })
    const models = await fetchCodeArtsRemoteModels(makeCredential(), fetcher)
    const ids = models.map((m) => m.id)
    // benefit 模型
    expect(ids).toContain('glm-5.3-flash')
    // ⚠️ 对外 id 是**上游原始 model_id**，不再剥日期后缀（2026-10-28 改，见
    // `normalizeModelId` 的长注释）：`deepseek-v4-flash-0731` 与
    // `deepseek-v4-flash` 在后端是**两个独立注册的模型**，剥后缀会把它们合并掉。
    expect(ids).toContain('deepseek-v4-flash-0731')
    // 常规模型
    expect(ids).toContain('GLM-5.2')
    // 去重：glm-5.3-flash 只出现一次
    expect(ids.filter((id) => id === 'glm-5.3-flash')).toHaveLength(1)
  })

  /**
   * ★ 带版本后缀的 id **必须原样暴露**（issue IKQY27）。
   *
   * 实测 `/v1/model/builtin` 同时下发 `deepseek-v4.1-flash` 与
   * `deepseek-v4.1-flash-1017`（两个 `display_enabled: true` 的独立条目）。
   * 修前 `normalizeModelId` 无条件剥 `-NNNN` 且用它做 `seen` 去重键 ⇒ 1017
   * 被静默吞掉，用户看到「IDE 已更新到 1017，我们的列表没更新」。
   *
   * 本机实测（2026-10-28）：上游 10 条，本项目修前只出 8 条。
   */
  it('★ 带版本后缀的 id 必须原样暴露，不得归一成无后缀（IKQY27）', async () => {
    const { fetcher } = makeFetcher({
      [SNAP_MODEL_BUILTIN_URL]: {
        body: JSON.stringify({
          builtinModels: [
            { model_id: 'deepseek-v4.1-flash', model_name: 'DeepSeek-V4.1-Flash' },
            { model_id: 'deepseek-v4.1-flash-1017', model_name: 'DeepSeek-V4.1-Flash-1017' },
          ],
        }),
      },
    })
    const models = await fetchCodeArtsRemoteModels(makeCredential(), fetcher)
    const ids = models.map((m) => m.id)
    expect(ids, '新旧两版是上游并存的独立模型，必须都出现').toEqual([
      'deepseek-v4.1-flash',
      'deepseek-v4.1-flash-1017',
    ])
    // 展示名同样不裁后缀：`1017` 正是用户要看的版本信息。
    expect(models.find((m) => m.id === 'deepseek-v4.1-flash-1017')?.name)
      .toBe('DeepSeek-V4.1-Flash-1017')
  })

  /**
   * ★ 消耗倍率：只取 `ratio_display`（不取 `ratio`），且**按时段选当前档**。
   *
   * 上游 `credit[]` 同时给 `ratio`（`0.05`）与 `ratio_display`（`0.18x`），
   * 两者**不同量纲**（`GLM-5.2` ratio=0.05 也显示 0.7x）⇒ 用 ratio 拼串会显示
   * 一个上游从未出现过的数字。错峰档（21:00–次日 7:59）是第二档，取
   * `credit[0]` 会在整个错峰期显示过高的倍率。
   */
  it('★ 倍率只取 ratio_display，且按 time_slots 选当前生效档（错峰 21:00–7:59）', async () => {
    const credit = [
      { ratio: '0.05', ratio_display: '0.18x', time_slot_id: 'default' },
      { ratio: '0.05', ratio_display: '0.09x', time_slot_id: 'off_peak' },
    ]
    const timeSlots = {
      off_peak: { timezone: 'Asia/Shanghai', schedule: '0 0 21 * * *', duration: 11, timeunit: 'hour' },
      default: { schedule: null, duration: null },
    }
    const { fetcher } = makeFetcher({
      [SNAP_MODEL_BUILTIN_URL]: {
        body: JSON.stringify({
          builtinModels: [
            { model_id: 'deepseek-v4.1-flash', model_name: 'DeepSeek-V4.1-Flash', credit, time_slots: timeSlots },
          ],
        }),
      },
    })
    /** 取某个 UTC+8 本地时刻的倍率。 */
    const at = async (iso: string): Promise<string | undefined> => {
      const models = await fetchCodeArtsRemoteModels(
        makeCredential(), fetcher, undefined, Date.parse(iso),
      )
      return freshRateLabel(models[0]!, Date.parse(iso))
    }
    // 错峰窗口内（含跨日界的两端）
    expect(await at('2026-10-28T21:00:00+08:00')).toBe('x0.09')
    expect(await at('2026-10-28T23:30:00+08:00')).toBe('x0.09')
    expect(await at('2026-10-29T03:00:00+08:00')).toBe('x0.09')
    expect(await at('2026-10-29T07:59:00+08:00')).toBe('x0.09')
    // 窗口外
    expect(await at('2026-10-28T08:00:00+08:00')).toBe('x0.18')
    expect(await at('2026-10-28T20:59:00+08:00')).toBe('x0.18')
  })

  /**
   * ★ 倍率必须能在**读取时**重算：磁盘快照 TTL 6 小时，必然跨过 21:00 边界。
   *
   * 若直接用拉取那一刻算出的 `rateLabel`，错峰开始后会继续显示白天档
   * （来源实测过同型缺陷：错峰期显示过高的 0.18x）。
   */
  it('★ freshRateLabel 按「现在」重算，不受快照拍摄时刻影响', async () => {
    const { fetcher } = makeFetcher({
      [SNAP_MODEL_BUILTIN_URL]: {
        body: JSON.stringify({
          builtinModels: [{
            model_id: 'deepseek-v4.1-flash',
            model_name: 'DeepSeek-V4.1-Flash',
            credit: [
              { ratio_display: '0.18x', time_slot_id: 'default' },
              { ratio_display: '0.09x', time_slot_id: 'off_peak' },
            ],
            time_slots: {
              off_peak: { schedule: '0 0 21 * * *', duration: 11, timeunit: 'hour' },
              default: { schedule: null, duration: null },
            },
          }],
        }),
      },
    })
    // 白天拍的快照
    const models = await fetchCodeArtsRemoteModels(
      makeCredential(), fetcher, undefined, Date.parse('2026-10-28T10:00:00+08:00'),
    )
    expect(models[0]?.rateLabel, '快照里存的是白天档').toBe('x0.18')
    // 但晚上读出来必须是错峰档
    expect(freshRateLabel(models[0]!, Date.parse('2026-10-28T22:00:00+08:00'))).toBe('x0.09')
    expect(freshRateLabel(models[0]!, Date.parse('2026-10-29T10:00:00+08:00'))).toBe('x0.18')
  })

  /** 上游不给 `credit[]`（或形状认不出）时**不落占位值**。 */
  it('倍率缺失/认不出时不冒充：不落 rateLabel', async () => {
    const { fetcher } = makeFetcher({
      [SNAP_MODEL_BUILTIN_URL]: {
        body: JSON.stringify({
          builtinModels: [
            { model_id: 'no-credit', model_name: 'No Credit' },
            // 形态变了（上游若改成 `x0.7`）：只改形态不改数值的契约要求**认不出就不显示**
            { model_id: 'odd-form', model_name: 'Odd', credit: [{ ratio_display: 'x0.7' }] },
          ],
        }),
      },
    })
    const models = await fetchCodeArtsRemoteModels(makeCredential(), fetcher)
    expect(models.find((m) => m.id === 'no-credit')?.rateLabel).toBeUndefined()
    expect(models.find((m) => m.id === 'odd-form')?.rateLabel).toBeUndefined()
  })

  it('returns empty array when credential lacks AK/SK', async () => {
    const { fetcher, calls } = makeFetcher({})
    const cred = makeCredential()
    cred.access_key_id = ''
    const models = await fetchCodeArtsRemoteModels(cred, fetcher)
    expect(models).toEqual([])
    expect(calls).toHaveLength(0)
  })
})

/**
 * benefit 模型判定与缓存。
 *
 * 真实缺陷（用户报障，对齐 deveco-code-rust fb1b4a2）：`deepseek-v4.1-flash`
 * 是 benefit（免费额度）模型，调用必须带 `maas_type: benefit`，而早期实现把该
 * 集合**硬编码**为只有 `glm-5.3-flash` → 发消息后调用失败。
 */
describe('isCodeArtsBenefitModel', () => {
  let cacheDir: string
  const originalDir = process.env.DSH_CODEARTS_CACHE_DIR

  beforeEach(() => {
    // 隔离磁盘缓存：否则会读到真实用户缓存（~/.cache/deveco），断言不稳定
    cacheDir = mkdtempSync(join(tmpdir(), 'codearts-benefit-'))
    process.env.DSH_CODEARTS_CACHE_DIR = cacheDir
    setBenefitMemoryCache(undefined)
  })

  afterEach(() => {
    setBenefitMemoryCache(undefined)
    if (originalDir === undefined) delete process.env.DSH_CODEARTS_CACHE_DIR
    else process.env.DSH_CODEARTS_CACHE_DIR = originalDir
    rmSync(cacheDir, { recursive: true, force: true })
  })

  it('兜底集合覆盖 gateway/config 的 benefit 模型', () => {
    // 必须判定为 benefit（否则 404 not registered）
    expect(isCodeArtsBenefitModel('glm-5.3-flash')).toBe(true)
    expect(isCodeArtsBenefitModel('deepseek-v4.1-flash')).toBe(true)
  })

  it('不把非 benefit 模型误判为 benefit（带 maas_type 会被拒）', () => {
    // deepseek-v4-flash / -pro 尤其关键：gateway 返回的是其带日期后缀形态
    // （-0731 / -0813），归一化后落到这两个 id，绝不能连带标成 benefit。
    for (const model of ['deepseek-v4-flash', 'deepseek-v4-pro', 'GLM-5.2', 'GLM-5.1', 'glm-5.3-flash-0101']) {
      expect(isCodeArtsBenefitModel(model), `${model} 不是 benefit 模型`).toBe(false)
    }
  })

  it('远端拉取所得集合是超集：新增 benefit 模型无需改代码', async () => {
    const { fetcher } = makeFetcher({
      [OPENGW_GATEWAY_CONFIG_URL]: {
        body: JSON.stringify({
          result: {
            models: [
              { model_id: 'glm-5.3-flash', model_name: 'glm-5.3-flash' },
              { model_id: 'brand-new-benefit-model', model_name: 'brand-new-benefit-model' },
            ],
          },
        }),
      },
    })
    await fetchCodeArtsRemoteModels(makeCredential(), fetcher)
    expect(isCodeArtsBenefitModel('brand-new-benefit-model')).toBe(true)
    // 兜底集合在远端集合存在时依然生效（两者取并集语义）
    expect(isCodeArtsBenefitModel('deepseek-v4.1-flash')).toBe(true)
  })

  it('落盘的 benefit 集合不含归一化改写过的 id', async () => {
    // deepseek-v4-flash-0731 在 gateway 中是 benefit，但 normalizeModelId 会把
    // 它改写成 deepseek-v4-flash 后再发出，而两者在后端是不同模型、benefit
    // 属性相反 —— 记录改写后的 id 会让无后缀模型多带 maas_type 而失败。
    const { fetcher } = makeFetcher({
      [OPENGW_GATEWAY_CONFIG_URL]: {
        body: JSON.stringify({
          result: {
            models: [
              { model_id: 'deepseek-v4-flash-0731', model_name: 'deepseek-v4-flash' },
              { model_id: 'deepseek-v4.1-flash', model_name: 'deepseek-v4.1-flash' },
            ],
          },
        }),
      },
    })
    await fetchCodeArtsRemoteModels(makeCredential(), fetcher)
    const saved: unknown = JSON.parse(readFileSync(join(cacheDir, 'codearts_benefit_models.json'), 'utf-8'))
    expect(saved).toEqual(['deepseek-v4.1-flash'])
    expect(isCodeArtsBenefitModel('deepseek-v4-flash')).toBe(false)
  })

  it('缓存读写往返：ESM 下 require 不可用的回归', () => {
    // 真实缺陷（2026-09-23）：本包是 ESM（package.json "type": "module"），
    // 而缓存读写曾用 `require('node:fs')` —— 在 ESM 下它未定义、抛
    // ReferenceError 并被 catch 吞掉，于是「写不进、也读不回」，
    // benefit 判定恒回退静态兜底、模型列表磁盘缓存恒失效。
    saveBenefitCache(['glm-5.3-flash', 'brand-new-benefit-model'])
    setBenefitMemoryCache(undefined)
    expect(loadBenefitCache()).toEqual(['glm-5.3-flash', 'brand-new-benefit-model'])
    // 远端新增的 benefit 模型经磁盘缓存生效（无需改代码）
    expect(isCodeArtsBenefitModel('brand-new-benefit-model')).toBe(true)
    // 兜底集合仍生效（并集语义）
    expect(isCodeArtsBenefitModel('deepseek-v4.1-flash')).toBe(true)
  })

  it('模型列表缓存读写往返（同一 require 缺陷）', () => {
    saveModelsCache([{ id: 'GLM-5.2', name: 'GLM-5.2' }])
    expect(loadModelsCache()).toEqual([{ id: 'GLM-5.2', name: 'GLM-5.2' }])
  })
})
