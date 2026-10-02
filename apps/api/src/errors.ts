// Erros padronizados da API (SPEC 3.4): `{ error: { code, message, details? } }`.
import type { Context } from 'hono'
import { HTTPException } from 'hono/http-exception'
import type { ContentfulStatusCode } from 'hono/utils/http-status'
import { ZodError } from 'zod'
import type { AppEnv } from './types'

export const ERROR_STATUS = {
  UNAUTHORIZED: 401,
  VALIDATION_ERROR: 400,
  SESSION_NOT_FOUND: 404,
  SESSION_NOT_CONNECTED: 409,
  INVALID_TRANSITION: 409,
  PROXY_IN_USE: 409,
  CONTACT_NOT_ALLOWED: 403,
  WARMUP_LIMIT: 429,
  RATE_LIMIT: 429,
  // Genéricos (fora da tabela 3.4): rota inexistente e falha inesperada.
  NOT_FOUND: 404,
  INTERNAL_ERROR: 500,
  GROUP_INVITE_FAILED: 502,
} as const satisfies Record<string, ContentfulStatusCode>

export type ErrorCode = keyof typeof ERROR_STATUS

export interface ErrorBody {
  error: { code: ErrorCode; message: string; details?: unknown }
}

/** Erro de domínio da API. Lance em handlers; `onError` converte para o formato 3.4. */
export class ApiError extends Error {
  readonly status: ContentfulStatusCode

  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly details?: unknown,
  ) {
    super(message)
    this.name = 'ApiError'
    this.status = ERROR_STATUS[code]
  }
}

export interface ValidationIssue {
  /** Caminho do campo em notação de pontos (ex.: `address.port`, `items.0.id`). */
  path: string
  message: string
  code: string
}

export function zodIssues(err: ZodError): ValidationIssue[] {
  return err.issues.map((i) => ({ path: i.path.map(String).join('.'), message: i.message, code: i.code }))
}

export function validationError(err: ZodError): ApiError {
  const issues = zodIssues(err)
  const fields = [...new Set(issues.map((i) => i.path).filter(Boolean))]
  const message = fields.length ? `invalid fields: ${fields.join(', ')}` : 'invalid request'
  return new ApiError('VALIDATION_ERROR', message, { issues })
}

/** Normaliza qualquer erro lançado para um `ApiError`. */
export function toApiError(err: unknown): ApiError {
  if (err instanceof ApiError) return err
  if (err instanceof ZodError) return validationError(err)
  // `await c.req.json()` com corpo malformado lança SyntaxError do JSON.parse.
  if (err instanceof SyntaxError) return new ApiError('VALIDATION_ERROR', 'malformed JSON body')
  if (err instanceof HTTPException) {
    if (err.status === 401) return new ApiError('UNAUTHORIZED', err.message || 'unauthorized')
    // Hono lança HTTPException 400 para JSON malformado / content-type inválido.
    if (err.status === 400) return new ApiError('VALIDATION_ERROR', err.message || 'invalid request body')
    if (err.status === 404) return new ApiError('NOT_FOUND', err.message || 'not found')
  }
  return new ApiError('INTERNAL_ERROR', 'internal server error')
}

export function errorBody(err: ApiError): ErrorBody {
  const body: ErrorBody = { error: { code: err.code, message: err.message } }
  if (err.details !== undefined) body.error.details = err.details
  return body
}

export function onError(err: Error, c: Context<AppEnv>) {
  const apiErr = toApiError(err)
  const log = c.get('logger')
  if (apiErr.status >= 500) log?.error({ err }, 'unhandled error')
  else log?.debug({ code: apiErr.code }, apiErr.message)
  return c.json(errorBody(apiErr), apiErr.status)
}

export function notFound(c: Context<AppEnv>) {
  return c.json(errorBody(new ApiError('NOT_FOUND', `route not found: ${c.req.method} ${c.req.path}`)), 404)
}
