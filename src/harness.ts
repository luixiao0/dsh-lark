import { installModelSelection } from '@deepseek-ai/dsh-agent'
import type { AttachmentStore, ImageMediaType } from '@deepseek-ai/dsh-attachment'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { SessionEvent, SessionHeader, SessionId } from '@deepseek-ai/dsh-session'
import { readFile } from 'node:fs/promises'
import type { LocalResource } from './attachments.ts'
import { conversationKey, summarizeTurn, toSessionId } from './conversation.ts'
import type { ConversationMessage } from './conversation.ts'
import type { DomainName } from './config.ts'

interface AgentLike {
  session: { id: unknown; seq: number; events: readonly any[] }
  whenIdle(): Promise<void>
  followup(message: ReturnType<typeof createUserMessage>): void
}

interface AgentHandleLike { agent: AgentLike; dispose(): Promise<void> }

interface WorkspaceLike {
  path: string
  attachSession(sessionId: unknown): Promise<void>
}

export interface HarnessDependencies {
  attachments: Pick<AttachmentStore, 'saveImages'>
  agents: {
    create: (options: any) => Promise<AgentHandleLike>
    resume: (options: any) => Promise<AgentHandleLike>
    get: (id: ReturnType<typeof toSessionId>) => AgentLike | undefined
  }
  sessions: { flush(session: AgentLike['session']): Promise<unknown> }
  sessionPersistence: {
    list(): Promise<SessionHeader[]>
    inspect?(id: SessionId): Promise<{ meta: SessionHeader; events: readonly SessionEvent[] }>
  }
  selection(): { provider: string; model: string }
  agentPresets: {
    resolve(id?: string): Promise<{ id: string }>
    mount(agentCtx: Parameters<typeof installModelSelection>[0], id?: string): Promise<unknown>
  }
  workspaceRegistry: {
    list(): WorkspaceLike[]
    resolveByPath(path: string): Promise<WorkspaceLike | undefined>
  }
}

export interface HarnessBridgeConfig {
  domain: DomainName
  workspace?: string
  agentPreset?: string
  provider?: string
  model?: string
}

export interface InboundMessage extends ConversationMessage {
  content: string
  resources?: readonly LocalResource[]
}

export interface BackgroundWorkDelivery {
  chatId: string
  chatType: 'p2p' | 'group'
  messageId?: string
  threadId?: string
  requesterName?: string
  text: string
}

interface BackgroundWorkOrigin {
  chatId: string
  chatType: 'p2p' | 'group'
  messageId?: string
  threadId?: string
  requesterName?: string
  requesterId?: string
}

export class HarnessConversationService {
  private readonly handles = new Map<string, Promise<AgentHandleLike>>()
  private readonly recoveryHandles = new Set<AgentHandleLike>()

  constructor(private readonly deps: HarnessDependencies, private readonly config: HarnessBridgeConfig) {}

  async reply(message: InboundMessage): Promise<string> {
    const key = conversationKey(message)
    const handle = await this.getOrCreate(key)
    const agent = handle.agent
    await agent.whenIdle()
    const firstSeq = agent.session.seq
    const content: ContentBlock[] = [{ type: 'text', text: message.content }]
    const images = (message.resources ?? []).filter((resource): resource is LocalResource & { type: 'image', localPath: string } => (
      resource.type === 'image' && resource.localPath !== undefined
    ))
    if (images.length > 0) {
      const refs = await this.deps.attachments.saveImages(await Promise.all(images.map(async image => {
        const data = await readFile(image.localPath)
        return {
          data,
          mediaType: detectImageMediaType(data),
          ...(image.fileName === undefined ? {} : { name: image.fileName }),
        }
      })))
      content.push(...refs.map(attachment => ({ type: 'image' as const, attachment })))
    }
    agent.followup(createUserMessage({
      content,
      source: { kind: 'user' },
    }))
    await agent.whenIdle()
    await this.deps.sessions.flush(agent.session)
    const result = summarizeTurn(agent.session.events, firstSeq)
    if (!result.ok) throw new Error('Harness turn did not produce a successful assistant response')
    return result.text
  }

