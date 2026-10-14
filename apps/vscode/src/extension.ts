// The VS Code side: a sidebar with each environment and its migrations, commands to run and
// check them, and editor warnings on scripts that were edited after they ran.
// All the database work is done by the liftoff program (see cli.ts).

import * as path from 'node:path'
import * as vscode from 'vscode'
import { UiPanel } from './uiPanel'
import { findBinary, LiftoffError, runCli } from './cli'
import { registerCompare, type CompareView } from './compareView'
import { registerDataCompare } from './dataCompare'
import { importFlyway, type ImportAnswers } from './flywayImport'
import { newProject, type NewProjectAnswers } from './newProject'
import { registerSchemaModel, type SchemaModelView } from './modelView'
import { checkRules, Rules } from './rules'
import { SettingsPanel } from './settingsPanel'
import {
  describe,
  groupProblems,
  migrateSummary,
  olderNotRun,
  pickable,
  problemsFor,
  stateIcon,
  summary,
  type CheckReport,
  type Environment,
  type MigrateResult,
  type MigrationInfo,
  type Problem,
  type Project,
} from './model'

/* ---------- tree items ---------- */

class EnvironmentItem extends vscode.TreeItem {
  constructor(readonly env: Environment, infos: MigrationInfo[] | undefined) {
    super(env.name, vscode.TreeItemCollapsibleState.Collapsed)
    this.contextValue = 'environment'
    this.iconPath = new vscode.ThemeIcon(env.role === 'prod' ? 'server-environment' : 'database')
    this.description = `${env.role} · ${env.engine}${infos ? ` · ${summary(infos)}` : ''}`
    this.tooltip = `${env.name}: ${env.role} database on ${env.engine}`
  }
}

class MigrationItem extends vscode.TreeItem {
  constructor(readonly info: MigrationInfo, file: vscode.Uri | undefined, readonly env: Environment) {
    super(info.script, vscode.TreeItemCollapsibleState.None)
    // Scripts that can run on their own get "Run This Script Only".
    this.contextValue = pickable(info) ? 'migration.pickable' : 'migration'
    this.description = describe(info)
    const warn = info.checksum_mismatch || info.state === 'failed'
    this.iconPath = new vscode.ThemeIcon(stateIcon[info.state], warn ? new vscode.ThemeColor('list.warningForeground') : undefined)
    if (info.execution_time_ms !== null) this.tooltip = `${info.script}\nran in ${info.execution_time_ms} ms`
    if (file) this.command = { command: 'vscode.open', title: 'Open script', arguments: [file] }
  }
}

class MessageItem extends vscode.TreeItem {
  constructor(message: string, icon = 'error') {
    super(message, vscode.TreeItemCollapsibleState.None)
    this.iconPath = new vscode.ThemeIcon(icon)
    this.tooltip = message
  }
}

type Item = EnvironmentItem | MigrationItem | MessageItem

/* ---------- the sidebar and everything that talks to the CLI ---------- */

export class Liftoff implements vscode.TreeDataProvider<Item> {
  private readonly changed = new vscode.EventEmitter<Item | undefined>()
  readonly onDidChangeTreeData = this.changed.event
  readonly log = vscode.window.createOutputChannel('LiftOff')
  readonly diagnostics = vscode.languages.createDiagnosticCollection('liftoff')

  project: Project | undefined
  projectDir: string | undefined
  /** the Schema Model view (modelView.ts) */
  schemaModel: SchemaModelView | undefined
  /** the Compare view (compareView.ts) */
  compare: CompareView | undefined
  /** the rules on the scripts, as Problems (rules.ts) */
  rules: Rules | undefined
  /** folders with a Flyway config and no liftoff.toml, for the import */
  flywayDirs: string[] = []
  /** what `info` last returned per environment; only environments someone opened are loaded */
  private readonly infos = new Map<string, MigrationInfo[]>()
  private readonly problems = new Map<string, Problem[]>()

  constructor(private readonly extensionDir: string) {}

  /** The liftoff program: the configured one, the one shipped in the extension, or the PATH's. */
  binary(): string {
    return findBinary(this.extensionDir, vscode.workspace.getConfiguration('liftoff').get('cliPath', ''))
  }

