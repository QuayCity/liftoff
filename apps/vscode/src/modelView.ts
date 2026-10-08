// The schema model in the editor, for teams whose source of truth is the schema-model folder in git:
//
//   - the "Schema Model" view shows what the dev database has that the files do not, object by object;
//     click one for a diff, pull one or all of them into the files (then commit as usual)
//   - Check Schema Model builds the files on the scratch database and puts any errors on the files
//   - Generate Migration from Schema Model writes the next migration script from the files
//   - Set Up Pipeline writes a workflow where pull requests get their migration script written (or required)
//
// The work is done by the liftoff program: `model --status`, `model --path`, `model --check`,
// `generate --from model` and `ci`.

import * as path from 'node:path'
import * as vscode from 'vscode'
import { LiftoffError } from './cli'
import type { Liftoff } from './extension'
import { describeModelChange, modelProblems, type ModelChange } from './model'

const SCHEME = 'liftoff-dev'

class ObjectItem extends vscode.TreeItem {
  constructor(readonly change: ModelChange, devName: string) {
    super(path.basename(change.path, '.sql'), vscode.TreeItemCollapsibleState.None)
    this.contextValue = 'modelChange'
    this.description = describeModelChange(change)
    this.tooltip = `schema-model/${change.path}`
    this.iconPath = new vscode.ThemeIcon(change.kind === 'added' ? 'diff-added' : change.kind === 'removed' ? 'diff-removed' : 'diff-modified')
    this.command = { command: 'liftoff.model.open', title: 'Show the difference', arguments: [this] }
    this.resourceUri = vscode.Uri.parse(`${SCHEME}:/${change.path}?${encodeURIComponent(devName)}`)
  }
}

class NoteItem extends vscode.TreeItem {
  constructor(text: string, icon: string) {
    super(text, vscode.TreeItemCollapsibleState.None)
    this.iconPath = new vscode.ThemeIcon(icon)
    this.tooltip = text
  }
}

type Item = ObjectItem | NoteItem

export class SchemaModelView implements vscode.TreeDataProvider<Item>, vscode.TextDocumentContentProvider {
  private readonly changed = new vscode.EventEmitter<Item | undefined>()
  readonly onDidChangeTreeData = this.changed.event
  private readonly docChanged = new vscode.EventEmitter<vscode.Uri>()
  readonly onDidChange = this.docChanged.event
  readonly diagnostics = vscode.languages.createDiagnosticCollection('liftoff-model')

  /** null: not compared yet */
  changes: ModelChange[] | null = null
  private failure: string | undefined
  private comparing = false

  constructor(private readonly lo: Liftoff) {}

  private devName(): string | undefined {
    const configured = vscode.workspace.getConfiguration('liftoff').get<string>('devEnvironment', '')
    if (configured) return configured
    return this.lo.project?.environments.find((e) => e.role === 'dev')?.name
  }

  private fileUri(rel: string): vscode.Uri | undefined {
    return this.lo.projectDir ? vscode.Uri.file(path.join(this.lo.projectDir, 'schema-model', rel)) : undefined
  }

  /** Compares dev with the schema-model folder. */
  async compare(): Promise<ModelChange[] | undefined> {
    const dev = this.devName()
    this.failure = undefined
    if (!dev) {
      this.failure = 'No dev environment: give one the role "dev" in liftoff.toml, or set liftoff.devEnvironment.'
      this.changes = []
      this.changed.fire(undefined)
      return undefined
    }
    this.comparing = true
    this.changed.fire(undefined)
    try {
      this.changes = await vscode.window.withProgress({ location: { viewId: 'liftoff.model' }, title: `Comparing ${dev} with the schema model` }, () =>
        this.lo.run<ModelChange[]>(['model', '--status', '--source', dev]),
      )
      for (const c of this.changes) this.docChanged.fire(this.devUri(c.path, dev))
      return this.changes
    } catch (e) {
      this.changes = []
      this.failure = e instanceof Error ? e.message : String(e)
      return undefined
    } finally {
      this.comparing = false
      this.changed.fire(undefined)
    }
  }

  private devUri(rel: string, dev: string): vscode.Uri {
    return vscode.Uri.parse(`${SCHEME}:/${rel}?${encodeURIComponent(dev)}`)
  }

