/**
 * 最小 LevelDB 读取器 —— **只为读本机浏览器 localStorage 里的登录态**。
 *
 * ## ⚠️⚠️ 为什么不能「把文件读成文本再做正则」
 *
 * 这是本模块存在的**唯一理由**，也是 2026-11-02 真机报障
 * 「MagiCrew (国际版)：我在网页登录了，为什么没识别到」的第二个根因。
 *
 * Chromium 把 localStorage 写在
 *
 *     <User Data>/<Default|Profile N>/Local Storage/leveldb/
 *
 * 下，里面两种文件：
 *
 * | 文件 | 格式 | 可否当明文读 |
 * |---|---|---|
 * | `*.log` | LevelDB WAL（预写日志） | ✅ 记录体是明文，但每 32KB 有 7 字节头 |
 * | `*.ldb` | LevelDB SSTable | ❌ **数据块可 snappy 压缩**，且键是前缀压缩 |
 *
 * 旧实现把整个文件 `toString('latin1')` 后做正则。它能跑通纯属侥幸：
 * 短值（`theme`、`i18n`）恰好落在未压缩块里、且没被块边界切开。
 *
 * 而登录态是
 *
 * ```
 * {"key":"authorization","value":"eyJhbGciOiJIUzI1NiIsInR5cGUiOiJKV1QifQ==.eyJpc3Mi…"}
 * ```
 *
 * —— 一个 200+ 字节的**长值**。它一落进压缩块，明文正则**必然失配**
 * ⇒ `not-found` ⇒ 面板反过来提示「请先在浏览器里登录 xxx」。
 * 用户明明刚登完，照着提示重登也永远读不到 —— **这条缺陷不可能自愈**。
 *
 * ## SSTable 布局（[leveldb `table/format.cc`](https://github.com/google/leveldb/blob/main/table/format.cc)）
 *
 * ```
 * [data block 0][压缩类型 1B][CRC32 4B]
 * [data block 1][压缩类型 1B][CRC32 4B]
 * …
 * [filter/meta block]…
 * [metaindex block][压缩类型][CRC32]
 * [index block][压缩类型][CRC32]
 * [footer 48B]  ← 里面按序是 metaindex handle、index handle，末 8 字节是 magic
 * ```
 *
 * - **footer 恒 48 字节**，从**文件末尾**倒数，不是正数。
 * - handle = `varint(offset) + varint(size)`。
 * - 每个块的**压缩类型在块内的倒数第 5 字节**（`0` = 无压缩，`1` = snappy），
 *   其后 4 字节是 CRC。⇒ 块的有效 payload 是 `raw[0 .. len-5]`。
 * - 块内条目是**前缀压缩**的：`varint(shared) + varint(nonShared) + varint(valueLen)`
 *   \+ `key 的后半段` + `value`，键 = `上一个键的前 shared 字节 + 后半段`。
 *   ⇒ **必须顺序重建**；跳过某条就等于把后面的键全解错。
 * - 块尾：`restart 数组(uint32 × n)` + `uint32(n)`。⇒ 有效条目区
 *   止于 `len - 4 - n*4`。
 *
 * ## 本模块的纪律
 *
 * - **只读**：不写、不修、不锁。唯一副作用是 `readFileSync`。
 * - **解不开就跳过该文件**（不抛）：leveldb 可能在写入中途被拷到半截文件、
 *   或将来换版本。跳过的后果是「这个 profile 读不到」，与「用户没登录」同形，
 *   但它**不会**让整个导入崩掉 —— 而抛错会让本机导入全废。
 */

import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import { readVarint, uncompressSnappy } from './leveldb-snappy.js'

/** SSTable 的 footer 魔数（leveldb `kTableMagicNumber` 的低 8 字节）。 */
const TABLE_MAGIC = '57fb808b247547db'

/** footer 固定长度。 */
const FOOTER_LEN = 48

/** WAL 的块大小（`kBlockSize`），块头 7 字节。 */
const LOG_BLOCK_SIZE = 32768

