import { describe, expect, it, vi } from 'vitest'
import { HarnessConversationService } from '../src/harness.ts'

function fixture() {
  let seq = 0
  const agents = new Map<string, any>()
  const createHandle = async (sessionId: string) => {
    const events: any[] = []
    const agent = {
      session: { id: sessionId, get seq() { return seq }, events },
      whenIdle: vi.fn(async () => undefined),
      followup: vi.fn((message: any) => {
        events.push({ seq: seq++, type: 'turn/start', data: {} })
        events.push({ seq: seq++, type: 'assistant/message', data: { message: { content: [{ type: 'text', text: `answer:${message.content[0].text}` }] } } })
        events.push({ seq: seq++, type: 'turn/end', data: { reason: { kind: 'completed' } } })
      }),
    }
    agents.set(String(sessionId), agent)
    return { agent, dispose: vi.fn(async () => undefined) }
  }
  const create = vi.fn(async ({ sessionId }: { sessionId: string }) => createHandle(sessionId))
  const resume = vi.fn(async ({ resumeSessionId }: { resumeSessionId: string }) => createHandle(resumeSessionId))
  const flush = vi.fn(async () => true)
  const workspace = {
    path: '/first-workspace',
    sessionIds: [] as string[],
    attachSession: vi.fn(async () => undefined),
    detachSession: vi.fn(async () => undefined),
  }
  const mount = vi.fn(async () => undefined)
  const resolve = vi.fn(async (id?: string) => ({ id: id ?? 'default-preset' }))
  return { create, resume, flush, agents, workspace, mount, resolve }
}

function dependencies(f: ReturnType<typeof fixture>) {
  return {
    attachments: { saveImages: vi.fn(async () => []) },
    agents: { create: f.create, resume: f.resume, get: (id: string) => f.agents.get(id) },
    sessions: { flush: f.flush },
    sessionPersistence: { list: vi.fn(async () => []) },
    selection: () => ({ provider: 'p', model: 'm' }),
    agentPresets: { resolve: f.resolve, mount: f.mount },
    workspaceRegistry: { list: () => [f.workspace], resolveByPath: vi.fn(async () => undefined) },
  } as any
}

