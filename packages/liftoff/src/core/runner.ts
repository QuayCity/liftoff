// Running migrations: info (C03), migrate (C04), undo (C09), validate (C05), baseline (C06),
// repair (C07), clean (C08) and recording a script as applied. The same code serves PostgreSQL
// and SQL Server; the differences live behind `Conn` (db.ts). Each run that changes something is
// also written to the activity table (who, from where, what), failed or not.

import { randomUUID } from 'node:crypto'
import * as os from 'node:os'
import type { Config, Environment } from './config.ts'
import { BaselineDiffersError, configError, DbError, MigrationError, notBaselinedError, validateError } from './errors.ts'
import { activityTable, dialect, open, type Conn, type EngineName, type Held, type HistoryRow } from './db.ts'
import { run as git } from './git.ts'
import { applyPlaceholders, compareVersions, holds, isFor, parseExpression, parseVersion, scan, versionNote, type Kind, type Script, type Version } from './migration.ts'

export type State =
  | 'pending'
  | 'applied'
  | 'failed'
  /** a repeatable whose file changed since it ran; migrate runs it again */
  | 'outdated'
  /** a versioned file older than the latest applied one (out of order); migrate refuses unless --out-of-order */
  | 'ignored'
  /** a versioned file at or below the baseline version; never runs */
  | 'below_baseline'
  /** in the history, file gone */
  | 'missing'
  | 'baseline'
  /** in the history, newer than any file here (another branch ran it) */
  | 'future'
  /** `-- liftoff:for` leaves this environment out; never runs here */
  | 'excluded'

export type MigrationInfo = {
  kind: Kind
  version: string | null
  description: string
  script: string
  state: State
  installed_on: string | null
  execution_time_ms: number | null
  /** an applied versioned script whose file changed afterwards */
  checksum_mismatch: boolean
  /** the script's `-- liftoff:for` expression */
  for?: string
  /** the script's `-- liftoff:topic` words */
  topics?: string[]
}

export type Level = 'info' | 'warn'

/** Progress messages: the CLI writes them to stderr, the desktop app and the extension show them. */
export type Log = (level: Level, message: string) => void

export const quiet: Log = () => {}

const ver = (r: HistoryRow) => (r.version === null ? undefined : parseVersion(r.version))

/** Where a script's `-- liftoff:for` is evaluated: an environment's name and role. */
export type Target = { name: string; role: string }

