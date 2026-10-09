// What the CLI returns, and the small decisions made from it: how a migration's state is shown,
// and which scripts deserve a warning in the editor.
//
// No VS Code API here, so it can be tested with plain Node.

export type Role = 'dev' | 'scratch' | 'test' | 'prod'

export type Environment = {
  name: string
  role: Role
  /** "PostgreSQL" or "SQL Server" */
  engine: string
  allow_clean: boolean
}

/** `liftoff project` */
export type Project = {
  name: string
  engine: string
  /** the migrations folder, relative to the project folder */
  migrations: string
  schemas: string[]
  environments: Environment[]
  /** any versioned or baseline script yet (without: an existing database can be adopted) */
  has_scripts?: boolean
  /** e.g. the numbering nearing 9999 */
  notes?: string[]
}

export type State =
  | 'pending'
  | 'applied'
  | 'failed'
  | 'outdated'
  | 'ignored'
  | 'below_baseline'
  | 'missing'
  | 'baseline'
  | 'future'

/** One row of `liftoff info` */
export type MigrationInfo = {
  kind: 'versioned' | 'repeatable' | 'undo' | 'baseline'
  version: string | null
  description: string
  script: string
  state: State
  installed_on: string | null
  execution_time_ms: number | null
  /** applied, but the file was edited afterwards */
  checksum_mismatch: boolean
}

/** `liftoff migrate` */
export type MigrateResult = {
  environment: string
  applied: { script: string; version: string | null; execution_time_ms: number; transactional: boolean }[]
  execution_time_ms: number
  dry_run_sql: string | null
  /** after `--only`: older versioned scripts that still have not run */
  left_behind?: string[]
  /** a database with objects was checked against a baseline script instead of running it */
  baseline_check?: { script: string; created: string[]; accepted: string[]; restart: boolean }
}

/** What a migrate did, in one line. */
export function migrateSummary(env: string, r: MigrateResult): string {
  const c = r.baseline_check
  if (c) {
    const parts = [`${env} ${c.restart ? 'went through the restart at' : 'is now at'} ${c.script}`]
    if (c.created.length) parts.push(`created ${c.created.length} missing object${c.created.length === 1 ? '' : 's'}`)
    if (c.accepted.length) parts.push(`kept ${c.accepted.length} difference${c.accepted.length === 1 ? '' : 's'}`)
    const ran = r.applied.filter((a) => a.script !== c.script).length
    if (ran) parts.push(`then applied ${ran} migration${ran === 1 ? '' : 's'}`)
    return parts.join('; ')
  }
  const n = r.applied.length
  return n ? `Applied ${n} migration${n === 1 ? '' : 's'} to ${env}` : `${env} is up to date`
}

/** Whether `migrate --only` can run this script now (the CLI checks again). */
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

/** A change found by `liftoff check --drift` */
export type Change = { id: string; object_type: string; name: string; kind: 'added' | 'changed' | 'removed'; sql: string }

/** `liftoff check` */
export type CheckReport = { environment: string; drift: Change[] | null; not_compared: string[] }

export const stateText: Record<State, string> = {
  pending: 'pending',
  applied: 'applied',
  failed: 'failed',
  outdated: 'changed, runs again',
  ignored: 'skipped: older than the latest applied',
  below_baseline: 'covered by the baseline',
  missing: 'applied, file missing',
  baseline: 'baseline',
  future: 'applied, newer than these files',
}

/** Codicon names (https://code.visualstudio.com/api/references/icons-in-labels). */
export const stateIcon: Record<State, string> = {
  pending: 'circle-large-outline',
  applied: 'pass',
  failed: 'error',
  outdated: 'sync',
  ignored: 'warning',
  below_baseline: 'circle-slash',
  missing: 'question',
  baseline: 'milestone',
  future: 'arrow-up',
}

/** "2 pending", "up to date", "1 failed, 3 pending" */
export function summary(infos: MigrationInfo[]): string {
  const failed = infos.filter((i) => i.state === 'failed').length
  const pending = infos.filter((i) => i.state === 'pending' || i.state === 'outdated').length
  const parts: string[] = []
  if (failed) parts.push(`${failed} failed`)
  if (pending) parts.push(`${pending} pending`)
  return parts.length ? parts.join(', ') : 'up to date'
}

/** The line next to a migration in the tree. */
export function describe(info: MigrationInfo): string {
  const when = info.installed_on ? ` · ${info.installed_on.replace('T', ' ').replace('Z', ' UTC')}` : ''
  const edited = info.checksum_mismatch ? ' · edited after it ran' : ''
  return stateText[info.state] + edited + (info.state === 'applied' ? when : '')
}

export type Problem = { script: string; severity: 'error' | 'warning'; message: string }

/** Scripts that need attention on one environment, as editor warnings. */
export function problemsFor(environment: string, infos: MigrationInfo[]): Problem[] {
  const out: Problem[] = []
  for (const i of infos) {
    if (i.checksum_mismatch) {
      out.push({
        script: i.script,
        severity: 'warning',
        message: `Changed after it ran on ${environment}. Put new changes in a new script; if this edit is intended, run "liftoff repair" there.`,
      })
    }
    if (i.state === 'failed') {
      out.push({ script: i.script, severity: 'error', message: `Failed on ${environment}. Fix it, then run "liftoff repair" there before migrating again.` })
    }
  }
  return out
}

/** Problems from several environments, grouped by script file. */
export function groupProblems(byEnvironment: Map<string, Problem[]>): Map<string, Problem[]> {
  const out = new Map<string, Problem[]>()
  for (const problems of byEnvironment.values()) {
    for (const p of problems) out.set(p.script, [...(out.get(p.script) ?? []), p])
  }
  return out
}

/** One object that differs between the dev database and the schema-model folder (`liftoff model --status`). */
export type ModelChange = {
  /** relative to schema-model/, e.g. public/tables/orders.sql */
  path: string
  /** tables, views, functions, … */
  object_type: string
  /** what dev did: added (not in the files yet), changed, removed (dev dropped it) */
  kind: 'added' | 'changed' | 'removed'
  /** the file as it is (null when there is none) */
  before: string | null
  /** what dev has (null when dev dropped it) */
  after: string | null
}

const kindText = { added: 'new in dev', changed: 'changed in dev', removed: 'dropped in dev' }

/** "table · changed in dev" */
export function describeModelChange(c: ModelChange): string {
  const type = c.object_type.replace(/-/g, ' ').replace(/s$/, '')
  return `${type} · ${kindText[c.kind]}`
}

/** Build problems from `model --check`, grouped by file. */
export function modelProblems(problems: { path: string; message: string }[]): Map<string, string[]> {
  const out = new Map<string, string[]>()
  for (const p of problems) out.set(p.path, [...(out.get(p.path) ?? []), p.message])
  return out
}