  /** Runs a CLI command for the project, logging its progress to the LiftOff output panel. */
  run<T>(args: string[], environment?: string, input?: string): Promise<T> {
    if (!this.projectDir) return Promise.reject(new Error('No liftoff.toml in this workspace'))
    return this.runIn<T>(this.projectDir, args, environment, input)
  }

  /** The same, in any folder (the Flyway import runs before there is a liftoff.toml). */
  runIn<T>(dir: string, args: string[], environment?: string, input?: string): Promise<T> {
    this.log.appendLine(`> liftoff ${environment ? `--environment ${environment} ` : ''}${args.join(' ')}`)
    return runCli<T>(this.binary(), args, { projectDir: dir, environment, input, onLog: (l) => this.log.appendLine(l) })
  }

  /** Finds liftoff.toml and reads the project; clears what was loaded before. */
  async load(): Promise<void> {
    this.infos.clear()
    this.problems.clear()
    this.diagnostics.clear()
    const found = await vscode.workspace.findFiles('**/liftoff.toml', '**/node_modules/**', 1)
    this.projectDir = found[0] ? path.dirname(found[0].fsPath) : undefined
    // No LiftOff project but a Flyway one: the sidebar offers to import it.
    const flyway = this.projectDir ? [] : await vscode.workspace.findFiles('{**/flyway.toml,**/flyway.conf}', '**/node_modules/**', 10)
    this.flywayDirs = [...new Set(flyway.map((f) => flywayProjectDir(f.fsPath)))]
    void vscode.commands.executeCommand('setContext', 'liftoff.flywayProject', this.flywayDirs.length > 0)
    this.project = undefined
    if (this.projectDir) {
      try {
        this.project = await this.run<Project>(['project'])
        void vscode.commands.executeCommand('setContext', 'liftoff.noScripts', this.project.has_scripts === false)
        // Near V9999: say so once per load, with the way out.
        for (const note of this.project.notes ?? []) {
          void vscode.window.showWarningMessage(`LiftOff: ${note}`, 'Rebaseline…').then((c) => {
            if (c) void vscode.commands.executeCommand('liftoff.rebaseline')
          })
        }
      } catch (e) {
        this.log.appendLine(`Could not read the project: ${message(e)}`)
      }
    }
    void vscode.commands.executeCommand('setContext', 'liftoff.hasProject', this.projectDir !== undefined)
    this.changed.fire(undefined)
  }

  /** What `info` last returned for an environment. */
  infosFor(name: string): MigrationInfo[] {
    return this.infos.get(name) ?? []
  }

  /** Reads one environment's migrations again, and its editor warnings. */
  async loadEnvironment(name: string): Promise<MigrationInfo[]> {
    const infos = await this.run<MigrationInfo[]>(['info'], name)
    this.infos.set(name, infos)
    this.problems.set(name, problemsFor(name, infos))
    this.showProblems()
    return infos
  }

  /** Environments already opened in the sidebar are read again (after a save or a run). */
  async reloadOpened(): Promise<void> {
    await Promise.allSettled([...this.infos.keys()].map((n) => this.loadEnvironment(n)))
    this.changed.fire(undefined)
  }

  scriptUri(script: string): vscode.Uri | undefined {
    if (!this.projectDir || !this.project) return undefined
    return vscode.Uri.file(path.join(this.projectDir, this.project.migrations, script))
  }

  private showProblems(): void {
    this.diagnostics.clear()
    for (const [script, problems] of groupProblems(this.problems)) {
      const uri = this.scriptUri(script)
      if (!uri) continue
      const firstLine = new vscode.Range(0, 0, 0, 1000)
      this.diagnostics.set(
        uri,
        problems.map((p) => {
          const d = new vscode.Diagnostic(firstLine, p.message, p.severity === 'error' ? vscode.DiagnosticSeverity.Error : vscode.DiagnosticSeverity.Warning)
          d.source = 'LiftOff'
          return d
        }),
      )
    }
  }

  /* TreeDataProvider */

  getTreeItem(item: Item): vscode.TreeItem {
    return item
  }

