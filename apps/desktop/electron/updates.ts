// Updates for the desktop app (the maintainer's decision, 2026-10-13): the only network traffic
// that is not a database. It reads the latest GitHub release of LiftOff and downloads the setup
// (Windows) or the AppImage (Linux) from it; nothing is sent but the request itself. The person
// picks the mode on the Settings screen; 'off' means no request at all. The CLI and the core never
// do this.

import { app, shell } from 'electron'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { assetFor, newer, type Release } from './release.ts'

export type UpdateMode = 'notify' | 'auto' | 'off'
export type UpdateState =
  | { state: 'idle' }
  | { state: 'checking' }
  | { state: 'latest'; version: string }
  | { state: 'available'; version: string; page: string }
  /** A newer version this install cannot update to by itself (Linux outside an AppImage). */
  | { state: 'manual'; version: string; page: string }
  | { state: 'downloading'; version: string; percent: number }
  | { state: 'ready'; version: string }
  | { state: 'failed'; message: string }
export type UpdateInfo = { mode: UpdateMode; current: string; status: UpdateState }

const LATEST = 'https://api.github.com/repos/sanderstad/liftoff/releases/latest'
const EVERY = 6 * 60 * 60 * 1000

export class Updater {
  private status: UpdateState = { state: 'idle' }
  private release?: Release
  private file?: string
  private timer?: NodeJS.Timeout
  private readonly settingsFile: string
  private readonly url: string
  mode: UpdateMode

  constructor(configDir: string, private readonly onChange: (info: UpdateInfo) => void) {
    this.settingsFile = path.join(configDir, 'settings.json')
    this.mode = readMode(this.settingsFile)
    // Tests point this at a local server; nothing else sets it.
    this.url = process.env.LIFTOFF_UPDATE_URL ?? LATEST
  }

  info(): UpdateInfo {
    return { mode: this.mode, current: app.getVersion(), status: this.status }
  }

  /** Checks shortly after the start and then every six hours, unless updates are off. */
  start(): void {
    clearInterval(this.timer)
    this.timer = undefined
    // Only an installed app updates itself (or one pointed at a test server).
    if (this.mode === 'off' || (!app.isPackaged && !process.env.LIFTOFF_UPDATE_URL)) return
    setTimeout(() => void this.check(true), process.env.LIFTOFF_UPDATE_URL ? 0 : 10_000)
    this.timer = setInterval(() => void this.check(true), EVERY)
  }

  setMode(mode: UpdateMode): UpdateInfo {
    this.mode = mode
    fs.mkdirSync(path.dirname(this.settingsFile), { recursive: true })
    fs.writeFileSync(this.settingsFile, JSON.stringify({ ...readSettings(this.settingsFile), updates: mode }, null, 2))
    if (mode === 'off' && this.status.state !== 'ready') this.set({ state: 'idle' })
    this.start()
    if (mode === 'auto' && this.status.state === 'available') void this.download()
    return this.set(this.status)
  }

  /** In the background (quiet: a failure is not shown) or because the person asked. */
  async check(quiet = false): Promise<UpdateInfo> {
    if (['downloading', 'ready', 'checking'].includes(this.status.state)) return this.info()
    this.set({ state: 'checking' })
    try {
      const r = await fetch(this.url, { headers: { accept: 'application/vnd.github+json', 'user-agent': `LiftOff/${app.getVersion()}` } })
      // A private repository answers 404 to a request without a token.
      if (!r.ok) throw new Error(r.status === 404 ? 'no published release found' : `GitHub answered ${r.status}`)
      const release = (await r.json()) as Release
      if (release.draft || release.prerelease || !newer(release.tag_name, app.getVersion())) {
        this.set({ state: 'latest', version: app.getVersion() })
        return this.info()
      }
      this.release = release
      const version = release.tag_name.replace(/^v/, '')
      if (!assetFor(release, process.platform, !!process.env.APPIMAGE)) this.set({ state: 'manual', version, page: release.html_url })
      else {
        this.set({ state: 'available', version, page: release.html_url })
        if (this.mode === 'auto') void this.download()
      }
    } catch (e) {
      this.set(quiet ? { state: 'idle' } : { state: 'failed', message: `Could not check for updates: ${e instanceof Error ? e.message : String(e)}` })
    }
    return this.info()
  }

