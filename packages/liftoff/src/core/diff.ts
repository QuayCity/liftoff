// Comparing databases and writing migrations (C11, C12, F07): rebuild the scratch database from
// the scripts, compare dev with it, write the differences as the next migration (with its undo),
// capture a whole database, squash old scripts. Works on either engine through `Schema`.

import * as fs from 'node:fs'
import * as path from 'node:path'
import { saveEnvironment, type Config, type Environment, type Role } from './config.ts'
import { PHASES, type Change, type Step } from './changes.ts'
import { open, type Conn } from './db.ts'
import { configError } from './errors.ts'
import { nextVersion, parseName, scan, compareVersions, parseVersion } from './migration.ts'
import * as ms from './msdiff.ts'
import * as pgd from './pgdiff.ts'
import { PgConn, quoteIdent, withDatabase as pgWithDatabase } from './postgres.ts'
import * as runner from './runner.ts'
import { SqlServerConn, quote, withDatabase as msWithDatabase } from './sqlserver.ts'

/** A database's schema, read by the engine it runs on. */
export type Schema = { engine: 'pg'; model: pgd.Model } | { engine: 'ms'; model: ms.MsModel }

/** Changes that turn `target` into `source`, with undo steps. */
export function diffSchemas(source: Schema, target: Schema): Change[] {
  if (source.engine === 'pg' && target.engine === 'pg') return pgd.diff(source.model, target.model)
  if (source.engine === 'ms' && target.engine === 'ms') return ms.diff(source.model, target.model)
  return []
}

/** Everything, as changes against an empty database (capture, squash). */
export function createAll(s: Schema): Change[] {
  return s.engine === 'pg' ? pgd.compare(s.model, pgd.emptyModel()) : ms.createAll(s.model)
}

export function notComparedBetween(source: Schema, target: Schema, sourceName: string, targetName: string): string[] {
  return pgd.notCompared(source.model.not_compared, target.model.not_compared, sourceName, targetName)
}

/** The schema of the database `c` is connected to, with the project's filters applied. */
export async function modelOf(cfg: Config, c: Conn): Promise<Schema> {
  if (c instanceof PgConn) {
    const m = await pgd.introspect(c, cfg.project.schemas, cfg.project.history_table)
    pgd.applyFilters(m, cfg.project)
    return { engine: 'pg', model: m }
  }
  const m = await ms.introspect(c as SqlServerConn, cfg.project.schemas, cfg.project.history_table)
  ms.applyFilters(m, cfg.project)
  return { engine: 'ms', model: m }
}

/** Picks and checks the scratch environment: it gets erased. */
export function scratchEnv(cfg: Config, scratch: string | undefined): [string, Environment] {
  const [name, env] = cfg.pickRole(scratch, 'scratch')
  if (env.role !== 'scratch' && !env.allow_clean) {
    throw configError(`'${name}' has role '${env.role}' and allow_clean is off; refusing to rebuild it as a scratch database`)
  }
  return [name, env]
}

/** Erases the scratch database and runs the migrations into it (up to `target` when given). Close the result. */
export async function rebuildScratch(cfg: Config, name: string, env: Environment, target: string | undefined, log: runner.Log, skipRepeatables = false): Promise<Conn> {
  log('info', `Rebuilding scratch database '${name}' from migrations${target ? ` up to ${target}` : ''}`)
  const s = await open(name, env)
  try {
    await s.resetSchemas(cfg.project.schemas)
    await runner.migrate(cfg, name, { outOfOrder: true, target, allowNonEmpty: true, skipRepeatables }, log)
    return s
  } catch (e) {
    await s.close()
    throw e
  }
}

/** Runs `work` with a connection, then closes it. */
async function using<T>(c: Conn | Promise<Conn>, work: (c: Conn) => Promise<T>): Promise<T> {
  const conn = await c
  try {
    return await work(conn)
  } finally {
    await conn.close()
  }
}

export type ScratchCreated = { environment: string; database: string }

/**
 * Creates an empty database next to the dev database (`<dev db>_scratch`, same server and login)
 * and saves it as a private scratch environment. Never touches a database that already exists.
 */