/** 块压缩类型：`0` = 无压缩，`1` = snappy。 */
const COMPRESSION_NONE = 0
const COMPRESSION_SNAPPY = 1

export interface LeveldbEntry {
  /** 完整键（已重建前缀）。 */
  readonly key: Buffer
  /** 值（**不**做前缀压缩，原样）。 */
  readonly value: Buffer
}

/**
 * leveldb 内部键尾部固定 8 字节：`uint64(sequence << 8 | type)`。
 *
 * ⚠️⚠️ **必须剥掉，否则键名后面会粘一串垃圾字节** —— 本机实测读出来是
 *
 * ```
 * _https://www.magicrew.ai\x00\x01MAGIC:user:authorization\x01YI\x02\x00\x00\x00\x00
 *                                                        ↑↑↑↑↑↑↑↑↑↑↑↑↑↑↑↑↑↑↑↑↑↑
 *                                                        内部键后缀（seq=9845633, type=1）
 * ```
 *
 * 而 `credsNear()` 的锚点是精确串 `"key":"authorization"`、「键名以
 * `MAGIC:user:authorization` 结尾」这类判据 ⇒ 带垃圾尾巴时**依然匹配不上**，
 * 表现为「解析器读到了记录，但产品函数还是读不到凭据」—— 比完全读不到更难查。
 *
 * ⚠️ `.log`（WAL）里的键**不带**这 8 字节（WriteBatch 存的是 userKey），
 *   所以只在 `sstableEntries` 里剥，不能在 `walEntries` 里剥。
 */
const INTERNAL_KEY_SUFFIX = 8

/** Chromium localStorage 值的编码前缀（第一字节）。 */
const VALUE_ENCODING_UTF16 = 0
const VALUE_ENCODING_LATIN1 = 1

/**
 * 解码一条 Chromium localStorage 的值。
 *
 * ## ⚠️⚠️ 值的第一字节是**编码标记**，不是数据
 *
 * Chromium 存 localStorage 时给每个值加 1 字节前缀表示编码
 * （`components/services/storage/dom_storage/` 的 `KeyPrefix`）：
 *
 * | 前缀 | 编码 |
 * |---|---|
 * | `0x00` | UTF-16LE |
 * | `0x01` | Latin-1（单字节，可当 UTF-8 的 ASCII 子集读） |
 *
 * 本机实测两条**同时存在**：`MAGIC:user:userInfo` 是 `0x00`（UTF-16），
 * 而 `MAGIC:user:authorization` 是 `0x01`（Latin-1）。⇒
 * **不能写死一种编码**：写死 latin1 会让 UTF-16 的中文昵称变成乱码
 * （`{ " k e y "...`），写死 utf16 会让 JWT 变成一串汉字。
 *
 * 丢掉那个前缀字节同样致命：UTF-16 被整体错位一字节 ⇒ 全部字符错半字节。
 */
export function decodeLocalStorageValue(value: Buffer): string {
  if (value.length === 0) return ''
  const encoding = value[0]
  const body = value.subarray(1)
  if (encoding === VALUE_ENCODING_UTF16) return body.toString('utf16le')
  if (encoding === VALUE_ENCODING_LATIN1) return body.toString('latin1')
  // 未知前缀：**不猜**，原样 latin1（至少不会把 ASCII 部分弄错）。
  return value.toString('latin1')
}

/** 一个块 handle。 */
interface BlockHandle {
  readonly offset: number
  readonly size: number
}

/** 读 footer 里的一个 handle。 */
function readHandle(buf: Buffer, pos: number): { handle: BlockHandle, next: number } {
  const offset = readVarint(buf, pos)
  const size = readVarint(buf, offset.next)
  return { handle: { offset: offset.value, size: size.value }, next: size.next }
}

/**
 * 读一个块并**按需解压**。
 *
 * ⚠️ 压缩类型取 `raw[len-5]`（不是 `raw[len-1]`）：块尾是
 * `[payload][类型 1B][CRC32 4B]`，`raw[len-1]` 是 CRC 的最后一个字节。
 * 读错这一格会让**未压缩块**被当 snappy 解（得到乱码），或反之（得到压缩字节），
 * 两种都表现为「键名读不到」而**不报错**。
 */
