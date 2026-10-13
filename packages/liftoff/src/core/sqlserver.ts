// SQL Server: connection, run lock, history table and clean.
//
// One tedious Connection per run, so the session-owned run lock, SET XACT_ABORT and
// transactions spanning several batches all stay on the same session.

import { InteractiveBrowserCredential } from '@azure/identity'
import { Connection, Request, TYPES, type ConnectionConfiguration } from 'tedious'
import type { Environment, LockMode } from './config.ts'
import { DbError, connectError } from './errors.ts'
import { activityRow, ownTables, sleep, type Activity, type Conn, type Held, type HistoryRow, type NewActivity, type NewRow, type ServerInfo } from './db.ts'
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

/** The sign-in methods, by their JDBC `authentication=` names (as Flyway projects write them). */
export const SIGN_IN = ['SqlPassword', 'ActiveDirectoryDefault', 'ActiveDirectoryInteractive', 'ActiveDirectoryServicePrincipal', 'ActiveDirectoryManagedIdentity'] as const

// One browser sign-in per process and account: the credential keeps its token in memory, so a
// command that opens several connections (dev, scratch) asks once.
const interactive = new Map<string, InteractiveBrowserCredential>()

/**
 * The driver's sign-in for `authentication=` in the URL. Microsoft Entra ID methods contact
 * Microsoft's sign-in service: the one place LiftOff reaches beyond the databases.
 */
export function signIn(props: Map<string, string>, user: string | undefined, password: string | undefined): ConnectionConfiguration['authentication'] {
  const method = (props.get('authentication') ?? 'SqlPassword').toLowerCase()
  const tenantId = props.get('tenantid')
  const need = (v: string | undefined, what: string) => {
    if (!v) throw new Error(`${props.get('authentication')} needs ${what}`)
    return v
  }
  switch (method) {
    case 'sqlpassword':
    case 'notspecified':
      return { type: 'default', options: { userName: user, password } }
    case 'activedirectorydefault':
      // az login, Visual Studio Code's Azure sign-in, AZURE_* variables, or a managed identity
      return { type: 'azure-active-directory-default', options: { clientId: user } }
    case 'activedirectoryinteractive': {
      const key = `${tenantId ?? ''}/${user ?? ''}`
      let credential = interactive.get(key)
      if (!credential) interactive.set(key, (credential = new InteractiveBrowserCredential({ tenantId, loginHint: user })))
      return { type: 'token-credential', options: { credential } }
    }
    case 'activedirectoryserviceprincipal':
      return {
        type: 'azure-active-directory-service-principal-secret',
        options: { clientId: need(user, 'the application (client) ID as the user'), clientSecret: need(password, 'the client secret as the password'), tenantId: need(tenantId, 'tenantId=… in the URL') },
      }
    case 'activedirectorymanagedidentity':
    case 'activedirectorymsi':
      return { type: 'azure-active-directory-msi-vm', options: { clientId: user } }
    default:
      throw new Error(`authentication=${props.get('authentication')} is not supported; use one of ${SIGN_IN.join(', ')}`)
  }
}

/** The driver's message, with what to do about a certificate the computer does not trust (its own hint names a Node.js flag). */
export function describeConnectError(message: string): string {
  if (!/self[- ]signed certificate|unable to verify the first certificate|unable to get local issuer certificate|certificate has expired/i.test(message)) return message
  return `${message.replace(/;\s*if the root CA is installed locally.*$/i, '')}. The server's certificate is not trusted by this computer: install its CA certificate, or, for a server you know (e.g. a local container), trust it with trustServerCertificate=true (in the app: Trust the server certificate)`
}

/** The same URL pointing at another database on the same server. */
export function withDatabase(url: string, db: string): string {
  const parts = url.split(';').filter((p) => !/^\s*(databaseName|database)\s*=/i.test(p))
  return [...parts, `databaseName=${db}`].join(';')
}

