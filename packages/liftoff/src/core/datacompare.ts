// Data compare: which rows differ between the same tables in two databases, and the INSERT /
// UPDATE / DELETE statements that make the target's rows match the source's.
//
// Fast on big tables because rows are compared where they are, by hash:
//   1. each side returns one row count and one fingerprint for the whole table (a sum of row
//      hashes); equal on both sides means the table is the same, whatever its size
//   2. a table that differs is split into buckets by a hash of its key; each side returns one
//      count and fingerprint per bucket (about 2,000 rows each)
//   3. only for the buckets that differ, each side returns (key, row hash) pairs; comparing those
//      gives the rows that are only in the source, only in the target, or different
// Full rows are read later, and only for differing keys: page by page to look at, in batches for
// a script. Both sides must run the same engine (the hashes are computed by the database).
// A fingerprint match is a hash match: the chance that different rows give the same 60-bit sum
// is about one in 10^18.

import * as fs from 'node:fs'
import * as path from 'node:path'
import type { Config, Environment } from './config.ts'
import { compares } from './config.ts'
import { open, type Conn } from './db.ts'
import { configError } from './errors.ts'
import { typeName } from './msdiff.ts'
import { PgConn, quoteIdent } from './postgres.ts'
import { quiet, type Log } from './runner.ts'
import { quote as msQuote, SqlServerConn } from './sqlserver.ts'
import type { Side } from './compare.ts'
import { sideLabel } from './compare.ts'

/** A column as both sides have it; only columns in both, and not computed, are compared. */
export type DataColumn = { name: string; type: string; /** how values become text and back (SQL Server) */ text: 'plain' | 'binary' | 'clr' | 'float' | 'datetime' }

/** A table as compared. */
export type DataTable = {
  schema: string
  name: string
  /** the key columns: the primary key, else a unique index on non-null columns */
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
  /** why the table was not compared (no key, only on one side, …) */
  skipped?: string
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

/** A row's key, each part as text. */
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
}

const tableName = (t: { schema: string; name: string }) => `${t.schema}.${t.name}`
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
    const where = buckets ? ` where ${pgKeyHash(t)} & $1 = any($2::int[])` : ''
    const rows = await (c as PgConn).rows(`select ${t.key.map((k) => `t.${quoteIdent(k)}::text`).join(', ')}, ${pgRowHash(t)}::text from ${pgFrom(t)}${where}`, buckets ? [mask, buckets] : [])
    return rows.map((r) => [r.slice(0, t.key.length).map(String), String(r[t.key.length])])
  },
  async rows(c, t, keys) {
    const out = new Map<string, (string | null)[]>()
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
}

const pgFrom = (t: DataTable) => `${quoteIdent(t.schema)}.${quoteIdent(t.name)} t`
const pgRecord = (cols: string[]) => `row(${cols.map((c) => `t.${quoteIdent(c)}`).join(', ')})::text`
/** 60 bits of the md5 of the row's text (record output is unambiguous: quotes, NULL as nothing). */
const pgRowHash = (t: DataTable) => `('x' || substr(md5(${pgRecord(t.columns.map((c) => c.name))}), 1, 15))::bit(60)::bigint`
/** The bucket source: a single integer key as it is, else 32 bits of the md5 of the key. */
const pgKeyHash = (t: DataTable) => (integerKey(t, ['smallint', 'integer', 'bigint']) ? `t.${quoteIdent(t.key[0])}` : `('x' || substr(md5(${pgRecord(t.key)}), 1, 8))::bit(32)::int`)
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
      `SELECT COUNT_BIG(*), CAST(COALESCE(SUM(CAST(h AS DECIMAL(38, 0))), 0) AS VARCHAR(40)) FROM (SELECT ${msRowHash(t)} AS h FROM ${msFrom(t)}) x`,
    )
    return [Number(n), String(sum)]
  },
  async buckets(c, t, mask) {
    const rows = await (c as SqlServerConn).query(
      `SELECT b, COUNT_BIG(*), CAST(SUM(CAST(h AS DECIMAL(38, 0))) AS VARCHAR(40)) FROM (SELECT ${msKeyHash(t)} & @P1 AS b, ${msRowHash(t)} AS h FROM ${msFrom(t)}) x GROUP BY b`,
      [mask],
    )
    return rows.map(([b, n, s]) => [Number(b), Number(n), String(s)])
  },
  async pairs(c, t, mask, buckets) {
    const keyText = t.key.map((k) => msText(t.columns.find((c) => c.name === k)!)).join(', ')
    const select = `SELECT ${keyText}, CAST(${msRowHash(t)} AS VARCHAR(20))`
    if (!buckets) return toPairs(t, await (c as SqlServerConn).query(`${select} FROM ${msFrom(t)}`))
    // Copy the rows of the differing buckets first, then hash only those: with the filter in the
    // same query, SQL Server hashes every row of the table before filtering.
    const rows = await (c as SqlServerConn).query(
      `SELECT t.* INTO #liftoff_rows FROM ${msFrom(t)} WHERE ${msKeyHash(t)} & @P1 IN (SELECT CAST(value AS INT) FROM STRING_SPLIT(@P2, ','));
       ${select} FROM #liftoff_rows t;
       DROP TABLE #liftoff_rows;`,
      [mask, buckets.join(',')],
    )
    return toPairs(t, rows)
  },
  async rows(c, t, keys) {
    const out = new Map<string, (string | null)[]>()
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
}

const msFrom = (t: DataTable) => `${msQuote(t.schema)}.${msQuote(t.name)} t`
/**
 * The row as one text: each value as `<length>:<text>`, NULL as `-`. Lengths make it unambiguous
 * (no separator a value could contain), and NULL differs from ''. Three times faster than JSON.
 */
