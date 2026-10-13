// F20 Overview: every environment's state, what is where, and the activity of each database. Browser preview with seeded data.
import { expect, test } from '@playwright/test'
import { expectNoA11yViolations, watchConsole } from '../helpers'

test.describe('F20 Overview', () => {
  let checkConsole: () => void
  test.beforeEach(async ({ page }) => {
    checkConsole = watchConsole(page)
  })
  test.afterEach(() => checkConsole())

  test('F20-H1 each environment with its version, what waits, and its last run; an unreachable one says so', async ({ page }) => {
    await page.goto('/?open=1&ws=Overview')
    await expect(page.getByRole('region', { name: 'local overview' })).toContainText('Up to date')
    await expect(page.getByRole('region', { name: 'staging overview' })).toContainText('2 scripts waiting')
    await expect(page.getByRole('region', { name: 'staging overview' })).toContainText('by deploy')
    await expect(page.getByRole('region', { name: 'production overview' })).toContainText("Can't be read")
    await expect(page.getByRole('region', { name: 'scratch overview' })).toHaveCount(0)
    const matrix = page.getByRole('table', { name: 'Scripts by environment' })
    await expect(matrix.getByRole('row').filter({ hasText: 'daily_totals_view' })).toContainText('Pending')
    await expect(matrix.getByRole('row').filter({ hasText: 'test_fixtures' })).toContainText('Not here')
    await expectNoA11yViolations(page, 'Overview')
  })

  test('F20-H2 the activity: newest first, failures only, and a run in detail', async ({ page }) => {
    await page.goto('/?open=1&ws=Overview')
    const runs = page.getByRole('table', { name: 'Runs, newest first' })
    await expect(runs.getByRole('row')).toHaveCount(6)
    await page.getByRole('checkbox', { name: 'Failures only' }).check()
    await expect(runs.getByRole('row')).toHaveCount(2)
    await runs.getByRole('row').filter({ hasText: 'Failed' }).click()
    await expect(page.getByText('What went wrong')).toBeVisible()
    await expect(page.getByText(/round\(double precision, integer\) does not exist/)).toBeVisible()
    await expect(page.getByText('https://github.com/acme/shop-db/actions/runs/11873')).toBeVisible()
    await expectNoA11yViolations(page, 'Overview with a run open')
  })

  test('F20-H3 a run from Environments shows up in the activity', async ({ page }) => {
    await page.goto('/?open=1&ws=Environments')
    await page.getByRole('region', { name: 'staging environment' }).click()
    await page.getByRole('region', { name: 'staging details' }).getByRole('button', { name: 'Run pending' }).click()
    await expect(page.getByText('Ran 2 scripts on staging', { exact: true })).toBeVisible()
    await page.getByRole('navigation', { name: 'Workspaces' }).getByRole('button', { name: 'Overview' }).click()
    await expect(page.getByRole('region', { name: 'staging overview' })).toContainText('Up to date')
    await expect(page.getByRole('table', { name: 'Runs, newest first' }).getByRole('row').nth(1)).toContainText('2 scripts')
  })

  test('F20-H4 all recent projects side by side from the start page', async ({ page }) => {
    await page.goto('/')
    await page.getByRole('button', { name: 'Overview of all projects' }).click()
    await expect(page.getByRole('region', { name: 'shop-db environments' }).getByRole('region', { name: 'staging overview' })).toBeVisible()
    await expect(page.getByRole('region', { name: 'legacy-flyway environments' })).toContainText("Can't read legacy-flyway")
    await expect(page.getByRole('table', { name: 'Runs, newest first' }).getByRole('columnheader', { name: 'Project' })).toBeVisible()
    await expectNoA11yViolations(page, 'All projects')
    await page.getByRole('region', { name: 'shop-db environments' }).getByRole('button', { name: 'Open' }).click()
    await expect(page.getByRole('navigation', { name: 'Workspaces' })).toBeVisible()
  })
})
