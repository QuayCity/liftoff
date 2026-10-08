// PostgreSQL schema diff (C11): reads a database's schema from the catalog and turns differences
// into steps (changes.ts).
// Objects: extensions, tables (columns, identity, serial, defaults, partitioning), constraints (pk,
// unique, check, exclusion, foreign key), indexes, views and materialized views, functions and
// procedures, triggers, enum types, domains, standalone sequences, grants and comments.
// Anything else in the managed schemas is counted and reported as "not compared", never silently
// skipped (row-level security, rules, composite and range types, aggregates, operators, foreign
// tables, column privileges). No rename detection.

import { compares, type Project } from './config.ts'
import {
  P_DROP,
  P_DROP_OTHER,
  P_DROP_TABLES,
  P_FKS,
  P_FUNCS,
  P_GRANTS,
  P_KEYS,
  P_TABLES,
  P_TRIGGERS,
  P_TYPES,
  P_VIEWS,
  byPhase,
  change,
  joined,
  key,
  sorted,
  step,
  unkey,
  withUndo,
  type Change,
  type Step,
} from './changes.ts'
import type { PgConn } from './postgres.ts'
import { quoteIdent as q } from './postgres.ts'

export type Column = {
  name: string
  data_type: string
  not_null: boolean
  default: string | null
  /** "always" | "by default" */
  identity: string | null
}

export type Constraint = {
  name: string
  /** pg_get_constraintdef, e.g. `PRIMARY KEY (id)` */
  def: string
  foreign: boolean
}

export type Table = {
  columns: Column[]
  constraints: Constraint[]
  /** index name -> pg_get_indexdef (indexes behind a constraint are left out) */
  indexes: Map<string, string>
  /** a partitioned parent: `RANGE (created_at)` */
  partition_by: string | null
  /** a partition: its parent's key and the bound, `FOR VALUES FROM ('2026-01-01') TO ('2027-01-01')` */
  partition_of: [string, string] | null
}

export type View = {
  /** creation order in the source database; views are created in this order */
  oid: number
  def: string
  materialized: boolean
  /** materialized views only: index name -> definition */
  indexes: Map<string, string>
}

export type Domain = { base: string; default: string | null; not_null: boolean; checks: Map<string, string> }

/** One privilege: `GRANT privilege ON object TO grantee [WITH GRANT OPTION]`. */
export type Grant = { object: string; grantee: string; privilege: string; grantable: boolean }

export type Func = {
  name: string
  /** identity arguments, e.g. `amount numeric, rate numeric` */
  args: string
  procedure: boolean
  /** pg_get_functiondef: a complete CREATE OR REPLACE statement */
  def: string
}

export type Sequence = { data_type: string; start: string; increment: string; min: string; max: string; cache: string; cycle: boolean }

/** Keys are `key(schema, name)`; triggers use `key(schema, table, trigger)`; functions `key(schema, "name(args)")`. */
export type Model = {
  tables: Map<string, Table>
  views: Map<string, View>
  functions: Map<string, Func>
  enums: Map<string, string[]>
  sequences: Map<string, Sequence>
  /** (view, relation it reads from): views on tables and on other views */
  view_deps: [string, string][]
  /** extension name -> schema */
  extensions: Map<string, string>
  domains: Map<string, Domain>
  triggers: Map<string, string>
  grants: Grant[]
  /** `TABLE public.orders`, `COLUMN public.orders.note`, … -> comment text */
  comments: Map<string, string>
  /** every object that can carry a grant or comment, named the same way */
  objects: Set<string>
  /** what exists but is not compared: (what, how many) */
  not_compared: [string, number][]
}

export function emptyModel(): Model {
  return {
    tables: new Map(),
    views: new Map(),
    functions: new Map(),
    enums: new Map(),
    sequences: new Map(),
    view_deps: [],
    extensions: new Map(),
    domains: new Map(),
    triggers: new Map(),
    grants: [],
    comments: new Map(),
    objects: new Set(),
    not_compared: [],
  }
}

/* ---------- reading the schema ---------- */

const notExt = (oid: string) => `not exists (select 1 from pg_depend e where e.objid = ${oid} and e.deptype = 'e')`

/**
 * Reads the schema in one read-only transaction: a consistent snapshot, and `SET LOCAL` keeps the
 * search_path change from leaking to anyone else on a pooled connection.
 */
export async function introspect(c: PgConn, schemas: string[], excludeTable: string): Promise<Model> {
  await c.batch('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY; SET LOCAL search_path TO pg_catalog')
  try {
    const m = await read(c, schemas, excludeTable)
    await c.batch('COMMIT')
    return m
  } catch (e) {
    await c.batch('ROLLBACK').catch(() => {})
    throw e
  }
}

