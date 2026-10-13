// The runner's view of a database: one connection, whichever engine it is. Each engine
// (postgres.ts, sqlserver.ts) implements the same small set of operations, so the runner
// (runner.ts) has no engine-specific code.

import type { Environment, LockMode } from './config.ts'
import { connectError } from './errors.ts'
import { needsNoTransaction, tsqlNeedsNoTransaction } from './migration.ts'

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

export function engineOf(url: string): EngineName {
  return isSqlServerUrl(url) ? 'SQL Server' : 'PostgreSQL'
}

/** The per-engine bits of SQL the runner writes itself (dry runs, transactions). */
export const dialect = {
  PostgreSQL: { begin: 'BEGIN', currentUser: 'current_user', true: 'true', needsNoTransaction },
  'SQL Server': { begin: 'BEGIN TRANSACTION', currentUser: 'SUSER_SNAME()', true: '1', needsNoTransaction: tsqlNeedsNoTransaction },
} as const

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
  if (isSqlServerUrl(env.url)) {
    const { SqlServerConn } = await import('./sqlserver.ts')
    return SqlServerConn.open(envName, env)
  }
  const { PgConn } = await import('./postgres.ts')
  return PgConn.open(envName, env)
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
