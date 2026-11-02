/**
 * Magicrew 新人奖励（onboarding）与三档积分的用例。
 *
 * 覆盖来源 `bd73592` 在 `magicrew-checkin.ts` / `magicrew-credits.ts` /
 * `magicrew-expiry-rank.ts` 里记录的每一条**真缺陷**判据。每条用例都对应
 * 一个「如果不这样写就会静默出错」的场景，而不是为了覆盖率。
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'

import {
  MAGICREW_NOT_MANUALLY_COMPLETABLE,
  claimMagicrewOnboardingTasks,
  fetchMagicrewOnboardingStatus,
  magicrewTaskIsDone,
} from '../../src/providers/magicrew-checkin.js'
import { fetchMagicrewBalance } from '../../src/providers/magicrew-credits.js'
import { MAGICREW, MAGICREW_INTL } from '../../src/providers/magicrew-product.js'
import {
  MAGICREW_EXPIRY_TIER,
  magicrewExpiryTier,
  magicrewTierUsable,
  rankMagicrewAccountsByExpiry,
  splitMagicrewCreditPackages,
} from '../../src/providers/magicrew-expiry-rank.js'
import type { CreditPackage } from '../../src/providers/credits.js'

const CREDENTIAL = { jwt: 'jwt-value', organizationCode: 'org-code' }

/** 构造一个 JSON 响应。 */
function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

/** 造一条积分包（`expiredTime` 是 ISO 串；空串 = 永久）。 */
function pkg(remaining: number, expiresAt?: number): CreditPackage {
  return {
    name: '限时积分',
    unit: '积分',
    remaining,
    total: remaining,
    used: 0,
    active: true,
    cycleStartTime: '',
    cycleEndTime: '',
    expiredTime: expiresAt === undefined ? '' : new Date(expiresAt).toISOString(),
  }
}

describe('magicrew 新人奖励：fetchMagicrewOnboardingStatus', () => {
  it('COMPLETED 与 reward_status=GRANTED 任一为真即算已完成（两个字段独立）', () => {
    // ⚠️ 只判一个会重复 PUT 已领过的任务 —— 上游实测存在 COMPLETED 但 reward 为空的样本。
    expect(magicrewTaskIsDone({ code: 'a', title: '', points: 1, status: 'COMPLETED', rewardStatus: '' })).toBe(true)
    expect(magicrewTaskIsDone({ code: 'a', title: '', points: 1, status: '', rewardStatus: 'GRANTED' })).toBe(true)
    expect(magicrewTaskIsDone({ code: 'a', title: '', points: 1, status: 'PENDING', rewardStatus: '' })).toBe(false)
  })

  it('按上游 tasks[].points 现场累加（不写死总分）', async () => {
    const fetcher = (async () => jsonResponse({
      code: 1000,
      data: {
        participant_type: null,
        tasks: [
          { code: 't1', title: '任务一', points: 100, status: 'COMPLETED', reward_status: 'GRANTED' },
          { code: 't2', title: '任务二', points: 50, status: 'PENDING', reward_status: '' },
        ],
      },
    })) as unknown as typeof fetch

    const status = await fetchMagicrewOnboardingStatus({ ...CREDENTIAL, fetchImpl: fetcher })
    expect(status.total).toBe(150)
    // earned 是「**累计**已领」，与「本次是否新增」无关
    expect(status.earned).toBe(100)
    expect(status.titles['t1']).toBe('任务一')
  })

  it('points 是字符串 "80" ⇒ 读成 80（不记成 0）', async () => {
    const fetcher = (async () => jsonResponse({
      code: 1000,
      data: { tasks: [{ code: 't1', title: 'x', points: '80', status: '', reward_status: '' }] },
    })) as unknown as typeof fetch
    const status = await fetchMagicrewOnboardingStatus({ ...CREDENTIAL, fetchImpl: fetcher })
    expect(status.points['t1']).toBe(80)
    expect(status.total).toBe(80)
  })

  it('points 是带单位的字符串 "1,234 积分" ⇒ 读成 0（刻意保守，不猜）', async () => {
    // ⚠️ 出现带千分位/单位的字符串本身就说明响应形态变了；猜成 1234 会让
    //    一次上游改版变成「数字看起来对、其实错」的静默错误。
    const fetcher = (async () => jsonResponse({
      code: 1000,
      data: { tasks: [{ code: 't1', title: 'x', points: '1,234 积分', status: '', reward_status: '' }] },
    })) as unknown as typeof fetch
    const status = await fetchMagicrewOnboardingStatus({ ...CREDENTIAL, fetchImpl: fetcher })
    expect(status.points['t1']).toBe(0)
  })

  it('国际站缺组织码 ⇒ 本地前置拦下并给出可操作文案（不把 2182 原样抛给用户）', async () => {
    const fetcher = vi.fn(async () => jsonResponse({ code: 2182, message: '用户所在组织不存在' })) as unknown as typeof fetch
    await expect(fetchMagicrewOnboardingStatus({
      jwt: 'jwt',
      organizationCode: '',
      product: MAGICREW_INTL,
      fetchImpl: fetcher,
    })).rejects.toThrow(/缺少组织码/)
    // ⚠️ 必须在本地就拦下：一个字节都不该发出去。
    expect(fetcher).not.toHaveBeenCalled()
  })

  it('国内站缺组织码**不**拦（缺了上游仍 200，拦了会误伤）', async () => {
    const fetcher = vi.fn(async () => jsonResponse({ code: 1000, data: { tasks: [] } })) as unknown as typeof fetch
    const status = await fetchMagicrewOnboardingStatus({
      jwt: 'jwt',
      organizationCode: '',
      product: MAGICREW,
      fetchImpl: fetcher,
    })
    expect(status.total).toBe(0)
    expect(fetcher).toHaveBeenCalledTimes(1)
  })
})