async function read(c: PgConn, schemas: string[], excludeTable: string): Promise<Model> {
  const m = emptyModel()
  const p = [schemas, excludeTable]
  const p1 = [schemas]
  const s = (v: unknown) => v as string
  const ns = (v: unknown) => (v ?? null) as string | null

  for (const r of await c.rows(
    `select n.nspname::text, c.relname::text, a.attname::text, format_type(a.atttypid, a.atttypmod),
            a.attnotnull, pg_get_expr(d.adbin, d.adrelid), a.attidentity::text,
            case when c.relkind = 'p' then pg_get_partkeydef(c.oid) end,
            pn.nspname::text, pc.relname::text, pg_get_expr(c.relpartbound, c.oid),
            a.attislocal
     from pg_class c
     join pg_namespace n on n.oid = c.relnamespace
     left join pg_attribute a on a.attrelid = c.oid and a.attnum > 0 and not a.attisdropped
     left join pg_attrdef d on d.adrelid = c.oid and d.adnum = a.attnum
     left join pg_inherits i on i.inhrelid = c.oid and c.relispartition
     left join pg_class pc on pc.oid = i.inhparent
     left join pg_namespace pn on pn.oid = pc.relnamespace
     where c.relkind in ('r', 'p') and n.nspname = any($1) and c.relname <> $2 and ${notExt('c.oid')}
     order by 1, 2, a.attnum`,
    p,
  )) {
    const k = key(s(r[0]), s(r[1]))
    let t = m.tables.get(k)
    if (!t) m.tables.set(k, (t = { columns: [], constraints: [], indexes: new Map(), partition_by: null, partition_of: null }))
    t.partition_by = ns(r[7])
    if (r[8] && r[9] && r[10]) t.partition_of = [key(s(r[8]), s(r[9])), s(r[10])]
    if (r[2] === null) continue
    // A partition's inherited columns come from its parent.
    if (t.partition_of && r[11] === false) continue
    const identity = r[6] === 'a' ? 'always' : r[6] === 'd' ? 'by default' : null
    t.columns.push(normalizeSerial({ name: s(r[2]), data_type: s(r[3]), not_null: r[4] as boolean, default: ns(r[5]), identity }))
  }

  for (const r of await c.rows(
    `select n.nspname::text, c.relname::text, con.conname::text, pg_get_constraintdef(con.oid, true), con.contype = 'f'
     from pg_constraint con
     join pg_class c on c.oid = con.conrelid
     join pg_namespace n on n.oid = c.relnamespace
     where con.contype in ('p', 'u', 'c', 'f', 'x') and con.conislocal
       and c.relkind in ('r', 'p') and n.nspname = any($1) and c.relname <> $2
     order by 1, 2, 3`,
    p,
  )) {
    m.tables.get(key(s(r[0]), s(r[1])))?.constraints.push({ name: s(r[2]), def: s(r[3]), foreign: r[4] as boolean })
  }

  const viewIndexes: [string, string, string][] = []
  for (const r of await c.rows(
    `select n.nspname::text, t.relname::text, i.relname::text, pg_get_indexdef(x.indexrelid)
     from pg_index x
     join pg_class i on i.oid = x.indexrelid
     join pg_class t on t.oid = x.indrelid
     join pg_namespace n on n.oid = t.relnamespace
     where t.relkind in ('r', 'p', 'm') and n.nspname = any($1) and t.relname <> $2
       and not i.relispartition
       and not exists (select 1 from pg_constraint con
                       where con.conindid = x.indexrelid and con.conrelid = x.indrelid and con.contype in ('p', 'u', 'x'))
     order by 1, 2, 3`,
    p,
  )) {
    const k = key(s(r[0]), s(r[1]))
    const t = m.tables.get(k)
    if (t) t.indexes.set(s(r[2]), s(r[3]))
    else viewIndexes.push([k, s(r[2]), s(r[3])])
  }

  for (const r of await c.rows(
    `select n.nspname::text, c.relname::text, c.oid::oid, pg_get_viewdef(c.oid, true), c.relkind = 'm'
     from pg_class c join pg_namespace n on n.oid = c.relnamespace
     where c.relkind in ('v', 'm') and n.nspname = any($1) and ${notExt('c.oid')}`,
    p1,
  )) {
    m.views.set(key(s(r[0]), s(r[1])), { oid: Number(r[2]), def: s(r[3]).trimEnd().replace(/;+$/, ''), materialized: r[4] as boolean, indexes: new Map() })
  }
  for (const [k, name, def] of viewIndexes) m.views.get(k)?.indexes.set(name, def)

  for (const r of await c.rows(
    `select distinct vn.nspname::text, v.relname::text, sn.nspname::text, s.relname::text
     from pg_depend d
     join pg_rewrite r on r.oid = d.objid
     join pg_class v on v.oid = r.ev_class
     join pg_namespace vn on vn.oid = v.relnamespace
     join pg_class s on s.oid = d.refobjid
     join pg_namespace sn on sn.oid = s.relnamespace
     where d.classid = 'pg_rewrite'::regclass and d.refclassid = 'pg_class'::regclass
       and v.oid <> s.oid and v.relkind in ('v', 'm') and vn.nspname = any($1)`,
    p1,
  )) {
    m.view_deps.push([key(s(r[0]), s(r[1])), key(s(r[2]), s(r[3]))])
  }

  for (const r of await c.rows(
    `select n.nspname::text, p.proname::text, pg_get_function_identity_arguments(p.oid), p.prokind = 'p', pg_get_functiondef(p.oid)
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where p.prokind in ('f', 'p') and n.nspname = any($1) and ${notExt('p.oid')}`,
    p1,
  )) {
    const [name, args] = [s(r[1]), s(r[2])]
    m.functions.set(key(s(r[0]), `${name}(${args})`), { name, args, procedure: r[3] as boolean, def: `${s(r[4]).trimEnd()};` })
  }

  for (const r of await c.rows(
    `select n.nspname::text, t.typname::text, array_agg(e.enumlabel::text order by e.enumsortorder)
     from pg_type t join pg_enum e on e.enumtypid = t.oid join pg_namespace n on n.oid = t.typnamespace
     where n.nspname = any($1) and ${notExt('t.oid')}
     group by 1, 2`,
    p1,
  )) {
    m.enums.set(key(s(r[0]), s(r[1])), r[2] as string[])
  }

  // Standalone sequences only: serial (deptype a) and identity (i) sequences come with their column.
  for (const r of await c.rows(
    `select n.nspname::text, c.relname::text, format_type(s.seqtypid, null), s.seqstart, s.seqincrement, s.seqmin, s.seqmax, s.seqcache, s.seqcycle
     from pg_sequence s join pg_class c on c.oid = s.seqrelid join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = any($1) and ${notExt('c.oid')}
       and not exists (select 1 from pg_depend d where d.objid = c.oid and d.deptype in ('a', 'i'))`,
    p1,
  )) {
    m.sequences.set(key(s(r[0]), s(r[1])), {
      data_type: s(r[2]),
      start: String(r[3]),
      increment: String(r[4]),
      min: String(r[5]),
      max: String(r[6]),
      cache: String(r[7]),
      cycle: r[8] as boolean,
    })
  }

  for (const r of await c.rows(
    `select e.extname::text, n.nspname::text from pg_extension e join pg_namespace n on n.oid = e.extnamespace
     where e.extname <> 'plpgsql' and n.nspname = any($1)`,
    p1,
  )) {
    m.extensions.set(s(r[0]), s(r[1]))
  }

  for (const r of await c.rows(
    `select n.nspname::text, t.typname::text, format_type(t.typbasetype, t.typtypmod), t.typdefault, t.typnotnull
     from pg_type t join pg_namespace n on n.oid = t.typnamespace
     where t.typtype = 'd' and n.nspname = any($1) and ${notExt('t.oid')}`,
    p1,
  )) {
    m.domains.set(key(s(r[0]), s(r[1])), { base: s(r[2]), default: ns(r[3]), not_null: r[4] as boolean, checks: new Map() })
  }
  for (const r of await c.rows(
    `select n.nspname::text, t.typname::text, con.conname::text, pg_get_constraintdef(con.oid, true)
     from pg_constraint con join pg_type t on t.oid = con.contypid join pg_namespace n on n.oid = t.typnamespace
     where con.contype = 'c' and n.nspname = any($1)`,
    p1,
  )) {
    m.domains.get(key(s(r[0]), s(r[1])))?.checks.set(s(r[2]), s(r[3]))
  }

  // Triggers a partition inherits from its parent are created with the parent's.
  for (const r of await c.rows(
    `select n.nspname::text, c.relname::text, t.tgname::text, pg_get_triggerdef(t.oid, true)
     from pg_trigger t join pg_class c on c.oid = t.tgrelid join pg_namespace n on n.oid = c.relnamespace
     where not t.tgisinternal and t.tgparentid = 0 and n.nspname = any($1) and c.relname <> $2`,
    p,
  )) {
    m.triggers.set(key(s(r[0]), s(r[1]), s(r[2])), `${s(r[3])};`)
  }

  // Grants: an owner's own privileges are implied, so they are left out.
  for (const r of await c.rows(
    `select case c.relkind when 'S' then 'SEQUENCE ' else 'TABLE ' end || quote_ident(n.nspname) || '.' || quote_ident(c.relname),
            case when a.grantee = 0 then 'PUBLIC' else a.grantee::regrole::text end, a.privilege_type::text, a.is_grantable
     from pg_class c join pg_namespace n on n.oid = c.relnamespace, aclexplode(c.relacl) a
     where c.relkind in ('r', 'p', 'v', 'm', 'S') and n.nspname = any($1) and c.relname <> $2 and a.grantee <> c.relowner and ${notExt('c.oid')}
     union all
     select case p.prokind when 'p' then 'PROCEDURE ' else 'FUNCTION ' end || quote_ident(n.nspname) || '.' || quote_ident(p.proname)
              || '(' || pg_get_function_identity_arguments(p.oid) || ')',
            case when a.grantee = 0 then 'PUBLIC' else a.grantee::regrole::text end, a.privilege_type::text, a.is_grantable
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace, aclexplode(p.proacl) a
     where p.prokind in ('f', 'p') and n.nspname = any($1) and a.grantee <> p.proowner and ${notExt('p.oid')}`,
    p,
  )) {
    m.grants.push({ object: s(r[0]), grantee: s(r[1]), privilege: s(r[2]), grantable: r[3] as boolean })
  }
  m.grants = uniqueGrants(m.grants)

  // Every object that can carry a comment, named the way COMMENT ON names it, with its comment.
  for (const r of await c.rows(
    `select case c.relkind when 'v' then 'VIEW ' when 'm' then 'MATERIALIZED VIEW ' when 'S' then 'SEQUENCE ' else 'TABLE ' end
              || quote_ident(n.nspname) || '.' || quote_ident(c.relname), obj_description(c.oid, 'pg_class')
     from pg_class c join pg_namespace n on n.oid = c.relnamespace
     where c.relkind in ('r', 'p', 'v', 'm', 'S') and n.nspname = any($1) and c.relname <> $2 and ${notExt('c.oid')}
     union all
     select 'COLUMN ' || quote_ident(n.nspname) || '.' || quote_ident(c.relname) || '.' || quote_ident(a.attname), col_description(c.oid, a.attnum)
     from pg_class c join pg_namespace n on n.oid = c.relnamespace join pg_attribute a on a.attrelid = c.oid and a.attnum > 0 and not a.attisdropped
     where c.relkind in ('r', 'p', 'v', 'm') and n.nspname = any($1) and c.relname <> $2 and ${notExt('c.oid')}
     union all
     select case p.prokind when 'p' then 'PROCEDURE ' else 'FUNCTION ' end || quote_ident(n.nspname) || '.' || quote_ident(p.proname)
              || '(' || pg_get_function_identity_arguments(p.oid) || ')', obj_description(p.oid, 'pg_proc')
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where p.prokind in ('f', 'p') and n.nspname = any($1) and ${notExt('p.oid')}
     union all
     select case t.typtype when 'd' then 'DOMAIN ' else 'TYPE ' end || quote_ident(n.nspname) || '.' || quote_ident(t.typname), obj_description(t.oid, 'pg_type')
     from pg_type t join pg_namespace n on n.oid = t.typnamespace
     where t.typtype in ('e', 'd') and n.nspname = any($1) and ${notExt('t.oid')}`,
    p,
  )) {
    if (r[1] !== null) m.comments.set(s(r[0]), s(r[1]))
    m.objects.add(s(r[0]))
  }

  for (const r of await c.rows(
    `select 'row-level security policies', count(*) from pg_policy p join pg_class c on c.oid = p.polrelid
       join pg_namespace n on n.oid = c.relnamespace where n.nspname = any($1)
     union all select 'tables with row-level security on', count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace
       where c.relrowsecurity and n.nspname = any($1)
     union all select 'rules', count(*) from pg_rewrite r join pg_class c on c.oid = r.ev_class
       join pg_namespace n on n.oid = c.relnamespace where r.rulename <> '_RETURN' and n.nspname = any($1)
     union all select 'composite types', count(*) from pg_type t join pg_class c on c.oid = t.typrelid
       join pg_namespace n on n.oid = t.typnamespace where t.typtype = 'c' and c.relkind = 'c' and n.nspname = any($1) and ${notExt('t.oid')}
     union all select 'range types', count(*) from pg_type t join pg_namespace n on n.oid = t.typnamespace
       where t.typtype = 'r' and n.nspname = any($1) and ${notExt('t.oid')}
     union all select 'aggregates', count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where p.prokind = 'a' and n.nspname = any($1) and ${notExt('p.oid')}
     union all select 'operators', count(*) from pg_operator o join pg_namespace n on n.oid = o.oprnamespace
       where n.nspname = any($1) and ${notExt('o.oid')}
     union all select 'foreign tables', count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace
       where c.relkind = 'f' and n.nspname = any($1)
     union all select 'column-level privileges', count(*) from pg_attribute a join pg_class c on c.oid = a.attrelid
       join pg_namespace n on n.oid = c.relnamespace where a.attacl is not null and n.nspname = any($1)`,
    p1,
  )) {
    const n = Number(r[1])
    if (n > 0) m.not_compared.push([s(r[0]), n])
  }
  return m
}

