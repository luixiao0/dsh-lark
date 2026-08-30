import { Domain, LoggerLevel, createLarkChannel } from '@larksuiteoapi/node-sdk'
import type { LarkChannel, LarkChannelOptions, NormalizedMessage, SendResult } from '@larksuiteoapi/node-sdk'
import type { RuntimeConfig } from './config.ts'
import type { HarnessConversationService } from './harness.ts'
import type { MessageInbox } from './inbox.ts'
import { ConversationMessageBatcher, isAmbientGroupBatch, toAgentMessage } from './message-batcher.ts'
import type { TimerScheduler } from './message-batcher.ts'

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

  const handleBatch = async (messages: readonly NormalizedMessage[]) => {
    const latest = messages.at(-1)
    if (latest === undefined) return
    const ambient = isAmbientGroupBatch(messages)
    let complete = false
    try {
      const text = await bridge.reply(toAgentMessage(messages))
      if (ambient && text.trim() === config.silentReplyToken) {
        logger.info(`dsh-lark: suppressed ambient reply in ${latest.chatId}`)
        complete = true
        return
      }
      await channel.send(latest.chatId, { markdown: text }, {
        replyTo: latest.messageId,
        replyInThread: latest.threadId !== undefined,
      })
      complete = true
    } catch (error: unknown) {
      logError(`dsh-lark: message handling failed: ${error instanceof Error ? error.message : String(error)}`)
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
      if (await dependencies.inbox.accept(message)) batcher.push(message)
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
  for (const message of recovered) batcher.push(message)

  return {
    send: async message => {
      const chatId = message.chatId?.trim() || config.homeChatId
      if (chatId === '') throw new TypeError('chatId is required when homeChatId is not configured')
      if (!config.groupAllowlist.includes(chatId)) throw new Error('outbound chat is not in groupAllowlist')
      const hasText = typeof message.text === 'string' && message.text !== ''
      const hasMarkdown = typeof message.markdown === 'string' && message.markdown !== ''
      if (hasText === hasMarkdown) throw new TypeError('provide exactly one non-empty text or markdown value')
      return hasText
        ? channel.send(chatId, { text: message.text! })
        : channel.send(chatId, { markdown: message.markdown! })
    },
    stop: async () => {
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
