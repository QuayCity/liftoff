// The runner's view of a database: one connection, whichever engine it is. Each engine
// (postgres.ts, sqlserver.ts, …) implements the same small set of operations, so the runner
// (runner.ts) has no engine-specific code. ENGINES lists them; engines.ts has their schema diffs.

import type { Environment, LockMode } from './config.ts'
import { configError, connectError } from './errors.ts'
import { needsNoTransaction, tsqlNeedsNoTransaction } from './migration.ts'

/** As liftoff.toml names it (`engine = "postgresql"`). */
export type EngineId = 'postgresql' | 'sqlserver'
/** As people read it. */
export type EngineName = 'PostgreSQL' | 'SQL Server'

export type ServerInfo = { version: string; user: string; database: string }

/** One row of the history table, as the CLI prints it. */
export type HistoryRow = {
  installed_rank: number
  version: string | null
  description: string
  type: string
  script: string
  checksum: number | null
  installed_by: string
  installed_on: string
  execution_time: number
  success: boolean
}

export type NewRow = {
  version: string | null
  description: string
  type: string
  script: string
  checksum: number | null
  executionTime: number
  success: boolean
}

/**
 * One run against a database (migrate, undo, repair, …), in `<history table>_activity`: who ran
 * it, from where, and what it did. The history table stays as it is (one row per script).
 */
export type Activity = {
  /** the deployment id */
  id: string
  operation: string
  started_on: string
  execution_time: number
  success: boolean
  /** the database user */
  installed_by: string
  os_user: string
  host: string
  /** the CI run's page, when it ran in a pipeline */
  pipeline: string | null
  git_commit: string | null
  scripts: string[]
  /** the error, or what the run did besides scripts */
  detail: string | null
}

export type NewActivity = Omit<Activity, 'installed_by'>

/** The activity table that goes with a history table. */
export const activityTable = (history: string) => `${history}_activity`

/** LiftOff's own tables, left out of drift, compare and "does this database have objects". */
export const ownTables = (history: string) => [history, `${history}_lock`, activityTable(history)]

/** A row of `select id, operation, started_on (ISO), execution_time, success, installed_by, os_user, host, pipeline, git_commit, scripts, detail`. */
export function activityRow(r: unknown[]): Activity {
  return {
    id: r[0] as string,
    operation: r[1] as string,
    started_on: new Date(r[2] as string).toISOString(),
    execution_time: r[3] as number,
    success: r[4] === true || r[4] === 1,
    installed_by: r[5] as string,
    os_user: r[6] as string,
    host: r[7] as string,
    pipeline: (r[8] as string | null) ?? null,
    git_commit: (r[9] as string | null) ?? null,
    scripts: (r[10] as string).split('\n').filter(Boolean),
    detail: (r[11] as string | null) ?? null,
  }
}

/** A held run lock; give it back with `release`. */
export type Held = { release(): Promise<void> }

export interface Conn {
  readonly engine: EngineName
  serverInfo(): Promise<ServerInfo>
  /**
   * Waits (polling) until no other run holds the lock on this database. `reopen` gives a second
   * connection where the lock needs one (the PostgreSQL lease is renewed on it).
   */
  lock(schema: string, table: string, mode: LockMode, onWait: () => void, reopen?: () => Promise<Conn>): Promise<Held>
  /** A control statement or a whole batch as is: BEGIN, COMMIT, ROLLBACK, a script body. */
  batch(sql: string): Promise<void>
  /** A migration script: one batch (PostgreSQL), statement by statement outside a transaction, or GO batches (SQL Server). */
  script(sql: string, transactional: boolean): Promise<void>
  ensureHistory(schema: string, table: string): Promise<void>
  readHistory(schema: string, table: string): Promise<HistoryRow[]>
  /** Runs inside the caller's lock, so max()+1 cannot race. */
  insertHistory(schema: string, table: string, row: NewRow): Promise<void>
  ensureActivity(schema: string, table: string): Promise<void>
  insertActivity(schema: string, table: string, a: NewActivity): Promise<void>
  /** Newest first; none when the table does not exist yet. */
  readActivity(schema: string, table: string, limit: number): Promise<Activity[]>
  /** Objects in the managed schemas besides LiftOff's own: a database with any and no history needs a baseline. */
  userObjects(schemas: string[], table: string): Promise<number>
  /** Removes failed rows; returns their scripts. */
  deleteFailed(schema: string, table: string): Promise<string[]>
  realign(schema: string, table: string, rank: number, checksum: number, description: string): Promise<void>
  /** Erases every object in the schemas. */
  resetSchemas(schemas: string[]): Promise<void>
  close(): Promise<void>
}

export function isSqlServerUrl(url: string): boolean {
  return /^(jdbc:)?sqlserver:\/\//i.test(url.trim())
}

