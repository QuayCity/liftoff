// SQLite schema diff: reads the CREATE statements SQLite keeps (sqlite_schema) and turns
// differences into SQLite steps, in the same Change / phase shape as the other engines
// (changes.ts), so generate, undo, capture, squash and the drift checks work the same way.
// Objects: tables (columns, constraints, options), their indexes, views, triggers. Counted as
// "not compared": virtual tables (full-text search and the like).
// SQLite's ALTER TABLE adds, drops and renames columns, nothing else: any other change to a table
// rebuilds it (a new table, the rows copied, the old one dropped, the new one renamed), with
// foreign keys off and in one transaction, the way SQLite's documentation describes.

import { compares, type Project } from './config.ts'
import { configError } from './errors.ts'
import { ownTables } from './db.ts'
import { P_DROP, P_DROP_OTHER, P_DROP_TABLES, P_KEYS, P_TABLES, P_TRIGGERS, P_VIEWS, change, sorted, step, withUndo, type Change, type Step } from './changes.ts'
import type { SqliteConn } from './sqlite.ts'

export type LiteTable = {
  /** the CREATE TABLE as SQLite keeps it */
  sql: string
  /** [name, definition], comments left out and spaces collapsed */
  columns: [string, string][]
  /** table constraints (PRIMARY KEY (…), UNIQUE, CHECK, FOREIGN KEY), the same way */
  constraints: string[]
  /** after the closing parenthesis: WITHOUT ROWID, STRICT */
  options: string
  /** index name -> CREATE INDEX (indexes SQLite makes for keys are left out) */
  indexes: Map<string, string>
}

export type LiteModel = {
  tables: Map<string, LiteTable>
  /** name -> CREATE VIEW */
  views: Map<string, string>
  /** name -> [table, CREATE TRIGGER] */
  triggers: Map<string, [string, string]>
  not_compared: [string, number][]
}

export const emptyLiteModel = (): LiteModel => ({ tables: new Map(), views: new Map(), triggers: new Map(), not_compared: [] })

const KEYWORDS = new Set(
  (
    'abort action add after all alter analyze and as asc attach autoincrement before begin between by cascade case cast check collate column commit ' +
    'conflict constraint create cross current current_date current_time current_timestamp database default deferrable deferred delete desc detach ' +
    'distinct do drop each else end escape except exclusive exists explain fail filter first following for foreign from full glob group having if ' +
    'ignore immediate in index indexed initially inner insert instead intersect into is isnull join key last left like limit match natural no not ' +
    'nothing notnull null nulls of offset on or order outer over partition plan pragma preceding primary query raise range recursive references ' +
    'regexp reindex release rename replace restrict returning right rollback row rows savepoint select set table temp temporary then ties to ' +
    'transaction trigger unbounded union unique update using vacuum values view virtual when where window with without'
  ).split(' '),
)

/** Bare when safe (lower case, not a keyword), double-quoted otherwise. */
export const q = (s: string) => (/^[a-z_][a-z0-9_]*$/.test(s) && !KEYWORDS.has(s) ? s : `"${s.replaceAll('"', '""')}"`)

const tidy = (s: string) =>
  s
    .replaceAll('\r\n', '\n')
    .split('\n')
    .map((l) => l.trimEnd())
    .join('\n')
    .trim()

/* ---------- reading the schema ---------- */

/**
 * A CREATE TABLE's parts: the items between its parentheses, split at the commas outside
 * parentheses, quotes and comments (comments left out), and what follows the closing one.
 */
