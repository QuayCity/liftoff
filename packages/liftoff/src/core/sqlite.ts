// SQLite: a database file, through the SQLite built into Node.js (node:sqlite): nothing to
// install. The project's schemas setting does not apply: LiftOff manages the file's main schema.
//
// URLs: `sqlite:data/shop.db` (relative to the project folder; the config anchors it there),
// `sqlite:/srv/shop.db`, `sqlite:C:/data/shop.db`, `sqlite:///srv/shop.db`, `jdbc:sqlite:…`.

import { createHash } from 'node:crypto'
import * as fs from 'node:fs'
import * as path from 'node:path'
import type { DatabaseSync, StatementSync } from 'node:sqlite'
import type { Environment, LockMode } from './config.ts'
import { DbError, connectError } from './errors.ts'
import { activityRow, holderName, ownTables, sleep, type Activity, type Conn, type Held, type HistoryRow, type NewActivity, type NewRow, type ServerInfo } from './db.ts'

/** `"name"`, with `"` doubled. */
export const quote = (s: string) => `"${s.replaceAll('"', '""')}"`

/** `'text'`, with `'` doubled. */
export const lit = (s: string) => `'${s.replaceAll("'", "''")}'`

export const isSqliteUrl = (url: string) => /^(jdbc:)?sqlite:/i.test(url.trim())

/** The file a URL names, as written (relative paths are anchored by the config). */
export function fileOf(url: string): string {
  const p = url.trim().replace(/^(jdbc:)?sqlite:/i, '')
  // sqlite:///srv/shop.db (a URL with an empty host) is /srv/shop.db.
  return p.startsWith('//') ? p.slice(2) : p
}

/** The same URL for another file in the same folder: `shop.db` -> `shop_scratch.db`. */
export function withDatabase(url: string, db: string): string {
  const file = fileOf(url)
  return `sqlite:${path.posix.join(path.posix.dirname(file.replaceAll('\\', '/')), `${db}${path.extname(file)}`)}`
}

/** node:sqlite prints an "experimental" warning once on load; LiftOff's output stays clean. */
async function loadSqlite(): Promise<typeof import('node:sqlite')> {
  const emit = process.emitWarning
  process.emitWarning = ((w: string | Error, ...rest: unknown[]) => {
    if (!String(w).includes('SQLite')) (emit as (...a: unknown[]) => void).call(process, w, ...rest)
  }) as typeof process.emitWarning
  try {
    return await import('node:sqlite')
  } finally {
    process.emitWarning = emit
  }
}

/** 60 bits of an md5, for data compare (SQLite has no hash function of its own). */
export const hash60 = (s: string) => BigInt(`0x${createHash('md5').update(s).digest('hex').slice(0, 15)}`)

function wrap(e: unknown): never {
  const x = e as Error & { errcode?: number }
  if (x instanceof Error && typeof x.errcode === 'number') throw new DbError(x.message, String(x.errcode))
  throw x instanceof Error ? new DbError(x.message) : e
}

type Param = string | number | bigint | boolean | null

export class SqliteConn implements Conn {
  readonly engine = 'SQLite' as const
  readonly db: DatabaseSync
  readonly file: string

  private constructor(db: DatabaseSync, file: string) {
    this.db = db
    this.file = file
  }

  static async open(envName: string, env: Environment): Promise<SqliteConn> {
    const file = fileOf(env.url)
    if (!file) throw connectError(envName, 'the URL names no file, e.g. sqlite:data/shop.db')
    if (!fs.existsSync(path.dirname(path.resolve(file)))) throw connectError(envName, `the folder of ${file} does not exist`)
    const { DatabaseSync } = await loadSqlite()
    let db: DatabaseSync
    try {
      db = new DatabaseSync(file)
    } catch (e) {
      throw connectError(envName, e instanceof Error ? e.message : String(e))
    }
    // Wait for another writer instead of failing at once; foreign keys are checked (SQLite's default is off).
    db.exec('PRAGMA busy_timeout = 10000; PRAGMA foreign_keys = ON;')
    // For data compare: a row's hash, and an exact sum of them.
    db.function('liftoff_hash', { deterministic: true }, (s) => hash60(String(s)))
    db.aggregate('liftoff_sum', { start: 0n, step: (acc, v) => (acc as bigint) + BigInt(v as bigint | number), result: (acc) => String(acc), useBigIntArguments: true })
    return new SqliteConn(db, file)
  }