/** Each script's state, from the files and the history table; with `env`, scripts not for it are `excluded`. */
export function compute(scripts: Script[], allRows: HistoryRow[], env?: Target): MigrationInfo[] {
  // Rows before the latest numbering restart belong to the old numbering: kept for the record, not
  // compared. The restart row itself is the baseline the new numbering starts from.
  const restart = allRows.findLastIndex((r) => r.type === 'RESTART')
  const current = restart < 0 ? allRows : allRows.slice(restart).map((r, i) => (i === 0 ? { ...r, type: 'SQL_BASELINE' } : r))
  // Flyway's schema-creation marker is bookkeeping, not a migration.
  const rows = current.filter((r) => r.type !== 'SCHEMA')
  // One effective row per version, in rank order. A later DELETE row (repair forgot a missing
  // script) or UNDO_SQL row (undo ran) retires the version.
  const latest: [Version, HistoryRow][] = []
  for (const r of rows.filter((r) => r.type !== 'BASELINE' && r.type !== 'SQL_BASELINE')) {
    const v = ver(r)
    if (!v) continue
    const i = latest.findIndex(([lv]) => compareVersions(lv, v) === 0)
    if (i >= 0) latest.splice(i, 1)
    if (r.type !== 'DELETE' && r.type !== 'UNDO_SQL') latest.push([v, r])
  }
  const applied = latest.map(([, r]) => r)
  // BASELINE: `liftoff baseline` marked the database. SQL_BASELINE: a B script built it.
  const baselineRows = rows.filter((r) => r.type === 'BASELINE' || r.type === 'SQL_BASELINE')
  const max = (vs: (Version | undefined)[]) => vs.filter((v): v is Version => !!v).sort(compareVersions).at(-1)
  const baseline = max(baselineRows.map(ver))
  const maxApplied = max([...applied.filter((r) => r.success).map(ver), baseline])
  const maxFile = max(scripts.filter((s) => s.kind === 'versioned').map((s) => s.version))
  const baselineFile = max(scripts.filter((s) => s.kind === 'baseline').map((s) => s.version))

  const fromRow = (r: HistoryRow, kind: Kind, state: State): MigrationInfo => ({
    kind,
    version: r.version,
    description: r.description,
    script: r.script,
    state,
    installed_on: r.installed_on,
    execution_time_ms: r.execution_time,
    checksum_mismatch: false,
  })

  const versioned: [Version, MigrationInfo][] = []
  for (const s of scripts.filter((s) => s.kind === 'versioned')) {
    const v = s.version!
    const row = applied.find((r) => compareVersions(ver(r), v) === 0 && ver(r))
    let state: State
    if (row) state = row.success ? 'applied' : 'failed'
    else if (baseline && compareVersions(v, baseline) <= 0) state = 'below_baseline'
    else if (env && !isFor(s, env)) state = 'excluded'
    else if (maxApplied && compareVersions(v, maxApplied) < 0) state = 'ignored'
    else state = 'pending'
    versioned.push([
      v,
      {
        kind: 'versioned',
        version: v.text,
        description: s.description,
        script: s.fileName,
        state,
        installed_on: row?.installed_on ?? null,
        execution_time_ms: row?.execution_time ?? null,
        checksum_mismatch: !!row && row.success && row.checksum !== s.checksum,
        ...marksOf(s),
      },
    ])
  }
  for (const r of baselineRows) versioned.push([ver(r) ?? parseVersion('0')!, fromRow(r, 'baseline', 'baseline')])
  const seen: Version[] = []
  for (const r of [...applied].reverse()) {
    const v = ver(r)!
    if (seen.some((x) => compareVersions(x, v) === 0)) continue
    if (versioned.some(([sv, i]) => compareVersions(sv, v) === 0 && i.kind === 'versioned')) continue
    seen.push(v)
    // A baseline script at or above this version replaced its file (liftoff rebaseline): covered, not missing.
    const covered = !!baselineFile && compareVersions(v, baselineFile) <= 0
    const state: State = !r.success ? 'failed' : covered ? 'below_baseline' : !maxFile || compareVersions(v, maxFile) > 0 ? 'future' : 'missing'
    versioned.push([v, fromRow(r, 'versioned', state)])
  }
  versioned.sort((a, b) => compareVersions(a[0], b[0]))

  const out = versioned.map(([, i]) => i)
  const repeatableRows = rows.filter((r) => r.version === null)
  // The latest row per description; a DELETE row means repair forgot it.
  const lastFor = (d: string) => {
    const r = repeatableRows.findLast((r) => r.description === d)
    return r && r.type !== 'DELETE' ? r : undefined
  }
  for (const s of scripts.filter((s) => s.kind === 'repeatable')) {
    const row = lastFor(s.description)
    const state: State = env && !isFor(s, env) ? 'excluded' : !row ? 'pending' : !row.success ? 'failed' : row.checksum === s.checksum ? 'applied' : 'outdated'
    out.push({
      kind: 'repeatable',
      version: null,
      description: s.description,
      script: s.fileName,
      state,
      installed_on: row?.installed_on ?? null,
      execution_time_ms: row?.execution_time ?? null,
      checksum_mismatch: false,
      ...marksOf(s),
    })
  }
  const gone: HistoryRow[] = []
  const seenDesc = new Set<string>()
  for (const r of repeatableRows) {
    if (seenDesc.has(r.description) || scripts.some((s) => s.kind === 'repeatable' && s.description === r.description)) continue
    seenDesc.add(r.description)
    // A forgotten (DELETE) repeatable has no last row and stays out of the list.
    const last = lastFor(r.description)
    if (last) gone.push(last)
  }
  gone.sort((a, b) => (a.description < b.description ? -1 : a.description > b.description ? 1 : 0))
  out.push(...gone.map((r) => fromRow(r, 'repeatable', 'missing')))
  return out
}

const marksOf = (s: Script): Pick<MigrationInfo, 'for' | 'topics'> => ({ ...(s.for !== undefined && { for: s.for }), ...(s.topics && { topics: s.topics }) })

/** The environment whose `-- liftoff:for` rules apply: `as` (a scratch rebuild for another environment), else itself. */
function targetOf(cfg: Config, name: string, env: Environment, as?: string): Target {
  return as ? { name: as, role: cfg.pick(as)[1].role } : { name, role: env.role }
}

/** Opens the environment, runs `work`, closes the connection. */
async function withEnv<T>(cfg: Config, envName: string | undefined, work: (c: Conn, name: string, env: Environment) => Promise<T>): Promise<T> {
  const [name, env] = cfg.pick(envName)
  const c = await open(name, env)
  try {
    return await work(c, name, env)
  } finally {
    await c.close()
  }
}

export async function info(cfg: Config, envName: string | undefined): Promise<MigrationInfo[]> {
  const scripts = scan(cfg.migrationsDir())
  return withEnv(cfg, envName, async (c, name, env) => compute(scripts, await c.readHistory(cfg.historySchema(), cfg.project.history_table), targetOf(cfg, name, env)))
}

export type Applied = { script: string; version: string | null; execution_time_ms: number; transactional: boolean }

export type MigrateResult = {
  environment: string
  applied: Applied[]
  execution_time_ms: number
  /** with `dryRun`: everything that would be sent to the database; nothing ran */
  dry_run_sql: string | null
  /** with `only`: versioned scripts older than one that ran, still not run (a plain migrate now needs --out-of-order for them) */
  left_behind?: string[]
  /** a database with objects was checked against a baseline script instead of running it */
  baseline_check?: BaselineCheck
  /** the activity row of this run, when it ran any script */
  deployment_id?: string
}

export type BaselineCheck = {
  script: string
  /** objects the database lacked, now created */
  created: string[]
  /** objects that differ, kept as they are (--accept-differences) */
  accepted: string[]
  /** a numbering restart (liftoff rebaseline --restart), not a first baseline */
  restart: boolean
}

