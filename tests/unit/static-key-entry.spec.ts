import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { AccountPool } from '../../src/pool/account-pool.js'
import { FileCredentialStore } from '../../src/pool/store.js'
import { createAdminHandler } from '../../src/admin/router.js'
import { AdminAuth } from '../../src/admin/auth.js'
import { ApiKeyStore } from '../../src/auth/api-keys.js'
import { ProviderRegistry } from '../../src/providers/registry.js'
import { registerAllProviders } from '../../src/providers/wiring.js'
import { sensenovaNicknameFromKey } from '../../src/providers/sensenova.js'
import {
  emptyAccountsHint,
  newAccountButtonLabel,
  newAccountButtonTitle,
  newAccountBusyLabel,
  normalizeApiKeyInput,
  staticKeyDialogTitle,
  staticKeyFieldHint,
  staticKeyNicknameHint,
  staticKeyVerifyHint,
} from '../../plugin-src/client/static-key-entry.js'

/**
 * SenseNova（静态 API Key provider）的建号入口。
 *
 * ## 为什么这个文件存在（用户 2026-10-15 报障）
 *
 * 「SenseNova 点新建账号提示：provider sensenova 不支持链接式登录」——
 * 后端能力一直齐全（`POST /api/accounts` + `account.addKey` + `supportsStaticKey`），
 * **缺的只是面板里的入口**：按钮只有链接式登录一条路，点下去必然被
 * orchestrator 拒绝。本文件锁死三件事：
 *   1. 入口的文案与输入归一（纯函数）；
 *   2. 面板真的把这些函数接上了（源码级断言，防再被改回硬编码）；
 *   3. 后端端点按约定收 key（成功不回显、非法 provider 拒绝、凭据字段名对）。
 */

const logger = { info: () => {}, warn: () => {}, error: () => {} }
const HERE = dirname(fileURLToPath(import.meta.url))
const hubSource = readFileSync(resolve(HERE, '../../plugin-src/client/jet-hub.js'), 'utf8')
const bridgeSource = readFileSync(resolve(HERE, '../../web/src/rpc-bridge.js'), 'utf8')
const routerSource = readFileSync(resolve(HERE, '../../src/admin/router.ts'), 'utf8')

describe('静态 API Key 建号入口的文案', () => {
  it('SenseNova 的按钮文案点明「粘贴 API Key」（不是笼统的新建账号）', () => {
    expect(newAccountButtonLabel('sensenova')).toBe('+ 新建账号 (粘贴 API Key)')
  })

  it('其余 provider 保持原文案（不因为这次修改改变既有入口）', () => {
    for (const provider of ['codearts', 'officeace', 'accio', 'loomy', 'raccoon']) {
      expect(newAccountButtonLabel(provider)).toBe('+ 新建账号')
    }
  })

  it('按钮提示讲清「没有浏览器登录」与「可多次添加」', () => {
    const title = newAccountButtonTitle('sensenova')
    expect(title).toContain('没有浏览器登录')
    expect(title).toContain('sk-...')
    expect(title).toContain('多把 key')
  })

  it('非静态 key provider 没有专属提示（由调用方 fallback 到既有文案）', () => {
    expect(newAccountButtonTitle('codearts')).toBe('')
    expect(newAccountButtonTitle('officeace')).toBe('')
  })

  it('空态提示按 provider 分叉：静态 key 说粘贴，其余说浏览器登录', () => {
    expect(emptyAccountsHint('sensenova')).toContain('粘贴 API Key')
    expect(emptyAccountsHint('codearts')).toBe('')
  })

  it('弹窗标题与字段说明覆盖 key 与昵称两项', () => {
    expect(staticKeyDialogTitle('sensenova')).toBe('添加 sensenova 账号（粘贴 API Key）')
    expect(staticKeyFieldHint()).toContain('sk-...')
    expect(staticKeyNicknameHint()).toContain('留空')
  })

  it('验证提示讲清「建号不校验」与验证手段（401 不至于变成无头案）', () => {
    expect(staticKeyVerifyHint()).toContain('不会校验')
    expect(staticKeyVerifyHint()).toContain('401')
    expect(staticKeyVerifyHint()).toContain('重测')
  })
})

describe('newAccountBusyLabel', () => {
  it('三态：登录中 / 添加 key 中 / 平时的入口文案', () => {
    expect(newAccountBusyLabel('sensenova', { creating: true, addingKey: false })).toBe('正在登录…')
    expect(newAccountBusyLabel('sensenova', { creating: false, addingKey: true })).toBe('正在添加…')
    expect(newAccountBusyLabel('sensenova', { creating: false, addingKey: false }))
      .toBe('+ 新建账号 (粘贴 API Key)')
  })

  it('登录态 provider 的常态文案不变', () => {
    expect(newAccountBusyLabel('codearts', { creating: false, addingKey: false })).toBe('+ 新建账号')
  })
})

