// Liga a fila de mensagens (T08) ao SessionManager (T05):
// - estado → PAUSED pausa a fila da sessão; saída de PAUSED a retoma (AC-T08-05);
// - conexão aberta inicia o Worker da sessão e liga os receipts do transporte (AC-T08-02);
// - o transporte só é entregue à fila enquanto a sessão está conectada.
import type { AntibanAdapter, MessageQueue, WaTransport } from '@wsm/core'
import type { SessionManager } from '../sessions'

export interface AttachQueueOptions {
  logger?: { error(obj: object, msg?: string): void }
  /** Recebe as confirmações de entrega: o AntiBan usa a taxa de entrega para ajustar os limites. */
  antiban?: Pick<AntibanAdapter, 'onDelivered'>
}

/** Devolve uma função que desfaz a ligação. Chame antes de conectar as sessões. */
export function attachQueueToSessions(manager: SessionManager, queue: MessageQueue, opts: AttachQueueOptions = {}): () => void {
  const wired = new WeakSet<WaTransport>()
  const fail = (sessionId: string, what: string) => (err: unknown) =>
    opts.logger?.error({ session_id: sessionId, err: err instanceof Error ? err.message : String(err) }, what)

  queue.setTransportProvider((sessionId) => (manager.isConnected(sessionId) ? manager.getTransport(sessionId) : undefined))

  const onState = ({ sessionId, from, to }: { sessionId: string; from: string; to: string }) => {
    if (to === 'PAUSED') void queue.pause(sessionId).catch(fail(sessionId, 'queue pause failed'))
    else if (from === 'PAUSED') void queue.resume(sessionId).catch(fail(sessionId, 'queue resume failed'))
  }

  const onConnected = ({ sessionId, transport }: { sessionId: string; transport: WaTransport }) => {
    if (!wired.has(transport)) {
      wired.add(transport)
      transport.on('receipt', (r) => {
        // O transporte pode ter sido substituído (restart); receipts do antigo ainda valem para mensagens dele.
        opts.antiban?.onDelivered(sessionId, r.messageId)
        void queue.handleReceipt(sessionId, r).catch(fail(sessionId, 'receipt handling failed'))
      })
    }
    void queue.startSession(sessionId).catch(fail(sessionId, 'queue worker start failed'))
  }

  manager.on('state', onState)
  manager.on('connected', onConnected)
  return () => {
    manager.off('state', onState)
    manager.off('connected', onConnected)
    queue.setTransportProvider(undefined)
  }
}
