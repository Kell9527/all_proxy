/**
 * 「锁定永久积分」在 Qoder / Qoder (中国版) / TRAE 上的判据。
 *
 * 每条用例都对应一个「如果不这样写就会**静默**出错」的场景（本仓库惯例：
 * 用例的价值在于钉住判据，不是凑覆盖率）。三个最关键的：
 *
 * 1. **假开关**（改前真实存在）：`pool.permanentLocked()` 从未被这三家读过 ⇒
 *    按钮点了行为完全不变，永久积分照样被烧，且没有任何提示。
 * 2. **永久哨兵**（Qoder）：`expiresAt = 253402214400000` 若被当成真实到期时间，
 *    包会落进 `longTerm` 桶 —— 而 `longTerm` 在锁定时**仍然可选** ⇒ 锁住的
 *    永久积分在这一路径上照样被烧。
 * 3. **TRAE 的 `expire_time` 被漏移植**（改前真实存在）：每个包的 `expiredTime`
 *    都是空串 ⇒ 全体落「永久」桶 ⇒ 锁定时**所有账号**都被判不可用。
 */

import { dirname, resolve } from 'node:path'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import {
  CREDIT_EXPIRY_TIER,
  CREDIT_EXPIRY_WINDOW_DAYS,
  CreditExpirySelector,
  creditExpiryOfBalance,
  creditExpiryTier,
  creditLockedError,
  creditTierUsable,
  foldErrors,
  rankAccountsByExpiry,
  splitCreditPackagesByExpiry,
} from '../../src/providers/credit-expiry-rank.js'
import {
  isPermanentSentinelMs,
  QODER_PERMANENT_EXPIRY_MS,
} from '../../src/providers/qoder-credits.js'
import type { CreditPackage } from '../../src/providers/credits.js'

const DAY = 24 * 60 * 60 * 1000
const NOW = Date.UTC(2026, 10, 2, 0, 0, 0)

/** 造一条积分包（`expiredTime` 是 ISO 串；空串 = 永久）。 */
function pkg(remaining: number, expiresAt?: number): CreditPackage {
  return {
    name: '资源包',
    unit: 'credits',
    remaining,
    total: remaining,
    used: 0,
    active: true,
    cycleStartTime: '',
    cycleEndTime: '',
    expiredTime: expiresAt === undefined ? '' : new Date(expiresAt).toISOString(),
  }
}

describe('共享分档层：三档口径（面板与选号必须逐字同源）', () => {
  it('按到期时间分三档（< 15 天 = 临期，≥ 15 天 = 长期，无到期 = 永久）', () => {
    const split = splitCreditPackagesByExpiry([
      pkg(100, NOW + 3 * DAY),   // 临期
      pkg(200, NOW + 30 * DAY),  // 长期
      pkg(300),                  // 永久
    ], CREDIT_EXPIRY_WINDOW_DAYS, NOW)
    expect(split.expiring).toBe(100)
    expect(split.longTerm).toBe(200)
    expect(split.permanent).toBe(300)
    expect(split.earliestExpiringAt).toBe(NOW + 3 * DAY)
  })

  it('窗口边界方向是 `end - now < window`（恰好 15 天算长期，不算临期）', () => {
    const at = splitCreditPackagesByExpiry([pkg(100, NOW + 15 * DAY)], CREDIT_EXPIRY_WINDOW_DAYS, NOW)
    expect(at.expiring).toBe(0)
    expect(at.longTerm).toBe(100)
    const justUnder = splitCreditPackagesByExpiry(
      [pkg(100, NOW + 15 * DAY - 1000)], CREDIT_EXPIRY_WINDOW_DAYS, NOW,
    )
    expect(justUnder.expiring).toBe(100)
  })

  it('已失效 / 剩余 ≤ 0 / 已过期 都不计入任何档，且不污染 earliestExpiringAt', () => {
    const inactive = { ...pkg(500), active: false }
    const split = splitCreditPackagesByExpiry([inactive, pkg(0), pkg(-5), pkg(100, NOW - DAY)], 15, NOW)
    expect(split).toEqual({ expiring: 0, longTerm: 0, permanent: 0, earliestExpiringAt: null })
  })

  it('窗口天数是**唯一常量**（后端 / 前端 / 共享层不得各写一份 15）', () => {
    expect(CREDIT_EXPIRY_WINDOW_DAYS).toBe(15)
    const here = dirname(fileURLToPath(import.meta.url))
    const endpoint = readFileSync(resolve(here, '../../src/admin/credits-endpoint.ts'), 'utf8')
    expect(endpoint).toContain('CREDIT_EXPIRY_WINDOW_DAYS = 15')
    const client = readFileSync(resolve(here, '../../plugin-src/client/credit-expiry.js'), 'utf8')
    expect(client).toContain('CREDIT_EXPIRY_WINDOW_DAYS = 15')
  })
})

