// F04 run pending, F09 clean, F07 baseline/capture entry points, F08 checks tab. Browser preview with seeded data.
import { expect, test } from '@playwright/test'
import { expectNoA11yViolations, watchConsole } from '../helpers'

test.describe('F04 Environments', () => {
  let checkConsole: () => void
  test.beforeEach(async ({ page }) => {
    checkConsole = watchConsole(page)
    await page.goto('/?open=1&ws=Environments')
  })
  test.afterEach(() => checkConsole())

  test('F04-H1 run pending on staging', async ({ page }) => {
    const staging = page.getByRole('region', { name: 'staging environment' })
    await expect(staging.getByText('2 scripts')).toBeVisible()
    await staging.click()
    await page.getByRole('region', { name: 'staging details' }).getByRole('button', { name: 'Run pending' }).click()
    await expect(page.getByText('Ran 2 scripts on staging', { exact: true })).toBeVisible()
    const table = page.getByRole('table', { name: 'Migrations on staging' })
    await expect(table.getByText('Pending')).toHaveCount(0)
    await expect(table.getByText('Applied')).toHaveCount(4)
    await expect(page.getByRole('log')).toContainText('Applied V20261008.0840__daily_totals_view.sql')
  })

  test('F04-N1 an unreachable target says so', async ({ page }) => {
    const prod = page.getByRole('region', { name: 'production environment' })
    await expect(prod.getByText('Unreachable')).toBeVisible()
    await prod.click()
    await expect(page.getByRole('alert').filter({ hasText: "Can't read production" })).toBeVisible()
  })

  test('F04-E5 double click on Run pending runs once', async ({ page }) => {
    await page.getByRole('region', { name: 'staging environment' }).click()
    await page.getByRole('region', { name: 'staging details' }).getByRole('button', { name: 'Run pending' }).dblclick()
    await expect(page.getByText('Ran 2 scripts on staging', { exact: true })).toHaveCount(1)
    await expect(page.getByText('staging was already up to date', { exact: true })).toHaveCount(0)
  })

  test('F04-H6 a click anywhere on a card opens it; the order: by role, scratch last; drag or Alt+arrows to change it', async ({ page }) => {
    const cards = page.getByRole('region', { name: / environment$/ })
    const order = async () => (await cards.evaluateAll((els) => els.map((e) => e.getAttribute('aria-label')!.replace(' environment', ''))))
    await expect.poll(order).toEqual(['local', 'staging', 'production', 'scratch'])
    // Not on the name: on the card's text.
    await page.getByRole('region', { name: 'local environment' }).getByText('Pending').click()
    await expect(page.getByRole('region', { name: 'local details' })).toBeVisible()
    await expect(page.getByRole('region', { name: 'local environment' }).getByRole('button', { name: 'local' })).toHaveAttribute('aria-pressed', 'true')
    await expect(page.getByRole('region', { name: 'local environment' }).getByRole('button', { name: 'Run pending' })).toHaveCount(0)

    await page.getByRole('region', { name: 'scratch environment' }).dragTo(page.getByRole('region', { name: 'staging environment' }))
    await expect.poll(order).toEqual(['local', 'scratch', 'staging', 'production'])
    await page.getByRole('region', { name: 'local environment' }).getByRole('button', { name: 'local' }).press('Alt+ArrowRight')
    await expect.poll(order).toEqual(['scratch', 'local', 'staging', 'production'])
  })

  test('F04-H8 a pending script on a database that already has it: Mark as applied, after a warning', async ({ page }) => {
    await page.getByRole('region', { name: 'staging environment' }).click()
    const table = page.getByRole('table', { name: 'Migrations on staging' })
    await expect(table.getByText('Pending')).toHaveCount(2)
    await table.getByRole('button', { name: /^Mark V\S+__tax_function\.sql as applied$/ }).click()
    const dialog = page.getByRole('dialog', { name: /^Record V\S+__tax_function\.sql as applied on staging\?$/ })
    await expect(dialog.getByText(/already has this script's changes/)).toBeVisible()
    await expectNoA11yViolations(page, 'Mark as applied')
    await dialog.getByRole('button', { name: 'Record as applied' }).click()
    await expect(page.getByText(/^Recorded V\S+__tax_function\.sql as applied on staging$/)).toBeVisible()
    await expect(table.getByText('Pending')).toHaveCount(1)
  })

  test('F09-E1/H1 clean needs the exact environment name', async ({ page }) => {
    await page.getByRole('region', { name: 'scratch environment' }).getByRole('button', { name: 'scratch' }).click()
    const details = page.getByRole('region', { name: 'scratch details' })
    await details.getByRole('combobox', { name: 'Command' }).selectOption({ label: 'Clean…' })
    await details.getByRole('button', { name: 'Clean…' }).click()
    const dialog = page.getByRole('alertdialog', { name: 'Clean scratch' })
    const erase = dialog.getByRole('button', { name: 'Erase everything' })
    await dialog.getByLabel('Type scratch to confirm').fill('scratc')
    await expect(erase).toBeDisabled()
    await dialog.getByLabel('Type scratch to confirm').fill('scratch')
    await expect(erase).toBeEnabled()
    await expectNoA11yViolations(page, 'Clean confirmation')
    await erase.click()
    await expect(page.getByText('scratch is empty', { exact: true })).toBeVisible()
  })

  test('F09-N1 clean is not offered on a test database', async ({ page }) => {
    const details = page.getByRole('region', { name: 'staging details' })
    await expect(details.getByRole('combobox', { name: 'Command' }).getByRole('option', { name: 'Clean…' })).toHaveCount(0)
  })

  test('F08-H1 drift check shows the changed object side by side', async ({ page }) => {
    const details = page.getByRole('region', { name: 'staging details' })
    await details.getByRole('tab', { name: 'Checks' }).click()
    await details.getByRole('button', { name: 'Check for drift' }).click()
    await expect(details.getByText('1 object changed outside the scripts')).toBeVisible()
    await expect(details.getByRole('table', { name: /From the applied scripts compared with In staging/ })).toContainText('hotfix integer')
    await expect(page.getByRole('region', { name: 'staging environment' }).getByText('Detected')).toBeVisible()
    await expectNoA11yViolations(page, 'Checks with drift')
  })

  test('F08-H2 the rules on the pending scripts, with allowed findings and their reason', async ({ page }) => {
    const details = page.getByRole('region', { name: 'staging details' })
    await details.getByRole('tab', { name: 'Checks' }).click()
    await details.getByRole('button', { name: 'Check the rules' }).click()
    await expect(details.getByText(/1 warning in \d+ pending scripts?/)).toBeVisible()
    const findings = details.getByRole('table', { name: 'Rule findings' })
    await expect(findings.getByRole('row').filter({ hasText: 'table-without-primary-key' })).toContainText('warn')
    await expect(findings.getByRole('row').filter({ hasText: 'drop-column' })).toContainText('allowed')
    await expect(findings).toContainText('moved to tax_rates in the previous release')
    await expectNoA11yViolations(page, 'Checks with rule findings')
  })

  test('X-A11Y Environments', async ({ page }) => {
    await expectNoA11yViolations(page, 'Environments (light)')
    await page.goto('/?open=1&ws=Environments&theme=dark')
    await expectNoA11yViolations(page, 'Environments (dark)')
  })
})
