// Ponto de registro das rotas (arquivo compartilhado: alterações somente aditivas, SPEC 2.4).
// Rotas de domínio montam sob `/api/*` (auth + auditoria já aplicados em app.ts).
import type { Hono } from 'hono'
import type { AppDeps, AppEnv } from '../types'
import { healthRoutes } from './health'
import { contactsRoutes } from './contacts'
import { proxiesRoutes } from './proxies'
import { sessionsRoutes } from './sessions'
import { groupsRoutes } from './groups'
import { conversationRoutes } from './conversations'
import { healthSessionRoutes } from './health-session'
import { messagesRoutes } from './messages'
import { limitsRoutes } from './messages-limits'
import { metricsRoutes } from '../observability/metrics-route'
import { webhooksRoutes } from './webhooks'
import { suggestionsRoutes } from './suggestions'
import { authRoutes } from './auth'
import { aiSettingsRoutes } from './ai-settings'
import { sessionLinksRoutes } from './session-links'
import { reportsRoutes } from './reports'

export function registerRoutes(app: Hono<AppEnv>, deps: AppDeps) {
  app.route('/', healthRoutes(deps))
  app.route('/', contactsRoutes(deps))
  app.route('/', proxiesRoutes(deps))
  app.route('/', sessionsRoutes(deps))
  app.route('/', groupsRoutes(deps))
  app.route('/', conversationRoutes(deps))
  app.route('/', healthSessionRoutes(deps))
  app.route('/', messagesRoutes(deps))
  // T09 — limites de envio por sessão
  app.route('/', limitsRoutes(deps))
  app.route('/', webhooksRoutes(deps))
  // T15 — GET /metrics (público, como /health)
  app.route('/', metricsRoutes(deps))
  // T13 — sugestões da IA com aprovação humana
  app.route('/', suggestionsRoutes(deps))
  // T17 — login de administrador do painel (/api/auth/login público; me/logout autenticados)
  app.route('/', authRoutes(deps))
  // T19 — configurações do modelo de LLM (GET/PUT /api/ai/settings, POST /api/ai/settings/test)
  app.route('/', aiSettingsRoutes(deps))
  app.route('/', sessionLinksRoutes(deps))
  // Relatório diário por chip (GET /api/reports/daily)
  app.route('/', reportsRoutes(deps))
}