  async getChildren(item?: Item): Promise<Item[]> {
    if (!item) {
      if (!this.project) return []
      if (!this.project.environments.length) return [new MessageItem('No environments in liftoff.toml yet', 'info')]
      return this.project.environments.map((e) => new EnvironmentItem(e, this.infos.get(e.name)))
    }
    if (!(item instanceof EnvironmentItem)) return []
    try {
      const infos = await this.loadEnvironment(item.env.name)
      if (!infos.length) return [new MessageItem('No migration scripts yet', 'info')]
      return infos.map((i) => new MigrationItem(i, i.state === 'missing' || i.state === 'future' ? undefined : this.scriptUri(i.script), item.env))
    } catch (e) {
      return [new MessageItem(message(e))]
    }
  }

  refreshTree(): void {
    this.changed.fire(undefined)
  }
}

/** The project folder of a Flyway config file: its folder, or the one above for `conf/flyway.*`. */
function flywayProjectDir(file: string): string {
  const dir = path.dirname(file)
  return path.basename(dir) === 'conf' ? path.dirname(dir) : dir
}

function message(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

/** An error popup with the log one click away; does not wait for the user. */
function showError(lo: Liftoff, e: unknown): void {
  void vscode.window.showErrorMessage(message(e), 'Show Log').then((choice) => {
    if (choice === 'Show Log') lo.log.show()
  })
}

/* ---------- commands ---------- */

/** The environment a command is for: the one clicked in the sidebar, else a pick. */
async function pickEnvironment(lo: Liftoff, item?: EnvironmentItem): Promise<Environment | undefined> {
  if (item?.env) return item.env
  const envs = lo.project?.environments ?? []
  if (envs.length === 1) return envs[0]
  const pick = await vscode.window.showQuickPick(
    envs.map((e) => ({ label: e.name, description: `${e.role} · ${e.engine}`, env: e })),
    { placeHolder: 'Which environment?' },
  )
  return pick?.env
}

/** Runs `work` with a progress notification; failures become an error message with the log one click away. */
async function withProgress<T>(lo: Liftoff, title: string, work: () => Promise<T>): Promise<T | undefined> {
  try {
    return await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title }, work)
  } catch (e) {
    const code = e instanceof LiftoffError ? e.report.code : ''
    showError(lo, e)
    lo.log.appendLine(`failed${code ? ` (${code})` : ''}: ${message(e)}`)
    return undefined
  }
}

async function migrate(lo: Liftoff, item?: EnvironmentItem): Promise<MigrateResult | undefined> {
  const env = await pickEnvironment(lo, item)
  if (!env) return undefined
  if (env.role === 'prod') {
    const go = await vscode.window.showWarningMessage(`Run the pending migrations on ${env.name}? This is a production database.`, { modal: true }, 'Run')
    if (go !== 'Run') return undefined
  }
  const result = await runMigrate(lo, env, [])
  await lo.reloadOpened()
  return result
}

/**
 * Runs migrate; a database with tables but no history (project without scripts) is offered for
 * adoption, and one that differs from the baseline script gets its differences listed first.
 */
async function runMigrate(lo: Liftoff, env: Environment, extra: string[]): Promise<MigrateResult | undefined> {
  try {
    const r = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `Running migrations on ${env.name}` }, () =>
      lo.run<MigrateResult>(['migrate', ...extra], env.name),
    )
    vscode.window.showInformationMessage(migrateSummary(env.name, r))
    return r
  } catch (e) {
    if (e instanceof LiftoffError && e.report.code === 'LIFTOFF_NOT_BASELINED' && lo.project?.has_scripts === false) {
      const c = await vscode.window.showWarningMessage(
        `${env.name} already has tables, and this project has no scripts yet.`,
        { modal: true, detail: 'Adopt it: its objects become B0001 (checked on the scratch database first), recorded as already there. Other environments are checked against it when they migrate; new scripts start at V0002.' },
        'Adopt as B0001',
      )
      if (c) await adoptDatabase(lo, env)
      return undefined
    }
    if (e instanceof LiftoffError && e.report.code === 'LIFTOFF_BASELINE_DIFFERS') {
      const word = { added: 'missing', removed: 'not in the baseline', changed: 'different' } as Record<string, string>
      const list = (e.report.differences ?? []).map((d) => `• ${d.id}: ${word[d.kind] ?? d.kind}`).join('\n')
      const c = await vscode.window.showWarningMessage(
        `${env.name} differs from the baseline script. Nothing was changed.`,
        { modal: true, detail: `${list}\n\nMake these match and run again, or record the baseline anyway: missing objects are created, the rest is kept as it is and shows up as drift.` },
        'Record Anyway',
      )
      return c ? runMigrate(lo, env, ['--accept-differences']) : undefined
    }
    showError(lo, e)
    return undefined
  }
}

