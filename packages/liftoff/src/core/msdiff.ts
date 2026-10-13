// SQL Server schema diff: reads a database's schema from sys.* and turns differences into T-SQL
// steps, in the same Change / phase shape as the PostgreSQL diff (changes.ts), so generate, undo,
// capture, squash and the drift checks work the same way.
// Objects: tables (columns, identity, computed columns, defaults), primary keys, unique, check and
// foreign keys, rowstore indexes, views, procedures, functions, triggers, sequences, alias types.
// Counted as "not compared": synonyms, table types, CLR objects, encrypted modules, columnstore /
// XML / spatial indexes, indexes on views, permissions, extended properties, column collations.
// Every statement ends with GO: CREATE VIEW / PROCEDURE / FUNCTION / TRIGGER must start a batch.

import { compares, type Project } from './config.ts'
import { configError } from './errors.ts'
import { ownTables } from './db.ts'
import {
  P_DROP,
  P_DROP_OTHER,
  P_DROP_TABLES,
  P_FKS,
  P_FUNCS,
  P_KEYS,
  P_TABLES,
  P_TRIGGERS,
  P_TYPES,
  P_VIEWS,
  change,
  key,
  sorted,
  step,
  unkey,
  withUndo,
  type Change,
  type Step,
} from './changes.ts'
import { lit, quote, type SqlServerConn } from './sqlserver.ts'

export type MsColumn = {
  name: string
  data_type: string
  not_null: boolean
  /** `IDENTITY(1,1)` */
  identity: string | null
  /** `AS ([qty]*[price]) PERSISTED` */
  computed: string | null
  /** the default constraint's name, when it was named explicitly */
  default_name: string | null
  /** `((0))`, as SQL Server stores it */
  default: string | null
}

export type MsConstraint = {
  name: string
  /**
   * SQL Server picked the name (PK__orders__3213E83F…). It differs per database, so these are
   * matched by definition instead.
   */
  system_named: boolean
  /** `PRIMARY KEY CLUSTERED ([id] ASC)`, `CHECK ([total]>=(0))`, `FOREIGN KEY ([c]) REFERENCES …` */
  def: string
  /** PK, UQ, C, F */
  kind: string
  /** key or foreign-key columns, `a,b`, to find an unnamed constraint again */
  cols: string
}

const constraintKey = (c: MsConstraint) => (c.system_named ? `~${c.def}` : c.name)

export type MsTable = {
  columns: MsColumn[]
  constraints: MsConstraint[]
  /** index name -> CREATE INDEX statement (indexes behind a key constraint are left out) */
  indexes: Map<string, string>
}

export type ModuleKind = 'view' | 'procedure' | 'function' | 'trigger'

const word: Record<ModuleKind, string> = { view: 'VIEW', procedure: 'PROCEDURE', function: 'FUNCTION', trigger: 'TRIGGER' }
const group: Record<ModuleKind, string> = { view: 'Views', procedure: 'Procedures', function: 'Functions', trigger: 'Triggers' }
const filterKind: Record<ModuleKind, string> = { view: 'view', procedure: 'function', function: 'function', trigger: 'trigger' }

export type Module = {
  kind: ModuleKind
  /** the CREATE statement as written, line endings and trailing spaces normalised */
  def: string
  /** creation order in the source database; created in this order */
  order: number
  /** triggers: the key of the table they belong to */
  parent: string | null
}

export type MsSequence = {
  data_type: string
  start: string
  increment: string
  min: string
  max: string
  cycle: boolean
  /** null: NO CACHE; 'default': CACHE with SQL Server's size; else the size */
  cache: number | 'default' | null
}

export type MsModel = {
  tables: Map<string, MsTable>
  modules: Map<string, Module>
  sequences: Map<string, MsSequence>
  /** alias types: key -> `CREATE TYPE … FROM …` */
  types: Map<string, string>
  not_compared: [string, number][]
}

export const emptyMsModel = (): MsModel => ({ tables: new Map(), modules: new Map(), sequences: new Map(), types: new Map(), not_compared: [] })

/* ---------- reading the schema ---------- */

const qk = (k: string) => unkey(k).slice(0, 2).map(quote).join('.')
const dotted = (k: string) => unkey(k).join('.')

