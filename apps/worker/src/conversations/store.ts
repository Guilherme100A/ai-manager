import { randomUUID } from 'node:crypto'
import type { Redis } from 'ioredis'
import { DEFAULT_CONVERSATION_CONFIG, type ConversationConfig, type ConversationState } from '@wsm/core'

export interface ConversationStore {
  config(id: string): Promise<ConversationConfig>
  saveConfig(id: string, config: ConversationConfig): Promise<void>
  state(id: string): Promise<ConversationState>
  saveState(id: string, state: ConversationState): Promise<void>
  claim(): Promise<string | undefined>
  renew(token: string): Promise<boolean>
  release(token: string): Promise<void>
}
export class RedisConversationStore implements ConversationStore {
  constructor(private readonly redis: Redis) {}
  private key(kind: string, id: string) { return `wsm:conversations:${kind}:${id}` }
  async config(id: string) {
    const raw = await this.redis.get(this.key('config', id))
    // Configurações existentes continuam como pares fixos até o operador escolher rodízio.
    return raw ? { ...DEFAULT_CONVERSATION_CONFIG, mode: 'fixed', ...JSON.parse(raw) } : { ...DEFAULT_CONVERSATION_CONFIG }
  }
  async saveConfig(id: string, config: ConversationConfig) { await this.redis.set(this.key('config', id), JSON.stringify(config)) }
  async state(id: string): Promise<ConversationState> {
    const raw = await this.redis.get(this.key('state', id))
    return raw ? JSON.parse(raw) : { history: [], turns: 0 }
  }
  async saveState(id: string, state: ConversationState) { await this.redis.set(this.key('state', id), JSON.stringify(state)) }
  async claim() {
    const token = randomUUID()
    return await this.redis.set('wsm:conversations:lease', token, 'PX', 120_000, 'NX') === 'OK' ? token : undefined
  }
  async release(token: string) {
    await this.redis.eval("if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) end return 0", 1, 'wsm:conversations:lease', token)
  }
  async renew(token: string) {
    return await this.redis.eval("if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('pexpire', KEYS[1], 120000) end return 0", 1, 'wsm:conversations:lease', token) === 1
  }
}
