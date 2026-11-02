/**
 * `leveldb-reader.ts` / `leveldb-snappy.ts` 的回归用例。
 *
 * ## 为什么要测「读浏览器数据库」这种底层设施
 *
 * 2026-11-02 用户报障「MagiCrew (国际版)：我在网页登录了，为什么没识别到」。
 * 排查后发现**三个各自都会单独致死的缺陷**叠在一起，而它们**全都没有任何报错**：
 *
 * | # | 缺陷 | 症状 |
 * |---|---|---|
 * | ① | 候选链只列 Edge Stable，漏 Beta/Dev/Canary | 装在 Beta 上的用户读不到 |
 * | ② | `.ldb` 块边界读错（`BlockHandle.size` **不含**块尾 5 字节） | 22MB 的库只读出 111 条 |
 * | ③ | Chromium 值的首字节是**编码标记**（0=UTF-16LE / 1=Latin-1） | UTF-16 值被解成 `{ " k e y "` |
 *
 * 三者的**共同症状**都是 `not-found` ⇒ 面板提示「请先在浏览器里登录」——
 * 而用户明明刚登好，照着提示重登也永远读不到。⇒ 必须用**构造样本**把每一格
 * 单独锁死，否则下一个改动又会静默回归。
 *
 * ⚠️ 用例**全部用构造的二进制**，绝不读真实浏览器目录：
 * 那里的内容随机器而变（开发机绿、CI 红），还会碰到真实用户的登录态。
 */
import { Buffer } from 'node:buffer'

import { describe, expect, it } from 'vitest'

import {
  decodeLocalStorageValue,
  leveldbEntries,
  sstableEntries,
  walEntries,
} from '../../src/providers/leveldb-reader.js'
import { readVarint, uncompressSnappy } from '../../src/providers/leveldb-snappy.js'

// ── 构造 leveldb 二进制的小工具 ─────────────────────────────────────────

/** 真 leveldb 的内部键后缀：`uint64(seq << 8 | type)`（8 字节）。 */
const INTERNAL_SUFFIX = Buffer.from([0x01, 0, 0, 0, 0, 0, 0, 0])

/** 造一个 `.ldb` 内部键：`userKey + 8 字节后缀`（解析器会把它剥掉）。 */
function withSuffix(userKey: string): Buffer {
  return Buffer.concat([Buffer.from(userKey, 'latin1'), INTERNAL_SUFFIX])
}

/** 写一个 varint。 */
function varint(value: number): Buffer {
  const out: number[] = []
  let rest = value
  for (;;) {
    const byte = rest & 0x7f
    rest = Math.floor(rest / 128)
    if (rest === 0) {
      out.push(byte)
      break
    }
    out.push(byte | 0x80)
  }
  return Buffer.from(out)
}

interface BlockEntry { key: Buffer, value: Buffer }

/** 构造一个 data block 的 payload（**不含**块尾 5 字节）。 */
function buildBlock(entries: readonly BlockEntry[]): Buffer {
  const parts: Buffer[] = []
  const restarts: number[] = []
  let lastKey = Buffer.alloc(0)
  let offset = 0
  entries.forEach((entry, index) => {
    if (index % 16 === 0) restarts.push(offset)
    let shared = 0
    while (shared < lastKey.length && shared < entry.key.length && lastKey[shared] === entry.key[shared]) shared++
    const record = Buffer.concat([
      varint(shared),
      varint(entry.key.length - shared),
      varint(entry.value.length),
      entry.key.subarray(shared),
      entry.value,
    ])
    parts.push(record)
    lastKey = entry.key
    offset += record.length
  })
  const restartBuf = Buffer.alloc(restarts.length * 4 + 4)
  restarts.forEach((value, index) => restartBuf.writeUInt32LE(value, index * 4))
  restartBuf.writeUInt32LE(restarts.length, restarts.length * 4)
  return Buffer.concat([...parts, restartBuf])
}

/**
 * 构造一个完整的 `.ldb` 文件。
 *
 * 布局：`[data blocks…][index block][metaindex block][footer 48B]`
 * 每个块 = `payload + 类型 1B + CRC 4B`（CRC 填 0，读取器不校验）。
 */
