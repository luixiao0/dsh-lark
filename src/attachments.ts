import { mkdir, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { extname, join } from 'node:path'
import type { LarkChannel, NormalizedMessage, ResourceDescriptor } from '@larksuiteoapi/node-sdk'

export interface LocalResource extends ResourceDescriptor { localPath?: string }

export async function downloadMessageResources(
  channel: LarkChannel,
  message: NormalizedMessage,
  onError?: (resource: ResourceDescriptor, error: unknown) => void,
): Promise<NormalizedMessage> {
  if (message.resources.length === 0) return message
  const directory = join(stateRoot(), 'attachments', safeName(message.messageId))
  await mkdir(directory, { recursive: true, mode: 0o700 })
  const resources: LocalResource[] = []
  for (const [index, resource] of message.resources.entries()) {
    try {
      const data = await downloadResource(channel, message.messageId, resource)
      const name = safeName(resource.fileName || `${resource.type}-${index + 1}${defaultExtension(resource.type)}`)
      const localPath = join(directory, name)
      await writeFile(localPath, data, { mode: 0o600 })
      resources.push({ ...resource, localPath })
    } catch (error) {
      onError?.(resource, error)
      resources.push(resource)
    }
  }
  return { ...message, resources } as NormalizedMessage
}

async function downloadResource(channel: LarkChannel, messageId: string, resource: ResourceDescriptor): Promise<Buffer> {
  try {
    const response = await channel.rawClient.im.v1.messageResource.get({
      path: { message_id: messageId, file_key: resource.fileKey },
      params: { type: resource.type === 'image' ? 'image' : 'file' },
    })
    const chunks: Buffer[] = []
    for await (const chunk of response.getReadableStream()) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
    }
    return Buffer.concat(chunks)
  } catch {
    // Card-hosted images are unsupported by messageResource, so keep the SDK
    // endpoint as a compatibility fallback for those resources.
    return channel.downloadResource(resource.fileKey, resource.type === 'image' ? 'image' : 'file')
  }
}

export function extractFileDeliveries(text: string): { text: string; files: string[] } {
  const files: string[] = []
  const lines = text.split('\n').filter(line => {
    const match = /^DSH_FEISHU_FILE:\s*(\/\S.*)$/u.exec(line.trim())
    if (match?.[1] === undefined) return true
    files.push(match[1].trim())
    return false
  })
  return { text: lines.join('\n').trim(), files }
}

function stateRoot(): string {
  const root = process.env.DSH_HOME?.trim() || join(homedir(), '.dsh')
  return join(root, 'state', 'dsh-lark')
}

function safeName(value: string): string {
  const cleaned = value.replace(/[^A-Za-z0-9._-]+/gu, '_').replace(/^\.+/u, '')
  return cleaned === '' ? 'attachment' : cleaned.slice(0, 180)
}

function defaultExtension(type: ResourceDescriptor['type']): string {
  if (type === 'image') return '.png'
  if (type === 'audio') return '.mp3'
  if (type === 'video') return '.mp4'
  return extname(type)
}
