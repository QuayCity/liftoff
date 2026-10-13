// Updates for the desktop app (the maintainer's decision, 2026-10-13): the only network traffic
// that is not a database. It reads the latest GitHub release of LiftOff and downloads the new
// version from it; nothing is sent but the request itself. The person picks the mode on the
// Settings screen; 'off' means no request at all. The CLI and the core never do this.
//
// Windows, as VS Code: the zip is unpacked next to the app while it runs, and the restart only
// swaps the two folders (swap.ts). Where that is not possible, the setup runs silently instead.
// Linux: the AppImage replaces itself.

import { app, shell } from 'electron'
import { execFile, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { assetFor, newer, type Release } from './release.ts'
import { SWAP_SCRIPT } from './swap.ts'

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
/** `updated`: the version this start updated to, until its notes are opened (What's new). */
/** The newest release GitHub knows, whether or not it is newer than this one (the About window). */
export type LatestRelease = { version: string; page: string; notes: string; published: string | null }
export type UpdateInfo = { mode: UpdateMode; current: string; status: UpdateState; updated?: string; latest?: LatestRelease }

const LATEST = 'https://api.github.com/repos/sanderstad/liftoff/releases/latest'
const EVERY = 6 * 60 * 60 * 1000
const NOTES = (v: string) => `https://github.com/sanderstad/liftoff/releases/tag/v${v}`

export class Updater {
  private status: UpdateState = { state: 'idle' }
  private release?: Release
  private file?: string
  /** How the downloaded version goes in: swap the unpacked folder, run the setup, or replace the AppImage. */
  private method?: 'swap' | 'setup' | 'appimage'
  private staged?: string
  /** A swap that failed last time: no automatic checks this start, so its message stays. */
  private held = false
  private readonly resultFile: string
  private timer?: NodeJS.Timeout
  private readonly settingsFile: string
  private readonly url: string
  private updated?: string
  private latest?: LatestRelease
  mode: UpdateMode

  constructor(configDir: string, private readonly onChange: (info: UpdateInfo) => void) {
    this.settingsFile = path.join(configDir, 'settings.json')
    this.resultFile = path.join(configDir, 'update-result.json')
    const result = readSettings(this.resultFile)
    removeQuietly(this.resultFile)
    if (result.ok === false && typeof result.message === 'string') {
      this.status = { state: 'failed', message: result.message }
      this.held = true
    }
    this.mode = readMode(this.settingsFile)
    // The first start of a newer version than last time offers its release notes, as VS Code does.
    const last = readSettings(this.settingsFile).last_version
    const current = app.getVersion()
    if (typeof last === 'string' && newer(current, last)) this.updated = current
    if (last !== current) this.save({ last_version: current })
    // Tests point this at a local server; nothing else sets it.
    this.url = process.env.LIFTOFF_UPDATE_URL ?? LATEST
  }

  info(): UpdateInfo {
    return { mode: this.mode, current: app.getVersion(), status: this.status, ...(this.updated ? { updated: this.updated } : {}), ...(this.latest ? { latest: this.latest } : {}) }
  }

  /** Checks shortly after the start and then every six hours, unless updates are off. */
  start(): void {
    clearInterval(this.timer)
    this.timer = undefined
    // Only an installed app updates itself (or one pointed at a test server).
    if (this.mode === 'off' || this.held || (!app.isPackaged && !process.env.LIFTOFF_UPDATE_URL)) return
    setTimeout(() => void this.check(true), process.env.LIFTOFF_UPDATE_URL ? 0 : 10_000)
    this.timer = setInterval(() => void this.check(true), EVERY)
  }

  setMode(mode: UpdateMode): UpdateInfo {
    this.mode = mode
    this.save({ updates: mode })
    if (mode === 'off' && this.status.state !== 'ready') this.set({ state: 'idle' })
    this.start()
    if (mode === 'auto' && this.status.state === 'available') void this.download()
    return this.set(this.status)
  }

  /** In the background (quiet: a failure is not shown) or because the person asked. */
  async check(quiet = false): Promise<UpdateInfo> {
    if (['downloading', 'ready', 'checking'].includes(this.status.state)) return this.info()
    this.held = false
    this.set({ state: 'checking' })
    try {
      const r = await fetch(this.url, { headers: { accept: 'application/vnd.github+json', 'user-agent': `LiftOff/${app.getVersion()}` } })
      // A private repository answers 404 to a request without a token.
      if (!r.ok) throw new Error(r.status === 404 ? 'no published release found' : `GitHub answered ${r.status}`)
      const release = (await r.json()) as Release
      this.latest = { version: release.tag_name.replace(/^v/, ''), page: release.html_url, notes: (release.body ?? '').trim(), published: release.published_at ?? null }
      if (release.draft || release.prerelease || !newer(release.tag_name, app.getVersion())) {
        this.set({ state: 'latest', version: app.getVersion() })
        return this.info()
      }
      this.release = release
      const version = release.tag_name.replace(/^v/, '')
      if (!assetFor(release, process.platform, { appImage: !!process.env.APPIMAGE, staged: true })) this.set({ state: 'manual', version, page: release.html_url })
      else {
        this.set({ state: 'available', version, page: release.html_url })
        if (this.mode === 'auto') void this.download()
      }
    } catch (e) {
      this.set(quiet ? { state: 'idle' } : { state: 'failed', message: `Could not check for updates: ${e instanceof Error ? e.message : String(e)}` })
    }
    return this.info()
  }

  /**
   * Downloads the new version, checks it against the checksum GitHub publishes, and on Windows
   * unpacks it next to the app, so the restart has little left to do.
   */
  async download(): Promise<UpdateInfo> {
    const release = this.release
    if (!release || this.status.state === 'downloading' || this.status.state === 'ready') return this.info()
    this.staged = process.platform === 'win32' ? stagingFolder() : undefined
    const asset = assetFor(release, process.platform, { appImage: !!process.env.APPIMAGE, staged: !!this.staged })
    if (this.staged && !asset?.name.endsWith('.zip')) {
      removeQuietly(this.staged)
      this.staged = undefined
    }
    if (!asset) return this.info()
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
        if (!out.write(chunk)) await new Promise<void>((ok) => out.once('drain', () => ok()))
        const percent = Math.floor((got / (asset.size || got)) * 100)
        if (percent >= shown + 2) this.set({ state: 'downloading', version, percent: (shown = percent) })
      }
      await new Promise<void>((ok, fail) => out.end((e?: Error | null) => (e ? fail(e) : ok())))
      if (hash.digest('hex') !== expected) throw new Error(`${asset.name} does not match its checksum on GitHub`)
      this.file = file
      if (asset.name.endsWith('.zip') && this.staged) {
        // Unpacked now, while the app runs; Windows' own tar reads zip files.
        this.set({ state: 'downloading', version, percent: 100 })
        await unzip(file, this.staged)
        const exe = path.join(this.staged, path.basename(process.execPath))
        if (!fs.existsSync(exe)) throw new Error(`${asset.name} does not hold ${path.basename(process.execPath)}`)
        await warmUp(exe)
        this.method = 'swap'
      } else this.method = asset.name.endsWith('.AppImage') ? 'appimage' : 'setup'
      return this.set({ state: 'ready', version })
    } catch (e) {
      removeQuietly(dir)
      if (this.staged) removeQuietly(this.staged)
      return this.set({ state: 'failed', message: `The update did not download: ${e instanceof Error ? e.message : String(e)}` })
    }
  }

  /** Installs what was downloaded and starts the new version. */
  install(): void {
    const file = this.file
    if (this.status.state !== 'ready' || !file) return
    if (this.method === 'swap' && this.staged) {
      const script = path.join(app.getPath('temp'), 'liftoff-swap.ps1')
      fs.writeFileSync(script, SWAP_SCRIPT)
      const args = ['-AppPid', String(process.pid), '-App', path.dirname(process.execPath), '-Staged', this.staged, '-Version', this.status.version, '-Exe', path.basename(process.execPath), '-Result', this.resultFile]
      const ps = ['powershell.exe', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-File', script, ...args]
      // Through `start`: PowerShell started detached straight from Node exits without running,
      // and one started attached is ended with the app. Quoted here for cmd (paths may have spaces).
      const q = (a: string) => (/[\s&()^|<>]/.test(a) ? `"${a}"` : a)
      spawn('cmd.exe', ['/d', '/c', 'start', '""', '/b', ...ps.map(q)], { detached: true, stdio: 'ignore', windowsHide: true, windowsVerbatimArguments: true }).unref()
      app.quit()
    } else if (this.method === 'setup') {
      // The setup made by electron-builder: silent, keeps the folder it was installed in, and
      // starts the app again when it is done.
      spawn(file, ['/S', '--updated', '--force-run'], { detached: true, stdio: 'ignore' }).unref()
      app.quit()
    } else if (this.method === 'appimage' && process.env.APPIMAGE) {
      const target = process.env.APPIMAGE
      fs.copyFileSync(file, `${target}.new`)
      fs.chmodSync(`${target}.new`, 0o755)
      fs.renameSync(`${target}.new`, target)
      app.relaunch({ execPath: target })
      app.exit(0)
    }
  }

  /** What's new: the release notes of the version just updated to, in the browser. Shown once. */
  openNotes(): UpdateInfo {
    void shell.openExternal(NOTES(app.getVersion()))
    this.updated = undefined
    return this.set(this.status)
  }

  private save(patch: Record<string, unknown>): void {
    fs.mkdirSync(path.dirname(this.settingsFile), { recursive: true })
    fs.writeFileSync(this.settingsFile, JSON.stringify({ ...readSettings(this.settingsFile), ...patch }, null, 2))
  }

  openPage(): void {
    const page = this.latest?.page ?? this.release?.html_url
    if (page?.startsWith('https://github.com/')) void shell.openExternal(page)
  }

  private set(status: UpdateState): UpdateInfo {
    this.status = status
    const info = this.info()
    this.onChange(info)
    return info
  }
}

/** <app folder>-update beside the app, if it can be written there (it can in the usual per-user install). */
function stagingFolder(): string | undefined {
  const dir = `${path.dirname(process.execPath)}-update`
  try {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
    fs.mkdirSync(dir)
    return dir
  } catch {
    return undefined
  }
}

/** Runs the new version once with --warm-up (it exits at once); a failure here is not one. */
function warmUp(exe: string): Promise<void> {
  return new Promise((ok) => execFile(exe, ['--warm-up'], { windowsHide: true, timeout: 60_000 }, () => ok()))
}

function unzip(zip: string, into: string): Promise<void> {
  const tar = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe')
  return new Promise((ok, fail) => execFile(tar, ['-xf', zip, '-C', into], { windowsHide: true }, (e, _out, err) => (e ? fail(new Error(err.trim() || e.message)) : ok())))
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
    // Without a byte-order mark, which JSON.parse does not accept.
    return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')) as Record<string, unknown>
  } catch {
    return {}
  }
}

function readMode(file: string): UpdateMode {
  const m = readSettings(file).updates
  // Like VS Code: unless the person chose otherwise, updates download by themselves.
  return m === 'notify' || m === 'off' ? m : 'auto'
}
