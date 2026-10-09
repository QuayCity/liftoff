// Existing databases and numbering restarts in the desktop app. Browser preview with seeded data.
import { expect, test } from '@playwright/test'
import { expectNoA11yViolations, watchConsole } from '../helpers'

const column = (page: import('@playwright/test').Page, name: string) => page.getByRole('region', { name: `${name} environment` })

test('F18-H1 a project without scripts adopts the database that has the tables', async ({ page }) => {
  const checkConsole = watchConsole(page)
  await page.goto('/?open=1&ws=Environments&noscripts')
  // Without scripts nothing is pending, so the screen says how to start from a database that has objects.
  await expect(page.getByText('Starting from an existing database?')).toBeVisible()
  await expect(page.getByLabel('Database to adopt')).toHaveValue('production')
  await expectNoA11yViolations(page, 'adopt prompt')
  await page.getByRole('button', { name: 'Adopt as B0001' }).click()
  await expect(page.getByText('Captured production as B0001__existing_schema.sql and recorded it there').first()).toBeVisible()
  checkConsole()
})

test('F18-H2 a database that differs from the baseline: listed, nothing changed until recorded anyway', async ({ page }) => {
  await page.goto('/?open=1&ws=Environments&differs')
  await column(page, 'staging').getByRole('button', { name: 'Run pending' }).click()
  const dialog = page.getByRole('dialog', { name: 'staging differs from the baseline' })
  await expect(dialog.getByText('table:public.orders')).toBeVisible()
  await expect(dialog.getByText(/Nothing was changed/)).toBeVisible()
  await expectNoA11yViolations(page, 'differs dialog')
  await dialog.getByRole('button', { name: 'Record anyway' }).click()
  await expect(page.getByText('staging is now at B0001__existing_schema.sql; created 1 missing object; kept 1 difference').first()).toBeVisible()
})

test('F18-H3 near V9999: the Scripts screen says so, and the rebaseline starts the numbering again', async ({ page }) => {
  await page.goto('/?open=1&ws=Scripts&nearlimit')
  const note = page.getByText(/reached version 9991/)
  await expect(note).toBeVisible()
  await page.getByRole('button', { name: 'Rebaseline…', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: 'Squash or rebaseline' })
  await expect(dialog.getByLabel(/Start the numbering again/)).toBeChecked()
  await expect(dialog.getByLabel('Up to version')).toBeDisabled()
  await dialog.getByRole('button', { name: 'Rebaseline' }).click()
  await expect(page.getByText(/^Wrote B0001__baseline\.sql; \d+ old scripts deleted/).first()).toBeVisible()
})
