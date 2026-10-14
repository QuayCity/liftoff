// Switching from Flyway (F12): convert flyway.toml / flyway.conf into liftoff.toml, and import a
// database's flyway_schema_history once into LiftOff's own history table.
// Built from Flyway's publicly documented config keys and history columns only.

import * as fs from 'node:fs'
import * as path from 'node:path'
import { parse } from 'smol-toml'
import { Config, defaultSchemas, initWith, PROJECT_FILE, redactUrl, saveEnvironment, saveProject, type Role } from './config.ts'
import { open, type HistoryRow } from './db.ts'
import { configError, validateError } from './errors.ts'
import { compareVersions, parseVersion, scan } from './migration.ts'
import { PgConn, quoteIdent } from './postgres.ts'
import { quiet, type Log } from './runner.ts'
import { keychainEnabled } from './keychain.ts'

export const DEFAULT_TABLE = 'flyway_schema_history'

/** Which Flyway config files a folder has. */
export function detect(root: string): string[] {
  return ['flyway.toml', 'flyway.conf', 'conf/flyway.toml', 'conf/flyway.conf'].map((f) => path.join(root, f)).filter((p) => fs.existsSync(p))
}

export type ConvertReport = {
  source: string
  /** every Flyway config file in the folder; `source` is the one used */
  sources: string[]
  written: string
  environments: string[]
  migrations: string
  schemas: string[]
  /** Flyway's history table name, for the history import */
  flyway_table: string
  /** settings LiftOff did not carry over, each with the reason */
  not_converted: string[]
  notes: string[]
  /** each environment brought over (or, in a preview, that would be): no passwords */
  planned: { name: string; role: Role; url: string; user: string | null; has_password: boolean; skipped: boolean }[]
  /** a preview: nothing was written */
  preview: boolean
}

export type ConvertOptions = {
  /** which Flyway config file (default: flyway.toml before flyway.conf) */
  source?: string
  /** only these environments, by their LiftOff name (default: all) */
  only?: string[]
  /** a role per environment, instead of the guess from its name */
  roles?: Record<string, Role>
  /** work out the report without writing anything */
  preview?: boolean
}

/** Everything read from either format, before liftoff.toml is written. */
type Parsed = {
  envs: [string, Map<string, string>][]
  /** flyway.* settings, flattened: "locations", "schemas", "table", "placeholders.x" … */
  settings: Map<string, string>
}

/** flyway.conf: Java properties with `flyway.` keys. */
function parseConf(text: string): Parsed {
  const settings = new Map<string, string>()
  let pending = ''
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    if (!pending && (!line || line.startsWith('#') || line.startsWith('!'))) continue
    // A trailing backslash continues the value on the next line.
    if (line.endsWith('\\')) {
      pending += line.slice(0, -1)
      continue
    }
    const entry = pending + line
    pending = ''
    const i = entry.search(/[=:]/)
    if (i < 0) continue
    const k = entry.slice(0, i).trim()
    settings.set(k.startsWith('flyway.') ? k.slice(7) : k, entry.slice(i + 1).trim())
  }
  const env = new Map<string, string>()
  for (const k of ['url', 'user', 'password', 'schemas']) {
    const v = settings.get(k)
    if (v !== undefined) {
      env.set(k, v)
      settings.delete(k)
    }
  }
  return { envs: env.size ? [['default', env]] : [], settings: sortedMap(settings) }
}

const asText = (v: unknown): string => (typeof v === 'string' ? v : Array.isArray(v) ? v.map((x) => (typeof x === 'string' ? x : String(x))).join(',') : String(v))
const isTable = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v) && !(v instanceof Date)

function flatten(prefix: string, t: Record<string, unknown>, out: Map<string, string>): void {
  for (const [k, v] of Object.entries(t)) {
    const key = prefix ? `${prefix}.${k}` : k
    if (isTable(v)) flatten(key, v, out)
    else out.set(key, asText(v))
  }
}

const sortedMap = (m: Map<string, string>) => new Map([...m].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))

/** flyway.toml: `[environments.<name>]` plus `[flyway]` settings. */
function parseToml(text: string): Parsed {
  let t: Record<string, unknown>
  try {
    t = parse(text) as Record<string, unknown>
  } catch (e) {
    throw configError(`flyway.toml: ${e instanceof Error ? e.message : e}`)
  }
  const p: Parsed = { envs: [], settings: new Map() }
  if (isTable(t.environments)) {
    for (const [name, e] of Object.entries(t.environments).sort(([a], [b]) => (a < b ? -1 : 1))) {
      const fields = new Map<string, string>()
      if (isTable(e)) flatten('', e, fields)
      p.envs.push([name, sortedMap(fields)])
    }
  }
  // [flyway] keys stay bare ("locations"); other sections keep their name ("flywayDesktop.shadowEnvironment").
  for (const [section, v] of Object.entries(t)) {
    if (section === 'environments') continue
    if (isTable(v)) flatten(section === 'flyway' ? '' : section, v, p.settings)
    else p.settings.set(section, asText(v))
  }
  p.settings = sortedMap(p.settings)
  return p
}

