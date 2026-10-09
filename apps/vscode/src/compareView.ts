// LiftOff: Compare in the editor. Pick two sides (an environment, the schema model, what the
// migrations build, a snapshot file, a database URL), go through the differences in the Compare
// view (a checkbox each, a diff editor on click), then open the sync script, write a migration,
// or apply to the target. All of it runs `liftoff compare` / `liftoff snapshot`.
// Tests pass `answers` to skip the prompts.

import * as vscode from 'vscode'
import type { Liftoff } from './extension'

type Kind = 'added' | 'changed' | 'removed'

/** `liftoff compare` (JSON): a difference */
export type CompareChange = { id: string; object_type: string; name: string; kind: Kind; destructive: boolean; sql: string; before: string | null; after: string | null }

/** `liftoff compare` (JSON) */
export type CompareResult = {
  source: string
  target: string
  engine: string
  changes: CompareChange[]
  not_compared: string[]
  script_text?: string
  migration?: string
  applied?: { target: string; transactional: boolean }
}

export type CompareAnswers = { source?: string; target?: string }

const SCHEME = 'liftoff-compare'

class DiffItem extends vscode.TreeItem {
  constructor(readonly change: CompareChange, checked: boolean) {
    super(change.name, vscode.TreeItemCollapsibleState.None)
    this.id = change.id
    this.description = `${change.object_type.toLowerCase()} · ${change.kind === 'added' ? 'only in the source' : change.kind === 'removed' ? 'only in the target' : 'different'}${change.destructive ? ' · may lose data' : ''}`
    this.iconPath = new vscode.ThemeIcon(change.kind === 'added' ? 'diff-added' : change.kind === 'removed' ? 'diff-removed' : 'diff-modified')
    this.checkboxState = checked ? vscode.TreeItemCheckboxState.Checked : vscode.TreeItemCheckboxState.Unchecked
    this.contextValue = 'compareChange'
    this.command = { command: 'liftoff.compare.open', title: 'Show the difference', arguments: [this] }
    this.tooltip = change.id
  }
}

class NoteItem extends vscode.TreeItem {
  constructor(text: string, icon: string) {
    super(text, vscode.TreeItemCollapsibleState.None)
    this.iconPath = new vscode.ThemeIcon(icon)
  }
}

type Item = DiffItem | NoteItem

export class CompareView implements vscode.TreeDataProvider<Item>, vscode.TextDocumentContentProvider {
  private readonly changed = new vscode.EventEmitter<Item | undefined>()
  readonly onDidChangeTreeData = this.changed.event
  /** the sides as given to the CLI */
  sides: { source: string; target: string } | undefined
  result: CompareResult | undefined
  /** ids of the differences ticked */
  readonly checked = new Set<string>()
  private busy = false

  constructor(private readonly lo: Liftoff) {}

  /** Asks for the two sides (unless given), then compares them. */
  async start(answers: CompareAnswers = {}): Promise<CompareResult | undefined> {
    const source = answers.source ?? (await this.pickSide('Compare: the source (what it should look like)'))
    if (!source) return undefined
    const target = answers.target ?? (await this.pickSide('Compare: the target (what would change)', source))
    if (!target) return undefined
    this.sides = { source, target }
    return this.run()
  }

  /** Runs the comparison for the current sides. */
  async run(): Promise<CompareResult | undefined> {
    if (!this.sides) return this.start()
    this.busy = true
    this.result = undefined
    this.changed.fire(undefined)
    void vscode.commands.executeCommand('setContext', 'liftoff.compared', false)
    try {
      this.result = await vscode.window.withProgress({ location: { viewId: 'liftoff.compare' }, title: 'Comparing' }, () =>
        this.lo.run<CompareResult>(['compare', '--source', this.sides!.source, '--target', this.sides!.target]),
      )
      this.checked.clear()
      for (const c of this.result.changes) if (!c.destructive) this.checked.add(c.id)
      void vscode.commands.executeCommand('setContext', 'liftoff.compared', this.result.changes.length > 0)
      return this.result
    } catch (e) {
      void vscode.window.showErrorMessage(e instanceof Error ? e.message : String(e))
      return undefined
    } finally {
      this.busy = false
      this.changed.fire(undefined)
    }
  }

  swap(): Promise<CompareResult | undefined> {
    if (!this.sides) return this.start()
    this.sides = { source: this.sides.target, target: this.sides.source }
    return this.run()
  }

