import { Domain, LoggerLevel, createLarkChannel, normalize } from '@larksuiteoapi/node-sdk'
import type { LarkChannel, LarkChannelOptions, NormalizedMessage, RawMessageEvent, SendResult } from '@larksuiteoapi/node-sdk'
import type { RuntimeConfig } from './config.ts'
import type { BackgroundWorkDelivery, HarnessConversationService } from './harness.ts'
import type { MessageInbox } from './inbox.ts'
import { ConversationMessageBatcher, formatLocalTime, isAmbientGroupBatch, toAgentMessage } from './message-batcher.ts'
import type { ContextualNormalizedMessage, QuotedFeishuMessage, TimerScheduler } from './message-batcher.ts'
import { basename } from 'node:path'
import { downloadMessageResources, extractFileDeliveries } from './attachments.ts'
import type { LocalResource } from './attachments.ts'
import { HulyEventClient, IdentityMap, hulyEventOf } from './huly-events.ts'
import { ReplyBindingStore } from './reply-bindings.ts'
import { PersistentMessageSyncState } from './message-sync-state.ts'
import type { FeishuChatType, MessageSyncState } from './message-sync-state.ts'

const INITIAL_CATCHUP_LOOKBACK_MS = 30 * 60_000
const CATCHUP_CURSOR_OVERLAP_MS = 1_000
const GROUP_DIRECTORY_TTL_MS = 5 * 60_000

interface HistoricalMessageItem {
  message_id?: string
  root_id?: string
  parent_id?: string
  thread_id?: string
  msg_type?: string
  create_time?: string
  update_time?: string
  deleted?: boolean
  updated?: boolean
  chat_id?: string
  sender?: {
    id: string
    id_type: string
    sender_type: string
    sender_name?: string
    sender_i18n_names?: Record<string, string>
    open_bot_id?: string
  }
  body?: { content: string }
  mentions?: Array<{ key: string, id: string, id_type: string, name: string, tenant_key?: string }>
}

function interactiveCardText(raw: string | undefined): string | undefined {
  if (raw === undefined) return undefined
  let card: unknown
  try {
    card = JSON.parse(raw)
    if (isRecord(card) && typeof card.json_card === 'string') card = JSON.parse(card.json_card)
  } catch {
    return undefined
  }
  const values: string[] = []
  collectCardText(card, values)
  const unique = values
    .map(value => value.trim())
    .filter((value, index, all) => value !== '' && all.indexOf(value) === index)
  return unique.length === 0 ? undefined : unique.join('\n').slice(0, 24_000)
}