/** A column's or alias type's type as written in DDL. */
export function typeName(name: string, userDefined: boolean, schema: string, maxLen: number, precision: number, scale: number): string {
  if (userDefined) return `${quote(schema)}.${quote(name)}`
  const len = (n: number) => (n === -1 ? 'max' : String(n))
  switch (name) {
    case 'varchar':
    case 'char':
    case 'varbinary':
    case 'binary':
      return `${name}(${len(maxLen)})`
    case 'nvarchar':
    case 'nchar':
      return `${name}(${maxLen === -1 ? 'max' : maxLen / 2})`
    case 'decimal':
    case 'numeric':
      return `${name}(${precision},${scale})`
    case 'datetime2':
    case 'time':
    case 'datetimeoffset':
      return `${name}(${scale})`
    case 'float':
      return precision !== 53 ? `float(${precision})` : name
    default:
      return name
  }
}

/** Where the leading `CREATE` starts (after comments), and where the word after `CREATE [OR ALTER]` starts. */
function createHeader(def: string): [number, number] | undefined {
  let i = 0
  while (i < def.length) {
    if (/\s/.test(def[i])) i++
    else if (def.startsWith('--', i)) {
      const n = def.indexOf('\n', i)
      i = n < 0 ? def.length : n
    } else if (def.startsWith('/*', i)) {
      const n = def.indexOf('*/', i + 2)
      i = n < 0 ? def.length : n + 2
    } else break
  }
  const isWord = (at: number, w: string) => def.slice(at, at + w.length).toLowerCase() === w
  const skipWs = (at: number) => at + (def.slice(at).length - def.slice(at).trimStart().length)
  if (!isWord(i, 'create')) return undefined
  let j = skipWs(i + 6)
  if (isWord(j, 'or')) {
    const k = skipWs(j + 2)
    if (isWord(k, 'alter')) j = skipWs(k + 5)
  }
  return [i, j]
}

/** `CREATE VIEW …` -> `CREATE OR ALTER VIEW …`, so objects that depend on it keep working. */
export function createOrAlter(def: string): string {
  const h = createHeader(def)
  return h ? `${def.slice(0, h[0])}CREATE OR ALTER ${def.slice(h[1])}` : def
}

/**
 * Line endings, trailing spaces and `CREATE` vs `CREATE OR ALTER` do not count as a change in a
 * module's text (SQL Server stores `CREATE OR ALTER VIEW` as `CREATE   VIEW`).
 */
export function normalize(def: string): string {
  const t = def
    .replaceAll('\r\n', '\n')
    .split('\n')
    .map((l) => l.trimEnd())
    .join('\n')
    .trim()
  const h = createHeader(t)
  return h ? `${t.slice(0, h[0])}CREATE ${t.slice(h[1])}` : t
}

