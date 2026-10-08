// LiftOff: Project Settings, an editor tab with every project setting and environment.
// The page itself is media/settings.js; this side reads and saves through the CLI
// (`liftoff settings`, `liftoff settings --save` with the changes on stdin, `test-connection`).

import * as crypto from 'node:crypto'
import * as vscode from 'vscode'
import type { Liftoff } from './extension'

type Role = 'dev' | 'scratch' | 'test' | 'prod'

/** `liftoff settings` */
export type Settings = {
  project: {
    name: string
    engine: string
    migrations: string
    schemas: string[]
    history_table: string
    filters: { action: 'include' | 'exclude'; object: string; pattern: string }[]
    lock: 'advisory' | 'table'
    placeholders: Record<string, string>
  }
  environments: {
    name: string
    url: string
    user: string | null
    role: Role
    allow_clean: boolean
    placeholders: Record<string, string>
    shared: boolean
    has_password: boolean
  }[]
}

/** What the page sends back (see SettingsChange in packages/liftoff/src/core/config.ts). */
export type SettingsChange = {
  project?: Partial<Omit<Settings['project'], 'engine'>>
  environments?: (Omit<Settings['environments'][number], 'has_password' | 'user'> & { user: string | null; password?: string })[]
  remove?: string[]
}

type FromPage = { type: 'ready' } | { type: 'save'; change: SettingsChange } | { type: 'test'; name: string }

export class SettingsPanel {
  private static current: SettingsPanel | undefined

  /** Opens the settings (or brings them forward), with one environment opened when given. */
  static async show(context: vscode.ExtensionContext, lo: Liftoff, focus?: string): Promise<SettingsPanel | undefined> {
    if (!lo.projectDir) {
      const choice = await vscode.window.showWarningMessage(
        'There is no LiftOff project in this workspace yet.',
        ...(lo.flywayDirs.length ? ['Import Flyway Project'] : []),
      )
      if (choice) void vscode.commands.executeCommand('liftoff.importFlyway')
      return undefined
    }
    if (SettingsPanel.current) {
      SettingsPanel.current.panel.reveal()
      SettingsPanel.current.focus = focus
      await SettingsPanel.current.send()
      return SettingsPanel.current
    }
    const media = vscode.Uri.joinPath(context.extensionUri, 'media')
    const panel = vscode.window.createWebviewPanel('liftoff.settings', 'LiftOff Settings', vscode.ViewColumn.Active, {
      enableScripts: true,
      localResourceRoots: [media],
      retainContextWhenHidden: true,
    })
    panel.iconPath = vscode.Uri.joinPath(media, 'liftoff.svg')
    SettingsPanel.current = new SettingsPanel(panel, lo, media, focus)
    return SettingsPanel.current
  }

  private constructor(
    readonly panel: vscode.WebviewPanel,
    private readonly lo: Liftoff,
    media: vscode.Uri,
    private focus: string | undefined,
  ) {
    panel.webview.html = page(panel.webview, media)
    panel.webview.onDidReceiveMessage((m: FromPage) => void this.receive(m))
    panel.onDidDispose(() => (SettingsPanel.current = undefined))
  }

  private post(message: unknown): void {
    void this.panel.webview.postMessage(message)
  }

  private async receive(m: FromPage): Promise<void> {
    if (m.type === 'ready') await this.send()
    else if (m.type === 'save') await this.save(m.change)
    else if (m.type === 'test') await this.test(m.name)
  }

  /** Reads the settings and hands them to the page. */
  async send(): Promise<Settings | undefined> {
    try {
      const settings = await this.lo.run<Settings>(['settings'])
      this.post({ type: 'settings', settings, focus: this.focus })
      return settings
    } catch (e) {
      this.post({ type: 'error', message: text(e) })
      return undefined
    }
  }

  /** Saves the page's changes; passwords go over stdin. Public for the tests. */
  async save(change: SettingsChange): Promise<Settings | undefined> {
    try {
      const settings = await this.lo.run<Settings>(['settings', '--save'], undefined, JSON.stringify(change))
      this.post({ type: 'saved', settings })
      await this.lo.load()
      return settings
    } catch (e) {
      this.post({ type: 'error', message: text(e) })
      return undefined
    }
  }

  private async test(name: string): Promise<void> {
    try {
      const s = await this.lo.run<{ database: string; user: string; version: string }>(['test-connection'], name)
      this.post({ type: 'tested', name, ok: true, message: `Connected to ${s.database} as ${s.user} (${s.version})` })
    } catch (e) {
      this.post({ type: 'tested', name, ok: false, message: text(e) })
    }
  }
}

function text(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

/** The page: no inline script or style, nothing loaded from outside the extension. */
function page(webview: vscode.Webview, media: vscode.Uri): string {
  const nonce = crypto.randomBytes(16).toString('base64')
  const css = webview.asWebviewUri(vscode.Uri.joinPath(media, 'settings.css'))
  const js = webview.asWebviewUri(vscode.Uri.joinPath(media, 'settings.js'))
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="stylesheet" href="${css}">
<title>LiftOff Settings</title>
</head>
<body>
<main id="app" aria-busy="true"><p class="muted">Loading the settings…</p></main>
<script nonce="${nonce}" src="${js}"></script>
</body>
</html>`
}
