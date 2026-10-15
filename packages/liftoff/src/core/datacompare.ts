// Data compare: which rows differ between the same tables in two databases, and the INSERT /
// UPDATE / DELETE statements that make the target's rows match the source's.
//
// Fast on big tables because rows are compared where they are, by hash:
//   1. each side returns one row count and one fingerprint for the whole table (a sum of row
//      hashes); equal on both sides means the table is the same, whatever its size
//   2. a table that differs is split into buckets by a hash of its key; each side returns one
//      count and fingerprint per bucket (about 16 rows each, so changes spread over the table
//      re-read little; the GROUP BY also lets SQL Server use every core, which one sum over the
//      table does not, so tables above 5,000 rows start here)
//   3. only for the buckets that differ, each side returns (key, row hash) pairs, about 500,000
//      rows at a time; comparing those gives the rows that are only in the source, only in the
//      target, or different, and only those are kept
// A table without a key (a heap) is compared as whole rows: buckets by row hash, then the row
// hashes counted on each side. Extra copies are only in the source or only in the target; a
// changed row shows as one of each, since nothing says it is the same row.
// Full rows are read later, and only for differing keys: page by page to look at, in batches for
// a script. Both sides must run the same engine (the hashes are computed by the database).
// A fingerprint match is a hash match: the chance that different rows give the same 60-bit sum
// is about one in 10^18.

import * as fs from 'node:fs'
import * as path from 'node:path'
import type { Config, Environment } from './config.ts'
import { compares } from './config.ts'
import { dialect, open, ownTables, type Conn, type EngineName } from './db.ts'
import { configError } from './errors.ts'
import { typeName } from './msdiff.ts'
import { PgConn, quoteIdent } from './postgres.ts'
import { quiet, type Log } from './runner.ts'
import { quote as msQuote, SqlServerConn } from './sqlserver.ts'
import { q as liteQ } from './litediff.ts'
import type { SqliteConn } from './sqlite.ts'
import { lit as myLit, quote as myQuote, type MySqlConn } from './mysql.ts'
import { clob, lit as oraLit, quote as oraQuote, type OracleConn } from './oracle.ts'
import type { Side } from './compare.ts'
import { sideLabel } from './compare.ts'

/** A column as both sides have it; only columns in both, and not computed, are compared. */
export type DataColumn = { name: string; type: string; /** how values become text and back (SQL Server, MySQL) */ text: 'plain' | 'binary' | 'clr' | 'float' | 'datetime' | 'number' }

/** A table as compared. */
export type DataTable = {
  schema: string
  name: string
  /** the key columns: the primary key, else a unique index on non-null columns; empty: whole rows are compared */
  key: string[]
  columns: DataColumn[]
  /** inserts with the key's value need IDENTITY_INSERT (SQL Server) or OVERRIDING SYSTEM VALUE (PostgreSQL) */
  identity: boolean
}

export type TableResult = {
  table: string
  key: string[]
  source_rows: number
  target_rows: number
  only_in_source: number
  only_in_target: number
  different: number
  /** why the table was not compared (only on one side, …) */
  skipped?: string
  /** no key: whole rows were compared, so a changed row counts once only in the source and once only in the target */
  whole_rows?: boolean
  /** milliseconds */
  ms: number
}

export type DataComparison = {
  source: string
  target: string
  engine: string
  tables: TableResult[]
  ms: number
}

/** A row's key, each part as text; for a table without a key, the row hash (one entry per copy). */
export type Key = string[]

/** What differs in one table, by key. */
export type TableDiff = { table: DataTable; onlyInSource: Key[]; onlyInTarget: Key[]; different: Key[] }

/** One difference with both rows, values as text (null for SQL NULL). */
export type RowPair = { key: Key; source: (string | null)[] | null; target: (string | null)[] | null }

/* ---------- what each engine does ---------- */

interface Dialect {
  q(name: string): string
  /** tables, columns, keys in the schemas */
  tables(c: Conn, schemas: string[]): Promise<Map<string, DataTable & { allColumns: Map<string, DataColumn> }>>
  /** (child, parent) table pairs by foreign key, for the order of statements */
  foreignKeys(c: Conn, schemas: string[]): Promise<[string, string][]>
  /** the database's own estimate of the rows (no scan); -1 when it has none */
  estimate(c: Conn, t: DataTable): Promise<number>
  /** total rows and fingerprint */
  fingerprint(c: Conn, t: DataTable): Promise<[number, string]>
  /** per bucket of the key hash: [bucket, rows, fingerprint] */
  buckets(c: Conn, t: DataTable, mask: number): Promise<[number, number, string][]>
  /** (key parts, row hash) for the rows in these buckets (all rows when `buckets` is undefined) */
  pairs(c: Conn, t: DataTable, mask: number, buckets: number[] | undefined): Promise<[Key, string][]>
  /** the rows with these keys, every compared column as text */
  rows(c: Conn, t: DataTable, keys: Key[]): Promise<Map<string, (string | null)[]>>
  literal(col: DataColumn, v: string | null): string
  /** one statement deleting `n` copies of each row by its row hash (tables without a key); `rows`: their values by hash */
  deleteCopies(t: DataTable, copies: [string, number][], rows: Map<string, (string | null)[]>): string
}

/** `schema.table`; MySQL tables are in the URL's database and go by their name alone. */
const tableName = (t: { schema: string; name: string }) => (t.schema ? `${t.schema}.${t.name}` : t.name)
const keyId = (k: Key) => JSON.stringify(k)

const pg: Dialect = {
  q: quoteIdent,
  async tables(c, schemas) {
    const pc = c as PgConn
    const cols = await pc.rows(
      `select n.nspname, c.relname, a.attname, format_type(a.atttypid, a.atttypmod), a.attgenerated <> '', a.attidentity = 'a'
         from pg_class c join pg_namespace n on n.oid = c.relnamespace join pg_attribute a on a.attrelid = c.oid
        where c.relkind in ('r', 'p') and not c.relispartition and n.nspname = any($1) and a.attnum > 0 and not a.attisdropped
        order by 1, 2, a.attnum`,
      [schemas],
    )
    // The primary key, else the smallest unique index on columns that cannot be null.
    const keys = await pc.rows(
      `select distinct on (n.nspname, c.relname) n.nspname, c.relname,
              (select array_agg(a.attname::text order by k.ord) from unnest(i.indkey) with ordinality k(attnum, ord)
                 join pg_attribute a on a.attrelid = c.oid and a.attnum = k.attnum)
         from pg_index i join pg_class c on c.oid = i.indrelid join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = any($1) and (i.indisprimary or i.indisunique) and i.indexprs is null and i.indpred is null
          and not exists (select 1 from unnest(i.indkey) k(attnum) join pg_attribute a on a.attrelid = c.oid and a.attnum = k.attnum where not a.attnotnull)
        order by n.nspname, c.relname, i.indisprimary desc, i.indnatts`,
      [schemas],
    )
    const out = new Map<string, DataTable & { allColumns: Map<string, DataColumn> }>()
    for (const [schema, name, col, type, generated, always] of cols as [string, string, string, string, boolean, boolean][]) {
      const id = `${schema}.${name}`
      if (!out.has(id)) out.set(id, { schema, name, key: [], columns: [], identity: false, allColumns: new Map() })
      // GENERATED ALWAYS AS IDENTITY: inserts with a value need OVERRIDING SYSTEM VALUE.
      if (always) out.get(id)!.identity = true
      if (!generated) out.get(id)!.allColumns.set(col, { name: col, type, text: 'plain' })
    }
    for (const [schema, name, key] of keys as [string, string, string[]][]) {
      const t = out.get(`${schema}.${name}`)
      if (t) t.key = key
    }
    return out
  },
  async foreignKeys(c, schemas) {
    return (await (c as PgConn).rows(
      `select sn.nspname || '.' || sc.relname, tn.nspname || '.' || tc.relname from pg_constraint k
         join pg_class sc on sc.oid = k.conrelid join pg_namespace sn on sn.oid = sc.relnamespace
         join pg_class tc on tc.oid = k.confrelid join pg_namespace tn on tn.oid = tc.relnamespace
        where k.contype = 'f' and sn.nspname = any($1)`,
      [schemas],
    )) as [string, string][]
  },
  async estimate(c, t) {
    const [n] = await (c as PgConn).row(`select reltuples::bigint from pg_class where oid = $1::regclass`, [`${quoteIdent(t.schema)}.${quoteIdent(t.name)}`])
    return Number(n)
  },
  async fingerprint(c, t) {
    const [n, sum] = await (c as PgConn).row(`select count(*), coalesce(sum(${pgRowHash(t)}), 0)::text from ${pgFrom(t)}`)
    return [Number(n), String(sum)]
  },
  async buckets(c, t, mask) {
    const rows = await (c as PgConn).rows(`select ${pgKeyHash(t)} & $1 b, count(*), sum(${pgRowHash(t)})::text from ${pgFrom(t)} group by 1`, [mask])
    return rows.map(([b, n, s]) => [Number(b), Number(n), String(s)])
  },
  async pairs(c, t, mask, buckets) {
    // IN (select unnest(…)), not = any($2): PostgreSQL checks a parameter array element by element for
    // every row, so 65,000 differing buckets times 2,000,000 rows took minutes; a set is hashed once.
    const where = buckets ? ` where ${pgKeyHash(t)} & $1 in (select unnest($2::int[]))` : ''
    const rows = await (c as PgConn).rows(`select ${[...t.key.map((k) => `t.${quoteIdent(k)}::text`), `${pgRowHash(t)}::text`].join(', ')} from ${pgFrom(t)}${where}`, buckets ? [mask, buckets] : [])
    return rows.map((r) => [r.slice(0, t.key.length).map(String), String(r[t.key.length])])
  },
  async rows(c, t, keys) {
    const out = new Map<string, (string | null)[]>()
    if (!t.key.length) {
      // By row hash: one scan per batch, hashing every row as the comparison did.
      for (let i = 0; i < keys.length; i += HEAP_READ) {
        const hashes = [...new Set(keys.slice(i, i + HEAP_READ).map((k) => k[0]))]
        const rows = await (c as PgConn).rows(
          `select h::text, ${t.columns.map((col) => `t.${quoteIdent(col.name)}::text`).join(', ')} from (select ${pgRowHash(t)} h, t.* from ${pgFrom(t)}) t where h in (select unnest($1::bigint[]))`,
          [hashes],
        )
        for (const r of rows) out.set(keyId([String(r[0])]), r.slice(1).map((v) => (v === null ? null : String(v))))
      }
      return out
    }
    const keyCols = t.key.map((k) => t.columns.find((c) => c.name === k)!)
    for (let i = 0; i < keys.length; i += 5000) {
      const batch = keys.slice(i, i + 5000)
      const arrays = t.key.map((_, j) => batch.map((k) => k[j]))
      const vals = keyCols.map((col, j) => `v.k${j}::${col.type}`).join(', ')
      const rows = await (c as PgConn).rows(
        `select ${t.key.map((k) => `t.${quoteIdent(k)}::text`).join(', ')}, ${t.columns.map((col) => `t.${quoteIdent(col.name)}::text`).join(', ')}
           from ${pgFrom(t)} where (${t.key.map((k) => `t.${quoteIdent(k)}`).join(', ')}) in
           (select ${vals} from unnest(${t.key.map((_, j) => `$${j + 1}::text[]`).join(', ')}) v(${t.key.map((_, j) => `k${j}`).join(', ')}))`,
        arrays,
      )
      for (const r of rows) out.set(keyId(r.slice(0, t.key.length).map(String)), r.slice(t.key.length).map((v) => (v === null ? null : String(v))))
    }
    return out
  },
  literal(col, v) {
    return v === null ? 'NULL' : `'${v.replaceAll("'", "''")}'::${col.type}`
  },
  deleteCopies(t, copies) {
    // One pass: hash only the rows looked for, number the copies of each, keep the first n.
    const fq = `${quoteIdent(t.schema)}.${quoteIdent(t.name)}`
    const values = copies.map(([h, n]) => `(${h}::bigint, ${n})`).join(', ')
    return `DELETE FROM ${fq} WHERE ctid IN (SELECT x.ctid FROM (SELECT t.ctid, ${pgRowHash(t)} AS h, row_number() OVER (PARTITION BY ${pgRowHash(t)}) AS rn FROM ${pgFrom(t)} WHERE ${pgRowHash(t)} IN (${copies.map(([h]) => h).join(', ')})) x JOIN (VALUES ${values}) v(h, n) ON v.h = x.h AND x.rn <= v.n);`
  },
}

