// F21 Rules: every rule and its severity, the project's own rules, saving them, checking every script. Browser preview with seeded data.
import { expect, test } from '@playwright/test'
import { expectNoA11yViolations, watchConsole } from '../helpers'

test.describe('F21 Rules', () => {
  let checkConsole: () => void
  test.beforeEach(async ({ page }) => {
    checkConsole = watchConsole(page)
    await page.goto('/?open=1&ws=Rules')
  })
  test.afterEach(() => checkConsole())

  test('F21-H1 every rule with its severity; changing one, a pattern rule needs its pattern, then save', async ({ page }) => {
    await expect(page.getByRole('combobox', { name: 'Severity of delete-without-where' })).toHaveValue('error')
    await expect(page.getByText('USE switches database: the rest of the script runs there (SQL Server, MySQL)')).toBeVisible()
    const save = page.getByRole('button', { name: 'Save rules' })
    await expect(save).toBeDisabled()
    await page.getByRole('combobox', { name: 'Severity of drop-table' }).selectOption('error')
    await page.getByRole('combobox', { name: 'Severity of table-names' }).selectOption('warn')
    await expect(page.getByText('This rule needs a pattern to check against.')).toBeVisible()
    await expect(save).toBeDisabled()
    await page.getByLabel('Pattern (regular expression)').fill('^[a-z_]+$')
    await expectNoA11yViolations(page, 'Rules with changes')
    await save.click()
    await expect(page.getByText('Rules saved to liftoff.toml').first()).toBeVisible()
    await expect(save).toBeDisabled()
    await expect(page.getByRole('row').filter({ hasText: 'drop-table' }).getByText('changed')).toBeVisible()
  })

  test('F21-H2 an own rule, checking every script, and leaving with unsaved changes asks first', async ({ page }) => {
    await expect(page.getByRole('group', { name: 'Own rule 1' }).getByLabel('Name')).toHaveValue('no-cascade')
    await page.getByRole('button', { name: 'Add a rule' }).click()
    const own = page.getByRole('group', { name: 'Own rule 2' })
    await own.getByLabel('Name').fill('no-cascade')
    await expect(own.getByText('Already used by another rule.')).toBeVisible()
    await own.getByLabel('Name').fill('no-nolock')
    await own.getByLabel('Pattern').fill('NOLOCK')
    await own.getByLabel('Message').fill('NOLOCK reads uncommitted rows')
    await expect(page.getByRole('button', { name: 'Save rules' })).toBeEnabled()

    await page.getByRole('button', { name: 'Check every script' }).click()
    const findings = page.getByRole('table', { name: 'Rule findings' })
    await expect(findings.getByRole('row').filter({ hasText: 'table-without-primary-key' })).toContainText('warn')
    await expect(page.getByText(/1 warning in \d+ scripts/)).toBeVisible()

    page.once('dialog', (d) => { expect(d.message()).toBe('Leave Rules without saving your changes?'); void d.dismiss() })
    await page.getByRole('navigation', { name: 'Workspaces' }).getByRole('button', { name: 'Overview' }).click()
    await expect(page.getByRole('heading', { name: 'Rules', exact: true })).toBeVisible()
    await expectNoA11yViolations(page, 'Rules with findings')
  })
})
