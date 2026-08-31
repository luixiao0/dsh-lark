import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-agent-default-model'
import type {} from '@deepseek-ai/dsh-agent-presets'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { settingsNamespace } from '@deepseek-ai/dsh-settings'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type {} from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-session-persistence'
import type {} from '@deepseek-ai/dsh-workspace'
import { createLarkChannel } from '@larksuiteoapi/node-sdk'
import { ConfigSchema, LARK_SETTINGS_NAMESPACE, resolveSettingsConfig } from './config.ts'
import type { Config as PluginConfig, SettingsConfig } from './config.ts'
import { HarnessConversationService } from './harness.ts'
import { startChannel } from './channel.ts'
import type { OutboundMessage } from './channel.ts'
import { PersistentMessageInbox } from './inbox.ts'
import { IdentityMap } from './huly-events.ts'
import { LarkRuntime } from './runtime.ts'
import { createSettingsApi } from './settings-api.ts'
import { handleSettingsRequest, SETTINGS_PATH } from './web.ts'

export interface LarkDeliveryService {
  send(message: OutboundMessage): ReturnType<LarkRuntime['send']>
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    larkDelivery: LarkDeliveryService
  }
}

export const name = 'lark-channel'
export const inject = [
  'agents', 'sessions', 'sessionPersistence', 'agentDefaultModel', 'agentPresets', 'workspaceRegistry',
  'settings', 'credentials', 'webServer', 'timer', 'tools',
]
export const Config = ConfigSchema
export type { PluginConfig }
export { ConfigSchema } from './config.ts'

export async function apply(ctx: Context, rawConfig: PluginConfig): Promise<void> {
  const agents = ctx.get('agents')
  const sessions = ctx.get('sessions')
  const sessionPersistence = ctx.get('sessionPersistence')
  const defaultModel = ctx.get('agentDefaultModel')
  const agentPresets = ctx.get('agentPresets')
  const workspaceRegistry = ctx.get('workspaceRegistry')
  const settings = ctx.get('settings')
  const credentials = ctx.get('credentials')
  const webServer = ctx.get('webServer')
  const timer = ctx.get('timer') as { timeout(callback: () => void, delay: number): () => void } | undefined
  const tools = ctx.get('tools')
  if (agents === undefined || sessions === undefined || sessionPersistence === undefined || defaultModel === undefined || agentPresets === undefined || workspaceRegistry === undefined || settings === undefined || credentials === undefined || webServer === undefined || timer === undefined || tools === undefined) {
    throw new Error('dsh-lark requires Harness agent, settings, credentials, workspace, and webServer services')
  }

  const settingsScope = settings.register(
    settingsNamespace(LARK_SETTINGS_NAMESPACE),
    ConfigSchema,
    { base: rawConfig, applies: 'live' },
  )
  const namespace = settingsNamespace(LARK_SETTINGS_NAMESPACE)
  const currentSettings = (): SettingsConfig => resolveSettingsConfig(settingsScope.get())
  let apiUpdateDepth = 0

  const runtime = new LarkRuntime({
    settings: currentSettings,
    resolveSecret: async ref => (await credentials.resolve(credentialRef(ref)))?.value,
    start: async config => {
      const bridge = new HarnessConversationService({
        agents,
        sessions,
        sessionPersistence,
        selection: () => defaultModel.currentSelection(),
        agentPresets,
        workspaceRegistry,
      }, config)
      return startChannel(config, bridge, {
        factory: createLarkChannel,
        inbox: new PersistentMessageInbox(),
        scheduler: timer,
        logger: ctx.logger,
        terminalLogger: console,
      })
    },
  })

  const delivery = {
    send: (message: OutboundMessage) => runtime.send(message),
  }
  ctx.provide('larkDelivery', delivery)
  ctx.effect(() => tools.register(defineTool({
    name: 'feishu_send_message',
    description: 'Send a proactive Feishu direct message to a person. Resolve the recipient only from an explicit Feishu open_id or the protected identity map. If Feishu rejects the direct message, notify the same person by mentioning them in the configured fallback group.',
    parameters: {
      recipient: {
        type: 'string',
        required: true,
        description: 'Feishu open_id, mapped Huly account/person ID, mapped Linear user ID/email, or an exact unique mapped name/alias.',
      },
      message: {
        type: 'string',
        required: true,
        description: 'Non-empty message to deliver. Feishu markdown is supported.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          messageId: { type: 'string' },
          recipientOpenId: { type: 'string' },
          recipientName: { type: 'string' },
        },
        required: ['messageId', 'recipientOpenId', 'recipientName'],
      },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    async execute(args) {
      const recipientInput = args.recipient.trim()
      const message = args.message.trim()
      if (message === '') throw new TypeError('Feishu message must not be empty')
      const identityMap = new IdentityMap(currentSettings().identityMapFile || undefined)
      const recipient = await identityMap.resolveRecipient(recipientInput)
      if (recipient === undefined) {
        throw new Error(`Feishu recipient is not mapped: ${recipientInput}. Update the protected identity map before sending.`)
      }
      const recipientName = recipient.name?.trim() || recipientInput
      const result = await runtime.send({
        chatId: recipient.feishuOpenId,
        markdown: message,
        fallbackMention: { openId: recipient.feishuOpenId, name: recipientName },
      })
      return {
        messageId: result.messageId,
        recipientOpenId: recipient.feishuOpenId,
        recipientName,
      }
    },
  })), 'dsh-lark: proactive Feishu direct-message tool')

  const api = createSettingsApi({
    getSettings: currentSettings,
    revision: () => settings.describe({ redactSecrets: true }).find(item => item.ns === namespace)?.revision ?? 0,
    beginUpdate: () => { apiUpdateDepth += 1 },
    endUpdate: () => { apiUpdateDepth -= 1 },
    updateSettings: (patch, unset, expectedRevision) => settings.mutate(namespace, [
      ...Object.entries(patch).map(([key, value]) => ({ op: 'set' as const, path: [key], value })),
      ...unset.map(key => ({ op: 'unset' as const, path: [key] })),
    ], expectedRevision),
    credentials: {
      describe: ref => credentials.describe(credentialRef(ref)),
      set: (ref, value) => credentials.set(credentialRef(ref), value),
      unset: ref => credentials.unset(credentialRef(ref)),
    },
    runtimeStatus: () => runtime.status(),
    reconcile: () => runtime.reconcile(),
  })

  settingsScope.watch(() => apiUpdateDepth > 0 ? undefined : runtime.reconcile())
  ctx.on('credentials/updated', ref => {
    const current = currentSettings()
    if (apiUpdateDepth === 0 && (ref === current.appSecretRef || ref === current.hulyEventsSecretRef)) void runtime.reconcile()
  })
  ctx.effect(() => webServer.register({
    kind: 'exact',
    path: SETTINGS_PATH,
    handler: (req, res) => handleSettingsRequest(req, res, api),
  }), 'dsh-lark: settings page')
  ctx.effect(() => () => runtime.dispose(), 'dsh-lark: runtime')
  await runtime.reconcile()
}
