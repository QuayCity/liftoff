// Typed wrappers over the Tauri commands in src-tauri/src/lib.rs.
// Outside Tauri (plain browser: screenshots, UI tests) the same signatures run against seeded fake data.
import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { open as openDialog } from '@tauri-apps/plugin-dialog'

export type Role = 'dev' | 'scratch' | 'test' | 'prod'
export type ErrorReport = { code: string; exit_code: number; message: string }
export type EnvView = { name: string; role: Role; url: string; user: string | null; has_password: boolean; allow_clean: boolean }
export type License = { org: string; seats: number; edition: string; expires: string; features: string[] }
export type LicenseStatus = { license: License; grace_days_left: number | null; source: string }
export type Project = {
  root: string; name: string; engine: string; schemas: string[]; environments: EnvView[]
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
export type Change = { id: string; object_type: string; name: string; kind: 'added' | 'changed' | 'removed'; destructive: boolean; sql: string; steps: { phase: number; sql: string }[] }
export type Generated = { file_name: string; version: string; sql: string }
export type LogEvent = { level: 'info' | 'warn'; message: string }
export type ScriptView = { kind: 'versioned' | 'repeatable' | 'undo' | 'baseline'; version: string | null; description: string; file_name: string; sql: string }
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
  envSave(path: string, name: string, env: EnvInput, shared: boolean): Promise<Project>
  envTest(path: string, name: string): Promise<ServerInfo>
  envTestDraft(env: EnvInput): Promise<ServerInfo>
  migrationsInfo(path: string, env: string): Promise<MigrationInfo[]>
  migrate(path: string, env: string, outOfOrder: boolean): Promise<MigrateResult>
  validate(path: string, env: string): Promise<MigrationInfo[]>
  baseline(path: string, env: string, version: string, description: string): Promise<void>
  repair(path: string, env: string): Promise<RepairReport>
  clean(path: string, env: string): Promise<string[]>
  markApplied(path: string, env: string, script: string): Promise<void>
  scriptsList(path: string): Promise<ScriptView[]>
  scriptAdd(path: string, repeatable: boolean, description: string, sql: string): Promise<string>
  capture(path: string, env: string, description: string): Promise<Generated>
  changesDiff(path: string): Promise<Change[]>
  migrationGenerate(path: string, changes: Change[], description: string): Promise<Generated>
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
  envSave: (path, name, env, shared) => invoke('env_save', { path, name, env, shared }),
  envTest: (path, name) => invoke('env_test', { path, name }),
  envTestDraft: (env) => invoke('env_test_draft', { env }),
  migrationsInfo: (path, env) => invoke('migrations_info', { path, env }),
  migrate: (path, env, outOfOrder) => invoke('migrate', { path, env, outOfOrder }),
  validate: (path, env) => invoke('validate', { path, env }),
  baseline: (path, env, version, description) => invoke('baseline', { path, env, version, description }),
  repair: (path, env) => invoke('repair', { path, env }),
  clean: (path, env) => invoke('clean', { path, env }),
  markApplied: (path, env, script) => invoke('mark_applied', { path, env, script }),
  scriptsList: (path) => invoke('scripts_list', { path }),
  scriptAdd: (path, repeatable, description, sql) => invoke('script_add', { path, repeatable, description, sql }),
  capture: (path, env, description) => invoke('capture', { path, env, description }),
  changesDiff: (path) => invoke('changes_diff', { path }),
  migrationGenerate: (path, changes, description) => invoke('migration_generate', { path, changes, description }),
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
    root: 'C:/repos/shop-db', name: 'shop-db', engine: 'postgresql', schemas: ['public'], license: null, license_error: null,
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
  recentProjects: async () => [{ name: 'shop-db', path: 'C:/repos/shop-db', exists: true }, { name: 'billing', path: 'C:/old/billing', exists: false }],
  recentForget: async () => {},
  pickFolder: async () => 'C:/repos/new-project',
  projectInit: async (path, name) => ({ ...fakeProject(), root: path, name, environments: [] }),
  projectOpen: async (path) => {
    await wait()
    if (path.includes('old')) throw fail('LIFTOFF_CONFIG', `no liftoff.toml in ${path}; run \`liftoff init\` first`, 2)
    return fakeProject()
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
  capture: async (_p, env, description) => {
    if (!fake.licensed) throw fail('LIFTOFF_LICENSE', "'generate' is part of LiftOff Pro.", 20)
    await wait(500)
    return { file_name: `V20261008.1200__${description.replaceAll(' ', '_')}.sql`, version: '20261008.1200', sql: `-- ${description}\n-- captured from ${env}\n\nCREATE TABLE public.orders (\n    id bigserial\n);\n` }
  },
  changesDiff: async () => {
    if (!fake.licensed) throw fail('LIFTOFF_LICENSE', "'diff' is part of LiftOff Pro. Set LIFTOFF_LICENSE (CI) or activate a licence in the desktop app.", 20)
    emit('info', "Rebuilding scratch database 'scratch' from migrations")
    await wait(600)
    emit('info', "Comparing 'local' with the migrations")
    return [
      { id: 'table:public.customer', object_type: 'Tables', name: 'public.customer', kind: 'added', destructive: false, sql: 'CREATE TABLE public.customer (\n    id bigint GENERATED ALWAYS AS IDENTITY,\n    email text NOT NULL\n);', steps: [] },
      { id: 'table:public.orders', object_type: 'Tables', name: 'public.orders', kind: 'changed', destructive: false, sql: 'ALTER TABLE public.orders ADD COLUMN paid_at timestamp with time zone;', steps: [] },
      { id: 'table:public.legacy_cart', object_type: 'Tables', name: 'public.legacy_cart', kind: 'removed', destructive: true, sql: 'DROP TABLE public.legacy_cart;', steps: [] },
    ]
  },
  migrationGenerate: async (_p, changes, description) => {
    const version = '20261008.1104'
    const sql = `-- ${description}\n-- Written by LiftOff. Review before committing.\n` + changes.map((c) => `\n-- ${c.kind} ${c.name}\n${c.sql}\n`).join('')
    return { file_name: `V${version}__${description.replaceAll(' ', '_')}.sql`, version, sql }
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
