// Compare: any two sides, then a script, a migration, or apply. Browser preview with seeded data.
import { expect, test } from '@playwright/test'
import { expectNoA11yViolations, watchConsole } from '../helpers'

test('F16-H1 compare two environments, look at a difference, save the script', async ({ page }) => {
  const checkConsole = watchConsole(page)
  await page.goto('/?open=1&ws=Compare')
  await expect(page.getByLabel('Source', { exact: true })).toHaveValue('env:local')
  await expect(page.getByLabel('Target', { exact: true })).toHaveValue('env:staging')
  await expectNoA11yViolations(page, 'Compare, before comparing')
  await page.getByRole('main').getByRole('button', { name: 'Compare', exact: true }).click()
  await expect(page.getByText(/what would make staging match local/)).toBeVisible()
  await expect(page.getByText(/selected$/)).toBeVisible()
  await expectNoA11yViolations(page, 'Compare, with differences')
  await page.getByRole('button', { name: 'Save script…' }).click()
  await expect(page.getByText('Saved C:/Users/me/sync-staging.sql').first()).toBeVisible()
  checkConsole()
})

test('F16-H2 apply to a test database: one review, with the drift warning', async ({ page }) => {
  await page.goto('/?open=1&ws=Compare')
  await page.getByRole('main').getByRole('button', { name: 'Compare', exact: true }).click()
  await page.getByRole('button', { name: 'Apply to staging…' }).click()
  const dialog = page.getByRole('dialog', { name: /Apply \d+ changes? to staging\?/ })
  await expect(dialog.getByText('Outside the migrations')).toBeVisible()
  await expect(dialog.getByText(/Makes staging match local/)).toBeVisible()
  await dialog.getByRole('button', { name: 'Apply' }).click()
  await expect(page.getByText(/^Applied \d+ changes? to staging$/).first()).toBeVisible()
})

test('F16-E1 production needs its name typed; a snapshot is not a database to apply to', async ({ page }) => {
  await page.goto('/?open=1&ws=Compare')
  await page.getByLabel('Target', { exact: true }).selectOption('env:production')
  await page.getByRole('main').getByRole('button', { name: 'Compare', exact: true }).click()
  await page.getByRole('button', { name: 'Apply to production…' }).click()
  await page.getByRole('dialog').getByRole('button', { name: 'Apply' }).click()
  const confirm = page.getByRole('alertdialog')
  await expect(confirm.getByRole('button', { name: 'Apply to production' })).toBeDisabled()
  await confirm.getByRole('textbox').fill('production')
  await confirm.getByRole('button', { name: 'Apply to production' }).click()
  await expect(page.getByText(/^Applied \d+ changes? to production$/).first()).toBeVisible()

  // Swap: the snapshot becomes the target, and apply is not offered.
  await page.getByLabel('Source', { exact: true }).selectOption('snapshot')
  await expect(page.getByLabel('Source', { exact: true })).toContainText('Snapshot: production-2026-10-01.json')
  await page.getByRole('button', { name: 'Swap source and target' }).click()
  await page.getByRole('main').getByRole('button', { name: 'Compare', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Apply (the target is not a database)' })).toBeDisabled()
})

test('F16-E2 a snapshot of the source, and comparing a side with itself', async ({ page }) => {
  await page.goto('/?open=1&ws=Compare')
  await page.getByRole('button', { name: 'Snapshot the source…' }).click()
  await expect(page.getByText(/^Saved a snapshot of \d+ objects to C:\/repos\/shop-db\/snapshots\/local-/).first()).toBeVisible()
  await page.getByLabel('Target', { exact: true }).selectOption('env:local')
  await page.getByRole('main').getByRole('button', { name: 'Compare', exact: true }).click()
  await expect(page.getByText('the source and the target are the same')).toBeVisible()
})
