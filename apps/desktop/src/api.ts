// Typed wrappers over the desktop app's commands (packages/liftoff/src/host/commands.ts), reached through the
// bridge in electron/preload.ts. Outside the app (plain browser: screenshots, UI tests) the same
// signatures run against seeded fake data.

export type Role = 'dev' | 'scratch' | 'test' | 'prod'
export type ErrorReport = { code: string; exit_code: number; message: string; differences?: { id: string; kind: string; destructive: boolean }[] }
export type EnvView = { name: string; role: Role; url: string; user: string | null; has_password: boolean; allow_clean: boolean; /** in liftoff.toml (else this computer only) */ shared: boolean }
export type Filter = { action: 'include' | 'exclude'; object: string; pattern: string }
export type LockMode = 'advisory' | 'table'
export type Engine = 'postgresql' | 'sqlserver'
const ENGINE_NAMES: Record<string, string> = { postgresql: 'PostgreSQL', sqlserver: 'SQL Server' }
export const engineName = (engine: string) => ENGINE_NAMES[engine] ?? 'PostgreSQL'
/** The engine and its schemas, as the status bar shows them (none: the engine manages the database the URL names). */
export const engineAndSchemas = (p: { engine: string; schemas: string[] }) => (p.schemas.length ? `${engineName(p.engine)} · ${p.schemas.join(', ')}` : engineName(p.engine))
/** An example connection URL for the project's engine, for placeholders and help. */
export const urlExample = (engine: string) => (engine === 'sqlserver' ? 'sqlserver://localhost:1433;databaseName=shop;encrypt=true;trustServerCertificate=true' : 'postgres://localhost:5432/shop')
/** The engine a connection URL points at. */
export const engineOfUrl = (url: string): Engine => (/^(jdbc:)?sqlserver:\/\//i.test(url.trim()) ? 'sqlserver' : 'postgresql')
export type ProjectSettings = { name: string; engine: string; migrations: string; schemas: string[]; history_table: string; filters: Filter[]; lock: LockMode }
export type Project = {
  root: string; name: string; engine: string; schemas: string[]; migrations: string; history_table: string; filters: Filter[]; lock: LockMode; environments: EnvView[]
  /** any versioned or baseline script yet (without: an existing database can be adopted) */
  has_scripts: boolean
  /** e.g. the numbering nearing 9999 */
  notes: string[]
}
export type Recent = { name: string; path: string; exists: boolean }
export type EnvInput = { url: string; user: string | null; password: string | null; role: Role; allow_clean: boolean }
export type ServerInfo = { version: string; user: string; database: string }
export type State = 'pending' | 'applied' | 'failed' | 'outdated' | 'ignored' | 'below_baseline' | 'missing' | 'baseline' | 'future' | 'excluded'
export type MigrationInfo = {
  kind: 'versioned' | 'repeatable' | 'undo' | 'baseline'; version: string | null; description: string; script: string
  state: State; installed_on: string | null; execution_time_ms: number | null; checksum_mismatch: boolean
  /** `-- liftoff:for`: the environments it runs on */
  for?: string
  /** `-- liftoff:topic` words */
  topics?: string[]
}
export type MigrateResult = {
  environment: string; applied: { script: string; version: string | null; execution_time_ms: number; transactional: boolean }[]; execution_time_ms: number
  /** after a run with `only`: older versioned scripts that still have not run */
  left_behind?: string[]
  /** a database with objects checked against a baseline script instead of running it */
  baseline_check?: { script: string; created: string[]; accepted: string[]; restart: boolean }
}

/** Whether a script can be run on its own (`migrate --only`); the core checks again. */
export function pickable(i: MigrationInfo): boolean {
  if (i.kind === 'versioned') return i.state === 'pending' || i.state === 'ignored'
  if (i.kind === 'repeatable') return i.state === 'pending' || i.state === 'outdated' || i.state === 'applied'
  return false
}

/** 1.10 after 1.9; missing parts count as 0. */
function compareVersions(a: string, b: string): number {
  const pa = a.split(/[._]/).map(Number)
  const pb = b.split(/[._]/).map(Number)
  for (let k = 0; k < Math.max(pa.length, pb.length); k++) {
    const d = (pa[k] ?? 0) - (pb[k] ?? 0)
    if (d) return d
  }
  return 0
}

/** Versioned scripts older than `i` that have not run: running `i` alone leaves them behind. */
export function olderNotRun(infos: MigrationInfo[], i: MigrationInfo): MigrationInfo[] {
  if (i.kind !== 'versioned' || i.version === null) return []
  return infos.filter((o) => o.kind === 'versioned' && o !== i && o.version !== null && (o.state === 'pending' || o.state === 'ignored') && compareVersions(o.version, i.version!) < 0)
}
export type Step = { phase: number; order?: number; sql: string }
export type Change = {
  id: string; object_type: string; name: string; kind: 'added' | 'changed' | 'removed'; destructive: boolean
  sql: string; steps: Step[]; undo_steps: Step[]; before: string | null; after: string | null
}
export type CompareResult = { source: string; target: string; engine: string; changes: Change[]; not_compared: string[] }
export type DataKind = 'only_in_source' | 'only_in_target' | 'different'
export type TableResult = { table: string; key: string[]; source_rows: number; target_rows: number; only_in_source: number; only_in_target: number; different: number; skipped?: string; /** no key: whole rows compared */ whole_rows?: boolean; ms: number }
export type DataComparison = { id: string; source: string; target: string; engine: string; tables: TableResult[]; ms: number }
export type RowPage = { columns: string[]; key: string[]; total: number; rows: { key: string[]; source: (string | null)[] | null; target: (string | null)[] | null }[] }
export type SyncWhat = { insert: boolean; update: boolean; delete: boolean }
export type Generated = { file_name: string; version: string; sql: string; undo: { file_name: string; sql: string } | null }
export type Finding = { rule: string; severity: 'info' | 'warn' | 'error'; script: string; line: number; message: string; /** the reason in the script's allow comment */ allowed?: string }
export type LintReport = { scripts: string[]; findings: Finding[]; errors: number; warnings: number }
export type Severity = 'off' | 'info' | 'warn' | 'error'
export type CustomRule = { id: string; pattern: string; message: string; severity: Severity }
/** A built-in rule: what it checks, its default, and how this project runs it */
export type BuiltinRule = { id: string; help: string; engine: Engine | null; default: Severity; needs_pattern: boolean; severity: Severity; pattern: string | null }
export type RulesView = { builtin: BuiltinRule[]; custom: CustomRule[] }
export type RulesConfig = { settings: Record<string, { severity: Severity; pattern?: string }>; custom: CustomRule[] }
export type CheckReport = { environment: string; applied_up_to: string | null; drift: Change[] | null; changes: Change[] | null; dry_run_sql: string | null; rules: LintReport | null; not_compared: string[] }
export type Comparison = { changes: Change[]; not_compared: string[] }
export type LogEvent = { level: 'info' | 'warn'; message: string }
export type ScriptView = { kind: 'versioned' | 'repeatable' | 'undo' | 'baseline'; version: string | null; description: string; file_name: string; sql: string }
export type ConvertReport = { source: string; written: string; environments: string[]; migrations: string; schemas: string[]; flyway_table: string; not_converted: string[]; notes: string[] }
export type HistoryImport = { environment: string; imported: number; skipped: string[]; edited: string[]; attention: string[] }
export type GitStatus = { branch: string | null; upstream: string | null; ahead: number; behind: number; files: { path: string; change: string }[] }
export type ModelChange = { path: string; object_type: string; kind: 'added' | 'changed' | 'removed'; before: string | null; after: string | null }
export type CiPlatform = 'github' | 'azure'
export type CiOptions = { stages: string[]; branch: string; checks: boolean; install: string; model?: 'off' | 'check' | 'generate'; platform?: CiPlatform }
export type ObjectCommit = { sha: string; short: string; author: string; date: string; message: string; path: string; deleted: boolean }
export type RepairReport = { removed_failed: string[]; realigned: string[]; forgotten: string[] }
/** One run against a database, from its activity table. `id` is the deployment id. */
export type Activity = {
  id: string; operation: string; started_on: string; execution_time: number; success: boolean
  installed_by: string; os_user: string; host: string; pipeline: string | null; git_commit: string | null; scripts: string[]; detail: string | null
}
export type EnvironmentOverview = { name: string; role: Role; error: string | null; version: string | null; pending: number; failed: number; activity: Activity[]; migrations: MigrationInfo[] }

/** The bridge electron/preload.ts puts on the window (or the VS Code panel, apps/vscode/src/uiPanel.ts). */
type Bridge = {
  /** set in VS Code, where the panel shows these screens */
  host?: 'vscode'
  /** VS Code: the workspace's project folders, opened as tabs on start */
  projects?: string[]
  /** VS Code: the editor's colour theme, and its changes */
  theme?(): 'light' | 'dark'
  onTheme?(cb: (theme: 'light' | 'dark') => void): () => void
  /** VS Code: a yes/no question in its own dialog (webviews block window.confirm) */
  confirm?(message: string): Promise<boolean>
  invoke(name: string, args?: Record<string, unknown>): Promise<{ ok: true; value: unknown } | { ok: false; error: ErrorReport }>
  pickFolder(): Promise<string | null>
  openFile(filterName: string, extensions: string[]): Promise<string | null>
  saveFile(defaultPath: string, filterName: string, extensions: string[]): Promise<string | null>
  onLog(cb: (e: LogEvent) => void): () => void
  setTheme(theme: 'system' | 'light' | 'dark'): Promise<void>
  update(action: UpdateAction, mode?: UpdateMode): Promise<UpdateInfo | undefined>
  onUpdate(cb: (info: UpdateInfo) => void): () => void
}
const bridge = (window as unknown as { liftoff?: Bridge }).liftoff

/** True inside the desktop app (or the VS Code panel), false in a plain browser. */
export const inDesktop = bridge !== undefined
/** In the VS Code panel: the theme follows the editor, and VS Code updates the extension. */
export const inVsCode = bridge?.host === 'vscode'
/** VS Code: the workspace's project folders, to open on start. */
export const hostProjects = bridge?.projects
/** A yes/no question: the window's confirm, or VS Code's own dialog in the panel, where confirm is blocked. */
export const ask = (message: string): Promise<boolean> => (bridge?.confirm ? bridge.confirm(message) : Promise.resolve(window.confirm(message)))

/** VS Code: applies the editor's theme now and whenever it changes. */
export function followHostTheme(apply: (theme: 'light' | 'dark') => void): void {
  if (!bridge?.theme || !bridge.onTheme) return
  apply(bridge.theme())
  bridge.onTheme(apply)
}

/** The window frame follows the app's theme; a browser has none to change. */
export const setNativeTheme = (theme: 'system' | 'light' | 'dark') => void bridge?.setTheme(theme)

/* ---------- updates of the app itself (electron/updates.ts) ---------- */

export type UpdateMode = 'notify' | 'auto' | 'off'
export type UpdateState =
  | { state: 'idle' }
  | { state: 'checking' }
  | { state: 'latest'; version: string }
  | { state: 'available'; version: string; page: string }
  | { state: 'manual'; version: string; page: string }
  | { state: 'downloading'; version: string; percent: number }
  | { state: 'ready'; version: string }
  | { state: 'failed'; message: string }
export type LatestRelease = { version: string; page: string; notes: string; published: string | null }
export type UpdateInfo = { mode: UpdateMode; current: string; status: UpdateState; updated?: string; latest?: LatestRelease }
type UpdateAction = 'info' | 'mode' | 'check' | 'download' | 'install' | 'page' | 'notes'

/** The browser preview pretends: ?update=available, ready or updated shows that state. */
const fakeUpdate = (() => {
  let info: UpdateInfo = { mode: 'auto', current: '0.1.0', status: { state: 'idle' } }
  const shown = new URLSearchParams(location.search).get('update')
  const latest: LatestRelease = {
    version: '0.2.0', page: 'https://github.com/sanderstad/liftoff/releases/tag/v0.2.0', published: '2026-11-02T09:00:00Z',
    notes: `## What's Changed
* Schema model files are named <type>/<schema>.<name>.sql
* The desktop app updates itself

**Full Changelog**: v0.1.0...v0.2.0`,
  }
  if (shown === 'available') info = { ...info, latest, status: { state: 'available', version: '0.2.0', page: latest.page } }
  if (shown === 'ready') info.status = { state: 'ready', version: '0.2.0' }
  if (shown === 'updated') info = { ...info, current: '0.2.0', updated: '0.2.0' }
  const listeners = new Set<(i: UpdateInfo) => void>()
  const set = (status: UpdateState) => {
    info = { ...info, status }
    for (const l of listeners) l(info)
    return info
  }
  return {
    async update(action: UpdateAction, mode?: UpdateMode): Promise<UpdateInfo | undefined> {
      if (action === 'mode' && mode) {
        info = { ...info, mode }
        return set(info.status)
      }
      if (action === 'notes') {
        info = { ...info, updated: undefined }
        return set(info.status)
      }
      if (action === 'check') {
        if (!info.latest) {
          const page = `https://github.com/sanderstad/liftoff/releases/tag/v${info.current}`
          info = { ...info, latest: { version: info.current, page, published: '2026-10-13T07:10:55Z', notes: `## What's Changed
* The first release` } }
        }
        return set(info.status.state === 'available' ? info.status : { state: 'latest', version: info.current })
      }
      if (action === 'download' && info.status.state === 'available') {
        const version = info.status.version
        for (const percent of [30, 70]) setTimeout(() => set({ state: 'downloading', version, percent }), percent * 5)
        setTimeout(() => set({ state: 'ready', version }), 500)
      }
      return info
    },
    onUpdate(cb: (i: UpdateInfo) => void) {
      listeners.add(cb)
      return () => void listeners.delete(cb)
    },
  }
})()

export const updates = {
  info: () => (bridge ?? fakeUpdate).update('info') as Promise<UpdateInfo>,
  setMode: (mode: UpdateMode) => (bridge ?? fakeUpdate).update('mode', mode) as Promise<UpdateInfo>,
  check: () => (bridge ?? fakeUpdate).update('check') as Promise<UpdateInfo>,
  download: () => (bridge ?? fakeUpdate).update('download') as Promise<UpdateInfo>,
  install: () => (bridge ?? fakeUpdate).update('install'),
  openPage: () => (bridge ?? fakeUpdate).update('page'),
  openNotes: () => (bridge ?? fakeUpdate).update('notes'),
  onChange: (cb: (info: UpdateInfo) => void) => (bridge ?? fakeUpdate).onUpdate(cb),
}

/** Calls a command; a failure rejects with its ErrorReport (code, exit_code, message). */
async function invoke<T>(name: string, args?: Record<string, unknown>): Promise<T> {
  const r = await bridge!.invoke(name, args)
  if (!r.ok) throw r.error
  return r.value as T
}

export const isErrorReport = (e: unknown): e is ErrorReport => typeof e === 'object' && e !== null && 'message' in e && 'code' in e
export const errorText = (e: unknown) => (isErrorReport(e) ? e.message : String(e))

type Api = {
  recentProjects(): Promise<Recent[]>
  recentForget(path: string): Promise<void>
  pickFolder(): Promise<string | null>
  projectInit(path: string, name: string, engine: Engine): Promise<Project>
  projectOpen(path: string): Promise<Project>
  convertFlyway(path: string): Promise<{ report: ConvertReport; project: Project }>
  historyImport(path: string, env: string, table: string, acceptEdited: boolean): Promise<HistoryImport>
  envSave(path: string, name: string, env: EnvInput, shared: boolean): Promise<Project>
  /** Lists the environments in this order (writes `order` in their files). */
  envOrder(path: string, names: string[]): Promise<Project>
  envTest(path: string, name: string): Promise<ServerInfo>
  /** `path` and `name` when editing a saved environment: its saved password and URL fill the gaps */
  envTestDraft(env: EnvInput, path?: string, name?: string): Promise<ServerInfo>
  migrationsInfo(path: string, env: string): Promise<MigrationInfo[]>
  /** Every environment but scratch: its state and latest runs (one that cannot be read has `error`) */
  overview(path: string): Promise<EnvironmentOverview[]>
  /** `only`: run these scripts and nothing else (a cherry-pick) */
  migrate(path: string, env: string, outOfOrder: boolean, allowNonEmpty?: boolean, only?: string[], acceptDifferences?: boolean): Promise<MigrateResult>
  adopt(path: string, env: string): Promise<{ environment: string; baseline: string; version: string; objects: number }>
  saveReport(path: string, report: CheckReport): Promise<string | null>
  modelStatus(path: string): Promise<ModelChange[]>
  modelSave(path: string, changes: ModelChange[]): Promise<number>
  modelFiles(path: string): Promise<string[]>
  objectHistory(path: string, file: string): Promise<ObjectCommit[]>
  objectAt(path: string, sha: string, file: string): Promise<string>
  sampleCreate(folder: string): Promise<Project>
  projectSave(path: string, project: ProjectSettings): Promise<Project>
  ciWorkflow(path: string, options: CiOptions): Promise<string>
  ciWrite(path: string, yaml: string, overwrite: boolean, platform: CiPlatform): Promise<string>
  gitStatus(path: string): Promise<GitStatus>
  gitDiff(path: string, file: string): Promise<string>
  gitCommit(path: string, files: string[], message: string): Promise<string>
  gitPush(path: string): Promise<void>
  gitPull(path: string): Promise<void>
  validate(path: string, env: string): Promise<MigrationInfo[]>
  baseline(path: string, env: string, version: string, description: string): Promise<void>
  repair(path: string, env: string): Promise<RepairReport>
  clean(path: string, env: string): Promise<string[]>
  markApplied(path: string, env: string, script: string): Promise<void>
  /** Records a new script on dev when dev already has these changes; returns the scripts recorded. */
  recordWhereThere(path: string, script: string, changed: string[]): Promise<string[]>
  scriptsList(path: string): Promise<ScriptView[]>
  scriptAdd(path: string, repeatable: boolean, description: string, sql: string): Promise<string>
  capture(path: string, env: string, description: string, asBaseline: boolean): Promise<Generated>
  squash(path: string, upTo: string, description: string): Promise<string>
  /** squash, then take the old scripts out of the migrations folder: deleted (git keeps them) or moved to `archive` */
  rebaseline(path: string, upTo: string, description: string, archive?: string, restart?: boolean): Promise<{ baseline: string; version: string; removed: string[]; archived_to: string | null }>
  scratchCreate(path: string): Promise<Project>
  changesDiff(path: string): Promise<Comparison>
  migrationGenerate(path: string, changes: Change[], description: string, withUndo: boolean): Promise<Generated>
  undo(path: string, env: string): Promise<{ script: string; version: string | null }>
  check(path: string, env: string, opts: { drift: boolean; changes: boolean; dryRun: boolean; rules: boolean }): Promise<CheckReport>
  migrationSave(path: string, fileName: string, sql: string): Promise<string>
  /** Compare two sides: an environment name, a database URL, 'model', 'migrations' or 'snapshot:<file>' */
  compareRun(path: string, source: string, target: string): Promise<CompareResult>
  compareScript(sourceLabel: string, targetLabel: string, changes: Change[]): Promise<string>
  compareApply(path: string, target: string, script: string): Promise<{ target: string; transactional: boolean }>
  snapshotSave(path: string, of: string, file: string): Promise<{ file: string; objects: number }>
  /** Picks a snapshot file to compare with; null when cancelled */
  pickSnapshot(): Promise<string | null>
  /** Asks where to save the sync script and writes it there; the path, or null when cancelled */
  saveScript(defaultName: string, text: string): Promise<string | null>
  /** Asks where to save a snapshot; the path, or null when cancelled */
  pickSnapshotTarget(defaultName: string): Promise<string | null>
  /** Data compare: two databases (an environment name or a URL); the comparison stays open for paging */
  dataOpen(path: string, source: string, target: string): Promise<DataComparison>
  dataPage(id: string, table: string, kind: DataKind, offset: number, limit: number): Promise<RowPage>
  /** Asks where to save the sync script and writes it there; the path, or null when cancelled */
  dataScript(id: string, defaultName: string, tables: string[], what: SyncWhat): Promise<string | null>
  dataApply(id: string, tables: string[], what: SyncWhat): Promise<{ statements: number }>
  dataClose(): Promise<void>
  onLog(cb: (e: LogEvent) => void): Promise<() => void>
  rulesGet(path: string): Promise<RulesView>
  /** Writes [rules] in liftoff.toml (refused when a pattern is missing or not a regular expression) */
  rulesSave(path: string, rules: RulesConfig): Promise<RulesView>
  /** The rules on every versioned and repeatable script */
  lint(path: string): Promise<LintReport>
}

const real: Api = {
  recentProjects: () => invoke('recent_projects'),
  recentForget: (path) => invoke('recent_forget', { path }),
  pickFolder: () => bridge!.pickFolder(),
  projectInit: (path, name, engine) => invoke('project_init', { path, name, engine }),
  projectOpen: (path) => invoke('project_open', { path }),
  convertFlyway: (path) => invoke('project_convert_flyway', { path }),
  historyImport: (path, env, table, acceptEdited) => invoke('history_import', { path, env, table, acceptEdited }),
  envSave: (path, name, env, shared) => invoke('env_save', { path, name, env, shared }),
  envOrder: (path, names) => invoke('env_order', { path, names }),
  envTest: (path, name) => invoke('env_test', { path, name }),
  envTestDraft: (env, path, name) => invoke('env_test_draft', { env, path, name }),
  migrationsInfo: (path, env) => invoke('migrations_info', { path, env }),
  overview: (path) => invoke('overview', { path }),
  migrate: (path, env, outOfOrder, allowNonEmpty = false, only, acceptDifferences = false) => invoke('migrate', { path, env, outOfOrder, allowNonEmpty, only, acceptDifferences }),
  adopt: (path, env) => invoke('adopt', { path, env }),
  modelStatus: (path) => invoke('model_status', { path }),
  modelSave: (path, changes) => invoke('model_save', { path, changes }),
  modelFiles: (path) => invoke('model_files', { path }),
  objectHistory: (path, file) => invoke('object_history', { path, file }),
  objectAt: (path, sha, file) => invoke('object_at', { path, sha, file }),
  sampleCreate: (folder) => invoke('sample_create', { folder }),
  projectSave: (path, project) => invoke('project_save', { path, project }),
  ciWorkflow: (path, options) => invoke('ci_workflow', { path, options }),
  ciWrite: (path, yaml, overwrite, platform) => invoke('ci_write', { path, yaml, overwrite, platform }),
  gitStatus: (path) => invoke('git_status', { path }),
  gitDiff: (path, file) => invoke('git_diff', { path, file }),
  gitCommit: (path, files, message) => invoke('git_commit', { path, files, message }),
  gitPush: (path) => invoke('git_push', { path }),
  gitPull: (path) => invoke('git_pull', { path }),
  saveReport: async (path, report) => {
    const file = await bridge!.saveFile(`liftoff-checks-${report.environment}.html`, 'HTML report', ['html'])
    if (!file) return null
    await invoke('report_save', { path, report, file })
    return file
  },
  validate: (path, env) => invoke('validate', { path, env }),
  baseline: (path, env, version, description) => invoke('baseline', { path, env, version, description }),
  repair: (path, env) => invoke('repair', { path, env }),
  clean: (path, env) => invoke('clean', { path, env }),
  markApplied: (path, env, script) => invoke('mark_applied', { path, env, script }),
  recordWhereThere: (path, script, changed) => invoke('migration_record_where_there', { path, script, changed }),
  scriptsList: (path) => invoke('scripts_list', { path }),
  scriptAdd: (path, repeatable, description, sql) => invoke('script_add', { path, repeatable, description, sql }),
  capture: (path, env, description, asBaseline) => invoke('capture', { path, env, description, asBaseline }),
  squash: (path, upTo, description) => invoke('squash', { path, upTo, description }),
  rebaseline: (path, upTo, description, archive, restart) => invoke('rebaseline', { path, upTo, description, archive, restart }),
  scratchCreate: (path) => invoke('scratch_create', { path }),
  changesDiff: (path) => invoke('changes_diff', { path }),
  migrationGenerate: (path, changes, description, withUndo) => invoke('migration_generate', { path, changes, description, withUndo }),
  undo: (path, env) => invoke('undo', { path, env }),
  check: (path, env, o) => invoke('check', { path, env, drift: o.drift, changes: o.changes, dryRun: o.dryRun, rules: o.rules }),
  migrationSave: (path, fileName, sql) => invoke('migration_save', { path, fileName, sql }),
  compareRun: (path, source, target) => invoke('compare_run', { path, source, target }),
  compareScript: (sourceLabel, targetLabel, changes) => invoke('compare_script', { sourceLabel, targetLabel, changes }),
  compareApply: (path, target, script) => invoke('compare_apply', { path, target, script }),
  snapshotSave: (path, of, file) => invoke('snapshot_save', { path, of, file }),
  pickSnapshot: () => bridge!.openFile('LiftOff snapshot', ['json']),
  saveScript: async (defaultName, text) => {
    const file = await bridge!.saveFile(defaultName, 'SQL script', ['sql'])
    if (file) await invoke('text_save', { file, text })
    return file
  },
  pickSnapshotTarget: (defaultName) => bridge!.saveFile(defaultName, 'LiftOff snapshot', ['json']),
  dataOpen: (path, source, target) => invoke('data_open', { path, source, target }),
  dataPage: (id, table, kind, offset, limit) => invoke('data_page', { id, table, kind, offset, limit }),
  dataScript: async (id, defaultName, tables, what) => {
    const file = await bridge!.saveFile(defaultName, 'SQL script', ['sql'])
    return file ? invoke('data_script', { id, file, tables, what }) : null
  },
  dataApply: (id, tables, what) => invoke('data_apply', { id, tables, what }),
  dataClose: () => invoke('data_close', {}),
  onLog: async (cb) => bridge!.onLog(cb),
  rulesGet: (path) => invoke('rules_get', { path }),
  rulesSave: (path, rules) => invoke('rules_save', { path, rules }),
  lint: (path) => invoke('lint', { path }),
}

/* ---------- fake: seeded, in memory, same behaviour shape ---------- */

const wait = (ms = 250) => new Promise((r) => setTimeout(r, ms))
const fail = (code: string, message: string, exit_code = 1): ErrorReport => ({ code, message, exit_code })
const logListeners = new Set<(e: LogEvent) => void>()
const emit = (level: LogEvent['level'], message: string) => logListeners.forEach((l) => l({ level, message }))

const fake = {
  project: {
    root: 'C:/repos/shop-db', name: 'shop-db', engine: 'postgresql', schemas: ['public'], migrations: 'migrations', history_table: 'liftoff_schema_history', filters: [], lock: 'advisory' as LockMode, has_scripts: true, notes: [],
    environments: [
      { name: 'local', role: 'dev', url: 'postgres://me@localhost:5432/shop', user: null, has_password: true, allow_clean: false, shared: true },
      { name: 'staging', role: 'test', url: 'postgres://deploy@staging.internal:5432/shop', user: null, has_password: true, allow_clean: false, shared: true },
      { name: 'production', role: 'prod', url: 'postgres://deploy@prod.internal:5432/shop', user: null, has_password: true, allow_clean: false, shared: true },
      { name: 'scratch', role: 'scratch', url: 'postgres://me@localhost:5432/shop_scratch', user: null, has_password: true, allow_clean: false, shared: true },
    ],
  } as Project,
  scripts: [
    ['20261001.0912', 'create orders'], ['20261003.1530', 'add order lines'], ['20261007.1102', 'tax function'], ['20261008.0840', 'daily totals view'],
  ] as [string, string][],
  applied: { local: 4, scratch: 0, staging: 2, production: 0 } as Record<string, number>,
  gitFiles: [
    { path: 'migrations/V20261008.1104__add_customers.sql', change: 'untracked' },
    { path: 'liftoff.toml', change: 'modified' },
    { path: 'notes/todo.md', change: 'untracked' },
  ],
  gitAhead: 0,
  modelChanges: [
    { path: 'tables/public.orders.sql', object_type: 'tables', kind: 'changed', before: 'CREATE TABLE public.orders (\n    id bigserial,\n    note text\n);\n', after: 'CREATE TABLE public.orders (\n    id bigserial,\n    note text,\n    paid_at timestamp with time zone\n);\n' },
    { path: 'tables/public.customer.sql', object_type: 'tables', kind: 'added', before: null, after: 'CREATE TABLE public.customer (\n    id bigint NOT NULL\n);\n' },
  ] as ModelChange[],
  activity: [] as (Activity & { environment: string })[],
  gitRejectPush: new URLSearchParams(location.search).has('rejectpush'),
  notGit: new URLSearchParams(location.search).has('nogit'),
}
const fakeProject = (): Project => ({ ...fake.project, has_scripts: !new URLSearchParams(location.search).has('noscripts'), notes: new URLSearchParams(location.search).has('nearlimit') ? ['the scripts have reached version 9991; rebaseline with a restart (liftoff rebaseline --restart) so the numbering starts again at 0001'] : [] })
const fakeSample = (folder: string): Project => ({ ...fakeProject(), root: `${folder}/liftoff-sample`, name: 'shop-sample', environments: [] })
const fakeInfo = (env: string): MigrationInfo[] => [
  ...fake.scripts.map(([version, description], i): MigrationInfo => {
    const done = i < (fake.applied[env] ?? 0)
    return {
      kind: 'versioned', version, description, script: `V${version}__${description.replaceAll(' ', '_')}.sql`,
      state: done ? 'applied' : 'pending', installed_on: done ? `2026-10-0${i + 1}T09:1${i}:00Z` : null,
      execution_time_ms: done ? 40 + i * 37 : null, checksum_mismatch: false,
      ...(description.includes('tax') && { topics: ['JIRA-142'] }),
    }
  }),
  // Test fixtures (-- liftoff:for test): listed on the dev database as not for it.
  ...(env === 'local'
    ? [{ kind: 'repeatable', version: null, description: 'test fixtures', script: 'R__test_fixtures.sql', for: 'test', state: 'excluded', installed_on: null, execution_time_ms: null, checksum_mismatch: false } satisfies MigrationInfo]
    : []),
]

const fakeRun = (environment: string, operation: string, started_on: string, scripts: string[], o: { by: string; from: string; pipeline?: string; failed?: string }): Activity & { environment: string } => ({
  environment, id: crypto.randomUUID(), operation, started_on, execution_time: 400 + scripts.length * 120, success: !o.failed,
  installed_by: o.by, os_user: o.from.split('@')[0], host: o.from.split('@')[1], pipeline: o.pipeline ?? null,
  git_commit: o.pipeline ? '3e591d5c0a8f41d2b7e6a9c4f1d0b2e8a7c6d5e4' : null, scripts, detail: o.failed ?? null,
})
const ago = (hours: number) => new Date(Date.now() - hours * 3_600_000).toISOString()
const ci = 'https://github.com/acme/shop-db/actions/runs/11873'
fake.activity.push(
  fakeRun('staging', 'migrate', ago(3), ['V20261003.1530__add_order_lines.sql'], { by: 'deploy', from: 'runner@gh-7f2c', pipeline: ci }),
  fakeRun('staging', 'migrate', ago(4), ['V20261007.1102__tax_function.sql'], { by: 'deploy', from: 'runner@gh-7f2c', pipeline: ci, failed: 'V20261007.1102__tax_function.sql failed: function round(double precision, integer) does not exist' }),
  fakeRun('local', 'migrate', ago(26), ['V20261007.1102__tax_function.sql', 'V20261008.0840__daily_totals_view.sql'], { by: 'me', from: 'me@LAPTOP-7' }),
  fakeRun('staging', 'migrate', ago(50), ['V20261001.0912__create_orders.sql'], { by: 'deploy', from: 'runner@gh-7f2c', pipeline: ci }),
  fakeRun('local', 'mark-applied', ago(75), ['V20261003.1530__add_order_lines.sql'], { by: 'me', from: 'me@LAPTOP-7' }),
)

const fakeRules: RulesView = {
  builtin: ([
    ['drop-table', 'Drops a table', 'warn'], ['drop-column', 'Drops a column', 'warn'], ['truncate', 'Empties a table', 'warn'],
    ['delete-without-where', 'DELETE without WHERE removes every row', 'error'], ['update-without-where', 'UPDATE without WHERE changes every row', 'error'],
    ['table-without-primary-key', 'A new table without a primary key', 'warn'], ['grant-to-public', 'Grants to PUBLIC', 'warn'],
  ] as const).map(([id, help, d]) => ({ id, help, engine: null, default: d, needs_pattern: false, severity: d, pattern: null }) as BuiltinRule)
    .concat([{ id: 'table-names', help: 'New table names must match a pattern (set pattern = "regex")', engine: null, default: 'off', needs_pattern: true, severity: 'off', pattern: null },
      { id: 'use-database', help: 'USE switches database inside a script', engine: 'sqlserver', default: 'warn', needs_pattern: false, severity: 'warn', pattern: null }]),
  custom: [{ id: 'no-cascade', pattern: '\\bCASCADE\\b', message: 'Drop with CASCADE takes dependent objects along', severity: 'error' }],
}

const fakeApi: Api = {
  rulesGet: async () => {
    await wait(150)
    return structuredClone(fakeRules)
  },
  rulesSave: async (_p, r) => {
    await wait(200)
    for (const b of fakeRules.builtin) {
      b.severity = r.settings[b.id]?.severity ?? b.default
      b.pattern = r.settings[b.id]?.pattern ?? null
      if (b.needs_pattern && b.severity !== 'off' && !b.pattern) throw fail('LIFTOFF_CONFIG', `[rules.${b.id}]: needs a pattern, e.g. pattern = "^[a-z][a-z0-9_]*$"`, 2)
    }
    fakeRules.custom = r.custom
    return structuredClone(fakeRules)
  },
  lint: async () => {
    await wait(300)
    return {
      scripts: fakeInfo('local').filter((i) => i.kind === 'versioned').map((i) => i.script),
      findings: [
        { rule: 'table-without-primary-key', severity: 'warn', script: 'V20261007.1102__tax_function.sql', line: 3, message: 'table tax_rates has no primary key' },
        { rule: 'drop-column', severity: 'warn', script: 'V20261007.1102__tax_function.sql', line: 9, message: 'drops column legacy_rate of orders', allowed: 'moved to tax_rates in the previous release' },
      ],
      errors: 0, warnings: 1,
    }
  },
  overview: async (path) => {
    await wait()
    if (path.includes('flyway')) throw fail('LIFTOFF_FLYWAY_PROJECT', 'This folder has a Flyway project. Convert its settings to open it in LiftOff.', 2)
    return fake.project.environments.filter((e) => e.role !== 'scratch').map((e): EnvironmentOverview => {
      if (e.name === 'production') return { name: e.name, role: e.role, error: "could not connect to 'production': timed out", version: null, pending: 0, failed: 0, activity: [], migrations: [] }
      const migrations = fakeInfo(e.name)
      return {
        name: e.name, role: e.role, error: null, version: migrations.filter((i) => i.state === 'applied').at(-1)?.version ?? null,
        pending: migrations.filter((i) => i.state === 'pending').length, failed: 0, migrations,
        activity: fake.activity.filter((a) => a.environment === e.name).map(({ environment: _, ...a }) => a),
      }
    })
  },
  recentProjects: async () => [
    { name: 'shop-db', path: 'C:/repos/shop-db', exists: true },
    { name: 'legacy-flyway', path: 'C:/repos/legacy-flyway', exists: true },
    { name: 'billing', path: 'C:/old/billing', exists: false },
  ],
  recentForget: async () => {},
  pickFolder: async () => 'C:/repos/new-project',
  compareRun: async (p, source, target) => {
    await wait(300)
    const label = (side: string) => (side === 'model' ? 'the schema model' : side === 'migrations' ? 'the migrations' : side.startsWith('snapshot:') ? `snapshot ${side.split(/[\\/]/).pop()}` : side)
    if (source === target) throw fail('LIFTOFF_CONFIG', 'the source and the target are the same', 2)
    const d = await fakeApi.changesDiff(p)
    return { source: label(source), target: label(target), engine: 'PostgreSQL', changes: d.changes, not_compared: d.not_compared }
  },
  compareScript: async (s, t, changes) => `-- Makes ${t} match ${s}\n-- Written by LiftOff. Review before running.\n\n${changes.map((c) => c.sql).join('\n')}\n`,
  compareApply: async (_p, target) => {
    await wait(300)
    emit('info', `Applying the differences to ${target} in one transaction`)
    return { target, transactional: true }
  },
  snapshotSave: async (_p, of, file) => {
    await wait(200)
    return { file, objects: 12 + of.length }
  },
  pickSnapshot: async () => 'C:/repos/shop-db/snapshots/production-2026-10-01.json',
  saveScript: async (name) => `C:/Users/me/${name}`,
  pickSnapshotTarget: async (name) => `C:/repos/shop-db/snapshots/${name}`,
  dataOpen: async (_p, source, target) => {
    await wait(300)
    if (source === target) throw fail('LIFTOFF_CONFIG', 'the source and the target are the same', 2)
    const t = (table: string, s: number, o: number, d: number, rows: number, skipped?: string, wholeRows?: boolean) =>
      ({ table, key: skipped || wholeRows ? [] : ['id'], source_rows: rows + s, target_rows: rows + o, only_in_source: s, only_in_target: o, different: d, skipped, ...(wholeRows && { whole_rows: true }), ms: 40 })
    return { id: '1', source, target, engine: 'PostgreSQL', ms: 1840, tables: [t('public.archive', 0, 0, 0, 0, 'only in the target; compare the schemas first'), t('public.audit_log', 3, 2, 0, 8_120, undefined, true), t('public.customers', 0, 0, 0, 52_310), t('public.orders', 2, 1, 132, 1_204_551)] }
  },
  dataPage: async (_id, table, kind, offset, limit) => {
    await wait(100)
    const total = kind === 'different' ? 132 : kind === 'only_in_source' ? 2 : 1
    const n = Math.max(0, Math.min(limit, total - offset))
    const row = (i: number, note: string | null, total_: string) => [String(i), `customer ${i % 50}`, total_, note]
    return {
      columns: ['id', 'customer', 'total', 'note'], key: ['id'], total,
      rows: Array.from({ length: n }, (_, j) => {
        const i = 1000 + offset + j
        if (kind === 'only_in_source') return { key: [String(i)], source: row(i, 'new', '10.00'), target: null }
        if (kind === 'only_in_target') return { key: [String(i)], source: null, target: row(i, 'stale', '9.00') }
        return { key: [String(i)], source: row(i, j % 3 === 0 ? null : 'paid', '12.50'), target: row(i, j % 3 === 0 ? '' : 'paid', j % 2 ? '12.51' : '12.50') }
      }).filter(() => table === 'public.orders'),
    }
  },
  dataScript: async (_id, name) => `C:/Users/me/${name}`,
  dataApply: async () => {
    await wait(300)
    emit('info', 'Applied 135 statement(s)')
    return { statements: 135 }
  },
  dataClose: async () => {},
  projectInit: async (path, name, engine) => ({ ...fakeProject(), root: path, name, engine, schemas: [engine === 'sqlserver' ? 'dbo' : 'public'], environments: [] }),
  projectOpen: async (path) => {
    await wait()
    if (path.includes('old')) throw fail('LIFTOFF_CONFIG', `no liftoff.toml in ${path}; run \`liftoff init\` first`, 2)
    if (path.includes('flyway')) throw fail('LIFTOFF_FLYWAY_PROJECT', 'This folder has a Flyway project. Convert its settings to open it in LiftOff.', 2)
    if (path.endsWith('/liftoff-sample')) return fakeSample(path.slice(0, -'/liftoff-sample'.length))
    return fakeProject()
  },
  convertFlyway: async (path) => {
    await wait()
    const report: ConvertReport = { source: `${path}/flyway.toml`, written: `${path}/liftoff.toml`, environments: ['development', 'shadow', 'production'], migrations: 'migrations', schemas: ['public'], flyway_table: 'flyway_schema_history',
      not_converted: ['placeholders.owner = app: placeholders are not supported; replace them in the scripts', 'callbacks = com.acme.Audit: callbacks are not supported; turn them into scripts'], notes: [] }
    return { report, project: { ...fakeProject(), root: path, name: 'legacy-flyway' } }
  },
  historyImport: async (_p, env) => {
    await wait(400)
    emit('info', `Imported 4 history row(s) on ${env}; Flyway's table was left as it was`)
    return { environment: env, imported: 4, skipped: ['rank 0: "public" (schema creation marker)'], edited: [], attention: [] }
  },
  envSave: async () => fakeProject(),
  envOrder: async (_path, names) => {
    const all = fake.project.environments
    fake.project.environments = [...names.map((n) => all.find((e) => e.name === n)!), ...all.filter((e) => !names.includes(e.name))]
    return fakeProject()
  },
  envTest: async (_p, name) => {
    await wait(400)
    if (name === 'production') throw fail('LIFTOFF_CONNECT', "could not connect to 'production': timed out", 10)
    return { version: '16.4', user: 'me', database: 'shop' }
  },
  envTestDraft: async (env) => {
    await wait(400)
    if (!env.url.startsWith('postgres')) throw fail('LIFTOFF_CONNECT', 'could not connect: bad url', 10)
    return { version: '16.4', user: env.user ?? 'me', database: 'shop' }
  },
  migrationsInfo: async (_p, env) => {
    await wait()
    if (env === 'production') throw fail('LIFTOFF_CONNECT', "could not connect to 'production': timed out", 10)
    return fakeInfo(env)
  },
  modelFiles: async () => {
    await wait()
    return ['functions/public.tax(amount numeric).sql', 'tables/public.customer.sql', 'tables/public.orders.sql', 'views/public.order_totals.sql']
  },
  objectHistory: async (_p, file) => {
    await wait()
    if (fake.notGit) throw fail('LIFTOFF_GIT_NOT_A_REPOSITORY', 'fatal: not a git repository (or any of the parent directories): .git', 1)
    if (file.includes('tax')) return []
    const f = `schema-model/${file}`
    return [
      { sha: 'c3', short: 'c3d4e5f', author: 'Ana Ruiz', date: '2026-10-07T15:20:00+02:00', message: 'Track when orders are paid', path: f, deleted: false },
      { sha: 'b2', short: 'b2c3d4e', author: 'Sam Okafor', date: '2026-10-03T09:12:00+02:00', message: 'Notes are required', path: f, deleted: false },
      { sha: 'a1', short: 'a1b2c3d', author: 'Ana Ruiz', date: '2026-09-28T11:02:00+02:00', message: 'First schema model', path: f, deleted: false },
    ]
  },
  objectAt: async (_p, sha) => {
    const cols: Record<string, string> = { a1: '    note text', b2: '    note text NOT NULL', c3: '    note text NOT NULL,\n    paid_at timestamp with time zone' }
    return `CREATE TABLE public.orders (\n    id bigserial,\n${cols[sha] ?? ''}\n);\n`
  },
  sampleCreate: async (folder) => {
    await wait(300)
    return fakeSample(folder)
  },
  modelStatus: async () => {
    await wait(300)
    return fake.modelChanges
  },
  modelSave: async (_p, changes) => {
    fake.modelChanges = fake.modelChanges.filter((c) => !changes.some((x) => x.path === c.path))
    return changes.length
  },
  projectSave: async (_p, s) => {
    if (!s.name.trim()) throw fail('LIFTOFF_CONFIG', 'a project needs a name', 2)
    fake.project = { ...fake.project, ...s }
    return fakeProject()
  },
  ciWorkflow: async (_p, o) => o.platform === 'azure'
    ? `# Written by LiftOff.\ntrigger:\n  branches:\n    include: ['${o.branch}']\nstages:\n` + o.stages.map((s, i) => `- stage: migrate_${s}\n  dependsOn: ${i ? `migrate_${o.stages[i - 1]}` : '[]'}\n  jobs:\n  - deployment: migrate\n    environment: '${s}'\n`).join('')
    : `# Written by LiftOff.\nname: Database migrations\non:\n  push:\n    branches: ['${o.branch}']\njobs:\n` + o.stages.map((s, i) => `  ${s}:\n    runs-on: ubuntu-latest\n${i ? `    needs: ${o.stages[i - 1]}\n` : ''}    steps:\n      - run: liftoff --environment '${s}' migrate\n`).join(''),
  ciWrite: async (path, _yaml, _overwrite, platform) => `${path}/${platform === 'azure' ? 'azure-pipelines.yml' : '.github/workflows/liftoff.yml'}`,
  gitStatus: async () => {
    await wait()
    return { branch: 'main', upstream: 'origin/main', ahead: fake.gitAhead, behind: 0, files: fake.gitFiles }
  },
  gitDiff: async (_p, file) => (file.endsWith('.sql') ? `-- ${file}\ncreate table customer (id bigint primary key);\n` : '+ [environments.staging]\n+ url = "postgres://staging.internal/shop"\n'),
  gitCommit: async (_p, files, message) => {
    if (!message.trim()) throw fail('LIFTOFF_CONFIG', 'write a commit message', 2)
    fake.gitFiles = fake.gitFiles.filter((f) => !files.includes(f.path))
    fake.gitAhead += 1
    return 'a1b2c3d'
  },
  gitPush: async () => {
    await wait()
    if (fake.gitRejectPush) throw fail('LIFTOFF_GIT_PUSH_REJECTED', '! [rejected] main -> main (fetch first)', 1)
    fake.gitAhead = 0
  },
  gitPull: async () => {
    await wait()
    fake.gitRejectPush = false
  },
  saveReport: async (_p, report) => `C:/Users/me/liftoff-checks-${report.environment}.html`,
  migrate: async (_p, env, _o, _a, only, acceptDifferences) => {
    // ?noscripts: production has tables but the project has no scripts (adopt it).
    // ?differs: staging has objects that differ from the baseline script.
    const flags = new URLSearchParams(location.search)
    if (flags.has('noscripts') && env === 'production') throw fail('LIFTOFF_NOT_BASELINED', `'${env}' already has tables but no migration history`, 12)
    if (flags.has('differs') && env === 'staging') {
      await wait(300)
      if (!acceptDifferences) {
        throw { ...fail('LIFTOFF_BASELINE_DIFFERS', `'${env}' has objects that differ from B0001__existing_schema.sql`, 12), differences: [{ id: 'table:public.orders', kind: 'changed', destructive: false }] }
      }
      return { environment: env, applied: [{ script: 'B0001__existing_schema.sql', version: '0001', execution_time_ms: 300, transactional: true }], execution_time_ms: 300, baseline_check: { script: 'B0001__existing_schema.sql', created: ['view:public.daily_totals'], accepted: ['table:public.orders'], restart: false } }
    }
    if (only) {
      // The preview keeps state as "the first n ran"; a cherry-pick only shows its log and result.
      const infos = fakeInfo(env)
      const picked = infos.filter((i) => only.includes(i.script))
      for (const p of picked) emit('info', `Applied ${p.script} in 48 ms`)
      const behind = picked.flatMap((p) => olderNotRun(infos, p)).filter((i) => !picked.includes(i)).map((i) => i.script)
      return { environment: env, applied: picked.map((p) => ({ script: p.script, version: p.version, execution_time_ms: 48, transactional: true })), execution_time_ms: 48, left_behind: [...new Set(behind)] }
    }
    const pending = fakeInfo(env).filter((i) => i.state === 'pending')
    emit('info', `Connected to ${env} (shop as me, PostgreSQL 16.4)`)
    for (const p of pending) {
      emit('info', `Running ${p.script}`)
      await wait(300)
      emit('info', `Applied ${p.script} in 52 ms`)
    }
    if (!pending.length) emit('info', `${env} is up to date`)
    fake.applied[env] = fake.scripts.length
    if (pending.length) fake.activity.unshift(fakeRun(env, 'migrate', new Date().toISOString(), pending.map((p) => p.script), { by: 'me', from: 'me@LAPTOP-7' }))
    return { environment: env, applied: pending.map((p) => ({ script: p.script, version: p.version, execution_time_ms: 52, transactional: true })), execution_time_ms: 300 * pending.length }
  },
  validate: async (_p, env) => {
    await wait()
    if (env === 'staging') throw fail('LIFTOFF_VALIDATE', 'V20261003.1530__add_order_lines.sql changed after it was applied (checksum mismatch)', 12)
    return fakeInfo(env)
  },
  baseline: async (_p, env, version) => {
    await wait()
    emit('info', `${env} is now at baseline ${version}`)
  },
  repair: async () => {
    await wait()
    emit('info', 'Repair: 0 failed row(s) removed, 1 checksum(s) updated, 0 missing script(s) forgotten')
    return { removed_failed: [], realigned: ['V20261003.1530__add_order_lines.sql'], forgotten: [] }
  },
  clean: async (_p, env) => {
    await wait()
    fake.applied[env] = 0
    emit('info', `Cleaned ${env}: public`)
    return ['public']
  },
  recordWhereThere: async (_p, script) => [script],
  markApplied: async (_p, env, script) => {
    // The preview applies scripts in order: recording the next pending one moves the count on.
    if (fakeInfo(env).findIndex((i) => i.script === script) === (fake.applied[env] ?? 0)) fake.applied[env] = (fake.applied[env] ?? 0) + 1
    emit('info', `Recorded ${script} as applied on ${env} without running it`)
  },
  scriptsList: async () => {
    await wait()
    return fake.scripts.map(([version, description]) => ({
      kind: 'versioned' as const, version, description,
      file_name: `V${version}__${description.replaceAll(' ', '_')}.sql`,
      sql: `-- ${description}\ncreate table if not exists ${description.split(' ').pop()} (id bigint primary key);\n`,
    }))
  },
  scriptAdd: async (path, repeatable, description) => {
    const name = repeatable ? `R__${description.replaceAll(' ', '_')}.sql` : `V20261008.1200__${description.replaceAll(' ', '_')}.sql`
    if (!repeatable) fake.scripts.push(['20261008.1200', description])
    return `${path}/migrations/${name}`
  },
  scratchCreate: async () => {
    await wait(400)
    return fakeProject()
  },
  capture: async (_p, env, description, asBaseline) => {
    await wait(500)
    return { file_name: `${asBaseline ? 'B' : 'V'}20261008.1200__${description.replaceAll(' ', '_')}.sql`, version: '20261008.1200', sql: `-- ${description}\n-- captured from ${env}\n\nCREATE TABLE public.orders (\n    id bigserial\n);\n`, undo: null }
  },
  squash: async (_p, upTo, description) => {
    emit('info', `Building 'scratch' from the versioned scripts up to ${upTo}`)
    await wait(500)
    return `B${upTo}__${description.replaceAll(' ', '_')}.sql`
  },
  rebaseline: async (_p, upTo, description, archive, restart) => {
    emit('info', `Building 'scratch' from the versioned scripts up to ${upTo}`)
    await wait(500)
    const removed = fake.scripts.filter(([v]) => restart || v <= upTo).map(([v, d]) => `V${v}__${d.replaceAll(' ', '_')}.sql`)
    const version = restart ? '0001' : upTo
    return { baseline: `C:/repos/shop-db/migrations/B${version}__${description.replaceAll(' ', '_')}.sql`, version, removed, archived_to: archive ? `C:/repos/shop-db/${archive}` : null }
  },
  adopt: async (_p, env) => {
    await wait(400)
    emit('info', `Capturing the objects of '${env}'`)
    return { environment: env, baseline: 'C:/repos/shop-db/migrations/B0001__existing_schema.sql', version: '0001', objects: 12 }
  },
  changesDiff: async () => {
    emit('info', "Rebuilding scratch database 'scratch' from migrations")
    await wait(600)
    emit('info', "Comparing 'local' with the migrations")
    const customer = 'CREATE TABLE public.customer (\n    id bigint GENERATED ALWAYS AS IDENTITY,\n    email text NOT NULL\n);\nALTER TABLE public.customer ADD CONSTRAINT customer_pkey PRIMARY KEY (id);'
    const ordersBefore = 'CREATE TABLE public.orders (\n    id bigserial,\n    note text\n);\nALTER TABLE public.orders ADD CONSTRAINT orders_pkey PRIMARY KEY (id);'
    const ordersAfter = 'CREATE TABLE public.orders (\n    id bigserial,\n    note text NOT NULL,\n    paid_at timestamp with time zone\n);\nALTER TABLE public.orders ADD CONSTRAINT orders_pkey PRIMARY KEY (id);\nCREATE INDEX orders_paid_idx ON public.orders USING btree (paid_at);'
    const cart = 'CREATE TABLE public.legacy_cart (\n    id integer NOT NULL\n);'
    const view = 'CREATE VIEW public.daily_totals AS\n SELECT date(paid_at) AS day, count(*) AS orders\n   FROM public.orders\n  GROUP BY (date(paid_at));'
    return { not_compared: ['row-level security policies: 2 in local, 0 in the scripts'], changes: [
      { id: 'table:public.customer', object_type: 'Tables', name: 'public.customer', kind: 'added', destructive: false, sql: customer, steps: [], undo_steps: [{ phase: 7, sql: 'DROP TABLE public.customer;' }], before: null, after: customer },
      { id: 'table:public.orders', object_type: 'Tables', name: 'public.orders', kind: 'changed', destructive: false, sql: 'ALTER TABLE public.orders ALTER COLUMN note SET NOT NULL;\nALTER TABLE public.orders ADD COLUMN paid_at timestamp with time zone;\nCREATE INDEX orders_paid_idx ON public.orders USING btree (paid_at);', steps: [], undo_steps: [], before: ordersBefore, after: ordersAfter },
      { id: 'table:public.legacy_cart', object_type: 'Tables', name: 'public.legacy_cart', kind: 'removed', destructive: true, sql: 'DROP TABLE public.legacy_cart;', steps: [], undo_steps: [], before: cart, after: null },
      { id: 'view:public.daily_totals', object_type: 'Views', name: 'public.daily_totals', kind: 'added', destructive: false, sql: `${view};`, steps: [], undo_steps: [], before: null, after: view },
    ] }
  },
  migrationGenerate: async (_p, changes, description, withUndo) => {
    const version = '20261008.1104'
    const sql = `-- ${description}\n-- Written by LiftOff. Review before committing.\n` + changes.map((c) => `\n-- ${c.kind} ${c.name}\n${c.sql}\n`).join('')
    const undo = withUndo ? { file_name: `U${version}__${description.replaceAll(' ', '_')}.sql`, sql: `-- Undo: ${description}\nDROP TABLE public.customer;\n` } : null
    return { file_name: `V${version}__${description.replaceAll(' ', '_')}.sql`, version, sql, undo }
  },
  undo: async (_p, env) => {
    await wait(300)
    emit('info', `Undid the latest script on ${env}; it is pending again`)
    fake.applied[env] = Math.max(0, (fake.applied[env] ?? 0) - 1)
    return { script: 'U20261008.0840__daily_totals_view.sql', version: '20261008.0840' }
  },
  check: async (_p, env, o) => {
    emit('info', `Rebuilding scratch database 'scratch' from migrations`)
    await wait(600)
    const drifted: Change = { id: 'table:public.orders', object_type: 'Tables', name: 'public.orders', kind: 'changed', destructive: false,
      sql: 'ALTER TABLE public.orders ADD COLUMN hotfix integer;', steps: [], undo_steps: [],
      before: 'CREATE TABLE public.orders (\n    id bigserial,\n    note text\n);', after: 'CREATE TABLE public.orders (\n    id bigserial,\n    note text,\n    hotfix integer\n);' }
    return {
      environment: env, applied_up_to: '20261003.1530',
      drift: o.drift ? (env === 'staging' ? [drifted] : []) : null,
      changes: o.changes ? fakeInfo(env).filter((i) => i.state === 'pending').map((i) => ({ ...drifted, id: `table:${i.description}`, name: `public.${i.description.replaceAll(' ', '_')}`, kind: 'added' as const, before: null })) : null,
      not_compared: [],
      rules: o.rules
        ? {
            scripts: fakeInfo(env).filter((i) => i.state === 'pending').map((i) => i.script),
            findings: env === 'production' ? [] : [
              { rule: 'table-without-primary-key', severity: 'warn', script: 'V20261007.1102__tax_function.sql', line: 3, message: 'table tax_rates has no primary key' },
              { rule: 'drop-column', severity: 'warn', script: 'V20261007.1102__tax_function.sql', line: 9, message: 'drops column legacy_rate of orders', allowed: 'moved to tax_rates in the previous release' },
            ],
            errors: 0,
            warnings: env === 'production' ? 0 : 1,
          }
        : null,
      dry_run_sql: o.dryRun ? `-- Dry run for ${env}: nothing below has been executed.\n\n-- V20261007.1102__tax_function.sql\nBEGIN;\ncreate function tax(amount numeric) ...;\nCOMMIT;\n` : null,
    }
  },
  migrationSave: async (path, fileName) => `${path}/migrations/${fileName}`,
  onLog: async (cb) => {
    logListeners.add(cb)
    return () => logListeners.delete(cb)
  },
}

export const api: Api = inDesktop ? real : fakeApi
