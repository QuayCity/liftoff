// Takes the VS Code screenshots in this folder: a real VS Code with the extension, on a SQLite copy
// of the sample project (no database server needed), so they can be made again when it changes:
//   cd packages/liftoff && npm run build:cli
//   cd apps/vscode && npm run build && npm run copy-ui
//   node docs/images/render-vscode.mjs
// Uses the VS Code that `npm run test:vscode` downloaded into apps/vscode/.vscode-test, and the
// Playwright from e2e/ (cd e2e && npm install).

import { execFileSync, spawn } from 'node:child_process'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import os from 'node:os'
import { dirname, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const repo = join(here, '..', '..')
const { chromium } = createRequire(join(repo, 'e2e', 'package.json'))('playwright')
const ext = join(repo, 'apps', 'vscode')
const cli = join(repo, 'packages', 'liftoff', 'build', process.platform === 'win32' ? 'liftoff.exe' : 'liftoff')
const cached = join(ext, '.vscode-test')
const build = fs.readdirSync(cached).filter((d) => d.startsWith('vscode-')).sort().at(-1)
if (!build) throw new Error('no VS Code in apps/vscode/.vscode-test: run npm run test:vscode once')
const code = join(cached, build, process.platform === 'win32' ? 'Code.exe' : 'code')

// The project: the sample shop on SQLite, with dev, test and prod in different states.
const tmp = fs.mkdtempSync(join(os.tmpdir(), 'lo-shots-'))
const project = join(tmp, 'shop')
fs.mkdirSync(project)
const lo = (...args) => execFileSync(cli, ['-C', project, ...args], { stdio: 'pipe' })
lo('init', '--sample', '--engine', 'sqlite', '--name', 'shop')
fs.appendFileSync(join(project, 'liftoff.toml'), `
[environments.dev]
url = "sqlite:dev.db"
role = "dev"

[environments.test]
url = "sqlite:test.db"
role = "test"

[environments.prod]
url = "sqlite:prod.db"
role = "prod"

[environments.scratch]
url = "sqlite:scratch.db"
role = "scratch"
`)
fs.appendFileSync(join(project, '.gitignore'), '\n*.db\n')
lo('-e', 'dev', 'migrate')
lo('-e', 'test', 'migrate')
lo('-e', 'prod', 'migrate', '--target', '0001')
lo('-e', 'dev', 'model')
// A change made by hand in dev, for the Schema Model view.
const dev = new DatabaseSync(join(project, 'dev.db'))
dev.exec(`DROP TABLE customers;
CREATE TABLE customers (
    id integer primary key,
    email text not null unique,
    phone text,
    created_at text not null default current_timestamp
);`)
dev.close()
// A script that the rules warn about, for the Problems panel.
fs.writeFileSync(join(project, 'migrations', 'V0004__drop_old_orders.sql'), '-- the old orders table is no longer used\nDROP TABLE orders;\n')
execFileSync('git', ['init', '-q'], { cwd: project })

const user = join(tmp, 'user-data')
fs.mkdirSync(join(user, 'User'), { recursive: true })
fs.writeFileSync(join(user, 'User', 'settings.json'), JSON.stringify({
  'workbench.colorTheme': 'Default Light Modern',
  'workbench.startupEditor': 'none',
  'workbench.tips.enabled': false,
  'workbench.secondarySideBar.defaultVisibility': 'hidden',
  'chat.disableAIFeatures': true,
  'security.workspace.trust.enabled': false,
  'update.mode': 'none',
  'telemetry.telemetryLevel': 'off',
  'extensions.ignoreRecommendations': true,
  'git.openRepositoryInParentFolders': 'never',
  'window.restoreWindows': 'none',
  'liftoff.cliPath': cli,
}))

// The extension packaged and installed, as people get it (a development host would say so in the title).
const vsix = join(tmp, 'liftoff.vsix')
const extensions = join(tmp, 'extensions')
execFileSync('npx', ['vsce', 'package', '--no-dependencies', '--allow-missing-repository', '-o', `"${vsix}"`], { cwd: ext, shell: true, stdio: 'ignore' })
const codeCli = join(cached, build, 'bin', process.platform === 'win32' ? 'code.cmd' : 'code')
execFileSync(`"${codeCli}"`, ['--install-extension', `"${vsix}"`, `--extensions-dir="${extensions}"`, `--user-data-dir="${user}"`], { shell: true, stdio: 'ignore' })

const port = 9333
const vscode = spawn(code, [project, `--remote-debugging-port=${port}`, `--user-data-dir=${user}`,
  `--extensions-dir=${extensions}`, '--force-device-scale-factor=2',
  '--disable-workspace-trust', '--skip-welcome', '--skip-release-notes', '--new-window'], { stdio: 'ignore' })

let browser
for (let i = 0; !browser; i++) {
  browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`).catch(() => undefined)
  if (!browser && i > 60) throw new Error('VS Code did not start')
  if (!browser) await new Promise((r) => setTimeout(r, 500))
}
let page
while (!page) {
  page = browser.contexts().flatMap((c) => c.pages()).find((p) => p.url().includes('workbench'))
  if (!page) await new Promise((r) => setTimeout(r, 300))
}
await page.locator('.monaco-workbench').waitFor()
const cdp = await page.context().newCDPSession(page)
await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 860, deviceScaleFactor: 2, mobile: false })

async function shot(file) {
  await page.waitForTimeout(800)
  await page.screenshot({ path: join(here, file) })
  console.log(`wrote docs/images/${file}`)
}
async function command(title) {
  await page.keyboard.press('F1')
  await page.keyboard.type(title)
  await page.waitForTimeout(400)
  await page.keyboard.press('Enter')
}
const row = (name) => page.getByRole('treeitem', { name, exact: false }).first()

// The Environments view, with a script open beside it.
await page.getByRole('tab', { name: /LiftOff/ }).first().click()
await row('prod').waitFor({ timeout: 30000 })
for (const env of ['test', 'prod']) {
  await row(env).click()
  await page.waitForTimeout(1500)
}
await page.getByRole('treeitem', { name: /V0002/ }).last().click()
await shot('vscode-environments.png')

// A rule's finding where you type, and in Problems.
await command('Go to File')
await page.keyboard.type('V0004__drop_old_orders.sql')
await page.waitForTimeout(500)
await page.keyboard.press('Enter')
await page.waitForTimeout(1500)
await command('View: Focus Problems')
await shot('vscode-rules.png')
await command('View: Close Panel')

// The Schema Model view: dev compared with the model, one difference side by side.
await command('LiftOff: Compare with Dev')
const changed = page.getByRole('tree', { name: /Schema Model/ }).getByRole('treeitem').first()
await changed.waitFor({ timeout: 60000 })
await command('Focus on Schema Model View')
await page.waitForTimeout(500)
await page.keyboard.press('Home')
await page.keyboard.press('Enter')
await page.locator('.monaco-diff-editor').first().waitFor({ timeout: 60000 })
await shot('vscode-schema-model.png')

// The LiftOff panel: the desktop app's screens in an editor tab.
await command('View: Close All Editors')
await command('LiftOff: Open LiftOff')
await page.waitForTimeout(6000)
await shot('vscode-panel.png')

await browser.close()
vscode.kill()
process.exit(0)