export type MigrateOptions = {
  /** also run versioned scripts older than the latest applied one */
  outOfOrder?: boolean
  /** stop after this version (repeatables still run) */
  target?: string
  /** write the SQL that would run instead of running it (C10); takes no lock and changes nothing */
  dryRun?: boolean
  /** run every script on a database that already has tables but no history (normally refused) */
  allowNonEmpty?: boolean
  /** also run repeatable scripts again that have not changed */
  rerunRepeatables?: boolean
  /** run versioned scripts only (squash builds its baseline without the repeatables) */
  skipRepeatables?: boolean
  /**
   * Run these scripts and nothing else (a cherry-pick): each a version (`5`, `1.2`), a file name,
   * or a repeatable script's name (`customer_totals`). Older versioned scripts may be picked.
   */
  only?: string[]
  /** a database with objects that differ from the baseline script: record the baseline anyway */
  acceptDifferences?: boolean
  /** the scratch environment to build a baseline script on, to check a database against it */
  scratch?: string
  /** adopt: the database must match the baseline exactly (nothing created, nothing accepted) */
  baselineMustMatch?: boolean
  /** run the pending scripts whose `-- liftoff:topic` words satisfy this expression, and nothing else */
  topic?: string
  /** decide `-- liftoff:for` as if this were that environment (a scratch database rebuilt to check it) */
  as?: string
}

const waiting = (log: Log) => () => log('info', 'Another run holds the lock on this database; waiting')

/** What a run writes to the activity table. `scripts` is read when the run ends. */
type Audit = { id: string; operation: string; scripts: () => string[]; detail: string | null; options: string | null }

const audit = (operation: string, options: string | null = null): Audit => ({ id: randomUUID(), operation, scripts: () => [], detail: null, options })

/** The CI run's page, from the variables each CI service sets; null outside a pipeline. */
export function pipelineOf(e: Record<string, string | undefined>): string | null {
  if (e.GITHUB_ACTIONS === 'true' && e.GITHUB_RUN_ID) return `${e.GITHUB_SERVER_URL ?? 'https://github.com'}/${e.GITHUB_REPOSITORY}/actions/runs/${e.GITHUB_RUN_ID}`
  if (e.TF_BUILD && e.BUILD_BUILDID) return `${e.SYSTEM_COLLECTIONURI ?? e.SYSTEM_TEAMFOUNDATIONCOLLECTIONURI ?? ''}${encodeURIComponent(e.SYSTEM_TEAMPROJECT ?? '')}/_build/results?buildId=${e.BUILD_BUILDID}`
  if (e.GITLAB_CI && (e.CI_JOB_URL || e.CI_PIPELINE_URL)) return (e.CI_JOB_URL ?? e.CI_PIPELINE_URL)!
  if (e.JENKINS_URL && e.BUILD_URL) return e.BUILD_URL
  return null
}

function commitOf(root: string): string | null {
  try {
    return git(root, ['rev-parse', 'HEAD']).trim() || null
  } catch {
    return null
  }
}

function osUser(): string {
  try {
    return process.env.USERNAME ?? process.env.USER ?? os.userInfo().username
  } catch {
    return ''
  }
}

/**
 * Runs `work` and writes the run to the activity table, failed or not. A run that changed nothing
 * is not written. Writing never hides the run's own result or error: it only warns.
 */
async function audited<T>(c: Conn, cfg: Config, log: Log, a: Audit, work: () => Promise<T>): Promise<T> {
  const started = new Date()
  let error: { e: unknown } | undefined
  try {
    return await work()
  } catch (e) {
    error = { e }
    throw e
  } finally {
    const scripts = a.scripts()
    if (error || scripts.length || a.detail) {
      const schema = cfg.historySchema()
      const table = activityTable(cfg.project.history_table)
      try {
        await c.ensureActivity(schema, table)
        await c.insertActivity(schema, table, {
          id: a.id,
          operation: a.operation,
          started_on: started.toISOString(),
          execution_time: Date.now() - started.getTime(),
          success: !error,
          os_user: osUser().slice(0, 100),
          host: os.hostname().slice(0, 100),
          pipeline: pipelineOf(process.env)?.slice(0, 1000) ?? null,
          git_commit: commitOf(cfg.root),
          scripts,
          detail: [error ? failure(error.e) : a.detail, a.options].filter(Boolean).join('\n') || null,
        })
      } catch (e) {
        log('warn', `This run was not written to ${table}: ${failure(e)}`)
      }
    }
  }
}

/** How migrate was asked to run, for the activity table. */
function optionsText(o: MigrateOptions): string | null {
  const parts = [
    o.only && `--only ${o.only.join(', ')}`,
    o.topic !== undefined && `--topic ${o.topic}`,
    o.target !== undefined && `--target ${o.target}`,
    o.outOfOrder && '--out-of-order',
    o.allowNonEmpty && '--allow-non-empty',
    o.acceptDifferences && '--accept-differences',
    o.rerunRepeatables && '--rerun-repeatables',
  ].filter(Boolean)
  return parts.length ? parts.join(' ') : null
}