describe('magicrew 新人奖励：claimMagicrewOnboardingTasks', () => {
  it('first_ai_work 归 manualRequired（不是 skipped），且不发 PUT', async () => {
    const calls: string[] = []
    const fetcher = (async (url: string | URL | Request, init?: RequestInit) => {
      const href = String(url)
      calls.push(`${init?.method ?? 'GET'} ${href}`)
      if ((init?.method ?? 'GET') === 'GET') {
        return jsonResponse({
          code: 1000,
          data: {
            tasks: [
              { code: 'first_ai_work', title: '发第一条消息', points: 50, status: 'PENDING', reward_status: '' },
              { code: 'done_one', title: '已完成', points: 100, status: 'COMPLETED', reward_status: 'GRANTED' },
            ],
          },
        })
      }
      return jsonResponse({ code: 1000, data: { points: 0 } })
    }) as unknown as typeof fetch

    const result = await claimMagicrewOnboardingTasks({ ...CREDENTIAL, fetchImpl: fetcher, throttleMs: 0 })
    expect(result.manualRequired).toEqual(['first_ai_work'])
    // ⚠️ 绝不能混进 skipped：那个字段的语义是「此前已完成」，而它既没完成也没领到分。
    expect(result.skipped).toEqual(['done_one'])
    expect(result.claimed).toEqual([])
    // 只发了那一次 GET，没有任何 PUT
    expect(calls.filter((line) => line.startsWith('PUT'))).toHaveLength(0)
  })

  it('9303 若漏进错误分支也归 manualRequired（数字与字符串两种码值都认）', async () => {
    for (const code of [9303, '9303']) {
      const fetcher = (async (url: string | URL | Request, init?: RequestInit) => {
        if ((init?.method ?? 'GET') === 'GET') {
          return jsonResponse({
            code: 1000,
            data: { tasks: [{ code: 'some_new_task', title: 'x', points: 50, status: 'PENDING', reward_status: '' }] },
          })
        }
        return jsonResponse({ code, message: '该新人引导任务不支持手动完成' })
      }) as unknown as typeof fetch

      const result = await claimMagicrewOnboardingTasks({ ...CREDENTIAL, fetchImpl: fetcher, throttleMs: 0 })
      expect(result.manualRequired).toEqual(['some_new_task'])
      expect(result.errors).toBeUndefined()
    }
  })

  it('部分成功：有 claimed + 有 errors ⇒ 返回并带 errors（不上抛）', async () => {
    let putIndex = 0
    const fetcher = (async (url: string | URL | Request, init?: RequestInit) => {
      if ((init?.method ?? 'GET') === 'GET') {
        return jsonResponse({
          code: 1000,
          data: {
            tasks: [
              { code: 'one', title: 'A', points: 50, status: 'PENDING', reward_status: '' },
              { code: 'two', title: 'B', points: 50, status: 'PENDING', reward_status: '' },
            ],
          },
        })
      }
      putIndex += 1
      // 第一项成功，第二项失败
      return putIndex === 1
        ? jsonResponse({ code: 1000, data: { points: 50 } })
        : jsonResponse({ code: 500, message: '上游抖动' })
    }) as unknown as typeof fetch

    const result = await claimMagicrewOnboardingTasks({ ...CREDENTIAL, fetchImpl: fetcher, throttleMs: 0 })
    expect(result.claimed).toHaveLength(1)
    expect(result.errors).toHaveLength(1)
    expect(result.errors?.[0]).toContain('two')
    expect(result.earned).toBe(50)
  })

  it('零成功 + 有失败 ⇒ 上抛（否则上层会包成「成功但没领到」）', async () => {
    const fetcher = (async (url: string | URL | Request, init?: RequestInit) => {
      if ((init?.method ?? 'GET') === 'GET') {
        return jsonResponse({
          code: 1000,
          data: { tasks: [{ code: 'one', title: 'A', points: 50, status: 'PENDING', reward_status: '' }] },
        })
      }
      return jsonResponse({ code: 500, message: '全挂了' })
    }) as unknown as typeof fetch

    await expect(claimMagicrewOnboardingTasks({ ...CREDENTIAL, fetchImpl: fetcher, throttleMs: 0 }))
      .rejects.toThrow(/新人奖励领取失败/)
  })

  it('HTTP 200 + code:"403"（字符串业务码）⇒ 判失败，不落成「已领取」', async () => {
    // ⚠️ 这正是来源二审发现的真缺陷：既不过数字腿也不过 HTTP 腿（HTTP 是 200）
    //    ⇒ 一路判成功 ⇒ 签到静默漏领、新人奖励显示「无任务」。
    const fetcher = (async () => jsonResponse({ code: '403', message: 'token无效' })) as unknown as typeof fetch
    await expect(fetchMagicrewOnboardingStatus({ ...CREDENTIAL, fetchImpl: fetcher }))
      .rejects.toThrow(/token无效/)
  })

  it('"0x3E8" 不当成功码（十六进制不算十进制字面量）', async () => {
    const fetcher = (async () => jsonResponse({ code: '0x3E8' })) as unknown as typeof fetch
    // ⚠️ `Number('0x3E8') === 1000` —— 裸 Number 会把它放行成成功码。
    //    本仓刻意拒绝畸形：非十进制字面量不走码值腿，交给 HTTP 腿兜底。
    //    HTTP 是 200 且没有 tasks ⇒ 读成空列表（不抛），这是「安全的降级」。
    const status = await fetchMagicrewOnboardingStatus({ ...CREDENTIAL, fetchImpl: fetcher })
    expect(status.total).toBe(0)
  })

  it('国际站 0 项 ⇒ total 0（不是「全部完成」）', async () => {
    const fetcher = (async () => jsonResponse({ code: 1000, data: { participant_type: null, tasks: [] } })) as unknown as typeof fetch
    const status = await fetchMagicrewOnboardingStatus({ ...CREDENTIAL, product: MAGICREW_INTL, fetchImpl: fetcher })
    expect(status.total).toBe(0)
    expect(Object.keys(status.tasks)).toHaveLength(0)
  })

  it('已知不可手动完成的 code 表里只有 first_ai_work（不臆造更多）', () => {
    expect([...MAGICREW_NOT_MANUALLY_COMPLETABLE]).toEqual(['first_ai_work'])
  })
})