export async function introspect(c: SqlServerConn, schemas: string[], excludeTable: string): Promise<MsModel> {
  const names = schemas.map(lit).join(', ')
  const inScope = `SELECT t.object_id FROM sys.tables t JOIN sys.schemas s ON s.schema_id = t.schema_id WHERE s.name IN (${names}) AND t.is_ms_shipped = 0 AND t.name NOT IN (${ownTables(excludeTable).map(lit).join(', ')})`
  const m = emptyMsModel()
  const s = (v: unknown) => (v ?? '') as string

  const byId = new Map<number, string>()
  for (const r of await c.query(`SELECT t.object_id, SCHEMA_NAME(t.schema_id), t.name FROM sys.tables t WHERE t.object_id IN (${inScope})`)) {
    const k = key(s(r[1]), s(r[2]))
    byId.set(r[0] as number, k)
    m.tables.set(k, { columns: [], constraints: [], indexes: new Map() })
  }
  const table = (r: unknown[]) => m.tables.get(byId.get(r[0] as number) ?? '')

  for (const r of await c.query(
    `SELECT c.object_id, c.name, ty.name, ty.is_user_defined, SCHEMA_NAME(ty.schema_id), c.max_length, c.precision, c.scale,
            c.is_nullable, CONVERT(nvarchar(40), ic.seed_value), CONVERT(nvarchar(40), ic.increment_value),
            cc.definition, cc.is_persisted, d.name, d.is_system_named, d.definition
     FROM sys.columns c
     JOIN sys.types ty ON ty.user_type_id = c.user_type_id
     LEFT JOIN sys.identity_columns ic ON ic.object_id = c.object_id AND ic.column_id = c.column_id
     LEFT JOIN sys.computed_columns cc ON cc.object_id = c.object_id AND cc.column_id = c.column_id
     LEFT JOIN sys.default_constraints d ON d.parent_object_id = c.object_id AND d.parent_column_id = c.column_id
     WHERE c.object_id IN (${inScope})
     ORDER BY c.object_id, c.column_id`,
  )) {
    table(r)?.columns.push({
      name: s(r[1]),
      data_type: typeName(s(r[2]), r[3] === true, s(r[4]), r[5] as number, r[6] as number, r[7] as number),
      not_null: r[8] === false,
      identity: r[9] === null ? null : `IDENTITY(${s(r[9])},${s(r[10])})`,
      computed: r[11] === null ? null : `AS ${s(r[11])}${r[12] === true ? ' PERSISTED' : ''}`,
      default_name: r[13] !== null && r[14] === false ? s(r[13]) : null,
      default: r[15] === null ? null : s(r[15]),
    })
  }

  // Catalog text and object names can have different collations; everything is cast to the
  // database's own before it is joined into one string.
  const fkCols = (side: string, quoted: boolean) =>
    `(SELECT STRING_AGG(${quoted ? 'QUOTENAME(c.name)' : 'c.name'} COLLATE DATABASE_DEFAULT, ${quoted ? "N', '" : "','"}) WITHIN GROUP (ORDER BY fc.constraint_column_id)
      FROM sys.foreign_key_columns fc JOIN sys.columns c ON c.object_id = fc.${side}_object_id AND c.column_id = fc.${side}_column_id
      WHERE fc.constraint_object_id = f.object_id)`
  const keyCols = (agg: string, sep: string) =>
    `(SELECT STRING_AGG((${agg}) COLLATE DATABASE_DEFAULT, ${sep}) WITHIN GROUP (ORDER BY ic.key_ordinal) FROM sys.index_columns ic
      JOIN sys.columns c ON c.object_id = ic.object_id AND c.column_id = ic.column_id
      WHERE ic.object_id = i.object_id AND ic.index_id = i.index_id AND ic.key_ordinal > 0)`
  const ordered = "QUOTENAME(c.name) + CASE WHEN ic.is_descending_key = 1 THEN N' DESC' ELSE N' ASC' END"
  for (const r of await c.query(
    `SELECT kc.parent_object_id, kc.name, kc.is_system_named, RTRIM(kc.type),
            CASE kc.type WHEN 'PK' THEN N'PRIMARY KEY ' ELSE N'UNIQUE ' END + i.type_desc COLLATE DATABASE_DEFAULT + N' (' + ${keyCols(ordered, "N', '")} + N')',
            ${keyCols('c.name', "','")}
     FROM sys.key_constraints kc JOIN sys.indexes i ON i.object_id = kc.parent_object_id AND i.index_id = kc.unique_index_id
     WHERE kc.parent_object_id IN (${inScope})
     UNION ALL
     SELECT cc.parent_object_id, cc.name, cc.is_system_named, 'C', N'CHECK ' + cc.definition COLLATE DATABASE_DEFAULT, N''
     FROM sys.check_constraints cc WHERE cc.parent_object_id IN (${inScope})
     UNION ALL
     SELECT f.parent_object_id, f.name, f.is_system_named, 'F',
            N'FOREIGN KEY (' + ${fkCols('parent', true)} + N') REFERENCES ' + QUOTENAME(OBJECT_SCHEMA_NAME(f.referenced_object_id)) COLLATE DATABASE_DEFAULT + N'.'
            + QUOTENAME(OBJECT_NAME(f.referenced_object_id)) COLLATE DATABASE_DEFAULT + N' (' + ${fkCols('referenced', true)} + N')'
            + CASE f.delete_referential_action WHEN 1 THEN N' ON DELETE CASCADE' WHEN 2 THEN N' ON DELETE SET NULL' WHEN 3 THEN N' ON DELETE SET DEFAULT' ELSE N'' END
            + CASE f.update_referential_action WHEN 1 THEN N' ON UPDATE CASCADE' WHEN 2 THEN N' ON UPDATE SET NULL' WHEN 3 THEN N' ON UPDATE SET DEFAULT' ELSE N'' END,
            ${fkCols('parent', false)}
     FROM sys.foreign_keys f WHERE f.parent_object_id IN (${inScope})`,
  )) {
    table(r)?.constraints.push({ name: s(r[1]), system_named: r[2] === true, kind: s(r[3]), def: s(r[4]), cols: s(r[5]) })
  }
  for (const t of m.tables.values()) t.constraints.sort((a, b) => (constraintKey(a) < constraintKey(b) ? -1 : constraintKey(a) > constraintKey(b) ? 1 : 0))

  for (const r of await c.query(
    `SELECT i.object_id, i.name,
            N'CREATE ' + CASE WHEN i.is_unique = 1 THEN N'UNIQUE ' ELSE N'' END + i.type_desc COLLATE DATABASE_DEFAULT + N' INDEX ' + QUOTENAME(i.name) COLLATE DATABASE_DEFAULT
            + N' ON ' + QUOTENAME(OBJECT_SCHEMA_NAME(i.object_id)) COLLATE DATABASE_DEFAULT + N'.' + QUOTENAME(OBJECT_NAME(i.object_id)) COLLATE DATABASE_DEFAULT
            + N' (' + ${keyCols(ordered, "N', '")} + N')'
            + ISNULL(N' INCLUDE (' + (SELECT STRING_AGG(QUOTENAME(c.name) COLLATE DATABASE_DEFAULT, N', ') WITHIN GROUP (ORDER BY ic.index_column_id) FROM sys.index_columns ic
                 JOIN sys.columns c ON c.object_id = ic.object_id AND c.column_id = ic.column_id
                 WHERE ic.object_id = i.object_id AND ic.index_id = i.index_id AND ic.is_included_column = 1) + N')', N'')
            + CASE WHEN i.has_filter = 1 THEN N' WHERE ' + i.filter_definition COLLATE DATABASE_DEFAULT ELSE N'' END
     FROM sys.indexes i
     WHERE i.object_id IN (${inScope}) AND i.type IN (1, 2) AND i.is_primary_key = 0 AND i.is_unique_constraint = 0 AND i.is_hypothetical = 0`,
  )) {
    table(r)?.indexes.set(s(r[1]), s(r[2]))
  }

  const mods = await c.query(
    `SELECT s.name, o.name, RTRIM(o.type), m.definition, OBJECT_SCHEMA_NAME(o.parent_object_id), OBJECT_NAME(o.parent_object_id)
     FROM sys.objects o JOIN sys.schemas s ON s.schema_id = o.schema_id JOIN sys.sql_modules m ON m.object_id = o.object_id
     WHERE s.name IN (${names}) AND o.is_ms_shipped = 0 AND o.type IN ('V', 'P', 'FN', 'IF', 'TF', 'TR') AND m.definition IS NOT NULL
       AND (o.type <> 'TR' OR o.parent_object_id IN (${inScope}))
     ORDER BY o.create_date, o.object_id`,
  )
  mods.forEach((r, i) => {
    const t = s(r[2])
    const kind: ModuleKind = t === 'V' ? 'view' : t === 'P' ? 'procedure' : t === 'TR' ? 'trigger' : 'function'
    m.modules.set(key(s(r[0]), s(r[1])), { kind, def: normalize(s(r[3])), order: i, parent: kind === 'trigger' ? key(s(r[4]), s(r[5])) : null })
  })

  for (const r of await c.query(
    `SELECT SCHEMA_NAME(q.schema_id), q.name, TYPE_NAME(q.user_type_id), CONVERT(nvarchar(40), q.start_value), CONVERT(nvarchar(40), q.increment),
            CONVERT(nvarchar(40), q.minimum_value), CONVERT(nvarchar(40), q.maximum_value), q.is_cycling, q.is_cached, q.cache_size
     FROM sys.sequences q WHERE SCHEMA_NAME(q.schema_id) IN (${names})`,
  )) {
    m.sequences.set(key(s(r[0]), s(r[1])), {
      data_type: s(r[2]),
      start: s(r[3]),
      increment: s(r[4]),
      min: s(r[5]),
      max: s(r[6]),
      cycle: r[7] === true,
      cache: r[8] === false ? null : r[9] === null ? 'default' : (r[9] as number),
    })
  }

  for (const r of await c.query(
    `SELECT SCHEMA_NAME(t.schema_id), t.name, bt.name, t.max_length, t.precision, t.scale, t.is_nullable
     FROM sys.types t JOIN sys.types bt ON bt.user_type_id = t.system_type_id
     WHERE t.is_user_defined = 1 AND t.is_table_type = 0 AND t.is_assembly_type = 0 AND SCHEMA_NAME(t.schema_id) IN (${names})`,
  )) {
    const k = key(s(r[0]), s(r[1]))
    const base = typeName(s(r[2]), false, '', r[3] as number, r[4] as number, r[5] as number)
    m.types.set(k, `CREATE TYPE ${qk(k)} FROM ${base}${r[6] === false ? ' NOT NULL' : ''};`)
  }

  const objectsIn = `SELECT o.object_id FROM sys.objects o JOIN sys.schemas s ON s.schema_id = o.schema_id WHERE s.name IN (${names}) AND o.is_ms_shipped = 0`
  for (const r of await c.query(
    `SELECT N'synonyms', COUNT(*) FROM sys.synonyms WHERE object_id IN (${objectsIn})
     UNION ALL SELECT N'table types', COUNT(*) FROM sys.table_types WHERE SCHEMA_NAME(schema_id) IN (${names})
     UNION ALL SELECT N'CLR objects', COUNT(*) FROM sys.objects WHERE object_id IN (${objectsIn}) AND type IN ('PC', 'FS', 'FT', 'TA', 'AF')
     UNION ALL SELECT N'encrypted modules', COUNT(*) FROM sys.sql_modules WHERE object_id IN (${objectsIn}) AND definition IS NULL
     UNION ALL SELECT N'columnstore, XML and spatial indexes', COUNT(*) FROM sys.indexes WHERE object_id IN (${inScope}) AND type NOT IN (0, 1, 2)
     UNION ALL SELECT N'indexes on views', COUNT(*) FROM sys.indexes i JOIN sys.views v ON v.object_id = i.object_id WHERE v.object_id IN (${objectsIn}) AND i.type > 0
     UNION ALL SELECT N'permissions', COUNT(*) FROM sys.database_permissions WHERE class = 1 AND major_id IN (${objectsIn})
     UNION ALL SELECT N'extended properties', COUNT(*) FROM sys.extended_properties WHERE class = 1 AND major_id IN (${objectsIn})
     UNION ALL SELECT N'column collations other than the database default', COUNT(*) FROM sys.columns
       WHERE object_id IN (${inScope}) AND collation_name <> CAST(DATABASEPROPERTYEX(DB_NAME(), 'Collation') AS sysname)`,
  )) {
    const n = Number(r[1])
    if (n > 0) m.not_compared.push([s(r[0]), n])
  }
  return m
}

