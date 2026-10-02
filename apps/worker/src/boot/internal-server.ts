// Servidor interno do worker (rede do compose, Bearer INTERNAL_TOKEN):
//  - POST /internal/rpc: ponte API ↔ worker. A API usa clientes com as MESMAS interfaces (SessionsControl,
//    MessagesControl + enqueue, HealthControl); os erros de domínio viajam serializados e são recriados na API.
//  - /internal/fake/*: controle do FakeTransport, montado SÓ quando WA_TRANSPORT=fake.
import { timingSafeEqual } from 'node:crypto'
import type { AddressInfo } from 'node:net'
import { serve, type ServerType } from '@hono/node-server'
import { Hono, type Context } from 'hono'
import { TransportNotConnectedError, type GroupInviteInput, type EnqueueMessageInput, type GroupSummary, type ListMessagesFilter, type WaTransport } from '@wsm/core'
import type { FakeControl } from './fake-control'

/** Operações do worker expostas à API. */
export interface BridgeTargets {
  sessions: {
    runGroupInvite?(input: GroupInviteInput): Promise<unknown>
    create(input: never): Promise<unknown>
    list(): Promise<unknown>
    get(id: string): Promise<unknown>
    startQr(id: string): Promise<unknown>
    getQr(id: string): Promise<unknown>
    requestPairingCode(id: string, phone?: string): Promise<unknown>
    pause(id: string): Promise<unknown>
    resume(id: string): Promise<unknown>
    restart(id: string): Promise<unknown>
    logout(id: string): Promise<unknown>
    getTransport(id: string): WaTransport | undefined
    isConnected(id: string): boolean
    /** T20 — adiciona UM número a um grupo (checagens e freio no GroupParticipantService). */
    addGroupParticipant?(adminSessionId: string, groupId: string, targetSessionId: string): Promise<unknown>
  }
  messages: {
    get(id: string): Promise<unknown>
    list(filter?: ListMessagesFilter): Promise<unknown>
    events(id: string): Promise<unknown>
    cancel(id: string): Promise<unknown>
    enqueue(input: EnqueueMessageInput): Promise<unknown>
  }
  health: { getHealth(sessionId: string): Promise<unknown> }
}

type Handler = (args: unknown[]) => Promise<unknown>

/** Métodos permitidos pela ponte (lista fechada). */
export function bridgeHandlers(t: BridgeTargets): Record<string, Record<string, Handler>> {
  const s = t.sessions
  const m = t.messages
  const str = (v: unknown) => String(v)
  return {
    sessions: {
      runGroupInvite: async ([input]) => {
        if (!s.runGroupInvite) throw new Error('runGroupInvite not available')
        return s.runGroupInvite(input as GroupInviteInput)
      },
      create: ([input]) => s.create(input as never),
      list: () => s.list(),
      get: ([id]) => s.get(str(id)),
      startQr: ([id]) => s.startQr(str(id)),
      getQr: ([id]) => s.getQr(str(id)),
      requestPairingCode: ([id, phone]) => s.requestPairingCode(str(id), phone === undefined || phone === null ? undefined : str(phone)),
      pause: ([id]) => s.pause(str(id)),
      resume: ([id]) => s.resume(str(id)),
      restart: ([id]) => s.restart(str(id)),
      logout: ([id]) => s.logout(str(id)),
      fetchGroups: async ([id]): Promise<GroupSummary[]> => {
        const transport = s.getTransport(str(id))
        if (!transport || !s.isConnected(str(id))) throw new TransportNotConnectedError()
        return transport.fetchGroups()
      },
      // T20: um alvo por chamada; sem a implementação (ex.: testes antigos) o método responde erro.
      addGroupParticipant: async ([adminSessionId, groupId, targetSessionId]) => {
        if (!s.addGroupParticipant) throw new Error('addGroupParticipant not available')
        return s.addGroupParticipant(str(adminSessionId), str(groupId), str(targetSessionId))
      },
    },
    messages: {
      get: ([id]) => m.get(str(id)),
      list: ([filter]) => m.list((filter ?? {}) as ListMessagesFilter),
      events: ([id]) => m.events(str(id)),
      cancel: ([id]) => m.cancel(str(id)),
      enqueue: ([input]) => m.enqueue(input as EnqueueMessageInput),
    },
    health: {
      getHealth: ([id]) => t.health.getHealth(str(id)),
    },
  }
}