  private async pickSide(title: string, not?: string): Promise<string | undefined> {
    const envs = this.lo.project?.environments ?? []
    const hasScratch = envs.some((e) => e.role === 'scratch')
    type Choice = vscode.QuickPickItem & { side?: string; ask?: 'snapshot' | 'url' }
    const items: Choice[] = [
      { label: 'Environments', kind: vscode.QuickPickItemKind.Separator },
      ...envs.map((e) => ({ label: e.name, description: `${e.role} · ${e.engine}`, side: e.name })),
      { label: 'This project', kind: vscode.QuickPickItemKind.Separator },
      ...(hasScratch
        ? [
            { label: 'The schema model', description: 'built on the scratch database', side: 'model' },
            { label: 'What the migrations build', description: 'on the scratch database', side: 'migrations' },
          ]
        : []),
      { label: 'Elsewhere', kind: vscode.QuickPickItemKind.Separator },
      { label: 'A snapshot file…', description: 'saved earlier with LiftOff: Save Snapshot', ask: 'snapshot' as const },
      { label: 'A database URL…', description: 'any database, also outside this project', ask: 'url' as const },
    ].filter((i) => !('side' in i) || i.side !== not)
    const pick = await vscode.window.showQuickPick(items, { title, ignoreFocusOut: true })
    if (!pick) return undefined
    if (pick.side) return pick.side
    if (pick.ask === 'snapshot') {
      const f = await vscode.window.showOpenDialog({ canSelectMany: false, filters: { 'LiftOff snapshot': ['json'] }, title: 'The snapshot to compare' })
      return f?.[0] ? `snapshot:${f[0].fsPath}` : undefined
    }
    return vscode.window.showInputBox({
      title,
      prompt: 'Connection URL',
      placeHolder: 'postgres://user@host:5432/db or sqlserver://host:1433;databaseName=db',
      ignoreFocusOut: true,
      validateInput: (v) => (/^(postgres(ql)?|sqlserver):/i.test(v.trim()) ? undefined : 'A postgres:// or sqlserver:// URL'),
    })
  }

  private chosenArgs(): string[] {
    return [...this.checked].flatMap((id) => ['--object', id])
  }

  private sideArgs(): string[] {
    return ['--source', this.sides!.source, '--target', this.sides!.target]
  }

  private needSelection(): boolean {
    if (this.result && this.checked.size) return true
    void vscode.window.showInformationMessage('Tick at least one difference first.')
    return false
  }

  /** Opens the script that makes the target like the source (the ticked differences). */
  async script(): Promise<string | undefined> {
    if (!this.needSelection()) return undefined
    const r = await this.lo.run<CompareResult>(['compare', ...this.sideArgs(), ...this.chosenArgs(), '--script', '-'])
    if (!r.script_text) return undefined
    await vscode.window.showTextDocument(await vscode.workspace.openTextDocument({ language: 'sql', content: r.script_text }))
    return r.script_text
  }