/** What the runner needs to know about an engine, and how to connect to it. */
export type EngineInfo = {
  id: EngineId
  name: EngineName
  /** its key in snapshot files */
  tag: string
  /** whether a connection URL is for this engine */
  matches: (url: string) => boolean
  /** a connection URL, for messages and examples */
  example: string
  // The bits of SQL the runner writes itself (dry runs, transactions).
  begin: string
  currentUser: string
  true: string
  needsNoTransaction: (sql: string) => boolean
  /** DDL commits at once (MySQL): a script with DDL never runs in a transaction, which is no cause for a warning */
  ddlCommits?: boolean
  quote: (name: string) => string
  /**
   * The schemas a new project manages. Empty: the schema the connection uses (the database in a
   * MySQL URL, the user's schema on Oracle); the schemas setting does not apply then.
   */
  schemas: string[]
  open: (envName: string, env: Environment) => Promise<Conn>
}

const RESERVED = new Set(
  (
    'all analyse analyze and any array as asc asymmetric authorization binary both case cast check collate collation column concurrently ' +
    'constraint create cross current_catalog current_date current_role current_schema current_time current_timestamp current_user default ' +
    'deferrable desc distinct do else end except false fetch for foreign freeze from full grant group having ilike in initially inner ' +
    'intersect into is isnull join lateral leading left like limit localtime localtimestamp natural not notnull null offset on only or ' +
    'order outer overlaps placing primary references returning right select session_user similar some symmetric system_user table ' +
    'tablesample then to trailing true union unique user using variadic verbose when where window with'
  ).split(' '),
)

/** PostgreSQL: bare when safe (lowercase, not reserved), double-quoted otherwise. */
export function quoteIdent(s: string): string {
  return /^[a-z_][a-z0-9_]*$/.test(s) && !RESERVED.has(s) ? s : `"${s.replaceAll('"', '""')}"`
}

export const ENGINES: EngineInfo[] = [
  {
    id: 'postgresql', name: 'PostgreSQL', tag: 'pg', matches: (u) => /^postgres(ql)?:\/\//i.test(u.trim()), example: 'postgres://localhost:5432/shop',
    begin: 'BEGIN', currentUser: 'current_user', true: 'true', needsNoTransaction, quote: quoteIdent, schemas: ['public'],
    open: async (n, e) => (await import('./postgres.ts')).PgConn.open(n, e),
  },
  {
    id: 'sqlserver', name: 'SQL Server', tag: 'ms', matches: isSqlServerUrl, example: 'sqlserver://localhost:1433;databaseName=shop;encrypt=true',
    begin: 'BEGIN TRANSACTION', currentUser: 'SUSER_SNAME()', true: '1', needsNoTransaction: tsqlNeedsNoTransaction, quote: (s) => `[${s.replaceAll(']', ']]')}]`, schemas: ['dbo'],
    open: async (n, e) => (await import('./sqlserver.ts')).SqlServerConn.open(n, e),
  },
]

/** The engine a liftoff.toml names. */
export function engineById(id: string): EngineInfo {
  const e = ENGINES.find((x) => x.id === id)
  if (!e) throw configError(`engine '${id}' is not supported; use ${ENGINES.map((x) => x.id).join(', ')}`)
  return e
}

/** The engine a connection URL is for; PostgreSQL when it names none (the driver then says what is wrong). */
export function engineForUrl(url: string): EngineInfo {
  return ENGINES.find((e) => e.matches(url)) ?? ENGINES[0]
}

export function engineOf(url: string): EngineName {
  return engineForUrl(url).name
}

/** The per-engine bits of SQL the runner writes itself, by a connection's `engine`. */
export const dialect = Object.fromEntries(ENGINES.map((e) => [e.name, e])) as Record<EngineName, EngineInfo>

/** `${env.X}` left in a URL, user or password means a variable is not set; say which. */
export function checkVars(envName: string, env: Environment): void {
  for (const v of [env.url, env.user, env.password]) {
    const i = v?.indexOf('${env.') ?? -1
    if (v && i >= 0) throw connectError(envName, `environment variable ${v.slice(i + 6).split('}')[0]} is not set`)
  }
}

/** Opens a connection to an environment, on the engine its URL names. */
export async function open(envName: string, env: Environment): Promise<Conn> {
  checkVars(envName, env)
  return engineForUrl(env.url).open(envName, env)
}

/** Runs `work` on a fresh connection and always closes it. */
export async function withConn<T>(envName: string, env: Environment, work: (c: Conn) => Promise<T>): Promise<T> {
  const c = await open(envName, env)
  try {
    return await work(c)
  } finally {
    await c.close()
  }
}

/** Who holds a lease: user, machine, process and a timestamp, so every run is distinct. */
export function holderName(): string {
  const user = process.env.USERNAME ?? process.env.USER ?? ''
  const host = process.env.COMPUTERNAME ?? process.env.HOSTNAME ?? ''
  return `${user}@${host} pid ${process.pid} ${process.hrtime.bigint()}`
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
