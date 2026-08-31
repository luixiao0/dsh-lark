import { describe, expect, it, vi } from 'vitest'
import { startChannel } from '../src/channel.ts'
import type { MessageInbox } from '../src/inbox.ts'

function fakeChannel() {
  const handlers = new Map<string, Function>()
  return {
    handlers,
    rawClient: {
      im: { v1: { chatMembers: { get: vi.fn(async () => ({ data: { items: [] } })) } } },
      contact: { v3: { user: { get: vi.fn(async () => ({ data: {} })) } } },
    },
    connect: vi.fn(async () => undefined), disconnect: vi.fn(async () => undefined),
    send: vi.fn(async () => ({ messageId: 'out' })),
    on: vi.fn((name: string, handler: Function) => { handlers.set(name, handler); return () => handlers.delete(name) }),
  }
}

function fakeInbox(initial: any[] = []): MessageInbox & { complete: ReturnType<typeof vi.fn> } {
  const pending = [...initial]
  const complete = vi.fn(async (ids: readonly string[]) => {
    for (const id of ids) {
      const index = pending.findIndex(message => message.messageId === id)
      if (index >= 0) pending.splice(index, 1)
    }
  })
  return {
    accept: vi.fn(async message => {
      if (pending.some(item => item.messageId === message.messageId)) return false
      pending.push(message)
      return true
    }),
    listPending: vi.fn(async () => [...pending]),
    complete,
  }
}

function scheduler() {
  return {
    timeout(callback: () => void, delay: number) {
      const timer = setTimeout(callback, delay)
      return () => clearTimeout(timer)
    },
  }
}

function config(overrides: Record<string, unknown> = {}) {
  return {
    appId: 'id', appSecret: 'secret', domain: 'feishu' as const, requireMention: true,
    dmMode: 'open' as const, groupAllowlist: ['oc_1'], dmAllowlist: [], homeChatId: 'oc_1',
    groupBatchDelayMs: 10, silentReplyToken: 'NO_REPLY', workspace: '/work', errorMessage: 'safe error',
    ...overrides,
  }
}

function message(overrides: Record<string, unknown> = {}) {
  return {
    messageId: 'om_1', chatId: 'oc_1', chatType: 'p2p' as const, senderId: 'ou_1', senderName: 'Lux',
    content: 'hi', rawContentType: 'text', resources: [], mentions: [], mentionAll: false,
    mentionedBot: false, createTime: Date.now(),
    ...overrides,
  }
}

function dependencies(channel: ReturnType<typeof fakeChannel>, inbox = fakeInbox(), logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() }) {
  return { factory: vi.fn(() => channel as any), inbox, scheduler: scheduler(), logger }
}