  /** Writes the ticked differences as the next migration. */
  async migration(description?: string): Promise<string | undefined> {
    if (!this.needSelection()) return undefined
    const d =
      description ??
      (await vscode.window.showInputBox({ title: 'Write the differences as a migration', prompt: 'What the migration does (goes into the file name)', validateInput: (v) => (v.trim() ? undefined : 'Describe it') }))
    if (!d) return undefined
    const r = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'Writing the migration' }, () =>
      this.lo.run<CompareResult>(['compare', ...this.sideArgs(), ...this.chosenArgs(), '--migration', d.trim()]),
    )
    if (r.migration) await vscode.window.showTextDocument(vscode.Uri.file(r.migration))
    return r.migration
  }

  /** Runs the ticked differences on the target database, after a confirmation. `confirmed` is for the tests. */
  async apply(confirmed = false): Promise<CompareResult | undefined> {
    if (!this.needSelection() || !this.sides) return undefined
    const env = this.lo.project?.environments.find((e) => e.name === this.sides!.target)
    const isDb = !!env || /^(postgres(ql)?|sqlserver):/i.test(this.sides.target)
    if (!isDb) {
      void vscode.window.showWarningMessage(`${this.result!.target} is not a database; open the script or write a migration instead.`)
      return undefined
    }
    if (!confirmed) {
      const n = this.checked.size
      const go = await vscode.window.showWarningMessage(
        `Apply ${n} change${n === 1 ? '' : 's'} to ${this.result!.target}?`,
        { modal: true, detail: `They run now, in one transaction when possible. ${this.result!.target}'s migration history is not changed, so afterwards it differs from its scripts. To keep environments in step, write a migration instead.` },
        'Apply',
      )
      if (go !== 'Apply') return undefined
      if (env?.role === 'prod') {
        const typed = await vscode.window.showInputBox({ title: 'Apply to production', prompt: `Type ${env.name} to confirm`, ignoreFocusOut: true })
        if (typed !== env.name) return undefined
      }
    }
    try {
      const r = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `Applying to ${this.result!.target}` }, () =>
        this.lo.run<CompareResult>(['compare', ...this.sideArgs(), ...this.chosenArgs(), '--apply', ...(env?.role === 'prod' ? ['--confirm-production'] : [])]),
      )
      void vscode.window.showInformationMessage(`Applied ${this.checked.size} change(s) to ${r.applied?.target ?? this.result!.target}.`)
      await this.run()
      return r
    } catch (e) {
      void vscode.window.showErrorMessage(`Not applied: ${e instanceof Error ? e.message : String(e)}`)
      return undefined
    }
  }

  /** Saves a side's schema to a file, to compare with later. */
  async snapshot(of?: string, file?: string): Promise<string | undefined> {
    const side = of ?? (await this.pickSide('Save a snapshot of'))
    if (!side || side.startsWith('snapshot:')) return undefined
    const name = `${side.replace(/[^A-Za-z0-9_-]+/g, '-')}-${new Date().toISOString().slice(0, 10)}.json`
    const out =
      file ??
      (await vscode.window.showSaveDialog({ title: 'Save the snapshot', defaultUri: this.lo.projectDir ? vscode.Uri.file(`${this.lo.projectDir}/snapshots/${name}`) : undefined, filters: { 'LiftOff snapshot': ['json'] } }))?.fsPath
    if (!out) return undefined
    const r = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `Saving a snapshot of ${side}` }, () =>
      this.lo.run<{ file: string; objects: number }>(['snapshot', '--of', side, '--out', out]),
    )
    void vscode.window.showInformationMessage(`Saved ${r.objects} objects to ${r.file}.`)
    return r.file
  }

  /** The two sides of one difference, for the diff editor: liftoff-compare:/<target|source>/<id> */
  provideTextDocumentContent(uri: vscode.Uri): string {
    const [, side, ...rest] = uri.path.split('/')
    const c = this.result?.changes.find((x) => x.id === decodeURIComponent(rest.join('/')))
    return (side === 'source' ? c?.after : c?.before) ?? ''
  }

  async open(item: DiffItem): Promise<void> {
    const at = (side: string) => vscode.Uri.parse(`${SCHEME}:/${side}/${encodeURIComponent(item.change.id)}.sql`)
    await vscode.commands.executeCommand('vscode.diff', at('target'), at('source'), `${item.change.name}: ${this.result!.target} ↔ ${this.result!.source}`, { preview: true })
  }

  /* TreeDataProvider */

  getTreeItem(item: Item): vscode.TreeItem {
    return item
  }

  getChildren(item?: Item): Item[] {
    if (item) return []
    if (this.busy) return [new NoteItem('Comparing…', 'loading~spin')]
    if (!this.result) return []
    if (!this.result.changes.length) return [new NoteItem(`${this.result.target} matches ${this.result.source}`, 'pass')]
    return [
      new NoteItem(`${this.result.target} → ${this.result.source}: ${this.result.changes.length} difference(s)`, 'git-compare'),
      ...this.result.changes.map((c) => new DiffItem(c, this.checked.has(c.id))),
      ...this.result.not_compared.map((n) => new NoteItem(`not compared: ${n}`, 'info')),
    ]
  }
}

export function registerCompare(context: vscode.ExtensionContext, lo: Liftoff): CompareView {
  const view = new CompareView(lo)
  const tree = vscode.window.createTreeView('liftoff.compare', { treeDataProvider: view })
  context.subscriptions.push(
    tree,
    tree.onDidChangeCheckboxState((e) => {
      for (const [item, state] of e.items) {
        if (!(item instanceof DiffItem)) continue
        if (state === vscode.TreeItemCheckboxState.Checked) view.checked.add(item.change.id)
        else view.checked.delete(item.change.id)
      }
    }),
    vscode.workspace.registerTextDocumentContentProvider(SCHEME, view),
    vscode.commands.registerCommand('liftoff.compare', (answers?: CompareAnswers) => view.start(answers)),
    vscode.commands.registerCommand('liftoff.compare.again', () => view.run()),
    vscode.commands.registerCommand('liftoff.compare.swap', () => view.swap()),
    vscode.commands.registerCommand('liftoff.compare.open', (item: DiffItem) => view.open(item)),
    vscode.commands.registerCommand('liftoff.compare.script', () => view.script()),
    vscode.commands.registerCommand('liftoff.compare.migration', (description?: string) => view.migration(description)),
    vscode.commands.registerCommand('liftoff.compare.apply', (confirmed?: boolean) => view.apply(confirmed === true)),
    vscode.commands.registerCommand('liftoff.snapshot', (of?: string, file?: string) => view.snapshot(of, file)),
  )
  return view
}
