// Squash the versioned scripts into one baseline script. Browser preview with seeded data.
import { expect, test } from '@playwright/test'
import { expectNoA11yViolations, watchConsole } from '../helpers'

test('FX1-H1 squash up to a version from the Scripts workspace', async ({ page }) => {
  const checkConsole = watchConsole(page)
  await page.goto('/?open=1&ws=Scripts')
  await page.getByRole('button', { name: 'Squash…' }).click()
  const dialog = page.getByRole('dialog', { name: 'Squash scripts' })
  const upTo = dialog.getByLabel('Up to version')
  const versions = await upTo.locator('option').allTextContents()
  expect(versions.length).toBeGreaterThan(1)
  await expect(upTo).toHaveValue(versions[versions.length - 1])
  await upTo.selectOption(versions[0])
  await expectNoA11yViolations(page, 'Squash dialog')
  await dialog.getByLabel('Description').fill('')
  await expect(dialog.getByRole('button', { name: 'Squash' })).toBeDisabled()
  await dialog.getByLabel('Description').fill('fresh start')
  await dialog.getByRole('button', { name: 'Squash' }).click()
  await expect(page.getByText(`Wrote B${versions[0]}__fresh_start.sql`, { exact: true })).toBeVisible()
  await expect(dialog).toBeHidden()
  checkConsole()
})
