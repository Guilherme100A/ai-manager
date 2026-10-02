import { api, createSession, randomPhone, sessionRow, useSessions } from './shared'
import { describe, expect, it } from 'vitest'
import { call } from '../helpers/app'
import { expectApiError } from '../helpers/http'

describe('T05 — criação de sessão', () => {
  const ctx = useSessions()

  it('AC-T05-01 POST /api/sessions {name, phone, note} → 201 com a sessão em NEW (persistida)', async () => {
    const phone = randomPhone()
    const res = await api(ctx, 'POST', '/api/sessions', { name: 'Atendimento', phone, note: 'loja centro' })
    expect(res.status, res.text).toBe(201)
    expect(res.body).toMatchObject({ name: 'Atendimento', phone, status: 'NEW', note: 'loja centro' })
    expect(typeof res.body.id).toBe('string')

    const row = sessionRow(ctx, res.body.id)
    expect(row, 'sessão não persistida').toBeDefined()
    expect(row).toMatchObject({ name: 'Atendimento', phone, status: 'NEW', note: 'loja centro' })

    const get = await api(ctx, 'GET', `/api/sessions/${res.body.id}`)
    expect(get.status, get.text).toBe(200)
    expect(get.body).toMatchObject({ id: res.body.id, status: 'NEW', phone })
  })

  it('AC-T05-01 criar sessão não conecta ao transporte (fica NEW até pedir QR/pareamento)', async () => {
    const s = await createSession(ctx)
    await new Promise((r) => setTimeout(r, 100))
    expect(ctx.tf.connectCount(s.id)).toBe(0)
    expect(sessionRow(ctx, s.id)!.status).toBe('NEW')
  })

  it('AC-T05-01 proxyId opcional vincula o proxy à sessão', async () => {
    const p = await api(ctx, 'POST', '/api/proxies', { url: `http://u:pw123@10.254.1.1:${3000 + Math.floor(Math.random() * 1000)}` })
    expect(p.status, p.text).toBe(201)
    const s = await createSession(ctx, { proxyId: p.body.id })
    expect(s.status).toBe('NEW')
    expect(s.proxyId).toBe(p.body.id)
    expect(sessionRow(ctx, s.id)!.proxy_id).toBe(p.body.id)
  })

  it('AC-T05-01 proxyId já vinculado a outra sessão → 409 PROXY_IN_USE', async () => {
    const p = await api(ctx, 'POST', '/api/proxies', { url: `http://u:pw123@10.254.1.2:${4000 + Math.floor(Math.random() * 1000)}` })
    expect(p.status, p.text).toBe(201)
    await createSession(ctx, { proxyId: p.body.id })
    const res = await api(ctx, 'POST', '/api/sessions', { name: 'outra', phone: randomPhone(), proxyId: p.body.id })
    expectApiError(res, 'PROXY_IN_USE', 409)
  })

  it.each([
    ['sem +', '5511999998888'],
    ['com máscara', '+55 (11) 99999-8888'],
    ['zero à esquerda', '+0551199998888'],
    ['longo demais', '+5511999998888777'],
    ['letras', '+55abc99998888'],
    ['vazio', ''],
  ])('AC-T05-01 telefone fora do E.164 (%s) → 400 VALIDATION_ERROR e nada é criado', async (_label, phone) => {
    const before = Number((await api(ctx, 'GET', '/api/sessions')).body?.items?.length ?? 0)
    const res = await api(ctx, 'POST', '/api/sessions', { name: 'x', phone })
    expectApiError(res, 'VALIDATION_ERROR', 400)
    const after = Number((await api(ctx, 'GET', '/api/sessions')).body?.items?.length ?? 0)
    expect(after).toBe(before)
  })

  it('AC-T05-01 body sem name → 400 VALIDATION_ERROR; sem phone (cadastro por QR) → 201 com phone null', async () => {
    expectApiError(await api(ctx, 'POST', '/api/sessions', { phone: randomPhone() }), 'VALIDATION_ERROR', 400)
    // O número passou a ser opcional: no QR o worker grava o número da conta quando o WhatsApp conecta.
    const res = await api(ctx, 'POST', '/api/sessions', { name: 'sem telefone' })
    expect(res.status).toBe(201)
    expect(res.body).toMatchObject({ name: 'sem telefone', phone: null, status: 'NEW' })
  })

  it('AC-T05-01 rotas de sessão exigem token (401 UNAUTHORIZED)', async () => {
    const res = await call(ctx.app, 'POST', '/api/sessions', { body: { name: 'x', phone: randomPhone() } })
    expectApiError(res, 'UNAUTHORIZED', 401)
  })
})
