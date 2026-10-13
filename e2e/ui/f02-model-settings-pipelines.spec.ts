// F02 schema model, S15/S16 settings and filters, F10/S17 CI workflow. Browser preview with seeded data.
import { expect, test } from '@playwright/test'
import { expectNoA11yViolations, watchConsole } from '../helpers'

test('F02-H1 compare dev with the schema model and save the changed files', async ({ page }) => {
  const checkConsole = watchConsole(page)
  await page.goto('/?open=1&ws=Changes')
  await page.getByRole('group', { name: 'Compare dev with' }).getByRole('button', { name: 'Schema model' }).click()
  await page.getByRole('main').getByRole('button', { name: 'Compare', exact: true }).click()
  await expect(page.getByRole('treeitem', { name: 'Changed public.orders' })).toBeVisible()
  await page.getByRole('treeitem', { name: 'Changed public.orders' }).click()
  await expect(page.getByRole('table', { name: /In the model compared with In local/ })).toContainText('paid_at')
  await expectNoA11yViolations(page, 'Schema model comparison')
  await page.getByRole('button', { name: 'Save to model' }).click()
  await expect(page.getByText(/^Saved 2 files to /)).toBeVisible()
  await expect(page.getByText('The schema model matches local.')).toBeVisible()
  checkConsole()
})

test('S15/S16 edit settings and a filter; leaving with unsaved changes asks first', async ({ page }) => {
  const checkConsole = watchConsole(page)
  await page.goto('/?open=1&ws=Settings')
  const save = page.getByRole('button', { name: 'Save settings' })
  await expect(save).toBeDisabled()
  await page.getByRole('button', { name: 'Add filter' }).click()
  const filter = page.getByRole('group', { name: 'Filter 1' })
  await expect(filter.getByText('Enter a pattern')).toBeVisible()
  await expect(save).toBeDisabled()
  await filter.getByLabel('Name pattern').fill('audit_*')
  await filter.getByLabel('Object').selectOption('table')
  await expect(page.getByText('Unsaved changes')).toBeVisible()
  await expectNoA11yViolations(page, 'Settings with a filter')

  // Leaving is refused once, then the edits are still there.
  page.once('dialog', (d) => d.dismiss())
  await page.getByRole('navigation', { name: 'Workspaces' }).getByRole('button', { name: 'Scripts' }).click()
  await expect(page.getByRole('button', { name: 'Save settings' })).toBeEnabled()

  await save.click()
  await expect(page.getByText('Settings saved to liftoff.toml', { exact: true })).toBeVisible()
  await expect(save).toBeDisabled()
  checkConsole()
})

test('S17 the workflow follows the chosen stages and installs LiftOff from its releases', async ({ page }) => {
  const checkConsole = watchConsole(page)
  await page.goto('/?open=1&ws=Pipelines')
  const preview = page.getByRole('region', { name: 'Workflow preview' })
  await expect(preview).toContainText("liftoff --environment 'staging' migrate")
  await expect(preview).toContainText('needs: staging')
  await expect(page.getByLabel('Install command')).toHaveValue(/github\.com\/sanderstad\/liftoff\/releases\/latest\/download\/liftoff-linux-x64/)
  await page.getByRole('checkbox', { name: 'production (prod)' }).click()
  await expect(preview).not.toContainText('production')
  await expectNoA11yViolations(page, 'Pipelines')
  await page.getByRole('button', { name: 'Write .github/workflows/liftoff.yml' }).click()
  await expect(page.getByText('Wrote C:/repos/shop-db/.github/workflows/liftoff.yml', { exact: true })).toBeVisible()
  checkConsole()
})

test('the last workspace comes back on the next open', async ({ page }) => {
  await page.goto('/?open=1')
  await page.getByRole('navigation', { name: 'Workspaces' }).getByRole('button', { name: 'Scripts' }).click()
  await page.goto('/?open=1')
  await expect(page.getByRole('navigation', { name: 'Workspaces' }).getByRole('button', { name: 'Scripts' })).toHaveAttribute('aria-current', 'page')
})

test('U-H2 an update: the button on the start page and in a project, and the choice under Settings > This app', async ({ page }) => {
  const checkConsole = watchConsole(page)
  await page.goto('/?update=available')
  await page.getByRole('button', { name: 'Update to 0.2.0' }).click()
  await expect(page.getByRole('button', { name: 'Restart to update' })).toBeVisible()

  await page.goto('/?open=1&ws=Settings')
  const app = page.getByRole('region', { name: 'This app' })
  await expect(app.getByRole('status')).toHaveText('This is LiftOff 0.1.0.')
  await app.getByRole('button', { name: 'Check now' }).click()
  await expect(app.getByRole('status')).toHaveText('LiftOff 0.1.0 is the latest version.')
  const mode = app.getByLabel('Updates')
  await expect(mode).toHaveValue('auto')
  await mode.selectOption('off')
  await expect(app.getByText('LiftOff contacts nothing but your databases.')).toBeVisible()
  await expectNoA11yViolations(page, 'Settings, This app')
  checkConsole()
})

test("U-H5 after an update: What's new, until it is opened", async ({ page }) => {
  const checkConsole = watchConsole(page)
  await page.goto('/?update=updated')
  await page.getByRole('button', { name: "What's new in 0.2.0" }).click()
  await expect(page.getByRole('button', { name: /What's new/ })).toBeHidden()
  checkConsole()
})