export function parseTable(sql: string): Pick<LiteTable, 'columns' | 'constraints' | 'options'> {
  const items: string[] = []
  let cur = ''
  let depth = 0
  let started = false
  let i = 0
  for (; i < sql.length; i++) {
    const c = sql[i]
    if (c === "'" || c === '"' || c === '`' || c === '[') {
      const close = c === '[' ? ']' : c
      let j = i + 1
      while (j < sql.length && !(sql[j] === close && sql[j + 1] !== close)) j += sql[j] === close ? 2 : 1
      if (started) cur += sql.slice(i, j + 1)
      i = j
    } else if (c === '-' && sql[i + 1] === '-') {
      const n = sql.indexOf('\n', i)
      i = n < 0 ? sql.length : n - 1
      if (started) cur += ' '
    } else if (c === '/' && sql[i + 1] === '*') {
      const n = sql.indexOf('*/', i + 2)
      i = n < 0 ? sql.length : n + 1
      if (started) cur += ' '
    } else if (c === '(') {
      depth++
      if (started) cur += c
      started = true
    } else if (c === ')') {
      depth--
      if (depth === 0) {
        items.push(cur)
        break
      }
      cur += c
    } else if (c === ',' && depth === 1) {
      items.push(cur)
      cur = ''
    } else if (started) cur += c
  }
  const norm = (s: string) => s.replace(/\s+/g, ' ').trim()
  const t: Pick<LiteTable, 'columns' | 'constraints' | 'options'> = { columns: [], constraints: [], options: norm(sql.slice(i + 1).replace(/;\s*$/, '')) }
  for (const item of items.map(norm).filter(Boolean)) {
    if (/^(constraint|primary|unique|check|foreign)\b/i.test(item)) t.constraints.push(item)
    else {
      const m = /^("(?:[^"]|"")*"|`[^`]*`|\[[^\]]*\]|[^\s(]+)/.exec(item)!
      const raw = m[1]
      const name = /^["`[]/.test(raw) ? raw.slice(1, -1).replaceAll('""', '"') : raw
      t.columns.push([name, item])
    }
  }
  return t
}

export async function introspect(c: SqliteConn, _schemas: string[], excludeTable: string): Promise<LiteModel> {
  const m = emptyLiteModel()
  const own = new Set(ownTables(excludeTable))
  const s = (v: unknown) => String(v ?? '')
  const kinds = new Map((await c.query("SELECT name, type FROM pragma_table_list WHERE schema = 'main'")).map(([n, t]) => [s(n), s(t)]))
  let virtual = 0
  for (const [type, name, table, sql] of await c.query("SELECT type, name, tbl_name, sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' AND sql IS NOT NULL ORDER BY type, name")) {
    const [n, t, text] = [s(name), s(table), tidy(s(sql))]
    if (own.has(n) || own.has(t)) continue
    if (type === 'table') {
      if (kinds.get(n) !== 'table') {
        if (kinds.get(n) === 'virtual') virtual++
        continue
      }
      m.tables.set(n, { sql: text, ...parseTable(text), indexes: new Map() })
    } else if (type === 'view') m.views.set(n, text)
    else if (type === 'trigger') m.triggers.set(n, [t, text])
  }
  // Indexes after their tables, so each finds its own.
  for (const [name, table, sql] of await c.query("SELECT name, tbl_name, sql FROM sqlite_schema WHERE type = 'index' AND sql IS NOT NULL AND name NOT LIKE 'sqlite_%'")) {
    m.tables.get(s(table))?.indexes.set(s(name), tidy(s(sql)))
  }
  for (const [name, [table]] of [...m.triggers]) if (!m.tables.has(table) && !m.views.has(table)) m.triggers.delete(name)
  if (virtual) m.not_compared.push(['virtual tables', virtual])
  return m
}

/** Removes what the project's comparison filters exclude; a table takes its triggers along. */
export function applyFilters(m: LiteModel, p: Project): void {
  if (!p.filters.length) return
  for (const k of [...m.tables.keys()]) if (!compares(p, 'table', '', k)) m.tables.delete(k)
  for (const k of [...m.views.keys()]) if (!compares(p, 'view', '', k)) m.views.delete(k)
  for (const [k, [t]] of [...m.triggers]) if (!compares(p, 'trigger', '', k) || !(m.tables.has(t) || m.views.has(t))) m.triggers.delete(k)
}

/* ---------- DDL ---------- */

/** The whole table as one readable block, for the side-by-side view and the schema model. */
export const tableDdl = (t: LiteTable) => [`${t.sql};`, ...[...t.indexes.values()].map((i) => `${i};`)].join('\n')

/** The CREATE TABLE of `sql` under another name (a rebuild's new table). */
function renamed(sql: string, to: string): string {
  return sql.replace(/^(\s*CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?)("(?:[^"]|"")*"|`[^`]*`|\[[^\]]*\]|[^\s(]+)/i, (_, head) => `${head}${q(to)}`)
}

