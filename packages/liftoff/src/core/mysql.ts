// MySQL: connection, run lock, history table and clean.
//
// LiftOff manages the database the URL names (`mysql://host:3306/shop`): the project's schemas
// setting does not apply, so dev, test and prod may have databases of different names. MySQL
// commits DDL at once, so a script with DDL cannot be rolled back (the runner records a failure
// for `repair`, as for any script outside a transaction).

import mysql from 'mysql2/promise'
import type { Environment, LockMode } from './config.ts'
import { DbError, connectError } from './errors.ts'
import { activityRow, ownTables, sleep, type Activity, type Conn, type Held, type HistoryRow, type NewActivity, type NewRow, type ServerInfo } from './db.ts'

/** `` `name` ``, with `` ` `` doubled. */
export const quote = (s: string) => `\`${s.replaceAll('`', '``')}\``

/** `'text'`, with `'` and `\` escaped. */
export const lit = (s: string) => `'${s.replaceAll('\\', '\\\\').replaceAll("'", "''")}'`

export const isMySqlUrl = (url: string) => /^(jdbc:)?mysql:\/\//i.test(url.trim())

type Target = { host: string; port: number; database?: string; user?: string; password?: string; sslmode: string }

/** `mysql://user:pw@host:3306/shop?sslmode=require` (with or without `jdbc:`). */
export function parseUrl(url: string): Target {
  const u = new URL(url.trim().replace(/^jdbc:/i, ''))
  const t: Target = { host: decodeURIComponent(u.hostname.replace(/^\[|\]$/g, '')) || 'localhost', port: Number(u.port || 3306), sslmode: 'prefer' }
  const db = decodeURIComponent(u.pathname.replace(/^\//, ''))
  if (db) t.database = db
  if (u.username) t.user = decodeURIComponent(u.username)
  if (u.password) t.password = decodeURIComponent(u.password)
  for (const [k, v] of u.searchParams) {
    const key = k.toLowerCase().replaceAll('-', '')
    // sslmode as LiftOff writes it; sslMode / ssl-mode as MySQL's own clients do.
    if (key === 'sslmode') t.sslmode = v.toLowerCase().replace('_', '-')
    else if (key === 'user') t.user = v
    else if (key === 'password') t.password = v
  }
  return t
}

/** The same URL pointing at another database on the same server. */
export function withDatabase(url: string, db: string): string {
  const u = new URL(url.trim().replace(/^jdbc:/i, ''))
  u.pathname = `/${encodeURIComponent(db)}`
  return u.toString()
}

/**
 * The parts of a script to send one at a time. Statements separated by `;` go together (MySQL
 * runs them in order and stops at the first error; it parses BEGIN … END bodies itself). A
 * `DELIMITER //` line, as the mysql client takes it, switches to another separator; each part up
 * to it is then sent on its own.
 */
export function splitScript(sql: string): string[] {
  const out: string[] = []
  let delimiter = ';'
  let cur = ''
  const push = () => {
    if (cur.replace(/--[^\n]*|#[^\n]*|\/\*[\s\S]*?\*\//g, '').trim()) out.push(cur.trim())
    cur = ''
  }
  let quoteChar = ''
  let block = false
  let lineStart = true
  for (let i = 0; i < sql.length; i++) {
    const c = sql[i]
    if (lineStart && !quoteChar && !block) {
      const m = /^[ \t]*delimiter[ \t]+(\S+)[ \t]*(\r?\n|$)/i.exec(sql.slice(i))
      if (m) {
        push()
        delimiter = m[1]
        i += m[0].length - 1
        continue
      }
    }
    lineStart = c === '\n'
    if (quoteChar) {
      cur += c
      if (c === '\\' && quoteChar !== '`') cur += sql[++i] ?? ''
      else if (c === quoteChar) {
        if (sql[i + 1] === quoteChar) cur += sql[++i]
        else quoteChar = ''
      }
    } else if (block) {
      cur += c
      if (c === '*' && sql[i + 1] === '/') {
        cur += sql[++i]
        block = false
      }
    } else if (c === "'" || c === '"' || c === '`') {
      quoteChar = c
      cur += c
    } else if (c === '/' && sql[i + 1] === '*') {
      block = true
      cur += c
    } else if (c === '#' || (c === '-' && sql[i + 1] === '-' && /\s/.test(sql[i + 2] ?? ' '))) {
      const n = sql.indexOf('\n', i)
      const end = n < 0 ? sql.length : n
      cur += sql.slice(i, end)
      i = end - 1
    } else if (delimiter !== ';' && sql.startsWith(delimiter, i)) {
      push()
      i += delimiter.length - 1
    } else cur += c
  }
  push()
  return out
}

/** A MySQL error with its number, e.g. `Table 'shop.x' doesn't exist (error 1146)`. */
function wrap(e: unknown): never {
  const x = e as { errno?: number; sqlMessage?: string; message?: string }
  if (typeof x?.errno === 'number') throw new DbError(`${x.sqlMessage ?? x.message} (error ${x.errno})`, String(x.errno))
  throw e instanceof Error ? new DbError(e.message) : e
}

type Param = string | number | boolean | null

export class MySqlConn implements Conn {
  readonly engine = 'MySQL' as const
  private readonly c: mysql.Connection
  readonly database: string

  private constructor(c: mysql.Connection, database: string) {
    this.c = c
    this.database = database
  }

  static async open(envName: string, env: Environment): Promise<MySqlConn> {
    const fail = (msg: string) => connectError(envName, msg)
    let t: Target
    try {
      t = parseUrl(env.url)
    } catch {
      throw fail('the URL is not a MySQL URL like mysql://localhost:3306/shop')
    }
    if (!t.database) throw fail('the URL names no database, e.g. mysql://localhost:3306/shop')
    const base: mysql.ConnectionOptions = {
      host: t.host,
      port: t.port,
      database: t.database,
      user: env.user ?? t.user,
      password: env.password ?? t.password,
      multipleStatements: true,
      supportBigNumbers: true,
      bigNumberStrings: true,
      dateStrings: true,
      charset: 'utf8mb4',
      timezone: 'Z',
      connectTimeout: 10_000,
    }
    // prefer (the default): TLS when the server offers it, without checking its certificate, as
    // MySQL's own clients do; require: TLS, unchecked; verify-ca / verify-full: TLS, checked;
    // disable: none.
    const connect = (ssl: mysql.ConnectionOptions['ssl']) => mysql.createConnection({ ...base, ...(ssl && { ssl }) })
    let c: mysql.Connection
    try {
      if (t.sslmode === 'disable' || t.sslmode === 'disabled') c = await connect(undefined)
      else if (t.sslmode.startsWith('verify')) c = await connect({ rejectUnauthorized: true })
      else if (t.sslmode === 'require' || t.sslmode === 'required') c = await connect({ rejectUnauthorized: false })
      else c = await connect({ rejectUnauthorized: false }).catch((e: Error) => (/does not support secure connection/i.test(e.message) ? connect(undefined) : Promise.reject(e)))
    } catch (e) {
      throw fail(e instanceof Error ? e.message : String(e))
    }
    c.on('error', () => {}) // a dropped connection surfaces on the next query
    const conn = new MySqlConn(c, t.database)
    // History times are written and read in UTC.
    await conn.batch("SET time_zone = '+00:00'")
    return conn
  }

  /** Rows as arrays; parameters are `?`. */
  async query(sql: string, params: Param[] = []): Promise<unknown[][]> {
    try {
      const [rows] = await this.c.query({ sql, values: params, rowsAsArray: true })
      return Array.isArray(rows) && (rows.length === 0 || Array.isArray(rows[0])) ? (rows as unknown[][]) : []
    } catch (e) {
      wrap(e)
    }
  }

  async batch(sql: string): Promise<void> {
    try {
      await this.c.query(sql)
    } catch (e) {
      wrap(e)
    }
  }

  async script(sql: string): Promise<void> {
    for (const part of splitScript(sql)) await this.batch(part)
  }

  async serverInfo(): Promise<ServerInfo> {
    const [[version, user, database]] = await this.query('SELECT VERSION(), CURRENT_USER(), DATABASE()')
    return { version: String(version), user: String(user), database: String(database) }
  }

  /**
   * A named lock owned by the session (GET_LOCK): released by `release` or when the connection
   * closes, so a crashed run never blocks the next one. Polls, like the other engines. The `lock`
   * setting does not apply here.
   */
  async lock(_schema: string, table: string, _mode: LockMode, onWait: () => void): Promise<Held> {
    // Lock names are at most 64 characters.
    const name = `liftoff:${this.database}.${table}`.slice(0, 64)
    let waited = false
    for (;;) {
      const [[got]] = await this.query('SELECT GET_LOCK(?, 0)', [name])
      if (Number(got) === 1) break
      if (!waited) {
        onWait()
        waited = true
      }
      await sleep(500)
    }
    return { release: async () => void (await this.query('SELECT RELEASE_LOCK(?)', [name]).catch(() => {})) }
  }

  async tableExists(table: string): Promise<boolean> {
    const [[n]] = await this.query('SELECT COUNT(*) FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name = ?', [table])
    return Number(n) > 0
  }

  async ensureHistory(_schema: string, table: string): Promise<void> {
    if (await this.tableExists(table)) return
    await this.batch(
      `CREATE TABLE ${quote(table)} (
         installed_rank INT NOT NULL PRIMARY KEY,
         version VARCHAR(50) NULL,
         description VARCHAR(200) NOT NULL,
         type VARCHAR(20) NOT NULL,
         script VARCHAR(1000) NOT NULL,
         checksum INT NULL,
         installed_by VARCHAR(100) NOT NULL,
         installed_on TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
         execution_time INT NOT NULL,
         success BOOL NOT NULL,
         INDEX ${quote(`${table}_s_idx`)} (success)
       ) ENGINE=InnoDB`,
    )
  }

  async readHistory(_schema: string, table: string): Promise<HistoryRow[]> {
    if (!(await this.tableExists(table))) return []
    const rows = await this.query(
      `SELECT installed_rank, version, description, type, script, checksum, installed_by,
              DATE_FORMAT(installed_on, '%Y-%m-%dT%H:%i:%sZ'), execution_time, success
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
       SELECT COALESCE(MAX(installed_rank), 0) + 1, ?, ?, ?, ?, ?, SUBSTRING_INDEX(CURRENT_USER(), '@', 1), UTC_TIMESTAMP(), ?, ? FROM ${t}`,
      [row.version, row.description, row.type, row.script, row.checksum, row.executionTime, row.success],
    )
  }

  async ensureActivity(_schema: string, table: string): Promise<void> {
    if (await this.tableExists(table)) return
    await this.batch(
      `CREATE TABLE ${quote(table)} (
         id VARCHAR(36) NOT NULL PRIMARY KEY,
         operation VARCHAR(20) NOT NULL,
         started_on DATETIME(3) NOT NULL,
         execution_time INT NOT NULL,
         success BOOL NOT NULL,
         installed_by VARCHAR(100) NOT NULL,
         os_user VARCHAR(100) NOT NULL,
         host VARCHAR(100) NOT NULL,
         pipeline VARCHAR(1000) NULL,
         git_commit VARCHAR(64) NULL,
         scripts LONGTEXT NOT NULL,
         detail LONGTEXT NULL
       ) ENGINE=InnoDB`,
    )
  }

  async insertActivity(_schema: string, table: string, a: NewActivity): Promise<void> {
    await this.query(
      `INSERT INTO ${quote(table)} (id, operation, started_on, execution_time, success, installed_by, os_user, host, pipeline, git_commit, scripts, detail)
       VALUES (?, ?, STR_TO_DATE(?, '%Y-%m-%dT%H:%i:%s.%fZ'), ?, ?, SUBSTRING_INDEX(CURRENT_USER(), '@', 1), ?, ?, ?, ?, ?, ?)`,
      [a.id, a.operation, a.started_on, a.execution_time, a.success, a.os_user, a.host, a.pipeline, a.git_commit, a.scripts.join('\n'), a.detail],
    )
  }

  async readActivity(_schema: string, table: string, limit: number): Promise<Activity[]> {
    if (!(await this.tableExists(table))) return []
    const rows = await this.query(
      `SELECT id, operation, DATE_FORMAT(started_on, '%Y-%m-%dT%H:%i:%s.%fZ'), execution_time, success, installed_by, os_user, host, pipeline, git_commit, scripts, detail
       FROM ${quote(table)} ORDER BY started_on DESC, id LIMIT ?`,
      [limit],
    )
    return rows.map((r) => activityRow([r[0], r[1], r[2], Number(r[3]), Number(r[4]) === 1, ...r.slice(5)]))
  }

  async userObjects(_schemas: string[], table: string): Promise<number> {
    const own = ownTables(table).map(lit).join(', ')
    const [[n]] = await this.query(
      `SELECT (SELECT COUNT(*) FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name NOT IN (${own}))
            + (SELECT COUNT(*) FROM information_schema.routines WHERE routine_schema = DATABASE())`,
    )
    return Number(n)
  }

  async deleteFailed(_schema: string, table: string): Promise<string[]> {
    const scripts = (await this.query(`SELECT script FROM ${quote(table)} WHERE success = 0`)).map((r) => r[0] as string)
    await this.query(`DELETE FROM ${quote(table)} WHERE success = 0`)
    return scripts
  }

  async realign(_schema: string, table: string, rank: number, checksum: number, description: string): Promise<void> {
    await this.query(`UPDATE ${quote(table)} SET checksum = ?, description = ? WHERE installed_rank = ?`, [checksum, description, rank])
  }

  /** Drops every view, table, routine and event in the database; the database itself stays. */
  async resetSchemas(): Promise<void> {
    const drops = (
      await this.query(
        `SELECT 'VIEW', table_name FROM information_schema.views WHERE table_schema = DATABASE()
         UNION ALL SELECT 'TABLE', table_name FROM information_schema.tables WHERE table_schema = DATABASE() AND table_type = 'BASE TABLE'
         UNION ALL SELECT routine_type, routine_name FROM information_schema.routines WHERE routine_schema = DATABASE()
         UNION ALL SELECT 'EVENT', event_name FROM information_schema.events WHERE event_schema = DATABASE()`,
      )
    ).map((r) => `DROP ${String(r[0])} IF EXISTS ${quote(String(r[1]))};`)
    if (!drops.length) return
    // Foreign keys between the tables do not decide the order.
    await this.batch(`SET FOREIGN_KEY_CHECKS = 0; ${drops.join(' ')} SET FOREIGN_KEY_CHECKS = 1;`)
  }

  async close(): Promise<void> {
    await this.c.end().catch(() => this.c.destroy())
  }
}
