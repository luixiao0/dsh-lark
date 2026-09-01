import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-agent-default-model'
import type {} from '@deepseek-ai/dsh-agent-presets'
import type {} from '@deepseek-ai/dsh-attachment'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { settingsNamespace } from '@deepseek-ai/dsh-settings'
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
  listMessages(query: Parameters<LarkRuntime['listMessages']>[0]): ReturnType<LarkRuntime['listMessages']>
  getMessage(messageId: string): ReturnType<LarkRuntime['getMessage']>
  editMessage(messageId: string, text: string): ReturnType<LarkRuntime['editMessage']>
  recallMessage(messageId: string): ReturnType<LarkRuntime['recallMessage']>
}

interface LarkToolRegistry {
  register(definition: {
    name: string
    description: string
    parameters: Record<string, unknown>
    output: {
      schema: Record<string, unknown>
      render(args: unknown, value: unknown): Array<{ type: 'text'; text: string }>
    }
    execute(args: unknown): Promise<unknown>
  }): () => void
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    larkDelivery: LarkDeliveryService
    tools: LarkToolRegistry
  }
}

export const name = 'lark-channel'
export const inject = [
  'attachments', 'agents', 'sessions', 'sessionPersistence', 'agentDefaultModel', 'agentPresets', 'workspaceRegistry',
  'settings', 'credentials', 'webServer', 'timer', 'tools',
]
export const Config = ConfigSchema
export type { PluginConfig }
export { ConfigSchema } from './config.ts'

