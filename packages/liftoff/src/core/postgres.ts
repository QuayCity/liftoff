// PostgreSQL: connections, the run lock and the history table.
//
// Every query goes out as one unnamed statement and the connection keeps no session settings,
// so LiftOff also works through connection poolers in transaction mode (PgBouncer, RDS Proxy).

import pg from 'pg'
import * as tls from 'node:tls'
import type { Environment, LockMode } from '../core/config.ts'
import { DbError, connectError } from './errors.ts'
import { activityRow, holderName, ownTables, quoteIdent, sleep, type Activity, type Conn, type Held, type HistoryRow, type NewActivity, type NewRow, type ServerInfo } from './db.ts'
import { splitStatements } from './migration.ts'

export { quoteIdent }

/** The same connection URL, pointing at another database on the same server. */
export function withDatabase(url: string, db: string): string {
  const scheme = url.indexOf('://')
  if (scheme >= 0) {
    const rest = url.slice(scheme + 3)
    const q = rest.indexOf('?')
    const main = q >= 0 ? rest.slice(0, q) : rest
    const query = q >= 0 ? rest.slice(q) : ''
    return `${url.slice(0, scheme + 3)}${main.split('/')[0]}/${db}${query}`
  }
  // key=value form
  return [...url.split(/\s+/).filter((p) => p && !p.startsWith('dbname=')), `dbname=${db}`].join(' ')
}

type Target = { host: string; port: number; database?: string; user?: string; password?: string; sslmode: string }