describe('magicrew 三档积分分桶', () => {
  const NOW = Date.UTC(2026, 10, 2, 0, 0, 0)
  const DAY = 24 * 60 * 60 * 1000

  it('按到期时间分三档（< 15 天 = 临期，≥ 15 天 = 长期，无到期 = 永久）', () => {
    const split = splitMagicrewCreditPackages([
      pkg(100, NOW + 3 * DAY),   // 临期
      pkg(200, NOW + 30 * DAY),  // 长期
      pkg(300),                  // 永久
    ], 15, NOW)
    expect(split.expiring).toBe(100)
    expect(split.longTerm).toBe(200)
    expect(split.permanent).toBe(300)
    expect(split.earliestExpiringAt).toBe(NOW + 3 * DAY)
  })

  it('已失效（active !== true）与剩余 ≤ 0 都不计入任何一档', () => {
    const inactive = { ...pkg(500), active: false }
    const split = splitMagicrewCreditPackages([inactive, pkg(0), pkg(-5)], 15, NOW)
    expect(split.permanent).toBe(0)
    expect(split.expiring).toBe(0)
    expect(split.longTerm).toBe(0)
  })

  it('已过期的批次不计入临期，也不污染 earliestExpiringAt', () => {
    const split = splitMagicrewCreditPackages([pkg(100, NOW - DAY)], 15, NOW)
    expect(split.expiring).toBe(0)
    expect(split.earliestExpiringAt).toBeNull()
  })
})

