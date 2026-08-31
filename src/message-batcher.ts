import type { NormalizedMessage } from '@larksuiteoapi/node-sdk'
import { conversationKey } from './conversation.ts'
import { HULY_EVENT_CONTENT_TYPE, type HulyFeishuEvent } from './huly-events.ts'
import type { LocalResource } from './attachments.ts'

const MAX_BATCH_MESSAGES = 20
const MAX_BATCH_CHARS = 8000

export interface TimerScheduler {
  timeout(callback: () => void, delayMs: number): () => void
}

interface PendingBatch {
  messages: NormalizedMessage[]
  chars: number
  cancel: () => void
}

export class ConversationMessageBatcher {
  private readonly pending = new Map<string, PendingBatch>()
  private readonly tails = new Map<string, Promise<void>>()
  private closed = false

  constructor(
    private readonly delayMs: number,
    private readonly scheduler: TimerScheduler,
    private readonly handle: (messages: readonly NormalizedMessage[]) => Promise<void>,
  ) {}

  push(message: NormalizedMessage): void {
    if (this.closed) return
    const key = conversationKey(message)
    const immediate = message.chatType === 'p2p' || message.mentionedBot || this.delayMs === 0
    if (immediate) {
      const buffered = this.take(key)
      void this.run(key, [...buffered, message])
      return
    }

    const current = this.pending.get(key)
    if (current !== undefined && (current.messages.length >= MAX_BATCH_MESSAGES || current.chars + message.content.length > MAX_BATCH_CHARS)) {
      void this.run(key, this.take(key))
    }
    const next = this.pending.get(key)
    if (next === undefined) {
      this.pending.set(key, {
        messages: [message],
        chars: message.content.length,
        cancel: this.scheduler.timeout(() => { void this.run(key, this.take(key)) }, this.delayMs),
      })
      return
    }
    next.cancel()
    next.messages.push(message)
    next.chars += message.content.length
    next.cancel = this.scheduler.timeout(() => { void this.run(key, this.take(key)) }, this.delayMs)
  }

  async dispose(): Promise<void> {
    this.closed = true
    const flushes = [...this.pending.keys()].map(key => this.run(key, this.take(key)))
    await Promise.allSettled([...flushes, ...this.tails.values()])
  }

  private take(key: string): NormalizedMessage[] {
    const batch = this.pending.get(key)
    if (batch === undefined) return []
    batch.cancel()
    this.pending.delete(key)
    return batch.messages
  }

  private run(key: string, messages: readonly NormalizedMessage[]): Promise<void> {
    if (messages.length === 0) return Promise.resolve()
    const previous = this.tails.get(key) ?? Promise.resolve()
    const next = previous.then(() => this.handle(messages), () => this.handle(messages))
    this.tails.set(key, next)
    const cleanup = () => {
      if (this.tails.get(key) === next) this.tails.delete(key)
    }
    void next.then(cleanup, cleanup)
    return next
  }
}

export function toAgentMessage(messages: readonly NormalizedMessage[], replyBindings: ReadonlyMap<string, HulyFeishuEvent> = new Map()): NormalizedMessage {
  const latest = messages.at(-1)
  if (latest === undefined) throw new TypeError('message batch cannot be empty')
  const mode = latest.rawContentType === HULY_EVENT_CONTENT_TYPE
    ? 'huly'
    : isAmbientGroupBatch(messages) ? 'ambient' : 'request'
  const entries = messages.map(message => JSON.stringify({
    messageId: message.messageId,
    senderId: message.senderId,
    senderName: message.senderName,
    text: message.content,
    resources: (message.resources as LocalResource[]).map(resource => ({
      type: resource.type,
      fileName: resource.fileName,
      localPath: resource.localPath,
    })),
    replyToMessageId: message.replyToMessageId,
    replyBinding: message.replyToMessageId === undefined ? undefined : replyBindings.get(message.replyToMessageId),
  })).join('\n')
  return {
    ...latest,
    content: `<feishu_messages mode=${JSON.stringify(mode)} chat_type=${JSON.stringify(latest.chatType)} thread_id=${JSON.stringify(latest.threadId ?? '')}>\n${entries}\n</feishu_messages>`,
  }
}

export function isAmbientGroupBatch(messages: readonly NormalizedMessage[]): boolean {
  return messages.length > 0 && messages.every(message => message.chatType === 'group' && !message.mentionedBot)
}
