// Máquina de estados da sessão (SPEC 3.2). Fonte única de domínio para estados e transições.
import { SESSION_STATUSES, type SessionStatus } from '@wsm/db'

export const SESSION_STATES = SESSION_STATUSES
export type SessionState = SessionStatus

export const SESSION_INDICATORS: Record<SessionState, { icon: string; label: string; description: string }> = {
  NEW: { icon: '⚫', label: 'New', description: 'criada, ainda não autenticada' },
  WARMING: { icon: '🟡', label: 'Warm-up', description: 'conectada, dentro do período de warm-up' },
  STABLE: { icon: '🟢', label: 'Connected', description: 'conectada, warm-up concluído' },
  DEGRADED: { icon: '🟠', label: 'Degraded', description: 'conectada, health score em alerta' },
  PAUSED: { icon: '🔴', label: 'Paused', description: 'envio suspenso (manual ou automático)' },
  DISCONNECTED: { icon: '⚫', label: 'Disconnected', description: 'sem conexão / deslogada' },
}

/**
 * Transições permitidas (SPEC 3.2). Mesmo estado → mesmo estado nunca é transição.
 * - NEW → WARMING (autenticou)
 * - WARMING → STABLE (warm-up 100%)
 * - WARMING|STABLE → DEGRADED; DEGRADED → WARMING|STABLE (health recuperado)
 * - WARMING|STABLE|DEGRADED → PAUSED; PAUSED → WARMING|STABLE (somente resume manual)
 * - * → DISCONNECTED; DISCONNECTED → NEW (re-autenticação)
 */
export const SESSION_TRANSITIONS: Record<SessionState, readonly SessionState[]> = {
  NEW: ['WARMING', 'DISCONNECTED'],
  WARMING: ['STABLE', 'DEGRADED', 'PAUSED', 'DISCONNECTED'],
  STABLE: ['DEGRADED', 'PAUSED', 'DISCONNECTED'],
  DEGRADED: ['WARMING', 'STABLE', 'PAUSED', 'DISCONNECTED'],
  PAUSED: ['WARMING', 'STABLE', 'DISCONNECTED'],
  DISCONNECTED: ['NEW'],
}

/** Estados com a conta autenticada e conexão esperada. */
export const CONNECTED_STATES: readonly SessionState[] = ['WARMING', 'STABLE', 'DEGRADED', 'PAUSED']
/**
 * Estados que permitem envio (SESSION_NOT_CONNECTED fora deles, SPEC 3.4). DEGRADED envia em ritmo reduzido
 * (DEGRADED_LIMIT_FACTOR nos limites), como o baileys-antiban: parar de vez não reduz quedas e só atrasa o aquecimento.
 */
export const SENDABLE_STATES: readonly SessionState[] = ['WARMING', 'STABLE', 'DEGRADED']

export function isSessionState(value: unknown): value is SessionState {
  return typeof value === 'string' && (SESSION_STATES as readonly string[]).includes(value)
}

export function canTransition(from: SessionState, to: SessionState): boolean {
  return SESSION_TRANSITIONS[from].includes(to)
}

export class InvalidTransitionError extends Error {
  readonly code = 'INVALID_TRANSITION'
  constructor(
    readonly from: SessionState,
    readonly to: SessionState | string,
    message = `invalid session transition: ${from} → ${to}`,
  ) {
    super(message)
    this.name = 'InvalidTransitionError'
  }
}

export function assertTransition(from: SessionState, to: SessionState): void {
  if (!canTransition(from, to)) throw new InvalidTransitionError(from, to)
}

/** Ações manuais sobre a sessão (API) e os estados de origem em que cada uma é válida. */
export type SessionAction = 'pause' | 'resume' | 'restart' | 'logout' | 'connect'

export const ACTION_SOURCES: Record<SessionAction, readonly SessionState[]> = {
  pause: ['WARMING', 'STABLE', 'DEGRADED'],
  resume: ['PAUSED'],
  // restart não muda o estado: fecha e reabre a conexão (aplica troca de proxy).
  restart: ['NEW', 'WARMING', 'STABLE', 'DEGRADED', 'PAUSED'],
  logout: ['NEW', 'WARMING', 'STABLE', 'DEGRADED', 'PAUSED'],
  // Iniciar autenticação (QR/pairing): só sessões ainda não autenticadas (DISCONNECTED passa por NEW).
  connect: ['NEW', 'DISCONNECTED'],
}

export function assertAction(action: SessionAction, from: SessionState): void {
  if (!ACTION_SOURCES[action].includes(from)) {
    throw new InvalidTransitionError(from, action, `action "${action}" not allowed in state ${from}`)
  }
}