/** `postgres://user:pw@host:5432/db?sslmode=require` or `host=… port=… dbname=… user=…`. */
export function parseUrl(url: string): Target {
  const t: Target = { host: 'localhost', port: 5432, sslmode: 'prefer' }
  if (/^postgres(ql)?:\/\//i.test(url)) {
    const u = new URL(url)
    if (u.hostname) t.host = decodeURIComponent(u.hostname.replace(/^\[|\]$/g, ''))
    if (u.port) t.port = Number(u.port)
    const db = decodeURIComponent(u.pathname.replace(/^\//, ''))
    if (db) t.database = db
    if (u.username) t.user = decodeURIComponent(u.username)
    if (u.password) t.password = decodeURIComponent(u.password)
    for (const [k, v] of u.searchParams) apply(t, k, v)
    return t
  }
  for (const m of url.matchAll(/(\w+)\s*=\s*('(?:[^'\\]|\\.)*'|\S+)/g)) {
    apply(t, m[1], m[2].startsWith("'") ? m[2].slice(1, -1).replace(/\\(.)/g, '$1') : m[2])
  }
  return t
}

function apply(t: Target, key: string, value: string): void {
  if (key === 'host') t.host = value
  else if (key === 'port') t.port = Number(value)
  else if (key === 'dbname') t.database = value
  else if (key === 'user') t.user = value
  else if (key === 'password') t.password = value
  else if (key === 'sslmode') t.sslmode = value
}

/** Certificates are always verified when TLS is used, against Node's list and the OS store. */
let trusted: string[] | undefined
const ca = () => (trusted ??= [...new Set([...tls.getCACertificates('bundled'), ...tls.getCACertificates('system')])])

/** `ERROR: relation "x" already exists (hint: …)` */
export function describePgError(e: unknown): string {
  if (e instanceof Error && 'severity' in e) {
    const d = e as Error & { severity?: string; hint?: string }
    return `${d.severity}: ${d.message}${d.hint ? ` (hint: ${d.hint})` : ''}`
  }
  // `localhost` is tried on IPv6 and IPv4; when both fail Node reports an AggregateError whose own
  // message is empty.
  if (e instanceof AggregateError && !e.message) {
    return [...new Set(e.errors.map((x) => (x instanceof Error ? x.message : String(x))))].join('; ')
  }
  return e instanceof Error ? e.message : String(e)
}

/** pg errors become DbError with the server's wording and SQLSTATE. */
function wrap(e: unknown): never {
  if (e instanceof Error && 'severity' in e) throw new DbError(describePgError(e), (e as { code?: string }).code)
  throw e
}

export class PgConn implements Conn {
  readonly engine = 'PostgreSQL' as const
  readonly client: pg.Client

  private constructor(client: pg.Client) {
    this.client = client
  }

  static async open(envName: string, env: Environment): Promise<PgConn> {
    if (/^(jdbc:)?sqlserver:/i.test(env.url)) {
      throw new DbError(`'${envName}' is SQL Server; this needs PostgreSQL`)
    }
    let t: Target
    try {
      t = parseUrl(env.url)
    } catch (e) {
      throw connectError(envName, `bad url: ${e instanceof Error ? e.message : e}`)
    }
    const base: pg.ClientConfig = {
      host: t.host,
      port: t.port,
      database: t.database,
      user: env.user ?? t.user,
      password: env.password ?? t.password,
      application_name: 'liftoff',
      connectionTimeoutMillis: 10_000,
    }
    const tlsOptions = { ca: ca(), servername: t.host }
    const attempt = async (ssl: pg.ClientConfig['ssl']) => {
      const client = new pg.Client({ ...base, ssl })
      client.on('error', () => {}) // a dropped connection surfaces on the next query
      try {
        await client.connect()
      } catch (e) {
        // A half-open socket would keep the process alive until the server gives up (a minute).
        await client.end().catch(() => {})
        throw e
      }
      return client
    }
    try {
      if (t.sslmode === 'disable') return new PgConn(await attempt(false))
      try {
        return new PgConn(await attempt(tlsOptions))
      } catch (e) {
        // `prefer` (the default): fall back to plain only when the server has no TLS at all.
        if (t.sslmode === 'prefer' && e instanceof Error && /does not support SSL/i.test(e.message)) return new PgConn(await attempt(false))
        throw e
      }
    } catch (e) {
      if (base.password === undefined && /password must be a string/i.test(describePgError(e))) {
        const variable = `LIFTOFF_ENV_${envName.toUpperCase().replaceAll('-', '_')}_PASSWORD`
        throw connectError(envName, `no password for '${envName}': save one in the desktop app, put it in liftoff.user.toml, or set ${variable}`)
      }
      throw connectError(envName, describePgError(e))
    }
  }

  /** Rows as arrays, in column order. */
  async rows(sql: string, params: unknown[] = []): Promise<unknown[][]> {
    try {
      const r = await this.client.query({ text: sql, values: params, rowMode: 'array' })
      return r.rows as unknown[][]
    } catch (e) {
      wrap(e)
    }
  }

  async row(sql: string, params: unknown[] = []): Promise<unknown[]> {
    const [first] = await this.rows(sql, params)
    if (!first) throw new DbError(`no row returned by: ${sql}`)
    return first
  }

  async batch(sql: string): Promise<void> {
    try {
      await this.client.query(sql)
    } catch (e) {
      wrap(e)
    }
  }

  async script(sql: string, transactional: boolean): Promise<void> {
    if (transactional) return this.batch(sql)
    // Outside a transaction each statement is its own implicit one.
    for (const stmt of splitStatements(sql)) await this.batch(stmt)
  }

  async serverInfo(): Promise<ServerInfo> {
    const [version, user, database] = await this.row("select current_setting('server_version'), current_user::text, current_database()::text")
    return { version: String(version), user: String(user), database: String(database) }
  }

  /**
   * Keeps concurrent runs on one database apart. Both modes poll instead of blocking: a run
   * blocked inside a lock call holds an open transaction, and CREATE INDEX CONCURRENTLY in the lock
   * holder waits for every open transaction, which deadlocks.
   *
   * `advisory`: a session-level pg_try_advisory_lock keyed on the history table; released by
   * `release` or when the connection closes.
   * `table`: a lease row in `<history table>_lock`, renewed every 30 s on its own connection and
   * expiring after 2 minutes, so a crashed run never blocks the next one for long.
   */
  async lock(schema: string, table: string, mode: LockMode, onWait: () => void, reopen?: () => Promise<Conn>): Promise<Held> {
    const key = `${schema}.${table}`
    const lockTable = `${quoteIdent(schema)}.${quoteIdent(`${table}_lock`)}`
    const holder = holderName()
    const LEASE_SECS = 120
    if (mode === 'table') {
      try {
        await this.client.query(
          `CREATE SCHEMA IF NOT EXISTS ${quoteIdent(schema)};
           CREATE TABLE IF NOT EXISTS ${lockTable} (id integer PRIMARY KEY CHECK (id = 1), holder text NOT NULL, expires_at timestamptz NOT NULL)`,
        )
      } catch (e) {
        // IF NOT EXISTS is not safe against a run creating it at the same moment; theirs is as good as ours.
        const code = (e as { code?: string }).code
        if (!['23505', '42P07', '42P06'].includes(code ?? '')) wrap(e)
      }
    }
    let waited = false
    for (;;) {
      const got =
        mode === 'advisory'
          ? (await this.row('select pg_try_advisory_lock(hashtext($1))', [key]))[0] === true
          : (
              await this.rows(
                `insert into ${lockTable} (id, holder, expires_at) values (1, $1, now() + make_interval(secs => $2))
                 on conflict (id) do update set holder = excluded.holder, expires_at = excluded.expires_at
                 where ${lockTable}.expires_at < now()
                 returning holder`,
                [holder, LEASE_SECS],
              )
            ).length > 0
      if (got) break
      if (!waited) {
        onWait()
        waited = true
      }
      await sleep(500)
    }
    if (mode === 'advisory') {
      return { release: async () => void (await this.rows('select pg_advisory_unlock(hashtext($1))', [key]).catch(() => {})) }
    }
    // Long scripts keep this connection busy, so the lease is renewed on a second one.
    let stop = false
    const renewer = reopen?.().then((c) => c as PgConn).catch(() => undefined)
    const timer = setInterval(async () => {
      const r = await renewer
      if (!stop && r) await r.rows(`update ${lockTable} set expires_at = now() + make_interval(secs => $2) where holder = $1`, [holder, LEASE_SECS]).catch(() => {})
    }, 30_000)
    return {
      release: async () => {
        stop = true
        clearInterval(timer)
        await (await renewer)?.close()
        await this.rows(`delete from ${lockTable} where holder = $1`, [holder]).catch(() => {})
      },
    }
  }

  async historyExists(schema: string, table: string): Promise<boolean> {
    return (await this.row('select to_regclass($1) is not null', [`${quoteIdent(schema)}.${quoteIdent(table)}`]))[0] === true
  }

  async ensureHistory(schema: string, table: string): Promise<void> {
    const [s, t] = [quoteIdent(schema), quoteIdent(table)]
    await this.batch(
      `CREATE SCHEMA IF NOT EXISTS ${s};
       CREATE TABLE IF NOT EXISTS ${s}.${t} (
         installed_rank integer NOT NULL PRIMARY KEY,
         version varchar(50),
         description varchar(200) NOT NULL,
         type varchar(20) NOT NULL,
         script varchar(1000) NOT NULL,
         checksum integer,
         installed_by varchar(100) NOT NULL,
         installed_on timestamp NOT NULL DEFAULT now(),
         execution_time integer NOT NULL,
         success boolean NOT NULL
       );
       CREATE INDEX IF NOT EXISTS ${quoteIdent(`${table}_s_idx`)} ON ${s}.${t} (success);`,
    )
  }

  async readHistory(schema: string, table: string): Promise<HistoryRow[]> {
    if (!(await this.historyExists(schema, table))) return []
    const rows = await this.rows(
      `select installed_rank, version, description, type, script, checksum, installed_by,
              to_char(installed_on, 'YYYY-MM-DD"T"HH24:MI:SS"Z"'), execution_time, success
       from ${quoteIdent(schema)}.${quoteIdent(table)} order by installed_rank`,
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
    const t = `${quoteIdent(schema)}.${quoteIdent(table)}`
    await this.rows(
      `insert into ${t} (installed_rank, version, description, type, script, checksum, installed_by, installed_on, execution_time, success)
       select coalesce(max(installed_rank), 0) + 1, $1::varchar, $2::varchar, $3::varchar, $4::varchar, $5::integer, current_user, now() at time zone 'UTC', $6::integer, $7::boolean from ${t}`,
      [row.version, row.description, row.type, row.script, row.checksum, row.executionTime, row.success],
    )
  }

  async ensureActivity(schema: string, table: string): Promise<void> {
    const [s, t] = [quoteIdent(schema), quoteIdent(table)]
    await this.batch(
      `CREATE SCHEMA IF NOT EXISTS ${s};
       CREATE TABLE IF NOT EXISTS ${s}.${t} (
         id varchar(36) NOT NULL PRIMARY KEY,
         operation varchar(20) NOT NULL,
         started_on timestamp NOT NULL,
         execution_time integer NOT NULL,
         success boolean NOT NULL,
         installed_by varchar(100) NOT NULL,
         os_user varchar(100) NOT NULL,
         host varchar(100) NOT NULL,
         pipeline varchar(1000),
         git_commit varchar(64),
         scripts text NOT NULL,
         detail text
       );`,
    )
  }

  async insertActivity(schema: string, table: string, a: NewActivity): Promise<void> {
    await this.rows(
      `insert into ${quoteIdent(schema)}.${quoteIdent(table)} (id, operation, started_on, execution_time, success, installed_by, os_user, host, pipeline, git_commit, scripts, detail)
       values ($1, $2, $3::timestamptz at time zone 'UTC', $4, $5, current_user, $6, $7, $8, $9, $10, $11)`,
      [a.id, a.operation, a.started_on, a.execution_time, a.success, a.os_user, a.host, a.pipeline, a.git_commit, a.scripts.join('\n'), a.detail],
    )
  }

  async readActivity(schema: string, table: string, limit: number): Promise<Activity[]> {
    if (!(await this.historyExists(schema, table))) return []
    const rows = await this.rows(
      `select id, operation, to_char(started_on, 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'), execution_time, success, installed_by, os_user, host, pipeline, git_commit, scripts, detail
       from ${quoteIdent(schema)}.${quoteIdent(table)} order by started_on desc, id limit $1`,
      [limit],
    )
    return rows.map(activityRow)
  }

  async userObjects(schemas: string[], table: string): Promise<number> {
    const [n] = await this.row(
      `select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace
       where n.nspname = any($1) and c.relkind in ('r', 'p', 'v', 'm', 'S') and c.relname <> all($2)
         and not exists (select 1 from pg_depend d where d.objid = c.oid and d.deptype in ('a', 'i', 'e'))`,
      [schemas, ownTables(table)],
    )
    return Number(n)
  }

  async deleteFailed(schema: string, table: string): Promise<string[]> {
    return (await this.rows(`delete from ${quoteIdent(schema)}.${quoteIdent(table)} where not success returning script`)).map((r) => r[0] as string)
  }

  async realign(schema: string, table: string, rank: number, checksum: number, description: string): Promise<void> {
    await this.rows(`update ${quoteIdent(schema)}.${quoteIdent(table)} set checksum = $1, description = $2 where installed_rank = $3`, [checksum, description, rank])
  }

  /**
   * ponytail: DROP SCHEMA … CASCADE + CREATE SCHEMA resets the schema's own owner and grants;
   * drop objects one by one if a customer needs those kept.
   */
  async resetSchemas(schemas: string[]): Promise<void> {
    for (const s of schemas) await this.batch(`DROP SCHEMA IF EXISTS ${quoteIdent(s)} CASCADE; CREATE SCHEMA ${quoteIdent(s)};`)
  }

  async close(): Promise<void> {
    await this.client.end().catch(() => {})
  }
}