/** Erro serializado: nome, mensagem e as propriedades que as rotas usam para mapear o código HTTP. */
export interface SerializedError {
  name: string
  message: string
  code?: unknown
  [key: string]: unknown
}

const ERROR_FIELDS = ['code', 'from', 'to', 'messageId', 'sessionId', 'proxyId', 'details', 'gate', 'status', 'reason']

export function serializeError(err: unknown): SerializedError {
  if (!(err instanceof Error)) return { name: 'Error', message: String(err) }
  const out: SerializedError = { name: err.name, message: err.message }
  for (const k of ERROR_FIELDS) {
    const v = (err as unknown as Record<string, unknown>)[k]
    if (v !== undefined) out[k] = v
  }
  return out
}

export function tokenOk(header: string | undefined, token: string): boolean {
  const m = /^Bearer\s+(.+)$/i.exec(header ?? '')
  if (!m) return false
  const a = Buffer.from(m[1]!.trim())
  const b = Buffer.from(token)
  return a.length === b.length && timingSafeEqual(a, b)
}

export interface InternalAppOptions {
  token: string
  targets: BridgeTargets
  /** Presente só com WA_TRANSPORT=fake. */
  fake?: FakeControl
  logger?: { error(obj: object, msg?: string): void }
}

const body = async (c: Context): Promise<Record<string, unknown>> => {
  const text = await c.req.text()
  if (!text.trim()) return {}
  const parsed = JSON.parse(text) as unknown
  return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {}
}

