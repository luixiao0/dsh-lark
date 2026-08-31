import { resolveRuntimeConfig } from './config.ts'
import type { RuntimeConfig, SettingsConfig } from './config.ts'
import type { ActiveLarkChannel, OutboundMessage } from './channel.ts'
import type { SendResult } from '@larksuiteoapi/node-sdk'

export type RuntimeStatus =
  | { state: 'unconfigured'; message: string }
  | { state: 'connecting' }
  | { state: 'connected' }
  | { state: 'error'; message: string }
  | { state: 'stopped' }

export interface LarkRuntimeDependencies {
  settings(): SettingsConfig
  resolveSecret(ref: string): Promise<string | undefined>
  start(config: RuntimeConfig): Promise<ActiveLarkChannel>
}

export class LarkRuntime {
  private current: { fingerprint: string; channel: ActiveLarkChannel } | undefined
  private snapshot: RuntimeStatus = { state: 'unconfigured', message: 'App ID and App Secret are required' }
  private operations = Promise.resolve()
  private disposed = false

  constructor(private readonly deps: LarkRuntimeDependencies) {}

  status(): RuntimeStatus {
    return { ...this.snapshot }
  }

  reconcile(): Promise<void> {
    return this.enqueue(async () => {
      if (this.disposed) return
      let secret: string | undefined
      let hulyEventsSecret: string | undefined
      let invalidConfig = false
      try {
        const settings = this.deps.settings()
        secret = await this.deps.resolveSecret(settings.appSecretRef) ?? settings.appSecret
        hulyEventsSecret = settings.hulyEventsUrl === '' ? '' : await this.deps.resolveSecret(settings.hulyEventsSecretRef)
        let config: RuntimeConfig
        try {
          config = resolveRuntimeConfig(settings, secret, hulyEventsSecret)
        } catch (error) {
          invalidConfig = true
          throw error
        }
        const fingerprint = JSON.stringify(config)
        if (this.current?.fingerprint === fingerprint) return
        await this.stopCurrent()
        this.snapshot = { state: 'connecting' }
        const channel = await this.deps.start(config)
        if (this.disposed) {
          await channel.stop()
          return
        }
        this.current = { fingerprint, channel }
        this.snapshot = { state: 'connected' }
      } catch (error) {
        let failure = error
        if (invalidConfig) {
          try {
            await this.stopCurrent()
          } catch (stopError) {
            invalidConfig = false
            failure = stopError
          }
        }
        const message = failure instanceof Error ? failure.message : String(failure)
        let redacted = secret === undefined || secret === '' ? message : message.split(secret).join('[redacted]')
        if (hulyEventsSecret !== undefined && hulyEventsSecret !== '') redacted = redacted.split(hulyEventsSecret).join('[redacted]')
        this.snapshot = invalidConfig
          ? { state: 'unconfigured', message: redacted }
          : { state: 'error', message: redacted }
      }
    })
  }

  dispose(): Promise<void> {
    this.disposed = true
    return this.enqueue(async () => {
      await this.stopCurrent()
      this.snapshot = { state: 'stopped' }
    })
  }

  async send(message: OutboundMessage): Promise<SendResult> {
    const current = this.current
    if (current === undefined || this.snapshot.state !== 'connected') throw new Error('dsh-lark channel is not connected')
    return current.channel.send(message)
  }

  private enqueue(operation: () => Promise<void>): Promise<void> {
    const result = this.operations.then(operation, operation)
    this.operations = result.catch(() => undefined)
    return result
  }

  private async stopCurrent(): Promise<void> {
    const current = this.current
    this.current = undefined
    if (current !== undefined) await current.channel.stop()
  }
}
