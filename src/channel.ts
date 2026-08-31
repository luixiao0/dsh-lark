import { Domain, LoggerLevel, createLarkChannel } from '@larksuiteoapi/node-sdk'
import type { LarkChannel, LarkChannelOptions, NormalizedMessage, SendResult } from '@larksuiteoapi/node-sdk'
import type { RuntimeConfig } from './config.ts'
import type { HarnessConversationService } from './harness.ts'
import type { MessageInbox } from './inbox.ts'
import { ConversationMessageBatcher, isAmbientGroupBatch, toAgentMessage } from './message-batcher.ts'
import type { TimerScheduler } from './message-batcher.ts'
import { basename } from 'node:path'
import { downloadMessageResources, extractFileDeliveries } from './attachments.ts'
import { HulyEventClient, IdentityMap, hulyEventOf } from './huly-events.ts'
import { ReplyBindingStore } from './reply-bindings.ts'

export type ChannelFactory = (options: LarkChannelOptions) => LarkChannel
export interface PluginLogger {
  info(message: string): unknown
  warn(message: string): unknown
  error(message: string): unknown
}

export interface OutboundMessage {
  chatId?: string
  text?: string
  markdown?: string
}

export interface ActiveLarkChannel {
  send(message: OutboundMessage): Promise<SendResult>
  stop(): Promise<void>
}

export interface StartChannelDependencies {
  inbox: MessageInbox
  scheduler: TimerScheduler
  factory?: ChannelFactory
  logger?: PluginLogger
  terminalLogger?: Pick<PluginLogger, 'error'>
  bindings?: ReplyBindingStore
}

