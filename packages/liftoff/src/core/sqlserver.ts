// SQL Server: connection, run lock, history table and clean.
//
// One tedious Connection per run, so the session-owned run lock, SET XACT_ABORT and
// transactions spanning several batches all stay on the same session.

import { Connection, Request, TYPES, type ConnectionConfiguration } from 'tedious'
import type { Environment, LockMode } from './config.ts'
import { DbError, connectError } from './errors.ts'
import { sleep, type Conn, type Held, type HistoryRow, type NewRow, type ServerInfo } from './db.ts'
import { splitBatches } from './migration.ts'

/** `[name]`, with `]` doubled, as QUOTENAME does. */
export const quote = (s: string) => `[${s.replaceAll(']', ']]')}]`

/** `N'text'`, with `'` doubled. */
export const lit = (s: string) => `N'${s.replaceAll("'", "''")}'`

/** `sqlserver://host[\instance][:port];databaseName=shop;encrypt=true` (the JDBC form, with or without `jdbc:`). */
export function parseUrl(url: string): { server: string; port?: number; instance?: string; props: Map<string, string> } {
  const body = url.trim().replace(/^jdbc:/i, '').replace(/^sqlserver:\/\//i, '')
  const [hostPart, ...rest] = body.split(';')
  const props = new Map<string, string>()
  for (const kv of rest) {
    const i = kv.indexOf('=')
    if (i > 0) props.set(kv.slice(0, i).trim().toLowerCase(), kv.slice(i + 1).trim())
  }
  let host = hostPart
  let port: number | undefined
  const colon = host.lastIndexOf(':')
  if (colon > 0) {
    port = Number(host.slice(colon + 1))
    host = host.slice(0, colon)
  }
  const [server, instance] = host.split('\\')
  if (props.has('portnumber')) port = Number(props.get('portnumber'))
  return { server: server || 'localhost', port, instance: instance ?? props.get('instancename'), props }
}

/** The same URL pointing at another database on the same server. */
export function withDatabase(url: string, db: string): string {
  const parts = url.split(';').filter((p) => !/^\s*(databaseName|database)\s*=/i.test(p))
  return [...parts, `databaseName=${db}`].join(';')
}

/** A SQL Server error with its number and line, e.g. `Invalid object name 'x'. (error 208, line 2)` */
function wrap(e: unknown): never {
  if (e instanceof Error && 'number' in e) {
    const x = e as Error & { number: number; lineNumber?: number }
    throw new DbError(`${x.message} (error ${x.number}, line ${x.lineNumber ?? 0})`, String(x.number))
  }
  throw e instanceof Error ? new DbError(e.message) : e
}

type Param = string | number | boolean | null

function sqlType(v: Param) {
  if (typeof v === 'number') return Number.isInteger(v) ? TYPES.Int : TYPES.Float
  if (typeof v === 'boolean') return TYPES.Bit
  return TYPES.NVarChar
}

export class SqlServerConn implements Conn {
  readonly engine = 'SQL Server' as const
  private readonly c: Connection
  /** tedious runs one request at a time; this chains them */
  private queue: Promise<unknown> = Promise.resolve()

  private constructor(c: Connection) {
    this.c = c
  }

  static async open(envName: string, env: Environment): Promise<SqlServerConn> {
    const fail = (msg: string) => connectError(envName, msg)
    const u = parseUrl(env.url)
    const flag = (k: string, dflt: boolean) => (u.props.has(k) ? /^(true|yes|1|strict|mandatory)$/i.test(u.props.get(k)!) : dflt)
    if (flag('integratedsecurity', false)) throw fail('Windows integrated login is not supported yet; use a SQL login (user and password)')
    const config: ConnectionConfiguration = {
      server: u.server,
      authentication: {
        type: 'default',
        options: { userName: env.user ?? u.props.get('user') ?? u.props.get('username'), password: env.password ?? u.props.get('password') },
      },
      options: {
        port: u.instance ? undefined : (u.port ?? 1433),
        instanceName: u.instance,
        database: u.props.get('databasename') ?? u.props.get('database'),
        encrypt: flag('encrypt', true),
        trustServerCertificate: flag('trustservercertificate', false),
        appName: 'liftoff',
        connectTimeout: 10_000,
        requestTimeout: 0, // migrations may take as long as they take
        useColumnNames: false,
      },
    }
    const connection = new Connection(config)
    await new Promise<void>((resolve, reject) => {
      connection.connect((err) => (err ? reject(fail(err.message)) : resolve()))
    })
    connection.on('error', () => {}) // a dropped connection surfaces on the next request
    const conn = new SqlServerConn(connection)
    // A failing statement rolls back the whole transaction instead of only itself.
    await conn.batch('SET XACT_ABORT ON; SET NOCOUNT ON;')
    return conn
  }

  private run(sql: string, params: Param[] | null): Promise<unknown[][]> {
    const job = this.queue.then(
      () =>
        new Promise<unknown[][]>((resolve, reject) => {
          const rows: unknown[][] = []
          const req = new Request(sql, (err) => (err ? reject(err) : resolve(rows)))
          req.on('row', (cols: { value: unknown }[]) => rows.push(cols.map((c) => c.value)))
          if (params === null) return this.c.execSqlBatch(req)
          params.forEach((v, i) => req.addParameter(`P${i + 1}`, sqlType(v), v))
          this.c.execSql(req)
        }),
    )
    this.queue = job.catch(() => {})
    return job.catch(wrap)
  }

  /** Rows (of every result set) as arrays; parameters are @P1, @P2, … */
  query(sql: string, params: Param[] = []): Promise<unknown[][]> {
    return this.run(sql, params)
  }

  async batch(sql: string): Promise<void> {
    await this.run(sql, null)
  }

  /** Batch by batch on GO lines; `GO n` repeats one. */
  async script(sql: string): Promise<void> {
    for (const b of splitBatches(sql)) {
      for (let i = 0; i < b.times; i++) await this.batch(b.sql)
    }
  }

  async serverInfo(): Promise<ServerInfo> {
    const [[version, user, database]] = await this.query("SELECT CAST(SERVERPROPERTY('ProductVersion') AS nvarchar(128)), SUSER_SNAME(), DB_NAME()")
    return { version: String(version), user: String(user), database: String(database) }
  }

  /**
   * A session-owned application lock: released by `release` or when the connection closes.
   * Polls, like the PostgreSQL lock. The `lock` setting does not apply here: SQL Server always
   * uses its own application lock.
   */
  async lock(schema: string, table: string, _mode: LockMode, onWait: () => void): Promise<Held> {
    const resource = `liftoff:${schema}.${table}`
    let waited = false
    for (;;) {
      const [[r]] = await this.query(
        "DECLARE @r int; EXEC @r = sp_getapplock @Resource = @P1, @LockMode = 'Exclusive', @LockOwner = 'Session', @LockTimeout = 0; SELECT @r",
        [resource],
      )
      if (typeof r === 'number' && r >= 0) break
      if (!waited) {
        onWait()
        waited = true
      }
      await sleep(500)
    }
    return { release: async () => void (await this.query("EXEC sp_releaseapplock @Resource = @P1, @LockOwner = 'Session'", [resource]).catch(() => {})) }
  }

  async historyExists(schema: string, table: string): Promise<boolean> {
    const [[n]] = await this.query("SELECT CASE WHEN OBJECT_ID(@P1, N'U') IS NULL THEN 0 ELSE 1 END", [`${quote(schema)}.${quote(table)}`])
    return n === 1
  }

  async ensureHistory(schema: string, table: string): Promise<void> {
    // CREATE SCHEMA must be alone in its batch, hence EXEC.
    await this.query("IF SCHEMA_ID(@P1) IS NULL BEGIN DECLARE @s nvarchar(400) = N'CREATE SCHEMA ' + QUOTENAME(@P1); EXEC (@s) END", [schema])
    if (await this.historyExists(schema, table)) return
    const [s, t] = [quote(schema), quote(table)]
    await this.batch(
      `CREATE TABLE ${s}.${t} (
         installed_rank int NOT NULL PRIMARY KEY,
         version nvarchar(50) NULL,
         description nvarchar(200) NOT NULL,
         type nvarchar(20) NOT NULL,
         script nvarchar(1000) NOT NULL,
         checksum int NULL,
         installed_by nvarchar(100) NOT NULL,
         installed_on datetime NOT NULL DEFAULT GETUTCDATE(),
         execution_time int NOT NULL,
         success bit NOT NULL
       );
       CREATE INDEX ${quote(`${table}_s_idx`)} ON ${s}.${t} (success);`,
    )
  }

  async readHistory(schema: string, table: string): Promise<HistoryRow[]> {
    if (!(await this.historyExists(schema, table))) return []
    const rows = await this.query(
      `SELECT installed_rank, version, description, type, script, checksum, installed_by,
              CONVERT(varchar(19), installed_on, 126) + 'Z', execution_time, success
       FROM ${quote(schema)}.${quote(table)} ORDER BY installed_rank`,
    )
    return rows.map((r) => ({
      installed_rank: r[0] as number,
      version: r[1] as string | null,
      description: r[2] as string,
      type: r[3] as string,
      script: r[4] as string,
      checksum: r[5] as number | null,
      installed_by: r[6] as string,
      installed_on: r[7] as string,
      execution_time: r[8] as number,
      success: r[9] as boolean,
    }))
  }

  async insertHistory(schema: string, table: string, row: NewRow): Promise<void> {
    const t = `${quote(schema)}.${quote(table)}`
    await this.query(
      `INSERT INTO ${t} (installed_rank, version, description, type, script, checksum, installed_by, installed_on, execution_time, success)
       SELECT COALESCE(MAX(installed_rank), 0) + 1, @P1, @P2, @P3, @P4, @P5, SUSER_SNAME(), GETUTCDATE(), @P6, @P7 FROM ${t}`,
      [row.version, row.description, row.type, row.script, row.checksum, row.executionTime, row.success],
    )
  }

  async userObjects(schemas: string[], table: string): Promise<number> {
    const [[n]] = await this.query(
      `SELECT COUNT(*) FROM sys.objects o JOIN sys.schemas s ON s.schema_id = o.schema_id
       WHERE s.name IN (${schemas.map(lit).join(', ')}) AND o.is_ms_shipped = 0 AND o.parent_object_id = 0
         AND o.type IN ('U', 'V', 'P', 'FN', 'IF', 'TF', 'SO', 'SN') AND o.name <> @P1`,
      [table],
    )
    return Number(n)
  }

  async deleteFailed(schema: string, table: string): Promise<string[]> {
    return (await this.query(`DELETE FROM ${quote(schema)}.${quote(table)} OUTPUT deleted.script WHERE success = 0`)).map((r) => r[0] as string)
  }

  async realign(schema: string, table: string, rank: number, checksum: number, description: string): Promise<void> {
    await this.query(`UPDATE ${quote(schema)}.${quote(table)} SET checksum = @P1, description = @P2 WHERE installed_rank = @P3`, [checksum, description, rank])
  }

  /**
   * Drops every user object in the schemas; the schemas themselves stay (dbo cannot be dropped).
   * ponytail: drops are retried in passes until nothing is left, which covers dependencies between
   * views and routines without working out their order; XML schema collections and full-text
   * catalogs are not dropped.
   */
  async resetSchemas(schemas: string[]): Promise<void> {
    const names = schemas.map(lit).join(', ')
    const rows = await this.query(
      `SELECT 0, N'ALTER TABLE ' + QUOTENAME(ps.name) + N'.' + QUOTENAME(pt.name) + N' DROP CONSTRAINT ' + QUOTENAME(f.name)
       FROM sys.foreign_keys f
       JOIN sys.tables pt ON pt.object_id = f.parent_object_id JOIN sys.schemas ps ON ps.schema_id = pt.schema_id
       JOIN sys.tables rt ON rt.object_id = f.referenced_object_id JOIN sys.schemas rs ON rs.schema_id = rt.schema_id
       WHERE ps.name IN (${names}) OR rs.name IN (${names})
       UNION ALL
       SELECT 1, N'ALTER TABLE ' + QUOTENAME(s.name) + N'.' + QUOTENAME(t.name) + N' SET (SYSTEM_VERSIONING = OFF)'
       FROM sys.tables t JOIN sys.schemas s ON s.schema_id = t.schema_id
       WHERE s.name IN (${names}) AND t.temporal_type = 2
       UNION ALL
       SELECT CASE o.type WHEN 'U' THEN 3 WHEN 'SO' THEN 4 ELSE 2 END,
              N'DROP ' + CASE o.type WHEN 'V' THEN N'VIEW' WHEN 'P' THEN N'PROCEDURE' WHEN 'SN' THEN N'SYNONYM'
                                     WHEN 'U' THEN N'TABLE' WHEN 'SO' THEN N'SEQUENCE' ELSE N'FUNCTION' END
              + N' ' + QUOTENAME(s.name) + N'.' + QUOTENAME(o.name)
       FROM sys.objects o JOIN sys.schemas s ON s.schema_id = o.schema_id
       WHERE s.name IN (${names}) AND o.is_ms_shipped = 0 AND o.parent_object_id = 0
         AND o.type IN ('V', 'P', 'FN', 'IF', 'TF', 'SN', 'U', 'SO')
       UNION ALL
       SELECT 5, N'DROP TYPE ' + QUOTENAME(s.name) + N'.' + QUOTENAME(t.name)
       FROM sys.types t JOIN sys.schemas s ON s.schema_id = t.schema_id
       WHERE t.is_user_defined = 1 AND s.name IN (${names})
       ORDER BY 1`,
    )
    let todo = rows.map((r) => r[1] as string)
    while (todo.length) {
      const left: string[] = []
      let last: unknown
      for (const stmt of todo) {
        try {
          await this.batch(stmt)
        } catch (e) {
          left.push(stmt)
          last = e
        }
      }
      if (left.length === todo.length) throw last
      todo = left
    }
  }

  async close(): Promise<void> {
    await this.queue.catch(() => {})
    await new Promise<void>((resolve) => {
      this.c.once('end', () => resolve())
      this.c.close()
    })
  }
}
