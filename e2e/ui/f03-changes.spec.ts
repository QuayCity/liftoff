// F03 write a migration from dev changes. Browser preview with seeded data.
import { expect, test } from '@playwright/test'
import { expectNoA11yViolations, watchConsole } from '../helpers'

test.describe('F03 Changes', () => {
  let checkConsole: () => void
  test.beforeEach(async ({ page }) => {
    checkConsole = watchConsole(page)
    await page.goto('/?open=1&ws=Changes')
    await page.getByRole('button', { name: 'Compare' }).click()
    await expect(page.getByRole('tree', { name: 'Changes' })).toBeVisible()
  })
  test.afterEach(() => checkConsole())

  test('F03-E2 destructive changes start unticked and warn when chosen', async ({ page }) => {
    const cart = page.getByRole('treeitem', { name: /legacy_cart/ })
    await expect(cart).toHaveAttribute('aria-checked', 'false')
    await expect(cart.getByText('data loss')).toBeVisible()
    await expect(page.getByText('This migration may lose data')).toHaveCount(0)
    await cart.getByRole('checkbox').click()
    await expect(page.getByText('This migration may lose data')).toBeVisible()
  })

  test('F03-E6 keyboard: arrows move, Space toggles, Enter previews, group goes tri-state', async ({ page }) => {
    const tree = page.getByRole('tree', { name: 'Changes' })
    const group = tree.getByRole('treeitem', { name: /^Tables/ })
    await group.focus()
    await page.keyboard.press('ArrowDown')
    await expect(tree.getByRole('treeitem', { name: /public\.customer$/ })).toBeFocused()
    await page.keyboard.press('ArrowDown')
    await page.keyboard.press('Enter')
    await expect(page.getByRole('tab', { name: 'Side by side', selected: true })).toBeVisible()
    await expect(page.getByRole('table', { name: /From the migrations compared with In local/ })).toContainText('paid_at')
    await page.keyboard.press('Space')
    await expect(tree.getByRole('treeitem', { name: /public\.orders/ })).toHaveAttribute('aria-checked', 'false')
    await expect(group).toHaveAttribute('aria-checked', 'mixed')
  })

  test('F03-E4/H1 description rules, then write and save the migration', async ({ page }) => {
    await page.getByRole('button', { name: 'Write migration…' }).click()
    await expect(page.getByText('Describe the migration in a few words.')).toBeVisible()
    await page.getByLabel('Description').fill('add customers')
    await page.getByLabel('Also write an undo script').check()
    await page.getByRole('button', { name: 'Write migration…' }).click()
    const dialog = page.getByRole('dialog', { name: 'Review the migration' })
    await expect(dialog.getByText('V20261008.1104__add_customers.sql')).toBeVisible()
    await expect(dialog.getByLabel('Record it as applied on local, which already has these changes')).toBeChecked()
    await expectNoA11yViolations(page, 'Review the migration')
    await dialog.getByRole('button', { name: 'Save to migrations' }).click()
    await expect(page.getByText('Wrote V20261008.1104__add_customers.sql and its undo script', { exact: true })).toBeVisible()
  })

  test('X-A11Y Changes', async ({ page }) => {
    await expectNoA11yViolations(page, 'Changes (light)')
  })
})

test('F03-N1 without a licence Changes explains Pro', async ({ page }) => {
  const checkConsole = watchConsole(page)
  await page.goto('/?open=1&ws=Changes&licensed=0')
  await expect(page.getByText(/part of LiftOff Pro/)).toBeVisible()
  await expect(page.getByRole('button', { name: 'Add a licence' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Compare' })).toHaveCount(0)
  checkConsole()
})
