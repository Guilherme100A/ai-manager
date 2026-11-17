// CI-only process fixture: real HTTP + disposable PostgreSQL; no worker, Redis or external providers.
import { serve } from '@hono/node-server'
import { createDb } from '@wsm/db'
import { createApp } from '../../app'
import { captureLogger, fakeRedis } from '../../test-utils'

const db = createDb(process.env.AUTH_TEST_DATABASE_URL!, { max: 2 })
const app = createApp({
  db, redis: fakeRedis(), logger: captureLogger().logger, apiToken: 'synthetic-integration-token',
  auth: { username: 'admin', password: 'synthetic-password', secret: 'synthetic-persistent-restart-secret', now: () => new Date(process.env.AUTH_TEST_NOW!) },
})
const server = serve({ fetch: app.fetch, hostname: '127.0.0.1', port: 0 })
server.once('listening', () => { const address = server.address(); if (address && typeof address !== 'string') process.send?.({ ready: true, port: address.port }) })
process.on('message', message => {
  if (message !== 'stop') return
  server.close(() => { void db.$client.end().then(() => process.exit(0)) })
  const closeConnections = (server as { closeAllConnections?: () => void }).closeAllConnections
  closeConnections?.call(server)
})