/**
 * `integer DEFAULT nextval('t_id_seq'::regclass)` -> `serial`, so the owned sequence comes along.
 * ponytail: assumes the sequence is the column's own; standalone sequences are diffed separately.
 */
function normalizeSerial(c: Column): Column {
  const serial: Record<string, string> = { integer: 'serial', bigint: 'bigserial', smallint: 'smallserial' }
  if (c.default?.startsWith('nextval(') && serial[c.data_type]) return { ...c, data_type: serial[c.data_type], default: null }
  return c
}

const grantKey = (g: Grant) => [g.object, g.grantee, g.privilege, g.grantable ? '1' : '0'].join('\u0001')

/** Sorted and without duplicates, like the Rust BTreeSet. */
function uniqueGrants(gs: Grant[]): Grant[] {
  const m = new Map(gs.map((g) => [grantKey(g), g]))
  return sorted(m).map(([, g]) => g)
}

/** What either side has that the diff does not look at, for a visible warning. */
export function notCompared(source: [string, number][], target: [string, number][], sourceName: string, targetName: string): string[] {
  const what = new Map<string, [number, number]>()
  for (const [w, n] of source) what.set(w, [n, what.get(w)?.[1] ?? 0])
  for (const [w, n] of target) what.set(w, [what.get(w)?.[0] ?? 0, n])
  return sorted(what).map(([w, [a, b]]) => `${w}: ${a} in ${sourceName}, ${b} in ${targetName}`)
}

