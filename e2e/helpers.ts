import AxeBuilder from '@axe-core/playwright'
import { expect, type Page } from '@playwright/test'

/** Collects console errors and uncaught exceptions; call the returned check at the end of a test. */
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
  const r = await new AxeBuilder({ page }).analyze()
  const found = r.violations.map((v) => `${v.id} (${v.impact}): ${v.nodes[0]?.target.join(' ')} - ${v.help}`)
  expect(found, `axe violations on ${label}`).toEqual([])
}
