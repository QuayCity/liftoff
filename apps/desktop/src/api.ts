// Typed wrappers over the Tauri commands in src-tauri/src/lib.rs.
// Outside Tauri (plain browser: screenshots, UI tests) the same signatures run against seeded fake data.
import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { open as openDialog, save as saveDialog } from '@tauri-apps/plugin-dialog'

export type Role = 'dev' | 'scratch' | 'test' | 'prod'
export type ErrorReport = { code: string; exit_code: number; message: string }
export type EnvView = { name: string; role: Role; url: string; user: string | null; has_password: boolean; allow_clean: boolean }
export type License = { org: string; seats: number; edition: string; expires: string; features: string[] }
export type LicenseStatus = { license: License; grace_days_left: number | null; source: string }
export type Filter = { action: 'include' | 'exclude'; object: string; pattern: string }
export type ProjectSettings = { name: string; engine: string; migrations: string; schemas: string[]; history_table: string; filters: Filter[] }
export type Project = {
  root: string; name: string; engine: string; schemas: string[]; migrations: string; history_table: string; filters: Filter[]; environments: EnvView[]
  license: LicenseStatus | null; license_error: string | null
}
export type Recent = { name: string; path: string; exists: boolean }
export type EnvInput = { url: string; user: string | null; password: string | null; role: Role; allow_clean: boolean }
export type ServerInfo = { version: string; user: string; database: string }
export type State = 'pending' | 'applied' | 'failed' | 'outdated' | 'ignored' | 'below_baseline' | 'missing' | 'baseline' | 'future'
export type MigrationInfo = {
  kind: 'versioned' | 'repeatable' | 'undo' | 'baseline'; version: string | null; description: string; script: string
  state: State; installed_on: string | null; execution_time_ms: number | null; checksum_mismatch: boolean
}
export type MigrateResult = { environment: string; applied: { script: string; version: string | null; execution_time_ms: number; transactional: boolean }[]; execution_time_ms: number }
export type Step = { phase: number; order?: number; sql: string }
export type Change = {
  id: string; object_type: string; name: string; kind: 'added' | 'changed' | 'removed'; destructive: boolean
  sql: string; steps: Step[]; undo_steps: Step[]; before: string | null; after: string | null
}
export type Generated = { file_name: string; version: string; sql: string; undo: { file_name: string; sql: string } | null }
export type CheckReport = { environment: string; applied_up_to: string | null; drift: Change[] | null; changes: Change[] | null; dry_run_sql: string | null; not_compared: string[] }
export type Comparison = { changes: Change[]; not_compared: string[] }
export type LogEvent = { level: 'info' | 'warn'; message: string }
export type ScriptView = { kind: 'versioned' | 'repeatable' | 'undo' | 'baseline'; version: string | null; description: string; file_name: string; sql: string }
export type ConvertReport = { source: string; written: string; environments: string[]; migrations: string; schemas: string[]; flyway_table: string; not_converted: string[]; notes: string[] }
export type HistoryImport = { environment: string; imported: number; skipped: string[]; edited: string[]; attention: string[] }
export type GitStatus = { branch: string | null; upstream: string | null; ahead: number; behind: number; files: { path: string; change: string }[] }
export type ModelChange = { path: string; object_type: string; kind: 'added' | 'changed' | 'removed'; before: string | null; after: string | null }
export type CiOptions = { stages: string[]; branch: string; checks: boolean; install: string }
export type RepairReport = { removed_failed: string[]; realigned: string[]; forgotten: string[] }

export const inTauri = '__TAURI_INTERNALS__' in window

export const isErrorReport = (e: unknown): e is ErrorReport => typeof e === 'object' && e !== null && 'message' in e && 'code' in e
export const errorText = (e: unknown) => (isErrorReport(e) ? e.message : String(e))

