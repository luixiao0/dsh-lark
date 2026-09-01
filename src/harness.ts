import { installModelSelection } from '@deepseek-ai/dsh-agent'
import type { AttachmentStore, ImageMediaType } from '@deepseek-ai/dsh-attachment'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { SessionEvent, SessionHeader } from '@deepseek-ai/dsh-session'
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import sharp from 'sharp'
import type { LocalResource } from './attachments.ts'
import { conversationKey, summarizeTurn, toSessionId } from './conversation.ts'
import type { ConversationMessage } from './conversation.ts'
import type { DomainName } from './config.ts'

interface AgentLike {
  session: { id: unknown; seq: number; events: readonly any[] }
  whenIdle(): Promise<void>
  followup(message: ReturnType<typeof createUserMessage>): void
  inject?(message: ReturnType<typeof createUserMessage>): void
}

const OPERATIONAL_TASK_PATTERN = /(?:修复|修一下|安装|部署|发布|配置|迁移|实现|开发|接入|排查|调查|调研|分析一下|检查一下|改一下|改代码|改配置|清理|同步|导入|导出|升级|更新|重启|提交|推送|创建|删除|批量|fix|install|deploy|configure|migrate|implement|investigate|research|debug)/iu
const MAX_MODEL_IMAGE_SIDE = 4096

interface AgentHandleLike { agent: AgentLike; dispose(): Promise<void> }

interface WorkspaceLike {
  path: string
  sessionIds?: readonly SessionId[]
  attachSession(sessionId: unknown): Promise<void>
  detachSession?(sessionId: unknown): Promise<void>
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
  messageId?: string
  senderName?: string
  mentionedBot?: boolean
  rawContentType?: string
  sourceText?: string
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
  private readonly backgroundHandles = new Set<AgentHandleLike>()
  private hulyWorkspaceCleanup: Promise<void> | undefined
  private backgroundDelivery: ((result: BackgroundWorkDelivery) => Promise<void>) | undefined

  constructor(private readonly deps: HarnessDependencies, private readonly config: HarnessBridgeConfig) {}

  configureBackgroundDelivery(deliver: (result: BackgroundWorkDelivery) => Promise<void>): void {
    this.backgroundDelivery = deliver
  }

  async concealHulyWorkspaceSessions(): Promise<void> {
    const workspace = this.config.workspace === undefined
      ? this.deps.workspaceRegistry.list()[0]
      : await this.deps.workspaceRegistry.resolveByPath(this.config.workspace)
    if (workspace?.detachSession === undefined) return
    this.hulyWorkspaceCleanup ??= this.detachHulyTransportSessions(workspace).catch((error: unknown) => {
      console.error(`dsh-lark: Huly transport session cleanup failed: ${error instanceof Error ? error.message : String(error)}`)
    })
    await this.hulyWorkspaceCleanup
  }

  async reply(message: InboundMessage): Promise<string> {
    const delegated = await this.delegateOperationalTask(message)
    if (delegated !== undefined) return delegated
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
        const data = await prepareImageForModel(await readFile(image.localPath))
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
        // Older bridge versions could misclassify synthetic Huly notifications
        // as Feishu execution requests. Never revive those accidental children.
        if (origin.messageId?.startsWith('huly:') === true) continue
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
    const backgroundHandles = [...this.backgroundHandles]
    this.backgroundHandles.clear()
    await Promise.all([
      ...handles.flatMap(result => result.status === 'fulfilled' ? [result.value.dispose()] : []),
      ...[...this.recoveryHandles].map(handle => handle.dispose()),
      ...backgroundHandles.map(handle => handle.dispose()),
    ])
    this.handles.clear()
    this.recoveryHandles.clear()
    this.backgroundDelivery = undefined
  }