describe('共享分档层：档位与锁定可用性', () => {
  it('档位优先级：临期 > 长期 > 永久 > 未知 > 空', () => {
    expect(creditExpiryTier({ id: 'a', expiring: 1, ok: true })).toBe(CREDIT_EXPIRY_TIER.expiring)
    expect(creditExpiryTier({ id: 'a', longTerm: 1, ok: true })).toBe(CREDIT_EXPIRY_TIER.longTerm)
    expect(creditExpiryTier({ id: 'a', permanent: 1, ok: true })).toBe(CREDIT_EXPIRY_TIER.permanent)
    expect(creditExpiryTier({ id: 'a', ok: false })).toBe(CREDIT_EXPIRY_TIER.unknown)
    expect(creditExpiryTier({ id: 'a', ok: true })).toBe(CREDIT_EXPIRY_TIER.empty)
  })

  it('未锁定：只有 empty 不可用（unknown 仍可用，查询失败不等于「没有账号」）', () => {
    expect(creditTierUsable(CREDIT_EXPIRY_TIER.expiring)).toBe(true)
    expect(creditTierUsable(CREDIT_EXPIRY_TIER.longTerm)).toBe(true)
    expect(creditTierUsable(CREDIT_EXPIRY_TIER.permanent)).toBe(true)
    expect(creditTierUsable(CREDIT_EXPIRY_TIER.unknown)).toBe(true)
    expect(creditTierUsable(CREDIT_EXPIRY_TIER.empty)).toBe(false)
  })

  it('锁定永久积分：permanent / unknown / empty 一律不可用', () => {
    // ⚠️ unknown 若可用，锁定就成了一次网络抖动即可绕过的装饰。
    for (const tier of [CREDIT_EXPIRY_TIER.permanent, CREDIT_EXPIRY_TIER.unknown, CREDIT_EXPIRY_TIER.empty]) {
      expect(creditTierUsable(tier, { allowPermanent: false }), `档位 ${tier}`).toBe(false)
    }
    expect(creditTierUsable(CREDIT_EXPIRY_TIER.expiring, { allowPermanent: false })).toBe(true)
    expect(creditTierUsable(CREDIT_EXPIRY_TIER.longTerm, { allowPermanent: false })).toBe(true)
  })

  it('档内保持手动顺序（稳定排序），且返回新数组', () => {
    const accounts = [
      { id: 'p1', permanent: 100, ok: true },
      { id: 'x1', expiring: 100, ok: true },
      { id: 'p2', permanent: 100, ok: true },
      { id: 'x2', expiring: 100, ok: true },
    ]
    const ranked = rankAccountsByExpiry(accounts)
    expect(ranked.map((a) => a.id)).toEqual(['x1', 'x2', 'p1', 'p2'])
    expect(accounts.map((a) => a.id)).toEqual(['p1', 'x1', 'p2', 'x2'])
  })
})

describe('Qoder 永久哨兵（253402214400000 = 9999-12-31）', () => {
  it('常量就是 9999-12-31 的毫秒时间戳', () => {
    expect(QODER_PERMANENT_EXPIRY_MS).toBe(253402214400000)
    expect(new Date(QODER_PERMANENT_EXPIRY_MS).toISOString().startsWith('9999-12-31')).toBe(true)
  })

  it('识别哨兵：≥ 常量、以及年份 ≥ 9999（兜住 9999-01-01~12-30）', () => {
    expect(isPermanentSentinelMs(QODER_PERMANENT_EXPIRY_MS)).toBe(true)
    expect(isPermanentSentinelMs(Date.parse('9999-12-30T00:00:00Z'))).toBe(true)
    expect(isPermanentSentinelMs(Date.parse('9999-01-01T00:00:00Z'))).toBe(true)
  })

  it('真实日期与非法值都不是哨兵（NaN/0/负数走「没有到期时间」那条路）', () => {
    expect(isPermanentSentinelMs(Date.parse('2026-12-31T00:00:00Z'))).toBe(false)
    expect(isPermanentSentinelMs(Number.NaN)).toBe(false)
    expect(isPermanentSentinelMs(0)).toBe(false)
    expect(isPermanentSentinelMs(-1)).toBe(false)
  })

  it('⚠️ 哨兵若被当成真实到期时间，包会落进 longTerm —— 而 longTerm 锁定时仍可选', () => {
    // 这是「锁定形同虚设」的机制：不需要真的构造报文，分档层就是判据。
    const asLongTerm = splitCreditPackagesByExpiry([pkg(1000, QODER_PERMANENT_EXPIRY_MS)], 15, NOW)
    expect(asLongTerm.longTerm).toBe(1000)
    expect(creditTierUsable(CREDIT_EXPIRY_TIER.longTerm, { allowPermanent: false })).toBe(true)
    // 正确归一化后（expiredTime 为空串）⇒ 永久桶 ⇒ 锁定时不可用。
    const asPermanent = splitCreditPackagesByExpiry([pkg(1000)], 15, NOW)
    expect(asPermanent.permanent).toBe(1000)
    expect(creditTierUsable(CREDIT_EXPIRY_TIER.permanent, { allowPermanent: false })).toBe(false)
  })
})