function buildSstable(
  blocks: readonly BlockEntry[][],
  options: { compress?: boolean } = {},
): Buffer {
  const chunks: Buffer[] = []
  const handles: { offset: number, size: number }[] = []
  let offset = 0
  for (const blockEntries of blocks) {
    const payload = buildBlock(blockEntries)
    const stored = options.compress === true ? compressStub(payload) : payload
    handles.push({ offset, size: stored.length })
    chunks.push(stored, Buffer.from([options.compress === true ? 1 : 0]), Buffer.alloc(4))
    offset += stored.length + 5
  }

  // index block：值是 (offset, size) handle。⚠️ index 键也带 8 字节内部后缀。
  const indexEntries: BlockEntry[] = handles.map((handle, index) => ({
    key: withSuffix(`\xffindex-${index}`),
    value: Buffer.concat([varint(handle.offset), varint(handle.size)]),
  }))
  const indexPayload = buildBlock(indexEntries)
  const indexHandle = { offset, size: indexPayload.length }
  chunks.push(indexPayload, Buffer.from([0]), Buffer.alloc(4))
  offset += indexPayload.length + 5

  // metaindex block（读取器跳过它，但 footer 里要有它的 handle）。
  const metaPayload = buildBlock([])
  const metaHandle = { offset, size: metaPayload.length }
  chunks.push(metaPayload, Buffer.from([0]), Buffer.alloc(4))

  const footer = Buffer.alloc(48)
  let at = 0
  for (const handle of [metaHandle, indexHandle]) {
    const offsetBuf = varint(handle.offset)
    const sizeBuf = varint(handle.size)
    offsetBuf.copy(footer, at)
    at += offsetBuf.length
    sizeBuf.copy(footer, at)
    at += sizeBuf.length
  }
  Buffer.from('57fb808b247547db', 'hex').copy(footer, 40)
  chunks.push(footer)
  return Buffer.concat(chunks)
}

/**
 * 最小 snappy 压缩器（**只用 literal**）。
 *
 * ⚠️ 故意不实现 copy 形式：本用例要验的是「读取器能解压缩」这条链路，
 * 而 copy 的**重叠语义**用 {@link uncompressSnappy} 的用例直接手写字节更精确。
 */
function compressStub(input: Buffer): Buffer {
  const out: Buffer[] = [varint(input.length)]
  let at = 0
  while (at < input.length) {
    const take = Math.min(input.length - at, 60)
    out.push(Buffer.from([(take - 1) << 2]))
    out.push(input.subarray(at, at + take))
    at += take
  }
  return Buffer.concat(out)
}

/** 构造一条 WAL 物理记录（`crc32 4B + length 2B + type 1B + payload`）。 */
function walRecord(payload: Buffer, type = 1): Buffer {
  const head = Buffer.alloc(7)
  head.writeUInt32LE(0, 0)
  head.writeUInt16LE(payload.length, 4)
  head[6] = type
  return Buffer.concat([head, payload])
}

/** 构造一个 WriteBatch（`seq 8B + count 4B + 条目…`）。 */
function writeBatch(entries: readonly BlockEntry[]): Buffer {
  const head = Buffer.alloc(12)
  head.writeUInt32LE(entries.length, 8)
  const parts: Buffer[] = [head]
  for (const entry of entries) {
    // ⚠️ 顺序是 **tag → key → value**（不是 varint 在前）。
    parts.push(Buffer.from([1]), varint(entry.key.length), entry.key, varint(entry.value.length), entry.value)
  }
  return Buffer.concat(parts)
}

/** 构造一个 Chromium localStorage 的值（`编码前缀 1B + 正文`）。 */
function lsValue(text: string, encoding: 'utf16' | 'latin1' = 'latin1'): Buffer {
  const body = encoding === 'utf16' ? Buffer.from(text, 'utf16le') : Buffer.from(text, 'latin1')
  return Buffer.concat([Buffer.from([encoding === 'utf16' ? 0 : 1]), body])
}

// ── snappy ─────────────────────────────────────────────────────────────

