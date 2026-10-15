import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  OFFICEACE_EXPIRY_WINDOW_DAYS_HINT,
  officeaceConsumeOrderNotice,
} from '../../plugin-src/client/officeace-consume-order.js'

/**
 * OfficeAce 账号管理页「积分消耗顺序」说明的回归测试。
 *
 * 守三件事：只在 OfficeAce 上出现、账号数 < 2 时不出现（排序无意义）、
 * 文案里必须写全三档顺序与「拖拽仍然有效」—— 少了这句，用户会以为
 * 手动排序被这条策略覆盖了。
 */

describe('officeaceConsumeOrderNotice', () => {
  it('OfficeAce 且账号数 ≥ 2 时给出说明', () => {
    const notice = officeaceConsumeOrderNotice('officeace', 2)
    expect(notice).not.toBeNull()
    expect(notice).toContain('临期')
    expect(notice).toContain('长期')
    expect(notice).toContain('永久')
    // 必须点明「档内仍是手动顺序」，否则用户会以为拖拽失效了
    expect(notice).toContain('拖拽排序仍然有效')
    expect(notice).toContain(String(OFFICEACE_EXPIRY_WINDOW_DAYS_HINT))
  })

  it('只有一个账号时不显示（排序没有意义）', () => {
    expect(officeaceConsumeOrderNotice('officeace', 1)).toBeNull()
    expect(officeaceConsumeOrderNotice('officeace', 0)).toBeNull()
  })

  it('非 OfficeAce provider 一律不显示', () => {
    for (const id of ['loomy', 'raccoon', 'accio', 'sensenova', 'codearts', 'trae']) {
      expect(officeaceConsumeOrderNotice(id, 5), `${id} 不该有这段说明`).toBeNull()
    }
  })

  it('账号数读不到（undefined / NaN）时不显示', () => {
    expect(officeaceConsumeOrderNotice('officeace', undefined)).toBeNull()
    expect(officeaceConsumeOrderNotice('officeace', Number.NaN)).toBeNull()
  })
})

describe('jet-hub.js 接线（源码级回归）', () => {
  const source = readFileSync(
    resolve(dirname(fileURLToPath(import.meta.url)), '../../plugin-src/client/jet-hub.js'),
    'utf8',
  )

  it('账号面板引用了本模块，而不是另写一份文案', () => {
    expect(source).toContain("from './officeace-consume-order.js'")
    expect(source).toContain('officeaceConsumeOrderNotice(provider, accounts.length)')
  })
})