  private prepare(sql: string): StatementSync {
    try {
      const s = this.db.prepare(sql)
      s.setReturnArrays(true)
      return s
    } catch (e) {
      wrap(e)
    }
  }

  /** Rows as arrays; parameters are `?`. */
  async query(sql: string, params: Param[] = []): Promise<unknown[][]> {
    const s = this.prepare(sql)
    try {
      return s.all(...params.map((p) => (typeof p === 'boolean' ? (p ? 1 : 0) : p))) as unknown as unknown[][]
    } catch (e) {
      wrap(e)
    }
  }

  async batch(sql: string): Promise<void> {
    try {
      this.db.exec(sql)
    } catch (e) {
      wrap(e)
    }
  }

  async script(sql: string): Promise<void> {
    await this.batch(sql)
  }

  async serverInfo(): Promise<ServerInfo> {
    const [[version]] = await this.query('SELECT sqlite_version()')
    return { version: String(version), user: process.env.USERNAME ?? process.env.USER ?? 'local', database: path.basename(this.file, path.extname(this.file)) }
  }

  /**
   * A lease row in `<history table>_lock`, renewed every 30 s on a second connection and expiring
   * after 2 minutes, so a crashed run never blocks the next one for long. Polls, like the other
   * engines. The `lock` setting does not apply here.
   */
  async lock(_schema: string, table: string, _mode: LockMode, onWait: () => void, reopen?: () => Promise<Conn>): Promise<Held> {
    const t = quote(`${table}_lock`)
    const holder = holderName()
    const LEASE_SECS = 120
    await this.batch(`CREATE TABLE IF NOT EXISTS ${t} (id INTEGER PRIMARY KEY CHECK (id = 1), holder TEXT NOT NULL, expires_at INTEGER NOT NULL)`)
    let waited = false
    for (;;) {
      const now = Math.floor(Date.now() / 1000)
      const got = await this.query(
        `INSERT INTO ${t} (id, holder, expires_at) VALUES (1, ?, ?)
         ON CONFLICT (id) DO UPDATE SET holder = excluded.holder, expires_at = excluded.expires_at WHERE ${t}.expires_at < ?
         RETURNING holder`,
        [holder, now + LEASE_SECS, now],
      )
      if (got.length) break
      if (!waited) {
        onWait()
        waited = true
      }
      await sleep(500)
    }
    // Long scripts keep this connection busy, so the lease is renewed on a second one.
    let stop = false
    const renewer = reopen?.().then((c) => c as SqliteConn).catch(() => undefined)
    const timer = setInterval(async () => {
      const r = await renewer
      if (!stop && r) await r.query(`UPDATE ${t} SET expires_at = ? WHERE holder = ?`, [Math.floor(Date.now() / 1000) + LEASE_SECS, holder]).catch(() => {})
    }, 30_000)
    return {
      release: async () => {
        stop = true
        clearInterval(timer)
        await (await renewer)?.close()
        await this.query(`DELETE FROM ${t} WHERE holder = ?`, [holder]).catch(() => {})
      },
    }
  }

  async tableExists(table: string): Promise<boolean> {
    return (await this.query("SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = ?", [table])).length > 0
  }

  async ensureHistory(_schema: string, table: string): Promise<void> {
    await this.batch(
      `CREATE TABLE IF NOT EXISTS ${quote(table)} (
         installed_rank INTEGER NOT NULL PRIMARY KEY,
         version TEXT NULL,
         description TEXT NOT NULL,
         type TEXT NOT NULL,
         script TEXT NOT NULL,
         checksum INTEGER NULL,
         installed_by TEXT NOT NULL,
         installed_on TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
         execution_time INTEGER NOT NULL,
         success INTEGER NOT NULL
       );
       CREATE INDEX IF NOT EXISTS ${quote(`${table}_s_idx`)} ON ${quote(table)} (success);`,
    )
  }

  async readHistory(_schema: string, table: string): Promise<HistoryRow[]> {
    if (!(await this.tableExists(table))) return []
    const rows = await this.query(
      `SELECT installed_rank, version, description, type, script, checksum, installed_by, installed_on, execution_time, success
       FROM ${quote(table)} ORDER BY installed_rank`,
    )
    return rows.map((r) => ({
      installed_rank: Number(r[0]),
      version: r[1] as string | null,
      description: r[2] as string,
      type: r[3] as string,
      script: r[4] as string,
      checksum: r[5] === null ? null : Number(r[5]),
      installed_by: r[6] as string,
      installed_on: r[7] as string,
      execution_time: Number(r[8]),
      success: Number(r[9]) === 1,
    }))
  }

