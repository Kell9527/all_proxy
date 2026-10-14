import { describe, expect, it } from 'vitest'
import {
  SENSENOVA,
  sensenovaProductById,
  ALL_SENSENOVA_PRODUCTS,
} from '../../src/providers/sensenova-product.js'
import {
  isSensenovaCredentialUsable,
  parseSensenovaModels,
  sensenovaChatUrl,
  sensenovaModelsUrl,
  sensenovaNicknameFromKey,
  sensenovaToken,
} from '../../src/providers/sensenova.js'

/**
 * SenseNova（商汤开放平台）产品配置与协议纯函数的单测。
 *
 * 这些用例锁死「静态 API Key provider」的关键约定：字段名、key 脱敏、
 * 出图模型过滤、URL 拼装。网络行为在 `sensenova-adapter.spec.ts`。
 */
describe('SenseNova 产品配置', () => {
  it('id 与展示名固定（与前端 PROVIDERS 的 label 一致）', () => {
    expect(SENSENOVA.id).toBe('sensenova')
    expect(SENSENOVA.displayName).toBe('SenseNova (商汤)')
  })

  it('基址指向商汤开放平台的 OpenAI 兼容端点', () => {
    expect(SENSENOVA.apiBase).toBe('https://token.sensenova.cn/v1')
    expect(SENSENOVA.chatPath).toBe('/chat/completions')
    expect(SENSENOVA.modelsPath).toBe('/models')
  })

  it('默认凭据 ref 用 access_token 命名约定', () => {
    expect(SENSENOVA.defaultCredentialRef).toBe('SENSENOVA_ACCESS_TOKEN')
  })

  it('引导环境变量名固定', () => {
    expect(SENSENOVA.envVar).toBe('SENSENOVA_API_KEYS')
  })

  it('兜底目录含用户口语里的 K3（kimi-k3）且不含出图模型', () => {
    const ids = SENSENOVA.fallbackModels.map((m) => m.id)
    expect(ids).toContain('kimi-k3')
    // 出图模型不能作为 chat 目标。
    expect(ids).not.toContain('sensenova-u1.5-lite')
  })

  it('每个兜底条目都有正整数的上下文与输出上限', () => {
    for (const model of SENSENOVA.fallbackModels) {
      expect(model.contextWindow, `${model.id} 缺 contextWindow`).toBeGreaterThan(0)
      expect(model.maxTokens, `${model.id} 缺 maxTokens`).toBeGreaterThan(0)
    }
  })

  it('sensenovaProductById 命中与未命中', () => {
    expect(sensenovaProductById('sensenova')).toBe(SENSENOVA)
    expect(sensenovaProductById('nope')).toBeUndefined()
    expect(ALL_SENSENOVA_PRODUCTS).toHaveLength(1)
  })

  it('chat / models URL 拼装正确', () => {
    expect(sensenovaChatUrl(SENSENOVA)).toBe('https://token.sensenova.cn/v1/chat/completions')
    expect(sensenovaModelsUrl(SENSENOVA)).toBe('https://token.sensenova.cn/v1/models')
  })
})

describe('SenseNova 凭据纯函数', () => {
  it('sensenovaToken 优先 access_token，回退 api_key 别名', () => {
    expect(sensenovaToken({ access_token: 'sk-a' })).toBe('sk-a')
    expect(sensenovaToken({ access_token: '', api_key: 'sk-b' })).toBe('sk-b')
    expect(sensenovaToken({ access_token: '  sk-c  ' })).toBe('sk-c')
    expect(sensenovaToken(undefined)).toBe('')
    expect(sensenovaToken({ access_token: '' })).toBe('')
  })

  it('isSensenovaCredentialUsable 判定非空 key', () => {
    expect(isSensenovaCredentialUsable({ access_token: 'sk-x' })).toBe(true)
    expect(isSensenovaCredentialUsable({ access_token: '' })).toBe(false)
    expect(isSensenovaCredentialUsable(undefined)).toBe(false)
  })

  it('sensenovaNicknameFromKey 只露前 6 后 4（绝不回显完整 key）', () => {
    const key = 'sk-LzxY9bOsKmTS8egBkDeWTcDgfkHwPqda'
    const nickname = sensenovaNicknameFromKey(key)
    expect(nickname).toBe('sk-Lzx…Pqda')
    // 完整 key 绝不出现在昵称里。
    expect(nickname).not.toContain(key)
  })

  it('过短的 key 只显示原样（无法安全脱敏时不打码）', () => {
    expect(sensenovaNicknameFromKey('sk-abc')).toBe('sk-abc')
    expect(sensenovaNicknameFromKey('')).toBe('sensenova')
  })
})

describe('parseSensenovaModels', () => {
  it('解析标准 /v1/models 响应并归一字段', () => {
    const models = parseSensenovaModels({
      data: [
        {
          id: 'kimi-k3',
          name: 'kimi-k3',
          context_length: 1_048_576,
          max_output_length: 65_536,
          input_modalities: ['text'],
          output_modalities: ['text'],
        },
        {
          id: 'sensenova-6.8-flash-lite',
          context_length: 262_144,
          max_output_length: 65_536,
          input_modalities: ['text', 'image'],
          output_modalities: ['text'],
        },
      ],
    })
    expect(models.map((m) => m.id)).toEqual(['kimi-k3', 'sensenova-6.8-flash-lite'])
    expect(models[0]?.contextWindow).toBe(1_048_576)
    expect(models[0]?.maxTokens).toBe(65_536)
    expect(models[0]?.supportsImage).toBe(false)
    expect(models[1]?.supportsImage).toBe(true)
  })

  it('**过滤出图模型**（output_modalities 不含 text）', () => {
    const models = parseSensenovaModels({
      data: [
        { id: 'text-model', output_modalities: ['text'], context_length: 1000, max_output_length: 100 },
        { id: 'image-model', output_modalities: ['image'], context_length: 1000, max_output_length: 100 },
      ],
    })
    expect(models.map((m) => m.id)).toEqual(['text-model'])
  })

  it('缺 output_modalities 时保留（保守视为可对话）', () => {
    const models = parseSensenovaModels({
      data: [{ id: 'unknown', context_length: 1000, max_output_length: 100 }],
    })
    expect(models.map((m) => m.id)).toEqual(['unknown'])
  })

  it('去重并跳过无 id 条目', () => {
    const models = parseSensenovaModels({
      data: [
        { id: 'a', output_modalities: ['text'] },
        { id: 'a', output_modalities: ['text'] },
        { id: '', output_modalities: ['text'] },
      ],
    })
    expect(models.map((m) => m.id)).toEqual(['a'])
  })

  it('非法上下文/输出上限归 0（不编造）', () => {
    const models = parseSensenovaModels({
      data: [{ id: 'x', context_length: -1, max_output_length: 0, output_modalities: ['text'] }],
    })
    expect(models[0]?.contextWindow).toBe(0)
    expect(models[0]?.maxTokens).toBe(0)
  })

  it('垃圾输入返回空数组（不抛错）', () => {
    expect(parseSensenovaModels(null)).toEqual([])
    expect(parseSensenovaModels({})).toEqual([])
    expect(parseSensenovaModels({ data: 'nope' })).toEqual([])
  })
})