describe('normalizeApiKeyInput', () => {
  it('剥掉复制时带上首尾空白', () => {
    expect(normalizeApiKeyInput('  sk-abc  ')).toEqual({ ok: true, apiKey: 'sk-abc' })
  })

  it('剥掉内部换行/制表符（多行复制最常见的污染）', () => {
    expect(normalizeApiKeyInput('sk-a\nbc\tdef')).toEqual({ ok: true, apiKey: 'sk-abcdef' })
  })

  it('空输入给出可读原因（而不是静默提交一个空 key）', () => {
    expect(normalizeApiKeyInput('   \n  ')).toEqual({
      ok: false,
      message: '请先粘贴 API Key（形如 sk-...）',
    })
  })

  it('非字符串输入不炸（防御面板传进 undefined）', () => {
    expect(normalizeApiKeyInput(undefined).ok).toBe(false)
  })

  it('不去改动 key 内部的有效字符（只动空白）', () => {
    const key = 'sk-0a1B2c3D4e5F6g7H8i9J0kLmNoPqRsTuVwXyZ-_'
    expect(normalizeApiKeyInput(key)).toEqual({ ok: true, apiKey: key })
  })
})

// ───────────────────────── 面板接线（源码级断言） ─────────────────────────

describe('面板接线（源码级断言）', () => {
  it('面板 import 了静态 key 入口函数', () => {
    expect(hubSource).toContain("from './static-key-entry.js'")
    expect(hubSource).toContain('newAccountButtonLabel')
    expect(hubSource).toContain('normalizeApiKeyInput')
  })

  it('「+ 新建账号」的点击按 provider 分叉（静态 key 开弹窗，不走登录）', () => {
    expect(hubSource).toContain("if (supportsStaticKey(provider)) setAskApiKey(true);")
    // 分叉必须**先于** Accio 区域预选与 createAccount，否则 sensenova 仍会
    // 掉进登录路径（这正是用户报障的那条路）。
    const branch = hubSource.indexOf("if (supportsStaticKey(provider)) setAskApiKey(true);")
    const loginBranch = hubSource.indexOf("else if (provider === 'accio') setAskAccioRegion(true);")
    expect(branch).toBeGreaterThan(-1)
    expect(loginBranch).toBeGreaterThan(branch)
  })

  it('按钮标签不再硬编码（否则静态 key 的入口永远出不来）', () => {
    expect(hubSource).toContain('newAccountBusyLabel(provider, { creating, addingKey })')
    // 原文案是 `: '+ 新建账号'))),`（三个右括号收 button/按钮组/面板头）；
    // 现在第三参数是函数调用，括号数变了，但**不能**退化成任何写死的字面量。
    expect(hubSource).not.toMatch(/: '\+ 新建账号'\)\)\)/)
  })

  it('粘贴提交走 account.addKey（不是 account.create）', () => {
    expect(hubSource).toContain("rpcCall('account.addKey'")
    expect(bridgeSource).toContain("case 'account.addKey': {")
    expect(bridgeSource).toContain("post('/api/accounts'")
  })

  it('空态提示使用纯函数（不保留写死的浏览器登录文案作为唯一分支）', () => {
    expect(hubSource).toContain('emptyAccountsHint(provider)')
  })

  it('弹窗渲染了 key/昵称输入、错误位与验证提示', () => {
    expect(hubSource).toContain('staticKeyFieldHint()')
    expect(hubSource).toContain('staticKeyNicknameHint()')
    expect(hubSource).toContain('staticKeyVerifyHint()')
    expect(hubSource).toContain("type: 'password'")
    expect(hubSource).toContain("role: 'dialog'")
  })

  it('后端静态 key 名单仍只有 sensenova（与 supportsStaticKey 一致）', () => {
    expect(routerSource).toContain("new Set(['sensenova'])")
  })
})

// ───────────────────────── 后端端点（POST /api/accounts） ─────────────────────────

