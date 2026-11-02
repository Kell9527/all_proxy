/**
 * Magicrew 账号判重（`src/admin/magicrew-dedupe.ts`）的判据用例。
 *
 * 每条都对应一个「不这样写就会**静默**出错」的场景 —— 判重的错误方向有两侧：
 * 判成「不重复」会堆出重复卡片；判成「重复」会**覆盖掉别人的凭据**（不可逆）。
 */

import { describe, expect, it } from 'vitest'

import { findExistingMagicrewAccount } from '../../src/admin/magicrew-dedupe.js'
import { magicrewCredentialFingerprint } from '../../src/providers/magicrew-auth.js'

/** 造一个最小的池替身（按 provider 过滤 + 按 ref 给凭据）。 */
function stubPool(
  entries: Array<{ id: string, provider: string, credentialRef: string }>,
  credentials: Record<string, unknown>,
) {
  return {
    listAccountsByProvider: (provider: string) => entries.filter((e) => e.provider === provider),
    resolveCredentialByRef: async (ref: string) => credentials[ref] as Record<string, unknown> | undefined,
  } as never
}

const JWT = 'jwt-of-account-1'
const FP = magicrewCredentialFingerprint(JWT)

describe('magicrew 判重：按 jwt 指纹', () => {
  it('同一 jwt ⇒ 命中既有条目（同一个上游账号）', async () => {
    const pool = stubPool(
      [{ id: 'magicrew-a', provider: 'magicrew', credentialRef: 'R1' }],
      { R1: { jwt: JWT } },
    )
    const hit = await findExistingMagicrewAccount(pool, 'magicrew', FP)
    expect(hit?.id).toBe('magicrew-a')
  })

  it('jwt 不同 ⇒ 不命中（重新登录会拿到新 jwt，这种拦不住）', async () => {
    const pool = stubPool(
      [{ id: 'magicrew-a', provider: 'magicrew', credentialRef: 'R1' }],
      { R1: { jwt: 'another-jwt' } },
    )
    expect(await findExistingMagicrewAccount(pool, 'magicrew', FP)).toBeUndefined()
  })

  it('⚠️ 凭据读不出来 ⇒ **跳过**（不判重复，也不判不重复）', async () => {
    // 无法判定 ≠ 失配：判成「重复」会覆盖掉别人的凭据（不可逆）。
    const pool = stubPool(
      [
        { id: 'magicrew-broken', provider: 'magicrew', credentialRef: 'R-BROKEN' },
        { id: 'magicrew-good', provider: 'magicrew', credentialRef: 'R2' },
      ],
      { R2: { jwt: JWT } },
    )
    const hit = await findExistingMagicrewAccount(pool, 'magicrew', FP)
    // 坏的那条被跳过，命中后面那条**好的**。
    expect(hit?.id).toBe('magicrew-good')
  })

  it('凭据没有 jwt 字段 ⇒ 跳过该账号', async () => {
    const pool = stubPool(
      [{ id: 'magicrew-a', provider: 'magicrew', credentialRef: 'R1' }],
      { R1: { access_token: 'x' } },
    )
    expect(await findExistingMagicrewAccount(pool, 'magicrew', FP)).toBeUndefined()
  })

  it('⚠️ 两站互不可见：国际站导入不命中池里的国内站账号', async () => {
    // 一旦将来指纹口径变化（例如退化成「同手机号」），不限定 provider 就会出现
    // 「登录国际站却把国内站的卡改掉」这种错位。
    const pool = stubPool(
      [{ id: 'magicrew-a', provider: 'magicrew', credentialRef: 'R1' }],
      { R1: { jwt: JWT } },
    )
    expect(await findExistingMagicrewAccount(pool, 'magicrewintl', FP)).toBeUndefined()
  })

  it('空指纹 ⇒ 不判重（调用方没算出指纹时不得凭空命中）', async () => {
    const pool = stubPool(
      [{ id: 'magicrew-a', provider: 'magicrew', credentialRef: 'R1' }],
      { R1: { jwt: '' } },
    )
    expect(await findExistingMagicrewAccount(pool, 'magicrew', '')).toBeUndefined()
  })

  it('非 magicrew 的 provider ⇒ 直接返回 undefined（不扫别人的池）', async () => {
    const pool = stubPool(
      [{ id: 'qoder-a', provider: 'qoder', credentialRef: 'R1' }],
      { R1: { jwt: JWT } },
    )
    expect(await findExistingMagicrewAccount(pool, 'qoder', FP)).toBeUndefined()
  })

  it('`skipAccountId` 跳过指定条目（占位账号场景）', async () => {
    const pool = stubPool(
      [
        { id: 'magicrew-self', provider: 'magicrew', credentialRef: 'R1' },
        { id: 'magicrew-other', provider: 'magicrew', credentialRef: 'R2' },
      ],
      { R1: { jwt: JWT }, R2: { jwt: 'other' } },
    )
    expect(await findExistingMagicrewAccount(pool, 'magicrew', FP, 'magicrew-self')).toBeUndefined()
    // 不传 skip 时命中自己。
    expect((await findExistingMagicrewAccount(pool, 'magicrew', FP))?.id).toBe('magicrew-self')
  })

  it('⚠️ 池缺少遍历能力 ⇒ 退化为「不判重」而不是抛错', async () => {
    // 判重是「建号之前」的优化，不是前置条件：抛错会让一次本来完全正常的
    // 导入变成「导入失败」，而用户完全无从理解。
    const pool = {} as never
    expect(await findExistingMagicrewAccount(pool, 'magicrew', FP)).toBeUndefined()
  })
})