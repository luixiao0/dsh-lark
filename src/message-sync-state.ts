import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import type { NormalizedMessage } from '@larksuiteoapi/node-sdk'

export type FeishuChatType = 'p2p' | 'group'

export interface MessageSyncCheckpoint {
  chatId: string
  chatType: FeishuChatType
  lastCreateTime: number
}

export interface MessageSyncState {
  list(): Promise<MessageSyncCheckpoint[]>
  remember(message: Pick<NormalizedMessage, 'chatId' | 'chatType' | 'createTime'>): Promise<void>
  advance(chatId: string, chatType: FeishuChatType, createTime: number): Promise<void>
}

interface StoredSyncState {
  version: 1
  chats: Record<string, Omit<MessageSyncCheckpoint, 'chatId'>>
}

export class PersistentMessageSyncState implements MessageSyncState {
  private readonly ready: Promise<StoredSyncState>
  private operations = Promise.resolve()

  constructor(private readonly path = defaultMessageSyncStatePath()) {
    this.ready = this.load()
  }

  async list(): Promise<MessageSyncCheckpoint[]> {
    await this.operations
    const state = await this.ready
    return Object.entries(state.chats).map(([chatId, checkpoint]) => ({ chatId, ...checkpoint }))
  }

  remember(message: Pick<NormalizedMessage, 'chatId' | 'chatType' | 'createTime'>): Promise<void> {
    return this.advance(message.chatId, message.chatType, message.createTime)
  }

  advance(chatId: string, chatType: FeishuChatType, createTime: number): Promise<void> {
    if (chatId === '' || !Number.isFinite(createTime) || createTime <= 0) return Promise.resolve()
    return this.mutate(async state => {
      const current = state.chats[chatId]
      if (current !== undefined && current.lastCreateTime >= createTime) return
      state.chats[chatId] = { chatType, lastCreateTime: createTime }
      await this.save(state)
    })
  }

  private mutate(operation: (state: StoredSyncState) => Promise<void>): Promise<void> {
    const result = this.operations.then(async () => operation(await this.ready))
    this.operations = result.then(() => undefined, () => undefined)
    return result
  }

  private async load(): Promise<StoredSyncState> {
    try {
      const parsed = JSON.parse(await readFile(this.path, 'utf8')) as Partial<StoredSyncState>
      const chats = Object.create(null) as StoredSyncState['chats']
      if (parsed.chats !== null && typeof parsed.chats === 'object') {
        for (const [chatId, checkpoint] of Object.entries(parsed.chats)) {
          if (checkpoint === null || typeof checkpoint !== 'object') continue
          const value = checkpoint as Partial<Omit<MessageSyncCheckpoint, 'chatId'>>
          if ((value.chatType === 'p2p' || value.chatType === 'group') && Number.isFinite(value.lastCreateTime) && value.lastCreateTime! > 0) {
            chats[chatId] = { chatType: value.chatType, lastCreateTime: value.lastCreateTime! }
          }
        }
      }
      return { version: 1, chats }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      return { version: 1, chats: Object.create(null) as StoredSyncState['chats'] }
    }
  }

  private async save(state: StoredSyncState): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 })
    const temporary = `${this.path}.tmp`
    await writeFile(temporary, JSON.stringify(state), { mode: 0o600 })
    await rename(temporary, this.path)
  }
}

export function defaultMessageSyncStatePath(): string {
  const root = process.env.DSH_HOME?.trim() || join(homedir(), '.dsh')
  return join(root, 'state', 'dsh-lark', 'message-sync.json')
}
