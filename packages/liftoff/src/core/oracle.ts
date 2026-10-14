// Oracle: connection, run lock, history table and clean.
//
// LiftOff manages the schema of the user it signs in as: the project's schemas setting does not
// apply, so dev, test and prod may be different users (SHOP_DEV, SHOP_TEST, …). Oracle commits
// DDL at once, so a script with DDL cannot be rolled back (the runner records a failure for
// `repair`). The driver runs in thin mode: no Oracle client to install.

import oracledb from 'oracledb'
import type { Environment, LockMode } from './config.ts'
import { DbError, connectError } from './errors.ts'
import { activityRow, ownTables, sleep, type Activity, type Conn, type Held, type HistoryRow, type NewActivity, type NewRow, type ServerInfo } from './db.ts'

// Long texts (view and routine sources, DBMS_METADATA) come back as strings.
oracledb.fetchAsString = [oracledb.CLOB]

const RESERVED = new Set(
  (
    'ACCESS ADD ALL ALTER AND ANY AS ASC AUDIT BETWEEN BY CHAR CHECK CLUSTER COLUMN COMMENT COMPRESS CONNECT CREATE CURRENT DATE DECIMAL ' +
    'DEFAULT DELETE DESC DISTINCT DROP ELSE EXCLUSIVE EXISTS FILE FLOAT FOR FROM GRANT GROUP HAVING IDENTIFIED IMMEDIATE IN INCREMENT ' +
    'INDEX INITIAL INSERT INTEGER INTERSECT INTO IS LEVEL LIKE LOCK LONG MAXEXTENTS MINUS MLSLABEL MODE MODIFY NOAUDIT NOCOMPRESS NOT ' +
    'NOWAIT NULL NUMBER OF OFFLINE ON ONLINE OPTION OR ORDER PCTFREE PRIOR PUBLIC RAW RENAME RESOURCE REVOKE ROW ROWID ROWNUM ROWS ' +
    'SELECT SESSION SET SHARE SIZE SMALLINT START SUCCESSFUL SYNONYM SYSDATE TABLE THEN TO TRIGGER UID UNION UNIQUE UPDATE USER ' +
    'VALIDATE VALUES VARCHAR VARCHAR2 VIEW WHENEVER WHERE WITH'
  ).split(' '),
)

/**
 * A name as Oracle stores it, written so it reads back the same: a plain upper-case name bare and
 * in lower case (Oracle folds it back), anything else double-quoted.
 */