describe('HarnessConversationService', () => {
  it('lazily creates and reuses one agent for the same conversation', async () => {
    const f = fixture()
    const service = new HarnessConversationService(dependencies(f), { domain: 'feishu', workspace: '/work' })
    await expect(service.reply({ chatId: 'oc_1', chatType: 'p2p', content: 'one' })).resolves.toBe('answer:one')
    await expect(service.reply({ chatId: 'oc_1', chatType: 'p2p', content: 'two' })).resolves.toBe('answer:two')
    expect(f.create).toHaveBeenCalledTimes(1)
    expect(f.flush).toHaveBeenCalledTimes(2)
  })

  it('resumes a persisted conversation instead of creating its session again', async () => {
    const f = fixture()
    const deps = dependencies(f)
    const sessionId = 'lark-v3-427e3361f60f3bd896c74f6acd7d065d2e0198db'
    deps.sessionPersistence.list = vi.fn(async () => [{ id: sessionId }])
    const service = new HarnessConversationService(deps, { domain: 'lark' })

    await expect(service.reply({ chatId: 'a', chatType: 'p2p', content: 'again' })).resolves.toBe('answer:again')

    expect(f.resume).toHaveBeenCalledWith(expect.objectContaining({ resumeSessionId: sessionId }))
    expect(f.create).not.toHaveBeenCalled()
  })

  it('reuses a live agent without trying to resume the same session', async () => {
    const f = fixture()
    const sessionId = 'lark-v3-427e3361f60f3bd896c74f6acd7d065d2e0198db'
    const liveHandle = await f.create({ sessionId })
    f.create.mockClear()
    const deps = dependencies(f)
    deps.sessionPersistence.list = vi.fn(async () => [{ id: sessionId }])
    const service = new HarnessConversationService(deps, { domain: 'lark' })

    await expect(service.reply({ chatId: 'a', chatType: 'p2p', content: 'live' })).resolves.toBe('answer:live')
    await service.dispose()

    expect(f.resume).not.toHaveBeenCalled()
    expect(f.create).not.toHaveBeenCalled()
    expect(liveHandle.dispose).not.toHaveBeenCalled()
  })

  it('isolates different chats and honors an explicit model route', async () => {
    const f = fixture()
    const deps = dependencies(f)
    deps.selection = () => ({ provider: 'default', model: 'default' })
    const service = new HarnessConversationService(deps, { domain: 'lark', workspace: '/work', provider: 'custom', model: 'model' })
    await service.reply({ chatId: 'a', chatType: 'p2p', content: 'one' })
    await service.reply({ chatId: 'b', chatType: 'p2p', content: 'two' })
    expect(f.create).toHaveBeenCalledTimes(2)
    expect(f.create).toHaveBeenCalledWith(expect.objectContaining({ agentOptions: { provider: 'custom', model: 'model' }, meta: { cwd: '/work', agentPreset: 'default-preset' } }))
  })

  it('uses the first registered workspace and mounts the default agent preset', async () => {
    const f = fixture()
    const service = new HarnessConversationService(dependencies(f), { domain: 'feishu' })
    await service.reply({ chatId: 'a', chatType: 'p2p', content: 'one' })
    const options = f.create.mock.calls[0]![0] as any
    expect(options.meta).toEqual({ cwd: '/first-workspace', agentPreset: 'default-preset' })
    const agentCtx = { on: vi.fn(() => () => undefined) } as any
    await options.setup(agentCtx)
    expect(f.resolve).toHaveBeenCalledWith(undefined)
    expect(f.mount).toHaveBeenCalledWith(agentCtx, 'default-preset')
    expect(f.workspace.attachSession).toHaveBeenCalledWith(options.sessionId)
  })

  it('uses and mounts an explicitly configured workspace and preset', async () => {
    const f = fixture()
    const explicit = { path: '/configured', attachSession: vi.fn(async () => undefined) }
    const deps = dependencies(f)
    deps.workspaceRegistry.resolveByPath = vi.fn(async () => explicit)
    const service = new HarnessConversationService(deps, { domain: 'feishu', workspace: '/configured', agentPreset: 'coding' })
    await service.reply({ chatId: 'a', chatType: 'p2p', content: 'one' })
    const options = f.create.mock.calls[0]![0] as any
    await options.setup({ on: vi.fn(() => () => undefined) } as any)
    expect(f.resolve).toHaveBeenCalledWith('coding')
    expect(explicit.attachSession).toHaveBeenCalledWith(options.sessionId)
  })

  it('disposes a newly created agent when workspace attachment fails', async () => {
    const f = fixture()
    f.workspace.attachSession.mockRejectedValueOnce(new Error('attach failed'))
    const service = new HarnessConversationService(dependencies(f), { domain: 'feishu' })
    await expect(service.reply({ chatId: 'a', chatType: 'p2p', content: 'one' })).rejects.toThrow('attach failed')
    const handle = await f.create.mock.results[0]!.value
    expect(handle.dispose).toHaveBeenCalledOnce()
  })

  it('rejects a turn that commits no successful assistant answer', async () => {
    const create = vi.fn(async ({ sessionId }: any) => ({ agent: { session: { id: sessionId, seq: 0, events: [{ seq: 0, type: 'turn/end', data: { reason: { kind: 'error' } } }] }, whenIdle: async () => undefined, followup() {} }, dispose: async () => undefined }))
    const service = new HarnessConversationService({ attachments: { saveImages: async () => [] }, agents: { create, resume: vi.fn(), get: () => undefined }, sessions: { flush: async () => true }, sessionPersistence: { list: async () => [] }, selection: () => ({ provider: 'p', model: 'm' }), agentPresets: { resolve: async () => ({ id: 'default' }), mount: async () => undefined }, workspaceRegistry: { list: () => [], resolveByPath: async () => undefined } }, { domain: 'feishu', workspace: '/work' })
    await expect(service.reply({ chatId: 'a', chatType: 'p2p', content: 'one' })).rejects.toThrow(/successful assistant response/)
  })

  it('keeps synthetic Huly events in the parent even when their content matches an action verb', async () => {
    const f = fixture()
    const service = new HarnessConversationService(dependencies(f), { domain: 'feishu' })
    service.configureBackgroundDelivery(vi.fn(async () => undefined))

    await expect(service.reply({
      chatId: 'ou_operator',
      chatType: 'p2p',
      content: 'notification payload',
      messageId: 'huly:notification-id',
      sourceText: '重构 Wild Pony 并接入 Runtime',
    })).resolves.toBe('answer:notification payload')

    expect(f.create).toHaveBeenCalledOnce()
    expect(f.create.mock.calls[0]![0].meta).not.toHaveProperty('origin')
    expect(f.workspace.attachSession).not.toHaveBeenCalled()
    expect(f.workspace.detachSession).toHaveBeenCalledWith(f.create.mock.calls[0]![0].sessionId)
  })

  it('detaches only retired per-object Huly sessions from the workspace', async () => {
    const f = fixture()
    const deps = dependencies(f)
    const retiredId = 'lark-v3-de15596236eb600a5a592b06401a672599e76397'
    const normalId = 'lark-v3-b1866693e6d77a54a638fb97a4a6c8005da8aafa'
    f.workspace.sessionIds = [retiredId, normalId]
    deps.sessionPersistence.list = vi.fn(async () => [{ id: retiredId }, { id: normalId }])
    deps.sessionPersistence.inspect = vi.fn(async (id: string) => ({
      meta: { id },
      events: [{
        seq: 0,
        type: 'user/message',
        data: {
          content: [{
            type: 'text',
            text: id === retiredId
              ? '<feishu_messages mode="huly" chat_id="ou_operator" thread_id="task-1">event</feishu_messages>'
              : '<feishu_messages mode="direct" chat_id="ou_operator">message</feishu_messages>',
          }],
        },
      }],
    }))
    const service = new HarnessConversationService(deps, { domain: 'feishu' })

    await service.reply({
      chatId: 'ou_operator',
      chatType: 'p2p',
      content: 'notification payload',
      messageId: 'huly:notification-id',
    })

    expect(f.workspace.detachSession).toHaveBeenCalledWith(retiredId)
    expect(f.workspace.detachSession).not.toHaveBeenCalledWith(normalId)
  })

  it('mechanically delegates an explicit operational Feishu message', async () => {
    const f = fixture()
    const service = new HarnessConversationService(dependencies(f), { domain: 'feishu' })
    service.configureBackgroundDelivery(vi.fn(async () => undefined))

    await expect(service.reply({
      chatId: 'ou_operator',
      chatType: 'p2p',
      content: '请修复通知系统',
      messageId: 'om_message-id',
      sourceText: '请修复通知系统',
    })).resolves.toContain('任务已转到后台执行')

    expect(f.create).toHaveBeenCalledTimes(2)
    expect(f.create.mock.calls[1]![0].meta).toMatchObject({ origin: 'subagent', delegationDepth: 1 })
  })

  it('does not recover an interrupted child created from a synthetic Huly event', async () => {
    const f = fixture()
    const deps = dependencies(f)
    const marker = 'DSH_FEISHU_BACKGROUND:{"chatId":"ou_operator","chatType":"p2p","messageId":"huly:notification-id"}'
    deps.sessionPersistence = {
      list: vi.fn(async () => [{ id: 'accidental-child', origin: 'subagent' }]),
      inspect: vi.fn(async () => ({
        meta: { id: 'accidental-child', origin: 'subagent' },
        events: [
          { seq: 0, type: 'user/message', data: { content: [{ type: 'text', text: marker }] } },
          { seq: 1, type: 'turn/end', data: { reason: { kind: 'interrupted' } } },
        ],
      })),
    }
    const service = new HarnessConversationService(deps, { domain: 'feishu' })
    const deliver = vi.fn(async () => undefined)

    await service.recoverInterruptedBackgroundWork(deliver)

    expect(f.resume).not.toHaveBeenCalled()
    expect(deliver).not.toHaveBeenCalled()
  })
})