/** A project without scripts starts from this database: B0001. `env` comes from the menu, else a pick. */
async function adoptDatabase(lo: Liftoff, env?: Environment): Promise<{ baseline: string } | undefined> {
  const target = env ?? (await pickEnvironment(lo))
  if (!target) return undefined
  const r = await withProgress(lo, `Capturing ${target.name} as B0001`, () => lo.run<{ baseline: string }>(['adopt'], target.name))
  if (r) {
    vscode.window.showInformationMessage(`Captured ${target.name} as ${path.basename(r.baseline)} and recorded it there. New scripts start at V0002.`)
    await lo.load()
  }
  return r
}

/** Runs one script and nothing else on an environment (`migrate --only`), after saying what that means. */
/** Records a pending script without running it: for a database that already has its changes. */
async function markApplied(lo: Liftoff, item: MigrationItem, confirmed = false): Promise<boolean> {
  const { info, env } = item
  if (!confirmed) {
    const detail = `Only for a database that already has this script's changes: the one it was written from, or one changed by hand the same way. If it does not, the scripts after it may fail there, and Check for Drift shows what is missing.${env.role === 'prod' ? `\n\n${env.name} is a production database.` : ''}`
    const go = await vscode.window.showWarningMessage(`Record ${info.script} as applied on ${env.name}, without running it?`, { modal: true, detail }, 'Record as Applied')
    if (go !== 'Record as Applied') return false
  }
  const done = await withProgress(lo, `Recording ${info.script} on ${env.name}`, () => lo.run<{ recorded: string }>(['mark-applied', info.script], env.name))
  if (done) vscode.window.showInformationMessage(`Recorded ${info.script} as applied on ${env.name}.`)
  await lo.reloadOpened()
  return !!done
}

async function runOnly(lo: Liftoff, item: MigrationItem, confirmed = false): Promise<MigrateResult | undefined> {
  const { info, env } = item
  if (!confirmed) {
    const older = olderNotRun(lo.infosFor(env.name), info)
    const lines = [
      older.length
        ? `Older scripts that have not run on ${env.name} stay that way: ${older.map((o) => o.script).join(', ')}. Run Pending will then ask for --out-of-order. If ${info.script} depends on them, it fails.`
        : `Nothing else runs; other pending scripts stay pending.`,
      ...(env.role === 'prod' ? ['', `${env.name} is a production database.`] : []),
    ]
    const go = await vscode.window.showWarningMessage(`Run only ${info.script} on ${env.name}?`, { modal: true, detail: lines.join('\n') }, 'Run This Script Only')
    if (go !== 'Run This Script Only') return undefined
  }
  const result = await withProgress(lo, `Running ${info.script} on ${env.name}`, () => lo.run<MigrateResult>(['migrate', '--only', info.script], env.name))
  if (result) {
    const behind = result.left_behind?.length ? ` Not run yet, and older: ${result.left_behind.join(', ')}.` : ''
    vscode.window.showInformationMessage(`Ran ${info.script} on ${env.name}.${behind}`)
  }
  await lo.reloadOpened()
  return result
}

type Rebaselined = { baseline: string; version: string; removed: string[]; archived_to: string | null }

/**
 * One baseline script replaces the versioned scripts; the old ones are deleted (git keeps them) or
 * moved to a folder. `answers` is for the tests.
 */
