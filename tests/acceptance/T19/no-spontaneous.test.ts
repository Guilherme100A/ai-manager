import { ENV_AI } from './env'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { fakeProviderFactory, newKey } from './shared'
import { rootPath } from '../helpers/exec'
import { api, C, connectedSession, createContact, delay, outboundCount, suggestionCount, useQueue, W } from '../T13/shared'

const SKIP = new Set(['node_modules', 'dist', 'build', 'coverage', '.turbo'])
function walk(dir: string, out: string[] = []): string[] {
  for (const n of readdirSync(dir)) {
    if (SKIP.has(n)) continue
    const p = join(dir, n)
    if (statSync(p).isDirectory()) walk(p, out)
    else if (/\.(ts|tsx|js|mjs)$/.test(n)) out.push(p)
  }
  return out
}
const rel = (f: string) => relative(rootPath(), f).split(sep).join('/')
// Fluxo de convite entre sessões e automação de grupos (posteriores ao T19): únicos módulos (e seus testes)
// que podem aceitar convite. Mesma lista do T14 (AC-T14-03).
const INVITE_FLOW_FILES = new Set(
  ['packages/core/src/transport/baileys', 'packages/core/src/transport/types', 'packages/core/src/groups/invites', 'apps/worker/src/groups/automation']
    .flatMap((f) => [`${f}.ts`, `${f}.unit.test.ts`]),
)

describe('T19 — configurações não criam geração/envio espontâneo nem entrada em grupos', () => {
  const ctx = useQueue() as any
  const provider = fakeProviderFactory()
  let ai: { stop(): unknown; idle(): Promise<void> }

  beforeAll(async () => {
    const settings = new C.AiSettingsService({ db: ctx.db, env: { ...ENV_AI } })
    const assistant = new C.AiAssistant({ settings, providerFactory: provider.factory, refreshMs: 0, logger: ctx.logger })
    ai = await W.attachAi(ctx.manager, { db: ctx.db, assistant, logger: ctx.logger })
  })
  afterAll(async () => {
    await ai?.stop()
  })

  it('AC-T19-06 salvar e alternar as configurações não gera sugestão, chamada de classificação nem envio', async () => {
    const { id, t } = await connectedSession(ctx)
    await createContact(ctx)
    const calls = provider.calls.length
    for (const body of [{ apiKey: newKey(), enabled: true }, { modelSmall: 'x-1' }, { enabled: false }, { enabled: true }, { modelLarge: 'y-2', confidenceThreshold: 0.2 }]) {
      const r = await api(ctx, 'PUT', '/api/ai/settings', body)
      expect(r.status, r.text).toBe(200)
    }
    await delay(500)
    await ai.idle()
    expect(suggestionCount(ctx, id), 'configurações geraram sugestão sem mensagem recebida').toBe(0)
    expect(outboundCount(ctx, id)).toBe(0)
    expect(t.sent).toHaveLength(0)
    expect(provider.calls.slice(calls), 'nenhuma classificação sem mensagem recebida').toHaveLength(0)
  })

  it('AC-T19-06 mensagem recebida continua sendo o único gatilho: gera sugestão pendente e nada é enviado sem aprovação', async () => {
    const { id, t } = await connectedSession(ctx)
    const contact = await createContact(ctx)
    await api(ctx, 'PUT', '/api/ai/settings', { apiKey: newKey(), enabled: true })
    t.receive({ from: `${contact.phone.slice(1)}@s.whatsapp.net`, text: 'quanto custa o plano?' })
    await ai.idle()
    expect(suggestionCount(ctx, id)).toBe(1)
    await delay(300)
    expect(outboundCount(ctx, id), 'nada é enviado sem aprovação humana').toBe(0)
    expect(t.sent).toHaveLength(0)
  })

  it('AC-T19-06 nenhuma rota de IA dispara geração ou envio (só /api/ai/settings, /settings/test e as sugestões do T13)', async () => {
    for (const [method, path] of [
      ['POST', '/api/ai/generate'],
      ['POST', '/api/ai/suggest'],
      ['POST', '/api/ai/send'],
      ['POST', '/api/ai/run'],
      ['POST', '/api/ai/settings/run'],
      ['POST', '/api/ai/groups/join'],
    ] as const) {
      const r = await api(ctx, method, path, { text: 'oi' })
      expect([404, 405], `${method} ${path} → ${r.status}`).toContain(r.status)
    }
  })

  it('AC-T19-06 aceitar convite/entrar em grupo só aparece nos módulos do fluxo de convite (nunca na configuração da IA)', () => {
    const forbidden = new RegExp(['group', 'Accept', 'Invite'].join('') + '|acceptInvite|joinGroup|groupJoin|autoJoin', 'i')
    const files = [...walk(rootPath('apps')), ...walk(rootPath('packages'))]
    const hits = files.filter((f) => forbidden.test(readFileSync(f, 'utf8'))).map(rel)
    expect(hits.filter((f) => !INVITE_FLOW_FILES.has(f)), `ocorrências fora do fluxo: ${hits.join(', ')}`).toEqual([])
  })

  it('AC-T19-06 o código novo de configuração da IA não agenda gerações (sem setInterval/cron que chame suggest/generate)', () => {
    const files = [...walk(rootPath('packages/core/src/ai')), ...walk(rootPath('apps/worker/src/ai')), ...walk(rootPath('apps/api/src/routes'))]
      .filter((f) => /ai/i.test(f) && !/\.test\.tsx?$/.test(f))
    for (const f of files) {
      const src = readFileSync(f, 'utf8')
      const scheduled = /(setInterval|cron|schedule)\s*\([^)]*\)[\s\S]{0,300}(suggest|generate)\s*\(/.test(src)
      expect(scheduled, `${rel(f)} parece agendar geração espontânea`).toBe(false)
    }
  })
})
