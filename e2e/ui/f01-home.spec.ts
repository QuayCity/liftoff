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

  test('F01-H3 a new SQL Server project suggests SQL Server connection URLs', async ({ page }) => {
    await page.getByRole('button', { name: 'New project…' }).click()
    const dialog = page.getByRole('dialog', { name: 'New project' })
    await dialog.getByRole('button', { name: 'Choose…' }).click()
    await dialog.getByLabel('Project name').fill('mssql-shop')
    await dialog.getByLabel('Database engine').selectOption('sqlserver')
    await dialog.getByRole('button', { name: 'Create project' }).click()
    await page.getByRole('button', { name: 'Add environment' }).first().click()
    const env = page.getByRole('dialog', { name: 'Add environment' })
    // Server details, not a URL: the URL is built from them.
    await expect(env.getByLabel('Port', { exact: true })).toHaveAttribute('placeholder', '1433')
    await env.getByLabel('Port', { exact: true }).fill('61433')
    await env.getByLabel('Database', { exact: true }).fill('uat_dev')
    await env.getByText('Trust the server certificate', { exact: false }).click()
    await expect(env.getByText('sqlserver://localhost:61433;databaseName=uat_dev;encrypt=true;trustServerCertificate=true')).toBeVisible()
    await env.getByLabel('Port', { exact: true }).fill('port')
    await expect(env.getByText('A port is a number, e.g. 1433.')).toBeVisible()
    await env.getByLabel('Port', { exact: true }).fill('61433')
    // Sign-in methods: each asks only for what it needs.
    const signIn = env.getByLabel('Sign in with')
    await signIn.selectOption('ActiveDirectoryDefault')
    await expect(env.getByLabel('User', { exact: true })).toHaveCount(0)
    await expect(env.getByLabel('Password', { exact: true })).toHaveCount(0)
    await expect(env.getByText(';authentication=ActiveDirectoryDefault', { exact: false })).toBeVisible()
    await signIn.selectOption('ActiveDirectoryServicePrincipal')
    await expect(env.getByLabel('Application (client) ID')).toBeVisible()
    await expect(env.getByLabel('Client secret')).toBeVisible()
    await env.getByLabel('Directory (tenant) ID').fill('t1')
    await expect(env.getByText('authentication=ActiveDirectoryServicePrincipal;tenantId=t1', { exact: false })).toBeVisible()
    await signIn.selectOption('ActiveDirectoryInteractive')
    await expect(env.getByLabel('Account')).toBeVisible()
    await expect(env.getByLabel('Client secret')).toHaveCount(0)
    await signIn.selectOption('SqlPassword')
    await expect(env.getByLabel('User', { exact: true })).toBeVisible()
    await expect(env.getByText('sqlserver://localhost:61433;databaseName=uat_dev;encrypt=true;trustServerCertificate=true', { exact: true })).toBeVisible()
    await env.getByRole('button', { name: 'Enter a URL instead' }).click()
    await expect(env.getByLabel('Connection URL')).toHaveValue('sqlserver://localhost:61433;databaseName=uat_dev;encrypt=true;trustServerCertificate=true')
    await expect(env.getByLabel('Connection URL')).toHaveAttribute('placeholder', /^sqlserver:\/\//)
    await env.getByLabel('Connection URL').fill('sqlserver://${env.DB_HOST};databaseName=x')
    await env.getByRole('button', { name: 'Enter server details instead' }).click()
    await expect(env.getByRole('alert').filter({ hasText: "can't be shown as server details" })).toBeVisible()
    await expectNoA11yViolations(page, 'Add environment (SQL Server)')
  })

  test('F01-H4 a PostgreSQL project asks for PostgreSQL details: no instance, SSL instead of the certificate options', async ({ page }) => {
    await page.getByRole('button', { name: 'shop-db', exact: true }).click()
    await page.getByRole('button', { name: 'Add environment' }).first().click()
    const env = page.getByRole('dialog', { name: 'Add environment' })
    await expect(env.getByLabel('Port', { exact: true })).toHaveAttribute('placeholder', '5432')
    await expect(env.getByLabel('Instance')).toHaveCount(0)
    await expect(env.getByText('Trust the server certificate', { exact: false })).toHaveCount(0)
    await env.getByLabel('Server').fill('pg.internal')
    await env.getByLabel('Database', { exact: true }).fill('shop')
    await env.getByLabel('SSL').selectOption('require')
    await expect(env.getByText('postgres://pg.internal/shop?sslmode=require')).toBeVisible()
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
