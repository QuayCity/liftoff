// The desktop app's own updates, against a local stand-in for GitHub's releases API: it finds a
// newer release, downloads the file for this platform, checks its checksum, and offers a restart.
// A file that does not match its checksum is refused. Installing is not run here.
import { _electron, expect, test } from '@playwright/test'
import { execFileSync } from 'node:child_process'
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
/** The version the app reports: tests set it as the last one started, so no What's new shows. */
const version = (JSON.parse(fs.readFileSync(path.join(desktop, 'package.json'), 'utf8')) as { version: string }).version

test.skip(process.platform !== 'win32' || !fs.existsSync(built), 'needs Windows and a built desktop app')
test.describe.configure({ mode: 'serial' })

// The app's own settings file: backed up, set per test, and restored.
const settingsFile = path.join(process.env.APPDATA ?? path.join(os.homedir(), 'AppData/Roaming'), 'app.liftoff.desktop/settings.json')
let saved: string | null = null
test.beforeAll(() => {
  saved = fs.existsSync(settingsFile) ? fs.readFileSync(settingsFile, 'utf8') : null
})
test.afterAll(() => {
  if (saved === null) fs.rmSync(settingsFile, { force: true })
  else fs.writeFileSync(settingsFile, saved)
})
const settings = (s: Record<string, unknown>) => {
  fs.mkdirSync(path.dirname(settingsFile), { recursive: true })
  fs.writeFileSync(settingsFile, JSON.stringify(s))
}

const setup = Buffer.from('not really a setup program\n'.repeat(20_000))
const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex')

/**
 * Serves /latest (the release), /file (the setup) and, when given, /zip (the app unpacked);
 * `digest` is what the release claims for the setup.
 */