/** A SQL Server error with its number and line, e.g. `Invalid object name 'x'. (error 208, line 2)` */
function wrap(e: unknown): never {
  type SqlError = Error & { number: number; lineNumber?: number }
  const one = (x: SqlError) => `${x.message} (error ${x.number}, line ${x.lineNumber ?? 0})`
  // Several errors in one batch arrive together, with an empty message of their own.
  if (e instanceof AggregateError && e.errors.length) {
    const errors = e.errors.filter((x): x is SqlError => x instanceof Error && 'number' in x)
    if (errors.length) throw new DbError(errors.map(one).join('\n'), String(errors.at(-1)!.number))
  }
  if (e instanceof Error && 'number' in e) throw new DbError(one(e as SqlError), String((e as SqlError).number))
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
    if (flag('integratedsecurity', false)) throw fail('Windows integrated login is not supported yet; use a SQL login (user and password) or Microsoft Entra ID (authentication=ActiveDirectoryDefault)')
    let authentication: ConnectionConfiguration['authentication']
    try {
      authentication = signIn(u.props, env.user ?? u.props.get('user') ?? u.props.get('username'), env.password ?? u.props.get('password'))
    } catch (e) {
      throw fail(e instanceof Error ? e.message : String(e))
    }
    const config: ConnectionConfiguration = {
      server: u.server,
      authentication,
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
      connection.connect((err) => (err ? reject(fail(describeConnectError(err.message))) : resolve()))
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

  async ensureActivity(schema: string, table: string): Promise<void> {
    await this.query("IF SCHEMA_ID(@P1) IS NULL BEGIN DECLARE @s nvarchar(400) = N'CREATE SCHEMA ' + QUOTENAME(@P1); EXEC (@s) END", [schema])
    if (await this.historyExists(schema, table)) return
    await this.batch(
      `CREATE TABLE ${quote(schema)}.${quote(table)} (
         id nvarchar(36) NOT NULL PRIMARY KEY,
         operation nvarchar(20) NOT NULL,
         started_on datetime2(3) NOT NULL,
         execution_time int NOT NULL,
         success bit NOT NULL,
         installed_by nvarchar(100) NOT NULL,
         os_user nvarchar(100) NOT NULL,
         host nvarchar(100) NOT NULL,
         pipeline nvarchar(1000) NULL,
         git_commit nvarchar(64) NULL,
         scripts nvarchar(max) NOT NULL,
         detail nvarchar(max) NULL
       );`,
    )
  }

  async insertActivity(schema: string, table: string, a: NewActivity): Promise<void> {
    await this.query(
      `INSERT INTO ${quote(schema)}.${quote(table)} (id, operation, started_on, execution_time, success, installed_by, os_user, host, pipeline, git_commit, scripts, detail)
       VALUES (@P1, @P2, CONVERT(datetime2(3), @P3, 127), @P4, @P5, SUSER_SNAME(), @P6, @P7, @P8, @P9, @P10, @P11)`,
      [a.id, a.operation, a.started_on, a.execution_time, a.success, a.os_user, a.host, a.pipeline, a.git_commit, a.scripts.join('\n'), a.detail],
    )
  }

  async readActivity(schema: string, table: string, limit: number): Promise<Activity[]> {
    if (!(await this.historyExists(schema, table))) return []
    const rows = await this.query(
      `SELECT TOP (@P1) id, operation, CONVERT(varchar(23), started_on, 126) + 'Z', execution_time, success, installed_by, os_user, host, pipeline, git_commit, scripts, detail
       FROM ${quote(schema)}.${quote(table)} ORDER BY started_on DESC, id`,
      [limit],
    )
    return rows.map(activityRow)
  }

  async userObjects(schemas: string[], table: string): Promise<number> {
    const [[n]] = await this.query(
      `SELECT COUNT(*) FROM sys.objects o JOIN sys.schemas s ON s.schema_id = o.schema_id
       WHERE s.name IN (${schemas.map(lit).join(', ')}) AND o.is_ms_shipped = 0 AND o.parent_object_id = 0
         AND o.type IN ('U', 'V', 'P', 'FN', 'IF', 'TF', 'SO', 'SN') AND o.name NOT IN (${ownTables(table).map(lit).join(', ')})`,
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
    // The schemas themselves stay, or are created when the database never had them.
    for (const s of schemas) await this.query("IF SCHEMA_ID(@P1) IS NULL BEGIN DECLARE @s nvarchar(400) = N'CREATE SCHEMA ' + QUOTENAME(@P1); EXEC (@s) END", [s])
  }

  async close(): Promise<void> {
    await this.queue.catch(() => {})
    await new Promise<void>((resolve) => {
      this.c.once('end', () => resolve())
      this.c.close()
    })
  }
}