/** `jdbc:postgresql://…` becomes `postgres://…`; `jdbc:sqlserver://…;props` keeps its form without `jdbc:`. */
export function jdbcToUrl(jdbc: string): string | undefined {
  const j = jdbc.trim()
  if (j.startsWith('jdbc:sqlserver:')) return `sqlserver:${j.slice('jdbc:sqlserver:'.length)}`
  if (!j.startsWith('jdbc:postgresql:')) return undefined
  const rest = j.slice('jdbc:postgresql:'.length)
  return `postgres://${rest.startsWith('//') ? rest.slice(2) : rest}`
}

function roleFor(name: string, desktop: Map<string, string>): Role {
  const lower = name.toLowerCase()
  if (desktop.get('developmentEnvironment') === name || lower.startsWith('dev')) return 'dev'
  if (desktop.get('shadowEnvironment') === name || lower.includes('shadow') || lower.includes('scratch')) return 'scratch'
  if (lower.includes('prod')) return 'prod'
  return 'test'
}

/** Flyway writes environment variables as `${env.NAME}` (toml) or `${NAME}` (conf); LiftOff uses `${env.NAME}`. */
export function interpolateFlyway(v: string): string {
  return v.replace(/\$\{([^}]*)\}/g, (_, k: string) => `\${env.${k.startsWith('env.') ? k.slice(4) : k}}`)
}

/**
 * Writes liftoff.toml (and credentials to the keychain or the user file) from the folder's Flyway
 * config. The Flyway files are left untouched; refuses when liftoff.toml already exists.
 */
