// The VS Code extension's settings page (apps/vscode/media/settings.js), in a plain browser page
// with a stand-in for the VS Code webview API and the colours of VS Code's dark theme.
import { expect, test, type Page } from '@playwright/test'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { expectNoA11yViolations, watchConsole } from '../helpers'

const media = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../apps/vscode/media')

const THEME = `:root {
  --vscode-foreground: #cccccc; --vscode-editor-background: #1f1f1f; --vscode-descriptionForeground: #9d9d9d;
  --vscode-input-background: #313131; --vscode-input-foreground: #cccccc; --vscode-input-border: #3c3c3c;
  --vscode-button-background: #0078d4; --vscode-button-foreground: #ffffff; --vscode-button-hoverBackground: #026ec1;
  --vscode-button-secondaryBackground: #313131; --vscode-button-secondaryForeground: #cccccc;
  --vscode-errorForeground: #f85149; --vscode-focusBorder: #0078d4; --vscode-badge-background: #616161;
  --vscode-badge-foreground: #f8f8f8; --vscode-editorWarning-foreground: #cca700; --vscode-widget-border: #3c3c3c;
  --vscode-panel-border: #2b2b2b; --vscode-font-family: system-ui, sans-serif; --vscode-font-size: 13px;
}`

const settings = {
  project: { name: 'shop', engine: 'postgresql', migrations: 'migrations', schemas: ['public'], history_table: 'liftoff_schema_history', filters: [{ action: 'exclude', object: 'table', pattern: 'audit_*' }], lock: 'advisory', placeholders: { owner: 'app' } },
  environments: [
    { name: 'dev', url: 'postgres://localhost/shop_dev', user: null, role: 'dev', allow_clean: true, placeholders: {}, shared: false, has_password: false },
    { name: 'prod', url: 'postgres://app@db/shop', user: 'app', role: 'prod', allow_clean: false, placeholders: {}, shared: true, has_password: true },
  ],
}

async function open(page: Page, focus?: string) {
  await page.setContent(`<!doctype html><html lang="en"><head><title>LiftOff Settings</title><style>${THEME}</style></head><body><main id="app" aria-busy="true"></main></body></html>`)
  await page.addStyleTag({ path: path.join(media, 'settings.css') })
  // The webview API: messages the page posts are kept for the test.
  await page.evaluate(() => {
    const w = window as unknown as { posted: unknown[]; acquireVsCodeApi: () => { postMessage: (m: unknown) => void } }
    w.posted = []
    w.acquireVsCodeApi = () => ({ postMessage: (m) => w.posted.push(m) })
  })
  await page.addScriptTag({ path: path.join(media, 'settings.js') })
  await page.evaluate(([s, f]) => window.postMessage({ type: 'settings', settings: s, focus: f }, '*'), [settings, focus] as const)
  await expect(page.getByRole('heading', { name: 'LiftOff settings: shop' })).toBeVisible()
}

const posted = (page: Page) => page.evaluate(() => (window as unknown as { posted: { type: string; change?: Record<string, unknown> }[] }).posted)

test('VS-SET-H1 the settings page shows the project and saves only what changed', async ({ page }) => {
  const checkConsole = watchConsole(page)
  await open(page)
  await expect(page.getByLabel('Migrations folder', { exact: true })).toHaveValue('migrations')
  await expect(page.getByRole('button', { name: 'Save' })).toBeDisabled()
  await expectNoA11yViolations(page, 'VS Code settings page')
  await page.screenshot({ path: 'test-results/vscode-settings.png', fullPage: true })

  await page.getByLabel('Schemas', { exact: true }).fill('public, sales')
  await page.getByText('prod', { exact: true }).first().click() // open the prod card
  await page.getByLabel('Password').nth(1).fill('new-secret')
  await page.locator('details[open]').last().screenshot({ path: 'test-results/vscode-settings-env.png' })
  await page.getByRole('button', { name: 'Save' }).click()
  const save = (await posted(page)).find((m) => m.type === 'save')
  expect(save?.change).toEqual({
    project: { ...settings.project, schemas: ['public', 'sales'], engine: undefined },
    environments: [{ name: 'prod', url: 'postgres://app@db/shop', user: 'app', password: 'new-secret', role: 'prod', allow_clean: false, placeholders: {}, shared: true }],
  })
  checkConsole()
})

test('VS-SET-N1 a new environment without a name or URL is not sent; the first problem gets the focus', async ({ page }) => {
  await open(page)
  await page.getByRole('button', { name: 'Add environment' }).click()
  await page.getByRole('button', { name: 'Save' }).click()
  await expect(page.getByRole('alert')).toContainText('need attention')
  await expect(page.locator('#env-2-name')).toBeFocused()
  await expect(page.getByText('Letters, digits, - and _ only.')).toBeVisible()
  expect((await posted(page)).filter((m) => m.type === 'save')).toHaveLength(0)
  await expectNoA11yViolations(page, 'VS Code settings page with problems')
})

test('VS-SET-E1 production cannot allow clean; removing an environment is sent as a removal', async ({ page }) => {
  await open(page)
  await page.getByText('dev', { exact: true }).first().click()
  await page.getByLabel('Role').first().selectOption('prod')
  await expect(page.getByLabel(/Allow clean/).first()).toBeDisabled()
  await expect(page.getByLabel(/Allow clean/).first()).not.toBeChecked()
  await page.getByRole('button', { name: 'Discard changes' }).click()
  await expect(page.getByLabel('Role').first()).toHaveValue('dev') // discarded; the card stays open
  await page.getByRole('button', { name: 'Remove environment' }).first().click()
  await page.getByRole('button', { name: 'Save' }).click()
  const save = (await posted(page)).find((m) => m.type === 'save')
  expect(save?.change).toEqual({ remove: ['dev'] })
})

test('VS-SET-H2 after New Project the page starts with an empty environment, its name focused', async ({ page }) => {
  await open(page, '+')
  await expect(page.locator('#env-2-name')).toBeFocused()
  await expect(page.getByText('New environment')).toBeVisible()
  await page.locator('#env-2-name').fill('staging')
  await page.locator('#env-2-url').fill('postgres://db/staging')
  await page.getByRole('button', { name: 'Save' }).click()
  const save = (await posted(page)).find((m) => m.type === 'save')
  expect(save?.change).toEqual({ environments: [{ name: 'staging', url: 'postgres://db/staging', user: null, role: 'test', allow_clean: false, placeholders: {}, shared: true }] })
})
