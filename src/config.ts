import z from '@deepseek-ai/schemastery'

export type DomainName = 'feishu' | 'lark'
export type DirectMessageMode = 'open' | 'allowlist' | 'disabled'

export const LARK_APP_SECRET_REF = 'DSH_LARK_APP_SECRET'
export const HULY_EVENTS_SECRET_REF = 'DSH_HULY_EVENTS_SHARED_SECRET'
export const LARK_SETTINGS_NAMESPACE = 'lark-channel'
const DEFAULT_ERROR_MESSAGE = '抱歉，处理这条消息时遇到了问题，请稍后重试。'
export const DEFAULT_GROUP_BATCH_DELAY_MS = 1500
export const DEFAULT_SILENT_REPLY_TOKEN = 'NO_REPLY'
const CREDENTIAL_REF_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/u

export interface Config {
  appId?: string
  /** @deprecated Use appSecretRef with the Harness credentials service. */
  appSecret?: string
  appSecretRef?: string
  domain?: DomainName
  requireMention?: boolean
  dmMode?: DirectMessageMode
  groupAllowlist?: string[]
  dmAllowlist?: string[]
  homeChatId?: string
  groupBatchDelayMs?: number
  silentReplyToken?: string
  provider?: string
  model?: string
  workspace?: string
  agentPreset?: string
  errorMessage?: string
  hulyEventsUrl?: string
  hulyEventsSecretRef?: string
  identityMapFile?: string
  adminOpenId?: string
  fallbackChatId?: string
}

export interface SettingsConfig extends Required<Pick<Config,
  'appId' | 'appSecretRef' | 'domain' | 'requireMention' | 'dmMode' | 'groupAllowlist' |
  'dmAllowlist' | 'homeChatId' | 'groupBatchDelayMs' | 'silentReplyToken' | 'errorMessage' |
  'hulyEventsUrl' | 'hulyEventsSecretRef' | 'identityMapFile' | 'adminOpenId' | 'fallbackChatId'>> {
  appSecret?: string
  provider?: string
  model?: string
  workspace?: string
  agentPreset?: string
}

export interface RuntimeConfig extends Omit<SettingsConfig, 'appSecretRef' | 'hulyEventsSecretRef'> {
  appSecret: string
  appSecretRef: string
  hulyEventsSecret: string
  hulyEventsSecretRef: string
}

export const ConfigSchema: z<Config> = z.object({
  appId: z.string().default('').description('Feishu/Lark application ID'),
  appSecret: z.string().role('secret').description('Legacy literal application secret'),
  appSecretRef: z.string().role('credential-ref').default(LARK_APP_SECRET_REF).description('Harness credential reference for the application secret'),
  domain: z.union(['feishu', 'lark']).default('feishu'),
  requireMention: z.boolean().default(true),
  dmMode: z.union(['open', 'allowlist', 'disabled']).default('open'),
  groupAllowlist: z.array(z.string()).default([]),
  dmAllowlist: z.array(z.string()).default([]),
  homeChatId: z.string().default(''),
  groupBatchDelayMs: z.number().step(1).min(0).max(30_000).default(DEFAULT_GROUP_BATCH_DELAY_MS),
  silentReplyToken: z.string().default(DEFAULT_SILENT_REPLY_TOKEN),
  provider: z.string(),
  model: z.string(),
  workspace: z.string(),
  agentPreset: z.string(),
  errorMessage: z.string().default(DEFAULT_ERROR_MESSAGE),
  hulyEventsUrl: z.string().default(''),
  hulyEventsSecretRef: z.string().role('credential-ref').default(HULY_EVENTS_SECRET_REF),
  identityMapFile: z.string().default(''),
  adminOpenId: z.string().default(''),
  fallbackChatId: z.string().default(''),
})

export function resolveSettingsConfig(config: Config): SettingsConfig {
  const appSecretRef = config.appSecretRef ?? LARK_APP_SECRET_REF
  if (!CREDENTIAL_REF_PATTERN.test(appSecretRef)) throw new TypeError('appSecretRef must be a POSIX environment variable name')
  const hulyEventsSecretRef = config.hulyEventsSecretRef ?? HULY_EVENTS_SECRET_REF
  if (!CREDENTIAL_REF_PATTERN.test(hulyEventsSecretRef)) throw new TypeError('hulyEventsSecretRef must be a POSIX environment variable name')
  const errorMessage = config.errorMessage ?? DEFAULT_ERROR_MESSAGE
  if (errorMessage.length > 500) throw new TypeError('errorMessage must not exceed 500 characters')
  const groupBatchDelayMs = config.groupBatchDelayMs ?? DEFAULT_GROUP_BATCH_DELAY_MS
  if (!Number.isSafeInteger(groupBatchDelayMs) || groupBatchDelayMs < 0 || groupBatchDelayMs > 30_000) {
    throw new TypeError('groupBatchDelayMs must be an integer between 0 and 30000')
  }
  const silentReplyToken = (config.silentReplyToken ?? DEFAULT_SILENT_REPLY_TOKEN).trim()
  if (silentReplyToken === '' || silentReplyToken.length > 64 || /\s/u.test(silentReplyToken)) {
    throw new TypeError('silentReplyToken must be 1-64 non-whitespace characters')
  }
  return {
    appId: config.appId ?? '',
    appSecretRef,
    domain: config.domain ?? 'feishu',
    requireMention: config.requireMention ?? true,
    dmMode: config.dmMode ?? 'open',
    groupAllowlist: config.groupAllowlist ?? [],
    dmAllowlist: config.dmAllowlist ?? [],
    homeChatId: config.homeChatId?.trim() ?? '',
    groupBatchDelayMs,
    silentReplyToken,
    errorMessage,
    hulyEventsUrl: config.hulyEventsUrl?.trim() ?? '',
    hulyEventsSecretRef,
    identityMapFile: config.identityMapFile?.trim() ?? '',
    adminOpenId: config.adminOpenId?.trim() ?? '',
    fallbackChatId: config.fallbackChatId?.trim() ?? '',
    ...(config.appSecret === undefined ? {} : { appSecret: config.appSecret }),
    ...(config.provider === undefined ? {} : { provider: config.provider }),
    ...(config.model === undefined ? {} : { model: config.model }),
    ...(config.workspace === undefined ? {} : { workspace: config.workspace }),
    ...(config.agentPreset === undefined ? {} : { agentPreset: config.agentPreset }),
  }
}

export function resolveRuntimeConfig(config: SettingsConfig, resolvedSecret?: string, resolvedHulyEventsSecret?: string): RuntimeConfig {
  if (config.appId.trim() === '') throw new TypeError('appId is required')
  const appSecret = resolvedSecret?.trim() || config.appSecret?.trim() || ''
  if (appSecret === '') throw new TypeError('appSecret is required')
  const hulyEventsSecret = resolvedHulyEventsSecret?.trim() || ''
  if (config.hulyEventsUrl !== '' && hulyEventsSecret === '') throw new TypeError('hulyEventsSecret is required when hulyEventsUrl is configured')
  return { ...config, appSecret, hulyEventsSecret }
}

/** @deprecated Use resolveSettingsConfig and resolveRuntimeConfig. */
export function resolveConfig(config: Config): RuntimeConfig {
  const settings = resolveSettingsConfig(config)
  return resolveRuntimeConfig(settings, settings.appSecret)
}
