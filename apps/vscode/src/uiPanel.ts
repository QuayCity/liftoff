// The LiftOff panel: the desktop app's screens inside VS Code, so nothing needs the desktop app.
// The page is the desktop app's built UI (media/ui, copied from apps/desktop/dist by
// scripts/copy-ui.mjs). Its calls go to `liftoff ui-host`, which runs the same commands the desktop
// app runs; folder and file pickers are VS Code's own. The workspace's projects open as tabs.

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import * as crypto from 'node:crypto'
import * as fs from 'node:fs'
import * as readline from 'node:readline'
import * as vscode from 'vscode'

type FromPage =
  | { type: 'invoke'; id: number; name: string; args?: Record<string, unknown> }
  | { type: 'pickFolder'; id: number }
  | { type: 'openFile'; id: number; filterName: string; extensions: string[] }
  | { type: 'saveFile'; id: number; defaultPath: string; filterName: string; extensions: string[] }
  | { type: 'confirm'; id: number; message: string }

const themeOf = (k: vscode.ColorThemeKind) => (k === vscode.ColorThemeKind.Light || k === vscode.ColorThemeKind.HighContrastLight ? 'light' : 'dark')

export class UiPanel {
  static current: UiPanel | undefined
  private host: ChildProcessWithoutNullStreams | undefined
  /** Calls sent to the host and not answered yet, by id: answered with an error if it stops. */
  private readonly sent = new Map<number, string>()
  /** The calls answered so far, for the tests: the page loaded and its bridge works. */
  readonly answered: { name: string; ok: boolean }[] = []
  private readonly disposables: vscode.Disposable[] = []

  /** Shows the panel (one for the window), opening the workspace's projects. */
  static async show(extensionUri: vscode.Uri, binary: () => string, log: vscode.OutputChannel): Promise<UiPanel> {
    if (UiPanel.current) {
      UiPanel.current.panel.reveal()
      return UiPanel.current
    }
    const found = await vscode.workspace.findFiles('**/liftoff.toml', '**/node_modules/**', 20)
    const projects = [...new Set(found.map((f) => vscode.Uri.joinPath(f, '..').fsPath))].sort()
    const ui = vscode.Uri.joinPath(extensionUri, 'media', 'ui')
    const panel = vscode.window.createWebviewPanel('liftoff.ui', 'LiftOff', vscode.ViewColumn.Active, {
      enableScripts: true,
      // The screens keep their state (comparisons, unsaved edits) while the tab is in the background.
      retainContextWhenHidden: true,
      localResourceRoots: [ui],
    })
    panel.iconPath = vscode.Uri.joinPath(extensionUri, 'media', 'liftoff.svg')
    UiPanel.current = new UiPanel(panel, ui, projects, binary, log)
    return UiPanel.current
  }

  private constructor(
    readonly panel: vscode.WebviewPanel,
    ui: vscode.Uri,
    projects: string[],
    private readonly binary: () => string,
    private readonly log: vscode.OutputChannel,
  ) {
    panel.webview.html = page(panel.webview, ui, projects)
    panel.webview.onDidReceiveMessage((m: FromPage) => void this.receive(m), null, this.disposables)
    vscode.window.onDidChangeActiveColorTheme((t) => void panel.webview.postMessage({ type: 'theme', theme: themeOf(t.kind) }), null, this.disposables)
    panel.onDidDispose(() => this.dispose(), null, this.disposables)
  }

  /** The command host, started on the first call and again if it stopped. */
  private start(): ChildProcessWithoutNullStreams {
    if (this.host && this.host.exitCode === null) return this.host
    const host = spawn(this.binary(), ['ui-host'], { stdio: 'pipe', windowsHide: true })
    host.stdin.setDefaultEncoding('utf8')
    readline.createInterface({ input: host.stdout }).on('line', (line) => {
      let m: { id?: number; log?: { level: string; message: string } }
      try {
        m = JSON.parse(line)
      } catch {
        return this.log.appendLine(line)
      }
      if (m.log) {
        this.log.appendLine(m.log.message)
        void this.panel.webview.postMessage({ type: 'log', log: m.log })
      } else if (m.id !== undefined) {
        const { id, ...answer } = m
        const name = this.sent.get(id)
        this.sent.delete(id)
        if (name) this.answered.push({ name, ok: (answer as { ok?: boolean }).ok === true })
        void this.panel.webview.postMessage({ type: 'reply', id, value: answer })
      }
    })
    host.stderr.on('data', (d: Buffer) => this.log.append(d.toString()))
    host.on('error', (e) => this.log.appendLine(`liftoff ui-host: ${e.message}`))
    host.on('exit', () => {
      const error = { code: 'LIFTOFF_UNEXPECTED', exit_code: -1, message: 'The LiftOff command host stopped; try again. Details are in the LiftOff output.' }
      for (const id of this.sent.keys()) void this.panel.webview.postMessage({ type: 'reply', id, value: { ok: false, error } })
      this.sent.clear()
    })
    this.host = host
    return host
  }