/**
 * Around a script that rebuilds or drops tables: foreign keys off (so dropping a table neither
 * fails nor cascades), the old ALTER TABLE RENAME (so views and triggers are not re-checked while a
 * table is gone), and one transaction. Identical steps appear once in a script.
 */
const FK_OFF: Step[] = [
  step(P_DROP, 'PRAGMA foreign_keys = OFF;', -3),
  step(P_DROP, 'PRAGMA legacy_alter_table = ON;', -2),
  step(P_DROP, 'BEGIN;', -1),
  step(P_DROP_OTHER, 'COMMIT;', 1_000_001),
  step(P_DROP_OTHER, 'PRAGMA legacy_alter_table = OFF;', 1_000_002),
  step(P_DROP_OTHER, 'PRAGMA foreign_keys = ON;', 1_000_003),
]

/** ADD COLUMN takes a column that is not a key, has no expression default and, when NOT NULL, has a default. */
function addable(def: string): boolean {
  if (/\b(primary\s+key|unique)\b|\bgenerated\s+always\b.*\bstored\b|\bdefault\s+(\(|current_(time|date|timestamp)\b)/i.test(def)) return false
  return !/\bnot\s+null\b/i.test(def) || /\bdefault\b/i.test(def)
}

/* ---------- compare ---------- */

/** Changes that turn `target` into `source`, each with the reverse steps for an undo script. */
export function diff(source: LiteModel, target: LiteModel): Change[] {
  return withUndo(compare(source, target), compare(target, source))
}

/** Everything in `m` as changes against an empty database (capture, squash). */
export const createAll = (m: LiteModel) => compare(m, emptyLiteModel())

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)
const shape = (t: LiteTable) => ({ columns: t.columns, constraints: t.constraints, options: t.options })