type Api = {
  recentProjects(): Promise<Recent[]>
  recentForget(path: string): Promise<void>
  pickFolder(): Promise<string | null>
  projectInit(path: string, name: string): Promise<Project>
  projectOpen(path: string): Promise<Project>
  convertFlyway(path: string): Promise<{ report: ConvertReport; project: Project }>
  historyImport(path: string, env: string, table: string, acceptEdited: boolean): Promise<HistoryImport>
  envSave(path: string, name: string, env: EnvInput, shared: boolean): Promise<Project>
  envTest(path: string, name: string): Promise<ServerInfo>
  envTestDraft(env: EnvInput): Promise<ServerInfo>
  migrationsInfo(path: string, env: string): Promise<MigrationInfo[]>
  migrate(path: string, env: string, outOfOrder: boolean, allowNonEmpty?: boolean): Promise<MigrateResult>
  saveReport(path: string, report: CheckReport): Promise<string | null>
  modelStatus(path: string): Promise<ModelChange[]>
  modelSave(path: string, changes: ModelChange[]): Promise<number>
  projectSave(path: string, project: ProjectSettings): Promise<Project>
  ciWorkflow(path: string, options: CiOptions): Promise<string>
  ciWrite(path: string, yaml: string, overwrite: boolean): Promise<string>
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
  scriptsList(path: string): Promise<ScriptView[]>
  scriptAdd(path: string, repeatable: boolean, description: string, sql: string): Promise<string>
  capture(path: string, env: string, description: string, asBaseline: boolean): Promise<Generated>
  scratchCreate(path: string): Promise<Project>
  changesDiff(path: string): Promise<Comparison>
  migrationGenerate(path: string, changes: Change[], description: string, withUndo: boolean): Promise<Generated>
  undo(path: string, env: string): Promise<{ script: string; version: string | null }>
  check(path: string, env: string, opts: { drift: boolean; changes: boolean; dryRun: boolean }): Promise<CheckReport>
  migrationSave(path: string, fileName: string, sql: string): Promise<string>
  licenseActivate(text: string): Promise<LicenseStatus>
  onLog(cb: (e: LogEvent) => void): Promise<() => void>
}

const real: Api = {
  recentProjects: () => invoke('recent_projects'),
  recentForget: (path) => invoke('recent_forget', { path }),
  pickFolder: async () => {
    const r = await openDialog({ directory: true, multiple: false })
    return typeof r === 'string' ? r : null
  },
  projectInit: (path, name) => invoke('project_init', { path, name }),
  projectOpen: (path) => invoke('project_open', { path }),
  convertFlyway: (path) => invoke('project_convert_flyway', { path }),
  historyImport: (path, env, table, acceptEdited) => invoke('history_import', { path, env, table, acceptEdited }),
  envSave: (path, name, env, shared) => invoke('env_save', { path, name, env, shared }),
  envTest: (path, name) => invoke('env_test', { path, name }),
  envTestDraft: (env) => invoke('env_test_draft', { env }),
  migrationsInfo: (path, env) => invoke('migrations_info', { path, env }),
  migrate: (path, env, outOfOrder, allowNonEmpty = false) => invoke('migrate', { path, env, outOfOrder, allowNonEmpty }),
  modelStatus: (path) => invoke('model_status', { path }),
  modelSave: (path, changes) => invoke('model_save', { path, changes }),
  projectSave: (path, project) => invoke('project_save', { path, project }),
  ciWorkflow: (path, options) => invoke('ci_workflow', { path, options }),
  ciWrite: (path, yaml, overwrite) => invoke('ci_write', { path, yaml, overwrite }),
  gitStatus: (path) => invoke('git_status', { path }),
  gitDiff: (path, file) => invoke('git_diff', { path, file }),
  gitCommit: (path, files, message) => invoke('git_commit', { path, files, message }),
  gitPush: (path) => invoke('git_push', { path }),
  gitPull: (path) => invoke('git_pull', { path }),
  saveReport: async (path, report) => {
    const file = await saveDialog({ defaultPath: `liftoff-checks-${report.environment}.html`, filters: [{ name: 'HTML report', extensions: ['html'] }] })
    if (!file) return null
    await invoke('report_save', { path, report, file })
    return file
  },
  validate: (path, env) => invoke('validate', { path, env }),
  baseline: (path, env, version, description) => invoke('baseline', { path, env, version, description }),
  repair: (path, env) => invoke('repair', { path, env }),
  clean: (path, env) => invoke('clean', { path, env }),
  markApplied: (path, env, script) => invoke('mark_applied', { path, env, script }),
  scriptsList: (path) => invoke('scripts_list', { path }),
  scriptAdd: (path, repeatable, description, sql) => invoke('script_add', { path, repeatable, description, sql }),
  capture: (path, env, description, asBaseline) => invoke('capture', { path, env, description, asBaseline }),
  scratchCreate: (path) => invoke('scratch_create', { path }),
  changesDiff: (path) => invoke('changes_diff', { path }),
  migrationGenerate: (path, changes, description, withUndo) => invoke('migration_generate', { path, changes, description, withUndo }),
  undo: (path, env) => invoke('undo', { path, env }),
  check: (path, env, o) => invoke('check', { path, env, drift: o.drift, changes: o.changes, dryRun: o.dryRun }),
  migrationSave: (path, fileName, sql) => invoke('migration_save', { path, fileName, sql }),
  licenseActivate: (text) => invoke('license_activate', { text }),
  onLog: (cb) => listen<LogEvent>('run-log', (e) => cb(e.payload)),
}

