// Factories de transporte do SessionManager. WA_TRANSPORT=fake usa o FakeTransport (testes, sem WhatsApp real).
import { BaileysTransport, FakeTransport, browserForSession, type BaileysTransportOptions, type DisappearingStore, type WaTransport } from '@wsm/core'
import type { TransportFactory } from './manager'

export type TransportKind = 'baileys' | 'fake'

export function transportKindFromEnv(env: NodeJS.ProcessEnv = process.env): TransportKind {
  return env.WA_TRANSPORT?.trim().toLowerCase() === 'fake' ? 'fake' : 'baileys'
}

export interface FakeTransportFactory {
  factory: TransportFactory
  /** Todos os transportes criados por sessão, em ordem. */
  created: Map<string, FakeTransport[]>
  /** Último transporte criado para a sessão. */
  last(sessionId: string): FakeTransport | undefined
}

/** Factory de FakeTransport que guarda as instâncias criadas (para os testes dirigirem os eventos). */
export function createFakeTransportFactory(): FakeTransportFactory {
  const created = new Map<string, FakeTransport[]>()
  const factory: TransportFactory = (sessionId) => {
    const t = new FakeTransport()
    created.set(sessionId, [...(created.get(sessionId) ?? []), t])
    return t
  }
  return { factory, created, last: (sessionId) => created.get(sessionId)?.at(-1) }
}

/** Factory a partir do ambiente: `WA_TRANSPORT=fake` → FakeTransport; senão BaileysTransport. */
export function createTransportFactory(
  opts: { kind?: TransportKind; baileys?: BaileysTransportOptions; disappearing?: (sessionId: string) => DisappearingStore; stickers?: BaileysTransportOptions['stickers'] } = {},
): TransportFactory {
  const kind = opts.kind ?? transportKindFromEnv()
  if (kind === 'fake') return createFakeTransportFactory().factory
  return (sessionId): WaTransport =>
    new BaileysTransport({
      ...opts.baileys,
      ...(opts.disappearing ? { disappearing: opts.disappearing(sessionId) } : {}),
      ...(opts.stickers ? { stickers: opts.stickers } : {}),
      socketConfig: {
        ...opts.baileys?.socketConfig,
        browser: browserForSession(sessionId),
      },
    })
}
