import { createHash } from 'node:crypto'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { DomainName } from './config.ts'

export interface ConversationMessage {
  chatId: string
  chatType: 'p2p' | 'group'
  messageId?: string
  senderId?: string
  threadId?: string
  replyToMessageId?: string
}

export function conversationKey(message: ConversationMessage): string {
  // Huly notifications are autonomous work, not messages from the Feishu user
  // receiving their output. Keep one durable worker per Huly object so a sync
  // burst cannot block that user's direct-message conversation.
  if (message.messageId?.startsWith('huly:') === true) {
    return `huly:${message.chatId}:${message.threadId ?? 'inbox'}`
  }
  if (message.chatType === 'p2p' && message.senderId !== undefined) return `user:${message.senderId}`
  return message.threadId === undefined
    ? `chat:${message.chatId}`
    : `thread:${message.chatId}:${message.threadId}`
}

export function toSessionId(domain: DomainName, key: string): SessionId {
  const digest = createHash('sha256').update(`${domain}\0${key}`).digest('hex').slice(0, 40)
  // v3 starts with the normalized context envelope. Keep older sessions intact
  // instead of rewriting compressed history that exposed internal SDK fields.
  return SessionId(`lark-v3-${digest}`)
}

interface EventLike {
  seq: number
  type: string
  data: Record<string, unknown>
}

export interface TurnSummary { text: string; ok: boolean }

export function summarizeTurn(events: readonly EventLike[], firstSeq: number): TurnSummary {
  let text = ''
  let completed = false
  let failed = false
  for (const event of events) {
    if (event.seq < firstSeq) continue
    if (event.type === 'assistant/message') {
      const message = event.data.message as { content?: Array<{ type: string; text?: string }> } | undefined
      const next = message?.content?.filter(block => block.type === 'text').map(block => block.text ?? '').join('') ?? ''
      if (next !== '') text = next
    }
    if (event.type === 'turn/end') {
      const reason = event.data.reason as { kind?: string } | undefined
      completed = reason?.kind === 'completed'
      failed = reason?.kind === 'error' || reason?.kind === 'cancelled'
    }
  }
  return { text, ok: completed && !failed && text !== '' }
}
