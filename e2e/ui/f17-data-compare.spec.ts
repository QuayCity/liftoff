// Data compare on the Compare screen: tables, differing rows page by page, script and apply.
// Browser preview with seeded data.
import { expect, test, type Page } from '@playwright/test'
import { expectNoA11yViolations, watchConsole } from '../helpers'

async function compareData(page: Page) {
  await page.goto('/?open=1&ws=Compare')
  await page.getByRole('radio', { name: 'Data' }).click()
  await page.getByRole('main').getByRole('button', { name: 'Compare data' }).click()
  await expect(page.getByText(/4 tables, 2 with differences, compared in 1\.8 s/)).toBeVisible()
}

test('F17-H1 compare the data: the table that differs, its rows, changed cells marked', async ({ page }) => {
  const checkConsole = watchConsole(page)
  await compareData(page)
  const tables = page.getByRole('list', { name: 'Tables' })
  // Same tables are hidden; ones that cannot be compared still show, with the reason.
  await expect(tables.getByText('public.customers')).toHaveCount(0)
  await expect(tables.getByText(/Not compared: only in the target/)).toBeVisible()
  // A table without a key: whole rows, so no "different", and the screen says why.
  await expect(tables.getByText('3 only in source · 2 only in target · no key, whole rows')).toBeVisible()
  await tables.getByRole('button', { name: /public\.audit_log/ }).click()
  await expect(page.getByText('No key: whole rows compared')).toBeVisible()
  await expect(tables.getByText('132 different · 2 only in source · 1 only in target')).toBeVisible()
  await tables.getByRole('button', { name: /public\.orders/ }).click()
  const grid = page.getByRole('table', { name: /Different in public\.orders, rows 1 to 50 of 132/ })
  await expect(grid).toBeVisible()
  await expect(grid.getByText('(changed)').first()).toBeAttached()
  await expect(grid.getByText('(empty)').first()).toBeVisible()
  await expectNoA11yViolations(page, 'data compare')
  await page.getByRole('button', { name: 'Next' }).click()
  await expect(page.getByText('51–100 of 132')).toBeVisible()
  await page.getByRole('tab', { name: 'Only in the source (2)' }).click()
  await expect(page.getByText('1–2 of 2')).toBeVisible()
  await page.getByLabel('Hide tables that are the same').uncheck()
  await expect(tables.getByText('public.customers')).toBeVisible()
  checkConsole()
})

test('F17-H2 choose what to sync, save the script, apply with a review', async ({ page }) => {
  await compareData(page)
  await expect(page.getByText('2 tables, 140 statements')).toBeVisible()
  await page.getByLabel('Delete rows only in the target').uncheck()
  await expect(page.getByText('2 tables, 137 statements')).toBeVisible()
  await page.getByRole('button', { name: 'Save script…' }).click()
  await expect(page.getByText('Saved C:/Users/me/sync-rows-staging.sql').first()).toBeVisible()
  await page.getByRole('button', { name: 'Apply to staging…' }).click()
  const dialog = page.getByRole('dialog', { name: 'Change 137 rows in staging?' })
  await expect(dialog.getByText('public.orders: 2 inserted, 132 updated')).toBeVisible()
  await dialog.getByRole('button', { name: 'Apply' }).click()
  await expect(page.getByText('Applied 135 statements to staging').first()).toBeVisible()
})

test('F17-E1 data mode offers databases only, and production needs its name typed', async ({ page }) => {
  await page.goto('/?open=1&ws=Compare')
  await page.getByRole('radio', { name: 'Data' }).click()
  await expect(page.getByLabel('Source', { exact: true }).locator('option', { hasText: 'The schema model' })).toHaveCount(0)
  await expect(page.getByLabel('Source', { exact: true }).locator('option', { hasText: 'A snapshot file' })).toHaveCount(0)
  await page.getByLabel('Target', { exact: true }).selectOption('env:production')
  await page.getByRole('main').getByRole('button', { name: 'Compare data' }).click()
  await page.getByRole('button', { name: 'Apply to production…' }).click()
  await page.getByRole('dialog').getByRole('button', { name: 'Apply' }).click()
  await expect(page.getByRole('alertdialog').getByRole('button', { name: 'Apply to production' })).toBeDisabled()
})