export async function apply(ctx: Context, rawConfig: PluginConfig): Promise<void> {
  const attachments = ctx.get('attachments')
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
  if (attachments === undefined || agents === undefined || sessions === undefined || sessionPersistence === undefined || defaultModel === undefined || agentPresets === undefined || workspaceRegistry === undefined || settings === undefined || credentials === undefined || webServer === undefined || timer === undefined || tools === undefined) {
    throw new Error('dsh-lark requires Harness agent, attachment, settings, credentials, workspace, and webServer services')
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
        attachments,
        agents,
        sessions,
        sessionPersistence,
        selection: () => defaultModel.currentSelection(),
        agentPresets,
        workspaceRegistry,
      }, config)
      await bridge.concealHulyWorkspaceSessions()
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
    listMessages: (query: Parameters<LarkRuntime['listMessages']>[0]) => runtime.listMessages(query),
    getMessage: (messageId: string) => runtime.getMessage(messageId),
    editMessage: (messageId: string, text: string) => runtime.editMessage(messageId, text),
    recallMessage: (messageId: string) => runtime.recallMessage(messageId),
  }
  ctx.provide('larkDelivery', delivery)
  ctx.effect(() => tools.register({
    name: 'feishu_send_message',
    description: 'Send a proactive Feishu message either to one mapped person or to an exact chat_id from a Feishu envelope. Provide exactly one of recipient or chatId. If Feishu rejects a direct message, notify the same person by mentioning them in the configured fallback group.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        recipient: {
          type: 'string',
          description: 'Feishu open_id, mapped Huly account/person ID, mapped Linear user ID/email, or an exact unique mapped name/alias.',
        },
        chatId: {
          type: 'string',
          description: 'Exact Feishu chat_id from a received feishu_messages envelope. Use this for progress or final delivery back to the originating group or direct chat.',
        },
        message: {
          type: 'string',
          description: 'Non-empty message to deliver. Feishu markdown is supported.',
        },
      },
      required: ['message'],
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          messageId: { type: 'string' },
          targetId: { type: 'string' },
          targetName: { type: 'string' },
        },
        required: ['messageId', 'targetId', 'targetName'],
      },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    async execute(args) {
      const input = args as { recipient?: unknown; chatId?: unknown; message?: unknown }
      if (typeof input.message !== 'string') throw new TypeError('Feishu message is required')
      if (input.recipient !== undefined && typeof input.recipient !== 'string') throw new TypeError('Feishu recipient must be a string')
      if (input.chatId !== undefined && typeof input.chatId !== 'string') throw new TypeError('Feishu chatId must be a string')
      const recipientInput = input.recipient?.trim() ?? ''
      const chatId = input.chatId?.trim() ?? ''
      const message = input.message.trim()
      if (message === '') throw new TypeError('Feishu message must not be empty')
      if ((recipientInput === '') === (chatId === '')) throw new TypeError('Provide exactly one of Feishu recipient or chatId')
      if (chatId !== '') {
        if (!chatId.startsWith('oc_')) throw new TypeError('Feishu chatId must be an exact oc_ chat identifier from the message envelope')
        const result = await runtime.send({ chatId, markdown: message })
        return { messageId: result.messageId, targetId: chatId, targetName: 'Feishu chat' }
      }
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
        targetId: recipient.feishuOpenId,
        targetName: recipientName,
      }
    },
  }), 'dsh-lark: proactive Feishu direct-message tool')

  ctx.effect(() => tools.register({
    name: 'feishu_get_chat_history',
    description: 'Read the latest messages currently visible to this Feishu application in one chat. Use the chat_id from the feishu_messages envelope. Results identify edited and recalled messages. Feishu does not expose webhook-bot messages to this application.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        chatId: { type: 'string', description: 'Exact Feishu chat_id from the current conversation envelope.' },
        limit: { type: 'integer', minimum: 1, maximum: 50, default: 20 },
        startTime: { type: 'string', description: 'Optional ISO-8601 inclusive lower time bound.' },
        endTime: { type: 'string', description: 'Optional ISO-8601 inclusive upper time bound.' },
        pageToken: { type: 'string', description: 'Optional pageToken returned by the previous call.' },
      },
      required: ['chatId'],
    },
    output: {
      schema: { type: 'object' },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    async execute(args) {
      const input = args as { chatId?: unknown; limit?: unknown; startTime?: unknown; endTime?: unknown; pageToken?: unknown }
      if (typeof input.chatId !== 'string') throw new TypeError('chatId is required')
      if (input.limit !== undefined && typeof input.limit !== 'number') throw new TypeError('limit must be a number')
      if (input.startTime !== undefined && typeof input.startTime !== 'string') throw new TypeError('startTime must be a string')
      if (input.endTime !== undefined && typeof input.endTime !== 'string') throw new TypeError('endTime must be a string')
      if (input.pageToken !== undefined && typeof input.pageToken !== 'string') throw new TypeError('pageToken must be a string')
      return runtime.listMessages({
        chatId: input.chatId,
        ...(input.limit === undefined ? {} : { limit: input.limit }),
        ...(input.startTime === undefined ? {} : { startTime: input.startTime }),
        ...(input.endTime === undefined ? {} : { endTime: input.endTime }),
        ...(input.pageToken === undefined ? {} : { pageToken: input.pageToken }),
      })
    },
  }), 'dsh-lark: Feishu chat-history tool')

  ctx.effect(() => tools.register({
    name: 'feishu_get_message',
    description: 'Re-read one Feishu message by message_id and return its current edited/deleted state. Image and file resources are downloaded to owner-only local paths.',
    parameters: {
      type: 'object', additionalProperties: false,
      properties: { messageId: { type: 'string', description: 'Exact Feishu message_id.' } },
      required: ['messageId'],
    },
    output: {
      schema: { type: 'object' },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    async execute(args) {
      const input = args as { messageId?: unknown }
      if (typeof input.messageId !== 'string') throw new TypeError('messageId is required')
      return runtime.getMessage(input.messageId)
    },
  }), 'dsh-lark: Feishu message-read tool')

  ctx.effect(() => tools.register({
    name: 'feishu_edit_message',
    description: 'Edit a Feishu text or rich-text message by message_id. Feishu normally permits the bot to edit only messages it sent and may enforce an administrator-defined time limit.',
    parameters: {
      type: 'object', additionalProperties: false,
      properties: { messageId: { type: 'string' }, text: { type: 'string' } },
      required: ['messageId', 'text'],
    },
    output: {
      schema: { type: 'object' },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    async execute(args) {
      const input = args as { messageId?: unknown; text?: unknown }
      if (typeof input.messageId !== 'string' || typeof input.text !== 'string') throw new TypeError('messageId and text are required')
      await runtime.editMessage(input.messageId, input.text)
      return { ok: true, messageId: input.messageId }
    },
  }), 'dsh-lark: Feishu message-edit tool')

  ctx.effect(() => tools.register({
    name: 'feishu_recall_message',
    description: 'Recall a Feishu message by message_id. Feishu enforces the tenant recall time limit and requires group owner/admin rights to recall another member\'s message.',
    parameters: {
      type: 'object', additionalProperties: false,
      properties: { messageId: { type: 'string' } },
      required: ['messageId'],
    },
    output: {
      schema: { type: 'object' },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    async execute(args) {
      const input = args as { messageId?: unknown }
      if (typeof input.messageId !== 'string') throw new TypeError('messageId is required')
      await runtime.recallMessage(input.messageId)
      return { ok: true, messageId: input.messageId }
    },
  }), 'dsh-lark: Feishu message-recall tool')

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