/** Validates, then applies pending versioned scripts in order, then new or changed repeatables. */
export async function migrate(cfg: Config, envName: string | undefined, opts: MigrateOptions = {}, log: Log = quiet): Promise<MigrateResult> {
  const started = Date.now()
  let target: Version | undefined
  if (opts.target !== undefined) {
    target = parseVersion(opts.target)
    if (!target) throw configError(`target '${opts.target}' must be numbers separated by . or _`)
  }
  if (opts.only && opts.target !== undefined) throw configError('use --only or --target, not both')
  if (opts.topic !== undefined && (opts.only || opts.target !== undefined)) throw configError('use --topic on its own, without --only or --target')
  if (opts.topic !== undefined) parseExpression(opts.topic, '--topic')
  const scripts = scan(cfg.migrationsDir())
  const note = versionNote(scripts)
  if (note) log('warn', note)
  // Placeholder values are checked before anything runs (an unset variable fails here).
  if (cfg.usesPlaceholders()) cfg.placeholders(cfg.pick(envName)[0])
  return withEnv(cfg, envName, async (c, name, env) => {
    const s = await c.serverInfo()
    log('info', `Connected to ${name} (${s.database} as ${s.user}, ${c.engine} ${s.version})`)
    const [schema, table] = [cfg.historySchema(), cfg.project.history_table]
    if (opts.dryRun) {
      const result = dryRun(cfg, c.engine, name, targetOf(cfg, name, env, opts.as), scripts, await c.readHistory(schema, table), opts, target)
      result.execution_time_ms = Date.now() - started
      return result
    }
    const held = await c.lock(schema, table, cfg.project.lock, waiting(log), () => open(name, env))
    const result: MigrateResult = { environment: name, applied: [], execution_time_ms: 0, dry_run_sql: null }
    const a = { ...audit('migrate', optionsText(opts)), scripts: () => result.applied.map((x) => x.script) }
    try {
      await audited(c, cfg, log, a, () => migrateLocked(c, cfg, name, targetOf(cfg, name, env, opts.as), scripts, opts, target, log, result))
    } finally {
      // Released on failure too (a dropped connection or an expired lease would free it as well).
      await held.release()
    }
    if (result.applied.length) result.deployment_id = a.id
    result.execution_time_ms = Date.now() - started
    return result
  })
}

/** The scripts migrate would run, in order. */
function plan(infos: MigrationInfo[], opts: MigrateOptions, target: Version | undefined): MigrationInfo[] {
  if (opts.only) return picked(infos, opts.only)
  if (opts.topic !== undefined) {
    const e = parseExpression(opts.topic, '--topic')
    const runnable: State[] = ['pending', 'ignored', 'outdated']
    return infos.filter((i) => (i.kind === 'versioned' || i.kind === 'repeatable') && runnable.includes(i.state) && holds(e, new Set((i.topics ?? []).map((t) => t.toLowerCase()))))
  }
  return infos.filter((i) => {
    let runs = false
    if (i.kind === 'versioned') runs = i.state === 'pending' || (i.state === 'ignored' && !!opts.outOfOrder)
    else if (i.kind === 'repeatable' && !opts.skipRepeatables) runs = i.state === 'pending' || i.state === 'outdated' || (i.state === 'applied' && !!opts.rerunRepeatables)
    const v = i.version === null ? undefined : parseVersion(i.version)
    return runs && !(target && v && compareVersions(v, target) > 0)
  })
}

const notPickable: Partial<Record<State, string>> = {
  applied: 'has already run',
  failed: 'failed on a previous run; fix it and run `liftoff repair` first',
  below_baseline: 'is covered by the baseline of this database',
  missing: 'has run, but its file is missing',
  future: 'has run (a newer version than these files)',
  baseline: 'is the baseline marker',
}

/** `--only`: the scripts it names, in the usual order. Each must be one that can run now. */
function picked(infos: MigrationInfo[], only: string[]): MigrationInfo[] {
  const chosen = new Set<MigrationInfo>()
  const name = (s: string) => s.trim().toLowerCase().replace(/[_\s]+/g, ' ')
  for (const sel of only) {
    const v = parseVersion(sel.trim().replace(/^v/i, ''))
    const match = infos.find(
      (i) =>
        i.script.toLowerCase() === sel.trim().toLowerCase() ||
        (i.kind === 'versioned' && v && i.version !== null && compareVersions(parseVersion(i.version), v) === 0) ||
        (i.kind === 'repeatable' && name(i.description) === name(sel)),
    )
    if (!match || (match.kind !== 'versioned' && match.kind !== 'repeatable')) {
      throw configError(`--only ${sel}: no script with that version or name`)
    }
    const why = match.kind === 'versioned' && match.state === 'applied' ? notPickable.applied : match.kind === 'versioned' ? notPickable[match.state] : match.state === 'missing' ? notPickable.missing : undefined
    if (why) throw configError(`--only ${sel}: ${match.script} ${why}`)
    chosen.add(match)
  }
  return infos.filter((i) => chosen.has(i))
}