describe('共享报错文案', () => {
  it('「查不到」与「确实用尽」是两条文案（否则用户会去解锁并不可撤回地烧积分）', () => {
    const unknown = creditLockedError('Qoder', 'unknown', ['a: 查询失败'])
    const exhausted = creditLockedError('Qoder', 'exhausted')
    expect(unknown.message).toContain('无法确认')
    expect(unknown.message).toContain('请重试')
    expect(exhausted.message).toContain('没有可用账号')
    expect(exhausted.message).not.toContain('请重试')
  })

  it('不得编造天数（Qoder 拿不到逐包到期时刻，写「N 天内到期」会让用户白等）', () => {
    for (const reason of ['unknown', 'exhausted', 'broken-credential'] as const) {
      const error = creditLockedError('Qoder', reason)
      expect(error.message).not.toMatch(/\d+\s*天/)
    }
  })

  it('「拿不到证据」不等于「永不过期」（Qoder 的 addOnQuota 其实 30 天有效）', () => {
    // 领取响应写的是 `validity: {mode:'RELATIVE_DAYS', days:30}`，而 usage 端点
    // 只回聚合标量 ⇒ 本端**结构上**看不到那 30 天。文案若写成「永不过期」就是
    // 一句假话，还可能让用户白白放掉即将作废的额度。
    const error = creditLockedError('Qoder', 'exhausted')
    expect(error.message).toContain('不等于')
    expect(error.message).not.toContain('永不过期**（')
  })

  it('用裸 Error，不带 LlmError.code（避免被映射成 429「稍后重试」）', () => {
    // 规则：`toGatewayError` 把非 LlmError 一律转 500 internal_error。
    // 刻意**不**报 QUOTA_EXCEEDED —— 那会映射成 429，而这里是确定性条件
    // （解锁前重试必然同样失败），报 429 只会让客户端白重试。
    const error = creditLockedError('TRAE', 'exhausted')
    expect((error as { code?: string }).code).toBeUndefined()
    expect(error.name).toBe('Error')
  })

  it('逐账号原因先去重、再截断（同一故障在每个号上各产生一条逐字相同的串）', () => {
    expect(foldErrors(['a: 失败', 'a: 失败', 'b: 别的'])).toBe('a: 失败；b: 别的')
    expect(foldErrors([])).toBe('原因未知')
  })
})

describe('源码级回归：三个渠道的锁定必须真的接线（防「假开关」）', () => {
  const here = dirname(fileURLToPath(import.meta.url))
  const wiring = readFileSync(resolve(here, '../../src/providers/wiring.ts'), 'utf8')
  const client = readFileSync(resolve(here, '../../plugin-src/client/credits-capabilities.js'), 'utf8')

  it('wiring 对 qoder / qodercn / trae 都读了 permanentLocked', () => {
    // 改前这三家一次都没读过 ⇒ 点了锁行为完全不变（真实缺陷）。
    expect(wiring).toContain('ctx.pool.permanentLocked(product.id)')
    expect(wiring).toContain('ctx.pool.permanentLocked(TRAE.id)')
  })

  it('锁定选号失败时**只抛错**，不回落通用池（回落会绕过锁定）', () => {
    expect(wiring).toContain('lockedNoAccountError')
    // 抛出的位置必须在「select 返回 undefined」那一支里，且后面没有再 return 池。
    const lockedBlocks = wiring.split('lockedNoAccountError').length - 1
    expect(lockedBlocks).toBeGreaterThanOrEqual(3) // 1 处定义 + 2 处调用
  })

  it('免费模型必须豁免余额门（否则锁定期间报「额度都属于永久」这种反事实错误）', () => {
    expect(wiring).toContain('isFreeModel(modelId')
    expect(readFileSync(resolve(here, '../../src/providers/qoder-adapter.ts'), 'utf8')).toContain('isFreeModel(')
    expect(readFileSync(resolve(here, '../../src/providers/trae-adapter.ts'), 'utf8')).toContain('isFreeModel(')
  })

  it('前端白名单与后端接线同一集合（前端多给一家 = 必然失败的开关）', () => {
    for (const id of ['qoder', 'qodercn', 'trae']) {
      expect(client).toContain(`'${id}',`)
    }
  })
})