/* ---------- fake: seeded, in memory, same behaviour shape ---------- */

const wait = (ms = 250) => new Promise((r) => setTimeout(r, ms))
const fail = (code: string, message: string, exit_code = 1): ErrorReport => ({ code, message, exit_code })
const logListeners = new Set<(e: LogEvent) => void>()
const emit = (level: LogEvent['level'], message: string) => logListeners.forEach((l) => l({ level, message }))

const demoLicense: LicenseStatus = { license: { org: 'Demo Org', seats: 5, edition: 'pro', expires: '2027-10-08', features: ['*'] }, grace_days_left: null, source: 'demo' }
const fake = {
  licensed: new URLSearchParams(location.search).get('licensed') !== '0',
  project: {
    root: 'C:/repos/shop-db', name: 'shop-db', engine: 'postgresql', schemas: ['public'], migrations: 'migrations', history_table: 'liftoff_schema_history', filters: [], license: null, license_error: null,
    environments: [
      { name: 'local', role: 'dev', url: 'postgres://me@localhost:5432/shop', user: null, has_password: true, allow_clean: false },
      { name: 'scratch', role: 'scratch', url: 'postgres://me@localhost:5432/shop_scratch', user: null, has_password: true, allow_clean: false },
      { name: 'staging', role: 'test', url: 'postgres://deploy@staging.internal:5432/shop', user: null, has_password: true, allow_clean: false },
      { name: 'production', role: 'prod', url: 'postgres://deploy@prod.internal:5432/shop', user: null, has_password: true, allow_clean: false },
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
    { path: 'public/tables/orders.sql', object_type: 'tables', kind: 'changed', before: 'CREATE TABLE public.orders (\n    id bigserial,\n    note text\n);\n', after: 'CREATE TABLE public.orders (\n    id bigserial,\n    note text,\n    paid_at timestamp with time zone\n);\n' },
    { path: 'public/tables/customer.sql', object_type: 'tables', kind: 'added', before: null, after: 'CREATE TABLE public.customer (\n    id bigint NOT NULL\n);\n' },
  ] as ModelChange[],
  gitRejectPush: new URLSearchParams(location.search).has('rejectpush'),
}
const fakeProject = (): Project => ({ ...fake.project, license: fake.licensed ? demoLicense : null })
const fakeInfo = (env: string): MigrationInfo[] =>
  fake.scripts.map(([version, description], i) => {
    const done = i < (fake.applied[env] ?? 0)
    return {
      kind: 'versioned', version, description, script: `V${version}__${description.replaceAll(' ', '_')}.sql`,
      state: done ? 'applied' : 'pending', installed_on: done ? `2026-10-0${i + 1}T09:1${i}:00Z` : null,
      execution_time_ms: done ? 40 + i * 37 : null, checksum_mismatch: false,
    }
  })

const fakeApi: Api = {
  recentProjects: async () => [
    { name: 'shop-db', path: 'C:/repos/shop-db', exists: true },
    { name: 'legacy-flyway', path: 'C:/repos/legacy-flyway', exists: true },
    { name: 'billing', path: 'C:/old/billing', exists: false },
  ],
  recentForget: async () => {},
  pickFolder: async () => 'C:/repos/new-project',
  projectInit: async (path, name) => ({ ...fakeProject(), root: path, name, environments: [] }),
  projectOpen: async (path) => {
    await wait()
    if (path.includes('old')) throw fail('LIFTOFF_CONFIG', `no liftoff.toml in ${path}; run \`liftoff init\` first`, 2)
    if (path.includes('flyway')) throw fail('LIFTOFF_FLYWAY_PROJECT', 'This folder has a Flyway project. Convert its settings to open it in LiftOff.', 2)
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
  modelStatus: async () => {
    if (!fake.licensed) throw fail('LIFTOFF_LICENSE', "'model' is part of LiftOff Pro.", 20)
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
  ciWorkflow: async (_p, o) => `# Written by LiftOff.\nname: Database migrations\non:\n  push:\n    branches: ['${o.branch}']\njobs:\n` + o.stages.map((s, i) => `  ${s}:\n    runs-on: ubuntu-latest\n${i ? `    needs: ${o.stages[i - 1]}\n` : ''}    steps:\n      - run: liftoff --environment '${s}' migrate\n`).join(''),
  ciWrite: async (path) => `${path}/.github/workflows/liftoff.yml`,
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
  migrate: async (_p, env) => {
    const pending = fakeInfo(env).filter((i) => i.state === 'pending')
    emit('info', `Connected to ${env} (shop as me, PostgreSQL 16.4)`)
    for (const p of pending) {
      emit('info', `Running ${p.script}`)
      await wait(300)
      emit('info', `Applied ${p.script} in 52 ms`)
    }
    if (!pending.length) emit('info', `${env} is up to date`)
    fake.applied[env] = fake.scripts.length
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
  markApplied: async (_p, env, script) => {
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
    if (!fake.licensed) throw fail('LIFTOFF_LICENSE', "'generate' is part of LiftOff Pro.", 20)
    await wait(500)
    return { file_name: `${asBaseline ? 'B' : 'V'}20261008.1200__${description.replaceAll(' ', '_')}.sql`, version: '20261008.1200', sql: `-- ${description}\n-- captured from ${env}\n\nCREATE TABLE public.orders (\n    id bigserial\n);\n`, undo: null }
  },
  changesDiff: async () => {
    if (!fake.licensed) throw fail('LIFTOFF_LICENSE', "'diff' is part of LiftOff Pro. Set LIFTOFF_LICENSE (CI) or activate a licence in the desktop app.", 20)
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
    if (!fake.licensed) throw fail('LIFTOFF_LICENSE', "'check' is part of LiftOff Pro.", 20)
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
      dry_run_sql: o.dryRun ? `-- Dry run for ${env}: nothing below has been executed.\n\n-- V20261007.1102__tax_function.sql\nBEGIN;\ncreate function tax(amount numeric) ...;\nCOMMIT;\n` : null,
    }
  },
  migrationSave: async (path, fileName) => `${path}/migrations/${fileName}`,
  licenseActivate: async (text) => {
    if (!text.startsWith('LIFTOFF-1.')) throw fail('LIFTOFF_LICENSE', 'the licence is not valid (damaged or not issued by LiftOff)', 20)
    fake.licensed = true
    return demoLicense
  },
  onLog: async (cb) => {
    logListeners.add(cb)
    return () => logListeners.delete(cb)
  },
}

export const api: Api = inTauri ? real : fakeApi
