import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import type { HulyFeishuEvent } from './huly-events.ts'

interface BindingRecord { event: HulyFeishuEvent; expiresAt: number }
interface BindingDocument { version: 1; messages: Record<string, BindingRecord> }

const BINDING_TTL_MS = 90 * 24 * 60 * 60_000

export class ReplyBindingStore {
  private operations = Promise.resolve()

  constructor(private readonly path = defaultReplyBindingPath()) {}

  get(messageId: string): Promise<HulyFeishuEvent | undefined> {
    return this.enqueue(async () => {
      const document = await this.read()
      this.prune(document)
      return document.messages[messageId]?.event
    })
  }

  set(messageId: string, event: HulyFeishuEvent): Promise<void> {
    return this.enqueue(async () => {
      const document = await this.read()
      this.prune(document)
      document.messages[messageId] = { event, expiresAt: Date.now() + BINDING_TTL_MS }
      await this.save(document)
    })
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.operations.then(operation, operation)
    this.operations = result.then(() => undefined, () => undefined)
    return result
  }

  private async read(): Promise<BindingDocument> {
    try {
      const value = JSON.parse(await readFile(this.path, 'utf8')) as Partial<BindingDocument>
      return {
        version: 1,
        messages: value.messages !== null && typeof value.messages === 'object' ? value.messages as Record<string, BindingRecord> : {},
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { version: 1, messages: {} }
      throw error
    }
  }

  private prune(document: BindingDocument): void {
    const now = Date.now()
    for (const [messageId, record] of Object.entries(document.messages)) {
      if (!Number.isFinite(record.expiresAt) || record.expiresAt <= now) delete document.messages[messageId]
    }
  }

  private async save(document: BindingDocument): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 })
    const temporary = `${this.path}.tmp`
    await writeFile(temporary, JSON.stringify(document), { mode: 0o600 })
    await rename(temporary, this.path)
  }
}

export function defaultReplyBindingPath(): string {
  const root = process.env.DSH_HOME?.trim() || join(homedir(), '.dsh')
  return join(root, 'state', 'dsh-lark', 'reply-bindings.json')
}
