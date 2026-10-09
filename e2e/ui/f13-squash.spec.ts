// Squash or rebaseline from the Scripts workspace. Browser preview with seeded data.
import { expect, test, type Page } from '@playwright/test'
import { expectNoA11yViolations, watchConsole } from '../helpers'

async function openDialog(page: Page) {
  await page.goto('/?open=1&ws=Scripts')
  await page.getByRole('button', { name: 'Squash or rebaseline…' }).click()
  return page.getByRole('dialog', { name: 'Squash or rebaseline' })
}

test('FX1-H1 rebaseline (the default): one baseline script, the old ones removed', async ({ page }) => {
  const checkConsole = watchConsole(page)
  const dialog = await openDialog(page)
  const upTo = dialog.getByLabel('Up to version')
  const versions = await upTo.locator('option').allTextContents()
  expect(versions.length).toBeGreaterThan(1)
  await expect(upTo).toHaveValue(versions[versions.length - 1])
  await expect(dialog.getByRole('radio', { name: 'Remove them (rebaseline)' })).toBeChecked()
  await expectNoA11yViolations(page, 'Squash or rebaseline dialog')
  await dialog.getByLabel('Description').fill('')
  await expect(dialog.getByRole('button', { name: 'Rebaseline' })).toBeDisabled()
  await dialog.getByLabel('Description').fill('fresh start')
  await dialog.getByRole('button', { name: 'Rebaseline' }).click()
  await expect(page.getByText(new RegExp(`^Wrote B${versions[versions.length - 1].replace('.', '\\.')}__fresh_start\\.sql; ${versions.length} old scripts deleted \\(git still has them\\)$`)).first()).toBeVisible()
  await expect(dialog).toBeHidden()
  checkConsole()
})

test('FX1-H2 rebaseline into an archive folder, up to an earlier version', async ({ page }) => {
  const dialog = await openDialog(page)
  const versions = await dialog.getByLabel('Up to version').locator('option').allTextContents()
  await dialog.getByLabel('Up to version').selectOption(versions[0])
  await dialog.getByRole('radio', { name: 'Move them to a folder (rebaseline)' }).check()
  await expect(dialog.getByLabel('Folder', { exact: true })).toHaveValue('migrations-archive')
  await dialog.getByRole('button', { name: 'Rebaseline' }).click()
  await expect(page.getByText(/; 1 old script moved to C:\/repos\/shop-db\/migrations-archive$/).first()).toBeVisible()
})

test('FX1-H3 squash only: the old scripts stay', async ({ page }) => {
  const dialog = await openDialog(page)
  const versions = await dialog.getByLabel('Up to version').locator('option').allTextContents()
  await dialog.getByRole('radio', { name: 'Keep them (squash only)' }).check()
  await dialog.getByRole('button', { name: 'Squash' }).click()
  await expect(page.getByText(`Wrote B${versions[versions.length - 1]}__baseline.sql`, { exact: true })).toBeVisible()
})