  async insertHistory(_schema: string, table: string, row: NewRow): Promise<void> {
    const t = quote(table)
    await this.query(
      `INSERT INTO ${t} (installed_rank, version, description, type, script, checksum, installed_by, installed_on, execution_time, success)
       SELECT COALESCE(MAX(installed_rank), 0) + 1, ?, ?, ?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%SZ', 'now'), ?, ? FROM ${t}`,
      [row.version, row.description, row.type, row.script, row.checksum, (await this.serverInfo()).user, row.executionTime, row.success],
    )
  }

  async ensureActivity(_schema: string, table: string): Promise<void> {
    await this.batch(
      `CREATE TABLE IF NOT EXISTS ${quote(table)} (
         id TEXT NOT NULL PRIMARY KEY,
         operation TEXT NOT NULL,
         started_on TEXT NOT NULL,
         execution_time INTEGER NOT NULL,
         success INTEGER NOT NULL,
         installed_by TEXT NOT NULL,
         os_user TEXT NOT NULL,
         host TEXT NOT NULL,
         pipeline TEXT NULL,
         git_commit TEXT NULL,
         scripts TEXT NOT NULL,
         detail TEXT NULL
       )`,
    )
  }

  async insertActivity(_schema: string, table: string, a: NewActivity): Promise<void> {
    await this.query(
      `INSERT INTO ${quote(table)} (id, operation, started_on, execution_time, success, installed_by, os_user, host, pipeline, git_commit, scripts, detail)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [a.id, a.operation, a.started_on, a.execution_time, a.success, a.os_user, a.os_user, a.host, a.pipeline, a.git_commit, a.scripts.join('\n'), a.detail],
    )
  }

  async readActivity(_schema: string, table: string, limit: number): Promise<Activity[]> {
    if (!(await this.tableExists(table))) return []
    const rows = await this.query(
      `SELECT id, operation, started_on, execution_time, success, installed_by, os_user, host, pipeline, git_commit, scripts, detail
       FROM ${quote(table)} ORDER BY started_on DESC, id LIMIT ?`,
      [limit],
    )
    return rows.map((r) => activityRow([r[0], r[1], r[2], Number(r[3]), Number(r[4]) === 1, ...r.slice(5)]))
  }

  async userObjects(_schemas: string[], table: string): Promise<number> {
    const own = ownTables(table).map(lit).join(', ')
    const [[n]] = await this.query(`SELECT COUNT(*) FROM sqlite_schema WHERE type IN ('table', 'view', 'trigger') AND name NOT LIKE 'sqlite_%' AND name NOT IN (${own})`)
    return Number(n)
  }

  async deleteFailed(_schema: string, table: string): Promise<string[]> {
    return (await this.query(`DELETE FROM ${quote(table)} WHERE success = 0 RETURNING script`)).map((r) => r[0] as string)
  }

  async realign(_schema: string, table: string, rank: number, checksum: number, description: string): Promise<void> {
    await this.query(`UPDATE ${quote(table)} SET checksum = ?, description = ? WHERE installed_rank = ?`, [checksum, description, rank])
  }

  /** Drops every view, trigger and table in the file (indexes go with their tables). */
  async resetSchemas(): Promise<void> {
    const rows = await this.query(
      `SELECT type, name FROM sqlite_schema WHERE type IN ('view', 'trigger', 'table') AND name NOT LIKE 'sqlite_%'
       ORDER BY CASE type WHEN 'view' THEN 0 WHEN 'trigger' THEN 1 ELSE 2 END`,
    )
    if (!rows.length) return
    // Foreign keys between the tables do not decide the order (the pragma is not allowed in a transaction, and this is not one).
    await this.batch(`PRAGMA foreign_keys = OFF; ${rows.map(([type, name]) => `DROP ${String(type).toUpperCase()} IF EXISTS ${quote(String(name))};`).join(' ')} PRAGMA foreign_keys = ON;`)
  }

  async close(): Promise<void> {
    try {
      this.db.close()
    } catch {
      /* already closed */
    }
  }
}