async function rebaselineProject(lo: Liftoff, answers?: { description: string; archive?: string; restart?: boolean }): Promise<Rebaselined | undefined> {
  let description = answers?.description
  let archive = answers?.archive
  let restart = answers?.restart ?? false
  if (!answers) {
    const how = await vscode.window.showQuickPick(
      [
        { label: 'Remove the old scripts', detail: 'Fewer files; git still has them (they must be committed).', archive: undefined as string | undefined },
        { label: 'Move them to migrations-archive', detail: 'Out of the migrations folder, still in the project.', archive: 'migrations-archive' },
      ],
      { title: 'Rebaseline: the scripts the baseline replaces' },
    )
    if (!how) return undefined
    archive = how.archive
    const numbering = await vscode.window.showQuickPick(
      [
        { label: 'Start the numbering again', detail: 'The baseline is B0001 and the next script V0002. Databases that ran the old scripts are checked against it on their next run.', restart: true },
        { label: 'Keep the numbering', detail: 'The baseline takes the number of the last script it replaces.', restart: false },
      ],
      { title: 'Rebaseline: numbering' },
    )
    if (!numbering) return undefined
    restart = numbering.restart
    description = await vscode.window.showInputBox({ title: 'Rebaseline', prompt: 'Description of the baseline script', value: 'baseline', validateInput: (v) => (v.trim() ? undefined : 'Describe it') })
    if (!description) return undefined
    const go = await vscode.window.showWarningMessage(
      'Rebaseline the project?',
      { modal: true, detail: 'One baseline script replaces the versioned scripts. It is built on the scratch database and checked first; nothing is removed if it does not build the same schema. Databases that already ran the scripts are not changed.' },
      'Rebaseline',
    )
    if (go !== 'Rebaseline') return undefined
  }
  const r = await withProgress(lo, 'Rebaselining', () =>
    lo.run<Rebaselined>(['rebaseline', '--description', description!.trim(), ...(archive ? ['--archive', archive] : []), ...(restart ? ['--restart'] : [])]),
  )
  if (r) {
    vscode.window.showInformationMessage(`Wrote ${path.basename(r.baseline)}; ${r.removed.length} old script(s) ${r.archived_to ? `moved to ${path.basename(r.archived_to)}` : 'deleted (git still has them)'}.`)
    await lo.load()
  }
  return r
}

async function dryRun(lo: Liftoff, item?: EnvironmentItem): Promise<void> {
  const env = await pickEnvironment(lo, item)
  if (!env) return
  const result = await withProgress(lo, `Working out what would run on ${env.name}`, () => lo.run<MigrateResult>(['migrate', '--dry-run'], env.name))
  if (result?.dry_run_sql) {
    const doc = await vscode.workspace.openTextDocument({ language: 'sql', content: result.dry_run_sql })
    await vscode.window.showTextDocument(doc, { preview: true })
  }
}

async function validate(lo: Liftoff, item?: EnvironmentItem): Promise<void> {
  const env = await pickEnvironment(lo, item)
  if (!env) return
  const ok = await withProgress(lo, `Validating ${env.name}`, () => lo.run<unknown>(['validate'], env.name).then(() => true))
  if (ok) vscode.window.showInformationMessage(`${env.name}: every applied script matches its file`)
  await lo.reloadOpened()
}

async function checkDrift(lo: Liftoff, item?: EnvironmentItem): Promise<CheckReport | undefined> {
  const env = await pickEnvironment(lo, item)
  if (!env) return undefined
  let report: CheckReport | undefined
  try {
    report = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `Checking ${env.name} for drift` }, () =>
      lo.run<CheckReport>(['check', '--drift'], env.name),
    )
  } catch (e) {
    // Drift is reported as a failure that still carries the report.
    if (e instanceof LiftoffError && e.report.code === 'LIFTOFF_DRIFT' && e.result) {
      report = e.result as CheckReport
    } else {
      showError(lo, e)
      return undefined
    }
  }
  const drift = report.drift ?? []
  for (const n of report.not_compared) lo.log.appendLine(`not compared: ${n}`)
  if (!drift.length) {
    vscode.window.showInformationMessage(`No drift on ${env.name}: it matches its applied scripts`)
    return report
  }
  const names = drift.map((c) => `${c.kind} ${c.object_type.toLowerCase()} ${c.name}`)
  names.forEach((n) => lo.log.appendLine(`drift: ${n}`))
  const content = `-- What would make the scripts match ${env.name}:\n\n` + drift.map((c) => `-- ${c.kind} ${c.name}\n${c.sql}`).join('\n\n')
  void vscode.window.showWarningMessage(`${drift.length} object${drift.length === 1 ? '' : 's'} on ${env.name} differ${drift.length === 1 ? 's' : ''} from its scripts`, 'Show the SQL').then(async (choice) => {
    if (choice === 'Show the SQL') {
      await vscode.window.showTextDocument(await vscode.workspace.openTextDocument({ language: 'sql', content }), { preview: true })
    }
  })
  return report
}

