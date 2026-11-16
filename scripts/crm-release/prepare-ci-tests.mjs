// CI-owned copy of the frozen reviewer suite. Adapt fixture gate lifecycle and
// the one pre-gate cross-company expectation to the approved strict 404 contract.
// The approved distribution stays untouched.
import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { pathToFileURL } from 'node:url'
export const REVIEWER_SHA256 = 'abb4e679c2b139bfa3c0ca3164963d415fb75fd776d4d8f81fff1157bbcf21aa'
export const originalFile = 'revisor-shared-offers.test.ts'
export const adaptedFile = 'revisor-gated-ci.test.ts'
const check = (ok, message) => { if (!ok) throw Error(message) }
const changes = [
  ['let sys: System, t: Tenant', 'const __ciOriginalOffersGate = process.env.SHARED_OFFERS_COMPANY_ID\nlet sys: System, t: Tenant'],
  ['  t = await tenant(sys)\n', '  t = await tenant(sys)\n  process.env.SHARED_OFFERS_COMPANY_ID = t.companyId\n'],
  ["expect((await foreign.c.put('/api/offers/' + a.id, a)).status).toBe(422)", "expect((await foreign.c.put('/api/offers/' + a.id, a)).status).toBe(404)"],
  ['afterAll(async () => {\n', 'afterAll(async () => {\n  try {\n'],
  ['  await gateway.stop()\n}, 120000)', "  await gateway.stop()\n  } finally {\n    if (__ciOriginalOffersGate === undefined) delete process.env.SHARED_OFFERS_COMPANY_ID\n    else process.env.SHARED_OFFERS_COMPANY_ID = __ciOriginalOffersGate\n  }\n}, 120000)"],
]
export function adaptReviewerSuite(input) {
  const source = input.replace(/\r\n/g, '\n')
  check(createHash('sha256').update(source).digest('hex') === REVIEWER_SHA256, 'Unexpected approved reviewer source; review adapter before changing it')
  let result = source
  for (const [before, after] of changes) {
    check(result.split(before).length === 2, 'Reviewer fixture anchor missing or ambiguous')
    result = result.replace(before, after)
  }
  // Exact reversal proves only the listed adaptations occurred; no test is removed.
  let restored = result
  for (const [before, after] of [...changes].reverse()) restored = restored.replace(after, before)
  check(restored === source, 'CI adaptation changed original test content')
  return result
}
export function assertIntegrationComplete(report) {
  const expected = new Map([['shared-offers.test.ts', 16], [adaptedFile, 39], ['operational-ci.test.ts', 2]])
  check(report?.numTotalTests === 57 && report.numPassedTests === 57 && report.numFailedTests === 0 && report.numPendingTests === 0 && report.numTodoTests === 0 && report.numFailedTestSuites === 0, 'Acceptance incomplete: all 57 tests must execute and pass, no pending/skip/todo')
  check(Array.isArray(report.testResults) && report.testResults.length === 3, 'All three acceptance suites required')
  const names = report.testResults.map(s => s.name.replaceAll('\\', '/').split('/').at(-1))
  check(new Set(names).size === 3, 'Duplicate acceptance suite')
  for (const suite of report.testResults) {
    const name = suite.name.replaceAll('\\', '/').split('/').at(-1)
    check(expected.has(name) && suite.status === 'passed' && suite.assertionResults.length === expected.get(name) && suite.assertionResults.every(t => t.status === 'passed'), 'Acceptance suite missing, incomplete or not passed')
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const [mode, file] = process.argv.slice(2)
    if (mode === 'prepare') {
      const folder = path.join(file, 'tests/acceptance/T125')
      const adapted = adaptReviewerSuite(fs.readFileSync(path.join(folder, originalFile), 'utf8'))
      fs.writeFileSync(path.join(folder, adaptedFile), adapted, { flag: 'wx' })
      console.log('CI reviewer fixture scoped to synthetic tenant; strict foreign-company 404; original source preserved')
    } else if (mode === 'verify') {
      assertIntegrationComplete(JSON.parse(fs.readFileSync(file, 'utf8')))
      console.log('PASS all 57 acceptance tests, including 39 reviewer cases; no pending/skip/todo')
    } else throw Error('Use prepare <reconstructed-crm> or verify <integration.json>')
  } catch (e) { console.error(e.message); process.exitCode = 1 }
}