describe('magicrew 到期档位与选号', () => {
  it('档位优先级：临期 > 长期 > 永久 > 未知 > 空', () => {
    expect(magicrewExpiryTier({ id: 'a', expiring: 1, ok: true })).toBe(MAGICREW_EXPIRY_TIER.expiring)
    expect(magicrewExpiryTier({ id: 'a', longTerm: 1, ok: true })).toBe(MAGICREW_EXPIRY_TIER.longTerm)
    expect(magicrewExpiryTier({ id: 'a', permanent: 1, ok: true })).toBe(MAGICREW_EXPIRY_TIER.permanent)
    expect(magicrewExpiryTier({ id: 'a', ok: false })).toBe(MAGICREW_EXPIRY_TIER.unknown)
    expect(magicrewExpiryTier({ id: 'a', ok: true })).toBe(MAGICREW_EXPIRY_TIER.empty)
  })

  it('未锁定：unknown 仍可用（查询失败不该等于「没有账号」）', () => {
    expect(magicrewTierUsable(MAGICREW_EXPIRY_TIER.unknown)).toBe(true)
    expect(magicrewTierUsable(MAGICREW_EXPIRY_TIER.empty)).toBe(false)
  })

  it('锁定永久积分：permanent / unknown / empty 一律不可用', () => {
    // ⚠️ unknown 若可用，锁定就成了一次网络抖动即可绕过的装饰。
    for (const tier of [MAGICREW_EXPIRY_TIER.permanent, MAGICREW_EXPIRY_TIER.unknown, MAGICREW_EXPIRY_TIER.empty]) {
      expect(magicrewTierUsable(tier, { allowPermanent: false })).toBe(false)
    }
    expect(magicrewTierUsable(MAGICREW_EXPIRY_TIER.expiring, { allowPermanent: false })).toBe(true)
    expect(magicrewTierUsable(MAGICREW_EXPIRY_TIER.longTerm, { allowPermanent: false })).toBe(true)
  })

  it('档内保持手动顺序（稳定排序），且返回新数组', () => {
    const accounts = [
      { id: 'p1', permanent: 100, ok: true },
      { id: 'x1', expiring: 100, ok: true },
      { id: 'p2', permanent: 100, ok: true },
      { id: 'x2', expiring: 100, ok: true },
    ]
    const ranked = rankMagicrewAccountsByExpiry(accounts)
    expect(ranked.map((a) => a.id)).toEqual(['x1', 'x2', 'p1', 'p2'])
    // 原数组不被改
    expect(accounts.map((a) => a.id)).toEqual(['p1', 'x1', 'p2', 'x2'])
  })
})