function readBlock(buf: Buffer, handle: BlockHandle): Buffer {
  if (handle.offset < 0 || handle.size < 4 || handle.offset + handle.size + 5 > buf.length) {
    throw new Error(`块 handle 越界（offset=${handle.offset} size=${handle.size} len=${buf.length}）`)
  }
  /**
   * ⚠️⚠️ **`BlockHandle.size` 不含块尾那 5 字节**（leveldb `table/format.cc`
   * 的 `ReadBlock`：先 `ReadHandle` 拿 `(offset, size)`，读 `size` 字节数据，
   * **再**读 1 字节类型 + 4 字节 CRC）。
   *
   * ⇒ payload 就是 `buf[offset .. offset+size)`，而**类型字节在 `buf[offset+size]`**
   * （块外）。写成 `raw[len-5]`（块内倒数第 5 字节）会少切 5 字节，
   * 于是块尾的 `restart` 计数被读成 restart 数组里的一个偏移值
   * ⇒ `entriesEnd` 变负数 ⇒ 整块判非法 ⇒ **22MB 的 `.ldb` 一条都读不出**，
   * 只剩 `.log` 里的新记录撑着（本机实测：111 条 / 22MB）。
   *
   * 这个 bug 的症状是「记录数远少于应有」，**且完全静默**（每块都抛 → 每文件跳过）。
   */
  const payload = buf.subarray(handle.offset, handle.offset + handle.size)
  const type = buf[handle.offset + handle.size]
  if (type === COMPRESSION_NONE) return payload
  if (type === COMPRESSION_SNAPPY) return uncompressSnappy(payload)
  throw new Error(`未知的块压缩类型 ${String(type)}`)
}

/**
 * 枚举一个块里的全部 (key, value)，**顺序重建前缀压缩**。
 *
 * @param block 已解压的块 payload（**不含**类型与 CRC 尾）
 */
function* blockEntries(block: Buffer): Generator<LeveldbEntry> {
  if (block.length < 8) return // 至少要有 restart 数组 + 计数
  /**
   * 块尾布局：`[entries…][restart0 u32]…[restartN-1 u32][N u32]`。
   *
   * ⚠️ 这里传进来的 `block` 必须是**已剥掉块尾 5 字节**（类型 + CRC）的 payload
   * —— 见 {@link readBlock}。剥错一档会让 `N` 被读成某个 restart 偏移值
   * （本机实测 `1726976`）⇒ `entriesEnd` 为负 ⇒ 整块判非法 ⇒ 静默跳过。
   */
  const numRestarts = block.readUInt32LE(block.length - 4)
  const entriesEnd = block.length - 4 - numRestarts * 4
  // ⚠️ `numRestarts` 是文件里的内容，**不可信**：损坏的文件能算出负的 `entriesEnd`
  //    ⇒ 整个块跳过（抛给调用方按「跳过该文件」处理），不要带着负边界继续读。
  if (entriesEnd < 0) throw new Error(`restart 数非法（${numRestarts}）`)

  let at = 0
  let lastKey = Buffer.alloc(0)
  while (at < entriesEnd) {
    const shared = readVarint(block, at)
    const nonShared = readVarint(block, shared.next)
    const valueLen = readVarint(block, nonShared.next)
    at = valueLen.next
    if (shared.value > lastKey.length) {
      throw new Error(`前缀共享长度越界（shared=${shared.value} lastKey=${lastKey.length}）`)
    }
    if (at + nonShared.value + valueLen.value > entriesEnd) {
      throw new Error('条目越过块尾')
    }
    const key = Buffer.concat([
      lastKey.subarray(0, shared.value),
      block.subarray(at, at + nonShared.value),
    ])
    at += nonShared.value
    const value = block.subarray(at, at + valueLen.value)
    at += valueLen.value
    lastKey = key
    yield { key, value }
  }
}

/**
 * 枚举 SSTable（`*.ldb`）的全部 (key, value)。
 *
 * 顺序：**跨块按 index 给出的顺序**（leveldb 键本身有序，故这就是键序）。
 *
 * @throws footer/魔数/块结构任一不合法 ⇒ 调用方应「跳过该文件」
 */
