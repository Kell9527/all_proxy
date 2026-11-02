/**
 * Snappy **raw block** 解压（leveldb 压缩块的格式）。
 *
 * ## 为什么本项目需要它
 *
 * Chromium 把 localStorage 存在 leveldb 里，而 leveldb 的 `.ldb`（SSTable）
 * **按块存储、每块可 snappy 压缩**：
 *
 * ```
 * [data block 0][type 1B][crc 4B]
 * [data block 1][type 1B][crc 4B]
 * ...
 * [metaindex block][index block][footer 48B]
 * ```
 *
 * ⚠️⚠️ 把整份文件 `toString('latin1')` 之后做正则，**只能命中「恰好落在未压缩块里、
 * 且没有被块边界切开」的短串**。而我们真正要的那条记录是
 *
 * ```
 * {"key":"authorization","value":"eyJhbGciOiJIUzI1NiIsInR5cGUiOiJKV1QifQ==.eyJpc3Mi..."}
 * ```
 *
 * —— 一个 200+ 字节的长值。它一旦落进压缩块，明文正则**必然失配**，而症状是
 * `not-found` ⇒ 面板提示「请先在浏览器里登录」—— 用户明明刚登好，被指引去重登，
 * **永远不可能成功**（2026-11-02 真机报障「MagiCrew (国际版) 我在网页登录了，
 * 为什么没识别到」的第二个根因）。
 *
 * ⇒ 唯一正确的读法是：**按 leveldb 的块结构读，遇压缩块先解压**。
 *
 * ## 格式（[snappy 官方 `format_description.txt`](https://github.com/google/snappy/blob/main/format_description.txt)）
 *
 * ```
 * <未压缩长度 varint>
 * <标签…>
 * ```
 *
 * 标签低 2 位是类型：
 *
 * | 类型 | 含义 | 后续 |
 * |---|---|---|
 * | `00` | literal | 长度在高 6 位（`< 60` 即 `n+1`；`60..63` 表示「再读 1..4 字节长度」） |
 * | `01` | copy，1 字节偏移 | 长度 = `((tag>>2)&0x07)+4`，偏移 = `((tag>>5)<<8) | next` |
 * | `10` | copy，2 字节偏移 | 长度 = `(tag>>2)+1`，偏移 = 2 字节 LE |
 * | `11` | copy，4 字节偏移 | 长度 = `(tag>>2)+1`，偏移 = 4 字节 LE |
 *
 * ⚠️ copy 的语义是「从**已解出的输出**里往回抄」——所以解压是**流式**的，
 * 必须一边写一边读自己刚写出来的字节（`out[op - offset]`）。写成「先收集再拼接」
 * 会在重叠 copy（`offset < length`，snappy 用它表示 run-length）上**解错**，
 * 而且错得很隐蔽：长度对、内容错。
 */

/** 读一个 snappy/leveldb 风格的 varint（最多 10 字节）。 */
export function readVarint(buf: Buffer, pos: number): { value: number, next: number } {
  let value = 0
  let shift = 0
  let at = pos
  for (let i = 0; i < 10; i++) {
    const byte = buf[at]
    if (byte === undefined) throw new Error(`varint 越界（pos=${pos}，len=${buf.length}）`)
    at++
    value += (byte & 0x7f) * 2 ** shift
    if ((byte & 0x80) === 0) break
    shift += 7
  }
  return { value, next: at }
}

/**
 * 解压一个 snappy raw block。
 *
 * @throws 输入不是合法 snappy、或解出的长度与声明不符（**宁可抛也不返回半截数据**：
 *         半截数据会让「凭据读不到」变成「凭据读到了一部分」，后者更难查）
 */
export function uncompressSnappy(input: Buffer): Buffer {
  const head = readVarint(input, 0)
  const expected = head.value
  const out = Buffer.alloc(expected)
  let at = head.next
  let op = 0

  while (at < input.length) {
    const tag = input[at]!
    at++
    const kind = tag & 0x03

    if (kind === 0) {
      // ── literal ──
      let length = tag >>> 2
      if (length < 60) {
        length += 1
      } else {
        const extra = length - 59 // 60 ⇒ 1 字节，61 ⇒ 2 字节 …
        let value = 0
        for (let i = 0; i < extra; i++) {
          const byte = input[at + i]
          if (byte === undefined) throw new Error('snappy literal 长度越界')
          value += byte * 2 ** (i * 8)
        }
        at += extra
        length = value + 1
      }
      if (op + length > expected) throw new Error(`snappy literal 超出声明长度（${op}+${length}>${expected}）`)
      input.copy(out, op, at, at + length)
      at += length
      op += length
      continue
    }

    // ── copy（从已解出的输出里回抄）──
    let length: number
    let offset: number
    if (kind === 1) {
      length = ((tag >>> 2) & 0x07) + 4
      const low = input[at]
      if (low === undefined) throw new Error('snappy copy1 偏移越界')
      offset = ((tag >>> 5) << 8) | low
      at += 1
    } else if (kind === 2) {
      length = (tag >>> 2) + 1
      const lo = input[at]
      const hi = input[at + 1]
      if (lo === undefined || hi === undefined) throw new Error('snappy copy2 偏移越界')
      offset = lo | (hi << 8)
      at += 2
    } else {
      length = (tag >>> 2) + 1
      const b0 = input[at]
      const b1 = input[at + 1]
      const b2 = input[at + 2]
      const b3 = input[at + 3]
      if (b0 === undefined || b1 === undefined || b2 === undefined || b3 === undefined) {
        throw new Error('snappy copy4 偏移越界')
      }
      offset = b0 | (b1 << 8) | (b2 << 16) | (b3 << 24)
      at += 4
    }
    if (offset === 0) throw new Error('snappy copy 偏移为 0（非法）')
    if (op + length > expected) throw new Error(`snappy copy 超出声明长度（${op}+${length}>${expected}）`)
    // ⚠️ 必须逐字节回抄：`offset < length` 时源区间与目标区间**重叠**，
    //    `Buffer.copy` 在重叠区间上是未定义行为（V8 实测会 memmove 成错误内容）。
    for (let i = 0; i < length; i++, op++) {
      out[op] = out[op - offset]!
    }
  }

  if (op !== expected) {
    throw new Error(`snappy 解压长度不符：声明 ${expected}，实得 ${op}`)
  }
  return out
}