/* ---------- DDL text ---------- */

export const qk = (k: string) => unkey(k).slice(0, 2).map(q).join('.')
const lit = (s: string) => `'${s.replaceAll("'", "''")}'`
const dotted = (k: string) => unkey(k).join('.')

function colDef(c: Column): string {
  let s = `${q(c.name)} ${c.data_type}`
  if (c.identity) s += ` GENERATED ${c.identity.toUpperCase()} AS IDENTITY`
  if (c.default !== null) s += ` DEFAULT ${c.default}`
  if (c.not_null && !c.data_type.endsWith('serial') && !c.identity) s += ' NOT NULL'
  return s
}

function createTable(t: string, tb: Table): string {
  if (tb.partition_of) return `CREATE TABLE ${t} PARTITION OF ${qk(tb.partition_of[0])} ${tb.partition_of[1]};`
  const body = tb.columns.map((c) => `    ${colDef(c)}`).join(',\n')
  return tb.partition_by ? `CREATE TABLE ${t} (\n${body}\n) PARTITION BY ${tb.partition_by};` : `CREATE TABLE ${t} (\n${body}\n);`
}

const addConstraint = (t: string, c: Constraint): Step => step(c.foreign ? P_FKS : P_KEYS, `ALTER TABLE ${t} ADD CONSTRAINT ${q(c.name)} ${c.def};`)

/** The whole table as one readable block, for the side-by-side view and the schema model. */
export function tableDdl(k: string, tb: Table): string {
  const t = qk(k)
  return [createTable(t, tb), ...tb.constraints.map((c) => addConstraint(t, c).sql), ...[...tb.indexes.values()].map((d) => `${d};`)].join('\n')
}

export function viewDdl(k: string, v: View): string {
  let s = `CREATE ${v.materialized ? 'MATERIALIZED ' : ''}VIEW ${qk(k)} AS\n${v.def};`
  for (const d of v.indexes.values()) s += `\n${d};`
  return s
}

const viewDrop = (k: string, v: View) => `DROP ${v.materialized ? 'MATERIALIZED ' : ''}VIEW IF EXISTS ${qk(k)} CASCADE;`

export function domainDdl(k: string, d: Domain): string {
  let s = `CREATE DOMAIN ${qk(k)} AS ${d.base}`
  if (d.default !== null) s += ` DEFAULT ${d.default}`
  if (d.not_null) s += ' NOT NULL'
  for (const [name, check] of sorted(d.checks)) s += ` CONSTRAINT ${q(name)} ${check}`
  return `${s};`
}

export const grantSql = (g: Grant, revoke: boolean) =>
  revoke ? `REVOKE ${g.privilege} ON ${g.object} FROM ${g.grantee};` : `GRANT ${g.privilege} ON ${g.object} TO ${g.grantee}${g.grantable ? ' WITH GRANT OPTION' : ''};`

export const commentSql = (object: string, text: string | undefined) => (text === undefined ? `COMMENT ON ${object} IS NULL;` : `COMMENT ON ${object} IS ${lit(text)};`)

/** Grants name views `TABLE x`; comments use `VIEW x`. The same object either way. */
function objectExists(m: Model, object: string): boolean {
  if (m.objects.has(object)) return true
  const rest = object.startsWith('TABLE ') ? object.slice(6) : undefined
  return rest !== undefined && (m.objects.has(`VIEW ${rest}`) || m.objects.has(`MATERIALIZED VIEW ${rest}`))
}

export const enumDdl = (k: string, labels: string[]) => `CREATE TYPE ${qk(k)} AS ENUM (${labels.map(lit).join(', ')});`

