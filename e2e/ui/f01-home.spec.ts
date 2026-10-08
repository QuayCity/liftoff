// F01 create/open a project, F12 open a Flyway folder. Browser preview with seeded data.
import { expect, test } from '@playwright/test'
import { expectNoA11yViolations, watchConsole } from '../helpers'

test.describe('F01 Home and projects', () => {
  let checkConsole: () => void
  test.beforeEach(async ({ page }) => {
    checkConsole = watchConsole(page)
    await page.goto('/')
  })
  test.afterEach(() => checkConsole())

  test('F01-H2 open a recent project', async ({ page }) => {
    await page.getByRole('button', { name: 'shop-db', exact: true }).click()
    await expect(page.getByRole('navigation', { name: 'Workspaces' }).getByRole('button', { name: 'Environments' })).toHaveAttribute('aria-current', 'page')
    await expect(page.getByRole('region', { name: 'staging environment' })).toBeVisible()
  })

  test('F01-N2 a missing folder cannot be opened, only removed', async ({ page }) => {
    const row = page.getByRole('listitem').filter({ hasText: 'billing' })
    await expect(row.getByText('Folder not found')).toBeVisible()
    await expect(row.getByRole('button', { name: 'billing' })).toHaveCount(0)
    await row.getByRole('button', { name: 'Remove' }).click()
    await expect(page.getByText('billing')).toHaveCount(0)
  })

  test('F01-E1 empty New project shows both field errors and writes nothing', async ({ page }) => {
    await page.getByRole('button', { name: 'New project…' }).click()
    const dialog = page.getByRole('dialog', { name: 'New project' })
    await dialog.getByRole('button', { name: 'Create project' }).click()
    await expect(dialog.getByText('Choose where the project lives.')).toBeVisible()
    await expect(dialog.getByText('Give the project a name.')).toBeVisible()
    await expect(dialog).toBeVisible()
    await expectNoA11yViolations(page, 'New project dialog')
  })

  test('F01-E4 keyboard only: open New project, Esc closes and focus returns', async ({ page }) => {
    const trigger = page.getByRole('button', { name: 'New project…' })
    await trigger.focus()
    await page.keyboard.press('Enter')
    await expect(page.getByRole('dialog', { name: 'New project' })).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(page.getByRole('dialog')).toHaveCount(0)
    await expect(trigger).toBeFocused()
  })

  test('F12-H1 a Flyway folder is offered for conversion, then opens', async ({ page }) => {
    await page.getByRole('button', { name: 'legacy-flyway' }).click()
    await expect(page.getByRole('status').filter({ hasText: 'This folder has a Flyway project' })).toBeVisible()
    await page.getByRole('button', { name: 'Convert settings…' }).click()
    const dialog = page.getByRole('dialog', { name: 'Flyway settings converted' })
    await expect(dialog.getByText('2 settings not carried over')).toBeVisible()
    await expect(dialog.getByText(/placeholders are not supported/)).toBeVisible()
    await expectNoA11yViolations(page, 'Flyway conversion summary')
    await dialog.getByRole('button', { name: 'Open project' }).click()
    await expect(page.getByRole('button', { name: 'legacy-flyway' })).toBeVisible()
  })

  test('X-A11Y Home', async ({ page }) => {
    await expectNoA11yViolations(page, 'Home (light)')
    await page.goto('/?theme=dark')
    await expectNoA11yViolations(page, 'Home (dark)')
  })
})