/** Versioned scripts older than the newest one that ran, still not run (after an --only run). */
function leftBehind(infos: MigrationInfo[], ran: MigrationInfo[]): string[] {
  const newest = ran.filter((i) => i.kind === 'versioned').map((i) => parseVersion(i.version!)).sort(compareVersions).at(-1)
  if (!newest) return []
  return infos
    .filter((i) => i.kind === 'versioned' && (i.state === 'pending' || i.state === 'ignored') && !ran.includes(i) && compareVersions(parseVersion(i.version!), newest) < 0)
    .map((i) => i.script)
}

/** The newest baseline script, when it restarts the numbering and this database (with history) has not been through it. */
function pendingRestart(scripts: Script[], rows: HistoryRow[]): Script | undefined {
  const b = scripts.filter((s) => s.kind === 'baseline').sort((x, y) => compareVersions(x.version, y.version)).at(-1)
  if (!b?.restart || !rows.length) return undefined
  return rows.some((r) => r.type === 'RESTART' && r.script === b.fileName && r.checksum === b.checksum) ? undefined : b
}

/**
 * Marks a database that already has objects with a baseline script, without running it: builds the
 * script on the scratch database, compares, creates what the database lacks, and stops on anything
 * that differs (unless accepted). The history row is written in the same transaction.
 */
async function smartBaseline(cfg: Config, c: Conn, name: string, b: Script, type: 'SQL_BASELINE' | 'RESTART', opts: MigrateOptions, log: Log): Promise<BaselineCheck> {
  // diff.ts uses this module too; loaded when needed.
  const d = await import('./diff.ts')
  let scratch: [string, Environment]
  try {
    scratch = d.scratchEnv(cfg, opts.scratch)
  } catch {
    throw configError(
      `'${name}' already has objects. To check them against ${b.fileName}, LiftOff builds that script on a scratch database: add an environment with role "scratch", ` +
        `or mark it without checking: liftoff -e ${name} baseline --version ${b.version!.text}`,
    )
  }
  if (scratch[0] === name) throw configError(`'${name}' cannot be its own scratch database`)
  log('info', `${name} already has objects: checking them against ${b.fileName} (built on '${scratch[0]}')`)
  const s = await d.rebuildScratch(cfg, scratch[0], scratch[1], b.version!.text, log)
  let expected
  try {
    expected = await d.modelOf(cfg, s)
  } finally {
    await s.close()
  }
  const changes = d.diffSchemas(expected, await d.modelOf(cfg, c))
  const brief = (x: { id: string; kind: string; destructive: boolean }) => ({ id: x.id, kind: x.kind, destructive: x.destructive })
  const missing = changes.filter((x) => x.kind === 'added')
  const differences = changes.filter((x) => x.kind !== 'added')
  if (opts.baselineMustMatch && changes.length) throw new BaselineDiffersError(name, b.fileName, changes.map(brief))
  if (differences.length && !opts.acceptDifferences) throw new BaselineDiffersError(name, b.fileName, differences.map(brief))
  for (const x of differences) log('warn', `${name}: ${x.id} differs from ${b.fileName}; kept as it is (it shows up as drift)`)
  const [schema, table] = [cfg.historySchema(), cfg.project.history_table]
  if (missing.length) {
    log('info', `${name}: creating what it lacks of ${b.fileName}: ${missing.map((x) => x.id).join(', ')}`)
    const sql = d.renderScript(`-- What '${name}' lacked of ${b.fileName}`, missing)
    try {
      await runScript(c, b, sql, !dialect[c.engine].needsNoTransaction(sql), schema, table, type)
    } catch (e) {
      throw new MigrationError(b.fileName, failure(e))
    }
  } else {
    await record(c, b, 0, true, schema, table, type)
  }
  log('info', type === 'RESTART' ? `${name}: the numbering starts again from ${b.fileName}` : `${name} is now at ${b.fileName}`)
  return { script: b.fileName, created: missing.map((x) => x.id), accepted: differences.map((x) => x.id), restart: type === 'RESTART' }
}

/** The newest B script at or below `target`. */
function baselineScript(scripts: Script[], target: Version | undefined): Script | undefined {
  return scripts
    .filter((s) => s.kind === 'baseline' && (!target || (s.version && compareVersions(s.version, target) <= 0)))
    .sort((a, b) => compareVersions(a.version, b.version))
    .at(-1)
}

/** The script's SQL with this environment's placeholder values. */
function sqlFor(cfg: Config, env: string, s: Script): string {
  return applyPlaceholders(s.sql, cfg.placeholders(env), cfg.usesPlaceholders(), s.fileName)
}