  async recoverInterruptedBackgroundWork(deliver: (result: BackgroundWorkDelivery) => Promise<void>): Promise<void> {
    const inspect = this.deps.sessionPersistence.inspect
    if (inspect === undefined) return
    const headers = await this.deps.sessionPersistence.list()
    for (const header of headers) {
      if (header.origin !== 'subagent') continue
      let origin: BackgroundWorkOrigin | undefined
      try {
        const inspected = await inspect.call(this.deps.sessionPersistence, header.id)
        const lastTurnEnd = inspected.events.findLast(event => event.type === 'turn/end')
        if (lastTurnEnd?.type !== 'turn/end' || lastTurnEnd.data.reason.kind !== 'interrupted') continue
        origin = backgroundWorkOrigin(inspected.events)
        if (origin === undefined) continue
        await this.resumeInterruptedBackgroundWork(header, inspected.events, origin, deliver)
      } catch (error) {
        if (origin === undefined) continue
        await deliver({
          ...origin,
          text: `后台任务在断线恢复时失败：${error instanceof Error ? error.message : String(error)}`,
        })
      }
    }
  }

  async dispose(): Promise<void> {
    const handles = await Promise.allSettled(this.handles.values())
    await Promise.all([
      ...handles.flatMap(result => result.status === 'fulfilled' ? [result.value.dispose()] : []),
      ...[...this.recoveryHandles].map(handle => handle.dispose()),
    ])
    this.handles.clear()
    this.recoveryHandles.clear()
  }

  private getOrCreate(key: string): Promise<AgentHandleLike> {
    let pending = this.handles.get(key)
    if (pending !== undefined) return pending
    pending = this.createAgent(key).catch((error: unknown) => {
      this.handles.delete(key)
      throw error
    })
    this.handles.set(key, pending)
    return pending
  }

  private async createAgent(key: string): Promise<AgentHandleLike> {
    const sessionId = toSessionId(this.config.domain, key)
    const liveAgent = this.deps.agents.get(sessionId)
    if (liveAgent !== undefined) {
      return { agent: liveAgent, dispose: async () => undefined }
    }
    const fallback = this.deps.selection()
    const selection = {
      provider: this.config.provider ?? fallback.provider,
      model: this.config.model ?? fallback.model,
    }
    const workspace = this.config.workspace === undefined
      ? this.deps.workspaceRegistry.list()[0]
      : await this.deps.workspaceRegistry.resolveByPath(this.config.workspace)
    const cwd = this.config.workspace ?? workspace?.path ?? process.cwd()
    const agentPreset = (await this.deps.agentPresets.resolve(this.config.agentPreset)).id
    const setup = async (agentCtx: Parameters<typeof installModelSelection>[0]) => {
      installModelSelection(agentCtx, { current: selection, assembled: undefined })
      await this.deps.agentPresets.mount(agentCtx, agentPreset)
    }
    const persisted = (await this.deps.sessionPersistence.list()).some(item => item.id === sessionId)
    const handle = persisted
      ? await this.deps.agents.resume({ resumeSessionId: sessionId, agentOptions: selection, setup })
      : await this.deps.agents.create({
        sessionId,
        meta: { cwd, agentPreset },
        agentOptions: selection,
        setup,
      })
    try {
      await workspace?.attachSession(sessionId)
    } catch (error: unknown) {
      await handle.dispose()
      throw error
    }
    return handle
  }