describe('snappy 解压', () => {
  it('literal 形式：原样还原', () => {
    const input = Buffer.from('hello magicrew', 'latin1')
    expect(uncompressSnappy(compressStub(input)).toString('latin1')).toBe('hello magicrew')
  })

  it('copy 形式必须支持**重叠**（offset < length，run-length）', () => {
    // 声明长度 10；先 literal 一个 'a'，再 copy{length=9, offset=1} ⇒ 'aaaaaaaaaa'
    const input = Buffer.concat([
      varint(10),
      Buffer.from([0]), // literal 长度 1
      Buffer.from('a', 'latin1'),
      // copy1：length = ((tag>>2)&7)+4 取 9 ⇒ (tag>>2)&7 = 5 ⇒ tag = 5<<2 | 1 = 0x15
      Buffer.from([0x15, 0x01]),
    ])
    expect(uncompressSnappy(input).toString('latin1')).toBe('aaaaaaaaaa')
  })

  it('长度不符一律抛错（宁可抛，也不返回半截数据）', () => {
    const bad = Buffer.concat([varint(10), Buffer.from([(3 - 1) << 2]), Buffer.from('abc', 'latin1')])
    expect(() => uncompressSnappy(bad)).toThrow()
  })

  it('varint 读取：单字节与多字节', () => {
    expect(readVarint(Buffer.from([0x05]), 0).value).toBe(5)
    expect(readVarint(Buffer.from([0xac, 0x02]), 0).value).toBe(300)
  })
})

// ── Chromium 值的编码前缀 ───────────────────────────────────────────────

describe('Chromium localStorage 值的编码前缀', () => {
  it('0x01 = Latin-1：解出原样文本', () => {
    const value = lsValue('{"key":"authorization","value":"eyJhbGci.eyJpc3Mi.sig"}', 'latin1')
    expect(value[0]).toBe(1)
    expect(decodeLocalStorageValue(value)).toContain('"key":"authorization"')
  })

  it('0x00 = UTF-16LE：中文字段不能变成乱码', () => {
    const value = lsValue('{"key":"userInfo","value":{"real_name":"张三"}}', 'utf16')
    expect(value[0]).toBe(0)
    const decoded = decodeLocalStorageValue(value)
    expect(decoded).toContain('"real_name":"张三"')
    // 反证：按 latin1 解会出现字符间夹 NUL 的形态
    expect(decoded).not.toContain('\u0000"')
  })

  it('前缀字节本身**不进正文**（否则精确锚点会失配）', () => {
    const decoded = decodeLocalStorageValue(lsValue('{"key":"authorization","value":"eyJ"}', 'latin1'))
    expect(decoded.startsWith('{')).toBe(true)
  })

  it('空值 ⇒ 空串（不抛）', () => {
    expect(decodeLocalStorageValue(Buffer.alloc(0))).toBe('')
  })
})

// ── SSTable(.ldb) ───────────────────────────────────────────────────────

describe('.ldb 解析：块边界与内部键后缀', () => {
  /**
   * ⚠️⚠️ 这条锁**最贵的一个 bug**：`BlockHandle.size` **不含**块尾的 5 字节
   * （类型 1B + CRC 4B）。写成 `raw[len-5]` 会让块尾的 restart 计数被读成
   * restart 数组里的偏移值（真机实测 1726976）⇒ `entriesEnd` 为负 ⇒ 整块判非法。
   *
   * 后果：**22MB 的 `.ldb` 一条记录都读不出**，只剩未压缩的 `.log` 撑着
   * （本机实测只读出 111 条）。而症状是「凭据读不到」= 用户以为没登录。
   */
  it('单块：能读出全部条目（含 5 字节块尾时不得偏移）', () => {
    const entries: BlockEntry[] = [
      { key: withSuffix('_https://www.magicrew.ai\u0000\u0001MAGIC:user:authorization'), value: lsValue('{"key":"authorization","value":"eyJx"}') },
      { key: withSuffix('_https://www.magicrew.ai\u0000\u0001MAGIC:user:organizationCode'), value: lsValue('{"key":"organizationCode","value":"org1"}') },
    ]
    const read = [...sstableEntries(buildSstable([entries]))]
    expect(read).toHaveLength(2)
    // 内部键的 8 字节后缀必须被剥掉
    expect(read[0]!.key.toString('latin1')).toBe('_https://www.magicrew.ai\u0000\u0001MAGIC:user:authorization')
    expect(read[1]!.key.toString('latin1')).toBe('_https://www.magicrew.ai\u0000\u0001MAGIC:user:organizationCode')
  })

  it('多块：跨块也要全读到（块是独立单位的，不能只读第一块）', () => {
    const blockA: BlockEntry[] = [
      { key: withSuffix('_https://a.example\u0000\u0001k1'), value: lsValue('v1') },
    ]
    const blockB: BlockEntry[] = [
      { key: withSuffix('_https://b.example\u0000\u0001k2'), value: lsValue('v2') },
    ]
    const read = [...sstableEntries(buildSstable([blockA, blockB]))]
    expect(read.map((entry) => entry.key.toString('latin1'))).toEqual([
      '_https://a.example\u0000\u0001k1',
      '_https://b.example\u0000\u0001k2',
    ])
  })

  it('压缩块：先解 snappy 再解析（真机数据就是压缩的）', () => {
    const entries: BlockEntry[] = [
      { key: withSuffix('_https://www.magicrew.ai\u0000\u0001MAGIC:user:authorization'), value: lsValue('{"key":"authorization","value":"eyJLONG"}') },
    ]
    const read = [...sstableEntries(buildSstable([entries], { compress: true }))]
    expect(read).toHaveLength(1)
    expect(decodeLocalStorageValue(read[0]!.value)).toContain('eyJLONG')
  })

  it('非 leveldb 文件（magic 不符）⇒ 空结果，不抛', () => {
    expect([...sstableEntries(Buffer.alloc(100))]).toHaveLength(0)
  })

  it('前缀压缩：共享前缀的连续键要能正确重建', () => {
    const prefix = '_https://www.magicrew.ai\u0000\u0001MAGIC:user:'
    const entries: BlockEntry[] = ['authorization', 'organizationCode', 'userInfo'].map((name) => ({
      key: withSuffix(`${prefix}${name}`),
      value: lsValue(`{"key":"${name}"}`),
    }))
    const read = [...sstableEntries(buildSstable([entries]))]
    expect(read.map((entry) => entry.key.toString('latin1'))).toEqual([
      `${prefix}authorization`,
      `${prefix}organizationCode`,
      `${prefix}userInfo`,
    ])
  })
})

