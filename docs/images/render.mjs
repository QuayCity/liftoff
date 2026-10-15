// Takes the screenshots in this folder from the desktop app's screens, on their made-up demo data
// (the browser preview), so they can be made again whenever the screens change:
//   cd apps/desktop && npm run build      (the screens, into dist/)
//   node docs/images/render.mjs
// Uses the Playwright from e2e/ (cd e2e && npm install && npx playwright install chromium).

import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const repo = join(here, '..', '..')
const { chromium } = createRequire(join(repo, 'e2e', 'package.json'))('playwright')

const port = 4327
const preview = spawn('npx', ['vite', 'preview', '--port', String(port), '--strictPort'], { cwd: join(repo, 'apps', 'desktop'), shell: true, stdio: 'ignore' })
const base = `http://localhost:${port}/`
for (let i = 0; ; i++) {
  if (await fetch(base).then((r) => r.ok, () => false)) break
  if (i > 60) throw new Error('vite preview did not start; run npm run build in apps/desktop first')
  await new Promise((r) => setTimeout(r, 500))
}

const browser = await chromium.launch()
/** One screenshot: a screen of the demo project, made ready by `ready`, in a 1280×760 window at twice the pixels. */
async function shot(file, query, ready, theme = 'light') {
  const page = await browser.newPage({ viewport: { width: 1280, height: 760 }, deviceScaleFactor: 2, colorScheme: theme })
  // The sidebar with the screens' names, so a reader sees where they are.
  await page.addInitScript(() => localStorage.setItem('liftoff:sidebar', 'wide'))
  await page.goto(`${base}?open=1&theme=${theme}&${query}`)
  await ready(page)
  // Let transitions and fonts settle.
  await page.waitForTimeout(400)
  await page.screenshot({ path: join(here, file) })
  await page.close()
  console.log(`wrote docs/images/${file}`)
}

// The README: dev compared with the migration scripts, one changed table side by side.
const changes = async (page) => {
  await page.getByText('public.orders', { exact: true }).click()
  await page.getByRole('tab', { name: 'Side by side' }).waitFor()
}
await shot('changes.png', 'ws=Changes&autocompare=1', changes)
await shot('changes-dark.png', 'ws=Changes&autocompare=1', changes, 'dark')

// The desktop app guide.
await shot('overview.png', 'ws=Overview', (page) => page.getByRole('heading', { name: 'Activity' }).waitFor())
await shot('environments.png', 'ws=Environments', (page) => page.getByRole('region', { name: 'staging environment' }).waitFor())
await shot('compare.png', 'ws=Compare', async (page) => {
  await page.getByRole('button', { name: 'Compare', exact: true }).last().click()
  await page.getByText('public.orders', { exact: true }).first().click()
})
await shot('data-compare.png', 'ws=Compare', async (page) => {
  await page.getByText('Data', { exact: true }).click()
  await page.getByRole('button', { name: 'Compare data' }).click()
  await page.getByText('public.orders', { exact: true }).click()
  await page.getByRole('tab', { name: /Different/ }).click()
})
await shot('rules.png', 'ws=Rules', (page) => page.getByText('drop-table').first().waitFor())

await browser.close()
preview.kill()
process.exit(0)
