// What each engine does with schemas: read one from a database, compare two, write the schema
// model's files, and create an empty database next to another (the scratch database). The rest of
// the code (diff.ts, compare.ts, model.ts) goes through `ops`, so it has no engine-specific code.

import type { Change } from './changes.ts'
import type { Project } from './config.ts'
import type { Conn, EngineName } from './db.ts'
import * as ms from './msdiff.ts'
import { MySqlConn, quote as myQuote, withDatabase as myWithDatabase } from './mysql.ts'
import * as my from './mysqldiff.ts'
import type { OracleConn } from './oracle.ts'
import * as ora from './oradiff.ts'
import * as pgd from './pgdiff.ts'
import { PgConn, quoteIdent, withDatabase as pgWithDatabase } from './postgres.ts'
import { SqlServerConn, quote, withDatabase as msWithDatabase } from './sqlserver.ts'

/** A schema as an engine reads it; every engine's model lists what it does not compare. */
export type Model = { not_compared: [string, number][] }

export type SchemaOps = {
  name: EngineName
  introspect(c: Conn, schemas: string[], historyTable: string): Promise<Model>
  /** Removes what the project's comparison filters exclude. */
  applyFilters(m: Model, p: Project): void
  /** Changes that turn `target` into `source`, with undo steps. */
  diff(source: Model, target: Model): Change[]
  /** Everything, as changes against an empty database (capture, squash). */
  createAll(m: Model): Change[]
  /** The schema model: one file per object, by path under schema-model/. */
  files(m: Model): Map<string, string>
  /** The same connection URL, for another database on the same server. */
  withDatabase(url: string, database: string): string
  /**
   * Creates an empty database on the server `c` is connected to. Throws `taken()` when it
   * exists, `noRights(what is needed)` when the login may not.
   */
  createDatabase(c: Conn, database: string, taken: () => Error, noRights: (needs: string) => Error): Promise<void>
}

const pg: SchemaOps = {
  name: 'PostgreSQL',
  introspect: (c, schemas, table) => pgd.introspect(c as PgConn, schemas, table),
  applyFilters: (m, p) => pgd.applyFilters(m as pgd.Model, p),
  diff: (a, b) => pgd.diff(a as pgd.Model, b as pgd.Model),
  createAll: (m) => pgd.compare(m as pgd.Model, pgd.emptyModel()),
  files: (m) => pgd.files(m as pgd.Model),
  withDatabase: pgWithDatabase,
  async createDatabase(c, database, taken, noRights) {
    const pc = c as PgConn
    if ((await pc.row('select exists (select 1 from pg_database where datname = $1)', [database]))[0] === true) throw taken()
    await pc.batch(`CREATE DATABASE ${quoteIdent(database)}`).catch((e: { dbCode?: string }) => {
      throw e.dbCode === '42501' ? noRights('it needs CREATEDB') : e
    })
  },
}

const sqlserver: SchemaOps = {
  name: 'SQL Server',
  introspect: (c, schemas, table) => ms.introspect(c as SqlServerConn, schemas, table),
  applyFilters: (m, p) => ms.applyFilters(m as ms.MsModel, p),
  diff: (a, b) => ms.diff(a as ms.MsModel, b as ms.MsModel),
  createAll: (m) => ms.createAll(m as ms.MsModel),
  files: (m) => ms.files(m as ms.MsModel),
  withDatabase: msWithDatabase,
  async createDatabase(c, database, taken, noRights) {
    const sc = c as SqlServerConn
    if ((await sc.query('SELECT DB_ID(@P1)', [database]))[0]?.[0] != null) throw taken()
    await sc.batch(`CREATE DATABASE ${quote(database)}`).catch((e: { dbCode?: string }) => {
      throw e.dbCode === '262' ? noRights('it needs CREATE ANY DATABASE or dbcreator') : e
    })
  },
}

const mysql: SchemaOps = {
  name: 'MySQL',
  introspect: (c, schemas, table) => my.introspect(c as MySqlConn, schemas, table),
  applyFilters: (m, p) => my.applyFilters(m as my.MyModel, p),
  diff: (a, b) => my.diff(a as my.MyModel, b as my.MyModel),
  createAll: (m) => my.createAll(m as my.MyModel),
  files: (m) => my.files(m as my.MyModel),
  withDatabase: myWithDatabase,
  async createDatabase(c, database, taken, noRights) {
    const mc = c as MySqlConn
    if ((await mc.query('SELECT COUNT(*) FROM information_schema.schemata WHERE schema_name = ?', [database]))[0][0] != 0) throw taken()
    await mc.batch(`CREATE DATABASE ${myQuote(database)}`).catch((e: { dbCode?: string }) => {
      throw e.dbCode === '1044' ? noRights('it needs the CREATE privilege') : e
    })
  },
}

const oracle: SchemaOps = {
  name: 'Oracle',
  introspect: (c, schemas, table) => ora.introspect(c as OracleConn, schemas, table),
  applyFilters: (m, p) => ora.applyFilters(m as ora.OraModel, p),
  diff: (a, b) => ora.diff(a as ora.OraModel, b as ora.OraModel),
  createAll: (m) => ora.createAll(m as ora.OraModel),
  files: (m) => ora.files(m as ora.OraModel),
  // The schema is the user signed in as: another one is another user, not another URL.
  withDatabase: (url) => url,
  async createDatabase(_c, database, _taken, noRights) {
    throw noRights(`on Oracle a scratch schema is a user of its own; ask a DBA to create a user such as ${database.toUpperCase()}`)
  },
}

/** By the engine's tag (EngineInfo.tag in db.ts), as snapshot files store it. */
export const ops: Record<string, SchemaOps> = { pg, ms: sqlserver, my: mysql, ora: oracle }

/** The schema operations for a connection's engine. */
export function opsFor(engine: EngineName): [tag: string, SchemaOps] {
  const found = Object.entries(ops).find(([, o]) => o.name === engine)
  if (!found) throw new Error(`no schema support for ${engine}`)
  return found
}