export function createInternalApp(opts: InternalAppOptions) {
  const handlers = bridgeHandlers(opts.targets)
  const app = new Hono()

  app.use('/internal/*', async (c, next) => {
    if (!tokenOk(c.req.header('authorization'), opts.token)) return c.json({ error: { code: 'UNAUTHORIZED', message: 'invalid internal token' } }, 401)
    await next()
  })

  app.post('/internal/rpc', async (c) => {
    let req: Record<string, unknown>
    try {
      req = await body(c)
    } catch {
      return c.json({ error: { name: 'SyntaxError', message: 'malformed JSON' } }, 400)
    }
    const target = String(req.target)
    const method = String(req.method)
    // Só métodos próprios da lista fechada (nunca propriedades herdadas como `constructor`).
    const fn = Object.hasOwn(handlers, target) && Object.hasOwn(handlers[target]!, method) ? handlers[target]![method] : undefined
    if (!fn) return c.json({ error: { name: 'RpcError', code: 'UNKNOWN_METHOD', message: `unknown method ${String(req.target)}.${String(req.method)}` } }, 400)
    try {
      const result = await fn(Array.isArray(req.args) ? req.args : [])
      return c.json({ result: result ?? null })
    } catch (err) {
      const e = serializeError(err)
      if (!['SessionError', 'InvalidTransitionError', 'MessageNotFoundError', 'MessageTransitionError', 'ProxyError', 'ProxyUnavailableError', 'TransportNotConnectedError', 'GroupAddError'].includes(e.name)) {
        opts.logger?.error({ err: e, target: req.target, method: req.method }, 'internal rpc failed')
      }
      return c.json({ error: e })
    }
  })

  const fake = opts.fake
  if (fake) {
    const id = (c: Context) => c.req.param('id') ?? ''
    const run = async (c: Context, fn: (b: Record<string, unknown>) => unknown | Promise<unknown>) => {
      try {
        const out = await fn(await body(c))
        return c.json(out === undefined ? { ok: true } : (out as object))
      } catch (err) {
        const e = serializeError(err)
        const status = e.code === 'FAKE_TRANSPORT_NOT_FOUND' ? 404 : e.name === 'SyntaxError' ? 400 : 500
        return c.json({ error: e }, status)
      }
    }
    const ms = (v: unknown) => {
      const n = Number(v)
      if (!Number.isFinite(n) || n < 0) throw Object.assign(new Error('ms must be >= 0'), { name: 'SyntaxError' })
      return n
    }
    app.get('/internal/fake/boot', (c) => c.json({ bootId: fake.bootId }))
    app.get('/internal/fake/sessions/:id/state', (c) => c.json(fake.state(id(c))))
    app.get('/internal/fake/sessions/:id/sent-history', (c) => run(c, async () => ({ items: await fake.history(id(c)) })))
    app.post('/internal/fake/sessions/:id/qr', (c) => run(c, (b) => fake.qr(id(c), b.qr === undefined ? undefined : String(b.qr))))
    app.post('/internal/fake/sessions/:id/pairing-code', (c) => run(c, (b) => fake.pairingCode(id(c), b.code === undefined ? undefined : String(b.code))))
    app.post('/internal/fake/sessions/:id/open', (c) => run(c, () => fake.open(id(c))))
    app.post('/internal/fake/sessions/:id/close', (c) =>
      run(c, (b) => {
        const reason = String(b.reason ?? 'transient')
        if (!['loggedOut', 'forbidden', 'transient'].includes(reason)) throw Object.assign(new Error('invalid reason'), { name: 'SyntaxError' })
        return fake.close(id(c), reason as 'loggedOut' | 'forbidden' | 'transient', b.statusCode === undefined ? undefined : Number(b.statusCode))
      }),
    )
    app.post('/internal/fake/sessions/:id/receive', (c) =>
      run(c, (b) => {
        if (typeof b.from !== 'string' || !b.from) throw Object.assign(new Error('from is required'), { name: 'SyntaxError' })
        const msg: { from: string; text?: string; fromMe?: boolean; type?: string } = { from: b.from }
        if (typeof b.text === 'string') msg.text = b.text
        if (typeof b.fromMe === 'boolean') msg.fromMe = b.fromMe
        if (typeof b.type === 'string') msg.type = b.type
        return fake.receive(id(c), msg)
      }),
    )
    app.post('/internal/fake/sessions/:id/receipt', (c) =>
      run(c, (b) => {
        const status = String(b.status ?? 'delivered')
        if (typeof b.messageId !== 'string' || !['delivered', 'read'].includes(status)) {
          throw Object.assign(new Error('messageId and status (delivered|read) are required'), { name: 'SyntaxError' })
        }
        return fake.receipt(id(c), b.messageId, status as 'delivered' | 'read')
      }),
    )
    app.post('/internal/fake/sessions/:id/fail-next-send', (c) =>
      run(c, (b) => {
        const opts: { message?: string; statusCode?: number } = {}
        if (typeof b.message === 'string') opts.message = b.message
        if (b.statusCode !== undefined) opts.statusCode = Number(b.statusCode)
        return fake.failNextSend(id(c), opts)
      }),
    )
    app.put('/internal/fake/sessions/:id/groups', (c) => run(c, (b) => fake.setGroups(id(c), (Array.isArray(b.groups) ? b.groups : []) as GroupSummary[])))
    app.post('/internal/fake/sessions/:id/send-delay', (c) => run(c, (b) => fake.setSendDelay(id(c), ms(b.ms))))
    app.post('/internal/fake/sessions/:id/hold-before-send', (c) => run(c, (b) => fake.setHoldBeforeSend(id(c), ms(b.ms))))
  }

  app.notFound((c) => c.json({ error: { code: 'NOT_FOUND', message: `route not found: ${c.req.method} ${c.req.path}` } }, 404))
  return app
}

export interface InternalServer {
  url: string
  port: number
  close(): Promise<void>
}

export async function startInternalServer(opts: InternalAppOptions & { port: number; host?: string }): Promise<InternalServer> {
  const app = createInternalApp(opts)
  const host = opts.host ?? '0.0.0.0'
  const server: ServerType = await new Promise((resolve, reject) => {
    const s = serve({ fetch: app.fetch, port: opts.port, hostname: host }, () => resolve(s))
    s.once('error', reject)
  })
  const port = (server.address() as AddressInfo).port
  return {
    url: `http://${host === '0.0.0.0' ? '127.0.0.1' : host}:${port}`,
    port,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  }
}