export function convert(root: string, name: string, useKeychain = keychainEnabled(), o: ConvertOptions = {}): ConvertReport {
  const found = detect(root)
  let source = found.find((p) => p.endsWith('.toml')) ?? found[0]
  if (!source) throw configError(`no flyway.toml or flyway.conf in ${root}`)
  if (o.source !== undefined) {
    const chosen = path.resolve(root, o.source)
    if (!found.includes(chosen)) throw configError(`${o.source} is not one of the Flyway config files here: ${found.map((f) => path.relative(root, f)).join(', ')}`)
    source = chosen
  }
  const write = !o.preview
  if (fs.existsSync(path.join(root, PROJECT_FILE))) throw configError(`${PROJECT_FILE} already exists; remove it to convert again`)
  const text = fs.readFileSync(source, 'utf8')
  const p = source.endsWith('.toml') ? parseToml(text) : parseConf(text)
  const r: ConvertReport = { source, sources: found, written: '', environments: [], migrations: '', schemas: [], flyway_table: '', not_converted: [], notes: [], planned: [], preview: !write }
  for (const other of found.filter((f) => f !== source)) r.notes.push(`${other} was also found and was not merged; ${source} was used`)

  const desktop = new Map([...p.settings].filter(([k]) => k.startsWith('flywayDesktop.')).map(([k, v]) => [k.slice('flywayDesktop.'.length), v]))
  const take = (k: string) => {
    const v = p.settings.get(k)
    p.settings.delete(k)
    return v
  }

  // The migrations folder: the first filesystem location.
  const locations = (take('locations') ?? '').split(',').map((s) => s.trim()).filter(Boolean)
  let folder: string | undefined
  for (const l of locations) {
    if (!l.startsWith('filesystem:')) r.not_converted.push(`locations ${l}: only filesystem: locations are supported (classpath and cloud locations are not)`)
    else if (folder === undefined) folder = l.slice('filesystem:'.length).replace(/^(\.\/)+/, '')
    else r.not_converted.push(`locations ${l}: LiftOff reads one migrations folder (${folder}); move ${l.slice('filesystem:'.length)} into it`)
  }
  if (folder === undefined) r.notes.push("no filesystem location set; using Flyway's default folder `sql`")
  r.migrations = folder ?? 'sql'

  r.flyway_table = take('table') ?? DEFAULT_TABLE
  const defaultSchemaSetting = take('defaultSchema')
  let schemas = (take('schemas') ?? '').split(',').map((s) => s.trim()).filter(Boolean)
  // Environment-level schemas apply when the global setting is absent.
  const envSchemas = p.envs.find(([, e]) => e.has('schemas'))
  if (!schemas.length && envSchemas) schemas = envSchemas[1].get('schemas')!.split(',').map((s) => s.trim())
  const engine = p.envs.some(([, e]) => e.get('url')?.trim().startsWith('jdbc:sqlserver:')) ? 'sqlserver' : 'postgresql'
  if (defaultSchemaSetting) schemas = [defaultSchemaSetting, ...schemas.filter((s) => s !== defaultSchemaSetting)]
  if (!schemas.length) schemas.push(...defaultSchemas(engine))
  r.schemas = schemas
  const cleanAllowed = take('cleanDisabled')?.toLowerCase() === 'false'
  take('environment')
  const placeholders = Object.fromEntries([...p.settings].filter(([k]) => k.startsWith('placeholders.')).map(([k, v]) => [k.slice('placeholders.'.length), interpolateFlyway(v)]))
  for (const k of [...p.settings.keys()]) if (k.startsWith('placeholders.')) p.settings.delete(k)

  // Settings understood but not needed, and ones that cannot be carried over.
  for (const [k, v] of p.settings) {
    let reason: string
    if (k.startsWith('flywayDesktop.') || k.startsWith('redgateCompare.') || ['id', 'name', 'databaseType'].includes(k)) continue
    if (k.startsWith('placeholder')) reason = 'LiftOff always replaces `${name}` placeholders, with Flyway\'s default `${` `}` markers'
    else if (k.startsWith('callbacks')) reason = 'callbacks are not supported; turn them into scripts'
    else if (k.startsWith('javaMigrations') || k.startsWith('resolvers')) reason = 'Java migrations and resolvers need a JVM; they are not supported'
    else if (['sqlMigrationPrefix', 'repeatableSqlMigrationPrefix', 'undoSqlMigrationPrefix', 'sqlMigrationSeparator', 'sqlMigrationSuffixes'].includes(k)) {
      reason = 'LiftOff uses the standard V/R/U/B prefixes, `__` and `.sql`; rename the files'
    } else if (['outOfOrder', 'target', 'validateOnMigrate', 'ignoreMigrationPatterns', 'mixed', 'group'].includes(k)) reason = 'a per-run option in LiftOff; pass it on the command line'
    else if (['baselineOnMigrate', 'baselineVersion', 'baselineDescription'].includes(k)) reason = 'use `liftoff baseline` once per database instead'
    else reason = 'not used by LiftOff'
    r.not_converted.push(`${k} = ${v}: ${reason}`)
  }

  if (write) {
    initWith(root, name, engine, r.migrations, schemas)
    // Flyway's history table stays in the databases; it is not part of the schema to compare or migrate.
    const filters = [{ action: 'exclude' as const, object: 'table', pattern: r.flyway_table }]
    saveProject(root, { ...Config.load(root).project, placeholders, filters })
  }
  r.notes.push(`${r.flyway_table} is left out of comparisons (a filter in liftoff.toml), so no migration creates or drops it`)
  if (r.flyway_table !== DEFAULT_TABLE) r.notes.push(`Flyway's history table is ${r.flyway_table}; pass it to the history import`)

  for (const [envName, fields] of p.envs) {
    const jdbc = fields.get('url')
    if (jdbc === undefined) {
      r.not_converted.push(`environment ${envName}: no url`)
      continue
    }
    const url = jdbcToUrl(interpolateFlyway(jdbc))
    if (url === undefined) {
      r.not_converted.push(`environment ${envName}: ${jdbc}: LiftOff supports PostgreSQL and SQL Server`)
      continue
    }
    const saveName = envName === 'default' ? 'default' : envName.replace(/[^A-Za-z0-9_-]/g, '_')
    const role = o.roles?.[saveName] ?? roleFor(envName, desktop)
    const user = fields.get('user')
    const password = fields.get('password')
    const envPlaceholders = Object.fromEntries([...fields].filter(([k]) => k.startsWith('placeholders.')).map(([k, v]) => [k.slice('placeholders.'.length), interpolateFlyway(v)]))
    const skipped = o.only !== undefined && !o.only.includes(saveName)
    r.planned.push({ name: saveName, role, url: redactUrl(url), user: user ?? null, has_password: password !== undefined || redactUrl(url) !== url, skipped })
    if (skipped || !write) continue
    saveEnvironment(
      root,
      saveName,
      {
        url,
        user: user === undefined ? undefined : interpolateFlyway(user),
        password: password === undefined ? undefined : interpolateFlyway(password),
        role,
        allow_clean: cleanAllowed && role !== 'prod',
        placeholders: envPlaceholders,
      },
      true,
      useKeychain,
    )
    for (const k of fields.keys()) {
      if (!['url', 'user', 'password', 'schemas'].includes(k) && !k.startsWith('placeholders.')) r.not_converted.push(`environments.${envName}.${k}: not used by LiftOff`)
    }
    r.environments.push(saveName)
  }
  for (const n of [...(o.only ?? []), ...Object.keys(o.roles ?? {})]) {
    if (!r.planned.some((p) => p.name === n)) throw configError(`the Flyway config has no environment '${n}'; it has: ${r.planned.map((p) => p.name).join(', ') || 'none'}`)
  }
  r.written = write ? path.join(root, PROJECT_FILE) : ''
  return r
}

