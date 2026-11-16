// Contrato do WaGateway (perfil ai-manager do CRM) contra o worker real do ai-manager com CRM_BRIDGE=on (ver vitest.config.mjs).
import { randomBytes } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Redis } from '../../apps/worker/node_modules/ioredis'
import { createTempDatabase, type TempDatabase } from '../../packages/db/src/index'
import { startWorker, type WorkerHandle } from '../../apps/worker/src/boot/start'
import { defineWaGatewayContract } from '@crm-copy/packages/wa-port/src/contract/index.ts'
import { createAiManagerGateway, detectAiManagerCapabilities } from '@crm-copy/packages/wa-gateway-rpc/src/profiles/ai-manager/detect.ts'
import { createWorkerContractHarness } from '@crm-copy/packages/wa-gateway-rpc/src/testing/index.ts'

const TOKEN = `crm-contract-${randomBytes(6).toString('hex')}`
const STREAM = `test:crm-contract:wsm:events:${randomBytes(4).toString('hex')}`
const REDIS_URL = process.env.REDIS_URL ?? 'redis://127.0.0.1:6379'

let tmp: TempDatabase
let redis: Redis
let worker: WorkerHandle
let workerOff: WorkerHandle

const env = (crmBridge: string) => ({
  DATABASE_URL: tmp.url,
  REDIS_URL,
  CREDENTIALS_KEY: randomBytes(32).toString('base64'),
  INTERNAL_TOKEN: TOKEN,
  WORKER_HEALTH_PORT: '0',
  WORKER_INTERNAL_PORT: '0',
  WORKER_INTERNAL_HOST: '127.0.0.1',
  QUEUE_PREFIX: `wsmcontract${randomBytes(4).toString('hex')}`,
  ANTIBAN_MODE: 'passthrough',
  LOG_LEVEL: 'silent',
  WA_TRANSPORT: 'fake',
  WA_EVENTS_STREAM: STREAM,
  CONVERSATIONS_AUTO_ROTATE: 'false',
  GROUP_AUTOMATION_AUTO_ENABLE: 'false',
  CRM_BRIDGE: crmBridge,
})

beforeAll(async () => {
  tmp = await createTempDatabase({ migrate: false, prefix: 'wsm_crm_contract' })
  redis = new Redis(REDIS_URL)
  worker = await startWorker({ env: env('on'), healthIntervalMs: 0 })
  workerOff = await startWorker({ env: { ...env('off'), WA_EVENTS_STREAM: `${STREAM}:off` }, healthIntervalMs: 0 })
})

afterAll(async () => {
  await worker?.stop()
  await workerOff?.stop()
  await redis?.del(STREAM)
  await redis?.quit()
  await tmp?.drop()
})

describe('detectAiManagerCapabilities contra o worker real', () => {
  it('CRM_BRIDGE=on: nenhum alvo aditivo ausente (A3/A7/A8)', async () => {
    const report = await detectAiManagerCapabilities({ url: worker.internal.url, token: TOKEN })
    console.log('[on] supported:', report.supported.join(','), '| missing:', report.missing.join(','), '| missingChanges:', report.missingChanges)
    expect(report.missingChanges).toEqual([])
    for (const m of ['send', 'sendGroup', 'downloadMedia', 'presence', 'listContacts', 'recordConsent', 'optOut']) expect(report.supported).toContain(m)
    // O que sobra em `missing` são métodos sem rota no perfil (react, deleteForEveryone, markRead, profile.*), não do worker.
    expect(report.missing.every((m) => !['send', 'sendGroup', 'downloadMedia', 'presence', 'listContacts', 'recordConsent', 'optOut'].includes(m))).toBe(true)
  })

  it('CRM_BRIDGE=off: o ai-manager de hoje (A3, A7 e A8 ausentes)', async () => {
    const report = await detectAiManagerCapabilities({ url: workerOff.internal.url, token: TOKEN })
    console.log('[off] missingChanges:', report.missingChanges)
    expect(report.missingChanges).toEqual(['A3', 'A7', 'A8'])
  })
})

defineWaGatewayContract('ai-manager REAL (worker crm-integracao, CRM_BRIDGE=on)', async () => {
  const gateway = await createAiManagerGateway({ url: worker.internal.url, token: TOKEN, redis, stream: STREAM, blockMs: 100, timeoutMs: 15_000 })
  return createWorkerContractHarness({
    gateway,
    url: worker.internal.url,
    token: TOKEN,
    fake: worker.fake!,
    queue: worker.queue,
    eventTimeoutMs: 5000,
  })
})

describe('stream do outbox (A1)', () => {
  it('toda entrada publicada pelo worker passa no parseWaEvent do CRM (@crm/wa-port)', async () => {
    const { safeParseWaEvent } = await import('@crm-copy/packages/wa-port/src/events.ts')
    const entries = await redis.xrange(STREAM, '-', '+')
    const types = new Map<string, number>()
    const invalid: unknown[] = []
    for (const [, fields] of entries) {
      expect(fields[0]).toBe('event')
      const r = safeParseWaEvent(fields[1])
      if (!r.success) invalid.push({ raw: fields[1], issues: r.error.issues })
      else types.set(r.data.type, (types.get(r.data.type) ?? 0) + 1)
    }
    console.log('[stream] entradas:', entries.length, Object.fromEntries(types))
    expect(invalid).toEqual([])
    for (const t of ['session.state', 'session.connection', 'session.qr', 'message.inbound', 'message.status']) expect(types.get(t) ?? 0).toBeGreaterThan(0)
  })
})