/** Removes what the project's comparison filters exclude; a table takes its triggers along. */
export function applyFilters(m: MsModel, p: Project): void {
  if (!p.filters.length) return
  const drop = <V>(map: Map<string, V>, object: (v: V) => string) => {
    for (const [k, v] of [...map]) if (!compares(p, object(v), unkey(k)[0], unkey(k)[1])) map.delete(k)
  }
  drop(m.tables, () => 'table')
  drop(m.modules, (md) => filterKind[md.kind])
  for (const [k, md] of [...m.modules]) if (md.parent && !m.tables.has(md.parent)) m.modules.delete(k)
  drop(m.sequences, () => 'sequence')
  drop(m.types, () => 'type')
}

/* ---------- DDL ---------- */

const go = (sql: string) => `${sql.trimEnd()}\nGO`

function colDef(c: MsColumn): string {
  const n = quote(c.name)
  if (c.computed) return `${n} ${c.computed}`
  let s = `${n} ${c.data_type}`
  if (c.identity) s += ` ${c.identity}`
  s += c.not_null ? ' NOT NULL' : ' NULL'
  if (c.default !== null) s += `${c.default_name ? ` CONSTRAINT ${quote(c.default_name)}` : ''} DEFAULT ${c.default}`
  return s
}

const addConstraint = (t: string, c: MsConstraint) =>
  c.system_named ? go(`ALTER TABLE ${t} ADD ${c.def};`) : go(`ALTER TABLE ${t} ADD CONSTRAINT ${quote(c.name)} ${c.def};`)