const sequenceClauses = (s: Sequence) => `AS ${s.data_type} INCREMENT BY ${s.increment} MINVALUE ${s.min} MAXVALUE ${s.max} CACHE ${s.cache} ${s.cycle ? 'CYCLE' : 'NO CYCLE'}`

export const sequenceDdl = (k: string, s: Sequence) => `CREATE SEQUENCE ${qk(k)} ${sequenceClauses(s)} START WITH ${s.start};`

const functionDrop = (k: string, f: Func) => `DROP ${f.procedure ? 'PROCEDURE' : 'FUNCTION'} ${q(unkey(k)[0])}.${q(f.name)}(${f.args});`

const extensionDdl = (name: string, schema: string) => `CREATE EXTENSION IF NOT EXISTS ${q(name)} WITH SCHEMA ${q(schema)};`

const sameMap = <V>(a: Map<string, V>, b: Map<string, V>, eq: (x: V, y: V) => boolean = (x, y) => x === y) =>
  a.size === b.size && [...a].every(([k, v]) => b.has(k) && eq(v, b.get(k)!))

const sameJson = (a: unknown, b: unknown) => JSON.stringify(a, mapsAsArrays) === JSON.stringify(b, mapsAsArrays)
function mapsAsArrays(_k: string, v: unknown) {
  return v instanceof Map ? sorted(v as Map<string, unknown>) : v
}

/* ---------- compare ---------- */

/** Changes that turn `target` (what the migrations build) into `source` (what dev has), each with its undo. */
export function diff(source: Model, target: Model): Change[] {
  return withUndo(compare(source, target), compare(target, source))
}

