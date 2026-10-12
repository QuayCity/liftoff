// LiftOff: Compare Data, an editor tab. Compares the rows of two databases once
// (`liftoff data-compare --save-diff`), then pages through the differing rows from the saved keys
// (`--from-diff --rows …`) without comparing again. The page itself is media/datacompare.js.
// Tests pass `answers` to skip the prompts and `confirmed` to skip the confirmation.

import * as crypto from 'node:crypto'
import * as vscode from 'vscode'
import type { Liftoff } from './extension'

export type DataKind = 'only_in_source' | 'only_in_target' | 'different'

/** `liftoff data-compare` (JSON) */
export type DataCompareResult = {
  source: string
  target: string
  engine: string
  ms: number
  tables: { table: string; key: string[]; source_rows: number; target_rows: number; only_in_source: number; only_in_target: number; different: number; skipped?: string; /** no key: whole rows compared */ whole_rows?: boolean }[]
  rows?: DataPage
  script_text?: string
  applied?: { statements: number }
}

/** One page of differing rows: values as text, null for NULL; a side is null when the row is not there. */
export type DataPage = { columns: string[]; key: string[]; total: number; rows: { key: string[]; source: (string | null)[] | null; target: (string | null)[] | null }[] }

type FromPage = { type: 'ready' } | { type: 'page'; table: string; kind: DataKind; offset: number } | { type: 'script' } | { type: 'apply' } | { type: 'again' } | { type: 'swap' }

const PAGE = 100

export class DataComparePanel {
  private static current: DataComparePanel | undefined
  result: DataCompareResult | undefined

  /** Asks for the two databases (unless given), compares them, and shows the result. */
  static async show(context: vscode.ExtensionContext, lo: Liftoff, answers: { source?: string; target?: string } = {}): Promise<DataComparePanel | undefined> {
    const source = answers.source ?? (await lo.compare!.pickSide('Compare Data: the source (whose rows are right)', undefined, true))
    if (!source) return undefined
    const target = answers.target ?? (await lo.compare!.pickSide('Compare Data: the target (what would change)', source, true))
    if (!target) return undefined
    let p = DataComparePanel.current
    if (p) {
      p.panel.reveal()
      p.sides = { source, target }
    } else {
      const media = vscode.Uri.joinPath(context.extensionUri, 'media')
      const panel = vscode.window.createWebviewPanel('liftoff.dataCompare', 'LiftOff Data Compare', vscode.ViewColumn.Active, { enableScripts: true, localResourceRoots: [media], retainContextWhenHidden: true })
      panel.iconPath = vscode.Uri.joinPath(media, 'liftoff.svg')
      const dir = context.storageUri ?? context.globalStorageUri
      p = DataComparePanel.current = new DataComparePanel(panel, lo, media, vscode.Uri.joinPath(dir, 'data-diff.json').fsPath, { source, target })
    }
    await p.compare()
    return p
  }

  private constructor(
    readonly panel: vscode.WebviewPanel,
    private readonly lo: Liftoff,
    media: vscode.Uri,
    /** where the differing keys are kept between pages */
    private readonly diffFile: string,
    private sides: { source: string; target: string },
  ) {
    panel.webview.html = page(panel.webview, media)
    panel.webview.onDidReceiveMessage((m: FromPage) => void this.receive(m))
    panel.onDidDispose(() => (DataComparePanel.current = undefined))
  }

  private post(message: unknown): void {
    void this.panel.webview.postMessage(message)
  }

  private async receive(m: FromPage): Promise<void> {
    if (m.type === 'ready' && this.result) this.post({ type: 'result', result: this.result })
    else if (m.type === 'page') await this.rows(m.table, m.kind, m.offset)
    else if (m.type === 'script') await this.script()
    else if (m.type === 'apply') await this.apply()
    else if (m.type === 'again') await this.compare()
    else if (m.type === 'swap') {
      this.sides = { source: this.sides.target, target: this.sides.source }
      await this.compare()
    }
  }

  private sideArgs(): string[] {
    return ['data-compare', '--source', this.sides.source, '--target', this.sides.target]
  }

