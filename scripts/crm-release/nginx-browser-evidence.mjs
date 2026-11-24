import fs from 'node:fs'
import path from 'node:path'
import { randomBytes } from 'node:crypto'
import { errorEvidence, pageEvidence } from './nginx-network-diagnostic.mjs'

const captured = new WeakSet()
export const hasFailureEvidence = error => captured.has(error)

export async function captureBrowserFailure(page, selector, report, name, events, error, diagnostic) {
  const evidence = { selector, error: errorEvidence(error), events }
  try { Object.assign(evidence, diagnostic?.stamp() ?? {}) } catch { evidence.clock_unavailable = true }
  try { diagnostic?.emit('harness', 'visibility_failed', { error: evidence.error.name }) } catch { evidence.timeline_unavailable = true }
  try { await diagnostic?.snapshot('visibility_failed') } catch { evidence.infra_unavailable = true }
  let base = path.join(report, name + '-failure')
  try { if (fs.existsSync(base + '.json') || fs.existsSync(base + '.png')) base += '-' + process.pid + '-' + randomBytes(6).toString('hex') } catch { /* capture attempts remain independent */ }
  try {
    const raw = await page.evaluate(() => ({
      url: location.origin + location.pathname,
      readyState: document.readyState,
      title: document.title,
      body: document.body?.innerText.slice(0, 4000),
      root: document.querySelector('#root')?.innerHTML.slice(0, 12000),
    }))
    try { raw.frame_urls = page.frames?.().map(frame => frame.url()) ?? [] } catch { evidence.frame_urls_unavailable = true }
    evidence.page = diagnostic ? diagnostic.pageEvidence(raw) : pageEvidence(raw)
  } catch { evidence.page_unavailable = true }
  try {
    await page.screenshot({ path: base + '.png' })
    const screenshotBytes = fs.statSync(base + '.png').size
    if (screenshotBytes > 8 * 1024 * 1024) {
      fs.unlinkSync(base + '.png') // Only the oversized screenshot just created here.
      evidence.screenshot_unavailable = true
      evidence.screenshot_truncated = true
      evidence.screenshot_reason = 'screenshot_limit'
      evidence.screenshot_dropped_bytes = screenshotBytes
      evidence.truncated = true
    }
  } catch { evidence.screenshot_unavailable = true }
  try {
    if (Buffer.byteLength(JSON.stringify(evidence)) > 1024 * 1024) { evidence.events = { truncated: true, reason: 'failure_evidence_limit' }; evidence.truncated = true }
    fs.writeFileSync(base + '.json', JSON.stringify(evidence, null, 2), { flag: 'wx', mode: 0o600 })
  } catch {
    // Evidence I/O must not replace the original browser failure.
    console.error('Could not persist browser failure evidence')
  }
  if (error && typeof error === 'object') captured.add(error)
}

// Keep the original visibility gate and error; capture the missing evidence before teardown.
export async function waitForVisibleWithEvidence(page, selector, report, name, events, diagnostic) {
  try {
    await page.locator(selector).waitFor()
  } catch (error) {
    try { await captureBrowserFailure(page, selector, report, name, events, error, diagnostic) } catch { /* never replace the primary failure */ }
    throw error
  }
}