function collectCardText(value: unknown, output: string[]): void {
  if (Array.isArray(value)) {
    for (const item of value) collectCardText(item, output)
    return
  }
  if (!isRecord(value)) return
  if (typeof value.content === 'string') output.push(value.content)
  for (const [key, child] of Object.entries(value)) {
    if (key !== 'content') collectCardText(child, output)
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

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
  fallbackMention?: { openId: string; name: string }
}

export interface ActiveLarkChannel {
  send(message: OutboundMessage): Promise<SendResult>
  listMessages(query: MessageHistoryQuery): Promise<MessageHistoryResult>
  getMessage(messageId: string): Promise<FeishuMessageRecord>
  editMessage(messageId: string, text: string): Promise<void>
  recallMessage(messageId: string): Promise<void>
  stop(): Promise<void>
}

export interface MessageHistoryQuery {
  chatId: string
  limit?: number
  startTime?: string
  endTime?: string
  pageToken?: string
}

export interface FeishuMessageRecord {
  messageId: string
  chatId: string
  senderId: string
  senderName: string
  senderType: string
  messageType: string
  text: string
  createdAt: string
  updatedAt?: string
  updated: boolean
  deleted: boolean
  threadId?: string
  replyToMessageId?: string
  resources: Array<{ type: string; fileName?: string; localPath?: string }>
}

export interface MessageHistoryResult {
  messages: FeishuMessageRecord[]
  hasMore: boolean
  pageToken?: string
}

interface RecallEvent {
  message_id?: string
  chat_id?: string
  recall_time?: string
  recall_type?: string
}

interface DispatcherChannel {
  dispatcher?: { register(handlers: Record<string, (event: RecallEvent) => Promise<void>>): unknown }
}

export interface StartChannelDependencies {
  inbox: MessageInbox
  scheduler: TimerScheduler
  factory?: ChannelFactory
  logger?: PluginLogger
  terminalLogger?: Pick<PluginLogger, 'info' | 'warn' | 'error'>
  bindings?: ReplyBindingStore
  messageSync?: MessageSyncState
}

export async function startChannel(
  config: Omit<RuntimeConfig, 'appSecretRef'>,
  bridge: Pick<HarnessConversationService, 'reply' | 'dispose'> & Partial<Pick<HarnessConversationService, 'configureBackgroundDelivery' | 'recoverInterruptedBackgroundWork'>>,
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
  const downloadResources = (message: NormalizedMessage): Promise<NormalizedMessage> => downloadMessageResources(channel, message, (resource, error) => {
    logger.warn(`dsh-lark: ${resource.type} download failed for ${message.messageId}; continuing without local bytes: ${error instanceof Error ? error.message : String(error)}`)
  })
  const bindings = dependencies.bindings ?? new ReplyBindingStore()
  const messageSync = dependencies.messageSync ?? new PersistentMessageSyncState()
  const identityMap = new IdentityMap(config.identityMapFile || undefined)
  const senderNames = new Map<string, string>()
  const observedGroupMembers = new Map<string, Map<string, string>>()
  const groupDirectoryCheckedAt = new Map<string, number>()
  const fetchMessageItem = async (messageId: string): Promise<HistoricalMessageItem | undefined> => {
    const response = await channel.rawClient.im.v1.message.get({
      path: { message_id: messageId },
      params: { with_sender_name: true, card_msg_content_type: 'raw_card_content' },
    })
    if (response.code !== undefined && response.code !== 0) throw new Error(`${response.code}: ${response.msg ?? 'message request failed'}`)
    return response.data?.items?.[0] as HistoricalMessageItem | undefined
  }

  const rememberGroupMember = (chatId: string, openId: string, name: string | undefined) => {
    if (!chatId.startsWith('oc_') || !openId.startsWith('ou_') || !name?.trim()) return
    const members = observedGroupMembers.get(chatId) ?? new Map<string, string>()
    members.set(openId, name.trim())
    observedGroupMembers.set(chatId, members)
    senderNames.set(openId, name.trim())
  }

  const groupMembers = async (chatId: string): Promise<Array<{ feishuOpenId: string; name: string }>> => {
    const checkedAt = groupDirectoryCheckedAt.get(chatId) ?? 0
    if (Date.now() - checkedAt >= GROUP_DIRECTORY_TTL_MS) {
      groupDirectoryCheckedAt.set(chatId, Date.now())
      try {
        let pageToken: string | undefined
        do {
          const response = await channel.rawClient.im.v1.chatMembers.get({
            params: {
              member_id_type: 'open_id',
              page_size: 100,
              ...(pageToken === undefined ? {} : { page_token: pageToken }),
            },
            path: { chat_id: chatId },
          })
          for (const member of response.data?.items ?? []) {
            if (member.member_id !== undefined) rememberGroupMember(chatId, member.member_id, member.name)
          }
          pageToken = response.data?.has_more ? response.data.page_token : undefined
        } while (pageToken)
      } catch (error) {
        logger.warn(`dsh-lark: group member lookup failed for ${chatId}: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
    return [...(observedGroupMembers.get(chatId) ?? new Map()).entries()].map(([feishuOpenId, name]) => ({ feishuOpenId, name }))
  }

  const sendMessage = async (
    chatId: string,
    content: Parameters<LarkChannel['send']>[1],
    options?: Parameters<LarkChannel['send']>[2],
    resolveGroupMentions = chatId.startsWith('oc_'),
  ): Promise<SendResult> => {
    const value = 'text' in content
      ? content.text
      : 'markdown' in content && typeof content.markdown === 'string' ? content.markdown : undefined
    if (!resolveGroupMentions || value === undefined) return channel.send(chatId, content, options)
    const resolved = await identityMap.resolveMentions(value, await groupMembers(chatId))
    const resolvedContent = 'text' in content ? { text: resolved.text } : { markdown: resolved.text }
    const mentions = [...(options?.mentions ?? []), ...resolved.mentions]
    return channel.send(chatId, resolvedContent, mentions.length === 0 ? options : { ...options, mentions })
  }

  const deliverBackground = async (result: BackgroundWorkDelivery): Promise<void> => {
    const mention = result.chatType === 'group' && result.requesterName?.trim()
      ? `@${result.requesterName.trim()} `
      : ''
    await sendMessage(result.chatId, { markdown: `${mention}${result.text}` }, result.messageId === undefined ? undefined : {
      replyTo: result.messageId,
      replyInThread: result.threadId !== undefined,
    }, result.chatType === 'group')
  }
  bridge.configureBackgroundDelivery?.(deliverBackground)

  const enrichSenderName = async (message: NormalizedMessage): Promise<NormalizedMessage> => {
    if (message.senderName?.trim()) {
      if (message.chatType === 'group') rememberGroupMember(message.chatId, message.senderId, message.senderName)
      return message
    }
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
    if (message.chatType === 'group') rememberGroupMember(message.chatId, message.senderId, name)
    return { ...message, senderName: name }
  }

  const historicalSenderName = (item: HistoricalMessageItem): string | undefined => (
    item.sender?.sender_name?.trim()
    || item.sender?.sender_i18n_names?.zh_cn?.trim()
    || item.sender?.sender_i18n_names?.en_us?.trim()
    || Object.values(item.sender?.sender_i18n_names ?? {}).find(value => value.trim())?.trim()
  )

  const applyHistoricalContent = (message: NormalizedMessage, item: HistoricalMessageItem): NormalizedMessage => {
    const appSender = item.sender?.sender_type.toLowerCase() === 'app'
    const senderId = appSender ? item.sender?.open_bot_id || item.sender?.id || message.senderId : message.senderId
    const senderName = historicalSenderName(item) || message.senderName
    const cardText = item.msg_type === 'interactive' ? interactiveCardText(item.body?.content) : undefined
    return {
      ...message,
      senderId,
      ...(senderName?.trim() ? { senderName: senderName.trim() } : {}),
      ...(cardText === undefined ? {} : { content: cardText }),
    }
  }

  const enrichLiveCard = async (message: NormalizedMessage): Promise<NormalizedMessage> => {
    if (message.rawContentType !== 'interactive') return message
    try {
      const item = await fetchMessageItem(message.messageId)
      return item === undefined ? message : applyHistoricalContent(message, item)
    } catch (error) {
      logger.warn(`dsh-lark: card content lookup failed for ${message.messageId}: ${error instanceof Error ? error.message : String(error)}`)
      return message
    }
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
          sent.push(await sendMessage(deliveryChatId, { markdown: text }, hulyEvent === undefined ? {
            replyTo: latest.messageId,
            replyInThread: latest.threadId !== undefined,
          } : undefined, latest.chatType === 'group'))
        } catch (error) {
          if (hulyEvent === undefined || !latest.chatId.startsWith('ou_') || config.fallbackChatId === '') throw error
          const key = '@_user_1'
          deliveryChatId = config.fallbackChatId
          sent.push(await sendMessage(deliveryChatId, { text }, {
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
          sent.push(await channel.send(deliveryChatId, { text: '文件转发' }, {
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
        await sendMessage(latest.chatId, { text: config.errorMessage }, {
          replyTo: latest.messageId,
          replyInThread: latest.threadId !== undefined,
        }, latest.chatType === 'group')
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

  const acceptFeishuMessage = async (message: NormalizedMessage) => {
    const card = await enrichLiveCard(message)
    const named = await enrichSenderName(card)
    const durable = await downloadResources(named)
    const contextual = await hydrateReplyContext(durable)
    const accepted = await dependencies.inbox.accept(contextual)
    try {
      await messageSync.remember(contextual)
    } catch (error) {
      logger.warn(`dsh-lark: message sync checkpoint failed for ${contextual.chatId}: ${error instanceof Error ? error.message : String(error)}`)
    }
    if (accepted) batcher.push(contextual)
  }

  const isAllowedHistoricalMessage = (message: NormalizedMessage): boolean => {
    if (message.chatType === 'group') {
      if (config.groupAllowlist.length > 0 && !config.groupAllowlist.includes(message.chatId)) return false
      if (config.requireMention && !message.mentionedBot) return false
      if (message.mentionAll && !message.mentionedBot) return false
      return true
    }
    if (config.dmMode === 'disabled') return false
    return config.dmMode !== 'allowlist' || config.dmAllowlist.includes(message.senderId)
  }

  const rawHistoricalEvent = (item: HistoricalMessageItem, chatId: string, chatType: FeishuChatType): RawMessageEvent | undefined => {
    if (item.deleted || item.sender === undefined || !item.message_id || !item.msg_type || item.body?.content === undefined) return undefined
    const senderType = item.sender.sender_type.toLowerCase()
    if (senderType !== 'user' && senderType !== 'app') return undefined
    const value = senderType === 'app' ? item.sender.open_bot_id || item.sender.id : item.sender.id
    const senderId = item.sender.id_type === 'user_id'
      ? { user_id: value }
      : item.sender.id_type === 'union_id'
        ? { union_id: value }
        : { open_id: value }
    const mentions = item.mentions?.map(mention => ({
      key: mention.key,
      id: mention.id_type === 'user_id'
        ? { user_id: mention.id }
        : mention.id_type === 'union_id'
          ? { union_id: mention.id }
          : { open_id: mention.id },
      name: mention.name,
      ...(mention.tenant_key === undefined ? {} : { tenant_key: mention.tenant_key }),
    }))
    return {
      sender: { sender_id: senderId, sender_type: item.sender.sender_type },
      message: {
        message_id: item.message_id,
        ...(item.root_id === undefined ? {} : { root_id: item.root_id }),
        ...(item.parent_id === undefined ? {} : { parent_id: item.parent_id }),
        ...(item.thread_id === undefined ? {} : { thread_id: item.thread_id }),
        ...(item.create_time === undefined ? {} : { create_time: item.create_time }),
        chat_id: item.chat_id || chatId,
        chat_type: chatType,
        message_type: item.msg_type,
        content: item.body.content,
        ...(mentions === undefined ? {} : { mentions }),
      },
    }
  }

  const isOwnHistoricalMessage = (item: HistoricalMessageItem): boolean => item.sender?.sender_type.toLowerCase() === 'app' && (
    item.sender.id === config.appId || item.sender.open_bot_id === channel.botIdentity?.openId
  )

  const normalizeHistoricalMessage = async (
    item: HistoricalMessageItem,
    chatId: string,
    chatType: FeishuChatType,
    download = false,
  ): Promise<NormalizedMessage | undefined> => {
    const raw = rawHistoricalEvent(item, chatId, chatType)
    if (raw === undefined || channel.botIdentity === undefined) return undefined
    let normalized = applyHistoricalContent(await normalize(raw, { botIdentity: channel.botIdentity }), item)
    normalized = await enrichSenderName(normalized)
    return download ? downloadResources(normalized) : normalized
  }

  async function hydrateReplyContext(message: NormalizedMessage): Promise<NormalizedMessage> {
    if (message.replyToMessageId === undefined) return message
    try {
      const item = await fetchMessageItem(message.replyToMessageId)
      if (item === undefined || item.chat_id === undefined) return message
      const mode = await channel.getChatMode(item.chat_id)
      const quoted = await normalizeHistoricalMessage(item, item.chat_id, mode === 'p2p' ? 'p2p' : 'group', true)
      if (quoted === undefined) return message
      const quotedResources = quoted.resources as LocalResource[]
      const directResources = message.resources as LocalResource[]
      const resources = [...directResources]
      const seen = new Set(directResources.map(resource => resource.fileKey))
      for (const resource of quotedResources) {
        if (!seen.has(resource.fileKey)) resources.push(resource)
        seen.add(resource.fileKey)
      }
      const quotedMessage: QuotedFeishuMessage = {
        messageId: quoted.messageId,
        senderId: quoted.senderId,
        senderName: quoted.senderName?.trim() || `Feishu user (${quoted.senderId})`,
        sentAt: formatLocalTime(quoted.createTime),
        text: quoted.content,
        resources: quotedResources,
      }
      return { ...message, resources, quotedMessage } as ContextualNormalizedMessage
    } catch (error) {
      logger.warn(`dsh-lark: quoted message lookup failed for ${message.replyToMessageId}: ${error instanceof Error ? error.message : String(error)}`)
      return message
    }
  }

  const messageRecord = async (item: HistoricalMessageItem, chatId: string, chatType: FeishuChatType, download = false): Promise<FeishuMessageRecord | undefined> => {
    if (!item.message_id || item.sender === undefined) return undefined
    const normalized = await normalizeHistoricalMessage(item, chatId, chatType, download)
    const senderId = normalized?.senderId || item.sender.open_bot_id || item.sender.id
    return {
      messageId: item.message_id,
      chatId: item.chat_id || chatId,
      senderId,
      senderName: normalized?.senderName?.trim() || item.sender.sender_name?.trim() || senderId,
      senderType: item.sender.sender_type,
      messageType: item.msg_type || 'unknown',
      text: item.deleted ? '[message recalled]' : normalized?.content ?? item.body?.content ?? '',
      createdAt: formatLocalTime(Number(item.create_time)),
      ...(item.update_time === undefined ? {} : { updatedAt: formatLocalTime(Number(item.update_time)) }),
      updated: item.updated === true,
      deleted: item.deleted === true,
      ...(item.thread_id === undefined ? {} : { threadId: item.thread_id }),
      ...(item.parent_id === undefined ? {} : { replyToMessageId: item.parent_id }),
      resources: ((normalized?.resources ?? []) as Array<{ type: string; fileName?: string; localPath?: string }>).map(resource => ({
        type: resource.type,
        ...(resource.fileName === undefined ? {} : { fileName: resource.fileName }),
        ...(resource.localPath === undefined ? {} : { localPath: resource.localPath }),
      })),
    }
  }

  const catchUpChat = async (chatId: string, chatType: FeishuChatType, lastCreateTime: number, endTime: number) => {
    const botIdentity = channel.botIdentity
    if (botIdentity === undefined) throw new Error('bot identity is unavailable after WebSocket connection')
    const startTime = lastCreateTime > 0
      ? Math.max(0, lastCreateTime - CATCHUP_CURSOR_OVERLAP_MS)
      : endTime - INITIAL_CATCHUP_LOOKBACK_MS
    let pageToken: string | undefined
    let recovered = 0
    do {
      const response = await channel.rawClient.im.v1.message.list({
        params: {
          container_id_type: 'chat',
          container_id: chatId,
          start_time: String(Math.floor(startTime / 1000)),
          end_time: String(Math.floor(endTime / 1000)),
          sort_type: 'ByCreateTimeAsc',
          page_size: 50,
          with_sender_name: true,
          card_msg_content_type: 'raw_card_content',
          ...(pageToken === undefined ? {} : { page_token: pageToken }),
        },
      })
      if (response.code !== undefined && response.code !== 0) throw new Error(`${response.code}: ${response.msg ?? 'history request failed'}`)
      for (const item of response.data?.items ?? []) {
        const historical = item as HistoricalMessageItem
        const senderName = historicalSenderName(historical)
        if (historical.sender?.id && senderName) rememberGroupMember(chatId, historical.sender.id, senderName)
        if (isOwnHistoricalMessage(historical)) continue
        const message = await normalizeHistoricalMessage(historical, chatId, chatType)
        if (message === undefined) continue
        if (!isAllowedHistoricalMessage(message)) continue
        await acceptFeishuMessage(message)
        recovered += 1
      }
      pageToken = response.data?.has_more ? response.data.page_token : undefined
    } while (pageToken)
    await messageSync.advance(chatId, chatType, endTime)
    if (recovered > 0) logger.info(`dsh-lark: recovered ${recovered} missed message(s) from ${chatId}`)
  }

  const catchUpMissedMessages = async () => {
    const endTime = Date.now()
    const chats = new Map<string, { chatType: FeishuChatType, lastCreateTime: number }>()
    for (const checkpoint of await messageSync.list()) chats.set(checkpoint.chatId, checkpoint)
    if (config.homeChatId.startsWith('oc_') && !chats.has(config.homeChatId)) {
      chats.set(config.homeChatId, { chatType: 'group', lastCreateTime: 0 })
    }
    for (const chatId of config.groupAllowlist) {
      if (chatId.startsWith('oc_') && !chats.has(chatId)) chats.set(chatId, { chatType: 'group', lastCreateTime: 0 })
    }
    try {
      let pageToken: string | undefined
      do {
        const response = await channel.rawClient.im.v1.chat.list({
          params: { page_size: 100, ...(pageToken === undefined ? {} : { page_token: pageToken }) },
        })
        if (response.code !== undefined && response.code !== 0) throw new Error(`${response.code}: ${response.msg ?? 'chat list request failed'}`)
        for (const chat of response.data?.items ?? []) {
          if (chat.chat_id && chat.chat_status !== 'dissolved' && chat.chat_status !== 'dissolved_save' && !chats.has(chat.chat_id)) {
            chats.set(chat.chat_id, { chatType: 'group', lastCreateTime: 0 })
          }
        }
        pageToken = response.data?.has_more ? response.data.page_token : undefined
      } while (pageToken)
    } catch (error) {
      logger.warn(`dsh-lark: group discovery for missed messages failed: ${error instanceof Error ? error.message : String(error)}`)
    }
    for (const [chatId, checkpoint] of chats) {
      try {
        await catchUpChat(chatId, checkpoint.chatType, checkpoint.lastCreateTime, endTime)
      } catch (error) {
        logger.warn(`dsh-lark: missed-message recovery failed for ${chatId}: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
  }

  let stopped = false
  let catchup = Promise.resolve()
  const scheduleCatchup = () => {
    catchup = catchup.then(async () => {
      if (!stopped) await catchUpMissedMessages()
    }).catch(error => {
      logger.warn(`dsh-lark: missed-message recovery could not start: ${error instanceof Error ? error.message : String(error)}`)
    })
  }
  let recovered: NormalizedMessage[]
  try {
    recovered = await dependencies.inbox.listPending()
  } catch (error) {
    await batcher.dispose()
    await bridge.dispose()
    throw error
  }

  const dispatcher = (channel as unknown as DispatcherChannel).dispatcher
  dispatcher?.register({
    'im.message.recalled_v1': async event => {
      if (!event.message_id || !event.chat_id) return
      const mode = await channel.getChatMode(event.chat_id)
      await acceptFeishuMessage({
        messageId: `recall:${event.message_id}:${event.recall_time ?? Date.now()}`,
        chatId: event.chat_id,
        chatType: mode === 'p2p' ? 'p2p' : 'group',
        senderId: 'feishu-system',
        senderName: 'Feishu',
        content: `[message recalled] messageId=${event.message_id} recallType=${event.recall_type ?? 'unknown'}`,
        rawContentType: 'system',
        resources: [],
        mentions: [],
        mentionAll: false,
        mentionedBot: false,
        createTime: Number(event.recall_time) || Date.now(),
      })
    },
  })

  const unsubscribers = [
    channel.on('message', async (message: NormalizedMessage) => {
      await acceptFeishuMessage(message)
    }),
    channel.on('reconnecting', () => { logger.warn('dsh-lark: WebSocket reconnecting') }),
    channel.on('reconnected', () => {
      logger.info('dsh-lark: WebSocket reconnected')
      scheduleCatchup()
    }),
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
  void bridge.recoverInterruptedBackgroundWork?.(deliverBackground).catch(error => {
    logger.warn(`dsh-lark: interrupted background recovery failed: ${error instanceof Error ? error.message : String(error)}`)
  })
  const hulyEvents = config.hulyEventsUrl === '' ? undefined : new HulyEventClient({
    url: config.hulyEventsUrl,
    secret: config.hulyEventsSecret,
    identityMap,
    adminOpenId: config.adminOpenId,
    fallbackChatId: config.fallbackChatId || config.homeChatId,
    accept: message => dependencies.inbox.accept(message),
    deliver: message => batcher.push(message),
    logger,
    ...(dependencies.terminalLogger === undefined ? {} : { terminalLogger: dependencies.terminalLogger }),
  })
  hulyEvents?.start()
  for (const message of recovered) batcher.push(message)
  scheduleCatchup()

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
      try {
        return hasText
          ? await sendMessage(chatId, { text: message.text! })
          : await sendMessage(chatId, { markdown: message.markdown! })
      } catch (error) {
        const mention = message.fallbackMention
        const fallbackChatId = config.fallbackChatId || config.homeChatId
        if (!chatId.startsWith('ou_') || mention === undefined || mention.openId !== chatId || fallbackChatId === '') throw error
        if (config.groupAllowlist.length > 0 && !config.groupAllowlist.includes(fallbackChatId)) throw error
        const key = '@_user_1'
        return sendMessage(fallbackChatId, { text: message.text ?? message.markdown! }, {
          mentions: [{ key, openId: mention.openId, name: mention.name }],
        })
      }
    },
    listMessages: async query => {
      const chatId = query.chatId.trim()
      if (chatId === '') throw new TypeError('chatId is required')
      const limit = Math.min(50, Math.max(1, Math.trunc(query.limit ?? 20)))
      const start = query.startTime === undefined ? undefined : Date.parse(query.startTime)
      const end = query.endTime === undefined ? undefined : Date.parse(query.endTime)
      if (start !== undefined && !Number.isFinite(start)) throw new TypeError('startTime must be an ISO timestamp')
      if (end !== undefined && !Number.isFinite(end)) throw new TypeError('endTime must be an ISO timestamp')
      const mode = await channel.getChatMode(chatId)
      const response = await channel.rawClient.im.v1.message.list({
        params: {
          container_id_type: 'chat',
          container_id: chatId,
          sort_type: 'ByCreateTimeDesc',
          page_size: limit,
          with_sender_name: true,
          card_msg_content_type: 'raw_card_content',
          ...(start === undefined ? {} : { start_time: String(Math.floor(start / 1000)) }),
          ...(end === undefined ? {} : { end_time: String(Math.floor(end / 1000)) }),
          ...(query.pageToken?.trim() ? { page_token: query.pageToken.trim() } : {}),
        },
      })
      if (response.code !== undefined && response.code !== 0) throw new Error(`${response.code}: ${response.msg ?? 'history request failed'}`)
      const records = await Promise.all((response.data?.items ?? []).map(item => messageRecord(item as HistoricalMessageItem, chatId, mode === 'p2p' ? 'p2p' : 'group')))
      return {
        messages: records.filter((record): record is FeishuMessageRecord => record !== undefined),
        hasMore: response.data?.has_more === true,
        ...(response.data?.page_token === undefined ? {} : { pageToken: response.data.page_token }),
      }
    },
    getMessage: async messageId => {
      const id = messageId.trim()
      if (id === '') throw new TypeError('messageId is required')
      const response = await channel.rawClient.im.v1.message.get({
        path: { message_id: id },
        params: { with_sender_name: true, card_msg_content_type: 'raw_card_content' },
      })
      if (response.code !== undefined && response.code !== 0) throw new Error(`${response.code}: ${response.msg ?? 'message request failed'}`)
      const item = response.data?.items?.[0] as HistoricalMessageItem | undefined
      if (item === undefined || item.chat_id === undefined) throw new Error(`Feishu message not found: ${id}`)
      const mode = await channel.getChatMode(item.chat_id)
      const record = await messageRecord(item, item.chat_id, mode === 'p2p' ? 'p2p' : 'group', true)
      if (record === undefined) throw new Error(`Feishu message is incomplete: ${id}`)
      return record
    },
    editMessage: async (messageId, text) => {
      if (messageId.trim() === '' || text.trim() === '') throw new TypeError('messageId and text are required')
      await channel.editMessage(messageId.trim(), text)
    },
    recallMessage: async messageId => {
      if (messageId.trim() === '') throw new TypeError('messageId is required')
      await channel.recallMessage(messageId.trim())
    },
    stop: async () => {
      stopped = true
      hulyEvents?.stop()
      for (const unsubscribe of unsubscribers) unsubscribe()
      await catchup
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
