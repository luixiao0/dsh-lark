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

export interface HulyEventClientOptions {
  url: string
  secret: string
  identityMap: IdentityMap
  adminOpenId: string
  fallbackChatId: string
  accept(message: NormalizedMessage): Promise<boolean>
  deliver(message: NormalizedMessage): void
  logger: PluginLogger
}

export class HulyEventClient {
  private socket: WebSocket | undefined
  private reconnectTimer: NodeJS.Timeout | undefined
  private attempts = 0
  private stopped = false
  private operations = Promise.resolve()

  constructor(private readonly options: HulyEventClientOptions) {}

  start(): void {
    if (this.options.url === '') return
    this.connect()
  }

  stop(): void {
    this.stopped = true
    if (this.reconnectTimer !== undefined) clearTimeout(this.reconnectTimer)
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
      this.options.logger.info('dsh-lark: Huly event bridge connected')
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
    socket.addEventListener('error', () => this.options.logger.error('dsh-lark: Huly event bridge error'))
    socket.addEventListener('close', () => {
      if (this.socket === socket) this.socket = undefined
      if (!this.stopped) this.scheduleReconnect()
    })
  }

  private async handleMessage(socket: WebSocket, payload: string): Promise<void> {
    const frame = JSON.parse(payload) as { type?: string; event?: HulyFeishuEvent }
    if (frame.type !== 'event' || frame.event === undefined) return
    const event = frame.event
    const mapping = await this.options.identityMap.resolve(event)
    const target = mapping?.feishuOpenId || this.options.adminOpenId || this.options.fallbackChatId
    if (target === '') throw new Error(`No Feishu target for unmapped Huly recipient ${event.recipient.personId ?? event.recipient.account ?? 'unknown'}`)
    const message = toNormalizedMessage(event, target, mapping)
    const accepted = await this.options.accept(message)
    if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: 'ack', id: event.id }))
    if (accepted) this.options.deliver(message)
  }

  private scheduleReconnect(): void {
    const delay = Math.min(30_000, 500 * (2 ** this.attempts++))
    this.reconnectTimer = setTimeout(() => this.connect(), delay)
  }
}

export function hulyEventOf(message: NormalizedMessage): HulyFeishuEvent | undefined {
  if (message.rawContentType !== HULY_EVENT_CONTENT_TYPE) return undefined
  return (message as NormalizedMessage & { hulyEvent?: HulyFeishuEvent }).hulyEvent
}

function toNormalizedMessage(event: HulyFeishuEvent, target: string, mapping?: IdentityMapping): NormalizedMessage {
  const unmapped = mapping === undefined
  const { createdAt: _createdAt, ...visibleEvent } = event
  const content = JSON.stringify({
    ...visibleEvent,
    delivery: {
      target,
      unmapped,
      instruction: unmapped
        ? 'Recipient is not mapped. Notify the operator, update the protected identity map when identity is established, then replay the work.'
        : 'Re-read the current Huly object before acting. Decide the useful Feishu message and any autonomous follow-up work.',
    },
  })
  return {
    messageId: `huly:${event.id}`,
    chatId: target,
    chatType: target.startsWith('ou_') ? 'p2p' : 'group',
    // P2P sessions are keyed by the Feishu user so proactive events and that
    // user's later direct messages resume the same durable DSH session.
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