/** Drops a constraint whose name is only known in the database it runs on. */
function dropFound(t: string, lookup: string): string {
  return go(
    `DECLARE @name sysname = (${lookup});\nIF @name IS NOT NULL\nBEGIN\n    DECLARE @sql nvarchar(max) = N'ALTER TABLE ${t.replaceAll("'", "''")} DROP CONSTRAINT ' + QUOTENAME(@name);\n    EXEC (@sql);\nEND`,
  )
}

function dropConstraint(t: string, c: MsConstraint): string {
  if (!c.system_named) return go(`ALTER TABLE ${t} DROP CONSTRAINT ${quote(c.name)};`)
  const on = `parent_object_id = OBJECT_ID(${lit(t)})`
  let lookup: string
  if (c.kind === 'PK') lookup = `SELECT name FROM sys.key_constraints WHERE ${on} AND type = 'PK'`
  else if (c.kind === 'C') lookup = `SELECT name FROM sys.check_constraints WHERE ${on} AND N'CHECK ' + definition = ${lit(c.def)}`
  else if (c.kind === 'UQ') {
    lookup =
      `SELECT kc.name FROM sys.key_constraints kc WHERE kc.${on} AND kc.type = 'UQ' AND (SELECT STRING_AGG(c.name, ',') WITHIN GROUP (ORDER BY ic.key_ordinal) ` +
      'FROM sys.index_columns ic JOIN sys.columns c ON c.object_id = ic.object_id AND c.column_id = ic.column_id ' +
      `WHERE ic.object_id = kc.parent_object_id AND ic.index_id = kc.unique_index_id AND ic.key_ordinal > 0) = ${lit(c.cols)}`
  } else {
    lookup =
      `SELECT f.name FROM sys.foreign_keys f WHERE f.${on} AND (SELECT STRING_AGG(c.name, ',') WITHIN GROUP (ORDER BY fc.constraint_column_id) ` +
      'FROM sys.foreign_key_columns fc JOIN sys.columns c ON c.object_id = fc.parent_object_id AND c.column_id = fc.parent_column_id ' +
      `WHERE fc.constraint_object_id = f.object_id) = ${lit(c.cols)}`
  }
  return dropFound(t, lookup)
}

