// Utilitários para testes unitários da API (fakes de db/redis/logger). Não usar em produção.
import { Writable } from 'node:stream'
import type { Database } from '@wsm/db'
import type { AuditEntry } from './middleware/audit'
import { createLogger } from './logger'
import type { RedisLike } from './types'

export function fakeDb(opts: { up?: boolean; hang?: boolean } = {}) {
  const audits: AuditEntry[] = []
  const db = {
    execute: async () => {
      if (opts.hang) return new Promise(() => {})
      if (opts.up === false) throw new Error('db down')
      return { rows: [{ '?column?': 1 }] }
    },
    insert: () => ({
      values: async (v: AuditEntry) => {
        audits.push(v)
      },
    }),
  }
  return { db: db as unknown as Database, audits }
}

export function fakeRedis(opts: { up?: boolean; hang?: boolean } = {}): RedisLike {
  const values = new Map<string, string>()
  return {
    ping: async () => {
      if (opts.hang) return new Promise(() => {})
      if (opts.up === false) throw new Error('redis down')
      return 'PONG'
    },
    get: async (key) => values.get(key) ?? null,
    set: async (key, value) => {
      values.set(key, value)
      return 'OK'
    },
  }
}

/** Logger pino que captura as linhas JSON em memória. */
export function captureLogger() {
  const lines: Record<string, unknown>[] = []
  const destination = new Writable({
    write(chunk, _enc, cb) {
      for (const l of String(chunk).split('\n').filter(Boolean)) lines.push(JSON.parse(l) as Record<string, unknown>)
      cb()
    },
  })
  return { logger: createLogger({ level: 'debug', destination }), lines }
}
