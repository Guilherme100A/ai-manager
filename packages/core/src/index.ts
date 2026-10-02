// @wsm/core — domínio: transport, estados, segurança, warm-up, health.
// Ponto de registro compartilhado (SPEC 2.4): cada tarefa adiciona seus exports aqui.
export const CORE_PACKAGE = '@wsm/core'

// T04 — transporte (WaTransport, BaileysTransport, FakeTransport)
export * from './transport'

// T02 — criptografia de credenciais, logger com redação e auth state no Postgres
export * from './crypto'
export * from './logger'
export * from './auth-state'

// T07 — contatos e consentimento (canMessage, opt-out, import CSV, ContactsService)
export * from './contacts'

// T06 — proxies (ProxyService, createProxyChecker, resolveSessionProxy, connectSession)
export * from './proxy'

// T05 — sessões (máquina de estados, SessionStore)
export * from './session'

// T14 — grupos (listagem via fetchGroups, SessionNotConnectedError)
export * from './groups'

// T10 — warm-up (cronograma baseado no baileys-antiban) e Health Score/HealthService
export * from './warmup'
export * from './health'

// T08 — fila de mensagens por sessão (MessageQueue, MessageStore, SessionQueueControl) e ponto único de entrega
export * from './queue'
export * from './send/deliver'

// T11 — alertas (ALERT_EVENTS, signWebhookBody, WebhookService, AlertDispatcher)
export * from './alerts'

// T15 — observabilidade (createMetrics, attachMetrics, createServiceLogger, contexto de log)
export * from './observability'

// T09 — motor de segurança (SendPipeline, GATE_ORDER), AntibanAdapter (baileys-antiban) e limites por sessão
export * from './send/pipeline'
export * from './antiban'
export * from './safety'

// T13 — IA assistiva (AiAssistant, AnthropicProvider, SuggestionService, aiConfigFromEnv)
export * from './ai'
export * from './session-router'
export * from './conversations'