// ── WAL(.log) ──────────────────────────────────────────────────────────

describe('.log（WAL）解析', () => {
  it('WriteBatch 的顺序是 tag → key → value（不是 varint 在前）', () => {
    // ⚠️ 顺序写反会让键尾粘上垃圾字节（本机实测
    //    `MAGIC:user:authorization` + 一串控制字符）⇒ 精确锚点依然匹配不上。
    const key = '_https://www.letsmagic.cn\u0000\u0001MAGIC:user:authorization'
    const read = [...walEntries(walRecord(writeBatch([
      { key: Buffer.from(key, 'latin1'), value: lsValue('{"key":"authorization","value":"eyJ0"}') },
    ])))]
    expect(read).toHaveLength(1)
    expect(read[0]!.key.toString('latin1')).toBe(key)
  })

  it('WAL 的键**不带**内部后缀（剥了反而会砍掉真键）', () => {
    const key = '_https://x\u0000\u0001k'
    const read = [...walEntries(walRecord(writeBatch([
      { key: Buffer.from(key, 'latin1'), value: lsValue('v') },
    ])))]
    expect(read[0]!.key.toString('latin1')).toBe(key)
  })

  it('跨块的记录要拼回来（用户刚登录时最新数据就在 WAL 尾部）', () => {
    const key = '_https://www.magicrew.ai\u0000\u0001MAGIC:user:authorization'
    const batch = writeBatch([{ key: Buffer.from(key, 'latin1'), value: lsValue('{"key":"authorization","value":"eyJSPLIT"}') }])
    const half = Math.floor(batch.length / 2)
    const buf = Buffer.concat([
      walRecord(batch.subarray(0, half), 2),
      walRecord(batch.subarray(half), 4),
    ])
    const read = [...walEntries(buf)]
    expect(read).toHaveLength(1)
    expect(decodeLocalStorageValue(read[0]!.value)).toContain('eyJSPLIT')
  })

  it('删除标记（tag=0）没有 value，不得把后面的字节当 value 读', () => {
    const head = Buffer.alloc(12)
    head.writeUInt32LE(1, 8)
    const key = Buffer.from('_https://x\u0000\u0001gone', 'latin1')
    const read = [...walEntries(walRecord(Buffer.concat([head, Buffer.from([0]), varint(key.length), key])))]
    expect(read).toHaveLength(1)
    expect(read[0]!.value).toHaveLength(0)
  })
})

// ── 文件级：容错 ────────────────────────────────────────────────────────

describe('leveldbEntries 文件级行为', () => {
  it('目录不存在 ⇒ 空数组（不抛：本机没装这个浏览器是常态）', () => {
    expect(leveldbEntries('definitely/not/a/real/dir/xyz')).toEqual([])
  })
})