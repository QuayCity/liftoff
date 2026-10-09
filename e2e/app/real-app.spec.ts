// The real desktop app: the Electron window + the TypeScript core + Postgres, launched by Playwright.
// Needs: LIFTOFF_TEST_PG (e.g. postgres://postgres:liftoff@localhost:55432) with databases shop_dev,
// shop_scratch and shop_test in the Docker container named by LIFTOFF_TEST_PG_CONTAINER (default
// liftoff-pg), and a built app: `npm run build && npm run build:electron` in apps/desktop.
// It backs up and restores the app's recent-projects file.
import { _electron, expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { expectNoA11yViolations, watchConsole } from '../helpers'

const base = process.env.LIFTOFF_TEST_PG
const container = process.env.LIFTOFF_TEST_PG_CONTAINER ?? 'liftoff-pg'
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const desktop = path.join(repo, 'apps/desktop')
const electron = path.join(desktop, 'node_modules/electron/dist', process.platform === 'win32' ? 'electron.exe' : 'electron')
const built = path.join(desktop, 'dist-electron/main.mjs')
const appData = process.env.APPDATA ?? path.join(os.homedir(), 'AppData/Roaming')
const recentFile = path.join(appData, 'app.liftoff.desktop/recent.json')

test.skip(!base || process.platform !== 'win32' || !fs.existsSync(built), 'needs LIFTOFF_TEST_PG, Windows and a built desktop app')
test.describe.configure({ mode: 'serial' })

const psql = (db: string, sql: string) =>
  execFileSync('docker', ['exec', container, 'psql', '-U', 'postgres', '-d', db, '-qAtc', sql], { encoding: 'utf8' }).trim()

const backups = new Map<string, string | null>()
function replace(file: string, content: string) {
  if (!backups.has(file)) backups.set(file, fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, content)
}
function restoreAll() {
  for (const [file, content] of backups) {
    if (content === null) fs.rmSync(file, { force: true })
    else fs.writeFileSync(file, content)
  }
}

let project: string
let app: ElectronApplication
let page: Page
let checkConsole: () => void

test.beforeAll(async () => {
  for (const db of ['shop_dev', 'shop_scratch', 'shop_test']) psql(db, 'drop schema if exists public cascade; create schema public;')
  project = fs.mkdtempSync(path.join(os.tmpdir(), 'liftoff-app-'))
  fs.mkdirSync(path.join(project, 'migrations'))
  fs.writeFileSync(path.join(project, 'migrations/V1__orders.sql'), 'create table orders (id int primary key, note text);\n')
  fs.writeFileSync(
    path.join(project, 'liftoff.toml'),
    `[project]\nname = "app-e2e"\nmigrations = "migrations"\nschemas = ["public"]\n\n` +
      `[environments.dev]\nurl = "${base}/shop_dev"\nrole = "dev"\n\n` +
      `[environments.scratch]\nurl = "${base}/shop_scratch"\nrole = "scratch"\n\n` +
      // The database name comes from a variable, as teams do for secrets and per-machine values.
      `[environments.test]\nurl = "${base}/\${env.LO_E2E_TEST_DB}"\nrole = "test"\n`,
  )
  replace(recentFile, JSON.stringify([{ name: 'app-e2e', path: project, exists: true }]))

  app = await _electron.launch({ executablePath: electron, args: [desktop], cwd: desktop, env: { ...process.env, LO_E2E_TEST_DB: 'shop_test' } })
  page = await app.firstWindow()
  checkConsole = watchConsole(page)
  await expect(page.getByRole('heading', { name: 'LiftOff' })).toBeVisible({ timeout: 30_000 })
})

test.afterAll(async () => {
  await app?.close().catch(() => {})
  restoreAll()
  if (project) fs.rmSync(project, { recursive: true, force: true })
})

const column = (name: string) => page.getByRole('region', { name: `${name} environment` })
const details = (name: string) => page.getByRole('region', { name: `${name} details` })

test('F01-H2 open the project from Recent; every database connects', async () => {
  await page.getByRole('button', { name: 'app-e2e', exact: true }).click()
  for (const env of ['dev', 'scratch', 'test']) await expect(column(env).getByText('Connected')).toBeVisible()
  await expect(column('test').getByText('1 script', { exact: true })).toBeVisible()
  await expectNoA11yViolations(page, 'real Environments')
})

test('F04-H1 run pending on test: Postgres gets the table and the history row', async () => {
  await column('test').getByRole('button', { name: 'Run pending' }).click()
  await expect(page.getByText('Ran 1 script on test', { exact: true })).toBeVisible()
  await expect(details('test').getByRole('table', { name: 'Migrations on test' }).getByText('Applied')).toBeVisible()
  expect(psql('shop_test', "select count(*) from liftoff_schema_history where success and script = 'V1__orders.sql'")).toBe('1')
  expect(psql('shop_test', "select to_regclass('public.orders') is not null")).toBe('t')
})

test('F01-E4 editing an environment keeps ${env.X} in its URL, its password, and where it is stored', async () => {
  await details('test').getByRole('button', { name: 'Edit test' }).click()
  const dialog = page.getByRole('dialog', { name: 'Edit test' })
  await expect(dialog.getByLabel('Connection URL')).toHaveValue(/\$\{env\.LO_E2E_TEST_DB\}$/)
  await expect(dialog.getByRole('radio', { name: 'Everyone on the project' })).toBeChecked()
  // Test with the password field empty: the saved password and the variable are used.
  await dialog.getByRole('button', { name: 'Test connection' }).click()
  await expect(dialog.getByText('Connected', { exact: true })).toBeVisible()
  await dialog.getByRole('button', { name: 'Save' }).click()
  await expect(dialog).toBeHidden()
  const toml = fs.readFileSync(path.join(project, 'liftoff.toml'), 'utf8')
  expect(toml).toContain(`url = "${base}/\${env.LO_E2E_TEST_DB}"`)
  const user = path.join(project, 'liftoff.user.toml')
  expect(fs.existsSync(user) ? fs.readFileSync(user, 'utf8') : '').not.toContain('[environments.test]')
  await expect(column('test').getByText('Connected')).toBeVisible()
})

test('F15-H2 run only one script on test: Postgres gets that one, not the older one', async () => {
  fs.writeFileSync(path.join(project, 'migrations/V2__notes.sql'), 'create table notes (id int);\n')
  fs.writeFileSync(path.join(project, 'migrations/V3__tags.sql'), 'create table tags (id int);\n')
  await details('test').getByRole('combobox', { name: 'Command' }).selectOption('info')
  await details('test').getByRole('button', { name: 'Refresh status' }).click()
  const table = details('test').getByRole('table', { name: 'Migrations on test' })
  await table.getByRole('button', { name: 'Run only V3__tags.sql' }).click()
  const dialog = page.getByRole('dialog', { name: 'Run only V3__tags.sql on test?' })
  await expect(dialog.getByText('V2__notes.sql')).toBeVisible()
  await dialog.getByRole('button', { name: 'Run this script only' }).click()
  await expect(page.getByText('Ran V3__tags.sql on test; not run yet, and older: V2__notes.sql').first()).toBeVisible()
  expect(psql('shop_test', "select string_agg(script, ',' order by script) from liftoff_schema_history where success")).toBe('V1__orders.sql,V3__tags.sql')
  // Tidy up for the tests after this one.
  psql('shop_test', "drop table tags; delete from liftoff_schema_history where script = 'V3__tags.sql'")
  fs.rmSync(path.join(project, 'migrations/V2__notes.sql'))
  fs.rmSync(path.join(project, 'migrations/V3__tags.sql'))
  await details('test').getByRole('button', { name: 'Refresh status' }).click()
  await details('test').getByRole('combobox', { name: 'Command' }).selectOption('migrate')
})

test('F04-E2 a failing script is rolled back and its Postgres error is shown', async () => {
  fs.writeFileSync(path.join(project, 'migrations/V2__broken.sql'), 'create table half (id int);\nselect * from no_such_table;\n')
  await details('test').getByRole('button', { name: 'Refresh' }).click()
  await column('test').getByRole('button', { name: 'Run pending' }).click()
  await expect(page.getByRole('log')).toContainText('relation "no_such_table" does not exist')
  await expect(details('test').getByRole('table', { name: 'Migrations on test' }).getByText('Pending')).toBeVisible()
  expect(psql('shop_test', "select to_regclass('public.half') is null")).toBe('t')
  fs.rmSync(path.join(project, 'migrations/V2__broken.sql'))
  await details('test').getByRole('button', { name: 'Refresh' }).click()
})

test('F03-H1 write a migration from dev changes; it is recorded as applied on dev', async () => {
  await column('dev').getByRole('button', { name: 'Run pending' }).click()
  await expect(page.getByText('Ran 1 script on dev', { exact: true })).toBeVisible()
  psql('shop_dev', 'create table customers (id bigint generated always as identity primary key, email text not null unique);')

  await page.getByRole('navigation', { name: 'Workspaces' }).getByRole('button', { name: 'Changes' }).click()
  await page.getByRole('button', { name: 'Compare' }).click()
  await expect(page.getByRole('treeitem', { name: 'Added public.customers' })).toBeVisible({ timeout: 60_000 })
  await page.getByLabel('Description').fill('add customers')
  await page.getByRole('button', { name: 'Write migration…' }).click()
  const dialog = page.getByRole('dialog', { name: 'Review the migration' })
  await expect(dialog.getByLabel('Generated script')).toContainText('CREATE TABLE public.customers')
  await dialog.getByRole('button', { name: 'Save to migrations' }).click()
  // The project's first script is V1, so the next version is a counter (V2), not a timestamp.
  await expect(page.getByText(/^Wrote V[0-9._]+__add_customers\.sql$/)).toBeVisible()

  const file = fs.readdirSync(path.join(project, 'migrations')).find((f) => f.endsWith('__add_customers.sql'))
  expect(file).toBeTruthy()
  expect(psql('shop_dev', `select count(*) from liftoff_schema_history where script = '${file}'`)).toBe('1')
  await page.getByRole('navigation', { name: 'Workspaces' }).getByRole('button', { name: 'Scripts' }).click()
  await expect(page.getByRole('row', { name: /add customers/ })).toBeVisible()
})

test('F08-H1 a hand change on test shows up as drift', async () => {
  psql('shop_test', 'alter table orders add column hotfix int;')
  await page.getByRole('navigation', { name: 'Workspaces' }).getByRole('button', { name: 'Environments' }).click()
  await column('test').getByRole('button', { name: 'test' }).click()
  await details('test').getByRole('tab', { name: 'Checks' }).click()
  await details('test').getByRole('button', { name: 'Check for drift' }).click()
  await expect(details('test').getByText('1 object changed outside the scripts')).toBeVisible({ timeout: 60_000 })
  await expect(details('test').getByRole('table', { name: /compared with In test/ })).toContainText('hotfix integer')
  psql('shop_test', 'alter table orders drop column hotfix;')
})

test('F09-H1 clean the scratch database after typing its name', async () => {
  psql('shop_scratch', 'create table leftover (id int);')
  await column('scratch').getByRole('button', { name: 'scratch' }).click()
  // The detail keeps the tab you were on when you switch environments; the commands live on Migrations.
  await details('scratch').getByRole('tab', { name: 'Migrations' }).click()
  await details('scratch').getByRole('combobox', { name: 'Command' }).selectOption({ label: 'Clean…' })
  await details('scratch').getByRole('button', { name: 'Clean…' }).click()
  const dialog = page.getByRole('alertdialog', { name: 'Clean scratch' })
  await dialog.getByLabel('Type scratch to confirm').fill('scratch')
  await dialog.getByRole('button', { name: 'Erase everything' }).click()
  await expect(page.getByText('scratch is empty', { exact: true })).toBeVisible()
  expect(psql('shop_scratch', "select count(*) from pg_tables where schemaname = 'public'")).toBe('0')
})

test('F07-N2 a database with tables but no history asks for a baseline instead of failing', async () => {
  psql('shop_test', 'drop schema public cascade; create schema public; create table orders (id int primary key, note text);')
  await column('test').getByRole('button', { name: 'test' }).click()
  await details('test').getByRole('tab', { name: 'Migrations' }).click()
  await details('test').getByRole('button', { name: 'Refresh' }).click()
  await column('test').getByRole('button', { name: 'Run pending' }).click()
  const ask = page.getByRole('dialog', { name: 'test already has tables' })
  await expect(ask).toBeVisible()
  await ask.getByRole('button', { name: 'Baseline…' }).click()
  const baseline = page.getByRole('dialog', { name: 'Baseline test' })
  await baseline.getByRole('button', { name: 'Set baseline' }).click()
  await expect(page.getByText('test marked as being at version 1', { exact: true })).toBeVisible()
  expect(psql('shop_test', "select type from liftoff_schema_history")).toBe('BASELINE')
})

test('F02-H1 save dev into the schema model: one file per object', async () => {
  await page.getByRole('navigation', { name: 'Workspaces' }).getByRole('button', { name: 'Changes' }).click()
  await page.getByRole('group', { name: 'Compare dev with' }).getByRole('button', { name: 'Schema model' }).click()
  await page.getByRole('button', { name: 'Compare' }).click()
  await expect(page.getByRole('treeitem', { name: 'Added customers' })).toBeVisible({ timeout: 60_000 })
  await page.getByRole('button', { name: 'Save to model' }).click()
  await expect(page.getByText(/^Saved \d+ files? to .*schema-model$/)).toBeVisible()
  const file = path.join(project, 'schema-model/public/tables/customers.sql')
  expect(fs.readFileSync(file, 'utf8')).toContain('CREATE TABLE public.customers')
  await expect(page.getByText('The schema model matches dev.')).toBeVisible()
})

test('F06-H1 commit the migration scripts with real git', async () => {
  const git = (...args: string[]) => execFileSync('git', args, { cwd: project, encoding: 'utf8' }).trim()
  git('init', '-b', 'main')
  git('config', 'user.name', 'E2E')
  git('config', 'user.email', 'e2e@example.test')
  git('config', 'commit.gpgsign', 'false')
  fs.writeFileSync(path.join(project, 'scratch-notes.txt'), 'not for the commit\n')
  await page.getByRole('navigation', { name: 'Workspaces' }).getByRole('button', { name: 'Commit' }).click()
  const files = page.getByRole('list', { name: 'Changed files' })
  await expect(files.getByRole('checkbox', { name: 'Include migrations/V1__orders.sql' })).toBeChecked()
  await expect(files.getByRole('checkbox', { name: 'Include scratch-notes.txt' })).not.toBeChecked()
  await page.getByLabel('Commit message').fill('Add the first migrations')
  await page.getByRole('button', { name: /^Commit \d+ files?$/ }).click()
  await expect(page.getByText(/^Committed \d+ files? \([0-9a-f]+\)$/)).toBeVisible()
  expect(git('log', '--format=%s')).toBe('Add the first migrations')
  expect(git('show', '--name-only', '--format=', 'HEAD')).toContain('migrations/V1__orders.sql')
  expect(git('status', '--porcelain')).toContain('scratch-notes.txt')
})

test('S20-H1 the history of a schema-model object comes from real git', async () => {
  const git = (...args: string[]) => execFileSync('git', args, { cwd: project, encoding: 'utf8' }).trim()
  const file = path.join(project, 'schema-model/public/tables/customers.sql')
  // F06 committed the schema-model files with the scripts; this adds a second commit to the object.
  fs.appendFileSync(file, 'COMMENT ON TABLE public.customers IS NULL;\n')
  git('commit', '-am', 'Model: a note on customers')

  await page.getByRole('navigation', { name: 'Workspaces' }).getByRole('button', { name: 'Changes' }).click()
  await page.getByRole('group', { name: 'Compare dev with' }).getByRole('button', { name: 'Schema model' }).click()
  await page.getByRole('button', { name: 'Object history…' }).click()
  const dialog = page.getByRole('dialog', { name: 'Object history' })
  await dialog.getByRole('region', { name: 'Objects' }).getByRole('button', { name: 'public/tables/customers' }).click()
  const commits = dialog.getByRole('region', { name: 'Commits' })
  await expect(commits.getByRole('button').first()).toContainText('Model: a note on customers')
  await expect(commits.getByRole('button', { name: /Add the first migrations/ })).toBeVisible()
  await expect(dialog.getByRole('region', { name: 'What the commit changed' })).toContainText('COMMENT ON TABLE public.customers')
  await page.keyboard.press('Escape')
})

test('X-CONSOLE no console errors in the real app', async () => {
  checkConsole()
})