/* ---------- one-time history import ---------- */

export type HistoryImport = {
  environment: string
  imported: number
  /** Flyway rows LiftOff has no use for (schema-creation markers) */
  skipped: string[]
  /** applied scripts whose files changed since they ran (the import refuses unless accepted) */
  edited: string[]
  /** rows that need a decision afterwards (e.g. Java migrations without a .sql file) */
  attention: string[]
}

/**
 * Copies `<schema>.<fromTable>` into LiftOff's history table on one environment. Refuses when
 * LiftOff already has history there, or when applied scripts were edited (unless `acceptEdited`,
 * which stores the current files' checksums). Flyway's table is left untouched.
 */
export async function importHistory(cfg: Config, envName: string | undefined, fromTable: string, acceptEdited: boolean, log: Log = quiet): Promise<HistoryImport> {
  const [name, env] = cfg.pick(envName)
  const [schema, table] = [cfg.historySchema(), cfg.project.history_table]
  if (fromTable === table) throw configError("the Flyway table and LiftOff's history table must have different names")
  const conn = await open(name, env)
  if (!(conn instanceof PgConn)) {
    await conn.close()
    throw configError("importing Flyway history works on PostgreSQL only for now; on SQL Server, baseline the database at Flyway's latest version instead")
  }
  const c = conn
  const held = await c.lock(schema, table, cfg.project.lock, () => log('info', 'Another run holds the lock on this database; waiting'), () => open(name, env))
  try {
    if (!(await c.historyExists(schema, fromTable))) throw configError(`${name} has no ${schema}.${fromTable}`)
    await c.ensureHistory(schema, table)
    if ((await c.readHistory(schema, table)).length) throw validateError(`${name} already has LiftOff history; the import only runs once`)
    const rows = await c.readHistory(schema, fromTable)
    const scripts = scan(cfg.migrationsDir())
    const report: HistoryImport = { environment: name, imported: 0, skipped: [], edited: [], attention: [] }
    const out: HistoryRow[] = []
    for (const original of rows) {
      const r = { ...original }
      if (r.type === 'SCHEMA') {
        report.skipped.push(`rank ${r.installed_rank}: ${r.script} (schema creation marker)`)
        continue
      }
      // A baseline migration (B script) puts the database at its version.
      if (r.type === 'SQL_BASELINE') r.type = 'BASELINE'
      if (['JDBC', 'SPRING_JDBC', 'SCRIPT', 'CUSTOM', 'UNDO_JDBC', 'UNDO_SCRIPT'].includes(r.type)) {
        report.attention.push(`${r.script} (${r.type}): not a .sql script; if it is retired, \`liftoff repair\` marks it as forgotten`)
      }
      if (r.success && (r.type === 'SQL' || r.type === 'UNDO_SQL')) {
        const base = r.script.split(/[/\\]/).at(-1)
        const v = r.version === null ? undefined : parseVersion(r.version)
        const file = scripts.find((s) => s.fileName === base && (s.kind === 'repeatable' || (v && compareVersions(s.version, v) === 0)))
        if (file && r.checksum !== file.checksum) {
          report.edited.push(`${file.fileName}: ran with checksum ${r.checksum ?? 0}, the file now has ${file.checksum}`)
          if (acceptEdited) r.checksum = file.checksum
        }
        // Flyway stores the path relative to the location; LiftOff stores the file name.
        if (file) r.script = file.fileName
      }
      out.push(r)
    }
    if (report.edited.length && !acceptEdited) {
      throw validateError(`scripts changed after they ran on ${name}:\n${report.edited.join('\n')}\nRestore them, or import with --accept-edited to keep the current files`)
    }
    const t = `${quoteIdent(schema)}.${quoteIdent(table)}`
    await c.batch('BEGIN')
    try {
      for (const r of out) {
        await c.rows(
          `insert into ${t} (installed_rank, version, description, type, script, checksum, installed_by, installed_on, execution_time, success)
           values ($1, $2, $3, $4, $5, $6, $7, to_timestamp($8, 'YYYY-MM-DD"T"HH24:MI:SS"Z"') at time zone 'UTC', $9, $10)`,
          [r.installed_rank, r.version, r.description, r.type, r.script, r.checksum, r.installed_by, r.installed_on, r.execution_time, r.success],
        )
      }
    } catch (e) {
      await c.batch('ROLLBACK').catch(() => {})
      throw e
    }
    await c.batch('COMMIT')
    report.imported = out.length
    log('info', `Imported ${out.length} history row(s) from ${schema}.${fromTable} into ${schema}.${table} on ${name}; Flyway's table was left as it was`)
    return report
  } finally {
    await held.release()
    await c.close()
  }
}
