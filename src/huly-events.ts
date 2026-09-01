import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { NormalizedMessage } from '@larksuiteoapi/node-sdk'
import type { PluginLogger } from './channel.ts'

export const HULY_EVENT_CONTENT_TYPE = 'application/vnd.squady.huly-event+json'

export interface HulyFeishuEvent {
  id: string
  type: string
  createdAt: string
  actor?: { account?: string; personId?: string; name?: string }
  recipient: { account?: string; personId?: string; name?: string }
  object: { class: string; id: string; space?: string; project?: string }
  notification: { title: string; body: string; link?: string }
  message?: { id?: string; threadId?: string }
  attachments?: Array<{ id: string; name?: string; type?: string }>
}

export interface IdentityMapping {
  feishuOpenId: string
  hulyAccount?: string
  hulyPersonId?: string
  linearUserId?: string
  name?: string
  aliases?: string[]
  hulyName?: string
  hulyDisplayName?: string
  linearName?: string
  linearDisplayName?: string
  linearEmail?: string
}

export interface ResolvedFeishuMentions {
  text: string
  mentions: Array<{ key: string; openId: string; name: string }>
}

interface IdentityMapDocument { version: 1; users: IdentityMapping[] }

export class IdentityMap {
  constructor(private readonly path = defaultIdentityMapPath()) {}

  async resolveFeishu(openId: string): Promise<IdentityMapping | undefined> {
    const document = await this.read()
    return document.users.find(item => item.feishuOpenId === openId)
  }

  async resolve(event: HulyFeishuEvent): Promise<IdentityMapping | undefined> {
    const document = await this.read()
    return document.users.find(item =>
      (event.recipient.personId !== undefined && item.hulyPersonId === event.recipient.personId)
      || (event.recipient.account !== undefined && item.hulyAccount === event.recipient.account),
    )
  }

  async resolveRecipient(value: string): Promise<IdentityMapping | undefined> {
    const query = value.trim()
    if (query === '') return undefined
    const document = await this.read()
    if (query.startsWith('ou_')) {
      return document.users.find(item => item.feishuOpenId === query) ?? { feishuOpenId: query }
    }
    const normalized = query.toLocaleLowerCase()
    const matches = document.users.filter(item => recipientKeys(item).some(key => key.toLocaleLowerCase() === normalized))
    if (matches.length > 1) throw new Error(`Feishu recipient is ambiguous: ${query}`)
    return matches[0]
  }

  async resolveMentions(text: string, fallbackUsers: IdentityMapping[] = []): Promise<ResolvedFeishuMentions> {
    const document = await this.read()
    const candidates = new Map<string, IdentityMapping | undefined>()
    for (const item of document.users) {
      for (const key of recipientKeys(item)) {
        const normalized = key.toLocaleLowerCase()
        if (!candidates.has(normalized)) candidates.set(normalized, item)
        else if (candidates.get(normalized)?.feishuOpenId !== item.feishuOpenId) candidates.set(normalized, undefined)
      }
    }
    for (const item of fallbackUsers) {
      for (const key of recipientKeys(item)) {
        const normalized = key.toLocaleLowerCase()
        if (!candidates.has(normalized)) candidates.set(normalized, item)
        else if (candidates.get(normalized)?.feishuOpenId !== item.feishuOpenId && !document.users.some(user => recipientKeys(user).some(value => value.toLocaleLowerCase() === normalized))) {
          candidates.set(normalized, undefined)
        }
      }
    }

    let resolvedText = text
    const mentions = new Map<string, { key: string; openId: string; name: string }>()
    const uniqueCandidates = [...candidates.entries()]
      .filter((entry): entry is [string, IdentityMapping] => entry[1] !== undefined)
      .sort(([left], [right]) => right.length - left.length)
    for (const [key, item] of uniqueCandidates) {
      const suffix = /[a-z0-9_.-]$/iu.test(key) ? '(?![a-z0-9_.-])' : ''
      const pattern = new RegExp(`(?<![a-z0-9._%+-])@${escapeRegExp(key)}${suffix}`, 'giu')
      if (!pattern.test(resolvedText)) continue
      pattern.lastIndex = 0
      const mention = mentions.get(item.feishuOpenId) ?? {
        key: `@_dsh_user_${mentions.size + 1}`,
        openId: item.feishuOpenId,
        name: item.name?.trim() || key,
      }
      mentions.set(item.feishuOpenId, mention)
      resolvedText = resolvedText.replace(new RegExp(`${pattern.source}[ \\t]?`, pattern.flags), '')
    }
    return { text: resolvedText, mentions: [...mentions.values()] }
  }

  private async read(): Promise<IdentityMapDocument> {
    try {
      const value = JSON.parse(await readFile(this.path, 'utf8')) as Partial<IdentityMapDocument>
      return { version: 1, users: Array.isArray(value.users) ? value.users : [] }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { version: 1, users: [] }
      throw error
    }
  }
}

function recipientKeys(item: IdentityMapping): string[] {
  return [
    item.feishuOpenId,
    item.hulyAccount,
    item.hulyPersonId,
    item.linearUserId,
    item.linearEmail,
    item.name,
    item.hulyName,
    item.hulyDisplayName,
    item.linearName,
    item.linearDisplayName,
    ...(item.aliases ?? []),
  ].flatMap(value => typeof value === 'string' && value.trim() !== '' ? [value.trim()] : [])
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
}