function dropDefault(t: string, c: MsColumn): string {
  if (c.default_name) return go(`ALTER TABLE ${t} DROP CONSTRAINT ${quote(c.default_name)};`)
  return dropFound(
    t,
    'SELECT d.name FROM sys.default_constraints d JOIN sys.columns c ON c.object_id = d.parent_object_id AND c.column_id = d.parent_column_id ' +
      `WHERE d.parent_object_id = OBJECT_ID(${lit(t)}) AND c.name = ${lit(c.name)}`,
  )
}

function addDefault(t: string, c: MsColumn): string | undefined {
  if (c.default === null) return undefined
  return go(`ALTER TABLE ${t} ADD ${c.default_name ? `CONSTRAINT ${quote(c.default_name)} ` : ''}DEFAULT ${c.default} FOR ${quote(c.name)};`)
}

const createTable = (t: string, tb: MsTable) => go(`CREATE TABLE ${t} (\n${tb.columns.map((c) => `    ${colDef(c)}`).join(',\n')}\n);`)

/** The whole table as one readable block, for the side-by-side view and the schema model. */
export function tableDdl(k: string, tb: MsTable): string {
  const t = qk(k)
  return [createTable(t, tb), ...tb.constraints.map((c) => addConstraint(t, c)), ...[...tb.indexes.values()].map((d) => go(`${d};`))].join('\n')
}

function sequenceClauses(s: MsSequence): string {
  const cache = s.cache === null ? 'NO CACHE' : s.cache === 'default' ? 'CACHE' : `CACHE ${s.cache}`
  return `INCREMENT BY ${s.increment} MINVALUE ${s.min} MAXVALUE ${s.max} ${s.cycle ? 'CYCLE' : 'NO CYCLE'} ${cache}`
}

const sequenceDdl = (k: string, s: MsSequence) => go(`CREATE SEQUENCE ${qk(k)} AS ${s.data_type} START WITH ${s.start} ${sequenceClauses(s)};`)

function modulePhase(md: Module): { phase: number; order: number } {
  if (md.kind === 'function') return { phase: P_FUNCS, order: md.order }
  if (md.kind === 'view') return { phase: P_VIEWS, order: md.order }
  if (md.kind === 'procedure') return { phase: P_TRIGGERS, order: md.order }
  return { phase: P_TRIGGERS, order: 1_000_000 + md.order }
}

/* ---------- compare ---------- */

/** Changes that turn `target` into `source`, each with the reverse steps for an undo script. */
export function diff(source: MsModel, target: MsModel): Change[] {
  return withUndo(compare(source, target), compare(target, source))
}

/** Everything in `m` as changes against an empty database (capture, squash). */
export const createAll = (m: MsModel) => compare(m, emptyMsModel())

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)