describe('POST /api/accounts 建号', () => {
  let dir: string
  let secret: string
  let pool: AccountPool
  let credentials: FileCredentialStore

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'all-proxy-static-key-'))
    credentials = new FileCredentialStore(dir)
    pool = new AccountPool({ credentials, dataDir: dir })
    const auth = new AdminAuth(dir, logger)
    auth.ensure(undefined, { minSecretLength: 4 })
    secret = process.env['ALL_PROXY_ADMIN_SECRET']?.trim() || auth.generatedSecret() || ''
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  /** 直接调 handler（不起真实服务器）：只需要 headers 与 writeHead/end。 */
  async function postAccounts(
    payload: Record<string, unknown>,
  ): Promise<{ status: number; body: string }> {
    const registry = new ProviderRegistry()
    registerAllProviders(registry, {
      pool,
      credentials,
      logger,
      resolveCredential: async () => undefined,
      refresh: async () => {},
      readImage: async () => { throw new Error('本项目暂无附件服务') },
    })
    const handler = createAdminHandler({
      registry,
      pool,
      credentials,
      apiKeys: new ApiKeyStore(dir),
      auth: new AdminAuth(dir, logger),
      logger,
    })
    const body = JSON.stringify(payload)
    const req = {
      method: 'POST',
      headers: { 'x-admin-secret': secret, 'content-type': 'application/json' },
      [Symbol.asyncIterator]: async function* () { yield Buffer.from(body) },
    } as unknown as IncomingMessage
    let status = 0
    let out = ''
    const res = {
      writeHead(code: number) { status = code },
      end(payload: string) { out = payload },
    } as unknown as ServerResponse
    const handled = await handler(req, res, new URL('http://127.0.0.1/api/accounts'))
    expect(handled).toBe(true)
    return { status, body: out }
  }

  it('粘贴 key 即建号：凭据落盘、账号入池、refreshable=false', async () => {
    const key = 'sk-test-0123456789abcdef'
    const { status, body } = await postAccounts({ provider: 'sensenova', apiKey: key })
    expect(status).toBe(200)
    const parsed = JSON.parse(body) as { ok: boolean; account: { id: string; provider: string; nickname: string } }
    expect(parsed.ok).toBe(true)
    expect(parsed.account.provider).toBe('sensenova')

    // ⚠️ 响应体**绝不回显 key 明文**（管理端可能被截图/投屏）。
    expect(body).not.toContain(key)

    const listed = await pool.listAccounts('sensenova')
    expect(listed).toHaveLength(1)
    expect(listed[0]!.refreshable).toBe(false)
    expect(listed[0]!.enabled).toBe(true)

    const stored = await credentials.resolve(listed[0]!.credentialRef)
    // 字段名必须是 access_token（findAccountIdByCredential 的约定）。
    expect(JSON.parse(stored!.value)).toEqual({ access_token: key })
  })

  it('昵称留空时按 key 生成脱敏昵称（便于区分多把 key）', async () => {
    const key = 'sk-test-0123456789abcdef'
    const { body } = await postAccounts({ provider: 'sensenova', apiKey: key })
    const parsed = JSON.parse(body) as { account: { nickname: string } }
    expect(parsed.account.nickname).toBe(sensenovaNicknameFromKey(key))
    // 脱敏昵称本身不含完整 key。
    expect(parsed.account.nickname).not.toBe(key)
  })

  it('显式昵称优先于自动生成', async () => {
    const { body } = await postAccounts({
      provider: 'sensenova', apiKey: 'sk-test-0123456789abcdef', nickname: '商汤主力',
    })
    const parsed = JSON.parse(body) as { account: { nickname: string } }
    expect(parsed.account.nickname).toBe('商汤主力')
  })

  it('key 前后空白被剥掉（复制带换线也不会建出一个坏账号）', async () => {
    const { status } = await postAccounts({ provider: 'sensenova', apiKey: '  sk-x\n ' })
    expect(status).toBe(200)
    const listed = await pool.listAccounts('sensenova')
    const stored = await credentials.resolve(listed[0]!.credentialRef)
    expect(JSON.parse(stored!.value)).toEqual({ access_token: 'sk-x' })
  })

  it('缺少 apiKey 时拒绝（不建空凭据账号）', async () => {
    const { status, body } = await postAccounts({ provider: 'sensenova' })
    expect(status).toBe(400)
    expect(body).toContain('缺少 apiKey')
    expect(await pool.listAccounts('sensenova')).toHaveLength(0)
  })

  it('登录态 provider 一律拒绝（不把它们的凭据变成可手填）', async () => {
    const { status, body } = await postAccounts({ provider: 'codearts', apiKey: 'sk-x' })
    expect(status).toBe(400)
    expect(body).toContain('不支持粘贴 API Key 建号')
    expect(await pool.listAccounts('codearts')).toHaveLength(0)
  })

  it('未知 provider 拒绝（名单先判，消息点明当前只支持谁）', async () => {
    const { status, body } = await postAccounts({ provider: 'not-a-provider', apiKey: 'sk-x' })
    expect(status).toBe(400)
    expect(body).toContain('不支持粘贴 API Key 建号')
    expect(body).toContain('sensenova')
    expect(await pool.listAllAccounts()).toHaveLength(0)
  })
})