function dryRun(cfg: Config, engine: EngineName, name: string, as: Target, scripts: Script[], rows: HistoryRow[], opts: MigrateOptions, target: Version | undefined): MigrateResult {
  const d = dialect[engine]
  const q = d.quote
  let infos = compute(scripts, rows, as)
  validate(infos, { ...opts, outOfOrder: opts.outOfOrder || !!opts.only || opts.topic !== undefined })
  // An engine that uses the connection's own schema (no schemas set): the history table goes without one.
  const history = cfg.historySchema() ? `${q(cfg.historySchema())}.${q(cfg.project.history_table)}` : q(cfg.project.history_table)
  let sql = `-- Dry run for ${name}: nothing below has been executed.\n-- History table: ${history}\n`
  const result: MigrateResult = { environment: name, applied: [], execution_time_ms: 0, dry_run_sql: null }
  const b = rows.length === 0 && !opts.only && opts.topic === undefined ? baselineScript(scripts, target) : undefined
  if (b) {
    sql += `\n-- ${b.fileName} (empty database: built from the baseline script)\n${d.begin};\n${sqlFor(cfg, name, b).trimEnd()}\nCOMMIT;\n`
    result.applied.push({ script: b.fileName, version: b.version?.text ?? null, execution_time_ms: 0, transactional: true })
    // The V scripts it covers would then be below the baseline.
    infos = infos.filter((i) => i.kind !== 'versioned' || compareVersions(parseVersion(i.version!), b.version) > 0)
  }
  for (const i of plan(infos, opts, target)) {
    const s = scripts.find((s) => s.fileName === i.script)!
    const transactional = !d.needsNoTransaction(s.sql)
    const version = s.version ? `'${s.version.text}'` : 'NULL'
    const esc = (x: string) => x.replaceAll("'", "''")
    const record =
      `INSERT INTO ${history} (installed_rank, version, description, type, script, checksum, installed_by, execution_time, success)\n` +
      `  SELECT coalesce(max(installed_rank), 0) + 1, ${version}, '${esc(s.description)}', 'SQL', '${esc(s.fileName)}', ${s.checksum}, ${d.currentUser}, 0, ${d.true} FROM ${history};`
    sql += `\n-- ${s.fileName}${transactional ? '' : ' (runs outside a transaction)'}\n`
    const body = sqlFor(cfg, name, s).trimEnd()
    sql += transactional ? `${d.begin};\n${body}\n${record}\nCOMMIT;\n` : `${body}\n${record}\n`
    result.applied.push({ script: s.fileName, version: s.version?.text ?? null, execution_time_ms: 0, transactional })
  }
  if (!result.applied.length) sql += '\n-- Nothing pending.\n'
  result.dry_run_sql = sql
  return result
}

async function migrateLocked(c: Conn, cfg: Config, name: string, as: Target, scripts: Script[], opts: MigrateOptions, target: Version | undefined, log: Log, result: MigrateResult): Promise<void> {
  const [schema, table] = [cfg.historySchema(), cfg.project.history_table]
  await c.ensureHistory(schema, table)
  let rows = await c.readHistory(schema, table)

  // Scripts that create what already exists fail half-way; ask for a baseline instead.
  // (--only never builds from a B script: it runs what it names.)
  const useBaseline = !opts.only && opts.topic === undefined
  if (!rows.length && !opts.allowNonEmpty && !(useBaseline && baselineScript(scripts, target)) && (await c.userObjects(cfg.project.schemas, table)) > 0) {
    throw notBaselinedError(name)
  }

  // A database whose history is from before a numbering restart goes through the restart first.
  const restart = useBaseline ? pendingRestart(scripts, rows) : undefined
  // A database without any history starts from the latest B script, when there is one. One that
  // already has objects is checked against it instead (missing objects created, differences listed).
  const b = restart ?? (rows.length === 0 && useBaseline ? baselineScript(scripts, target) : undefined)
  if (b && (restart || (!opts.allowNonEmpty && (await c.userObjects(cfg.project.schemas, table)) > 0))) {
    const t = Date.now()
    result.baseline_check = await smartBaseline(cfg, c, name, b, restart ? 'RESTART' : 'SQL_BASELINE', opts, log)
    result.applied.push({ script: b.fileName, version: b.version?.text ?? null, execution_time_ms: Date.now() - t, transactional: true })
    rows = await c.readHistory(schema, table)
  } else if (b) {
    log('info', `Empty database: building it from ${b.fileName}`)
    const t = Date.now()
    try {
      await runScript(c, b, sqlFor(cfg, name, b), !dialect[c.engine].needsNoTransaction(b.sql), schema, table, 'SQL_BASELINE')
    } catch (e) {
      throw new MigrationError(b.fileName, failure(e))
    }
    result.applied.push({ script: b.fileName, version: b.version?.text ?? null, execution_time_ms: Date.now() - t, transactional: true })
    rows = await c.readHistory(schema, table)
  }
  const infos = compute(scripts, rows, as)
  // Being older than what ran stops a plain migrate; with --only or --topic, only the picked scripts run.
  validate(infos, { ...opts, outOfOrder: opts.outOfOrder || !!opts.only || opts.topic !== undefined })

  const todo = plan(infos, opts, target)
  if (opts.topic !== undefined && !todo.length) log('info', `No pending script on ${name} has a topic matching '${opts.topic}'`)
  if (opts.only || opts.topic !== undefined) {
    result.left_behind = leftBehind(infos, todo)
    if (result.left_behind.length) {
      log('warn', `Not run, and older than what ran: ${result.left_behind.join(', ')}. A plain migrate now needs --out-of-order to run them.`)
    }
  }
  if (!todo.length && !result.applied.length) log('info', `${name} is up to date`)
  let ddlNoted = false
  for (const i of todo) {
    const s = scripts.find((s) => s.fileName === i.script)!
    const transactional = !dialect[c.engine].needsNoTransaction(s.sql)
    if (!transactional && dialect[c.engine].ddlCommits) {
      // Said once: on such an engine nearly every script has DDL.
      if (!ddlNoted) log('info', `${c.engine} commits DDL at once: if a script with DDL fails part-way, what ran stays (repair, then fix the script)`)
      ddlNoted = true
    } else if (!transactional) log('warn', `${s.fileName} runs outside a transaction; if it fails part-way it cannot be rolled back`)
    log('info', `Running ${s.fileName}`)
    const t = Date.now()
    try {
      await runScript(c, s, sqlFor(cfg, name, s), transactional, schema, table, 'SQL')
    } catch (e) {
      // Partial changes may remain: record the failure so `repair` is required.
      if (!transactional) await record(c, s, Date.now() - t, false, schema, table, 'SQL')
      log('warn', `${s.fileName} failed${transactional ? '; rolled back' : ''}`)
      throw new MigrationError(s.fileName, failure(e))
    }
    const ms = Date.now() - t
    log('info', `Applied ${s.fileName} in ${ms} ms`)
    result.applied.push({ script: s.fileName, version: s.version?.text ?? null, execution_time_ms: ms, transactional })
  }
}