export function compare(source: MsModel, target: MsModel): Change[] {
  const out: Change[] = []

  for (const [k, ddl] of sorted(source.types)) {
    const old = target.types.get(k)
    if (old === undefined) out.push(change('type', 'Types', dotted(k), 'added', false, [step(P_TYPES, go(ddl))], null, ddl))
    else if (old !== ddl) {
      const steps = [step(P_TYPES, `-- ${qk(k)}: an alias type cannot be altered while columns use it; write this change by hand.`)]
      out.push(change('type', 'Types', dotted(k), 'changed', true, steps, old, ddl))
    }
  }
  for (const [k, ddl] of sorted(target.types)) {
    if (!source.types.has(k)) out.push(change('type', 'Types', dotted(k), 'removed', true, [step(P_DROP_OTHER, go(`DROP TYPE IF EXISTS ${qk(k)};`))], ddl, null))
  }

  for (const [k, s] of sorted(source.sequences)) {
    const old = target.sequences.get(k)
    if (!old) out.push(change('sequence', 'Sequences', dotted(k), 'added', false, [step(P_TYPES, sequenceDdl(k, s))], null, sequenceDdl(k, s)))
    else if (!same(old, s)) {
      const steps: Step[] = []
      if (old.data_type !== s.data_type) steps.push(step(P_TYPES, `-- ${qk(k)}: a sequence's type cannot be altered; drop and recreate it by hand.`))
      steps.push(step(P_TYPES, go(`ALTER SEQUENCE ${qk(k)} ${sequenceClauses(s)};`)))
      out.push(change('sequence', 'Sequences', dotted(k), 'changed', old.data_type !== s.data_type, steps, sequenceDdl(k, old), sequenceDdl(k, s)))
    }
  }
  for (const [k, s] of sorted(target.sequences)) {
    if (!source.sequences.has(k)) out.push(change('sequence', 'Sequences', dotted(k), 'removed', true, [step(P_DROP_OTHER, go(`DROP SEQUENCE IF EXISTS ${qk(k)};`))], sequenceDdl(k, s), null))
  }

  for (const [k, nw] of sorted(source.tables)) {
    const t = qk(k)
    const old = target.tables.get(k)
    const steps: Step[] = []
    let destructive = false
    if (!old) steps.push(step(P_TABLES, createTable(t, nw)))
    else {
      for (const c of nw.columns) {
        const o = old.columns.find((o) => o.name === c.name)
        if (!o) steps.push(step(P_TABLES, go(`ALTER TABLE ${t} ADD ${colDef(c)};`)))
        else if (!same(o, c)) destructive = alterColumn(t, o, c, steps) || destructive
      }
      for (const o of old.columns) {
        if (nw.columns.some((c) => c.name === o.name)) continue
        destructive = true
        // SQL Server refuses to drop a column that still has a default.
        if (o.default !== null) steps.push(step(P_DROP, dropDefault(t, o)))
        steps.push(step(P_TABLES, go(`ALTER TABLE ${t} DROP COLUMN ${quote(o.name)};`)))
      }
    }
    const oldT: MsTable = old ?? { columns: [], constraints: [], indexes: new Map() }
    // SQL Server refuses ALTER COLUMN while an index or key uses the column: those are dropped
    // before and recreated after.
    const retyped = nw.columns
      .filter((c) =>
        oldT.columns.some((o) => o.name === c.name && o.computed === null && c.computed === null && o.identity === c.identity && (o.data_type !== c.data_type || o.not_null !== c.not_null)),
      )
      .map((c) => quote(c.name))
    const rebuild = (def: string) => retyped.some((c) => def.includes(c))
    const sameCon = (a: MsConstraint, b: MsConstraint) => constraintKey(a) === constraintKey(b) && a.def === b.def && !rebuild(a.def)
    for (const o of oldT.constraints) {
      // Foreign keys go first: a key they point at cannot be dropped before them.
      if (!nw.constraints.some((c) => sameCon(c, o))) steps.push(step(P_DROP, dropConstraint(t, o), o.kind === 'F' ? 0 : 1))
    }
    for (const c of nw.constraints) if (!oldT.constraints.some((o) => sameCon(o, c))) steps.push(step(c.kind === 'F' ? P_FKS : P_KEYS, addConstraint(t, c)))
    for (const [iname, odef] of sorted(oldT.indexes)) if (nw.indexes.get(iname) !== odef || rebuild(odef)) steps.push(step(P_DROP, go(`DROP INDEX ${quote(iname)} ON ${t};`)))
    for (const [iname, def] of sorted(nw.indexes)) if (oldT.indexes.get(iname) !== def || rebuild(def)) steps.push(step(P_KEYS, go(`${def};`)))
    if (steps.length) out.push(change('table', 'Tables', dotted(k), old ? 'changed' : 'added', destructive, steps, old ? tableDdl(k, old) : null, tableDdl(k, nw)))
  }
  for (const [k, old] of sorted(target.tables)) {
    if (source.tables.has(k)) continue
    const t = qk(k)
    // Its own foreign keys go first, so tables dropped together drop in any order.
    const steps = [step(P_DROP_TABLES, go(`DROP TABLE IF EXISTS ${t};`))]
    for (const c of old.constraints) if (c.kind === 'F') steps.push(step(P_DROP, dropConstraint(t, c)))
    out.push(change('table', 'Tables', dotted(k), 'removed', true, steps, tableDdl(k, old), null))
  }

  for (const [k, md] of sorted(source.modules)) {
    const prefix = md.kind
    const at = modulePhase(md)
    const old = target.modules.get(k)
    if (!old) out.push(change(prefix, group[md.kind], dotted(k), 'added', false, [{ ...at, sql: go(md.def) }], null, md.def))
    else if (old.def === md.def && old.kind === md.kind) {
      // unchanged
    } else if (old.kind !== md.kind) {
      const steps = [step(P_DROP, go(`DROP ${word[old.kind]} IF EXISTS ${qk(k)};`)), { ...at, sql: go(md.def) }]
      out.push(change(prefix, group[md.kind], dotted(k), 'changed', false, steps, old.def, md.def))
    } else {
      out.push(change(prefix, group[md.kind], dotted(k), 'changed', false, [{ ...at, sql: go(createOrAlter(md.def)) }], old.def, md.def))
    }
  }
  for (const [k, md] of sorted(target.modules)) {
    if (source.modules.has(k)) continue
    // Dropping a table drops its triggers.
    if (md.parent && !source.tables.has(md.parent)) continue
    const steps = [step(md.kind === 'function' ? P_DROP_OTHER : P_DROP, go(`DROP ${word[md.kind]} IF EXISTS ${qk(k)};`))]
    out.push(change(md.kind, group[md.kind], dotted(k), 'removed', false, steps, md.def, null))
  }
  return out
}

