import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { PersistentMessageInbox } from '../src/inbox.ts'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function inboxPath(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-lark-inbox-'))
  roots.push(root)
  return join(root, 'state', 'inbox.json')
}

function message(id: string) {
  return {
    messageId: id, chatId: 'oc_1', chatType: 'group' as const, senderId: 'ou_1', senderName: 'Lux',
    content: 'hello', rawContentType: 'text', resources: [], mentions: [], mentionAll: false,
    mentionedBot: false, createTime: Date.now(), raw: { secretEvent: true },
  }
}

describe('PersistentMessageInbox', () => {
  it('restores accepted messages after restart without persisting raw events', async () => {
    const path = await inboxPath()
    const first = new PersistentMessageInbox(path)
    await expect(first.accept(message('om_1'))).resolves.toBe(true)
    await expect(first.accept(message('om_1'))).resolves.toBe(false)

    const second = new PersistentMessageInbox(path)
    await expect(second.listPending()).resolves.toMatchObject([{ messageId: 'om_1', content: 'hello' }])
    expect(await readFile(path, 'utf8')).not.toContain('secretEvent')
  })

  it('keeps completed message ids deduplicated across restart', async () => {
    const path = await inboxPath()
    const first = new PersistentMessageInbox(path)
    await first.accept(message('om_1'))
    await first.complete(['om_1'])

    const second = new PersistentMessageInbox(path)
    await expect(second.listPending()).resolves.toEqual([])
    await expect(second.accept(message('om_1'))).resolves.toBe(false)
  })
})
