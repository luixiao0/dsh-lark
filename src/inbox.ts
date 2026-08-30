import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import type { NormalizedMessage } from '@larksuiteoapi/node-sdk'

const SEEN_TTL_MS = 12 * 60 * 60_000
const MAX_SEEN = 10_000
const MAX_PENDING = 10_000

interface InboxState {
  version: 1
  pending: NormalizedMessage[]
  seen: Record<string, number>
}

export interface MessageInbox {
  accept(message: NormalizedMessage): Promise<boolean>
  listPending(): Promise<NormalizedMessage[]>
  complete(messageIds: readonly string[]): Promise<void>
}

export class PersistentMessageInbox implements MessageInbox {
  private readonly ready: Promise<InboxState>
  private operations = Promise.resolve()

  constructor(private readonly path = defaultInboxPath()) {
    this.ready = this.load()
  }

  accept(message: NormalizedMessage): Promise<boolean> {
    return this.mutate(async state => {
      this.prune(state)
      if (Object.hasOwn(state.seen, message.messageId) || state.pending.some(item => item.messageId === message.messageId)) return false
      if (state.pending.length >= MAX_PENDING) throw new Error('dsh-lark inbox is full')
      const { raw: _raw, ...durable } = message
      state.pending.push(durable as NormalizedMessage)
      await this.save(state)
      return true
    })
  }

  async listPending(): Promise<NormalizedMessage[]> {
    await this.operations
    const state = await this.ready
    return state.pending.map(message => structuredClone(message))
  }

  complete(messageIds: readonly string[]): Promise<void> {
    if (messageIds.length === 0) return Promise.resolve()
    return this.mutate(async state => {
      const completed = new Set(messageIds)
      state.pending = state.pending.filter(message => !completed.has(message.messageId))
      const expire = Date.now() + SEEN_TTL_MS
      for (const messageId of completed) state.seen[messageId] = expire
      this.prune(state)
      await this.save(state)
    })
  }

  private mutate<T>(operation: (state: InboxState) => Promise<T>): Promise<T> {
    const result = this.operations.then(async () => operation(await this.ready))
    this.operations = result.then(() => undefined, () => undefined)
    return result
  }

  private async load(): Promise<InboxState> {
    try {
      const parsed = JSON.parse(await readFile(this.path, 'utf8')) as Partial<InboxState>
      const state: InboxState = {
        version: 1,
        pending: Array.isArray(parsed.pending) ? parsed.pending as NormalizedMessage[] : [],
        seen: parsed.seen !== null && typeof parsed.seen === 'object'
          ? Object.assign(Object.create(null), parsed.seen) as Record<string, number>
          : Object.create(null) as Record<string, number>,
      }
      this.prune(state)
      return state
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      return { version: 1, pending: [], seen: Object.create(null) as Record<string, number> }
    }
  }

  private prune(state: InboxState): void {
    const now = Date.now()
    for (const [messageId, expire] of Object.entries(state.seen)) {
      if (!Number.isFinite(expire) || expire <= now) delete state.seen[messageId]
    }
    const entries = Object.entries(state.seen)
    if (entries.length <= MAX_SEEN) return
    entries.sort((a, b) => a[1] - b[1])
    for (const [messageId] of entries.slice(0, entries.length - MAX_SEEN)) delete state.seen[messageId]
  }

  private async save(state: InboxState): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 })
    const temporary = `${this.path}.tmp`
    await writeFile(temporary, JSON.stringify(state), { mode: 0o600 })
    await rename(temporary, this.path)
  }
}

export function defaultInboxPath(): string {
  const root = process.env.DSH_HOME?.trim() || join(homedir(), '.dsh')
  return join(root, 'state', 'dsh-lark', 'inbox.json')
}