  /** The dev side of a diff: the object as the dev database has it (from the last comparison). */
  provideTextDocumentContent(uri: vscode.Uri): string {
    const rel = uri.path.replace(/^\//, '')
    return this.changes?.find((c) => c.path === rel)?.after ?? ''
  }

  /** Opens the model file next to dev's version, in VS Code's diff editor. */
  async open(item: ObjectItem): Promise<void> {
    const dev = this.devName() ?? 'dev'
    const file = this.fileUri(item.change.path)
    if (!file) return
    const left = item.change.before === null ? vscode.Uri.parse(`untitled:${file.fsPath}`) : file
    const title = `${path.basename(item.change.path)}: schema model ↔ ${dev}`
    await vscode.commands.executeCommand('vscode.diff', left, this.devUri(item.change.path, dev), title, { preview: true })
  }

  /** Writes the chosen objects (or all of them) from dev into the schema-model folder. */
  async pull(items?: ObjectItem[]): Promise<number> {
    const dev = this.devName()
    if (!dev || !this.changes?.length) return 0
    const chosen = items?.length ? items.map((i) => i.change.path) : this.changes.map((c) => c.path)
    const args = ['model', '--source', dev, ...chosen.flatMap((p) => ['--path', p])]
    try {
      await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `Pulling ${chosen.length} object(s) from ${dev}` }, () => this.lo.run(args))
    } catch (e) {
      this.showError(e)
      return 0
    }
    void vscode.window.showInformationMessage(`Pulled ${chosen.length} object(s) from ${dev} into the schema model. Commit them from Source Control.`)
    await this.compare()
    return chosen.length
  }

  /** Builds the schema model on the scratch database; problems go on the files. */
  async check(quietWhenFine = false): Promise<boolean> {
    try {
      const r = await vscode.window.withProgress({ location: vscode.ProgressLocation.Window, title: 'Checking the schema model' }, () => this.lo.run<{ files: number }>(['model', '--check']))
      this.diagnostics.clear()
      if (!quietWhenFine) void vscode.window.showInformationMessage(`The schema model builds: ${r.files} object file(s).`)
      return true
    } catch (e) {
      this.diagnostics.clear()
      if (e instanceof LiftoffError && e.report.code === 'LIFTOFF_MODEL_INVALID') {
        for (const [rel, messages] of modelProblems(e.report.problems ?? [])) {
          const uri = this.fileUri(rel)
          if (!uri) continue
          this.diagnostics.set(
            uri,
            messages.map((m) => Object.assign(new vscode.Diagnostic(new vscode.Range(0, 0, 0, 1000), m, vscode.DiagnosticSeverity.Error), { source: 'LiftOff' })),
          )
        }
        void vscode.window.showErrorMessage(`${e.report.problems?.length ?? 0} schema-model file(s) do not build; see Problems.`)
      } else {
        this.showError(e)
      }
      return false
    }
  }

  /** Writes the next migration script from the schema model and opens it. */
  async generate(): Promise<string | undefined> {
    const description = await vscode.window.showInputBox({
      title: 'Generate migration from schema model',
      prompt: 'What the migration does (goes into the file name)',
      validateInput: (v) => (/^[\p{L}\p{N} _-]{1,120}$/u.test(v.trim()) ? undefined : 'Up to 120 letters, digits, spaces, - or _'),
    })
    if (!description) return undefined
    const undo = vscode.workspace.getConfiguration('liftoff').get<boolean>('generateUndo', false)
    try {
      const r = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'Writing the migration from the schema model' }, () =>
        this.lo.run<{ written: string | null }>(['generate', '--from', 'model', '--description', description.trim(), ...(undo ? ['--undo'] : [])]),
      )
      if (!r.written) {
        void vscode.window.showInformationMessage('The migration scripts already build the schema model; nothing to write.')
        return undefined
      }
      await vscode.window.showTextDocument(vscode.Uri.file(r.written))
      return r.written
    } catch (e) {
      this.showError(e)
      return undefined
    }
  }

  /** Writes .github/workflows/liftoff.yml: deployments per stage, plus the pull-request job for the schema model. */
  async setUpPipeline(): Promise<string | undefined> {
    const targets = (this.lo.project?.environments ?? []).filter((e) => e.role === 'test' || e.role === 'prod')
    if (!targets.length) {
      void vscode.window.showWarningMessage('Add the environments to deploy to (role test or prod) to liftoff.toml first.')
      return undefined
    }
    const stages = await vscode.window.showQuickPick(
      targets.map((e) => ({ label: e.name, description: `${e.role} · ${e.engine}`, picked: true })),
      { canPickMany: true, title: 'Deploy to (in this order)' },
    )
    if (!stages?.length) return undefined
    const mode = await vscode.window.showQuickPick(
      [
        { label: 'Write the migration script', detail: 'Pull requests that change the schema model get their migration script written and committed by the pipeline.', mode: 'generate' },
        { label: 'Require a migration script', detail: 'Pull requests fail while a schema model change has no migration script.', mode: 'check' },
        { label: 'Nothing', detail: 'Only deployments.', mode: 'off' },
      ],
      { title: 'Pull requests that change the schema model' },
    )
    if (!mode) return undefined
    const args = ['ci', ...stages.flatMap((s) => ['--stage', s.label]), '--model', mode.mode, '--write']
    try {
      const r = await this.lo.run<{ written: string }>(args)
      await vscode.window.showTextDocument(vscode.Uri.file(r.written))
      void vscode.window.showInformationMessage('Workflow written. Add the repository secrets it names, and point the install step at your LiftOff release.')
      return r.written
    } catch (e) {
      if (e instanceof LiftoffError && /already exists/.test(e.message)) {
        const replace = await vscode.window.showWarningMessage('A LiftOff workflow already exists.', { modal: true }, 'Replace it')
        if (replace) return this.lo.run<{ written: string }>([...args, '--force']).then((r) => r.written)
        return undefined
      }
      this.showError(e)
      return undefined
    }
  }

  private showError(e: unknown): void {
    const text = e instanceof Error ? e.message : String(e)
    this.lo.log.appendLine(`failed: ${text}`)
    void vscode.window.showErrorMessage(text, 'Show Log').then((c) => c && this.lo.log.show())
  }

  /* TreeDataProvider */

  getTreeItem(item: Item): vscode.TreeItem {
    return item
  }

  getChildren(item?: Item): Item[] {
    if (item || !this.lo.project) return []
    if (this.comparing) return [new NoteItem('Comparing…', 'loading~spin')]
    if (this.failure) return [new NoteItem(this.failure, 'error')]
    if (this.changes === null) return [] // the welcome text offers to compare
    if (!this.changes.length) return [new NoteItem(`The schema model matches ${this.devName()}`, 'pass')]
    return this.changes.map((c) => new ObjectItem(c, this.devName() ?? 'dev'))
  }
}