export function compare(source: Model, target: Model): Change[] {
  const out: Change[] = []
  // Relations whose change breaks the views reading from them: those views are dropped and recreated.
  const broken: [number, string][] = []

  for (const [name, schema] of sorted(source.extensions)) {
    const ddl = extensionDdl(name, schema)
    const old = target.extensions.get(name)
    if (old === undefined) out.push(change('extension', 'Extensions', name, 'added', false, [step(P_TYPES, ddl)], null, ddl))
    else if (old !== schema) out.push(change('extension', 'Extensions', name, 'changed', false, [step(P_TYPES, `ALTER EXTENSION ${q(name)} SET SCHEMA ${q(schema)};`)], null, ddl))
  }
  for (const [name, schema] of sorted(target.extensions)) {
    if (source.extensions.has(name)) continue
    out.push(change('extension', 'Extensions', name, 'removed', true, [step(P_DROP_OTHER, `DROP EXTENSION IF EXISTS ${q(name)};`)], extensionDdl(name, schema), null))
  }

  for (const [k, d] of sorted(source.domains)) {
    const dk = qk(k)
    const old = target.domains.get(k)
    if (!old) {
      out.push(change('domain', 'Domains', dotted(k), 'added', false, [step(P_TYPES, domainDdl(k, d))], null, domainDdl(k, d)))
      continue
    }
    if (sameJson(old, d)) continue
    const steps: Step[] = []
    let destructive = false
    if (old.base !== d.base) {
      destructive = true
      steps.push(step(P_TYPES, `-- ${dk}: changing a domain's base type cannot be done in place; write it by hand.`))
    }
    if (old.default !== d.default) steps.push(step(P_TYPES, d.default !== null ? `ALTER DOMAIN ${dk} SET DEFAULT ${d.default};` : `ALTER DOMAIN ${dk} DROP DEFAULT;`))
    if (old.not_null !== d.not_null) steps.push(step(P_TYPES, `ALTER DOMAIN ${dk} ${d.not_null ? 'SET' : 'DROP'} NOT NULL;`))
    for (const [cname, check] of sorted(old.checks)) if (d.checks.get(cname) !== check) steps.push(step(P_TYPES, `ALTER DOMAIN ${dk} DROP CONSTRAINT ${q(cname)};`))
    for (const [cname, check] of sorted(d.checks)) if (old.checks.get(cname) !== check) steps.push(step(P_TYPES, `ALTER DOMAIN ${dk} ADD CONSTRAINT ${q(cname)} ${check};`))
    out.push(change('domain', 'Domains', dotted(k), 'changed', destructive, steps, domainDdl(k, old), domainDdl(k, d)))
  }
  for (const [k, d] of sorted(target.domains)) {
    if (!source.domains.has(k)) out.push(change('domain', 'Domains', dotted(k), 'removed', true, [step(P_DROP_OTHER, `DROP DOMAIN ${qk(k)};`)], domainDdl(k, d), null))
  }

  for (const [k, labels] of sorted(source.enums)) {
    const old = target.enums.get(k)
    if (!old) {
      out.push(change('type', 'Types', dotted(k), 'added', false, [step(P_TYPES, enumDdl(k, labels))], null, enumDdl(k, labels)))
      continue
    }
    if (old.join('\u0000') === labels.join('\u0000')) continue
    const steps: Step[] = []
    let destructive = false
    const keptOld = old.filter((l) => labels.includes(l))
    const keptNew = labels.filter((l) => old.includes(l))
    if (old.some((l) => !labels.includes(l)) || keptOld.join('\u0000') !== keptNew.join('\u0000')) {
      destructive = true
      steps.push(step(P_TYPES, `-- ${qk(k)}: removing or reordering enum values cannot be done automatically; write it by hand.`))
    }
    labels.forEach((l, i) => {
      if (old.includes(l)) return
      const pos = i === 0 ? (labels[1] !== undefined ? ` BEFORE ${lit(labels[1])}` : '') : ` AFTER ${lit(labels[i - 1])}`
      steps.push(step(P_TYPES, `ALTER TYPE ${qk(k)} ADD VALUE IF NOT EXISTS ${lit(l)}${pos};`))
    })
    out.push(change('type', 'Types', dotted(k), 'changed', destructive, steps, enumDdl(k, old), enumDdl(k, labels)))
  }
  for (const [k, labels] of sorted(target.enums)) {
    if (!source.enums.has(k)) out.push(change('type', 'Types', dotted(k), 'removed', true, [step(P_DROP_OTHER, `DROP TYPE ${qk(k)};`)], enumDdl(k, labels), null))
  }

  for (const [k, s] of sorted(source.sequences)) {
    const old = target.sequences.get(k)
    if (!old) out.push(change('sequence', 'Sequences', dotted(k), 'added', false, [step(P_TYPES, sequenceDdl(k, s))], null, sequenceDdl(k, s)))
    else if (!sameJson(old, s)) {
      out.push(change('sequence', 'Sequences', dotted(k), 'changed', false, [step(P_TYPES, `ALTER SEQUENCE ${qk(k)} ${sequenceClauses(s)};`)], sequenceDdl(k, old), sequenceDdl(k, s)))
    }
  }
  for (const [k, s] of sorted(target.sequences)) {
    if (!source.sequences.has(k)) out.push(change('sequence', 'Sequences', dotted(k), 'removed', true, [step(P_DROP_OTHER, `DROP SEQUENCE ${qk(k)};`)], sequenceDdl(k, s), null))
  }

  const sameCol = (a: Column, b: Column) => sameJson(a, b)
  const sameCon = (a: Constraint, b: Constraint) => a.name === b.name && a.def === b.def && a.foreign === b.foreign
  for (const [k, nw] of sorted(source.tables)) {
    const t = qk(k)
    const steps: Step[] = []
    let destructive = false
    const old = target.tables.get(k)
    if (!old) {
      // Parents before their partitions.
      steps.push(step(P_TABLES, createTable(t, nw), nw.partition_of ? 1 : 0))
    } else if (old.partition_by !== nw.partition_by || JSON.stringify(old.partition_of) !== JSON.stringify(nw.partition_of)) {
      destructive = true
      steps.push(step(P_TABLES, `-- ${t}: partitioning changed; this needs a hand-written migration (new table, copy, swap).`))
    } else {
      for (const c of nw.columns) {
        const o = old.columns.find((o) => o.name === c.name)
        if (!o) steps.push(step(P_TABLES, `ALTER TABLE ${t} ADD COLUMN ${colDef(c)};`))
        else if (!sameCol(o, c)) destructive = alterColumn(t, o, c, steps) || destructive
      }
      for (const o of old.columns) {
        if (nw.columns.some((c) => c.name === o.name)) continue
        destructive = true
        steps.push(step(P_TABLES, `ALTER TABLE ${t} DROP COLUMN ${q(o.name)};`))
      }
    }
    const oldT = old ?? { columns: [], constraints: [], indexes: new Map<string, string>(), partition_by: null, partition_of: null }
    for (const o of oldT.constraints) {
      const c = nw.constraints.find((c) => c.name === o.name)
      if (!c || !sameCon(c, o)) steps.push(step(P_DROP, `ALTER TABLE ${t} DROP CONSTRAINT ${q(o.name)};`))
    }
    for (const c of nw.constraints) {
      const o = oldT.constraints.find((o) => o.name === c.name)
      if (!o || !sameCon(o, c)) steps.push(addConstraint(t, c))
    }
    for (const [iname, odef] of sorted(oldT.indexes)) if (nw.indexes.get(iname) !== odef) steps.push(step(P_DROP, `DROP INDEX ${q(unkey(k)[0])}.${q(iname)};`))
    for (const [iname, def] of sorted(nw.indexes)) if (oldT.indexes.get(iname) !== def) steps.push(step(P_KEYS, `${def};`))
    if (steps.length) {
      if (destructive) broken.push([out.length, k])
      out.push(change('table', 'Tables', dotted(k), old ? 'changed' : 'added', destructive, steps, old ? tableDdl(k, old) : null, tableDdl(k, nw)))
    }
  }
  for (const [k, old] of sorted(target.tables)) {
    if (source.tables.has(k)) continue
    broken.push([out.length, k])
    // Partitions before their parent (dropping the parent would take them along).
    const steps = [step(P_DROP_TABLES, `DROP TABLE IF EXISTS ${qk(k)};`, old.partition_of ? 0 : 1)]
    out.push(change('table', 'Tables', dotted(k), 'removed', true, steps, tableDdl(k, old), null))
  }

  for (const [k, f] of sorted(source.functions)) {
    const old = target.functions.get(k)
    if (!old) out.push(change('function', 'Functions', dotted(k), 'added', false, [step(P_FUNCS, f.def)], null, f.def))
    // ponytail: CREATE OR REPLACE cannot change the return type; that needs a hand-written drop and create.
    else if (!sameJson(old, f)) out.push(change('function', 'Functions', dotted(k), 'changed', false, [step(P_FUNCS, f.def)], old.def, f.def))
  }
  for (const [k, f] of sorted(target.functions)) {
    if (!source.functions.has(k)) out.push(change('function', 'Functions', dotted(k), 'removed', true, [step(P_DROP_OTHER, functionDrop(k, f))], f.def, null))
  }

  // Recreating a view also recreates what CASCADE took with it: its triggers, grants and comments.
  const viewNames = (k: string) => [`TABLE ${qk(k)}`, `VIEW ${qk(k)}`, `MATERIALIZED VIEW ${qk(k)}`]
  const createView = (k: string): Step[] => {
    const v = source.views.get(k)!
    const steps = [step(P_VIEWS, viewDdl(k, v), v.oid)]
    const [vs, vn] = unkey(k)
    for (const [tk, def] of sorted(source.triggers)) {
      const [s, t] = unkey(tk)
      if (s === vs && t === vn) steps.push(step(P_TRIGGERS, def))
    }
    const names = viewNames(k)
    for (const g of source.grants) if (names.includes(g.object)) steps.push(step(P_GRANTS, grantSql(g, false)))
    for (const [obj, text] of sorted(source.comments)) {
      if (names.includes(obj) || obj.startsWith(`COLUMN ${qk(k)}.`)) steps.push(step(P_GRANTS, commentSql(obj, text)))
    }
    return steps
  }
  const dropView = (k: string, v: View) => step(P_DROP, viewDrop(k, v))
  // Views this diff (re)creates; their triggers, grants and comments travel with them.
  const rebuilt = new Set<string>()
  for (const [k, v] of sorted(source.views)) {
    const old = target.views.get(k)
    if (!old) {
      rebuilt.add(k)
      out.push(change('view', 'Views', dotted(k), 'added', false, createView(k), null, viewDdl(k, v)))
    } else if (old.def === v.def && old.materialized === v.materialized && sameMap(old.indexes, v.indexes)) {
      // unchanged
    } else if (old.def === v.def && old.materialized === v.materialized) {
      // Only a materialized view's indexes changed.
      const steps: Step[] = []
      for (const [iname, odef] of sorted(old.indexes)) if (v.indexes.get(iname) !== odef) steps.push(step(P_DROP, `DROP INDEX ${q(unkey(k)[0])}.${q(iname)};`))
      for (const [iname, def] of sorted(v.indexes)) if (old.indexes.get(iname) !== def) steps.push(step(P_KEYS, `${def};`))
      out.push(change('view', 'Views', dotted(k), 'changed', false, steps, viewDdl(k, old), viewDdl(k, v)))
    } else {
      broken.push([out.length, k])
      rebuilt.add(k)
      out.push(change('view', 'Views', dotted(k), 'changed', false, [dropView(k, old), ...createView(k)], viewDdl(k, old), viewDdl(k, v)))
    }
  }
  for (const [k, v] of sorted(target.views)) {
    if (source.views.has(k)) continue
    broken.push([out.length, k])
    out.push(change('view', 'Views', dotted(k), 'removed', false, [dropView(k, v)], viewDdl(k, v), null))
  }

  // Views reading (directly or through other views) from a changed relation are dropped with
  // CASCADE and recreated by that change, so selecting the change alone gives a working script.
  for (const [i, rel] of broken) {
    const affected = new Set<string>()
    const frontier = [rel]
    while (frontier.length) {
      const r = frontier.pop()!
      for (const [v, src] of target.view_deps) {
        if (src === r && !affected.has(v)) {
          affected.add(v)
          frontier.push(v)
        }
      }
    }
    for (const v of [...affected].sort()) {
      const ownChange = out.some((c) => c.id === `view:${dotted(v)}`)
      if (source.views.has(v) && !ownChange) {
        rebuilt.add(v)
        out[i].steps.push(dropView(v, target.views.get(v)!), ...createView(v))
        out[i].steps.sort(byPhase)
        out[i].sql = joined(out[i].steps)
      }
    }
  }

  for (const [tk, def] of sorted(source.triggers)) {
    const [s, t, name] = unkey(tk)
    // A rebuilt view gets its triggers back with it.
    if (rebuilt.has(key(s, t))) continue
    const label = `${s}.${t}.${name}`
    const old = target.triggers.get(tk)
    if (old === undefined) out.push(change('trigger', 'Triggers', label, 'added', false, [step(P_TRIGGERS, def)], null, def))
    else if (old !== def) {
      const steps = [step(P_DROP, `DROP TRIGGER IF EXISTS ${q(name)} ON ${q(s)}.${q(t)};`), step(P_TRIGGERS, def)]
      out.push(change('trigger', 'Triggers', label, 'changed', false, steps, old, def))
    }
  }
  for (const [tk, def] of sorted(target.triggers)) {
    if (source.triggers.has(tk)) continue
    const [s, t, name] = unkey(tk)
    // Dropping the table or view drops its triggers.
    if (!source.tables.has(key(s, t)) && !source.views.has(key(s, t))) continue
    out.push(change('trigger', 'Triggers', `${s}.${t}.${name}`, 'removed', false, [step(P_DROP, `DROP TRIGGER IF EXISTS ${q(name)} ON ${q(s)}.${q(t)};`)], def, null))
  }

  const isRebuiltView = (object: string) =>
    [...rebuilt].some((k) => viewNames(k).includes(object) || object.startsWith(`COLUMN ${qk(k)}.`))
  const grantObjects = [...new Set([...source.grants, ...target.grants].map((g) => g.object))].sort()
  for (const object of grantObjects) {
    if (isRebuiltView(object)) continue
    const nw = source.grants.filter((g) => g.object === object)
    const old = target.grants.filter((g) => g.object === object)
    const nwKeys = new Set(nw.map(grantKey))
    const oldKeys = new Set(old.map(grantKey))
    if (nwKeys.size === oldKeys.size && [...nwKeys].every((k) => oldKeys.has(k))) continue
    const steps: Step[] = []
    // Revokes only where the object stays; dropping it removes its grants.
    if (objectExists(source, object)) for (const g of old) if (!nwKeys.has(grantKey(g))) steps.push(step(P_GRANTS, grantSql(g, true)))
    for (const g of nw) if (!oldKeys.has(grantKey(g))) steps.push(step(P_GRANTS, grantSql(g, false)))
    if (!steps.length) continue
    const show = (gs: Grant[]) => (gs.length ? gs.map((g) => grantSql(g, false)).join('\n') : null)
    out.push(change('grant', 'Grants', object, 'changed', false, steps, show(old), show(nw)))
  }

  const commentObjects = [...new Set([...source.comments.keys(), ...target.comments.keys()])].sort()
  for (const object of commentObjects) {
    const [nw, old] = [source.comments.get(object), target.comments.get(object)]
    if (nw === old || isRebuiltView(object) || (nw === undefined && !objectExists(source, object))) continue
    const kind = old === undefined ? 'added' : nw === undefined ? 'removed' : 'changed'
    out.push(
      change('comment', 'Comments', object, kind, false, [step(P_GRANTS, commentSql(object, nw))], old === undefined ? null : commentSql(object, old), nw === undefined ? null : commentSql(object, nw)),
    )
  }
  return out
}

