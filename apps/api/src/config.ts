// Configuração do servidor a partir do ambiente (SPEC 3.5).
import { z } from 'zod'

const emptyAsUndefined = (v: unknown) => (v === '' ? undefined : v)

const schema = z.object({
  DATABASE_URL: z.string().min(1),
  REDIS_URL: z.string().min(1),
  API_TOKEN: z.string().min(1),
  LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal', 'silent']).default('info'),
  PORT: z.coerce.number().int().min(0).max(65535).default(3000),
  HOST: z.string().default('0.0.0.0'),
  // T16 — ponte com o worker (containers separados). Sem URL, a API opera só com o banco (modo degradado).
  WORKER_INTERNAL_URL: z.url().optional(),
  INTERNAL_TOKEN: z.string().min(1).optional(),
  // T17 — login de administrador do painel (defaults admin/nimda; sem AUTH_SECRET, segredo aleatório por processo).
  // Vazio (ex.: copiado do .env.example) = não definido.
  ADMIN_USERNAME: z.preprocess(emptyAsUndefined, z.string().min(1).optional()),
  ADMIN_PASSWORD: z.preprocess(emptyAsUndefined, z.string().min(1).optional()),
  AUTH_SECRET: z.preprocess(emptyAsUndefined, z.string().min(16).optional()),
  AUTH_SESSION_TTL_MS: z.preprocess(emptyAsUndefined, z.coerce.number().int().positive().optional()),
  // T17 — confiar em X-Forwarded-For (IP do limite de login) só atrás de um proxy que sobrescreve o header.
  TRUST_PROXY: z.preprocess(emptyAsUndefined, z.enum(['true', 'false', '1', '0', 'yes', 'no']).optional()),
  // Espião de funil: fila de links processada neste processo (off desliga). Com a chave do Serper a busca de posts é confiável.
  SPY_RUNNER: z.preprocess(emptyAsUndefined, z.enum(['on', 'off']).default('on')),
  SPY_SERPER_KEY: z.preprocess(emptyAsUndefined, z.string().min(1).optional()),
}).refine((c) => !c.WORKER_INTERNAL_URL || c.INTERNAL_TOKEN, { path: ['INTERNAL_TOKEN'], message: 'required with WORKER_INTERNAL_URL' })

export type ApiConfig = z.output<typeof schema>

export function loadConfig(env: Record<string, string | undefined> = process.env): ApiConfig {
  const parsed = schema.safeParse(env)
  if (!parsed.success) {
    const fields = parsed.error.issues.map((i) => i.path.join('.')).join(', ')
    throw new Error(`invalid API configuration: ${fields}`)
  }
  return parsed.data
}