/** A failed script's message, in the database's own words. */
function failure(e: unknown): string {
  if (e instanceof DbError) return e.detail
  return e instanceof Error ? e.message : String(e)
}

async function runScript(c: Conn, s: Script, sql: string, transactional: boolean, schema: string, table: string, type: string): Promise<void> {
  const t = Date.now()
  if (!transactional) {
    await c.script(sql, false)
    return record(c, s, Date.now() - t, true, schema, table, type)
  }
  // One transaction for the script and its history row: both land or neither does.
  await c.batch(dialect[c.engine].begin)
  try {
    await c.script(sql, true)
    await record(c, s, Date.now() - t, true, schema, table, type)
  } catch (e) {
    // On SQL Server XACT_ABORT may have rolled back already; then this one just fails.
    await c.batch('ROLLBACK').catch(() => {})
    throw e
  }
  await c.batch('COMMIT')
}

function record(c: Conn, s: Script, ms: number, success: boolean, schema: string, table: string, type: string): Promise<void> {
  return c.insertHistory(schema, table, { version: s.version?.text ?? null, description: s.description, type, script: s.fileName, checksum: s.checksum, executionTime: ms, success })
}

/** Runs the U script of the latest applied version and records it; that version is pending again. */
export async function undo(cfg: Config, envName: string | undefined, log: Log = quiet): Promise<Applied> {
  return withSession(cfg, envName, log, 'undo', async (s) => {
    const infos = compute(s.scripts, s.rows)
    validate(infos, {})
    const latest = infos
      .filter((i) => i.kind === 'versioned' && i.state === 'applied')
      .sort((a, b) => compareVersions(parseVersion(a.version!), parseVersion(b.version!)))
      .at(-1)
    if (!latest) throw validateError(`nothing to undo on ${s.name}`)
    const v = parseVersion(latest.version!)
    const u = s.scripts.find((x) => x.kind === 'undo' && compareVersions(x.version, v) === 0)
    if (!u) throw validateError(`${latest.script} has no undo script (U${latest.version}__….sql)`)
    const transactional = !dialect[s.c.engine].needsNoTransaction(u.sql)
    log('info', `Undoing ${latest.script} with ${u.fileName}`)
    s.audit.scripts = () => [u.fileName]
    const t = Date.now()
    try {
      await runScript(s.c, u, sqlFor(cfg, s.name, u), transactional, s.schema, s.table, 'UNDO_SQL')
    } catch (e) {
      throw new MigrationError(u.fileName, failure(e))
    }
    const ms = Date.now() - t
    log('info', `Undid ${latest.script} in ${ms} ms; it is pending again`)
    return { script: u.fileName, version: latest.version, execution_time_ms: ms, transactional }
  })
}

/** What `migrate` refuses to run on (also the core of `validate`, C05). */
export function validate(infos: MigrationInfo[], opts: MigrateOptions): void {
  const problems: string[] = []
  for (const i of infos) {
    if (i.state === 'failed') problems.push(`${i.script} failed on a previous run; fix it and run \`liftoff repair\``)
    if (i.state === 'missing' && i.kind === 'versioned') problems.push(`${i.script} was applied but the file is missing`)
    if (i.state === 'ignored' && !opts.outOfOrder) problems.push(`${i.script} is older than the latest applied version; use --out-of-order to run it`)
    if (i.checksum_mismatch) problems.push(`${i.script} changed after it was applied (checksum mismatch)`)
  }
  if (problems.length) throw validateError(problems.join('\n'))
}

export async function validateEnv(cfg: Config, envName: string | undefined): Promise<MigrationInfo[]> {
  const infos = await info(cfg, envName)
  validate(infos, {})
  return infos
}

/** A locked connection with the history table in place; `audit` is what the activity table gets. */
type Session = { c: Conn; name: string; schema: string; table: string; scripts: Script[]; rows: HistoryRow[]; audit: Audit }