export function registerSchemaModel(context: vscode.ExtensionContext, lo: Liftoff): SchemaModelView {
  const view = new SchemaModelView(lo)
  const tree = vscode.window.createTreeView('liftoff.model', { treeDataProvider: view, canSelectMany: true })
  context.subscriptions.push(
    tree,
    view.diagnostics,
    vscode.workspace.registerTextDocumentContentProvider(SCHEME, view),
    vscode.commands.registerCommand('liftoff.model.compare', () => view.compare()),
    vscode.commands.registerCommand('liftoff.model.open', (item: ObjectItem) => view.open(item)),
    // From the inline button: that object, or every selected one. From the title bar: all of them.
    vscode.commands.registerCommand('liftoff.model.pull', (item?: ObjectItem, selected?: ObjectItem[]) => view.pull(selected?.length ? selected : item ? [item] : undefined)),
    vscode.commands.registerCommand('liftoff.model.pullAll', () => view.pull()),
    vscode.commands.registerCommand('liftoff.model.check', () => view.check()),
    vscode.commands.registerCommand('liftoff.model.generate', () => view.generate()),
    vscode.commands.registerCommand('liftoff.pipeline', () => view.setUpPipeline()),
    // Optional: build the model whenever one of its files is saved.
    vscode.workspace.onDidSaveTextDocument((doc) => {
      const inModel = lo.projectDir && doc.fileName.startsWith(path.join(lo.projectDir, 'schema-model') + path.sep)
      if (inModel && vscode.workspace.getConfiguration('liftoff').get<boolean>('checkModelOnSave', false)) void view.check(true)
    }),
  )
  return view
}