  private async resumeInterruptedBackgroundWork(
    header: SessionHeader,
    inspectedEvents: readonly SessionEvent[],
    origin: BackgroundWorkOrigin,
    deliver: (result: BackgroundWorkDelivery) => Promise<void>,
  ): Promise<void> {
    const fallback = this.deps.selection()
    const selection = {
      provider: this.config.provider ?? fallback.provider,
      model: this.config.model ?? fallback.model,
    }
    const agentPreset = (await this.deps.agentPresets.resolve(header.agentPreset ?? this.config.agentPreset)).id
    const setup = async (agentCtx: Parameters<typeof installModelSelection>[0]) => {
      installModelSelection(agentCtx, { current: selection, assembled: undefined })
      await this.deps.agentPresets.mount(agentCtx, agentPreset)
    }
    const handle = await this.deps.agents.resume({ resumeSessionId: header.id, agentOptions: selection, setup })
    this.recoveryHandles.add(handle)
    try {
      const workspacePath = header.cwd ?? this.config.workspace
      const workspace = workspacePath === undefined
        ? this.deps.workspaceRegistry.list()[0]
        : await this.deps.workspaceRegistry.resolveByPath(workspacePath)
      await workspace?.attachSession(header.id)
      const agent = handle.agent
      await agent.whenIdle()
      const firstSeq = Math.max(agent.session.seq, inspectedEvents.length)
      agent.followup(createUserMessage({
        content: [{
          type: 'text',
          text: '上一轮后台执行因进程退出而中断。继续原任务；任何有副作用的操作都先核对外部当前状态，避免重复执行。不要调用 feishu_send_message，最终结果由恢复器回传。',
        }],
        source: { kind: 'user' },
      }))
      await agent.whenIdle()
      await this.deps.sessions.flush(agent.session)
      const result = summarizeTurn(agent.session.events, firstSeq)
      await deliver({
        ...origin,
        text: result.ok ? result.text : '后台任务已恢复执行，但没有产生可交付的最终结果。',
      })
    } finally {
      this.recoveryHandles.delete(handle)
      await handle.dispose()
    }
  }
}

function backgroundWorkOrigin(events: readonly SessionEvent[]): BackgroundWorkOrigin | undefined {
  const marker = /^DSH_FEISHU_BACKGROUND:(\{[^\n]+\})$/mu
  for (const event of events) {
    if (event.type !== 'user/message') continue
    const text = event.data.content
      .filter(block => block.type === 'text')
      .map(block => block.text)
      .join('\n')
    const payload = marker.exec(text)?.[1]
    if (payload === undefined) continue
    try {
      const value = JSON.parse(payload) as Record<string, unknown>
      if (typeof value.chatId !== 'string' || value.chatId.trim() === '') return undefined
      if (value.chatType !== 'p2p' && value.chatType !== 'group') return undefined
      return {
        chatId: value.chatId,
        chatType: value.chatType,
        ...(typeof value.messageId === 'string' && value.messageId !== '' ? { messageId: value.messageId } : {}),
        ...(typeof value.threadId === 'string' && value.threadId !== '' ? { threadId: value.threadId } : {}),
        ...(typeof value.requesterName === 'string' && value.requesterName !== '' ? { requesterName: value.requesterName } : {}),
        ...(typeof value.requesterId === 'string' && value.requesterId !== '' ? { requesterId: value.requesterId } : {}),
      }
    } catch {
      return undefined
    }
  }
  return undefined
}

function detectImageMediaType(data: Uint8Array): ImageMediaType {
  if (data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return 'image/jpeg'
  if (data.length >= 8 && data[0] === 0x89 && data[1] === 0x50 && data[2] === 0x4e && data[3] === 0x47 && data[4] === 0x0d && data[5] === 0x0a && data[6] === 0x1a && data[7] === 0x0a) return 'image/png'
  const prefix = Buffer.from(data.subarray(0, 12)).toString('ascii')
  if (prefix.startsWith('GIF87a') || prefix.startsWith('GIF89a')) return 'image/gif'
  if (prefix.startsWith('RIFF') && prefix.slice(8, 12) === 'WEBP') return 'image/webp'
  throw new TypeError('Feishu image has an unsupported encoded format')
}