  /** Downloads the new setup or AppImage and checks it against the checksum GitHub publishes. */
  async download(): Promise<UpdateInfo> {
    const release = this.release
    const asset = release && assetFor(release, process.platform, !!process.env.APPIMAGE)
    if (!release || !asset || this.status.state === 'downloading' || this.status.state === 'ready') return this.info()
    const version = release.tag_name.replace(/^v/, '')
    const expected = /^sha256:([0-9a-f]{64})$/.exec(asset.digest ?? '')?.[1]
    if (!expected) return this.set({ state: 'failed', message: `${asset.name} has no checksum on GitHub; download it from ${release.html_url}` })
    const dir = path.join(app.getPath('temp'), 'liftoff-update')
    removeQuietly(dir)
    fs.mkdirSync(dir, { recursive: true })
    const file = path.join(dir, asset.name)
    this.set({ state: 'downloading', version, percent: 0 })
    try {
      const r = await fetch(asset.browser_download_url, { headers: { 'user-agent': `LiftOff/${app.getVersion()}` } })
      if (!r.ok || !r.body) throw new Error(`GitHub answered ${r.status}`)
      const hash = createHash('sha256')
      const out = fs.createWriteStream(file)
      let got = 0
      let shown = 0
      for await (const chunk of r.body as unknown as AsyncIterable<Uint8Array>) {
        hash.update(chunk)
        got += chunk.length
        if (!out.write(chunk)) await new Promise((ok) => out.once('drain', ok))
        const percent = Math.floor((got / (asset.size || got)) * 100)
        if (percent >= shown + 2) this.set({ state: 'downloading', version, percent: (shown = percent) })
      }
      await new Promise<void>((ok, fail) => out.end((e?: Error | null) => (e ? fail(e) : ok())))
      if (hash.digest('hex') !== expected) throw new Error(`${asset.name} does not match its checksum on GitHub`)
      this.file = file
      return this.set({ state: 'ready', version })
    } catch (e) {
      removeQuietly(dir)
      return this.set({ state: 'failed', message: `The update did not download: ${e instanceof Error ? e.message : String(e)}` })
    }
  }

  /** Installs what was downloaded and starts the new version. */
  install(): void {
    const file = this.file
    if (this.status.state !== 'ready' || !file) return
    if (process.platform === 'win32') {
      // The setup made by electron-builder: silent, keeps the folder it was installed in, and
      // starts the app again when it is done.
      spawn(file, ['/S', '--updated', '--force-run'], { detached: true, stdio: 'ignore' }).unref()
      app.quit()
    } else if (process.env.APPIMAGE) {
      const target = process.env.APPIMAGE
      fs.copyFileSync(file, `${target}.new`)
      fs.chmodSync(`${target}.new`, 0o755)
      fs.renameSync(`${target}.new`, target)
      app.relaunch({ execPath: target })
      app.exit(0)
    }
  }

  openPage(): void {
    if (this.release?.html_url.startsWith('https://github.com/')) void shell.openExternal(this.release.html_url)
  }

  private set(status: UpdateState): UpdateInfo {
    this.status = status
    const info = this.info()
    this.onChange(info)
    return info
  }
}

/** Windows can hold a file that was just closed for a moment (a virus scanner): retry, never throw. */
function removeQuietly(dir: string): void {
  try {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
  } catch {
    /* left in the temp folder; the next download starts by clearing it again */
  }
}

function readSettings(file: string): Record<string, unknown> {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>
  } catch {
    return {}
  }
}

function readMode(file: string): UpdateMode {
  const m = readSettings(file).updates
  return m === 'auto' || m === 'off' ? m : 'notify'
}
