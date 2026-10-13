// The desktop app's own updates, against a local stand-in for GitHub's releases API: it finds a
// newer release, downloads the file for this platform, checks its checksum, and offers a restart.
// A file that does not match its checksum is refused. Installing is not run here.
import { _electron, expect, test } from '@playwright/test'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const desktop = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../apps/desktop')
const electron = path.join(desktop, 'node_modules/electron/dist', process.platform === 'win32' ? 'electron.exe' : 'electron')
const built = path.join(desktop, 'dist-electron/main.mjs')

test.skip(process.platform !== 'win32' || !fs.existsSync(built), 'needs Windows and a built desktop app')
test.describe.configure({ mode: 'serial' })

const setup = Buffer.from('not really a setup program\n'.repeat(20_000))
const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex')

/** Serves /latest (the release) and /file (the setup); `digest` is what the release claims. */
async function github(digest: string) {
  const server = http.createServer((req, res) => {
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
    if (req.url === '/latest') {
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify({
        tag_name: 'v9.9.9', html_url: 'https://github.com/sanderstad/liftoff/releases/tag/v9.9.9',
        assets: [{ name: 'LiftOff-Setup-9.9.9.exe', browser_download_url: `${base}/file`, size: setup.length, digest: `sha256:${digest}` }],
      }))
    } else if (req.url === '/file') res.end(setup)
    else res.writeHead(404).end()
  })
  await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok))
  return { server, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/latest` }
}

async function launch(url: string) {
  const app = await _electron.launch({ executablePath: electron, args: [desktop], cwd: desktop, env: { ...process.env, LIFTOFF_UPDATE_URL: url } })
  const page = await app.firstWindow()
  await expect(page.getByRole('heading', { name: 'LiftOff' })).toBeVisible({ timeout: 30_000 })
  return { app, page }
}

const downloaded = path.join(os.tmpdir(), 'liftoff-update', 'LiftOff-Setup-9.9.9.exe')

test('U-H1 a newer release: Update, the download checked against its checksum, then Restart to update', async () => {
  const { server, url } = await github(sha(setup))
  const { app, page } = await launch(url)
  try {
    await page.getByRole('button', { name: 'Update to 9.9.9' }).click()
    await expect(page.getByRole('button', { name: 'Restart to update' })).toBeVisible({ timeout: 30_000 })
    expect(sha(fs.readFileSync(downloaded))).toBe(sha(setup))
  } finally {
    await app.close()
    server.close()
  }
})

test('U-E1 a download that does not match its checksum is refused and removed', async () => {
  const { server, url } = await github('0'.repeat(64))
  const { app, page } = await launch(url)
  try {
    await page.getByRole('button', { name: 'Update to 9.9.9' }).click()
    await expect(page.getByRole('button', { name: /Update to 9\.9\.9|Downloading/ })).toBeHidden({ timeout: 30_000 })
    await expect(page.getByRole('button', { name: 'Restart to update' })).toBeHidden()
    expect(fs.existsSync(downloaded)).toBe(false)
  } finally {
    await app.close()
    server.close()
  }
})