async function withSession<T>(cfg: Config, envName: string | undefined, log: Log, operation: string, work: (s: Session) => Promise<T>): Promise<T> {
  const scripts = scan(cfg.migrationsDir())
  return withEnv(cfg, envName, async (c, name, env) => {
    const [schema, table] = [cfg.historySchema(), cfg.project.history_table]
    const held: Held = await c.lock(schema, table, cfg.project.lock, waiting(log), () => open(name, env))
    const a = audit(operation)
    try {
      return await audited(c, cfg, log, a, async () => {
        await c.ensureHistory(schema, table)
        return work({ c, name, schema, table, scripts, rows: await c.readHistory(schema, table), audit: a })
      })
    } finally {
      await held.release()
    }
  })
}

/** Marks an existing database as being at `version`, so scripts up to it never run there. */
export async function baseline(cfg: Config, envName: string | undefined, version: string, description: string, log: Log = quiet): Promise<void> {
  if (!parseVersion(version)) throw configError(`baseline version '${version}' must be numbers separated by . or _`)
  await withSession(cfg, envName, log, 'baseline', async (s) => {
    if (s.rows.length) throw validateError(`${s.name} already has migration history; baseline only applies to a database without any`)
    s.audit.detail = `baseline at version ${version}`
    await s.c.insertHistory(s.schema, s.table, { version, description, type: 'BASELINE', script: '<< baseline >>', checksum: null, executionTime: 0, success: true })
    log('info', `${s.name} is now at baseline ${version}`)
  })
}

export type RepairReport = {
  /** failed rows removed so the scripts can run again */
  removed_failed: string[]
  /** applied scripts whose stored checksum now matches the edited file */
  realigned: string[]
  /** applied scripts whose files are gone, marked as forgotten */
  forgotten: string[]
}

/** Removes failed runs, accepts edited scripts, forgets scripts whose files were deleted. */
export async function repair(cfg: Config, envName: string | undefined, log: Log = quiet): Promise<RepairReport> {
  return withSession(cfg, envName, log, 'repair', async (s) => {
    const report: RepairReport = { removed_failed: await s.c.deleteFailed(s.schema, s.table), realigned: [], forgotten: [] }
    const rows = await s.c.readHistory(s.schema, s.table)
    for (const i of compute(s.scripts, rows)) {
      if (i.checksum_mismatch) {
        const file = s.scripts.find((x) => x.fileName === i.script)!
        const v = parseVersion(i.version!)
        const row = rows.findLast((r) => r.success && r.type === 'SQL' && compareVersions(ver(r), v) === 0)
        if (row) {
          await s.c.realign(s.schema, s.table, row.installed_rank, file.checksum, file.description)
          report.realigned.push(i.script)
        }
      }
      if (i.state === 'missing') {
        await s.c.insertHistory(s.schema, s.table, { version: i.version, description: i.description, type: 'DELETE', script: i.script, checksum: null, executionTime: 0, success: true })
        report.forgotten.push(i.script)
      }
    }
    const done = `${report.removed_failed.length} failed row(s) removed, ${report.realigned.length} checksum(s) updated, ${report.forgotten.length} missing script(s) forgotten`
    log('info', `Repair: ${done}`)
    s.audit.scripts = () => [...report.removed_failed, ...report.realigned, ...report.forgotten]
    return report
  })
}

/** Erases every object in the project's schemas. Refused unless the environment is a scratch database or allows it. */
export async function clean(cfg: Config, envName: string | undefined, log: Log = quiet): Promise<string[]> {
  const [name, env] = cfg.pick(envName)
  if (env.role !== 'scratch' && !env.allow_clean) {
    throw configError(`clean is turned off for '${name}'; set allow_clean = true for it in liftoff.toml if it really may be erased`)
  }
  await withEnv(cfg, name, async (c) => {
    const held = await c.lock(cfg.historySchema(), cfg.project.history_table, cfg.project.lock, waiting(log), () => open(name, env))
    try {
      // The activity table goes too; the clean is its first row again.
      await audited(c, cfg, log, { ...audit('clean'), detail: `erased ${cfg.project.schemas.join(', ')}` }, () => c.resetSchemas(cfg.project.schemas))
    } finally {
      await held.release()
    }
  })
  log('info', `Cleaned ${name}: ${cfg.project.schemas.join(', ')}`)
  return cfg.project.schemas
}

/**
 * Records a pending script as applied without running it: for the dev database a migration was
 * generated from, which already has the change.
 */
export async function markApplied(cfg: Config, envName: string | undefined, script: string, log: Log = quiet): Promise<void> {
  await withSession(cfg, envName, log, 'mark-applied', async (s) => {
    const env = cfg.pick(s.name)[1]
    const i = compute(s.scripts, s.rows, { name: s.name, role: env.role }).find((i) => i.script === script)
    if (!i) throw configError(`no script named ${script} in the migrations folder`)
    if (i.state !== 'pending' && i.state !== 'outdated') throw validateError(`${script} is ${i.state.replaceAll('_', '')} on ${s.name}; only pending scripts can be recorded`)
    await record(s.c, s.scripts.find((x) => x.fileName === script)!, 0, true, s.schema, s.table, 'SQL')
    s.audit.scripts = () => [script]
    log('info', `Recorded ${script} as applied on ${s.name} without running it`)
  })
}