export function* sstableEntries(buf: Buffer): Generator<LeveldbEntry> {
  if (buf.length < FOOTER_LEN + 8) return
  if (buf.subarray(buf.length - 8).toString('hex') !== TABLE_MAGIC) return
  const footerAt = buf.length - FOOTER_LEN
  const meta = readHandle(buf, footerAt)
  const index = readHandle(buf, meta.next)
  const indexBlock = readBlock(buf, index.handle)
  for (const entry of blockEntries(indexBlock)) {
    // index 的值是一个 handle（指向对应数据块）。
    const dataHandle = readHandle(entry.value, 0).handle
    const dataBlock = readBlock(buf, dataHandle)
    for (const kv of blockEntries(dataBlock)) {
      // ⚠️ 剥掉内部键后缀（见 `INTERNAL_KEY_SUFFIX`）。
      const key = kv.key.length > INTERNAL_KEY_SUFFIX
        ? kv.key.subarray(0, kv.key.length - INTERNAL_KEY_SUFFIX)
        : kv.key
      yield { key, value: kv.value }
    }
  }
}

/**
 * 枚举 WAL（`*.log`）里的全部 (key, value)。
 *
 * WAL 记录体 = `WriteBatch`：`uint64 序号 + uint32 计数`，随后逐条
 * `type 1B(1=put,0=delete) + varint(keyLen) + key + varint(valueLen) + value`。
 *
 * ⚠️ 记录体本身可能被切成 `First/Middle/Last` 三段（跨 32KB 块边界），
 * 必须先拼回一整条再解 `WriteBatch` —— 直接按「每条记录一个 batch」读会在
 * 边界处丢条目，而那正是**用户刚登录、数据还没刷进 `.ldb`** 的时刻
 * （浏览器开着时 `.log` 才是最新的那份）。
 */
export function* walEntries(buf: Buffer): Generator<LeveldbEntry> {
  const batches = walBatches(buf)
  for (const batch of batches) {
    if (batch.length < 12) continue
    const count = batch.readUInt32LE(8)
    let at = 12
    for (let i = 0; i < count; i++) {
      if (at >= batch.length) break
      /**
       * ⚠️⚠️ **WriteBatch 的条目里没有「type」字节**（这里曾是第二个真 bug）。
       *
       * `leveldb/db/write_batch.cc` 的 `WriteBatchInternal::Iterate`：
       *
       * ```
       * if (tag == kTypeDeletion) { GetVarint32LengthPrefixed(key); handler->Deleted(key); }
       * else if (tag == kTypeValue) { GetVarint32LengthPrefixed(key);
       *                               GetVarint32LengthPrefixed(value); handler->Put(key, value); }
       * ```
       *
       * ⇒ 条目 = `tag 1B + varint(keyLen) + key + [varint(valueLen) + value]`，
       * 也就是**先 tag、再 key、再 value**，而不是「先两个 varint 再 tag」。
       *
       * ⚠️ 首版把 `varint(keyLen)` 读成了 tag、把 tag 读成了 keyLen ⇒ 键名尾部
       * 粘连若干垃圾字节（`MAGIC:user:authorization\u0001YI\u0000\u0000\u0000\u0000`），
       * 于是 `credsNear` 的精确锚点 `"key":"authorization"` 仍然匹配不上 ——
       * **看起来"读到了"但实际还是没用**，比读不到更难查。
       */
      const tag = batch[at]
      at += 1
      const keyLen = readVarint(batch, at)
      at = keyLen.next
      const key = batch.subarray(at, at + keyLen.value)
      at += keyLen.value
      if (tag === 0) {
        // kTypeDeletion：没有 value
        yield { key, value: Buffer.alloc(0) }
        continue
      }
      if (tag !== 1) break // 未知 tag ⇒ 本条到此为止（不猜）
      const valueLen = readVarint(batch, at)
      at = valueLen.next
      const value = batch.subarray(at, at + valueLen.value)
      at += valueLen.value
      yield { key, value }
    }
  }
}

