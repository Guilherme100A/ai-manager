import fs from 'node:fs'
import path from 'node:path'

// Keep the original visibility gate and error; capture the missing evidence before teardown.
export async function waitForVisibleWithEvidence(page, selector, report, name, events) {
  try {
    await page.locator(selector).waitFor()
  } catch (error) {
    const evidence = { selector, error: { name: error.name, message: error.message }, events }
    try {
      evidence.page = await page.evaluate(() => ({
        url: location.origin + location.pathname,
        readyState: document.readyState,
        title: document.title,
        body: document.body?.innerText.slice(0, 4000),
        root: document.querySelector('#root')?.innerHTML.slice(0, 12000),
      }))
    } catch { evidence.page_unavailable = true }
    try { await page.screenshot({ path: path.join(report, name + '-failure.png') }) } catch { evidence.screenshot_unavailable = true }
    try { fs.writeFileSync(path.join(report, name + '-failure.json'), JSON.stringify(evidence, null, 2)) } catch {
      // Evidence I/O must not replace the original browser failure.
      console.error('Could not persist browser failure evidence')
    }
    throw error
  }
}
