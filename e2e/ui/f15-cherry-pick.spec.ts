// Run one script on its own (migrate --only) from the Environments screen. Browser preview with seeded data.
import { expect, test } from '@playwright/test'
import { expectNoA11yViolations, watchConsole } from '../helpers'

test('F15-H1 run only the newer pending script; the dialog names the older one it leaves behind', async ({ page }) => {
  const checkConsole = watchConsole(page)
  await page.goto('/?open=1&ws=Environments')
  await page.getByRole('region', { name: 'staging environment' }).click()
  const table = page.getByRole('table', { name: 'Migrations on staging' })
  // Applied scripts have no button; the two that have not run do.
  await expect(table.getByRole('button', { name: /^Run only / })).toHaveCount(2)
  await table.getByRole('button', { name: 'Run only V20261008.0840__daily_totals_view.sql' }).click()

  const dialog = page.getByRole('dialog', { name: 'Run only V20261008.0840__daily_totals_view.sql on staging?' })
  await expect(dialog.getByText('1 older script will not run')).toBeVisible()
  await expect(dialog.getByText('V20261007.1102__tax_function.sql').first()).toBeVisible()
  await expectNoA11yViolations(page, 'run only this dialog')
  await dialog.getByRole('button', { name: 'Run this script only' }).click()
  await expect(page.getByText('Ran V20261008.0840__daily_totals_view.sql on staging; not run yet, and older: V20261007.1102__tax_function.sql').first()).toBeVisible()
  checkConsole()
})

test('F15-N1 cancelling runs nothing', async ({ page }) => {
  await page.goto('/?open=1&ws=Environments')
  await page.getByRole('region', { name: 'staging environment' }).click()
  await page.getByRole('table', { name: 'Migrations on staging' }).getByRole('button', { name: 'Run only V20261007.1102__tax_function.sql' }).click()
  const dialog = page.getByRole('dialog')
  await expect(dialog.getByText(/older script/)).toHaveCount(0)
  await dialog.getByRole('button', { name: 'Cancel' }).click()
  await expect(dialog).toBeHidden()
  await expect(page.getByText(/^Ran V/)).toHaveCount(0)
})