const pgFrom = (t: DataTable) => `${quoteIdent(t.schema)}.${quoteIdent(t.name)} t`
const pgRecord = (cols: string[]) => `row(${cols.map((c) => `t.${quoteIdent(c)}`).join(', ')})::text`
/** 60 bits of the md5 of the row's text (record output is unambiguous: quotes, NULL as nothing). */
const pgRowHash = (t: DataTable) => `('x' || substr(md5(${pgRecord(t.columns.map((c) => c.name))}), 1, 15))::bit(60)::bigint`
/** The bucket source: a single integer key as it is, else 32 bits of the md5 of the key (no key: the row hash). */
const pgKeyHash = (t: DataTable) => (!t.key.length ? pgRowHash(t) : integerKey(t, ['smallint', 'integer', 'bigint']) ? `t.${quoteIdent(t.key[0])}` : `('x' || substr(md5(${pgRecord(t.key)}), 1, 8))::bit(32)::int`)
const integerKey = (t: DataTable, types: string[]) => t.key.length === 1 && types.includes(t.columns.find((c) => c.name === t.key[0])?.type ?? '')

const ms: Dialect = {
  q: msQuote,
  async tables(c, schemas) {
    const sc = c as SqlServerConn
    const cols = await sc.query(
      `SELECT s.name, t.name, c.name, ty.name, ty.is_user_defined, SCHEMA_NAME(ty.schema_id), c.max_length, c.precision, c.scale, c.is_computed, c.is_identity, ty.is_assembly_type
         FROM sys.tables t JOIN sys.schemas s ON s.schema_id = t.schema_id
         JOIN sys.columns c ON c.object_id = t.object_id JOIN sys.types ty ON ty.user_type_id = c.user_type_id
        WHERE s.name IN (SELECT value FROM STRING_SPLIT(@P1, ',')) AND t.is_ms_shipped = 0
        ORDER BY s.name, t.name, c.column_id`,
      [schemas.join(',')],
    )
    const keys = await sc.query(
      `SELECT s.name, t.name, i.index_id, i.is_primary_key, c.name
         FROM sys.indexes i JOIN sys.tables t ON t.object_id = i.object_id JOIN sys.schemas s ON s.schema_id = t.schema_id
         JOIN sys.index_columns ic ON ic.object_id = i.object_id AND ic.index_id = i.index_id AND ic.is_included_column = 0
         JOIN sys.columns c ON c.object_id = i.object_id AND c.column_id = ic.column_id
        WHERE s.name IN (SELECT value FROM STRING_SPLIT(@P1, ',')) AND (i.is_primary_key = 1 OR i.is_unique = 1) AND i.has_filter = 0
          AND NOT EXISTS (SELECT 1 FROM sys.index_columns x JOIN sys.columns xc ON xc.object_id = x.object_id AND xc.column_id = x.column_id
                           WHERE x.object_id = i.object_id AND x.index_id = i.index_id AND xc.is_nullable = 1)
        ORDER BY s.name, t.name, i.is_primary_key DESC, i.index_id, ic.key_ordinal`,
      [schemas.join(',')],
    )
    const out = new Map<string, DataTable & { allColumns: Map<string, DataColumn> }>()
    for (const [schema, name, col, type, userDefined, typeSchema, maxLen, precision, scale, computed, identity, clr] of cols as [string, string, string, string, boolean, string, number, number, number, boolean, boolean, boolean][]) {
      const id = `${schema}.${name}`
      if (!out.has(id)) out.set(id, { schema, name, key: [], columns: [], identity: false, allColumns: new Map() })
      const t = out.get(id)!
      if (identity) t.identity = true
      // Computed and rowversion columns are not written, so not compared either.
      if (computed || type === 'timestamp' || type === 'rowversion') continue
      const text: DataColumn['text'] = clr ? 'clr' : ['binary', 'varbinary', 'image'].includes(type) ? 'binary' : ['float', 'real'].includes(type) ? 'float' : ['datetime', 'smalldatetime', 'datetime2', 'datetimeoffset', 'date', 'time'].includes(type) ? 'datetime' : 'plain'
      t.allColumns.set(col, { name: col, type: typeName(type, userDefined && !clr, typeSchema, maxLen, precision, scale), text })
    }
    // The first index per table wins (the primary key sorts first).
    const chosen = new Map<string, number>()
    for (const [schema, name, index, , col] of keys as [string, string, number, boolean, string][]) {
      const id = `${schema}.${name}`
      if (!chosen.has(id)) chosen.set(id, index)
      if (chosen.get(id) === index) out.get(id)?.key.push(col)
    }
    return out
  },
  async foreignKeys(c, schemas) {
    return (await (c as SqlServerConn).query(
      `SELECT OBJECT_SCHEMA_NAME(f.parent_object_id) + '.' + OBJECT_NAME(f.parent_object_id), OBJECT_SCHEMA_NAME(f.referenced_object_id) + '.' + OBJECT_NAME(f.referenced_object_id)
         FROM sys.foreign_keys f WHERE OBJECT_SCHEMA_NAME(f.parent_object_id) IN (SELECT value FROM STRING_SPLIT(@P1, ','))`,
      [schemas.join(',')],
    )) as [string, string][]
  },
  async estimate(c, t) {
    const [[n]] = await (c as SqlServerConn).query(`SELECT COALESCE(SUM(rows), -1) FROM sys.partitions WHERE object_id = OBJECT_ID(@P1) AND index_id IN (0, 1)`, [`${msQuote(t.schema)}.${msQuote(t.name)}`])
    return Number(n)
  },
  async fingerprint(c, t) {
    const [[n, sum]] = await (c as SqlServerConn).query(
      `SELECT COUNT_BIG(*), CAST(COALESCE(SUM(CAST(h AS DECIMAL(38, 0))), 0) AS VARCHAR(40)) FROM (SELECT ${msRowHash(t)} AS h FROM ${msFrom(t)}) x${await msHint(c)}`,
    )
    return [Number(n), String(sum)]
  },
  async buckets(c, t, mask) {
    const rows = await (c as SqlServerConn).query(
      `SELECT b, COUNT_BIG(*), CAST(SUM(CAST(h AS DECIMAL(38, 0))) AS VARCHAR(40)) FROM (SELECT ${msKeyHash(t)} & @P1 AS b, ${msRowHash(t)} AS h FROM ${msFrom(t)}) x GROUP BY b${await msHint(c)}`,
      [mask],
    )
    return rows.map(([b, n, s]) => [Number(b), Number(n), String(s)])
  },
  async pairs(c, t, mask, buckets) {
    const select = `SELECT ${[...t.key.map((k) => msText(t.columns.find((c) => c.name === k)!)), `CAST(${msRowHash(t)} AS VARCHAR(20))`].join(', ')}`
    const hint = await msHint(c)
    if (!buckets) return toPairs(t, await (c as SqlServerConn).query(`${select} FROM ${msFrom(t)}${hint}`))
    // Copy the rows of the differing buckets first, then hash only those: with the filter in the
    // same query, SQL Server hashes every row of the table before filtering.
    const rows = await (c as SqlServerConn).query(
      `SELECT t.* INTO #liftoff_rows FROM ${msFrom(t)} WHERE ${msKeyHash(t)} & @P1 IN (SELECT CAST(value AS INT) FROM STRING_SPLIT(@P2, ','))${hint};
       ${select} FROM #liftoff_rows t${hint};
       DROP TABLE #liftoff_rows;`,
      [mask, buckets.join(',')],
    )
    return toPairs(t, rows)
  },
  async rows(c, t, keys) {
    const out = new Map<string, (string | null)[]>()
    if (!t.key.length) {
      // By row hash: one scan per batch, hashing every row as the comparison did.
      for (let i = 0; i < keys.length; i += HEAP_READ) {
        const hashes = [...new Set(keys.slice(i, i + HEAP_READ).map((k) => k[0]))].join(',')
        const rows = await (c as SqlServerConn).query(
          `SELECT CAST(t.liftoff_h AS VARCHAR(20)), ${t.columns.map(msText).join(', ')}
             FROM (SELECT ${msRowHash(t)} AS liftoff_h, t.* FROM ${msFrom(t)}) t
            WHERE t.liftoff_h IN (SELECT CAST(value AS BIGINT) FROM STRING_SPLIT(@P1, ','))${await msHint(c)}`,
          [hashes],
        )
        for (const r of rows) out.set(keyId([String(r[0])]), r.slice(1).map((v) => (v === null ? null : String(v))))
      }
      return out
    }
    const keyCols = t.key.map((k) => t.columns.find((c) => c.name === k)!)
    for (let i = 0; i < keys.length; i += 5000) {
      // The keys go in as one JSON parameter (no 2,100-parameter limit), joined on their own types.
      const json = JSON.stringify(keys.slice(i, i + 5000))
      const on = keyCols.map((col, j) => `t.${msQuote(col.name)} = ${msFromText(col, `v.k${j}`)}`).join(' AND ')
      const withCols = keyCols.map((_, j) => `k${j} nvarchar(max) '$[${j}]'`).join(', ')
      const rows = await (c as SqlServerConn).query(
        `SELECT ${keyCols.map(msText).join(', ')}, ${t.columns.map(msText).join(', ')} FROM ${msFrom(t)} JOIN OPENJSON(@P1) WITH (${withCols}) v ON ${on}`,
        [json],
      )
      for (const r of rows) out.set(keyId(r.slice(0, t.key.length).map(String)), r.slice(t.key.length).map((v) => (v === null ? null : String(v))))
    }
    return out
  },
  literal(col, v) {
    return v === null ? 'NULL' : msFromText(col, `N'${v.replaceAll("'", "''")}'`)
  },
  deleteCopies(t, copies) {
    // One pass: hash each row once (in the derived table; written out in an IN list, SQL Server
    // hashes the row again for every value: 18 s instead of 1.3 s on 300,000 rows), keep the rows
    // looked for, number the copies of each, delete the first n.
    // The hashes go in as JSON: a VALUES list holds at most 1,000 rows. HASH JOIN reads the JSON
    // once into a hash table; otherwise SQL Server reads it again for every row (46 s instead of
    // 1.7 s for 10,000 rows of a 300,000-row heap).
    const json = `OPENJSON(N'[${copies.map(([h, n]) => `[${h},${n}]`).join(',')}]') WITH (h bigint '$[0]', n int '$[1]')`
    return `WITH d AS (SELECT x.liftoff_h, ROW_NUMBER() OVER (PARTITION BY x.liftoff_h ORDER BY (SELECT NULL)) AS liftoff_rn FROM (SELECT ${msRowHash(t)} AS liftoff_h FROM ${msFrom(t)}) x WHERE x.liftoff_h IN (SELECT v.h FROM ${json} v)) DELETE FROM d WHERE EXISTS (SELECT 1 FROM ${json} v WHERE v.h = d.liftoff_h AND d.liftoff_rn <= v.n) OPTION (HASH JOIN);`
  },
}

