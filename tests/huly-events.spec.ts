import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { IdentityMap } from '../src/huly-events.ts'

const temporaryPaths: string[] = []

afterEach(async () => {
  await Promise.all(temporaryPaths.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

async function identityMap(users: unknown[]): Promise<IdentityMap> {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-lark-identities-'))
  temporaryPaths.push(directory)
  const path = join(directory, 'identity-map.json')
  await writeFile(path, JSON.stringify({ version: 1, users }))
  return new IdentityMap(path)
}

describe('IdentityMap mentions', () => {
  it('converts exact unique names and aliases to Feishu mention placeholders', async () => {
    const identities = await identityMap([
      { feishuOpenId: 'ou_a', name: '冯嘉宁', aliases: ['嘉宁'] },
      { feishuOpenId: 'ou_b', name: 'Lux' },
    ])

    await expect(identities.resolveMentions('@冯嘉宁 请看，@lux 也看一下，@未知 保持原样')).resolves.toEqual({
      text: '@_dsh_user_1 请看，@_dsh_user_2 也看一下，@未知 保持原样',
      mentions: [
        { key: '@_dsh_user_1', openId: 'ou_a', name: '冯嘉宁' },
        { key: '@_dsh_user_2', openId: 'ou_b', name: 'Lux' },
      ],
    })
  })

  it('leaves a shared alias as plain text instead of mentioning the wrong person', async () => {
    const identities = await identityMap([
      { feishuOpenId: 'ou_a', name: 'A', aliases: ['同学'] },
      { feishuOpenId: 'ou_b', name: 'B', aliases: ['同学'] },
    ])

    await expect(identities.resolveMentions('@同学 请处理')).resolves.toEqual({ text: '@同学 请处理', mentions: [] })
  })
})