export async function createScratch(cfg: Config, dev: string | undefined, envName: string): Promise<ScratchCreated> {
  const [devName, devEnv] = cfg.pickRole(dev, 'dev')
  if (cfg.environments.has(envName)) throw configError(`an environment named '${envName}' already exists`)
  const database = await using(open(devName, devEnv), async (c) => {
    const database = `${(await c.serverInfo()).database}_scratch`
    const taken = () => configError(`a database named ${database} already exists on ${devName}'s server; if it may be erased, add it as the scratch environment yourself`)
    const noRights = (needs: string) => configError(`${devName}'s login may not create databases (${needs}); ask an admin to create ${database}, then add it as the scratch environment`)
    if (c instanceof PgConn) {
      if ((await c.row('select exists (select 1 from pg_database where datname = $1)', [database]))[0] === true) throw taken()
      await c.batch(`CREATE DATABASE ${quoteIdent(database)}`).catch((e: { dbCode?: string }) => {
        throw e.dbCode === '42501' ? noRights('it needs CREATEDB') : e
      })
    } else {
      const sc = c as SqlServerConn
      if ((await sc.query('SELECT DB_ID(@P1)', [database]))[0]?.[0] != null) throw taken()
      await sc.batch(`CREATE DATABASE ${quote(database)}`).catch((e: { dbCode?: string }) => {
        throw e.dbCode === '262' ? noRights('it needs CREATE ANY DATABASE or dbcreator') : e
      })
    }
    return database
  })
  const url = devEnv.url.match(/^(jdbc:)?sqlserver:/i) ? msWithDatabase(devEnv.url, database) : pgWithDatabase(devEnv.url, database)
  saveEnvironment(cfg.root, envName, { url, user: devEnv.user, password: devEnv.password, role: 'scratch' as Role, allow_clean: true, placeholders: devEnv.placeholders }, false)
  return { environment: envName, database }
}

export type Comparison = {
  changes: Change[]
  /** objects that exist but are not compared, e.g. "rules: 2 in dev, 0 in the scripts" */
  not_compared: string[]
}

/** Rebuilds the scratch database from the project's migrations, then compares dev with it. */
export async function devVsMigrations(cfg: Config, dev: string | undefined, scratch: string | undefined, log: runner.Log = runner.quiet): Promise<Comparison> {
  const [devName, devEnv] = cfg.pickRole(dev, 'dev')
  const [scratchName, scratchEnvironment] = scratchEnv(cfg, scratch)
  if (devName === scratchName) throw configError('the dev and scratch environments must be different databases')
  return using(rebuildScratch(cfg, scratchName, scratchEnvironment, undefined, log), (s) =>
    using(open(devName, devEnv), async (d) => {
      if (d.engine !== s.engine) throw configError(`'${devName}' and '${scratchName}' are different database engines`)
      log('info', `Comparing '${devName}' with the migrations`)
      const [source, target] = [await modelOf(cfg, d), await modelOf(cfg, s)]
      const changes = diffSchemas(source, target)
      const notCompared = notComparedBetween(source, target, devName, 'the scripts')
      log('info', `${changes.length} difference(s)`)
      for (const n of notCompared) log('warn', `not compared: ${n}`)
      return { changes, not_compared: notCompared }
    }),
  )
}

/* ---------- writing scripts ---------- */

export type Generated = {
  file_name: string
  version: string
  sql: string
  /** the matching U script, when asked for */
  undo: { file_name: string; sql: string } | null
}

const kindWord = { added: 'Add', changed: 'Change', removed: 'Remove' } as const

function render(header: string, changes: Change[], stepsOf: (c: Change) => Step[]): string {
  let sql = `${header}\n`
  const summary = changes
    .map((c) => `--   ${kindWord[c.kind]} ${c.object_type.toLowerCase().replace(/s+$/, '')} ${c.name}${c.destructive ? ' (may lose data)' : ''}`)
    .sort()
  sql += `--\n${summary.join('\n')}\n`
  // SQL Server keeps the whole batch as a view's or procedure's text, comments too: the header
  // gets a batch of its own. (Its statements end in GO; PostgreSQL's do not.)
  if (changes.flatMap(stepsOf).some((s) => /\nGO\s*$/.test(s.sql))) sql += 'GO\n'
  const seen = new Set<string>()
  for (let phase = 0; phase < PHASES; phase++) {
    const steps = changes
      .flatMap(stepsOf)
      .filter((s) => s.phase === phase)
      .sort((a, b) => a.order - b.order)
    // A view recreated by two changes appears once.
    const stmts = steps.map((s) => s.sql).filter((s) => !seen.has(s) && seen.add(s))
    if (stmts.length) sql += `\n${stmts.join('\n')}\n`
  }
  return sql
}

/** The changes' SQL, phase by phase, under a header (Compare's sync script). */
export function renderScript(header: string, changes: Change[]): string {
  return render(header, changes, (c) => c.steps)
}

function checkDescription(description: string): string {
  const d = description.trim()
  if (!d || d.length > 120 || !/^[\p{L}\p{N} _-]+$/u.test(d)) throw configError('describe the migration in up to 120 letters, digits, spaces, - or _')
  return d
}

const slugOf = (d: string) => d.replace(/[ -]/g, '_')

/** The selected changes as the next versioned migration (not yet written to disk), plus its undo script when asked. */
export function generate(cfg: Config, changes: Change[], description: string, withUndo: boolean): Generated {
  if (!changes.length) throw configError('nothing selected to put in the migration')
  const desc = checkDescription(description)
  const version = nextVersion(scan(cfg.migrationsDir()), new Date())
  const slug = slugOf(desc)
  const sql = render(`-- ${desc}\n-- Written by LiftOff. Review before committing.`, changes, (c) => c.steps)
  const undo = withUndo
    ? { file_name: `U${version}__${slug}.sql`, sql: render(`-- Undo: ${desc}\n-- Written by LiftOff. Data removed by the migration is not restored.`, changes, (c) => c.undo_steps) }
    : null
  return { file_name: `V${version}__${slug}.sql`, version, sql, undo }
}