/**
 * Hashing a table is CPU work; below its cost threshold SQL Server runs it on one core (100,000
 * rows: 1.3 s instead of 0.26 s on 16 cores). Ask for a parallel plan where the server takes the
 * hint, checked once per connection. Only for LiftOff's own queries, never in a saved script.
 */
const parallelHint = new WeakMap<Conn, Promise<string>>()
function msHint(c: Conn): Promise<string> {
  let h = parallelHint.get(c)
  if (!h) {
    const hint = " OPTION (USE HINT('ENABLE_PARALLEL_PLAN_PREFERENCE'))"
    h = (c as SqlServerConn).query(`SELECT 1${hint}`).then(() => hint, () => '')
    parallelHint.set(c, h)
  }
  return h
}

const msFrom = (t: DataTable) => `${msQuote(t.schema)}.${msQuote(t.name)} t`
/**
 * The row as one text: each value as `<length>:<text>`, NULL as `-`. Lengths make it unambiguous
 * (no separator a value could contain), and NULL differs from ''. Three times faster than JSON.
 */
const msRowText = (cols: DataColumn[]) => `CONCAT(${cols.map((c) => `ISNULL(CONCAT(DATALENGTH(${msText(c)}), ':', ${msText(c)}), N'-')`).join(', ')}, N'')`
/** 60 bits of SHA-256 over the row text. */
const msRowHash = (t: DataTable) => `(CAST(SUBSTRING(HASHBYTES('SHA2_256', ${msRowText(t.columns)}), 1, 8) AS BIGINT) & 0x0FFFFFFFFFFFFFFF)`
/** The bucket source: a single integer key as it is, else 32 bits of the hash of the key (no key: the row hash). */
const msKeyHash = (t: DataTable) =>
  !t.key.length ? msRowHash(t) : integerKey(t, ['tinyint', 'smallint', 'int', 'bigint']) ? `t.${msQuote(t.key[0])}` : `CAST(SUBSTRING(HASHBYTES('SHA2_256', ${msRowText(t.key.map((k) => t.columns.find((c) => c.name === k)!))}), 1, 4) AS INT)`
/**
 * The text type a value converts to. (max) makes SQL Server treat every value as a large object,
 * which halves the speed of a pass; it is used only where a value can be longer than 4,000.
 */
