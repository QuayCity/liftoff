// S20 object history and the S01 sample project. Browser preview with seeded data.
import { expect, test } from '@playwright/test'
import { expectNoA11yViolations, watchConsole } from '../helpers'

test('S20-H1 the history of one object: its commits and what each changed', async ({ page }) => {
  const checkConsole = watchConsole(page)
  await page.goto('/?open=1&ws=Changes')
  await page.getByRole('navigation', { name: 'Workspaces' }).getByRole('button', { name: 'History' }).click()
  const history = page.getByRole('main')
  const objects = history.getByRole('region', { name: 'Objects' })
  const commits = history.getByRole('region', { name: 'Commits' })

  await objects.getByRole('button', { name: 'tables/public.orders' }).click()
  await expect(commits.getByRole('button')).toHaveCount(3)
  await expect(commits.getByRole('button').first()).toContainText('Track when orders are paid')
  await expect(history.getByRole('region', { name: 'What the commit changed' })).toContainText('paid_at')
  // An older commit shows what it changed, against the one before it.
  await commits.getByRole('button', { name: /Notes are required/ }).click()
  await expect(commits.getByRole('button', { name: /Notes are required/ })).toHaveAttribute('aria-current', 'true')
  await expect(history.getByRole('region', { name: 'What the commit changed' })).toContainText('note text NOT NULL')
  await expectNoA11yViolations(page, 'Object history')

  // An object never committed says so; the filter narrows the list.
  await objects.getByRole('button', { name: /tax/ }).click()
  await expect(commits).toContainText('Not committed yet')
  await objects.getByLabel('Filter objects').fill('view')
  await expect(objects.getByRole('button')).toHaveCount(1)
  await objects.getByLabel('Filter objects').fill('nothing like this')
  await expect(objects).toContainText('No object matches.')
  checkConsole()
})

test('S01-H3 try the sample project from the start page', async ({ page }) => {
  const checkConsole = watchConsole(page)
  await page.goto('/')
  await expect(page.getByRole('heading', { name: 'Try the sample' })).toBeVisible()
  await page.getByRole('button', { name: 'Create sample…' }).click()
  await expect(page.getByText('shop-sample').first()).toBeVisible()
  checkConsole()
})

test('BUG-014: outside a git repository the history explains itself instead of showing git output', async ({ page }) => {
  await page.goto('/?open=1&ws=History&nogit')
  const history = page.getByRole('main')
  await expect(history.getByRole('region', { name: 'Commits' })).toContainText('This project is not in a git repository')
  await expect(history).not.toContainText('fatal:')
  await expect(history).not.toContainText('Not committed yet')
})
