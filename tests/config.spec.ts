import { describe, expect, it } from 'vitest'
import { LARK_APP_SECRET_REF, resolveRuntimeConfig, resolveSettingsConfig } from '../src/config.ts'

describe('resolveSettingsConfig', () => {
  it('allows an installed plugin to remain unconfigured', () => {
    expect(resolveSettingsConfig({})).toMatchObject({
      appId: '', appSecretRef: LARK_APP_SECRET_REF, domain: 'feishu', requireMention: true, dmMode: 'open',
      homeChatId: '', groupBatchDelayMs: 1500, silentReplyToken: 'NO_REPLY',
    })
  })

  it('applies safe conversational defaults', () => {
    expect(resolveSettingsConfig({ appId: 'id' })).toMatchObject({
      domain: 'feishu', requireMention: true, dmMode: 'open',
      errorMessage: '抱歉，处理这条消息时遇到了问题，请稍后重试。',
    })
    expect(resolveSettingsConfig({ appId: 'id' })).not.toHaveProperty('workspace')
  })

  it('preserves Lark and access-policy configuration', () => {
    expect(resolveSettingsConfig({
      appId: 'id', domain: 'lark', requireMention: false,
      dmMode: 'allowlist', groupAllowlist: ['oc_a'], dmAllowlist: ['ou_a'],
      homeChatId: 'oc_a', groupBatchDelayMs: 800, silentReplyToken: 'QUIET',
      provider: 'deepseek-official', model: 'deepseek-v4-flash', workspace: '/work', agentPreset: 'coding',
    })).toMatchObject({ domain: 'lark', dmMode: 'allowlist', groupAllowlist: ['oc_a'], dmAllowlist: ['ou_a'], homeChatId: 'oc_a', groupBatchDelayMs: 800, silentReplyToken: 'QUIET', workspace: '/work', agentPreset: 'coding' })
  })

  it('requires a POSIX credential reference', () => {
    expect(() => resolveSettingsConfig({ appSecretRef: 'not-valid-ref' })).toThrow(/appSecretRef/)
  })

  it('rejects an unbounded error response', () => {
    expect(() => resolveSettingsConfig({ appId: 'id', errorMessage: 'x'.repeat(501) })).toThrow(/errorMessage/)
  })

  it('rejects invalid ambient policy values', () => {
    expect(() => resolveSettingsConfig({ groupBatchDelayMs: -1 })).toThrow(/groupBatchDelayMs/)
    expect(() => resolveSettingsConfig({ groupBatchDelayMs: 1.5 })).toThrow(/groupBatchDelayMs/)
    expect(() => resolveSettingsConfig({ silentReplyToken: 'NO REPLY' })).toThrow(/silentReplyToken/)
  })
})

describe('resolveRuntimeConfig', () => {
  it('requires the application id and resolved secret only at activation', () => {
    const config = resolveSettingsConfig({})
    expect(() => resolveRuntimeConfig(config, 'secret')).toThrow(/appId/)
    expect(() => resolveRuntimeConfig({ ...config, appId: 'id' }, '')).toThrow(/appSecret/)
    expect(resolveRuntimeConfig({ ...config, appId: 'id' }, 'secret')).toMatchObject({ appId: 'id', appSecret: 'secret' })
  })
})