function msTextType(c: DataColumn): string {
  const t = c.type.toLowerCase()
  const n = Number(/\((\d+)\)$/.exec(t)?.[1] ?? 0)
  if (c.text === 'clr' || t.endsWith('(max)') || ['xml', 'text', 'ntext', 'image', 'sql_variant'].includes(t)) return c.text === 'binary' || c.text === 'clr' ? 'varchar(max)' : 'nvarchar(max)'
  if (c.text === 'binary') return 2 * n + 2 > 8000 ? 'varchar(max)' : 'varchar(8000)'
  if (/^(var)?char\(/.test(t) && n > 4000) return 'nvarchar(max)'
  return 'nvarchar(4000)'
}

/** A value as text that converts back exactly. */
function msText(c: DataColumn): string {
  const col = `t.${msQuote(c.name)}`
  const to = msTextType(c)
  if (c.text === 'binary') return `CONVERT(${to}, ${col}, 1)`
  if (c.text === 'clr') return `CONVERT(${to}, CONVERT(varbinary(max), ${col}), 1)`
  if (c.text === 'float') return `CONVERT(${to}, ${col}, 3)`
  if (c.text === 'datetime') return `CONVERT(${to}, ${col}, 121)`
  return `CONVERT(${to}, ${col})`
}
/** Text from msText back to the column's type. */
function msFromText(c: DataColumn, text: string): string {
  if (c.text === 'binary') return `CONVERT(${c.type}, ${text}, 1)`
  if (c.text === 'clr') return `CAST(CONVERT(varbinary(max), ${text}, 1) AS ${c.type})`
  if (c.text === 'datetime') return `CONVERT(${c.type}, ${text}, 121)`
  return `CAST(${text} AS ${c.type})`
}

const toPairs = (t: DataTable, rows: unknown[][]): [Key, string][] => rows.map((r) => [r.slice(0, t.key.length).map(String), String(r[t.key.length])])

const my: Dialect = {
  q: myQuote,
  async tables(c) {
    const mc = c as MySqlConn
    const cols = await mc.query(
      `SELECT table_name, column_name, data_type, column_type, extra FROM information_schema.columns
        WHERE table_schema = DATABASE() AND table_name IN (SELECT table_name FROM information_schema.tables WHERE table_schema = DATABASE() AND table_type = 'BASE TABLE')
        ORDER BY table_name, ordinal_position`,
    )
    // The primary key, else the unique index with the fewest columns, all of them NOT NULL.
    const keys = await mc.query(
      `SELECT s.table_name, s.index_name, s.column_name FROM information_schema.statistics s
        WHERE s.table_schema = DATABASE() AND s.non_unique = 0
          AND NOT EXISTS (SELECT 1 FROM information_schema.statistics x JOIN information_schema.columns c
                           ON c.table_schema = x.table_schema AND c.table_name = x.table_name AND c.column_name = x.column_name
                          WHERE x.table_schema = s.table_schema AND x.table_name = s.table_name AND x.index_name = s.index_name AND (c.is_nullable = 'YES' OR x.column_name IS NULL))
        ORDER BY s.table_name, s.index_name <> 'PRIMARY', (SELECT COUNT(*) FROM information_schema.statistics y WHERE y.table_schema = s.table_schema AND y.table_name = s.table_name AND y.index_name = s.index_name), s.index_name, s.seq_in_index`,
    )
    const out = new Map<string, DataTable & { allColumns: Map<string, DataColumn> }>()
    for (const [name, col, dataType, columnType, extra] of cols as [string, string, string, string, string][]) {
      if (!out.has(name)) out.set(name, { schema: '', name, key: [], columns: [], identity: false, allColumns: new Map() })
      // Generated columns are not written, so not compared either.
      if (/GENERATED/i.test(extra)) continue
      const t = dataType.toLowerCase()
      const text: DataColumn['text'] = /binary|blob|geometry|point|linestring|polygon/.test(t) ? 'binary' : t === 'bit' ? 'number' : 'plain'
      out.get(name)!.allColumns.set(col, { name: col, type: columnType, text })
    }
    const chosen = new Map<string, string>()
    for (const [name, index, col] of keys as [string, string, string][]) {
      if (!chosen.has(name)) chosen.set(name, index)
      if (chosen.get(name) === index) out.get(name)?.key.push(col)
    }
    return out
  },
  async foreignKeys(c) {
    return (await (c as MySqlConn).query(
      'SELECT DISTINCT table_name, referenced_table_name FROM information_schema.key_column_usage WHERE table_schema = DATABASE() AND referenced_table_schema = DATABASE()',
    )) as [string, string][]
  },
  async estimate(c, t) {
    const [row] = await (c as MySqlConn).query('SELECT table_rows FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name = ?', [t.name])
    return row?.[0] == null ? -1 : Number(row[0])
  },
  async fingerprint(c, t) {
    const [[n, sum]] = await (c as MySqlConn).query(`SELECT COUNT(*), CAST(COALESCE(SUM(h), 0) AS CHAR) FROM (SELECT ${myRowHash(t)} AS h FROM ${myFrom(t)}) x`)
    return [Number(n), String(sum)]
  },
  async buckets(c, t, mask) {
    const rows = await (c as MySqlConn).query(`SELECT b, COUNT(*), CAST(SUM(h) AS CHAR) FROM (SELECT ${myKeyHash(t)} & ? AS b, ${myRowHash(t)} AS h FROM ${myFrom(t)}) x GROUP BY b`, [mask])
    return rows.map(([b, n, s]) => [Number(b), Number(n), String(s)])
  },
  async pairs(c, t, mask, buckets) {
    const select = `SELECT ${[...t.key.map((k) => myText(t.columns.find((c) => c.name === k)!)), `CAST(${myRowHash(t)} AS CHAR)`].join(', ')} FROM ${myFrom(t)}`
    if (!buckets) return toPairs(t, await (c as MySqlConn).query(select))
    return toPairs(t, await (c as MySqlConn).query(`${select} WHERE ${myKeyHash(t)} & ? IN (${buckets.join(', ')})`, [mask]))
  },
  async rows(c, t, keys) {
    const out = new Map<string, (string | null)[]>()
    if (!t.key.length) {
      for (let i = 0; i < keys.length; i += HEAP_READ) {
        const hashes = [...new Set(keys.slice(i, i + HEAP_READ).map((k) => k[0]))]
        const rows = await (c as MySqlConn).query(
          `SELECT CAST(x.liftoff_h AS CHAR), ${t.columns.map((col) => myText(col, 'x')).join(', ')} FROM (SELECT ${myRowHash(t)} AS liftoff_h, t.* FROM ${myFrom(t)}) x WHERE x.liftoff_h IN (${hashes.join(', ')})`,
        )
        for (const r of rows) out.set(keyId([String(r[0])]), r.slice(1).map((v) => (v === null ? null : String(v))))
      }
      return out
    }
    const keyCols = t.key.map((k) => t.columns.find((c) => c.name === k)!)
    for (let i = 0; i < keys.length; i += 5000) {
      const tuples = keys.slice(i, i + 5000).map((k) => `(${k.map((v, j) => my.literal(keyCols[j], v)).join(', ')})`)
      const rows = await (c as MySqlConn).query(
        `SELECT ${keyCols.map((col) => myText(col)).join(', ')}, ${t.columns.map((col) => myText(col)).join(', ')} FROM ${myFrom(t)} WHERE (${keyCols.map((col) => `t.${myQuote(col.name)}`).join(', ')}) IN (${tuples.join(', ')})`,
      )
      for (const r of rows) out.set(keyId(r.slice(0, t.key.length).map(String)), r.slice(t.key.length).map((v) => (v === null ? null : String(v))))
    }
    return out
  },
  literal(col, v) {
    if (v === null) return 'NULL'
    if (col.text === 'binary') return `UNHEX('${v}')`
    if (col.text === 'number') return String(Number(v))
    return myLit(v)
  },
  deleteCopies(t, copies) {
    // ponytail: one DELETE … LIMIT n per distinct row, each a pass over the table; fine for the
    // keyless tables MySQL has (InnoDB tables nearly always have a key).
    return copies.map(([h, n]) => `DELETE FROM ${myQuote(t.name)} WHERE ${myRowHash(t, myQuote(t.name))} = ${h} LIMIT ${n};`).join('\n')
  },
}

const myFrom = (t: DataTable) => `${myQuote(t.name)} t`
/** A value as text that converts back exactly: binary as hex, BIT as a number, the rest as MySQL writes it. */
function myText(c: DataColumn, alias = 't'): string {
  const col = `${alias}.${myQuote(c.name)}`
  if (c.text === 'binary') return `HEX(${col})`
  if (c.text === 'number') return `CAST(${col} AS UNSIGNED)`
  return `CAST(${col} AS CHAR)`
}
/** The row as one text: each value as `<length>:<text>`, NULL as `-` (unambiguous, and NULL differs from ''). */
const myRowText = (cols: DataColumn[], alias = 't') => `CONCAT(${cols.map((c) => `IFNULL(CONCAT(CHAR_LENGTH(${myText(c, alias)}), ':', ${myText(c, alias)}), '-')`).join(', ')}, '')`
/** 60 bits of the md5 of the row text. */
const myRowHash = (t: DataTable, alias = 't') => `CAST(CONV(SUBSTRING(MD5(${myRowText(t.columns, alias)}), 1, 15), 16, 10) AS UNSIGNED)`
/** The bucket source: a single integer key as it is, else 32 bits of the md5 of the key (no key: the row hash). */
const myKeyHash = (t: DataTable) =>
  !t.key.length ? myRowHash(t) : t.key.length === 1 && /^(tiny|small|medium|big)?int\b/i.test(t.columns.find((c) => c.name === t.key[0])?.type ?? '') ? `t.${myQuote(t.key[0])}` : `CAST(CONV(SUBSTRING(MD5(${myRowText(t.key.map((k) => t.columns.find((c) => c.name === k)!))}), 1, 8), 16, 10) AS UNSIGNED)`

/** Oracle: values as text, by type. LOBs, LONG, XML and object columns are not compared (see oraTables). */
const ORA_NUMBER = /^(NUMBER|FLOAT|INTEGER)/
const ORA_FLOAT = /^BINARY_(FLOAT|DOUBLE)/

const ora: Dialect = {
  q: oraQuote,
  async tables(c) {
    const oc = c as OracleConn
    const cols = await oc.query(
      `SELECT c.table_name, c.column_name, c.data_type, c.data_length, c.char_length, c.char_used, c.data_precision, c.data_scale, c.virtual_column
         FROM user_tab_cols c JOIN user_tables t ON t.table_name = c.table_name
        WHERE c.hidden_column = 'NO' AND t.temporary = 'N' AND t.nested = 'NO' AND t.table_name NOT LIKE 'BIN$%'
        ORDER BY c.table_name, c.column_id`,
    )
    // The primary key, else a unique constraint on NOT NULL columns.
    const keys = await oc.query(
      `SELECT k.table_name, k.constraint_name, cc.column_name FROM user_constraints k JOIN user_cons_columns cc ON cc.constraint_name = k.constraint_name
        WHERE k.constraint_type IN ('P', 'U')
          AND NOT EXISTS (SELECT 1 FROM user_cons_columns x JOIN user_tab_cols tc ON tc.table_name = x.table_name AND tc.column_name = x.column_name
                           WHERE x.constraint_name = k.constraint_name AND tc.nullable = 'Y')
        ORDER BY k.table_name, DECODE(k.constraint_type, 'P', 0, 1), k.constraint_name, cc.position`,
    )
    const out = new Map<string, DataTable & { allColumns: Map<string, DataColumn> }>()
    for (const [name, col, type, len, charLen, charUsed, precision, scale, virtual] of cols as [string, string, string, number, number, string | null, number | null, number | null, string][]) {
      if (!out.has(name)) out.set(name, { schema: '', name, key: [], columns: [], identity: false, allColumns: new Map() })
      if (virtual === 'YES' || /LOB$|^LONG|XMLTYPE|^JSON$|^BFILE$/.test(type)) continue
      const text: DataColumn['text'] = type === 'RAW' ? 'binary' : ORA_NUMBER.test(type) ? 'number' : ORA_FLOAT.test(type) ? 'float' : type === 'DATE' || type.startsWith('TIMESTAMP') ? 'datetime' : 'plain'
      const full = ['VARCHAR2', 'CHAR'].includes(type) ? `${type}(${charUsed === 'C' ? `${charLen} CHAR` : len})` : type === 'RAW' ? `RAW(${len})` : precision !== null && type === 'NUMBER' ? `NUMBER(${precision},${scale ?? 0})` : type
      out.get(name)!.allColumns.set(col, { name: col, type: full, text })
    }
    const chosen = new Map<string, string>()
    for (const [name, constraint, col] of keys as [string, string, string][]) {
      if (!chosen.has(name)) chosen.set(name, constraint)
      if (chosen.get(name) === constraint) out.get(name)?.key.push(col)
    }
    return out
  },
  async foreignKeys(c) {
    return (await (c as OracleConn).query(
      `SELECT k.table_name, r.table_name FROM user_constraints k JOIN user_constraints r ON r.constraint_name = k.r_constraint_name WHERE k.constraint_type = 'R'`,
    )) as [string, string][]
  },
  async estimate(c, t) {
    const [row] = await (c as OracleConn).query('SELECT num_rows FROM user_tables WHERE table_name = :1', [t.name])
    return row?.[0] == null ? -1 : Number(row[0])
  },
  async fingerprint(c, t) {
    const [[n, sum]] = await (c as OracleConn).query(`SELECT COUNT(*), TO_CHAR(NVL(SUM(h), 0), 'TM9') FROM (SELECT ${oraRowHash(t)} h FROM ${oraFrom(t)})`)
    return [Number(n), String(sum)]
  },
  async buckets(c, t, mask) {
    const rows = await (c as OracleConn).query(`SELECT b, COUNT(*), TO_CHAR(SUM(h), 'TM9') FROM (SELECT BITAND(${oraKeyHash(t)}, :1) b, ${oraRowHash(t)} h FROM ${oraFrom(t)}) GROUP BY b`, [mask])
    return rows.map(([b, n, s]) => [Number(b), Number(n), String(s)])
  },
  async pairs(c, t, mask, buckets) {
    const select = `SELECT ${[...t.key.map((k) => oraText(t.columns.find((c) => c.name === k)!)), `TO_CHAR(${oraRowHash(t)}, 'TM9')`].join(', ')} FROM ${oraFrom(t)}`
    if (!buckets) return toPairs(t, await (c as OracleConn).query(select))
    return toPairs(t, await (c as OracleConn).query(`${select} WHERE BITAND(${oraKeyHash(t)}, :1) IN (SELECT n FROM JSON_TABLE(:2, '$[*]' COLUMNS (n NUMBER PATH '$')))`, [mask, clob(JSON.stringify(buckets))]))
  },
  async rows(c, t, keys) {
    const out = new Map<string, (string | null)[]>()
    if (!t.key.length) {
      for (let i = 0; i < keys.length; i += HEAP_READ) {
        const hashes = [...new Set(keys.slice(i, i + HEAP_READ).map((k) => k[0]))]
        const rows = await (c as OracleConn).query(
          `SELECT TO_CHAR(x.liftoff_h, 'TM9'), ${t.columns.map((col) => oraText(col, 'x')).join(', ')} FROM (SELECT ${oraRowHash(t)} liftoff_h, t.* FROM ${oraFrom(t)}) x
            WHERE x.liftoff_h IN (SELECT TO_NUMBER(n) FROM JSON_TABLE(:1, '$[*]' COLUMNS (n VARCHAR2(40) PATH '$')))`,
          // As text: 60-bit hashes do not fit a JavaScript number.
          [clob(JSON.stringify(hashes))],
        )
        for (const r of rows) out.set(keyId([String(r[0])]), r.slice(1).map((v) => (v === null ? null : String(v))))
      }
      return out
    }
    const keyCols = t.key.map((k) => t.columns.find((c) => c.name === k)!)
    for (let i = 0; i < keys.length; i += 5000) {
      // The keys go in as one JSON text, joined on their own types (an IN list holds 1,000 at most).
      const on = keyCols.map((col, j) => `t.${oraQuote(col.name)} = ${oraFromText(col, `v.k${j}`)}`).join(' AND ')
      const withCols = keyCols.map((_, j) => `k${j} VARCHAR2(4000) PATH '$[${j}]'`).join(', ')
      const rows = await (c as OracleConn).query(
        `SELECT ${keyCols.map((col) => oraText(col)).join(', ')}, ${t.columns.map((col) => oraText(col)).join(', ')} FROM ${oraFrom(t)} JOIN JSON_TABLE(:1, '$[*]' COLUMNS (${withCols})) v ON ${on}`,
        [clob(JSON.stringify(keys.slice(i, i + 5000)))],
      )
      for (const r of rows) out.set(keyId(r.slice(0, t.key.length).map(String)), r.slice(t.key.length).map((v) => (v === null ? null : String(v))))
    }
    return out
  },
  literal(col, v) {
    return v === null ? 'NULL' : oraFromText(col, oraLit(v))
  },
  deleteCopies(t, copies) {
    // A statement per 100 rows: a string literal in Oracle SQL holds 4,000 characters at most.
    const out: string[] = []
    for (let i = 0; i < copies.length; i += 100) {
      const part = copies.slice(i, i + 100)
      const json = `JSON_TABLE('[${part.map(([h, n]) => `[${h},${n}]`).join(',')}]', '$[*]' COLUMNS (h NUMBER PATH '$[0]', n NUMBER PATH '$[1]'))`
      out.push(
        `DELETE FROM ${oraQuote(t.name)} WHERE ROWID IN (SELECT x.rid FROM (SELECT t.ROWID rid, ${oraRowHash(t)} h, ROW_NUMBER() OVER (PARTITION BY ${oraRowHash(t)} ORDER BY t.ROWID) rn FROM ${oraFrom(t)}) x JOIN ${json} v ON v.h = x.h AND x.rn <= v.n);`,
      )
    }
    return out.join('\n')
  },
}

const oraFrom = (t: DataTable) => `${oraQuote(t.name)} t`
/** A value as text that converts back exactly (numbers as written, dates and times in full, RAW as hex). */
function oraText(c: DataColumn, alias = 't'): string {
  const col = `${alias}.${oraQuote(c.name)}`
  if (c.text === 'binary') return `RAWTOHEX(${col})`
  if (c.text === 'number' || c.text === 'float') return `TO_CHAR(${col}, 'TM9')`
  if (c.type === 'DATE') return `TO_CHAR(${col}, 'YYYY-MM-DD HH24:MI:SS')`
  if (/WITH (LOCAL )?TIME ZONE/.test(c.type)) return `TO_CHAR(${col}, 'YYYY-MM-DD HH24:MI:SS.FF9 TZH:TZM')`
  if (c.text === 'datetime') return `TO_CHAR(${col}, 'YYYY-MM-DD HH24:MI:SS.FF9')`
  if (/^(N?VARCHAR2|N?CHAR)/.test(c.type)) return col
  return `TO_CHAR(${col})`
}
/** Text from oraText back to the column's type. */
function oraFromText(c: DataColumn, text: string): string {
  if (c.text === 'binary') return `HEXTORAW(${text})`
  if (c.text === 'number') return `TO_NUMBER(${text})`
  if (c.text === 'float') return `TO_BINARY_DOUBLE(${text})`
  if (c.type === 'DATE') return `TO_DATE(${text}, 'YYYY-MM-DD HH24:MI:SS')`
  if (/WITH (LOCAL )?TIME ZONE/.test(c.type)) return `TO_TIMESTAMP_TZ(${text}, 'YYYY-MM-DD HH24:MI:SS.FF9 TZH:TZM')`
  if (c.text === 'datetime') return `TO_TIMESTAMP(${text}, 'YYYY-MM-DD HH24:MI:SS.FF9')`
  if (/^N(VAR)?CHAR/.test(c.type)) return `TO_NCHAR(${text})`
  return text
}
/**
 * Each value's md5 (a NULL as a zero byte), the hex of those in a row, and 60 bits of the md5 of
 * that: text in Oracle SQL stops at 4,000 bytes, so whole rows are never put together as text.
 * Wide tables hash 100 columns at a time first.
 */
function oraRowText(cols: DataColumn[], alias = 't'): string {
  const parts = cols.map((c) => `RAWTOHEX(NVL(STANDARD_HASH(${oraText(c, alias)}, 'MD5'), HEXTORAW('00')))`)
  const groups: string[] = []
  for (let i = 0; i < parts.length; i += 100) groups.push(parts.slice(i, i + 100).join(' || '))
  return groups.length === 1 ? groups[0] : groups.map((g) => `RAWTOHEX(STANDARD_HASH(${g}, 'MD5'))`).join(' || ')
}
const oraRowHash = (t: DataTable, alias = 't') => `TO_NUMBER(SUBSTR(RAWTOHEX(STANDARD_HASH(${oraRowText(t.columns, alias)}, 'MD5')), 1, 15), 'XXXXXXXXXXXXXXX')`
/** The bucket source: a single whole-number key as it is, else 32 bits of the md5 of the key (no key: the row hash). */
const oraKeyHash = (t: DataTable) => {
  const k = t.key.length === 1 ? t.columns.find((c) => c.name === t.key[0]) : undefined
  if (!t.key.length) return oraRowHash(t)
  if (k && (/^NUMBER\(\d+,0\)$/.test(k.type) || k.type === 'INTEGER')) return `t.${oraQuote(k.name)}`
  return `TO_NUMBER(SUBSTR(RAWTOHEX(STANDARD_HASH(${oraRowText(t.key.map((n) => t.columns.find((c) => c.name === n)!))}, 'MD5')), 1, 8), 'XXXXXXXX')`
}

/**
 * SQLite: values travel as SQLite's own literals (quote()): 1, 'text', X'00ff', so a value's type
 * (SQLite keeps it per value) is part of the comparison, and a value goes back into a script as it is.
 * The hashes come from functions LiftOff adds to its own connections (sqlite.ts); the scripts it
 * writes use none of them, so they run in the sqlite3 shell too.
 */
const lite: Dialect = {
  q: liteQ,
  async tables(c) {
    const lc = c as SqliteConn
    const cols = await lc.query(
      `SELECT m.name, p.name, p.type, p.pk, p.hidden FROM sqlite_schema m JOIN pragma_table_list l ON l.name = m.name AND l.schema = 'main' AND l.type = 'table'
         JOIN pragma_table_xinfo(m.name) p WHERE m.type = 'table' AND m.name NOT LIKE 'sqlite_%' ORDER BY m.name, p.cid`,
    )
    const out = new Map<string, DataTable & { allColumns: Map<string, DataColumn> }>()
    const pk = new Map<string, [number, string][]>()
    for (const [name, col, type, inPk, hidden] of cols as [string, string, string, number, number][]) {
      if (!out.has(name)) out.set(name, { schema: '', name, key: [], columns: [], identity: false, allColumns: new Map() })
      // Generated columns are not written, so not compared either.
      if (hidden) continue
      out.get(name)!.allColumns.set(col, { name: col, type, text: 'plain' })
      if (inPk) pk.set(name, [...(pk.get(name) ?? []), [Number(inPk), col]])
    }
    // The primary key; else, as on the other engines, a unique index on NOT NULL columns.
    for (const [name, t] of out) {
      const key = pk.get(name)
      if (key) t.key = key.sort((a, b) => a[0] - b[0]).map(([, col]) => col)
      else {
        const [u] = await lc.query(
          `SELECT (SELECT json_group_array(ii.name) FROM pragma_index_info(il.name) ii) FROM pragma_index_list(?) il
            WHERE il."unique" AND il.partial = 0 AND NOT EXISTS (SELECT 1 FROM pragma_index_info(il.name) ii JOIN pragma_table_info(?) ti ON ti.name = ii.name WHERE ti."notnull" = 0)
              AND NOT EXISTS (SELECT 1 FROM pragma_index_info(il.name) ii WHERE ii.name IS NULL)
            ORDER BY (SELECT COUNT(*) FROM pragma_index_info(il.name)) LIMIT 1`,
          [name, name],
        )
        if (u) t.key = JSON.parse(String(u[0])) as string[]
      }
    }
    return out
  },
  async foreignKeys(c) {
    return (await (c as SqliteConn).query(
      `SELECT DISTINCT m.name, f."table" FROM sqlite_schema m JOIN pragma_foreign_key_list(m.name) f WHERE m.type = 'table'`,
    )) as [string, string][]
  },
  async estimate() {
    // SQLite keeps no row estimate; counting is cheap enough for a file on this computer.
    return -1
  },
  async fingerprint(c, t) {
    const [[n, sum]] = await (c as SqliteConn).query(`SELECT COUNT(*), liftoff_sum(${liteRowHash(t)}) FROM ${liteFrom(t)}`)
    return [Number(n), String(sum)]
  },
  async buckets(c, t, mask) {
    const rows = await (c as SqliteConn).query(`SELECT ${liteKeyHash(t)} & ? b, COUNT(*), liftoff_sum(${liteRowHash(t)}) FROM ${liteFrom(t)} GROUP BY b`, [mask])
    return rows.map(([b, n, s]) => [Number(b), Number(n), String(s)])
  },
  async pairs(c, t, mask, buckets) {
    const select = `SELECT ${[...t.key.map((k) => liteText(k)), `CAST(${liteRowHash(t)} AS TEXT)`].join(', ')} FROM ${liteFrom(t)}`
    if (!buckets) return toPairs(t, await (c as SqliteConn).query(select))
    return toPairs(t, await (c as SqliteConn).query(`${select} WHERE ${liteKeyHash(t)} & ? IN (SELECT value FROM json_each(?))`, [mask, JSON.stringify(buckets)]))
  },
  async rows(c, t, keys) {
    const out = new Map<string, (string | null)[]>()
    const values = t.columns.map((col) => liteText(col.name)).join(', ')
    if (!t.key.length) {
      for (let i = 0; i < keys.length; i += HEAP_READ) {
        const hashes = [...new Set(keys.slice(i, i + HEAP_READ).map((k) => k[0]))]
        const rows = await (c as SqliteConn).query(`SELECT CAST(${liteRowHash(t)} AS TEXT), ${values} FROM ${liteFrom(t)} WHERE CAST(${liteRowHash(t)} AS TEXT) IN (SELECT value FROM json_each(?))`, [JSON.stringify(hashes)])
        for (const r of rows) out.set(keyId([String(r[0])]), r.slice(1).map((v) => (v === null ? null : String(v))))
      }
      return out
    }
    for (let i = 0; i < keys.length; i += 5000) {
      // The keys as their literals, in one JSON text: matched on quote(), so on the same type too.
      const on = t.key.map((k, j) => `${liteText(k)} = json_extract(v.value, '$[${j}]')`).join(' AND ')
      const rows = await (c as SqliteConn).query(
        `SELECT ${t.key.map((k) => liteText(k)).join(', ')}, ${values} FROM ${liteFrom(t)} JOIN json_each(?) v ON ${on}`,
        [JSON.stringify(keys.slice(i, i + 5000))],
      )
      for (const r of rows) out.set(keyId(r.slice(0, t.key.length).map(String)), r.slice(t.key.length).map((v) => (v === null ? null : String(v))))
    }
    return out
  },
  literal(_col, v) {
    return v ?? 'NULL'
  },
  deleteCopies(t, copies, rows) {
    // By the rows' values (IS also matches NULL), n copies each: no LiftOff function in a script.
    return copies
      .map(([h, n]) => {
        const r = rows.get(keyId([h]))!
        const where = t.columns.map((c, j) => `${liteQ(c.name)} IS ${r[j] ?? 'NULL'}`).join(' AND ')
        return `DELETE FROM ${liteQ(t.name)} WHERE rowid IN (SELECT rowid FROM ${liteQ(t.name)} WHERE ${where} LIMIT ${n});`
      })
      .join('\n')
  },
}

const liteFrom = (t: DataTable) => `${liteQ(t.name)} t`
/** A value as its SQLite literal; NULL stays NULL. */
const liteText = (col: string) => `CASE WHEN t.${liteQ(col)} IS NULL THEN NULL ELSE quote(t.${liteQ(col)}) END`
/** Literals are self-delimiting ('it''s', 1, X'00', NULL), so joined with commas they say which row it is. */
const liteRowHash = (t: DataTable) => `liftoff_hash(${t.columns.map((c) => `quote(t.${liteQ(c.name)})`).join(` || ',' || `) || "''"})`
/** The bucket source: a single INTEGER key as it is, else 32 bits of the hash of the key (no key: the row hash). */
const liteKeyHash = (t: DataTable) => {
  if (!t.key.length) return liteRowHash(t)
  const k = t.columns.find((c) => c.name === t.key[0])
  if (t.key.length === 1 && /^INT/i.test(k?.type ?? '')) return `t.${liteQ(t.key[0])}`
  return `(liftoff_hash(${t.key.map((n) => `quote(t.${liteQ(n)})`).join(` || ',' || `)}) & 4294967295)`
}

const dialects: Partial<Record<EngineName, Dialect>> = { PostgreSQL: pg, 'SQL Server': ms, MySQL: my, Oracle: ora, SQLite: lite }

function dialectOf(c: Conn): Dialect {
  const d = dialects[c.engine]
  if (!d) throw configError(`data compare is not available for ${c.engine} yet`)
  return d
}

/* ---------- comparing ---------- */

/**
 * About this many rows per bucket; tables up to SMALL rows skip the buckets. Small buckets matter
 * when changes are spread over a table: with 250 rows per bucket, 1% changed in 1,000,000 rows made
 * all 4,096 buckets differ and every key/hash pair had to be read (17 s); with 16, 15% of them
 * differ (5 s). Identical tables cost the same either way.
 */
const PER_BUCKET = 16
/**
 * Tables without a key: reading rows by their hash, and deleting by it, reads the whole table each
 * time, so do it for many rows at once. Measured on a 300,000-row heap with 40,000 differing rows.
 */
const HEAP_READ = 50_000
const HEAP_DELETE = 10_000
const SMALL = 5_000
const MAX_BITS = 20
/** Key/hash pairs are read and compared this many rows at a time, so memory stays flat on big tables. */
const CHUNK_ROWS = 500_000

/** The tables both sides have, with the columns both have; and why the others are left out. */
async function plan(cfg: Config, a: Conn, b: Conn, only: string[] | undefined): Promise<{ tables: DataTable[]; skipped: TableResult[] }> {
  const d = dialectOf(a)
  const schemas = cfg.project.schemas
  const [ta, tb] = await Promise.all([d.tables(a, schemas), d.tables(b, schemas)])
  const tables: DataTable[] = []
  const skipped: TableResult[] = []
  const skip = (table: string, why: string) => skipped.push({ table, key: [], source_rows: 0, target_rows: 0, only_in_source: 0, only_in_target: 0, different: 0, skipped: why, ms: 0 })
  const names = [...new Set([...ta.keys(), ...tb.keys()])].sort()
  for (const id of only ?? []) if (!names.includes(id)) throw configError(`no table ${id} on either side`)
  for (const id of names) {
    if (only && !only.includes(id)) continue
    const [s, t] = [ta.get(id), tb.get(id)]
    const [schema, name] = [(s ?? t)!.schema, (s ?? t)!.name]
    if (ownTables(cfg.project.history_table).includes(name) || !compares(cfg.project, 'table', schema, name)) continue
    if (!s || !t) {
      skip(id, `only in the ${s ? 'source' : 'target'}; compare the schemas first`)
      continue
    }
    // No key on either side: compared as whole rows.
    const key = s.key.length ? s.key : t.key
    if (key.some((k) => !s.allColumns.has(k) || !t.allColumns.has(k))) {
      skip(id, 'its key columns differ between the sides')
      continue
    }
    const columns = [...s.allColumns.values()].filter((c) => t.allColumns.has(c.name))
    tables.push({ schema, name, key, columns, identity: s.identity || t.identity })
  }
  return { tables, skipped }
}

/** Compares one table: counts, then buckets, then key/hash pairs for the buckets that differ. */
async function compareTable(a: Conn, b: Conn, t: DataTable, log: Log): Promise<{ result: TableResult; diff: TableDiff }> {
  const d = dialectOf(a)
  const started = Date.now()
  const diff: TableDiff = { table: t, onlyInSource: [], onlyInTarget: [], different: [] }
  const result: TableResult = { table: tableName(t), key: t.key, source_rows: 0, target_rows: 0, only_in_source: 0, only_in_target: 0, different: 0, ms: 0, ...(!t.key.length && { whole_rows: true }) }
  const estimate = Math.max(...(await Promise.all([d.estimate(a, t), d.estimate(b, t)])))
  let same: boolean
  let mask = 0
  let buckets: number[] | undefined
  /** rows in each differing bucket (the larger side), to read the pairs in chunks */
  let sizes = new Map<number, number>()
  const bitsFor = (rows: number, per: number) => Math.max(1, Math.min(MAX_BITS, Math.ceil(Math.log2(rows / per))))
  /** One pass per side: a count and fingerprint per bucket; their totals are the table's. */
  const byBucket = async (bits: number) => {
    mask = 2 ** bits - 1
    const [ba, bb] = await Promise.all([d.buckets(a, t, mask), d.buckets(b, t, mask)])
    result.source_rows = ba.reduce((n, [, c]) => n + c, 0)
    result.target_rows = bb.reduce((n, [, c]) => n + c, 0)
    const fp = (rs: [number, number, string][]) => new Map(rs.map(([k, n, f]) => [k, [n, f] as const]))
    const [ma, mb] = [fp(ba), fp(bb)]
    buckets = [...new Set([...ma.keys(), ...mb.keys()])].filter((k) => ma.get(k)?.[0] !== mb.get(k)?.[0] || ma.get(k)?.[1] !== mb.get(k)?.[1])
    sizes = new Map(buckets.map((k) => [k, Math.max(ma.get(k)?.[0] ?? 0, mb.get(k)?.[0] ?? 0)]))
    log('info', `${tableName(t)}: ${buckets.length} of ${mask + 1} buckets differ`)
    return buckets.length === 0
  }
  if (estimate > SMALL) {
    same = await byBucket(bitsFor(estimate, PER_BUCKET))
  } else {
    const [[na, fa], [nb, fb]] = await Promise.all([d.fingerprint(a, t), d.fingerprint(b, t)])
    result.source_rows = na
    result.target_rows = nb
    same = na === nb && fa === fb
    // The estimate was stale (a table filled since it was last analysed): narrow it down by bucket.
    if (!same && Math.max(na, nb) > SMALL) same = await byBucket(bitsFor(Math.max(na, nb), PER_BUCKET))
  }
  if (!same) {
    // The differing buckets in chunks of about CHUNK_ROWS rows; a key (or, without one, a whole
    // row) always falls in the same bucket on both sides, so each chunk is compared on its own.
    const chunks: (number[] | undefined)[] = []
    if (!buckets) chunks.push(undefined)
    else {
      let cur: number[] = []
      let rows = 0
      for (const k of buckets) {
        const n = sizes.get(k) ?? 0
        if (cur.length && rows + n > CHUNK_ROWS) {
          chunks.push(cur)
          cur = []
          rows = 0
        }
        cur.push(k)
        rows += n
      }
      if (cur.length) chunks.push(cur)
    }
    for (const chunk of chunks) await compareChunk(chunk)
  }
  async function compareChunk(chunk: number[] | undefined): Promise<void> {
    const [pa, pb] = await Promise.all([d.pairs(a, t, mask, chunk), d.pairs(b, t, mask, chunk)])
    if (!t.key.length) {
      // Whole rows: how many copies of each row each side has.
      const copies = new Map<string, number>()
      for (const [, h] of pa) copies.set(h, (copies.get(h) ?? 0) + 1)
      for (const [, h] of pb) copies.set(h, (copies.get(h) ?? 0) - 1)
      for (const [h, n] of copies) {
        for (let i = 0; i < n; i++) diff.onlyInSource.push([h])
        for (let i = 0; i < -n; i++) diff.onlyInTarget.push([h])
      }
    } else {
      const hb = new Map(pb.map(([k, h]) => [keyId(k), [k, h] as const]))
      for (const [k, h] of pa) {
        const other = hb.get(keyId(k))
        if (!other) diff.onlyInSource.push(k)
        else {
          if (other[1] !== h) diff.different.push(k)
          hb.delete(keyId(k))
        }
      }
      for (const [k] of hb.values()) diff.onlyInTarget.push(k)
    }
  }
  result.only_in_source = diff.onlyInSource.length
  result.only_in_target = diff.onlyInTarget.length
  result.different = diff.different.length
  result.ms = Date.now() - started
  return { result, diff }
}

const urlEnv = (url: string): Environment => ({ url, role: 'test', allow_clean: false, placeholders: {} })

function databaseOf(cfg: Config, side: Side): [string, Environment] {
  if (side.kind === 'env') return cfg.pick(side.name)
  if (side.kind === 'url') return [sideLabel(side), urlEnv(side.url)]
  throw configError(`data compare needs two databases; ${sideLabel(side)} has no rows`)
}

const DIFF_FORMAT = 'liftoff-data-diff'
type DiffFile = { format: string; version: number; result: DataComparison; diffs: TableDiff[] }

/** A data comparison that stays open:its differences can be read page by page and turned into SQL. */
export class DataSession {
  readonly result: DataComparison
  readonly diffs: Map<string, TableDiff>
  private readonly a: Conn
  private readonly b: Conn
  private readonly fks: [string, string][]

  private constructor(a: Conn, b: Conn, result: DataComparison, diffs: Map<string, TableDiff>, fks: [string, string][]) {
    this.a = a
    this.b = b
    this.result = result
    this.diffs = diffs
    this.fks = fks
  }

  /** Connects to both sides; `then` runs with both open and closes them when it throws. */
  private static async connect<T>(cfg: Config, source: Side, target: Side, then: (a: Conn, b: Conn) => Promise<T>): Promise<T> {
    if (JSON.stringify(source) === JSON.stringify(target)) throw configError('the source and the target are the same')
    const [an, ae] = databaseOf(cfg, source)
    const [bn, be] = databaseOf(cfg, target)
    const a = await open(an, ae)
    let b: Conn | undefined
    try {
      b = await open(bn, be)
      if (a.engine !== b.engine) throw configError(`${sideLabel(source)} is ${a.engine} and ${sideLabel(target)} is ${b.engine}; data compare needs the same engine on both sides`)
      return await then(a, b)
    } catch (e) {
      await a.close()
      await b?.close()
      throw e
    }
  }

  /** Connects to both sides and compares every table both have (or only `tables`). Close it when done. */
  static open(cfg: Config, source: Side, target: Side, only?: string[], log: Log = quiet): Promise<DataSession> {
    const started = Date.now()
    return DataSession.connect(cfg, source, target, async (a, b) => {
      const { tables, skipped } = await plan(cfg, a, b, only)
      const results: TableResult[] = [...skipped]
      const diffs = new Map<string, TableDiff>()
      for (const t of tables) {
        const { result, diff } = await compareTable(a, b, t, log)
        log('info', `${result.table}: ${result.source_rows} and ${result.target_rows} rows; ${result.only_in_source} only in the source, ${result.only_in_target} only in the target, ${result.different} different (${result.ms} ms)`)
        results.push(result)
        diffs.set(result.table, diff)
      }
      results.sort((x, y) => x.table.localeCompare(y.table))
      const fks = await dialectOf(a).foreignKeys(a, cfg.project.schemas)
      const r: DataComparison = { source: sideLabel(source), target: sideLabel(target), engine: a.engine, tables: results, ms: Date.now() - started }
      return new DataSession(a, b, r, diffs, fks)
    })
  }

  /**
   * Writes the comparison and the differing keys to a file, so the rows can be paged later without
   * comparing again (`resume`). Only side labels go in, never a URL or a password.
   */
  save(file: string): void {
    const doc: DiffFile = { format: DIFF_FORMAT, version: 1, result: this.result, diffs: [...this.diffs.values()] }
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, JSON.stringify(doc))
  }

  /** Opens a comparison saved with `save`: connects to both sides again, compares nothing. */
  static resume(cfg: Config, source: Side, target: Side, file: string): Promise<DataSession> {
    let doc: DiffFile
    try {
      doc = JSON.parse(fs.readFileSync(file, 'utf8'))
    } catch (e) {
      throw configError(`cannot read the saved data comparison ${file}: ${e instanceof Error ? e.message : String(e)}`)
    }
    if (doc.format !== DIFF_FORMAT) throw configError(`${file} is not a saved data comparison`)
    if (doc.result.source !== sideLabel(source) || doc.result.target !== sideLabel(target)) {
      throw configError(`${file} compares ${doc.result.source} with ${doc.result.target}, not ${sideLabel(source)} with ${sideLabel(target)}`)
    }
    return DataSession.connect(cfg, source, target, async (a, b) => {
      const fks = await dialectOf(a).foreignKeys(a, cfg.project.schemas)
      return new DataSession(a, b, doc.result, new Map(doc.diffs.map((d) => [tableName(d.table), d])), fks)
    })
  }

  private diff(table: string): TableDiff {
    const d = this.diffs.get(table)
    if (!d) throw configError(`${table} was not compared`)
    return d
  }

  /** One page of a table's differences, with both rows (values as text). */
  async page(table: string, kind: 'only_in_source' | 'only_in_target' | 'different', offset: number, limit: number): Promise<{ columns: string[]; key: string[]; total: number; rows: RowPair[] }> {
    const d = this.diff(table)
    const keys = (kind === 'only_in_source' ? d.onlyInSource : kind === 'only_in_target' ? d.onlyInTarget : d.different).slice(offset, offset + limit)
    const dl = dialectOf(this.a)
    const [ra, rb] = await Promise.all([
      kind === 'only_in_target' ? new Map<string, (string | null)[]>() : dl.rows(this.a, d.table, keys),
      kind === 'only_in_source' ? new Map<string, (string | null)[]>() : dl.rows(this.b, d.table, keys),
    ])
    const total = kind === 'only_in_source' ? d.onlyInSource.length : kind === 'only_in_target' ? d.onlyInTarget.length : d.different.length
    return { columns: d.table.columns.map((c) => c.name), key: d.table.key, total, rows: keys.map((k) => ({ key: k, source: ra.get(keyId(k)) ?? null, target: rb.get(keyId(k)) ?? null })) }
  }

  /**
   * The statements that make the target's rows match the source's, in chunks (so millions of rows
   * never sit in memory at once): deletes child tables first, then inserts and updates parents first.
   */
  async *script(tables?: string[], what: { insert?: boolean; update?: boolean; delete?: boolean } = {}): AsyncGenerator<string> {
    const doInsert = what.insert ?? true
    const doUpdate = what.update ?? true
    const doDelete = what.delete ?? true
    const chosen = [...this.diffs.values()].filter((d) => !tables || tables.includes(tableName(d.table)))
    const order = parentsFirst(chosen.map((d) => tableName(d.table)), this.fks)
    const dl = dialectOf(this.a)
    const isMs = this.a.engine === 'SQL Server'
    yield `-- Makes the rows of ${this.result.target} match ${this.result.source}\n-- Written by LiftOff ${new Date().toISOString()}. Review before running.\n`
    const fq = (t: DataTable) => (t.schema ? `${dl.q(t.schema)}.${dl.q(t.name)}` : dl.q(t.name))
    const where = (t: DataTable, k: Key) => t.key.map((name, i) => `${dl.q(name)} = ${dl.literal(t.columns.find((c) => c.name === name)!, k[i])}`).join(' AND ')
    if (doDelete) {
      for (const id of [...order].reverse()) {
        const d = this.diffs.get(id)!
        if (!d.table.key.length) {
          // One statement (one pass over the table) per HEAP_DELETE distinct rows; their values above it.
          for (const [hashes, rows] of await this.byHash(this.b, d.table, d.onlyInTarget)) {
            yield hashes.map(([h, n]) => `-- ${n > 1 ? `${n} copies of ` : ''}${JSON.stringify(rows.get(keyId([h])))}`).join('\n') + `\n${dl.deleteCopies(d.table, hashes, rows)}\n`
          }
          continue
        }
        for (let i = 0; i < d.onlyInTarget.length; i += 1000) {
          yield d.onlyInTarget.slice(i, i + 1000).map((k) => `DELETE FROM ${fq(d.table)} WHERE ${where(d.table, k)};`).join('\n') + '\n'
        }
      }
    }
    for (const id of order) {
      const d = this.diffs.get(id)!
      const t = d.table
      const cols = t.columns
      if (doInsert && d.onlyInSource.length) {
        if (isMs && t.identity) yield `SET IDENTITY_INSERT ${fq(t)} ON;\n`
        const read = t.key.length ? 1000 : HEAP_READ
        for (let i = 0; i < d.onlyInSource.length; i += read) {
          const keys = d.onlyInSource.slice(i, i + read)
          const found = await dl.rows(this.a, t, keys)
          // One INSERT per key, so each copy of a duplicated row (no key) is inserted.
          const rows = keys.map((k) => found.get(keyId(k))).filter((r) => r !== undefined)
          const overriding = !isMs && t.identity ? ' OVERRIDING SYSTEM VALUE' : ''
          for (let j = 0; j < rows.length; j += 1000) {
            yield rows.slice(j, j + 1000).map((r) => `INSERT INTO ${fq(t)} (${cols.map((c) => dl.q(c.name)).join(', ')})${overriding} VALUES (${r.map((v, k) => dl.literal(cols[k], v)).join(', ')});`).join('\n') + '\n'
          }
        }
        if (isMs && t.identity) yield `SET IDENTITY_INSERT ${fq(t)} OFF;\n`
      }
      if (doUpdate && d.different.length) {
        for (let i = 0; i < d.different.length; i += 1000) {
          const keys = d.different.slice(i, i + 1000)
          const [ra, rb] = await Promise.all([dl.rows(this.a, t, keys), dl.rows(this.b, t, keys)])
          const out: string[] = []
          for (const k of keys) {
            const [s, o] = [ra.get(keyId(k)), rb.get(keyId(k))]
            if (!s || !o) continue
            // Only the columns that differ (never the key: rows are matched on it).
            const set = cols.map((c, j) => [c, j] as const).filter(([c, j]) => s[j] !== o[j] && !t.key.includes(c.name))
            if (set.length) out.push(`UPDATE ${fq(t)} SET ${set.map(([c, j]) => `${dl.q(c.name)} = ${dl.literal(c, s[j])}`).join(', ')} WHERE ${where(t, k)};`)
          }
          if (out.length) yield out.join('\n') + '\n'
        }
      }
    }
  }

  /** Row hashes with their number of copies, one batch per delete statement, with the rows' values (for the comment above it). */
  private async byHash(c: Conn, t: DataTable, keys: Key[]): Promise<[[string, number][], Map<string, (string | null)[]>][]> {
    const copies = new Map<string, number>()
    for (const [h] of keys) copies.set(h, (copies.get(h) ?? 0) + 1)
    const all = [...copies]
    const out: [[string, number][], Map<string, (string | null)[]>][] = []
    for (let i = 0; i < all.length; i += HEAP_READ) {
      const read = all.slice(i, i + HEAP_READ)
      const rows = await dialectOf(c).rows(c, t, read.map(([h]) => [h]))
      for (let j = 0; j < read.length; j += HEAP_DELETE) out.push([read.slice(j, j + HEAP_DELETE), rows])
    }
    return out
  }

  /** Runs the script on the target, in one transaction; nothing changes when a statement fails. */
  async apply(tables?: string[], what?: { insert?: boolean; update?: boolean; delete?: boolean }, log: Log = quiet): Promise<{ statements: number }> {
    const b = this.b
    let statements = 0
    await b.batch(dialect[b.engine].begin)
    try {
      for await (const chunk of this.script(tables, what)) {
        const body = chunk.split('\n').filter((l) => l && !l.startsWith('--')).join('\n')
        if (!body) continue
        await b.batch(body)
        statements += body.split('\n').length
      }
    } catch (e) {
      await b.batch('ROLLBACK').catch(() => {})
      throw e
    }
    await b.batch('COMMIT')
    log('info', `Applied ${statements} statement(s) to ${this.result.target}`)
    return { statements }
  }

  async close(): Promise<void> {
    await Promise.allSettled([this.a.close(), this.b.close()])
  }
}

/** Tables in an order where a table comes after the tables it references (cycles: as listed). */
export function parentsFirst(tables: string[], fks: [string, string][]): string[] {
  const set = new Set(tables)
  const deps = new Map(tables.map((t) => [t, new Set(fks.filter(([c, p]) => c === t && p !== t && set.has(p)).map(([, p]) => p))]))
  const out: string[] = []
  const done = new Set<string>()
  const visit = (t: string, path: Set<string>) => {
    if (done.has(t) || path.has(t)) return
    path.add(t)
    for (const p of deps.get(t) ?? []) visit(p, path)
    path.delete(t)
    done.add(t)
    out.push(t)
  }
  for (const t of [...tables].sort()) visit(t, new Set())
  return out
}
