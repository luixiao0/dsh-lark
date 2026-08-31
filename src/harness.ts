import { installModelSelection } from '@deepseek-ai/dsh-agent'
import type { AttachmentStore, ImageMediaType } from '@deepseek-ai/dsh-attachment'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
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
  sessionPersistence: { list(): Promise<Array<{ id: string }>> }
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

export class HarnessConversationService {
  private readonly handles = new Map<string, Promise<AgentHandleLike>>()

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

  async dispose(): Promise<void> {
    const handles = await Promise.allSettled(this.handles.values())
    await Promise.all(handles.flatMap(result => result.status === 'fulfilled' ? [result.value.dispose()] : []))
    this.handles.clear()
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
}

function detectImageMediaType(data: Uint8Array): ImageMediaType {
  if (data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return 'image/jpeg'
  if (data.length >= 8 && data[0] === 0x89 && data[1] === 0x50 && data[2] === 0x4e && data[3] === 0x47 && data[4] === 0x0d && data[5] === 0x0a && data[6] === 0x1a && data[7] === 0x0a) return 'image/png'
  const prefix = Buffer.from(data.subarray(0, 12)).toString('ascii')
  if (prefix.startsWith('GIF87a') || prefix.startsWith('GIF89a')) return 'image/gif'
  if (prefix.startsWith('RIFF') && prefix.slice(8, 12) === 'WEBP') return 'image/webp'
  throw new TypeError('Feishu image has an unsupported encoded format')
}