  /** Compares the rows again and keeps the differing keys. */
  async compare(): Promise<DataCompareResult | undefined> {
    this.post({ type: 'busy', text: `Comparing the rows of ${this.sides.target} with ${this.sides.source}…` })
    try {
      this.result = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'Comparing the data' }, () =>
        this.lo.run<DataCompareResult>([...this.sideArgs(), '--save-diff', this.diffFile]),
      )
      this.post({ type: 'result', result: this.result })
      return this.result
    } catch (e) {
      this.result = undefined
      this.post({ type: 'error', message: text(e) })
      return undefined
    }
  }

  /** One page of a table's differing rows, read from the saved keys. Public for the tests. */
  async rows(table: string, kind: DataKind, offset = 0): Promise<DataPage | undefined> {
    try {
      const r = await this.lo.run<DataCompareResult>([...this.sideArgs(), '--from-diff', this.diffFile, '--rows', table, '--kind', kind, '--offset', String(offset), '--limit', String(PAGE)])
      this.post({ type: 'rows', table, kind, offset, limit: PAGE, page: r.rows })
      return r.rows
    } catch (e) {
      this.post({ type: 'error', message: text(e) })
      return undefined
    }
  }

  /** Opens the INSERT / UPDATE / DELETE statements that make the target match. */
  async script(): Promise<string | undefined> {
    try {
      const r = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'Writing the sync script' }, () =>
        this.lo.run<DataCompareResult>([...this.sideArgs(), '--from-diff', this.diffFile, '--script', '-']),
      )
      await vscode.window.showTextDocument(await vscode.workspace.openTextDocument({ language: 'sql', content: r.script_text ?? '' }))
      return r.script_text
    } catch (e) {
      void vscode.window.showErrorMessage(text(e))
      return undefined
    }
  }

  /** Runs those statements on the target, in one transaction, after a confirmation. */
  async apply(confirmed = false): Promise<DataCompareResult | undefined> {
    if (!this.result) return undefined
    const env = this.lo.project?.environments.find((e) => e.name === this.sides.target)
    if (!confirmed) {
      const n = this.result.tables.reduce((s, t) => s + t.only_in_source + t.only_in_target + t.different, 0)
      const go = await vscode.window.showWarningMessage(
        `Change ${n} row${n === 1 ? '' : 's'} in ${this.result.target}?`,
        { modal: true, detail: `Rows only in ${this.result.source} are inserted, rows that differ are updated, and rows only in ${this.result.target} are deleted, in one transaction.` },
        'Apply',
      )
      if (go !== 'Apply') return undefined
      if (env?.role === 'prod') {
        const typed = await vscode.window.showInputBox({ title: 'Apply to production', prompt: `Type ${env.name} to confirm`, ignoreFocusOut: true })
        if (typed !== env.name) return undefined
      }
    }
    try {
      const r = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `Applying to ${this.result.target}` }, () =>
        this.lo.run<DataCompareResult>([...this.sideArgs(), '--from-diff', this.diffFile, '--apply', ...(env?.role === 'prod' ? ['--confirm-production'] : [])]),
      )
      void vscode.window.showInformationMessage(`Applied ${r.applied?.statements ?? 0} statement${r.applied?.statements === 1 ? '' : 's'} to ${r.target}.`)
      await this.compare()
      return r
    } catch (e) {
      void vscode.window.showErrorMessage(`Not applied: ${text(e)}`)
      return undefined
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
  const js = webview.asWebviewUri(vscode.Uri.joinPath(media, 'datacompare.js'))
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="stylesheet" href="${css}">
<title>LiftOff Data Compare</title>
</head>
<body>
<main id="app" class="wide" aria-busy="true"><p class="muted">Comparing…</p></main>
<script nonce="${nonce}" src="${js}"></script>
</body>
</html>`
}

export function registerDataCompare(context: vscode.ExtensionContext, lo: Liftoff): void {
  context.subscriptions.push(
    vscode.commands.registerCommand('liftoff.dataCompare', (answers?: { source?: string; target?: string }) => DataComparePanel.show(context, lo, answers)),
  )
}
