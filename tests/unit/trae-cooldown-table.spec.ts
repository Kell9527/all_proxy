/**
 * TRAE 冷却时长表（A8）。
 *
 * ## 为什么锁死这些值
 *
 * 原实现一律用 1 小时兜底 ⇒ `quota-exceeded`（日配额耗尽）也只冷却 1 小时，
 * 1 小时后耗尽的账号被再次选中、又是 4008 —— 用户看到「轮换好像不行」。
 * 取值必须对齐 `trae-errors.ts` 的既有权威定义，且**各档数量级不同**。
 */
import { describe, expect, it } from 'vitest'
import { TRAE_COOLDOWN_MS, traeCooldownFor } from '../../src/providers/trae-cooldown-table.js'

const HOUR = 3_600_000

describe('TRAE_COOLDOWN_MS', () => {
  it('quota-exceeded（日配额耗尽）→ 24 小时（覆盖到下次签到）', () => {
    expect(traeCooldownFor('quota-exceeded')).toBe(24 * HOUR)
  })

  it('hard-plan（套餐权益不足）→ 12 小时', () => {
    expect(traeCooldownFor('hard-plan')).toBe(12 * HOUR)
  })

  it('soft-rate（频率超限）→ 60 秒（分钟级恢复，放大到小时级会白损失容量）', () => {
    expect(traeCooldownFor('soft-rate')).toBe(60_000)
  })

  it('not-found / server / client → 1 小时', () => {
    expect(traeCooldownFor('not-found')).toBe(HOUR)
    expect(traeCooldownFor('server')).toBe(HOUR)
    expect(traeCooldownFor('client')).toBe(HOUR)
  })

  it('session-dead / none → 0（不靠冷却恢复）', () => {
    expect(traeCooldownFor('session-dead')).toBe(0)
    expect(traeCooldownFor('none')).toBe(0)
  })

  it('未知类别回落 1 小时（保守，与旧行为一致）', () => {
    expect(traeCooldownFor('zzz')).toBe(HOUR)
    expect(traeCooldownFor('')).toBe(HOUR)
  })

  it('三个关键档的取值互不相同（防「一律 1 小时」回归）', () => {
    const values = new Set([
      TRAE_COOLDOWN_MS['quota-exceeded'],
      TRAE_COOLDOWN_MS['hard-plan'],
      TRAE_COOLDOWN_MS['soft-rate'],
    ])
    expect(values.size).toBe(3)
  })
})
