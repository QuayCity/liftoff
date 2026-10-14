import AxeBuilder from '@axe-core/playwright'
import { expect, type Page } from '@playwright/test'

/** Collects console errors and uncaught exceptions; call the returned check at the end of a test. */
/**
 * The real app opens again with the tabs of last time; the tests start from the start page. Sets
 * the saved tabs aside (reloading without them) and returns a function that puts them back: call
 * it before the app closes, after the test's own tabs, which the app saves too.
 */
export async function withoutSavedTabs(page: Page): Promise<() => Promise<void>> {
  const key = 'liftoff:open-projects'
  const saved = await page.evaluate((k) => localStorage.getItem(k), key)
  if (saved !== null) {
    await page.evaluate((k) => localStorage.removeItem(k), key)
    await page.reload()
  }
  return async () => {
    if (saved !== null) await page.evaluate(([k, v]) => localStorage.setItem(k, v), [key, saved]).catch(() => {})
  }
}

export function watchConsole(page: Page) {
  const errors: string[] = []
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text())
  })
  page.on('pageerror', (e) => errors.push(`uncaught: ${e.message}`))
  return () => expect(errors, 'console errors').toEqual([])
}

/** axe scan; failures list rule id, impact and the first offending element. */
export async function expectNoA11yViolations(page: Page, label: string) {
  // Legacy mode runs entirely in this page: the desktop app (Electron) cannot open the extra page
  // axe otherwise uses, and LiftOff has no iframes for it to combine.
  const r = await new AxeBuilder({ page }).setLegacyMode(true).analyze()
  const found = r.violations.map((v) => `${v.id} (${v.impact}): ${v.nodes[0]?.target.join(' ')} - ${v.help}`)
  expect(found, `axe violations on ${label}`).toEqual([])
}