/** True when the change may lose data (a type or identity change). */
function alterColumn(t: string, o: Column, c: Column, steps: Step[]): boolean {
  const col = q(c.name)
  const sql: string[] = []
  let destructive = false
  if (o.data_type !== c.data_type || o.identity !== c.identity) {
    destructive = true
    if (o.identity && !c.identity) sql.push(`ALTER TABLE ${t} ALTER COLUMN ${col} DROP IDENTITY;`)
    if (o.data_type !== c.data_type) sql.push(`ALTER TABLE ${t} ALTER COLUMN ${col} TYPE ${c.data_type} USING ${col}::${c.data_type};`)
    if (!o.identity && c.identity) sql.push(`ALTER TABLE ${t} ALTER COLUMN ${col} ADD GENERATED ${c.identity.toUpperCase()} AS IDENTITY;`)
  }
  if (o.default !== c.default) sql.push(c.default !== null ? `ALTER TABLE ${t} ALTER COLUMN ${col} SET DEFAULT ${c.default};` : `ALTER TABLE ${t} ALTER COLUMN ${col} DROP DEFAULT;`)
  if (o.not_null !== c.not_null && !c.identity) sql.push(`ALTER TABLE ${t} ALTER COLUMN ${col} ${c.not_null ? 'SET' : 'DROP'} NOT NULL;`)
  steps.push(...sql.map((s) => step(P_TABLES, s)))
  return destructive
}