async function testConnection(lo: Liftoff, item?: EnvironmentItem): Promise<void> {
  const env = await pickEnvironment(lo, item)
  if (!env) return
  const info = await withProgress(lo, `Connecting to ${env.name}`, () => lo.run<{ database: string; user: string; version: string }>(['test-connection'], env.name))
  if (info) vscode.window.showInformationMessage(`Connected to ${env.name}: ${info.database} as ${info.user} (${env.engine} ${info.version})`)
}

/* ---------- activation ---------- */

export async function activate(context: vscode.ExtensionContext): Promise<Liftoff> {
  const lo = new Liftoff(context.extensionPath)
  context.subscriptions.push(
    lo.log,
    lo.diagnostics,
    vscode.window.registerTreeDataProvider('liftoff.environments', lo),
    vscode.commands.registerCommand('liftoff.refresh', () => lo.load()),
    vscode.commands.registerCommand('liftoff.migrate', (item?: EnvironmentItem) => migrate(lo, item)),
    vscode.commands.registerCommand('liftoff.dryRun', (item?: EnvironmentItem) => dryRun(lo, item)),
    // `confirmed` is for the tests, which cannot press the dialog's button.
    vscode.commands.registerCommand('liftoff.runOnly', (item: MigrationItem, confirmed?: boolean) => runOnly(lo, item, confirmed === true)),
    vscode.commands.registerCommand('liftoff.markApplied', (item: MigrationItem, confirmed?: boolean) => markApplied(lo, item, confirmed === true)),
    vscode.commands.registerCommand('liftoff.validate', (item?: EnvironmentItem) => validate(lo, item)),
    vscode.commands.registerCommand('liftoff.checkDrift', (item?: EnvironmentItem) => checkDrift(lo, item)),
    vscode.commands.registerCommand('liftoff.lint', () => checkRules(lo, lo.rules!)),
    vscode.commands.registerCommand('liftoff.testConnection', (item?: EnvironmentItem) => testConnection(lo, item)),
    vscode.commands.registerCommand('liftoff.showLog', () => lo.log.show()),
    // The desktop app's screens in a panel: everything LiftOff does, without leaving VS Code.
    vscode.commands.registerCommand('liftoff.open', () => UiPanel.show(context.extensionUri, () => lo.binary(), lo.log)),
    vscode.commands.registerCommand('liftoff.importFlyway', (answers?: ImportAnswers) => importFlyway(lo, answers)),
    vscode.commands.registerCommand('liftoff.rebaseline', (answers?: { description: string; archive?: string; restart?: boolean }) => rebaselineProject(lo, answers)),
    vscode.commands.registerCommand('liftoff.adopt', (item?: EnvironmentItem) => adoptDatabase(lo, item?.env)),
    vscode.commands.registerCommand('liftoff.newProject', (answers?: NewProjectAnswers) => newProject(lo, answers)),
    // From an environment's menu (its item), the import (a name), or the palette (nothing).
    vscode.commands.registerCommand('liftoff.settings', (target?: EnvironmentItem | string) =>
      SettingsPanel.show(context, lo, typeof target === 'string' ? target : target?.env?.name),
    ),
    vscode.commands.registerCommand('liftoff.editEnvironment', (item?: EnvironmentItem) => SettingsPanel.show(context, lo, item?.env?.name)),
    // Saving a script or liftoff.toml (or liftoff.user.toml) re-reads what is open, so warnings follow the edit.
    vscode.workspace.onDidSaveTextDocument((doc) => {
      if (['liftoff.toml', 'liftoff.user.toml'].includes(path.basename(doc.fileName))) void lo.load()
      else if (doc.fileName.endsWith('.sql')) void lo.reloadOpened()
      lo.rules?.onSave(doc.fileName)
    }),
  )
  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 50)
  status.text = '$(rocket) LiftOff'
  status.tooltip = 'Open LiftOff: environments, changes, compare, scripts, rules and more'
  status.command = 'liftoff.open'
  status.show()
  context.subscriptions.push(status)
  lo.rules = new Rules(lo)
  context.subscriptions.push(lo.rules.diagnostics)
  await lo.load()
  void lo.rules.lint()
  lo.schemaModel = registerSchemaModel(context, lo)
  lo.compare = registerCompare(context, lo)
  registerDataCompare(context, lo)
  // Returned for the integration tests.
  return lo
}

export function deactivate(): void {}