/** Views in an order that creates the ones a view selects from first (by name otherwise). */
function viewOrder(views: Map<string, string>): string[] {
  const names = [...views.keys()].sort()
  const out: string[] = []
  const visit = (n: string, path: Set<string>) => {
    if (out.includes(n) || path.has(n)) return
    path.add(n)
    for (const other of names) if (other !== n && new RegExp(`\\b${other.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(views.get(n)!)) visit(other, path)
    out.push(n)
  }
  for (const n of names) visit(n, new Set())
  return out
}

export function compare(source: LiteModel, target: LiteModel): Change[] {
  const out: Change[] = []

  for (const [name, nw] of sorted(source.tables)) {
    const t = q(name)
    const old = target.tables.get(name)
    const steps: Step[] = []
    let destructive = false
    if (!old) {
      steps.push(step(P_TABLES, `${nw.sql};`))
      for (const i of nw.indexes.values()) steps.push(step(P_KEYS, `${i};`))
    } else if (!same(shape(old), shape(nw))) {
      const oldCols = new Map(old.columns)
      const newCols = new Map(nw.columns)
      const rest = same(old.constraints, nw.constraints) && old.options === nw.options
      const added = nw.columns.slice(old.columns.length)
      const onlyAdded = rest && same(nw.columns.slice(0, old.columns.length), old.columns) && added.every(([, d]) => addable(d))
      const dropped = old.columns.filter(([n]) => !newCols.has(n))
      const indexed = (n: string) => [...old.indexes.values(), ...old.constraints].some((x) => new RegExp(`\\b${n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(x))
      const onlyDropped =
        rest && dropped.length > 0 && same(old.columns.filter(([n]) => newCols.has(n)), nw.columns) && dropped.every(([n, d]) => !/\b(primary\s+key|unique)\b/i.test(d) && !indexed(n))
      if (onlyAdded) for (const [, d] of added) steps.push(step(P_TABLES, `ALTER TABLE ${t} ADD COLUMN ${d};`))
      else if (onlyDropped) {
        destructive = true
        for (const [n] of dropped) steps.push(step(P_TABLES, `ALTER TABLE ${t} DROP COLUMN ${q(n)};`))
      } else {
        // The rebuild: the rows of the columns both have are copied.
        destructive = dropped.length > 0 || nw.columns.some(([n, d]) => oldCols.has(n) && oldCols.get(n) !== d)
        const tmp = `liftoff_new_${name}`
        const common = nw.columns.filter(([n]) => oldCols.has(n)).map(([n]) => q(n)).join(', ')
        steps.push(
          ...FK_OFF,
          step(P_TABLES, `${renamed(nw.sql, tmp)};`, 0),
          step(P_TABLES, `INSERT INTO ${q(tmp)} (${common}) SELECT ${common} FROM ${t};`, 1),
          step(P_TABLES, `DROP TABLE ${t};`, 2),
          step(P_TABLES, `ALTER TABLE ${q(tmp)} RENAME TO ${t};`, 3),
        )
        // Dropping the table dropped its indexes and triggers: all of them come back.
        for (const i of nw.indexes.values()) steps.push(step(P_KEYS, `${i};`))
        for (const [, [tb, sql]] of sorted(source.triggers)) if (tb === name) steps.push(step(P_TRIGGERS, `${sql};`, 1))
      }
    }
    if (old && !steps.some((s) => s.sql.startsWith('DROP TABLE'))) {
      for (const [iname, odef] of sorted(old.indexes)) if (nw.indexes.get(iname) !== odef) steps.push(step(P_DROP, `DROP INDEX IF EXISTS ${q(iname)};`, 2))
      for (const [iname, def] of sorted(nw.indexes)) if (old.indexes.get(iname) !== def) steps.push(step(P_KEYS, `${def};`))
    }
    if (steps.length) out.push(change('table', 'Tables', name, old ? 'changed' : 'added', destructive, steps, old ? tableDdl(old) : null, tableDdl(nw)))
  }
  for (const [name, old] of sorted(target.tables)) {
    if (source.tables.has(name)) continue
    out.push(change('table', 'Tables', name, 'removed', true, [...FK_OFF, step(P_DROP_TABLES, `DROP TABLE IF EXISTS ${q(name)};`)], tableDdl(old), null))
  }

  const order = viewOrder(source.views)
  for (const [name, def] of sorted(source.views)) {
    const old = target.views.get(name)
    if (old === def) continue
    const steps = [...(old === undefined ? [] : [step(P_DROP, `DROP VIEW IF EXISTS ${q(name)};`)]), step(P_VIEWS, `${def};`, order.indexOf(name))]
    out.push(change('view', 'Views', name, old === undefined ? 'added' : 'changed', false, steps, old ?? null, def))
  }
  for (const [name, def] of sorted(target.views)) {
    if (!source.views.has(name)) out.push(change('view', 'Views', name, 'removed', false, [step(P_DROP, `DROP VIEW IF EXISTS ${q(name)};`)], def, null))
  }

  for (const [name, [table, def]] of sorted(source.triggers)) {
    const old = target.triggers.get(name)
    if (old?.[1] === def) continue
    // A rebuilt table brings its triggers back itself.
    const rebuilt = out.some((c) => c.id === `table:${table}` && c.steps.some((s) => s.sql === `${def};`))
    if (rebuilt && old) continue
    const steps = [...(old ? [step(P_DROP, `DROP TRIGGER IF EXISTS ${q(name)};`)] : []), step(P_TRIGGERS, `${def};`, 1)]
    out.push(change('trigger', 'Triggers', name, old ? 'changed' : 'added', false, steps, old?.[1] ?? null, def))
  }
  for (const [name, [table, def]] of sorted(target.triggers)) {
    // Dropping a table drops its triggers.
    if (source.triggers.has(name) || !source.tables.has(table)) continue
    out.push(change('trigger', 'Triggers', name, 'removed', false, [step(P_DROP, `DROP TRIGGER IF EXISTS ${q(name)};`)], def, null))
  }
  return out
}

/** The schema model: one file per object, `<type>/<name>.sql`. */
export function files(m: LiteModel): Map<string, string> {
  const f = (s: string) => s.replace(/[/\\:*?"<>|]/g, '_')
  const out = new Map<string, string>()
  const put = (p: string, body: string) => {
    if (out.has(p)) throw configError(`two objects would share the schema-model file ${p}; rename one of them`)
    out.set(p, `${body.trimEnd()}\n`)
  }
  for (const [name, t] of sorted(m.tables)) put(`tables/${f(name)}.sql`, tableDdl(t))
  for (const [name, def] of sorted(m.views)) put(`views/${f(name)}.sql`, `${def};`)
  for (const [name, [, def]] of sorted(m.triggers)) put(`triggers/${f(name)}.sql`, `${def};`)
  return out
}

