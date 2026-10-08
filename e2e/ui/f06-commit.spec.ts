// F06 commit and push from the Commit workspace. Browser preview with seeded data.
import { expect, test } from '@playwright/test'
import { expectNoA11yViolations, watchConsole } from '../helpers'

test('F06-H1 scripts and settings are pre-selected; commit then push', async ({ page }) => {
  const checkConsole = watchConsole(page)
  await page.goto('/?open=1&ws=Commit')
  const files = page.getByRole('list', { name: 'Changed files' })
  await expect(files.getByRole('checkbox', { name: 'Include migrations/V20261008.1104__add_customers.sql' })).toBeChecked()
  await expect(files.getByRole('checkbox', { name: 'Include liftoff.toml' })).toBeChecked()
  await expect(files.getByRole('checkbox', { name: 'Include notes/todo.md' })).not.toBeChecked()
  await expectNoA11yViolations(page, 'Commit')

  const commit = page.getByRole('button', { name: 'Commit 2 files' })
  await expect(commit).toBeDisabled()
  await page.getByLabel('Commit message').fill('Add customers table')
  await commit.click()
  await expect(page.getByText('Committed 2 files (a1b2c3d)', { exact: true })).toBeVisible()
  await expect(files.getByText('notes/todo.md')).toBeVisible()
  await expect(page.getByText('1 to push, 0 to pull')).toBeVisible()

  await page.getByRole('button', { name: 'Push' }).click()
  await expect(page.getByText('Pushed', { exact: true })).toBeVisible()
  checkConsole()
})

test('F06-E1 a rejected push offers to pull, then pushes', async ({ page }) => {
  const checkConsole = watchConsole(page)
  await page.goto('/?open=1&ws=Commit&rejectpush=1')
  await page.getByLabel('Commit message').fill('Add customers table')
  await page.getByRole('button', { name: 'Commit 2 files' }).click()
  await page.getByRole('button', { name: 'Push' }).click()
  const toast = page.getByRole('status').filter({ hasText: 'The remote has commits you do not have yet' }).or(page.locator('li').filter({ hasText: 'The remote has commits you do not have yet' })).first()
  await expect(toast).toBeVisible()
  await page.getByRole('button', { name: 'Pull changes' }).click()
  await expect(page.getByText('Up to date with the remote', { exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Push' }).click()
  await expect(page.getByText('Pushed', { exact: true })).toBeVisible()
  checkConsole()
})