/** 把 WAL 的物理记录拼回完整 `WriteBatch`。 */
function walBatches(buf: Buffer): Buffer[] {
  const out: Buffer[] = []
  let at = 0
  let acc: Buffer | undefined
  while (at + 7 <= buf.length) {
    const inBlock = at % LOG_BLOCK_SIZE
    // 块尾不足 7 字节 ⇒ 补零，跳到下一块。
    if (LOG_BLOCK_SIZE - inBlock < 7) {
      at += LOG_BLOCK_SIZE - inBlock
      continue
    }
    const length = buf.readUInt16LE(at + 4)
    const type = buf[at + 6]
    const payload = buf.subarray(at + 7, at + 7 + length)
    at += 7 + length
    if (type === 1) {
      // FULL
      out.push(payload)
      acc = undefined
    } else if (type === 2) {
      // FIRST
      acc = Buffer.from(payload)
    } else if (type === 3 && acc !== undefined) {
      // MIDDLE
      acc = Buffer.concat([acc, payload])
    } else if (type === 4 && acc !== undefined) {
      // LAST
      out.push(Buffer.concat([acc, payload]))
      acc = undefined
    }
    // type 0（清零区）/ 未知 ⇒ 忽略，等下一个记录
  }
  return out
}

/**
 * 一个 profile 目录的 leveldb 全部条目。
 *
 * ⚠️ 顺序取 `readdirSync` 的**文件名字典序**（`.ldb` 与 `.log` 混在一起）：
 * 同一个键在 `.log`（新）与 `.ldb`（旧）里各有一份，后者是**过期值**。
 * 我们要的是「最新值」，而文件名里 `.log` 的编号恒大于已 compact 的 `.ldb`
 * ⇒ 字典序恰好把新的排在后面。**不能按修改时间排序**（compact 会重写旧文件）。
 */
export function leveldbEntries(dir: string): LeveldbEntry[] {
  let files: string[]
  try {
    files = readdirSync(dir).sort()
  } catch {
    return []
  }
  const out: LeveldbEntry[] = []
  for (const file of files) {
    if (!file.endsWith('.ldb') && !file.endsWith('.log')) continue
    let buf: Buffer
    try {
      buf = readFileSync(join(dir, file))
    } catch {
      // ⚠️ 浏览器正在写时文件可能被独占（Windows 下实测 EBUSY）。
      //    **跳过而不是抛**：还有别的文件可读，且用户可能就开着浏览器登录。
      continue
    }
    try {
      const entries = file.endsWith('.ldb') ? sstableEntries(buf) : walEntries(buf)
      for (const entry of entries) out.push(entry)
    } catch {
      // 单个文件结构异常（半截、版本不同）⇒ 跳过它，其余照读。
      continue
    }
  }
  return out
}

/**
 * 一个 profile 目录的 leveldb **文本视图**。
 *
 * 每条记录拼成 `<key><解码后的值>`，而键本身就是 Chromium 的
 * localStorage 键形态 `_https://www.magicrew.ai MAGIC:user:authorization`
 * ⇒ 拼接后恰好是 `credsNear()` 期望的锚点形状，**不必改配对逻辑**，
 * 只把「取文本」这一步从「整文件 latin1 正则扫」换成「结构化读取 + 解码」。
 *
 * ⚠️⚠️ **值必须走 {@link decodeLocalStorageValue}**，不能直接 `toString('latin1')`：
 * 那会把 UTF-16 的 `userInfo` 解成 `{ " k e y " …`（字符间夹 NUL），
 * 也会把值首字节的**编码标记**留在正文里 —— 于是 `"value":"eyJ…"` 的取值
 * 因夹字符而失配（本机实测：解析器读到了记录，产品函数却仍读不到凭据）。
 */
export function leveldbText(dir: string): string {
  const parts: string[] = []
  for (const entry of leveldbEntries(dir)) {
    parts.push(entry.key.toString('latin1'), '', decodeLocalStorageValue(entry.value), '')
  }
  return parts.join('')
}