export interface HulyEventClientOptions {
  url: string
  secret: string
  identityMap: IdentityMap
  adminOpenId: string
  fallbackChatId: string
  accept(message: NormalizedMessage): Promise<boolean>
  deliver(message: NormalizedMessage): void
  logger: PluginLogger
  terminalLogger?: Pick<PluginLogger, 'info' | 'warn' | 'error'>
}

export class HulyEventClient {
  private socket: WebSocket | undefined
  private reconnectTimer: NodeJS.Timeout | undefined
  private attempts = 0
  private stopped = false
  private operations = Promise.resolve()
  private authTimer: NodeJS.Timeout | undefined

  constructor(private readonly options: HulyEventClientOptions) {}

  start(): void {
    if (this.options.url === '') return
    this.connect()
  }

  stop(): void {
    this.stopped = true
    if (this.reconnectTimer !== undefined) clearTimeout(this.reconnectTimer)
    if (this.authTimer !== undefined) clearTimeout(this.authTimer)
    this.socket?.close()
    this.socket = undefined
  }

  private connect(): void {
    if (this.stopped) return
    const socket = new WebSocket(this.options.url)
    this.socket = socket
    socket.addEventListener('open', () => {
      this.attempts = 0
      socket.send(JSON.stringify({ type: 'auth', secret: this.options.secret }))
      this.authTimer = setTimeout(() => socket.close(1008, 'Authentication timeout'), 10_000)
    })
    socket.addEventListener('message', event => {
      const next = this.operations.then(
        () => this.handleMessage(socket, String(event.data)),
        () => this.handleMessage(socket, String(event.data)),
      )
      this.operations = next.catch((error: unknown) => {
        this.options.logger.error(`dsh-lark: Huly event persistence failed: ${error instanceof Error ? error.message : String(error)}`)
        socket.close(1011, 'Event persistence failed')
      })
    })
    socket.addEventListener('error', () => this.log('error', 'dsh-lark: Huly event bridge error'))
    socket.addEventListener('close', event => {
      if (this.authTimer !== undefined) clearTimeout(this.authTimer)
      this.authTimer = undefined
      if (this.socket === socket) this.socket = undefined
      if (!this.stopped) this.log('warn', `dsh-lark: Huly event bridge closed (${event.code}${event.reason === '' ? '' : `: ${event.reason}`})`)
      if (!this.stopped) this.scheduleReconnect()
    })
  }

  private async handleMessage(socket: WebSocket, payload: string): Promise<void> {
    const frame = JSON.parse(payload) as { type?: string; event?: HulyFeishuEvent }
    if (frame.type === 'ready') {
      if (this.authTimer !== undefined) clearTimeout(this.authTimer)
      this.authTimer = undefined
      this.log('info', 'dsh-lark: Huly event bridge ready')
      return
    }
    if (frame.type !== 'event' || frame.event === undefined) return
    const event = frame.event
    const mapping = await this.options.identityMap.resolve(event)
    const target = mapping?.feishuOpenId || this.options.adminOpenId || this.options.fallbackChatId
    if (target === '') throw new Error(`No Feishu target for unmapped Huly recipient ${event.recipient.personId ?? event.recipient.account ?? 'unknown'}`)
    const message = toNormalizedMessage(event, target)
    const accepted = await this.options.accept(message)
    if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: 'ack', id: event.id }))
    if (accepted) this.options.deliver(message)
  }

  private scheduleReconnect(): void {
    const delay = Math.min(30_000, 500 * (2 ** this.attempts++))
    this.log('warn', `dsh-lark: Huly event bridge reconnecting in ${delay}ms`)
    this.reconnectTimer = setTimeout(() => this.connect(), delay)
  }

  private log(level: 'info' | 'warn' | 'error', message: string): void {
    this.options.logger[level](message)
    this.options.terminalLogger?.[level](message)
  }
}

export function hulyEventOf(message: NormalizedMessage): HulyFeishuEvent | undefined {
  if (message.rawContentType !== HULY_EVENT_CONTENT_TYPE) return undefined
  return (message as NormalizedMessage & { hulyEvent?: HulyFeishuEvent }).hulyEvent
}

export function toNormalizedMessage(event: HulyFeishuEvent, target: string): NormalizedMessage {
  const content = JSON.stringify({
    type: event.type,
    ...(event.actor?.name?.trim() ? { actor: { name: event.actor.name.trim() } } : {}),
    object: event.object,
    notification: event.notification,
    ...(event.message === undefined ? {} : { message: event.message }),
    ...(event.attachments === undefined ? {} : { attachments: event.attachments }),
  })
  return {
    messageId: `huly:${event.id}`,
    chatId: target,
    chatType: target.startsWith('ou_') ? 'p2p' : 'group',
    // senderId remains the Feishu delivery target; conversationKey isolates
    // synthetic Huly events by object before deriving the durable session.
    senderId: target,
    senderName: event.actor?.name ?? 'Huly',
    content,
    rawContentType: HULY_EVENT_CONTENT_TYPE,
    resources: [],
    mentions: [],
    mentionAll: false,
    mentionedBot: true,
    createTime: Date.parse(event.createdAt) || Date.now(),
    ...(event.message?.threadId === undefined ? {} : { threadId: event.message.threadId }),
    hulyEvent: event,
  } as NormalizedMessage
}

export function defaultIdentityMapPath(): string {
  const root = process.env.DSH_HOME?.trim() || join(homedir(), '.dsh')
  return join(root, 'state', 'dsh-lark', 'identity-map.json')
}