describe('startChannel', () => {
  it('uses WebSocket policy defaults and preserves channel metadata for the agent', async () => {
    const channel = fakeChannel()
    const deps = dependencies(channel)
    const bridge = { reply: vi.fn(async (_message: any) => 'Hello **Lark**'), dispose: vi.fn(async () => undefined) }
    const active = await startChannel(config(), bridge, deps)
    expect(deps.logger.info).toHaveBeenCalledWith('dsh-lark: WebSocket connected')
    expect(deps.factory).toHaveBeenCalledWith(expect.objectContaining({
      transport: 'websocket',
      policy: expect.objectContaining({ requireMention: true, dmMode: 'open' }),
      safety: expect.objectContaining({ batch: { text: { delayMs: 0 } } }),
    }))
    await channel.handlers.get('message')!(message())
    await vi.waitFor(() => expect(bridge.reply).toHaveBeenCalledOnce())
    const inbound = bridge.reply.mock.calls[0]![0]
    expect(inbound.content).toContain('<feishu_messages')
    expect(inbound.content).toContain('"senderName":"Lux"')
    expect(inbound.content).toContain('"sentAt":')
    expect(inbound.content).toContain('timezone=')
    expect(inbound.content).toContain('current_time=')
    expect(inbound.content).toContain('mode="request"')
    expect(inbound.content).not.toContain('"mentionedBot"')
    expect(inbound.content).not.toContain('"rawContentType"')
    expect(inbound.content).not.toContain('"createdAt"')
    expect(channel.send).toHaveBeenCalledWith('oc_1', { markdown: 'Hello **Lark**' }, { replyTo: 'om_1', replyInThread: false })
    await active.stop()
    expect(channel.disconnect).toHaveBeenCalledOnce()
    expect(bridge.dispose).toHaveBeenCalledOnce()
  })

  it('keeps speakers distinguishable when Feishu does not return a nickname', async () => {
    const channel = fakeChannel()
    const bridge = { reply: vi.fn(async () => '收到'), dispose: vi.fn(async () => undefined) }
    await startChannel(config(), bridge, dependencies(channel))

    await channel.handlers.get('message')!(message({ senderName: undefined }))

    await vi.waitFor(() => expect(bridge.reply).toHaveBeenCalledOnce())
    expect(bridge.reply.mock.calls[0]![0].content).toContain('"senderName":"Feishu user (ou_1)"')
  })

  it('resolves a missing sender name from the Feishu group member list', async () => {
    const channel = fakeChannel()
    channel.rawClient.im.v1.chatMembers.get.mockResolvedValueOnce({
      data: { items: [{ member_id: 'ou_1', name: '冯嘉宁' }] },
    })
    const bridge = { reply: vi.fn(async () => '收到'), dispose: vi.fn(async () => undefined) }
    await startChannel(config(), bridge, dependencies(channel))

    await channel.handlers.get('message')!(message({ senderName: undefined }))

    await vi.waitFor(() => expect(bridge.reply).toHaveBeenCalledOnce())
    expect(bridge.reply.mock.calls[0]![0].content).toContain('"senderName":"冯嘉宁"')
  })

  it('converts an exact current group member name to a native mention', async () => {
    const channel = fakeChannel()
    channel.rawClient.im.v1.chatMembers.get.mockResolvedValueOnce({
      data: { items: [{ member_id: 'ou_amagi', name: 'Amagi' }] },
    })
    const bridge = { reply: vi.fn(async () => '@Amagi 请处理'), dispose: vi.fn(async () => undefined) }
    await startChannel(config(), bridge, dependencies(channel))

    await channel.handlers.get('message')!(message({ chatType: 'group', mentionedBot: true }))

    await vi.waitFor(() => expect(channel.send).toHaveBeenCalledWith(
      'oc_1',
      { markdown: '请处理' },
      {
        replyTo: 'om_1',
        replyInThread: false,
        mentions: [{ key: '@_dsh_user_1', openId: 'ou_amagi', name: 'Amagi' }],
      },
    ))
  })

  it('batches ordinary group messages per topic and suppresses an exact ambient token', async () => {
    vi.useFakeTimers()
    const channel = fakeChannel()
    const inbox = fakeInbox()
    const bridge = { reply: vi.fn(async (_message: any) => 'NO_REPLY'), dispose: vi.fn(async () => undefined) }
    const active = await startChannel(config({ requireMention: false, groupBatchDelayMs: 100 }), bridge, dependencies(channel, inbox))
    await channel.handlers.get('message')!(message({ messageId: 'om_a', chatType: 'group', threadId: 'topic-a', senderId: 'ou_a', senderName: 'A', content: 'one' }))
    await channel.handlers.get('message')!(message({ messageId: 'om_b', chatType: 'group', threadId: 'topic-b', senderId: 'ou_b', senderName: 'B', content: 'two' }))
    await vi.advanceTimersByTimeAsync(100)
    await vi.runAllTicks()
    expect(bridge.reply).toHaveBeenCalledTimes(2)
    expect(bridge.reply.mock.calls.map(call => call[0].threadId).sort()).toEqual(['topic-a', 'topic-b'])
    expect(channel.send).not.toHaveBeenCalled()
    expect(inbox.complete).toHaveBeenCalledTimes(2)
    await active.stop()
    vi.useRealTimers()
  })

  it('flushes buffered context immediately when the bot is mentioned', async () => {
    const channel = fakeChannel()
    const bridge = { reply: vi.fn(async (_message: any) => 'answer'), dispose: vi.fn(async () => undefined) }
    await startChannel(config({ requireMention: false, groupBatchDelayMs: 1000 }), bridge, dependencies(channel))
    await channel.handlers.get('message')!(message({ messageId: 'om_a', chatType: 'group', content: 'background' }))
    await channel.handlers.get('message')!(message({ messageId: 'om_b', chatType: 'group', content: 'question', mentionedBot: true }))
    await vi.waitFor(() => expect(bridge.reply).toHaveBeenCalledOnce())
    expect(bridge.reply.mock.calls[0]![0].content).toContain('background')
    expect(bridge.reply.mock.calls[0]![0].content).toContain('question')
  })

  it('sends a safe fallback for direct requests but stays quiet for ambient failures', async () => {
    const channel = fakeChannel()
    const terminal = { error: vi.fn() }
    const deps = { ...dependencies(channel), terminalLogger: terminal }
    const bridge = { reply: vi.fn(async (_message: any) => { throw new Error('secret stack') }), dispose: vi.fn(async () => undefined) }
    await startChannel(config({ requireMention: false, groupBatchDelayMs: 0 }), bridge, deps)
    await channel.handlers.get('message')!(message({ messageId: 'direct', chatType: 'group', threadId: 'topic', mentionedBot: true }))
    await vi.waitFor(() => expect(channel.send).toHaveBeenCalledWith('oc_1', { text: 'safe error' }, { replyTo: 'direct', replyInThread: true }))
    channel.send.mockClear()
    await channel.handlers.get('message')!(message({ messageId: 'ambient', chatType: 'group', mentionedBot: false }))
    await vi.waitFor(() => expect(bridge.reply).toHaveBeenCalledTimes(2))
    expect(channel.send).not.toHaveBeenCalled()
    expect(terminal.error).toHaveBeenCalledWith('dsh-lark: message handling failed: secret stack')
  })

  it('restricts proactive delivery to the configured group allowlist', async () => {
    const channel = fakeChannel()
    const bridge = { reply: vi.fn(async (_message: any) => 'answer'), dispose: vi.fn(async () => undefined) }
    const active = await startChannel(config(), bridge, dependencies(channel))
    await expect(active.send({ markdown: 'summary' })).resolves.toEqual({ messageId: 'out' })
    expect(channel.send).toHaveBeenCalledWith('oc_1', { markdown: 'summary' })
    await expect(active.send({ chatId: 'oc_other', text: 'blocked' })).rejects.toThrow(/groupAllowlist/)
    await expect(active.send({ text: 'a', markdown: 'b' })).rejects.toThrow(/exactly one/)
  })

  it('disposes conversation resources when channel disconnect fails', async () => {
    const channel = fakeChannel()
    channel.disconnect.mockRejectedValueOnce(new Error('disconnect failed'))
    const bridge = { reply: vi.fn(async (_message: any) => ''), dispose: vi.fn(async () => undefined) }
    const active = await startChannel(config(), bridge, dependencies(channel))
    await expect(active.stop()).rejects.toThrow('disconnect failed')
    expect(bridge.dispose).toHaveBeenCalledOnce()
  })

  it('logs an initial connection failure without exposing the secret', async () => {
    const channel = fakeChannel()
    channel.connect.mockRejectedValueOnce(new Error('authentication failed for secret'))
    const bridge = { reply: vi.fn(async (_message: any) => ''), dispose: vi.fn(async () => undefined) }
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
    const terminal = { error: vi.fn() }
    await expect(startChannel(config(), bridge, { ...dependencies(channel, fakeInbox(), logger), terminalLogger: terminal })).rejects.toThrow('authentication failed for secret')
    expect(logger.error).toHaveBeenCalledWith('dsh-lark: WebSocket connection failed: authentication failed for [redacted]')
    expect(terminal.error).toHaveBeenCalledWith('dsh-lark: WebSocket connection failed: authentication failed for [redacted]')
    expect(bridge.dispose).toHaveBeenCalledOnce()
  })
})
