// F05 hand-written scripts, plus Settings. Browser preview with seeded data.
import { expect, test } from '@playwright/test'
import { expectNoA11yViolations, watchConsole } from '../helpers'

test('F05-H1 new versioned script is created and selected', async ({ page }) => {
  const checkConsole = watchConsole(page)
  await page.goto('/?open=1&ws=Scripts')
  await expect(page.getByRole('table', { name: 'Migration scripts' }).getByRole('row')).toHaveCount(5)
  await page.getByRole('button', { name: 'New script' }).first().click()
  const dialog = page.getByRole('dialog', { name: 'New script' })
  await dialog.getByRole('button', { name: 'Create script' }).click()
  await expect(dialog.getByText(/Up to 120 letters/)).toBeVisible()
  await dialog.getByLabel('Description').fill('backfill totals')
  await dialog.getByLabel('SQL').fill('update orders set total = 0 where total is null;')
  await expectNoA11yViolations(page, 'New script dialog')
  await dialog.getByRole('button', { name: 'Create script' }).click()
  await expect(page.getByText('Created V20261008.1200__backfill_totals.sql', { exact: true })).toBeVisible()
  await expect(page.getByRole('row', { name: /backfill totals/ })).toHaveAttribute('aria-selected', 'true')
  checkConsole()
})

test('X-A11Y Scripts and Settings', async ({ page }) => {
  const checkConsole = watchConsole(page)
  await page.goto('/?open=1&ws=Scripts')
  await expect(page.getByRole('table', { name: 'Migration scripts' })).toBeVisible()
  await expectNoA11yViolations(page, 'Scripts')
  await page.goto('/?open=1&ws=Settings')
  await expect(page.getByRole('button', { name: 'Save settings' })).toBeVisible()
  await expectNoA11yViolations(page, 'Settings')
  checkConsole()
})

test('X-A11Y design page', async ({ page }) => {
  const checkConsole = watchConsole(page)
  await page.goto('/?design')
  await expectNoA11yViolations(page, 'design page')
  checkConsole()
})