const msRowText = (cols: DataColumn[]) => `CONCAT(${cols.map((c) => `ISNULL(CONCAT(DATALENGTH(${msText(c)}), ':', ${msText(c)}), N'-')`).join(', ')}, N'')`
/** 60 bits of SHA-256 over the row text. */
const msRowHash = (t: DataTable) => `(CAST(SUBSTRING(HASHBYTES('SHA2_256', ${msRowText(t.columns)}), 1, 8) AS BIGINT) & 0x0FFFFFFFFFFFFFFF)`
/** The bucket source: a single integer key as it is, else 32 bits of the hash of the key. */
const msKeyHash = (t: DataTable) =>
  integerKey(t, ['tinyint', 'smallint', 'int', 'bigint']) ? `t.${msQuote(t.key[0])}` : `CAST(SUBSTRING(HASHBYTES('SHA2_256', ${msRowText(t.key.map((k) => t.columns.find((c) => c.name === k)!))}), 1, 4) AS INT)`
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

const dialectOf = (c: Conn): Dialect => (c.engine === 'PostgreSQL' ? pg : ms)

/* ---------- comparing ---------- */

/** About this many rows per bucket; tables up to SMALL rows skip the buckets. */
const PER_BUCKET = 2000
const SMALL = 50_000

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
    if (name === cfg.project.history_table || !compares(cfg.project, 'table', schema, name)) continue
    if (!s || !t) {
      skip(id, `only in the ${s ? 'source' : 'target'}; compare the schemas first`)
      continue
    }
    const key = s.key.length ? s.key : t.key
    if (!key.length) {
      skip(id, 'no primary key or unique index on non-null columns, so rows cannot be matched')
      continue
    }
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
  const result: TableResult = { table: tableName(t), key: t.key, source_rows: 0, target_rows: 0, only_in_source: 0, only_in_target: 0, different: 0, ms: 0 }
  const estimate = Math.max(...(await Promise.all([d.estimate(a, t), d.estimate(b, t)])))
  let same: boolean
  let mask = 0
  let buckets: number[] | undefined
  /** One pass per side: a count and fingerprint per bucket; their totals are the table's. */
  const byBucket = async (rows: number) => {
    const bits = Math.min(20, Math.ceil(Math.log2(rows / PER_BUCKET)))
    mask = 2 ** bits - 1
    const [ba, bb] = await Promise.all([d.buckets(a, t, mask), d.buckets(b, t, mask)])
    result.source_rows = ba.reduce((n, [, c]) => n + c, 0)
    result.target_rows = bb.reduce((n, [, c]) => n + c, 0)
    const fp = (rs: [number, number, string][]) => new Map(rs.map(([k, n, f]) => [k, `${n}:${f}`]))
    const [ma, mb] = [fp(ba), fp(bb)]
    buckets = [...new Set([...ma.keys(), ...mb.keys()])].filter((k) => ma.get(k) !== mb.get(k))
    log('info', `${tableName(t)}: ${buckets.length} of ${mask + 1} buckets differ`)
    return buckets.length === 0
  }
  if (estimate > SMALL) {
    same = await byBucket(estimate)
  } else {
    const [[na, fa], [nb, fb]] = await Promise.all([d.fingerprint(a, t), d.fingerprint(b, t)])
    result.source_rows = na
    result.target_rows = nb
    same = na === nb && fa === fb
    // The estimate was stale (a table filled since it was last analysed): narrow it down by bucket.
    if (!same && Math.max(na, nb) > SMALL) same = await byBucket(Math.max(na, nb))
  }
  if (!same) {
    const [pa, pb] = await Promise.all([d.pairs(a, t, mask, buckets), d.pairs(b, t, mask, buckets)])
    const hb = new Map(pb.map(([k, h]) => [keyId(k), [k, h] as const]))
    for (const [k, h] of pa) {
      const other = hb.get(keyId(k))
      if (!other) diff.onlyInSource.push(k)
      else {
        if (other[1] !== h) diff.different.push(k)
        hb.delete(keyId(k))
      }
    }
    diff.onlyInTarget = [...hb.values()].map(([k]) => k)
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
    const fq = (t: DataTable) => `${dl.q(t.schema)}.${dl.q(t.name)}`
    const where = (t: DataTable, k: Key) => t.key.map((name, i) => `${dl.q(name)} = ${dl.literal(t.columns.find((c) => c.name === name)!, k[i])}`).join(' AND ')
    if (doDelete) {
      for (const id of [...order].reverse()) {
        const d = this.diffs.get(id)!
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
        for (let i = 0; i < d.onlyInSource.length; i += 1000) {
          const rows = await dl.rows(this.a, t, d.onlyInSource.slice(i, i + 1000))
          const overriding = !isMs && t.identity ? ' OVERRIDING SYSTEM VALUE' : ''
          yield [...rows.values()].map((r) => `INSERT INTO ${fq(t)} (${cols.map((c) => dl.q(c.name)).join(', ')})${overriding} VALUES (${r.map((v, j) => dl.literal(cols[j], v)).join(', ')});`).join('\n') + '\n'
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

  /** Runs the script on the target, in one transaction; nothing changes when a statement fails. */
  async apply(tables?: string[], what?: { insert?: boolean; update?: boolean; delete?: boolean }, log: Log = quiet): Promise<{ statements: number }> {
    const b = this.b
    let statements = 0
    await b.batch(b.engine === 'SQL Server' ? 'BEGIN TRANSACTION' : 'BEGIN')
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