/** Removes what the project's comparison filters exclude, with the triggers, grants and comments that belong to it. */
export function applyFilters(m: Model, p: Project): void {
  if (!p.filters.length) return
  const gone: string[] = []
  const keep = <V>(map: Map<string, V>, object: string, names: string[], nameOf: (k: string, v: V) => string = (k) => unkey(k)[1]) => {
    for (const [k, v] of [...map]) {
      if (compares(p, object, unkey(k)[0], nameOf(k, v))) continue
      map.delete(k)
      gone.push(...names.map((w) => `${w} ${qk(k)}`))
    }
  }
  keep(m.tables, 'table', ['TABLE'])
  keep(m.views, 'view', ['TABLE', 'VIEW', 'MATERIALIZED VIEW'])
  keep(m.sequences, 'sequence', ['SEQUENCE'])
  keep(m.enums, 'type', ['TYPE'])
  keep(m.domains, 'type', ['DOMAIN'])
  for (const [k, f] of [...m.functions]) {
    if (compares(p, 'function', unkey(k)[0], f.name)) continue
    m.functions.delete(k)
    gone.push(`${f.procedure ? 'PROCEDURE' : 'FUNCTION'} ${q(unkey(k)[0])}.${q(f.name)}(${f.args})`)
  }
  for (const [name, schema] of [...m.extensions]) if (!compares(p, 'extension', schema, name)) m.extensions.delete(name)
  for (const [tk] of [...m.triggers]) {
    const [s, t, name] = unkey(tk)
    const owner = key(s, t)
    if (!((m.tables.has(owner) || m.views.has(owner)) && compares(p, 'trigger', s, name))) m.triggers.delete(tk)
  }
  const belongs = (object: string) => gone.some((g) => object === g || object.startsWith(`COLUMN ${g.slice(g.indexOf(' ') + 1)}.`))
  m.grants = m.grants.filter((g) => !belongs(g.object))
  for (const o of [...m.comments.keys()]) if (belongs(o)) m.comments.delete(o)
  for (const o of [...m.objects]) if (belongs(o)) m.objects.delete(o)
}

/** The schema model: one file per object (S05). */
export function files(m: Model): Map<string, string> {
  const fileName = (s: string) => s.replace(/[/\\:*?"<>|]/g, '_')
  const out = new Map<string, string>()
  const extras = (designators: string[]) => {
    let s = ''
    for (const g of m.grants) if (designators.includes(g.object)) s += `\n${grantSql(g, false)}`
    for (const [o, text] of sorted(m.comments)) {
      const column = designators.some((d) => o.startsWith(`COLUMN ${d.slice(d.indexOf(' ') + 1)}.`))
      if (designators.includes(o) || column) s += `\n${commentSql(o, text)}`
    }
    return s
  }
  const put = (p: string, body: string) => out.set(p, `${body.trimEnd()}\n`)
  const [S, N] = [(k: string) => fileName(unkey(k)[0]), (k: string) => fileName(unkey(k)[1])]
  for (const [k, t] of sorted(m.tables)) put(`${S(k)}/tables/${N(k)}.sql`, tableDdl(k, t) + extras([`TABLE ${qk(k)}`]))
  for (const [k, v] of sorted(m.views)) put(`${S(k)}/${v.materialized ? 'materialized-views' : 'views'}/${N(k)}.sql`, viewDdl(k, v) + extras(viewNamesOf(k)))
  for (const [k, f] of sorted(m.functions)) {
    const d = `${f.procedure ? 'PROCEDURE' : 'FUNCTION'} ${q(unkey(k)[0])}.${q(f.name)}(${f.args})`
    put(`${S(k)}/${f.procedure ? 'procedures' : 'functions'}/${N(k)}.sql`, f.def + extras([d]))
  }
  for (const [k, labels] of sorted(m.enums)) put(`${S(k)}/types/${N(k)}.sql`, enumDdl(k, labels) + extras([`TYPE ${qk(k)}`]))
  for (const [k, d] of sorted(m.domains)) put(`${S(k)}/domains/${N(k)}.sql`, domainDdl(k, d) + extras([`DOMAIN ${qk(k)}`]))
  for (const [k, s] of sorted(m.sequences)) put(`${S(k)}/sequences/${N(k)}.sql`, sequenceDdl(k, s) + extras([`SEQUENCE ${qk(k)}`]))
  for (const [tk, def] of sorted(m.triggers)) {
    const [s, t, name] = unkey(tk)
    put(`${fileName(s)}/triggers/${fileName(t)}.${fileName(name)}.sql`, def)
  }
  for (const [name, schema] of sorted(m.extensions)) put(`extensions/${fileName(name)}.sql`, extensionDdl(name, schema))
  return out
}

const viewNamesOf = (k: string) => [`TABLE ${qk(k)}`, `VIEW ${qk(k)}`, `MATERIALIZED VIEW ${qk(k)}`]