describe('magicrew 余额：永久积分包与守恒裁剪', () => {
  const fetcherOf = (body: unknown): typeof fetch =>
    (async () => jsonResponse(body)) as unknown as typeof fetch

  beforeEach(() => {
    vi.useRealTimers()
  })

  it('合成「永久积分」包，使 sum(remaining) === total', async () => {
    // 实测形状：total 2661 / 批次 1661 / 残差 1000
    const balance = await fetchMagicrewBalance({
      ...CREDENTIAL,
      fetchImpl: fetcherOf({
        code: 1000,
        data: {
          total_points: 2661,
          expiring_quota_details: [
            { quota_id: 'q1', expires_at: '2027-11-03 23:02:08', remaining_points: 1661 },
          ],
        },
      }),
    })
    expect(balance?.total).toBe(2661)
    const sum = balance!.packages.reduce((acc, item) => acc + item.remaining, 0)
    expect(sum).toBe(2661)
    const permanent = balance!.packages.find((item) => item.name === '永久积分')
    expect(permanent?.remaining).toBe(1000)
    // ⚠️ 刻意**不给** `expiredTime`：有值会落进「长期」桶，而锁定永久积分保护的正是它。
    expect(permanent?.expiredTime).toBe('')
  })

  it('total_points 是字符串 "2661" 也认（只认 number 会让积分与选号同时全死）', async () => {
    const balance = await fetchMagicrewBalance({
      ...CREDENTIAL,
      fetchImpl: fetcherOf({ code: 1000, data: { total_points: '2661', expiring_quota_details: [] } }),
    })
    expect(balance?.total).toBe(2661)
  })

  it('remaining_points 是字符串 "50" 也认（丢弃会让临期被误标成永久）', async () => {
    const balance = await fetchMagicrewBalance({
      ...CREDENTIAL,
      fetchImpl: fetcherOf({
        code: 1000,
        data: {
          total_points: 150,
          expiring_quota_details: [{ expires_at: '2027-11-03 23:02:08', remaining_points: '50' }],
        },
      }),
    })
    const limited = balance!.packages.find((item) => item.name === '限时积分')
    expect(limited?.remaining).toBe(50)
    const permanent = balance!.packages.find((item) => item.name === '永久积分')
    expect(permanent?.remaining).toBe(100)
  })

  it('欠费（total_points 为负）不做裁剪，批次明细照常给出', async () => {
    // ⚠️ 若照 total 裁剪，循环首轮 budget <= 0 就 break ⇒ 正批次被整条丢弃 ⇒
    //    面板只剩「积分 -31」（无包、三档行不渲染），而报文里其实给了可用批次。
    const balance = await fetchMagicrewBalance({
      ...CREDENTIAL,
      fetchImpl: fetcherOf({
        code: 1000,
        data: {
          total_points: -31,
          expiring_quota_details: [{ expires_at: '2027-11-03 23:02:08', remaining_points: 50 }],
        },
      }),
    })
    expect(balance?.total).toBe(-31)
    expect(balance!.packages).toHaveLength(1)
    expect(balance!.packages[0].remaining).toBe(50)
  })

  it('批次合计 > total ⇒ 按到期从早到晚裁剪，临期优先保留', async () => {
    // 构造矛盾报文：total 100，批次 200（远）+ 50（近）
    const now = Date.now()
    const near = new Date(now + 2 * 24 * 60 * 60 * 1000).toISOString().slice(0, 19).replace('T', ' ')
    const far = new Date(now + 90 * 24 * 60 * 60 * 1000).toISOString().slice(0, 19).replace('T', ' ')
    const balance = await fetchMagicrewBalance({
      ...CREDENTIAL,
      fetchImpl: fetcherOf({
        code: 1000,
        data: {
          total_points: 100,
          expiring_quota_details: [
            { expires_at: far, remaining_points: 200 },
            { expires_at: near, remaining_points: 50 },
          ],
        },
      }),
    })
    const sum = balance!.packages.reduce((acc, item) => acc + item.remaining, 0)
    // 裁剪后合计等于权威余额（不多出「看起来能用」的积分）
    expect(sum).toBe(100)
    // 临期那 50 必须**完整保留**（先到期先消耗）
    const nearIso = new Date(Date.parse(near.replace(' ', 'T') + '+08:00')).toISOString()
    const nearPkg = balance!.packages.find((item) => item.expiredTime === nearIso)
    expect(nearPkg?.remaining).toBe(50)
  })

  it('非法日期 "2026-13-45 25:99:99" ⇒ 当无到期时间（Date.UTC 会静默归一化）', async () => {
    const balance = await fetchMagicrewBalance({
      ...CREDENTIAL,
      fetchImpl: fetcherOf({
        code: 1000,
        data: {
          total_points: 100,
          expiring_quota_details: [{ expires_at: '2026-13-45 25:99:99', remaining_points: 100 }],
        },
      }),
    })
    // 解析不出来 ⇒ expiredTime 空串 ⇒ 落「永久」桶（而不是变成一个真实时刻）
    expect(balance!.packages[0].expiredTime).toBe('')
  })
})