  private async receive(m: FromPage): Promise<void> {
    const reply = (value: unknown) => void this.panel.webview.postMessage({ type: 'reply', id: m.id, value })
    if (m.type === 'invoke') {
      const host = this.start()
      if (!host.pid) return reply({ ok: false, error: { code: 'LIFTOFF_UNEXPECTED', exit_code: -1, message: `Could not start ${this.binary()}; set liftoff.cliPath or install the LiftOff CLI.` } })
      this.sent.set(m.id, m.name)
      host.stdin.write(`${JSON.stringify({ id: m.id, name: m.name, args: m.args ?? {} })}\n`)
    } else if (m.type === 'pickFolder') {
      const r = await vscode.window.showOpenDialog({ canSelectFolders: true, canSelectFiles: false, canSelectMany: false })
      reply(r?.[0]?.fsPath ?? null)
    } else if (m.type === 'openFile') {
      const r = await vscode.window.showOpenDialog({ canSelectMany: false, filters: { [m.filterName]: m.extensions } })
      reply(r?.[0]?.fsPath ?? null)
    } else if (m.type === 'confirm') {
      // The page's yes/no questions (unsaved changes, replacing a file): webviews block confirm().
      reply((await vscode.window.showWarningMessage(m.message, { modal: true }, 'Yes')) === 'Yes')
    } else if (m.type === 'saveFile') {
      const base = vscode.workspace.workspaceFolders?.[0]?.uri
      const r = await vscode.window.showSaveDialog({ defaultUri: base ? vscode.Uri.joinPath(base, m.defaultPath) : undefined, filters: { [m.filterName]: m.extensions } })
      reply(r?.fsPath ?? null)
    }
  }

  private dispose(): void {
    UiPanel.current = undefined
    this.host?.stdin.end()
    for (const d of this.disposables) d.dispose()
  }
}

/**
 * The desktop UI's index.html with VS Code's rules: a base for its relative asset paths, a content
 * security policy for the webview, and the bridge the screens call (window.liftoff), which turns
 * each call into a message to the extension and its reply back into a promise.
 */
function page(webview: vscode.Webview, ui: vscode.Uri, projects: string[]): string {
  const nonce = crypto.randomBytes(16).toString('base64')
  const html = fs.readFileSync(vscode.Uri.joinPath(ui, 'index.html').fsPath, 'utf8')
  const csp =
    `default-src 'none'; script-src 'nonce-${nonce}' ${webview.cspSource}; style-src ${webview.cspSource} 'unsafe-inline'; ` +
    `img-src ${webview.cspSource} data:; font-src ${webview.cspSource} data:;`
  const theme = themeOf(vscode.window.activeColorTheme.kind)
  const bridge = `<script nonce="${nonce}">
(() => {
  const vscode = acquireVsCodeApi()
  let next = 0
  const waiting = new Map()
  const logs = new Set()
  const themes = new Set()
  let theme = ${JSON.stringify(theme)}
  const call = (message) => new Promise((resolve) => {
    const id = ++next
    waiting.set(id, resolve)
    vscode.postMessage({ ...message, id })
  })
  window.addEventListener('message', (e) => {
    const m = e.data
    if (m.type === 'reply') {
      waiting.get(m.id)?.(m.value)
      waiting.delete(m.id)
    } else if (m.type === 'log') for (const cb of logs) cb(m.log)
    else if (m.type === 'theme') {
      theme = m.theme
      for (const cb of themes) cb(theme)
    }
  })
  window.liftoff = {
    host: 'vscode',
    projects: ${JSON.stringify(projects)},
    theme: () => theme,
    onTheme: (cb) => (themes.add(cb), () => themes.delete(cb)),
    invoke: (name, args) => call({ type: 'invoke', name, args }),
    pickFolder: () => call({ type: 'pickFolder' }),
    openFile: (filterName, extensions) => call({ type: 'openFile', filterName, extensions }),
    saveFile: (defaultPath, filterName, extensions) => call({ type: 'saveFile', defaultPath, filterName, extensions }),
    confirm: (message) => call({ type: 'confirm', message }),
    onLog: (cb) => (logs.add(cb), () => logs.delete(cb)),
    setTheme: async () => {},
    // VS Code updates the extension; the app's own updater has nothing to do here.
    update: async () => ({ mode: 'off', current: '', status: { state: 'idle' } }),
    onUpdate: () => () => {},
  }
})()
</script>`
  return html
    .replace(/<meta http-equiv="Content-Security-Policy"[^>]*>/, () => `<meta http-equiv="Content-Security-Policy" content="${csp}">\n<base href="${webview.asWebviewUri(ui)}/">\n${bridge}`)
}
