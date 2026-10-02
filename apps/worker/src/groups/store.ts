import { randomUUID } from 'node:crypto'
import type { Redis } from 'ioredis'
import { DEFAULT_GROUP_AUTOMATION, type GroupAutomationConfig, type GroupAutomationState } from '@wsm/core'

export interface GroupAutomationStore {
  config(id: string): Promise<GroupAutomationConfig>
  saveConfig(id: string, config: GroupAutomationConfig): Promise<void>
  state(id: string): Promise<GroupAutomationState>
  saveState(id: string, state: GroupAutomationState): Promise<void>
  claim(key: string, ttlMs: number): Promise<string | undefined>
  renew(key: string, token: string, ttlMs: number): Promise<void>
  release(key: string, token: string): Promise<void>
}

/** Redis já usa AOF no compose: configurações, grupos e marca diária sobrevivem a restarts. */
export class RedisGroupAutomationStore implements GroupAutomationStore {
  constructor(private readonly redis: Redis, private readonly prefix = 'wsm') {}
  private key(kind: string, id: string) { return `${this.prefix}:group-automation:${kind}:${id}` }
  async config(id: string): Promise<GroupAutomationConfig> {
    const raw = await this.redis.get(this.key('config', id))
    return raw ? { ...DEFAULT_GROUP_AUTOMATION, ...JSON.parse(raw) } : { ...DEFAULT_GROUP_AUTOMATION }
  }
  async saveConfig(id: string, config: GroupAutomationConfig) { await this.redis.set(this.key('config', id), JSON.stringify(config)) }
  async state(id: string): Promise<GroupAutomationState> {
    const raw = await this.redis.get(this.key('state', id))
    return raw ? JSON.parse(raw) : { groups: [] }
  }
  async saveState(id: string, state: GroupAutomationState) { await this.redis.set(this.key('state', id), JSON.stringify(state)) }
  async claim(key: string, ttlMs: number) {
    const token = randomUUID()
    return await this.redis.set(this.key('lease', key), token, 'PX', ttlMs, 'NX') === 'OK' ? token : undefined
  }
  async renew(key: string, token: string, ttlMs: number) {
    await this.redis.eval("if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('pexpire', KEYS[1], ARGV[2]) end return 0", 1, this.key('lease', key), token, ttlMs)
  }
  async release(key: string, token: string) {
    await this.redis.eval("if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) end return 0", 1, this.key('lease', key), token)
  }
}
