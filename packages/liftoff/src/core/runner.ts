// Running migrations: info (C03), migrate (C04), undo (C09), validate (C05), baseline (C06),
// repair (C07), clean (C08) and recording a script as applied. The same code serves PostgreSQL
// and SQL Server; the differences live behind `Conn` (db.ts).

import type { Config, Environment } from './config.ts'
import { configError, DbError, MigrationError, notBaselinedError, validateError } from './errors.ts'
import { dialect, open, type Conn, type EngineName, type Held, type HistoryRow } from './db.ts'
import { applyPlaceholders, compareVersions, parseVersion, scan, type Kind, type Script, type Version } from './migration.ts'
import { quoteIdent } from './postgres.ts'
import { quote as quoteTsql } from './sqlserver.ts'

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
}

export type Level = 'info' | 'warn'

/** Progress messages: the CLI writes them to stderr, the desktop app and the extension show them. */
export type Log = (level: Level, message: string) => void

export const quiet: Log = () => {}

const ver = (r: HistoryRow) => (r.version === null ? undefined : parseVersion(r.version))

/** Each script's state, from the files and the history table. */
export function compute(scripts: Script[], allRows: HistoryRow[]): MigrationInfo[] {
  // Flyway's schema-creation marker is bookkeeping, not a migration.
  const rows = allRows.filter((r) => r.type !== 'SCHEMA')
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
    const state: State = !row ? 'pending' : !row.success ? 'failed' : row.checksum === s.checksum ? 'applied' : 'outdated'
    out.push({
      kind: 'repeatable',
      version: null,
      description: s.description,
      script: s.fileName,
      state,
      installed_on: row?.installed_on ?? null,
      execution_time_ms: row?.execution_time ?? null,
      checksum_mismatch: false,
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
  return withEnv(cfg, envName, async (c) => compute(scripts, await c.readHistory(cfg.historySchema(), cfg.project.history_table)))
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
}

const waiting = (log: Log) => () => log('info', 'Another run holds the lock on this database; waiting')

/** Validates, then applies pending versioned scripts in order, then new or changed repeatables. */
export async function migrate(cfg: Config, envName: string | undefined, opts: MigrateOptions = {}, log: Log = quiet): Promise<MigrateResult> {
  const started = Date.now()
  let target: Version | undefined
  if (opts.target !== undefined) {
    target = parseVersion(opts.target)
    if (!target) throw configError(`target '${opts.target}' must be numbers separated by . or _`)
  }
  if (opts.only && opts.target !== undefined) throw configError('use --only or --target, not both')
  const scripts = scan(cfg.migrationsDir())
  // Placeholder values are checked before anything runs (an unset variable fails here).
  if (cfg.usesPlaceholders()) cfg.placeholders(cfg.pick(envName)[0])
  return withEnv(cfg, envName, async (c, name, env) => {
    const s = await c.serverInfo()
    log('info', `Connected to ${name} (${s.database} as ${s.user}, ${c.engine} ${s.version})`)
    const [schema, table] = [cfg.historySchema(), cfg.project.history_table]
    if (opts.dryRun) {
      const result = dryRun(cfg, c.engine, name, scripts, await c.readHistory(schema, table), opts, target)
      result.execution_time_ms = Date.now() - started
      return result
    }
    const held = await c.lock(schema, table, cfg.project.lock, waiting(log), () => open(name, env))
    let result: MigrateResult
    try {
      result = await migrateLocked(c, cfg, name, scripts, opts, target, log)
    } finally {
      // Released on failure too (a dropped connection or an expired lease would free it as well).
      await held.release()
    }
    result.execution_time_ms = Date.now() - started
    return result
  })
}

/** The scripts migrate would run, in order. */
function plan(infos: MigrationInfo[], opts: MigrateOptions, target: Version | undefined): MigrationInfo[] {
  if (opts.only) return picked(infos, opts.only)
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

function dryRun(cfg: Config, engine: EngineName, name: string, scripts: Script[], rows: HistoryRow[], opts: MigrateOptions, target: Version | undefined): MigrateResult {
  const d = dialect[engine]
  const q = engine === 'SQL Server' ? quoteTsql : quoteIdent
  let infos = compute(scripts, rows)
  validate(infos, { ...opts, outOfOrder: opts.outOfOrder || !!opts.only })
  const [schema, table] = [q(cfg.historySchema()), q(cfg.project.history_table)]
  let sql = `-- Dry run for ${name}: nothing below has been executed.\n-- History table: ${schema}.${table}\n`
  const result: MigrateResult = { environment: name, applied: [], execution_time_ms: 0, dry_run_sql: null }
  const b = rows.length === 0 && !opts.only ? baselineScript(scripts, target) : undefined
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
      `INSERT INTO ${schema}.${table} (installed_rank, version, description, type, script, checksum, installed_by, execution_time, success)\n` +
      `  SELECT coalesce(max(installed_rank), 0) + 1, ${version}, '${esc(s.description)}', 'SQL', '${esc(s.fileName)}', ${s.checksum}, ${d.currentUser}, 0, ${d.true} FROM ${schema}.${table};`
    sql += `\n-- ${s.fileName}${transactional ? '' : ' (runs outside a transaction)'}\n`
    const body = sqlFor(cfg, name, s).trimEnd()
    sql += transactional ? `${d.begin};\n${body}\n${record}\nCOMMIT;\n` : `${body}\n${record}\n`
    result.applied.push({ script: s.fileName, version: s.version?.text ?? null, execution_time_ms: 0, transactional })
  }
  if (!result.applied.length) sql += '\n-- Nothing pending.\n'
  result.dry_run_sql = sql
  return result
}

async function migrateLocked(c: Conn, cfg: Config, name: string, scripts: Script[], opts: MigrateOptions, target: Version | undefined, log: Log): Promise<MigrateResult> {
  const [schema, table] = [cfg.historySchema(), cfg.project.history_table]
  await c.ensureHistory(schema, table)
  let rows = await c.readHistory(schema, table)
  const result: MigrateResult = { environment: name, applied: [], execution_time_ms: 0, dry_run_sql: null }

  // Scripts that create what already exists fail half-way; ask for a baseline instead.
  // (--only never builds from a B script: it runs what it names.)
  const useBaseline = !opts.only
  if (!rows.length && !opts.allowNonEmpty && !(useBaseline && baselineScript(scripts, target)) && (await c.userObjects(cfg.project.schemas, table)) > 0) {
    throw notBaselinedError(name)
  }

  // A database without any history starts from the latest B script, when there is one.
  const b = rows.length === 0 && useBaseline ? baselineScript(scripts, target) : undefined
  if (b) {
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
  const infos = compute(scripts, rows)
  // Being older than what ran stops a plain migrate; with --only, only the picked scripts run.
  validate(infos, { ...opts, outOfOrder: opts.outOfOrder || !!opts.only })

  const todo = plan(infos, opts, target)
  if (opts.only) {
    result.left_behind = leftBehind(infos, todo)
    if (result.left_behind.length) {
      log('warn', `Not run, and older than what ran: ${result.left_behind.join(', ')}. A plain migrate now needs --out-of-order to run them.`)
    }
  }
  if (!todo.length && !result.applied.length) log('info', `${name} is up to date`)
  for (const i of todo) {
    const s = scripts.find((s) => s.fileName === i.script)!
    const transactional = !dialect[c.engine].needsNoTransaction(s.sql)
    if (!transactional) log('warn', `${s.fileName} runs outside a transaction; if it fails part-way it cannot be rolled back`)
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
  return result
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
  return withSession(cfg, envName, log, async (s) => {
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

/** A locked connection with the history table in place. */
type Session = { c: Conn; name: string; schema: string; table: string; scripts: Script[]; rows: HistoryRow[] }

async function withSession<T>(cfg: Config, envName: string | undefined, log: Log, work: (s: Session) => Promise<T>): Promise<T> {
  const scripts = scan(cfg.migrationsDir())
  return withEnv(cfg, envName, async (c, name, env) => {
    const [schema, table] = [cfg.historySchema(), cfg.project.history_table]
    const held: Held = await c.lock(schema, table, cfg.project.lock, waiting(log), () => open(name, env))
    try {
      await c.ensureHistory(schema, table)
      return await work({ c, name, schema, table, scripts, rows: await c.readHistory(schema, table) })
    } finally {
      await held.release()
    }
  })
}

/** Marks an existing database as being at `version`, so scripts up to it never run there. */
export async function baseline(cfg: Config, envName: string | undefined, version: string, description: string, log: Log = quiet): Promise<void> {
  if (!parseVersion(version)) throw configError(`baseline version '${version}' must be numbers separated by . or _`)
  await withSession(cfg, envName, log, async (s) => {
    if (s.rows.length) throw validateError(`${s.name} already has migration history; baseline only applies to a database without any`)
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
  return withSession(cfg, envName, log, async (s) => {
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
    log('info', `Repair: ${report.removed_failed.length} failed row(s) removed, ${report.realigned.length} checksum(s) updated, ${report.forgotten.length} missing script(s) forgotten`)
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
      await c.resetSchemas(cfg.project.schemas)
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
  await withSession(cfg, envName, log, async (s) => {
    const i = compute(s.scripts, s.rows).find((i) => i.script === script)
    if (!i) throw configError(`no script named ${script} in the migrations folder`)
    if (i.state !== 'pending' && i.state !== 'outdated') throw validateError(`${script} is ${i.state.replaceAll('_', '')} on ${s.name}; only pending scripts can be recorded`)
    await record(s.c, s.scripts.find((x) => x.fileName === script)!, 0, true, s.schema, s.table, 'SQL')
    log('info', `Recorded ${script} as applied on ${s.name} without running it`)
  })
}