describe('CreditExpirySelector：锁定逻辑与降级', () => {
  /** 造一个只按 id 返回固定余额的选择器依赖。 */
  const selectorOf = (balances: Record<string, CreditPackage[] | undefined>, now = NOW) =>
    new CreditExpirySelector({
      now: () => now,
      ttlMs: 60_000,
      fetchBalance: async (candidate) => {
        const packages = balances[candidate.id]
        if (packages === undefined) return undefined
        return { total: packages.reduce((sum, p) => sum + p.remaining, 0), packages, expiredTotal: 0 }
      },
    })

  it('选号优先临期，其次长期，其次永久（档内保持手动顺序）', async () => {
    const selector = selectorOf({
      a: [pkg(100)],
      b: [pkg(100, NOW + 30 * DAY)],
      c: [pkg(100, NOW + 2 * DAY)],
    })
    const picked = await selector.select([{ id: 'a', credentialRef: 'r-a' }, { id: 'b', credentialRef: 'r-b' }, { id: 'c', credentialRef: 'r-c' }])
    expect(picked?.account.id).toBe('c')
    expect(picked?.expiry?.expiring).toBe(100)
  })

  it('锁定永久积分：只剩永久桶时返回 undefined（调用方据此报明确错误）', async () => {
    const selector = selectorOf({ a: [pkg(100)] })
    expect(await selector.select([{ id: 'a', credentialRef: 'r-a' }], { allowPermanent: false })).toBeUndefined()
  })

  it('锁定永久积分：有真正会到期的包时照样可选（TRAE 的关键差异）', async () => {
    const selector = selectorOf({ a: [pkg(100, NOW + 2 * DAY)] })
    const picked = await selector.select([{ id: 'a', credentialRef: 'r-a' }], { allowPermanent: false })
    expect(picked?.account.id).toBe('a')
  })

  it('查询异常归 unknown 而不是崩溃（一次抖动不能把整条渠道打成硬故障）', async () => {
    const selector = new CreditExpirySelector({
      now: () => NOW,
      fetchBalance: async () => { throw new Error('网络炸了') },
    })
    const expiry = await selector.expiryOf({ id: 'a', credentialRef: 'r-a' })
    expect(expiry.ok).toBe(false)
    expect(creditExpiryTier(expiry)).toBe(CREDIT_EXPIRY_TIER.unknown)
  })

  it('60 秒 TTL 内不重复查（同一轮对话不该为同一次选号打 N 遍上游）', async () => {
    let calls = 0
    const selector = new CreditExpirySelector({
      now: () => NOW,
      ttlMs: 60_000,
      fetchBalance: async () => {
        calls += 1
        return { total: 100, packages: [pkg(100)], expiredTotal: 0 }
      },
    })
    await selector.expiryOf({ id: 'a', credentialRef: 'r-a' })
    await selector.expiryOf({ id: 'a', credentialRef: 'r-a' })
    expect(calls).toBe(1)
    selector.invalidate()
    await selector.expiryOf({ id: 'a', credentialRef: 'r-a' })
    expect(calls).toBe(2)
  })

  it('查不到余额（undefined）与「查到且为 0」在档位上不同（unknown vs empty）', () => {
    expect(creditExpiryTier(creditExpiryOfBalance('a', undefined, 15, NOW))).toBe(CREDIT_EXPIRY_TIER.unknown)
    expect(creditExpiryTier(creditExpiryOfBalance('a', { total: 0, packages: [], expiredTotal: 0 }, 15, NOW)))
      .toBe(CREDIT_EXPIRY_TIER.empty)
  })
})

describe('TRAE 条目级 expire_time（秒级）必须归一化进 expiredTime', () => {
  const here = dirname(fileURLToPath(import.meta.url))
  const source = readFileSync(resolve(here, '../../src/providers/trae-credits.ts'), 'utf8')

  it('读了 expire_time 且乘 1000（不乘会落在 1970 年）', () => {
    expect(source).toContain("readNumber(entry, 'expire_time')")
    expect(source).toContain('expireSec * 1000')
  })

  it('拿不到到期时间时写空串（不编造日期 ⇒ 归永久桶）', () => {
    expect(source).toContain('expireSec > 0 ? new Date(expireSec * 1000).toISOString() :')
  })

  it('包名优先 display_desc（base.name 实测为 undefined）', () => {
    expect(source).toContain("readString(base, 'display_desc')")
  })
})