  private async delegateOperationalTask(message: InboundMessage): Promise<string | undefined> {
    const deliver = this.backgroundDelivery
    if (deliver === undefined || !shouldDelegateOperationalTask(message)) return undefined
    const parent = await this.getOrCreate(conversationKey(message))
    let handle: AgentHandleLike
    try {
      handle = await this.createMechanicalBackgroundAgent(parent.agent)
    } catch (error) {
      console.error(`dsh-lark: mechanical background delegation failed; using parent session: ${error instanceof Error ? error.message : String(error)}`)
      return undefined
    }
    const origin: BackgroundWorkOrigin = {
      chatId: message.chatId,
      chatType: message.chatType,
      ...(message.messageId === undefined ? {} : { messageId: message.messageId }),
      ...(message.threadId === undefined ? {} : { threadId: message.threadId }),
      ...(message.senderName?.trim() ? { requesterName: message.senderName.trim() } : {}),
      ...(message.senderId === undefined ? {} : { requesterId: message.senderId }),
    }
    const marker = `DSH_FEISHU_BACKGROUND:${JSON.stringify(origin)}`
    const firstSeq = handle.agent.session.seq
    parent.agent.inject?.(createUserMessage({
      content: [{ type: 'text', text: `系统状态：消息 ${message.messageId ?? '(unknown)'} 已机械委派给后台 Agent；主 Session 不要重复执行。` }],
      source: { kind: 'user' },
    }))
    handle.agent.followup(createUserMessage({
      content: [{
        type: 'text',
        text: `${marker}\n\n这是飞书协调器机械委派的执行任务。不要再创建子 Agent。开始工具工作前，先用 feishu_send_message 向 chatId 发送一条以“【后台任务已开始】”开头的简短回执；有实质进展或阻塞时发送“【后台进度】”。完成后必须发送一条以“【后台任务完成】”开头的最终结果，再给出同样内容的 assistant 最终回答。\n\n原始飞书请求：\n${message.content}`,
      }],
      source: { kind: 'user' },
    }))
    this.backgroundHandles.add(handle)
    void this.finishMechanicalBackground(handle, parent.agent, origin, firstSeq, deliver).catch(error => {
      console.error(`dsh-lark: mechanical background delivery failed: ${error instanceof Error ? error.message : String(error)}`)
    })
    const mention = message.chatType === 'group' && message.senderName?.trim() ? `@${message.senderName.trim()} ` : ''
    return `${mention}已接手，任务已转到后台执行；这里继续保持可响应，进度和结果会直接回到本群。`
  }

  private async createMechanicalBackgroundAgent(parent: AgentLike): Promise<AgentHandleLike> {
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
    const sessionId = SessionId(randomUUID())
    const handle = await this.deps.agents.create({
      sessionId,
      meta: {
        cwd,
        parentSession: SessionId(String(parent.session.id)),
        origin: 'subagent',
        delegationDepth: 1,
        agentPreset,
      },
      agentOptions: selection,
      setup,
    })
    try {
      await workspace?.attachSession(sessionId)
      return handle
    } catch (error) {
      await handle.dispose()
      throw error
    }
  }