export function quote(s: string): string {
  return /^[A-Z][A-Z0-9_$#]*$/.test(s) && !RESERVED.has(s) ? s.toLowerCase() : `"${s.replaceAll('"', '""')}"`
}

/** `'text'`, with `'` doubled. */
export const lit = (s: string) => `'${s.replaceAll("'", "''")}'`

export const isOracleUrl = (url: string) => /^(oracle:\/\/|jdbc:oracle:)/i.test(url.trim())

type Target = { connectString: string; user?: string; password?: string }

/**
 * `oracle://host:1521/SERVICE` (`?ssl=true` for TLS), and the JDBC thin forms:
 * `jdbc:oracle:thin:@//host:1521/SERVICE`, `@host:1521/SERVICE`, `@host:1521:SID`, `@(DESCRIPTION=…)`.
 */
export function parseUrl(url: string): Target {
  const u = url.trim()
  if (/^oracle:\/\//i.test(u)) {
    const p = new URL(u)
    const host = decodeURIComponent(p.hostname.replace(/^\[|\]$/g, '')) || 'localhost'
    const service = decodeURIComponent(p.pathname.replace(/^\//, ''))
    if (!service) throw new Error('the URL names no service, e.g. oracle://localhost:1521/FREEPDB1')
    const ssl = /^(true|1|yes)$/i.test(p.searchParams.get('ssl') ?? '')
    return {
      connectString: `${ssl ? 'tcps://' : ''}${host}:${p.port || (ssl ? 2484 : 1521)}/${service}`,
      ...(p.username && { user: decodeURIComponent(p.username) }),
      ...(p.password && { password: decodeURIComponent(p.password) }),
    }
  }
  const m = /^jdbc:oracle:thin:(?:([^/@]*)(?:\/([^@]*))?)?@(.*)$/i.exec(u)
  if (!m) throw new Error('not an Oracle URL')
  let rest = m[3].trim()
  if (rest.startsWith('//')) rest = rest.slice(2)
  const sid = /^([^:/()]+):(\d+):([^:/]+)$/.exec(rest)
  const connectString = sid ? `(DESCRIPTION=(ADDRESS=(PROTOCOL=TCP)(HOST=${sid[1]})(PORT=${sid[2]}))(CONNECT_DATA=(SID=${sid[3]})))` : rest
  return { connectString, ...(m[1] && { user: m[1] }), ...(m[2] && { password: m[2] }) }
}

const PLSQL = /^(create\s+(or\s+replace\s+)?((non)?editionable\s+)?(procedure|function|package|trigger|type|library)\b|declare\b|begin\b)/i

/**
 * A script as Oracle statements, the way SQL*Plus reads it: a SQL statement ends at `;`; a PL/SQL
 * block (CREATE PROCEDURE / FUNCTION / PACKAGE / TRIGGER / TYPE, DECLARE, BEGIN) at a line with
 * only `/`. Strings (also q'[…]'), quoted names and comments are skipped over.
 */
export function splitScript(sql: string): string[] {
  const out: string[] = []
  let cur = ''
  let plsql: boolean | undefined
  const push = () => {
    const s = cur.trim()
    if (s && s.replace(/--[^\n]*|\/\*[\s\S]*?\*\//g, '').trim()) out.push(s)
    cur = ''
    plsql = undefined
  }
  let lineStart = true
  for (let i = 0; i < sql.length; i++) {
    const c = sql[i]
    if (lineStart) {
      const slash = /^[ \t]*\/[ \t]*(\r?\n|$)/.exec(sql.slice(i))
      if (slash) {
        push()
        i += slash[0].length - 1
        continue
      }
    }
    lineStart = c === '\n'
    if (c === '-' && sql[i + 1] === '-') {
      const n = sql.indexOf('\n', i)
      const end = n < 0 ? sql.length : n
      cur += sql.slice(i, end)
      i = end - 1
      continue
    }
    if (c === '/' && sql[i + 1] === '*') {
      const n = sql.indexOf('*/', i + 2)
      const end = n < 0 ? sql.length : n + 2
      cur += sql.slice(i, end)
      i = end - 1
      continue
    }
    if (plsql === undefined && /\S/.test(c)) plsql = PLSQL.test(sql.slice(i))
    if ((c === 'q' || c === 'Q') && sql[i + 1] === "'" && !/[\w$#]/.test(sql[i - 1] ?? '')) {
      // q'[ … ]', q'{ … }', q'! … !': the closing delimiter, then a quote.
      const open = sql[i + 2]
      const close = ({ '[': ']', '{': '}', '(': ')', '<': '>' } as Record<string, string>)[open] ?? open
      const n = sql.indexOf(`${close}'`, i + 3)
      const end = n < 0 ? sql.length : n + 2
      cur += sql.slice(i, end)
      i = end - 1
      continue
    }
    if (c === "'" || c === '"') {
      let j = i + 1
      while (j < sql.length && !(sql[j] === c && sql[j + 1] !== c)) j += sql[j] === c ? 2 : 1
      cur += sql.slice(i, j + 1)
      i = j
      continue
    }
    if (c === ';' && plsql === false) {
      push()
      continue
    }
    cur += c
  }
  push()
  return out
}

/** The object a CREATE of a PL/SQL unit makes: [type as USER_ERRORS has it, name as stored]. */
function createdUnit(sql: string): [string, string] | undefined {
  const m = /^create\s+(?:or\s+replace\s+)?(?:(?:non)?editionable\s+)?(package\s+body|type\s+body|procedure|function|package|trigger|type)\s+(?:"?[\w$#]+"?\s*\.\s*)?("([^"]+)"|[\w$#]+)/i.exec(sql.trim())
  if (!m) return undefined
  return [m[1].toUpperCase().replace(/\s+/, ' '), m[3] ?? m[2].toUpperCase()]
}

type OraError = Error & { errorNum?: number; offset?: number }

/** An Oracle error as its first line, e.g. `ORA-00942: table or view does not exist`, with its number. */
function wrap(e: unknown): never {
  const x = e as OraError
  if (typeof x?.errorNum === 'number' && x.errorNum > 0) throw new DbError(x.message.split('\n')[0].replace(/\s*Help: https?:\S+$/, ''), String(x.errorNum))
  throw e instanceof Error ? new DbError(e.message) : e
}

/** A long text (JSON lists of keys) bound as a CLOB, so it is not cut off at 32 KB. */
export const clob = (val: string) => ({ val, type: oracledb.DB_TYPE_CLOB })

type Param = string | number | boolean | null | ReturnType<typeof clob>

export class OracleConn implements Conn {
  readonly engine = 'Oracle' as const
  private readonly c: oracledb.Connection
  /** the schema LiftOff manages: the signed-in user's */
  readonly schema: string
  /**
   * Inside a transaction the runner started (SET TRANSACTION, until COMMIT or ROLLBACK). Outside
   * one, every statement commits, as on the other engines: a history row is never left pending.
   */
  private inTx = false
  /** The run lock's table while this connection holds it: clean leaves it alone. */
  private lockTable: string | undefined

  private constructor(c: oracledb.Connection, schema: string) {
    this.c = c
    this.schema = schema
  }

  static async open(envName: string, env: Environment): Promise<OracleConn> {
    const fail = (msg: string) => connectError(envName, msg)
    let t: Target
    try {
      t = parseUrl(env.url)
    } catch (e) {
      throw fail(e instanceof Error ? e.message : String(e))
    }
    let c: oracledb.Connection
    try {
      c = await oracledb.getConnection({ connectString: t.connectString, user: env.user ?? t.user, password: env.password ?? t.password, connectTimeout: 10 })
    } catch (e) {
      throw fail((e as Error).message.split('\n')[0])
    }
    // Numbers as LiftOff writes them in scripts, whatever the database's language settings.
    await c.execute("ALTER SESSION SET NLS_NUMERIC_CHARACTERS = '.,'")
    const r = await c.execute<[string]>("SELECT SYS_CONTEXT('USERENV', 'CURRENT_SCHEMA') FROM dual", [], { outFormat: oracledb.OUT_FORMAT_ARRAY })
    return new OracleConn(c, r.rows![0][0])
  }

  /** Rows as arrays; parameters are :1, :2, … */
  async query(sql: string, params: Param[] = []): Promise<unknown[][]> {
    try {
      const r = await this.c.execute(sql, params.map((p) => (typeof p === 'boolean' ? (p ? 1 : 0) : p)), { outFormat: oracledb.OUT_FORMAT_ARRAY, autoCommit: !this.inTx })
      return (r.rows ?? []) as unknown[][]
    } catch (e) {
      wrap(e)
    }
  }

  /** One statement as Oracle takes it (no `;` after SQL, `END;` kept for PL/SQL). */
  private async statement(sql: string): Promise<void> {
    const control = /^\s*(set\s+transaction|commit|rollback)\b/i.exec(sql)?.[1].toLowerCase()
    let r: oracledb.Result<unknown>
    try {
      r = await this.c.execute(sql, [], { autoCommit: !this.inTx && !control })
    } catch (e) {
      if (control === 'rollback') this.inTx = false
      wrap(e)
    }
    if (control) this.inTx = control.startsWith('set')
    // A PL/SQL unit with compile errors is created anyway, with a warning: fail with its errors.
    if (r.warning) {
      const unit = createdUnit(sql)
      const errors = unit
        ? await this.query(`SELECT line, position, text FROM user_errors WHERE type = :1 AND name = :2 AND attribute = 'ERROR' ORDER BY sequence`, unit)
        : []
      const detail = errors.map((e) => `line ${String(e[0])}, column ${String(e[1])}: ${String(e[2]).trim()}`).join('\n')
      throw new DbError(`${unit ? `${unit[0].toLowerCase()} ${unit[1]}` : 'the block'} has compile errors${detail ? `:\n${detail}` : ` (${r.warning.message.split('\n')[0]})`}`, String((r.warning as OraError).errorNum ?? ''))
    }
  }

  /** Statement by statement, as SQL*Plus reads a script. */
  async batch(sql: string): Promise<void> {
    for (const s of splitScript(sql)) await this.statement(s)
  }

  async script(sql: string): Promise<void> {
    await this.batch(sql)
  }

  async serverInfo(): Promise<ServerInfo> {
    const [[version, user]] = await this.query("SELECT (SELECT MAX(version_full) FROM product_component_version), USER FROM dual")
    // The schema is what LiftOff manages here: it stands for the database.
    return { version: String(version), user: String(user), database: this.schema }
  }

  /**
   * A lock row held by an open transaction on a second connection: Oracle releases it when that
   * connection ends, so a crashed run never blocks the next one. Polls (FOR UPDATE NOWAIT), like
   * the other engines. The `lock` setting does not apply here.
   */
  async lock(_schema: string, table: string, _mode: LockMode, onWait: () => void, reopen?: () => Promise<Conn>): Promise<Held> {
    const t = quote(`${table}_lock`)
    if (!(await this.tableExists(`${table}_lock`))) {
      await this.batch(`CREATE TABLE ${t} (id NUMBER(1) PRIMARY KEY)`).catch((e: DbError) => {
        // Another run created it at the same moment; theirs is as good as ours.
        if (e.dbCode !== '955') throw e
      })
    }
    await this.batch(`MERGE INTO ${t} l USING dual ON (l.id = 1) WHEN NOT MATCHED THEN INSERT (id) VALUES (1)`)
    await this.batch('COMMIT')
    if (!reopen) throw new Error('the Oracle run lock needs a second connection')
    this.lockTable = `${table}_lock`
    const holder = (await reopen()) as OracleConn
    // The row lock lasts as long as this transaction: it is never committed.
    await holder.batch('SET TRANSACTION READ WRITE')
    let waited = false
    for (;;) {
      const got = await holder.query(`SELECT id FROM ${t} WHERE id = 1 FOR UPDATE NOWAIT`).then(
        () => true,
        (e: DbError) => {
          if (e.dbCode === '54') return false
          throw e
        },
      )
      if (got) break
      if (!waited) {
        onWait()
        waited = true
      }
      await sleep(500)
    }
    return {
      release: async () => {
        this.lockTable = undefined
        await holder.batch('ROLLBACK').catch(() => {})
        await holder.close()
      },
    }
  }

  async tableExists(table: string): Promise<boolean> {
    const [[n]] = await this.query('SELECT COUNT(*) FROM user_tables WHERE table_name = :1', [table])
    return Number(n) > 0
  }

  async ensureHistory(_schema: string, table: string): Promise<void> {
    if (await this.tableExists(table)) return
    await this.batch(
      `CREATE TABLE ${quote(table)} (
         installed_rank NUMBER(10) NOT NULL PRIMARY KEY,
         version VARCHAR2(50) NULL,
         description VARCHAR2(200) NOT NULL,
         type VARCHAR2(20) NOT NULL,
         script VARCHAR2(1000) NOT NULL,
         checksum NUMBER(10) NULL,
         installed_by VARCHAR2(100) NOT NULL,
         installed_on TIMESTAMP DEFAULT SYS_EXTRACT_UTC(SYSTIMESTAMP) NOT NULL,
         execution_time NUMBER(10) NOT NULL,
         success NUMBER(1) NOT NULL
       )`,
    )
    await this.batch(`CREATE INDEX ${quote(`${table}_s_idx`)} ON ${quote(table)} (success)`)
  }

  async readHistory(_schema: string, table: string): Promise<HistoryRow[]> {
    if (!(await this.tableExists(table))) return []
    const rows = await this.query(
      `SELECT installed_rank, version, description, type, script, checksum, installed_by,
              TO_CHAR(installed_on, 'YYYY-MM-DD"T"HH24:MI:SS"Z"'), execution_time, success
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
       SELECT NVL(MAX(installed_rank), 0) + 1, :1, :2, :3, :4, :5, USER, SYS_EXTRACT_UTC(SYSTIMESTAMP), :6, :7 FROM ${t}`,
      [row.version, row.description, row.type, row.script, row.checksum, row.executionTime, row.success],
    )
  }

  async ensureActivity(_schema: string, table: string): Promise<void> {
    if (await this.tableExists(table)) return
    await this.batch(
      `CREATE TABLE ${quote(table)} (
         id VARCHAR2(36) NOT NULL PRIMARY KEY,
         operation VARCHAR2(20) NOT NULL,
         started_on TIMESTAMP(3) NOT NULL,
         execution_time NUMBER(10) NOT NULL,
         success NUMBER(1) NOT NULL,
         installed_by VARCHAR2(100) NOT NULL,
         os_user VARCHAR2(100) NOT NULL,
         host VARCHAR2(100) NOT NULL,
         pipeline VARCHAR2(1000) NULL,
         git_commit VARCHAR2(64) NULL,
         scripts CLOB NOT NULL,
         detail CLOB NULL
       )`,
    )
  }

  async insertActivity(_schema: string, table: string, a: NewActivity): Promise<void> {
    await this.query(
      `INSERT INTO ${quote(table)} (id, operation, started_on, execution_time, success, installed_by, os_user, host, pipeline, git_commit, scripts, detail)
       VALUES (:1, :2, TO_TIMESTAMP(:3, 'YYYY-MM-DD"T"HH24:MI:SS.FF3"Z"'), :4, :5, USER, :6, :7, :8, :9, :10, :11)`,
      [a.id, a.operation, a.started_on, a.execution_time, a.success, a.os_user, a.host, a.pipeline, a.git_commit, a.scripts.join('\n'), a.detail],
    )
  }

  async readActivity(_schema: string, table: string, limit: number): Promise<Activity[]> {
    if (!(await this.tableExists(table))) return []
    const rows = await this.query(
      `SELECT id, operation, TO_CHAR(started_on, 'YYYY-MM-DD"T"HH24:MI:SS.FF3"Z"'), execution_time, success, installed_by, os_user, host, pipeline, git_commit, scripts, detail
       FROM ${quote(table)} ORDER BY started_on DESC, id FETCH FIRST :1 ROWS ONLY`,
      [limit],
    )
    // An empty text is NULL in Oracle; a run with no scripts has none.
    return rows.map((r) => activityRow([r[0], r[1], r[2], Number(r[3]), Number(r[4]) === 1, r[5], r[6], r[7], r[8], r[9], r[10] ?? '', r[11]]))
  }

  async userObjects(_schemas: string[], table: string): Promise<number> {
    const own = ownTables(table).map(lit).join(', ')
    const [[n]] = await this.query(
      `SELECT COUNT(*) FROM user_objects
       WHERE object_type IN ('TABLE', 'VIEW', 'SEQUENCE', 'PROCEDURE', 'FUNCTION', 'PACKAGE', 'TYPE', 'SYNONYM', 'MATERIALIZED VIEW')
         AND generated = 'N' AND object_name NOT LIKE 'BIN$%' AND object_name NOT IN (${own})`,
    )
    return Number(n)
  }

  async deleteFailed(_schema: string, table: string): Promise<string[]> {
    const scripts = (await this.query(`SELECT script FROM ${quote(table)} WHERE success = 0`)).map((r) => r[0] as string)
    await this.query(`DELETE FROM ${quote(table)} WHERE success = 0`)
    await this.batch('COMMIT')
    return scripts
  }

  async realign(_schema: string, table: string, rank: number, checksum: number, description: string): Promise<void> {
    await this.query(`UPDATE ${quote(table)} SET checksum = :1, description = :2 WHERE installed_rank = :3`, [checksum, description, rank])
    await this.batch('COMMIT')
  }

  /**
   * Drops every object of the schema; the user itself stays.
   * ponytail: drops are retried in passes until nothing is left, which covers dependencies between
   * types and packages without working out their order.
   */
  async resetSchemas(): Promise<void> {
    const rows = await this.query(
      `SELECT object_type, object_name FROM user_objects
       WHERE object_type IN ('MATERIALIZED VIEW', 'VIEW', 'SYNONYM', 'TABLE', 'SEQUENCE', 'PROCEDURE', 'FUNCTION', 'PACKAGE', 'TYPE', 'TRIGGER')
         AND generated = 'N' AND object_name NOT LIKE 'BIN$%' AND object_name NOT LIKE 'ISEQ$$%'
       ORDER BY DECODE(object_type, 'MATERIALIZED VIEW', 0, 'VIEW', 1, 'SYNONYM', 1, 'TRIGGER', 2, 'TABLE', 3, 4)`,
    ).then((rs) => rs.filter((r) => !(r[0] === 'TABLE' && r[1] === this.lockTable)))
    const drop = ([type, name]: unknown[]) =>
      `DROP ${String(type)} ${quote(String(name))}${type === 'TABLE' ? ' CASCADE CONSTRAINTS PURGE' : type === 'TYPE' ? ' FORCE' : ''}`
    let todo = rows.map(drop)
    while (todo.length) {
      const left: string[] = []
      let last: unknown
      for (const stmt of todo) {
        try {
          await this.statement(stmt)
        } catch (e) {
          // Already gone: dropped with its table (a trigger, a materialized view's table).
          if (e instanceof DbError && ['942', '4043', '4080', '2289', '12003'].includes(e.dbCode ?? '')) continue
          left.push(stmt)
          last = e
        }
      }
      if (left.length === todo.length) throw last
      todo = left
    }
  }

  async close(): Promise<void> {
    await this.c.close().catch(() => {})
  }
}