/** A hand-written script (C20): versioned gets the next version, repeatable gets `R__`. */
export function add(cfg: Config, repeatable: boolean, description: string, sql: string): string {
  const desc = slugOf(checkDescription(description))
  const fileName = repeatable ? `R__${desc}.sql` : `V${nextVersion(scan(cfg.migrationsDir()), new Date())}__${desc}.sql`
  return save(cfg, fileName, sql.trim() ? sql : `-- ${description.trim()}\n`)
}

/** Writes a script into the migrations folder; never overwrites. */
export function save(cfg: Config, fileName: string, sql: string): string {
  if (!parseName(fileName) || /[/\\]/.test(fileName)) throw configError(`'${fileName}' is not a valid migration file name`)
  const dir = cfg.migrationsDir()
  fs.mkdirSync(dir, { recursive: true })
  const file = path.join(dir, fileName)
  try {
    fs.writeFileSync(file, sql, { flag: 'wx' })
  } catch (e) {
    if ((e as { code?: string }).code === 'EEXIST') throw configError(`${fileName} already exists`)
    throw e
  }
  // Scan again so a duplicate version is caught now, not at the next migrate.
  try {
    scan(dir)
  } catch (e) {
    fs.rmSync(file)
    throw e
  }
  return file
}

/** The latest version applied (or baselined) on an environment. */
async function appliedVersion(cfg: Config, env: string): Promise<string | undefined> {
  return (await runner.info(cfg, env))
    .filter((i) => i.state === 'applied' || i.state === 'baseline')
    .map((i) => i.version)
    .filter((v): v is string => v !== null)
    .sort((a, b) => compareVersions(parseVersion(a), parseVersion(b)))
    .at(-1)
}

/**
 * The whole schema of an existing database as one script (F07): the next V script by default
 * (then baseline that database at its version, so it never runs there). With `asBaseline`, a B
 * script that empty databases start from, versioned at the database's latest applied version.
 */
export async function capture(cfg: Config, envName: string | undefined, description: string, asBaseline: boolean): Promise<Generated> {
  const [name, env] = cfg.pick(envName)
  const changes = await using(open(name, env), async (c) => createAll(await modelOf(cfg, c)))
  if (!changes.length) throw configError(`'${name}' has nothing in ${cfg.project.schemas.join(', ')} to capture`)
  const g = generate(cfg, changes, description, false)
  if (asBaseline) {
    g.version = (await appliedVersion(cfg, name)) ?? g.version
    g.file_name = `B${g.version}__${slugOf(checkDescription(description))}.sql`
  }
  return g
}

/**
 * Squash: one B script with the schema the versioned scripts build up to `upTo` (all of them when
 * not given). Empty databases start from it; databases with history keep running the V scripts.
 * Before it is kept, scratch built the old way and scratch built from the new B script must match.
 */
export async function squash(cfg: Config, upTo: string | undefined, description: string, scratch: string | undefined, dryRun: boolean, log: runner.Log = runner.quiet): Promise<{ generated: Generated; path: string | null }> {
  const slug = slugOf(checkDescription(description))
  const [name, env] = scratchEnv(cfg, scratch)
  if (cfg.usesPlaceholders()) log('warn', `placeholders are written into the script with the values of '${name}'; check them before committing`)
  log('info', `Building '${name}' from the versioned scripts${upTo ? ` up to ${upTo}` : ''}`)
  const { changes, applied } = await using(open(name, env), async (s) => {
    await s.resetSchemas(cfg.project.schemas)
    const r = await runner.migrate(cfg, name, { outOfOrder: true, target: upTo, allowNonEmpty: true, skipRepeatables: true }, log)
    return { changes: createAll(await modelOf(cfg, s)), applied: r.applied.length }
  })
  const version = await appliedVersion(cfg, name)
  if (!version) throw configError('there are no versioned scripts to squash')
  const g = generate(cfg, changes, description, false)
  g.file_name = `B${version}__${slug}.sql`
  g.version = version
  g.sql = `-- Squashed from the versioned scripts up to ${version} (${applied} script(s) applied to build it).\n-- Empty databases start here; databases that already have history keep running the V scripts.\n${g.sql}`
  if (dryRun) return { generated: g, path: null }

  const before = await using(rebuildScratch(cfg, name, env, undefined, log), (s) => modelOf(cfg, s))
  const file = save(cfg, g.file_name, g.sql)
  log('info', `Checking: rebuilding '${name}' from ${g.file_name}`)
  try {
    const after = await using(rebuildScratch(cfg, name, env, undefined, log), (s) => modelOf(cfg, s))
    const left = diffSchemas(before, after)
    if (left.length) throw configError(`the squashed script does not build the same schema (${left.map((c) => c.id).join(', ')}); it was not kept`)
  } catch (e) {
    fs.rmSync(file, { force: true })
    throw e
  }
  return { generated: g, path: file }
}