  private async finishMechanicalBackground(
    handle: AgentHandleLike,
    parent: AgentLike,
    origin: BackgroundWorkOrigin,
    firstSeq: number,
    deliver: (result: BackgroundWorkDelivery) => Promise<void>,
  ): Promise<void> {
    let outcome = '后台任务没有产生可交付的最终结果。'
    try {
      await handle.agent.whenIdle()
      await this.deps.sessions.flush(handle.agent.session)
      const result = summarizeTurn(handle.agent.session.events, firstSeq)
      outcome = result.ok ? result.text : outcome
      if (!hasSuccessfulFinalFeishuDelivery(handle.agent.session.events, firstSeq)) {
        await deliver({ ...origin, text: outcome })
      }
    } catch (error) {
      outcome = `后台任务执行失败：${error instanceof Error ? error.message : String(error)}`
      await deliver({ ...origin, text: outcome })
    } finally {
      parent.inject?.(createUserMessage({
        content: [{ type: 'text', text: `系统状态：后台任务 ${origin.messageId ?? '(unknown)'} 已结束。结果摘要：${outcome.slice(0, 2_000)}` }],
        source: { kind: 'user' },
      }))
      if (this.backgroundHandles.delete(handle)) await handle.dispose()
    }
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
      if (key.startsWith('huly:')) {
        await this.concealHulySessions(workspace, sessionId)
      } else {
        await workspace?.attachSession(sessionId)
      }
    } catch (error: unknown) {
      await handle.dispose()
      throw error
    }
    return handle
  }

  private async concealHulySessions(workspace: WorkspaceLike | undefined, currentSessionId: SessionId): Promise<void> {
    if (workspace?.detachSession === undefined) return
    await this.concealHulyWorkspaceSessions()
    await workspace.detachSession(currentSessionId)
  }

  private async detachHulyTransportSessions(workspace: WorkspaceLike): Promise<void> {
    const inspect = this.deps.sessionPersistence.inspect
    const detach = workspace.detachSession
    if (inspect === undefined || detach === undefined) return
    const attached = new Set((workspace.sessionIds ?? []).map(String))
    const headers = await this.deps.sessionPersistence.list()
    for (const header of headers) {
      if (!attached.has(String(header.id))) continue
      const inspected = await inspect.call(this.deps.sessionPersistence, header.id)
      if (!isHulyTransportSession(this.config.domain, header.id, inspected.events)) continue
      await detach.call(workspace, header.id)
    }
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

async function prepareImageForModel(data: Buffer): Promise<Buffer> {
  const image = sharp(data, { failOn: 'none' })
  const metadata = await image.metadata()
  if (Math.max(metadata.width ?? 0, metadata.height ?? 0) <= MAX_MODEL_IMAGE_SIDE) return data
  return image
    .rotate()
    .resize({
      width: MAX_MODEL_IMAGE_SIDE,
      height: MAX_MODEL_IMAGE_SIDE,
      fit: 'inside',
      withoutEnlargement: true,
    })
    .toBuffer()
}

function shouldDelegateOperationalTask(message: InboundMessage): boolean {
  if (message.messageId === undefined || !message.sourceText?.trim()) return false
  // Mechanical delegation is only for explicit human Feishu messages. Synthetic
  // Huly events contain issue titles and routing instructions that can match the
  // action-verb classifier but must stay in their durable parent conversation.
  if (!message.messageId.startsWith('om_')) return false
  if (message.chatType === 'group' && message.mentionedBot !== true) return false
  return OPERATIONAL_TASK_PATTERN.test(message.sourceText)
}

function hasSuccessfulFinalFeishuDelivery(events: readonly any[], firstSeq: number): boolean {
  const calls = new Set<string>()
  for (const event of events) {
    if (event.seq < firstSeq || event.type !== 'tool/call' || event.data.name !== 'feishu_send_message') continue
    try {
      const args = JSON.parse(event.data.arguments) as { message?: unknown }
      if (typeof args.message === 'string' && args.message.trimStart().startsWith('【后台任务完成】')) calls.add(String(event.data.callId))
    } catch {
      // An invalid call cannot count as a successful final delivery.
    }
  }
  return events.some(event => (
    event.seq >= firstSeq
    && event.type === 'tool/result'
    && calls.has(String(event.data.message?.content?.[0]?.toolCallId))
    && event.data.error === undefined
    && event.data.message?.content?.[0]?.isError !== true
  ))
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

function isHulyTransportSession(domain: DomainName, sessionId: SessionId, events: readonly SessionEvent[]): boolean {
  for (const event of events) {
    if (event.type !== 'user/message') continue
    const text = event.data.content
      .filter(block => block.type === 'text')
      .map(block => block.text)
      .join('\n')
    const envelope = /<feishu_messages\s+mode="huly"([^>]*)>/u.exec(text)?.[1]
    if (envelope === undefined) continue
    const chatId = /\bchat_id="([^"]+)"/u.exec(envelope)?.[1]
    const threadId = /\bthread_id="([^"]+)"/u.exec(envelope)?.[1]
    if (chatId === undefined) continue
    const candidates = [toSessionId(domain, `huly:${chatId}`)]
    if (threadId !== undefined) candidates.push(toSessionId(domain, `huly:${chatId}:${threadId}`))
    return candidates.some(candidate => String(sessionId) === String(candidate))
  }
  return false
}

function detectImageMediaType(data: Uint8Array): ImageMediaType {
  if (data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return 'image/jpeg'
  if (data.length >= 8 && data[0] === 0x89 && data[1] === 0x50 && data[2] === 0x4e && data[3] === 0x47 && data[4] === 0x0d && data[5] === 0x0a && data[6] === 0x1a && data[7] === 0x0a) return 'image/png'
  const prefix = Buffer.from(data.subarray(0, 12)).toString('ascii')
  if (prefix.startsWith('GIF87a') || prefix.startsWith('GIF89a')) return 'image/gif'
  if (prefix.startsWith('RIFF') && prefix.slice(8, 12) === 'WEBP') return 'image/webp'
  throw new TypeError('Feishu image has an unsupported encoded format')
}
