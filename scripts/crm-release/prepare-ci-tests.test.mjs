import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'
import { adaptReviewerSuite, assertIntegrationComplete, REVIEWER_SHA256, adaptedFile } from './prepare-ci-tests.mjs'
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
// The frozen public test is already fully present as an added file in patch01.
// Read it; no CRM checkout/dependencies/build/service is created by these tests.
const patch = fs.readFileSync(path.join(root, 'integrations/shared-offers/01-existing-prerequisites.patch'), 'utf8').replace(/\r\n/g, '\n')
const section = patch.split(/(?=^diff --git )/m).find(x => x.startsWith('diff --git a/tests/acceptance/T125/revisor-shared-offers.test.ts '))
assert.ok(section)
const source = section.split('\n').filter(x => x.startsWith('+') && !x.startsWith('+++')).map(x => x.slice(1)).join('\n') + '\n'
assert.equal(createHash('sha256').update(source).digest('hex'), REVIEWER_SHA256)
test('adapter scopes tenant, restores env and aligns only the strict foreign-company gate assertion', () => {
  const adapted = adaptReviewerSuite(source)
  assert.ok(adapted.includes('t = await tenant(sys)\n  process.env.SHARED_OFFERS_COMPANY_ID = t.companyId'))
  const before = source.split('\n').filter(x => x.includes('expect(')), after = adapted.split('\n').filter(x => x.includes('expect('))
  assert.deepEqual(after, before.map(line => line.replace("expect((await foreign.c.put('/api/offers/' + a.id, a)).status).toBe(422)", "expect((await foreign.c.put('/api/offers/' + a.id, a)).status).toBe(404)")))
  assert.ok(adapted.includes('expect(invalid.status, invalid.text).toBe(422)'))
  assert.ok(adapted.includes("allowed_events: ['Purchase', 'Lead', 'InitiateCheckout', 'Contact']"))
  assert.ok(adapted.includes("await p.getByRole('button',{name:/UI shared offer/}).waitFor()\n      expect(await p.getByRole('button',{name:/UI shared offer/}).count()).toBe(1)"))
  assert.deepEqual(adapted.split('\n').filter(x => /\bit\(/.test(x)), source.split('\n').filter(x => /\bit\(/.test(x)))
  assert.ok(adapted.includes('finally {\n    if (__ciOriginalOffersGate === undefined) delete'))
})
test('CRLF source accepted without changing original normalized content', () => assert.equal(adaptReviewerSuite(source.replaceAll('\n', '\r\n')), adaptReviewerSuite(source)))
test('drift or second adaptation rejected; no unreviewed fixture substitution', () => { assert.throws(() => adaptReviewerSuite(source + '// drift')); assert.throws(() => adaptReviewerSuite(adaptReviewerSuite(source))) })
for (const initial of [undefined, '', 'other-fixture']) for (const cleanupFails of [false, true]) test('fixture lifecycle restores ' + String(initial) + ', cleanup failure=' + cleanupFails, async () => {
  const adapted = adaptReviewerSuite(source)
  const saved = adapted.match(/^const __ciOriginalOffersGate = .*$/m)[0]
  const setup = adapted.match(/  t = await tenant\(sys\)\n  process.env.SHARED_OFFERS_COMPANY_ID = t.companyId/)[0]
  const cleanup = adapted.match(/  } finally \{\n    if \(__ciOriginalOffersGate.*\n    else .*\n  }/)[0]
  const env = initial === undefined ? {} : { SHARED_OFFERS_COMPANY_ID: initial }
  const context = { process: { env }, tenant: async () => ({ companyId: '11111111-1111-4111-8111-111111111111' }), sys: {}, assert, cleanupFails }
  const code = `${saved}; (async()=>{let t; ${setup}; assert.equal(process.env.SHARED_OFFERS_COMPANY_ID,t.companyId); try {if(cleanupFails) throw Error('simulated cleanup failure');${cleanup}; })()`
  if (cleanupFails) await assert.rejects(vm.runInNewContext(code, context), /cleanup failure/)
  else await vm.runInNewContext(code, context)
  assert.equal(env.SHARED_OFFERS_COMPANY_ID, initial)
  assert.equal(Object.hasOwn(env, 'SHARED_OFFERS_COMPANY_ID'), initial !== undefined)
})
function report() { return { numTotalTests: 8, numPassedTests: 8, numFailedTests: 0, numPendingTests: 0, numTodoTests: 0, numFailedTestSuites: 0, testResults: [['crm003-regression.test.ts', 6], ['operational-ci.test.ts', 2]].map(([name, n]) => ({ name: '/ci/' + name, status: 'passed', assertionResults: Array.from({ length: n }, () => ({ status: 'passed' })) })) } }
test('complete report accepted', () => assert.doesNotThrow(() => assertIntegrationComplete(report())))
for (const [name, mutate] of [
  ['real setup failure shape:18passed39pending0assertion failures', r => { r.numPassedTests = 2; r.numPendingTests = 5; r.numFailedTestSuites = 1; r.testResults[1].status = 'failed' }],
  ['missing regression suite', r => r.testResults.splice(0, 1)],
  ['regression assertion skipped despite forged totals', r => { r.testResults[1].assertionResults[0].status = 'skipped' }],
  ['regression uncollected assertion', r => r.testResults[1].assertionResults.pop()],
  ['duplicate suite', r => { r.testResults[1] = r.testResults[0] }],
  ['retired shared-offers suite instead of regression', r => { r.testResults[0].name = '/ci/shared-offers.test.ts' }],
  ['todo', r => { r.numTodoTests = 1 }],
]) test('report rejects ' + name, () => { const r = report(); mutate(r); assert.throws(() => assertIntegrationComplete(r)) })