/** True when the change may lose data. */
function alterColumn(t: string, o: MsColumn, c: MsColumn, steps: Step[]): boolean {
  const col = quote(c.name)
  if (o.identity !== c.identity || o.computed !== null || c.computed !== null) {
    if (o.computed !== null && c.computed !== null) {
      // A computed column is replaced: drop and add.
      steps.push(step(P_TABLES, go(`ALTER TABLE ${t} DROP COLUMN ${col};`)), step(P_TABLES, go(`ALTER TABLE ${t} ADD ${colDef(c)};`)))
      return false
    }
    steps.push(step(P_TABLES, `-- ${t}.${col}: identity or computed-column changes need a new column and a copy; write this change by hand.`))
    return true
  }
  let destructive = false
  if (o.data_type !== c.data_type || o.not_null !== c.not_null) {
    destructive = o.data_type !== c.data_type
    steps.push(step(P_TABLES, go(`ALTER TABLE ${t} ALTER COLUMN ${col} ${c.data_type} ${c.not_null ? 'NOT NULL' : 'NULL'};`)))
  }
  if (o.default !== c.default || o.default_name !== c.default_name) {
    if (o.default !== null) steps.push(step(P_DROP, dropDefault(t, o)))
    const add = addDefault(t, c)
    if (add) steps.push(step(P_KEYS, add))
  }
  return destructive
}

/** The schema model: one file per object. */
export function files(m: MsModel): Map<string, string> {
  const f = (s: string) => s.replace(/[/\\:*?"<>|]/g, '_')
  const out = new Map<string, string>()
  const put = (p: string, body: string) => {
    // Only possible when a schema or object name has a dot in it (a.b + c and a + b.c).
    if (out.has(p)) throw configError(`two objects would share the schema-model file ${p}; rename one of them`)
    out.set(p, `${body.trimEnd()}\n`)
  }
  // <type>/<schema>.<name>.sql: the same name in two schemas gets two files, and the name alone says which.
  const at = (type: string, k: string) => `${type}/${f(unkey(k)[0])}.${f(unkey(k)[1])}.sql`
  for (const [k, t] of sorted(m.tables)) put(at('tables', k), tableDdl(k, t))
  const dir: Record<ModuleKind, string> = { view: 'views', procedure: 'procedures', function: 'functions', trigger: 'triggers' }
  for (const [k, md] of sorted(m.modules)) put(at(dir[md.kind], k), go(md.def))
  for (const [k, s] of sorted(m.sequences)) put(at('sequences', k), sequenceDdl(k, s))
  for (const [k, ddl] of sorted(m.types)) put(at('types', k), go(ddl))
  return out
}