async function github(digest: string, zip?: Buffer) {
  const server = http.createServer((req, res) => {
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
    if (req.url === '/latest') {
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify({
        tag_name: 'v9.9.9', html_url: 'https://github.com/sanderstad/liftoff/releases/tag/v9.9.9', published_at: '2027-01-05T10:00:00Z',
        body: ['## What changed', '* Something new in 9.9.9'].join(String.fromCharCode(10)),
        assets: [
          { name: 'LiftOff-Setup-9.9.9.exe', browser_download_url: `${base}/file`, size: setup.length, digest: `sha256:${digest}` },
          ...(zip ? [{ name: 'LiftOff-9.9.9-win-x64.zip', browser_download_url: `${base}/zip`, size: zip.length, digest: `sha256:${sha(zip)}` }] : []),
        ],
      }))
    } else if (req.url === '/file') res.end(setup)
    else if (req.url === '/zip' && zip) res.end(zip)
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
  settings({ updates: 'notify', last_version: version })
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
  settings({ updates: 'notify', last_version: version })
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

test('U-H3 automatic, the default: the update downloads by itself and only Restart to update shows', async () => {
  settings({ last_version: version })
  const { server, url } = await github(sha(setup))
  const { app, page } = await launch(url)
  try {
    await expect(page.getByRole('button', { name: 'Restart to update' })).toBeVisible({ timeout: 30_000 })
    expect(JSON.parse(fs.readFileSync(settingsFile, 'utf8')).updates).toBeUndefined()
  } finally {
    await app.close()
    server.close()
  }
})

test("U-H4 the first start after an update offers What's new: the release notes, once", async () => {
  settings({ updates: 'off', last_version: '0.0.9' })
  const app = await _electron.launch({ executablePath: electron, args: [desktop], cwd: desktop })
  try {
    const page = await app.firstWindow()
    await app.evaluate(({ shell }) => {
      shell.openExternal = async (url: string) => void ((globalThis as { opened?: string }).opened = url)
    })
    await page.getByRole('button', { name: `What's new in ${version}`, exact: true }).click()
    expect(await app.evaluate(() => (globalThis as { opened?: string }).opened)).toBe(`https://github.com/sanderstad/liftoff/releases/tag/v${version}`)
    await expect(page.getByRole('button', { name: /What's new/ })).toBeHidden()
    expect(JSON.parse(fs.readFileSync(settingsFile, 'utf8')).last_version).toBe(version)
  } finally {
    await app.close()
  }
})

test('U-H6 with the zip in the release: unpacked beside the app before Restart to update, as VS Code does', async () => {
  settings({ last_version: version })
  // A stand-in for the app folder: the app's exe (electron.exe when run from source) and one more file.
  const src = fs.mkdtempSync(path.join(os.tmpdir(), 'lo-zip-'))
  // A real program, since it is started once to warm up; a small one that exits at once.
  fs.copyFileSync(path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'whoami.exe'), path.join(src, path.basename(electron)))
  fs.mkdirSync(path.join(src, 'resources'))
  fs.writeFileSync(path.join(src, 'resources', 'app.asar'), 'the new app\n')
  const zipFile = path.join(src, 'app.zip')
  execFileSync(path.join(process.env.SystemRoot ?? 'C:\Windows', 'System32', 'tar.exe'), ['-a', '-c', '-f', zipFile, '-C', src, path.basename(electron), 'resources'])
  const staged = `${path.dirname(electron)}-update`
  const { server, url } = await github(sha(setup), fs.readFileSync(zipFile))
  const { app, page } = await launch(url)
  try {
    await expect(page.getByRole('button', { name: 'Restart to update' })).toBeVisible({ timeout: 30_000 })
    expect(fs.readFileSync(path.join(staged, 'resources', 'app.asar'), 'utf8')).toBe('the new app\n')
    expect(fs.existsSync(path.join(staged, path.basename(electron)))).toBe(true)
  } finally {
    await app.close()
    server.close()
    fs.rmSync(staged, { recursive: true, force: true })
    fs.rmSync(src, { recursive: true, force: true })
  }
})

test('U-E2 a swap that failed: the old version starts again and says why; no automatic retry that start', async () => {
  settings({ last_version: version })
  const result = path.join(path.dirname(settingsFile), 'update-result.json')
  // With a byte-order mark, as Windows PowerShell writes UTF-8.
  fs.writeFileSync(result, String.fromCharCode(0xfeff) + JSON.stringify({ ok: false, version: '9.9.9', message: 'LiftOff 9.9.9 is downloaded but could not be installed: a file in C:\LiftOff is in use' }))
  const { server, url } = await github(sha(setup))
  const { app, page } = await launch(url)
  try {
    await page.getByRole('button', { name: 'Update failed' }).click()
    await expect(page.getByText(/could not be installed: a file in .* is in use/).first()).toBeVisible()
    await expect(page.getByRole('button', { name: /Update to|Restart to update/ })).toBeHidden()
    expect(fs.existsSync(result)).toBe(false)
  } finally {
    await app.close()
    server.close()
  }
})

test('U-H8 About LiftOff: this version, the newest release and its notes, from the same lookup', async () => {
  settings({ updates: 'notify', last_version: version })
  const { server, url } = await github(sha(setup))
  const { app, page } = await launch(url)
  try {
    await expect(page.getByRole('button', { name: 'Update to 9.9.9' })).toBeVisible({ timeout: 30_000 })
    await page.getByRole('button', { name: 'About LiftOff' }).click()
    const about = page.getByRole('dialog', { name: 'About LiftOff' })
    await expect(about.getByText('Newest version').locator('xpath=following-sibling::dd[1]')).toHaveText('9.9.9')
    const notes = about.getByRole('region', { name: "What's new in 9.9.9" })
    await expect(notes.getByRole('heading')).toHaveText("What's new in 9.9.9 (2027-01-05)")
    await expect(notes.getByText('• Something new in 9.9.9')).toBeVisible()
  } finally {
    await app.close()
    server.close()
  }
})