export async function startChannel(
  config: Omit<RuntimeConfig, 'appSecretRef'>,
  bridge: Pick<HarnessConversationService, 'reply' | 'dispose'>,
  dependencies: StartChannelDependencies,
): Promise<ActiveLarkChannel> {
  const factory = dependencies.factory ?? createLarkChannel
  const logger = dependencies.logger ?? console
  const logError = (message: string) => {
    logger.error(message)
    dependencies.terminalLogger?.error(message)
  }
  const channel = factory({
    appId: config.appId,
    appSecret: config.appSecret,
    transport: 'websocket',
    domain: config.domain === 'lark' ? Domain.Lark : Domain.Feishu,
    source: 'dsh-lark',
    loggerLevel: LoggerLevel.info,
    handshakeTimeoutMs: 15_000,
    policy: {
      requireMention: config.requireMention,
      dmMode: config.dmMode,
      groupAllowlist: config.groupAllowlist,
      dmAllowlist: config.dmAllowlist,
      respondToMentionAll: false,
    },
    safety: {
      chatQueue: { enabled: true },
      batch: { text: { delayMs: 0 } },
      staleMessageWindowMs: 5 * 60_000,
      dedup: { ttl: 10 * 60_000, maxEntries: 10_000 },
    },
  })
  const bindings = dependencies.bindings ?? new ReplyBindingStore()
  const identityMap = new IdentityMap(config.identityMapFile || undefined)
  const senderNames = new Map<string, string>()

  const enrichSenderName = async (message: NormalizedMessage): Promise<NormalizedMessage> => {
    if (message.senderName?.trim()) return message
    let name = senderNames.get(message.senderId)
    try {
      if (name === undefined) name = (await identityMap.resolveFeishu(message.senderId))?.name
      if (name === undefined && message.chatType === 'group') {
        let pageToken: string | undefined
        do {
          const response = await channel.rawClient.im.v1.chatMembers.get({
            params: {
              member_id_type: 'open_id',
              page_size: 100,
              ...(pageToken === undefined ? {} : { page_token: pageToken }),
            },
            path: { chat_id: message.chatId },
          })
          for (const member of response.data?.items ?? []) {
            if (member.member_id && member.name) senderNames.set(member.member_id, member.name)
          }
          name = senderNames.get(message.senderId)
          pageToken = response.data?.has_more ? response.data.page_token : undefined
        } while (name === undefined && pageToken)
      }
      if (name === undefined && message.senderId.startsWith('ou_')) {
        const response = await channel.rawClient.contact.v3.user.get({
          params: { user_id_type: 'open_id' },
          path: { user_id: message.senderId },
        })
        name = response.data?.user?.name
      }
    } catch (error) {
      logger.warn(`dsh-lark: sender name lookup failed for ${message.senderId}: ${error instanceof Error ? error.message : String(error)}`)
    }
    if (!name) return message
    senderNames.set(message.senderId, name)
    return { ...message, senderName: name }
  }

  const handleBatch = async (messages: readonly NormalizedMessage[]) => {
    const latest = messages.at(-1)
    if (latest === undefined) return
    const ambient = isAmbientGroupBatch(messages)
    const hulyEvent = hulyEventOf(latest)
    let complete = false
    try {
      const replyBindings = new Map()
      for (const message of messages) {
        if (message.replyToMessageId === undefined) continue
        const binding = await bindings.get(message.replyToMessageId)
        if (binding !== undefined) replyBindings.set(message.replyToMessageId, binding)
      }
      const rawText = await bridge.reply(toAgentMessage(messages, replyBindings))
      const delivery = extractFileDeliveries(rawText)
      const text = delivery.text
      if (ambient && text.trim() === config.silentReplyToken) {
        logger.info(`dsh-lark: suppressed ambient reply in ${latest.chatId}`)
        complete = true
        return
      }
      const sent = []
      let deliveryChatId = latest.chatId
      if (text !== '' && text !== config.silentReplyToken) {
        try {
          sent.push(await channel.send(deliveryChatId, { markdown: text }, hulyEvent === undefined ? {
            replyTo: latest.messageId,
            replyInThread: latest.threadId !== undefined,
          } : undefined))
        } catch (error) {
          if (hulyEvent === undefined || !latest.chatId.startsWith('ou_') || config.fallbackChatId === '') throw error
          const key = '@_user_1'
          deliveryChatId = config.fallbackChatId
          sent.push(await channel.send(deliveryChatId, { text: `${key}\n${text}` }, {
            mentions: [{ key, openId: latest.chatId, name: hulyEvent.recipient.name ?? '成员' }],
          }))
        }
      }
      for (const path of delivery.files) {
        try {
          sent.push(await channel.send(deliveryChatId, { file: { source: path, fileName: basename(path) } }))
        } catch (error) {
          if (hulyEvent === undefined || deliveryChatId !== latest.chatId || !latest.chatId.startsWith('ou_') || config.fallbackChatId === '') throw error
          const key = '@_user_1'
          deliveryChatId = config.fallbackChatId
          sent.push(await channel.send(deliveryChatId, { text: `${key}\n文件转发` }, {
            mentions: [{ key, openId: latest.chatId, name: hulyEvent.recipient.name ?? '成员' }],
          }))
          sent.push(await channel.send(deliveryChatId, { file: { source: path, fileName: basename(path) } }))
        }
      }
      if (hulyEvent !== undefined) {
        await Promise.all(sent.map(result => bindings.set(result.messageId, hulyEvent)))
      }
      complete = true
    } catch (error: unknown) {
      logError(`dsh-lark: message handling failed: ${error instanceof Error ? error.message : String(error)}`)
      if (hulyEvent !== undefined) {
        dependencies.scheduler.timeout(() => batcher.push(latest), 30_000)
        return
      }
      if (ambient) {
        complete = true
        return
      }
      try {
        await channel.send(latest.chatId, { text: config.errorMessage }, {
          replyTo: latest.messageId,
          replyInThread: latest.threadId !== undefined,
        })
        complete = true
      } catch (sendError: unknown) {
        logError(`dsh-lark: fallback reply failed: ${sendError instanceof Error ? sendError.message : String(sendError)}`)
      }
    } finally {
      if (complete) await dependencies.inbox.complete(messages.map(message => message.messageId))
    }
  }
  const batcher = new ConversationMessageBatcher(
    config.groupBatchDelayMs,
    dependencies.scheduler,
    handleBatch,
  )
  let recovered: NormalizedMessage[]
  try {
    recovered = await dependencies.inbox.listPending()
  } catch (error) {
    await batcher.dispose()
    await bridge.dispose()
    throw error
  }

  const unsubscribers = [
    channel.on('message', async (message: NormalizedMessage) => {
      const named = await enrichSenderName(message)
      const durable = await downloadMessageResources(channel, named)
      if (await dependencies.inbox.accept(durable)) batcher.push(durable)
    }),
    channel.on('reconnecting', () => { logger.warn('dsh-lark: WebSocket reconnecting') }),
    channel.on('reconnected', () => { logger.info('dsh-lark: WebSocket reconnected') }),
    channel.on('error', (error) => { logError(`dsh-lark: channel error: ${String(error)}`) }),
  ]
  try {
    await channel.connect()
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    const redacted = config.appSecret === '' ? detail : detail.split(config.appSecret).join('[redacted]')
    logError(`dsh-lark: WebSocket connection failed: ${redacted}`)
    for (const unsubscribe of unsubscribers) unsubscribe()
    await batcher.dispose()
    await bridge.dispose()
    throw error
  }
  logger.info('dsh-lark: WebSocket connected')
  const hulyEvents = config.hulyEventsUrl === '' ? undefined : new HulyEventClient({
    url: config.hulyEventsUrl,
    secret: config.hulyEventsSecret,
    identityMap,
    adminOpenId: config.adminOpenId,
    fallbackChatId: config.fallbackChatId || config.homeChatId,
    accept: message => dependencies.inbox.accept(message),
    deliver: message => batcher.push(message),
    logger,
  })
  hulyEvents?.start()
  for (const message of recovered) batcher.push(message)

  return {
    send: async message => {
      const chatId = message.chatId?.trim() || config.homeChatId
      if (chatId === '') throw new TypeError('chatId is required when homeChatId is not configured')
      if (chatId.startsWith('oc_') && config.groupAllowlist.length > 0 && !config.groupAllowlist.includes(chatId)) {
        throw new Error('outbound group is not in groupAllowlist')
      }
      const hasText = typeof message.text === 'string' && message.text !== ''
      const hasMarkdown = typeof message.markdown === 'string' && message.markdown !== ''
      if (hasText === hasMarkdown) throw new TypeError('provide exactly one non-empty text or markdown value')
      return hasText
        ? channel.send(chatId, { text: message.text! })
        : channel.send(chatId, { markdown: message.markdown! })
    },
    stop: async () => {
      hulyEvents?.stop()
      for (const unsubscribe of unsubscribers) unsubscribe()
      await batcher.dispose()
      try {
        await channel.disconnect()
        logger.info('dsh-lark: WebSocket disconnected')
      } finally {
        await bridge.dispose()
      }
    },
  }
}
