// MySQL schema diff: reads the database's schema with SHOW CREATE (MySQL's own canonical DDL) and
// turns differences into MySQL steps, in the same Change / phase shape as the other engines
// (changes.ts), so generate, undo, capture, squash and the drift checks work the same way.
// Objects: tables (columns, keys and indexes, foreign keys, checks, table options), views,
// procedures, functions, triggers. Counted as "not compared": events, and routines whose text
// this login may not read.
// Names are bare (no database): the database is the one the URL names, and differs per environment.
// Routines and triggers are written between DELIMITER lines, as the mysql client takes them.

import { compares, type Project } from './config.ts'
import { configError } from './errors.ts'
import { ownTables } from './db.ts'
import { P_DROP, P_DROP_OTHER, P_DROP_TABLES, P_FKS, P_FUNCS, P_KEYS, P_TABLES, P_TRIGGERS, P_VIEWS, change, sorted, step, withUndo, type Change, type Step } from './changes.ts'
import { lit, quote, type MySqlConn } from './mysql.ts'

export type MyTable = {
  /** [name, definition line as SHOW CREATE TABLE writes it], in column order */
  columns: [string, string][]
  /** PRIMARY, or the index name -> its line (`UNIQUE KEY \`u\` (\`a\`)`) */
  keys: Map<string, string>
  /** constraint name -> `CONSTRAINT \`fk\` FOREIGN KEY …` */
  fks: Map<string, string>
  /** constraint name -> `CONSTRAINT \`c\` CHECK (…)` */
  checks: Map<string, string>
  /** the table options (ENGINE, CHARSET, COMMENT, …) without AUTO_INCREMENT=n */
  options: string
}

export type RoutineKind = 'procedure' | 'function' | 'trigger'

export type Routine = {
  kind: RoutineKind
  /** the CREATE statement, without DEFINER */
  def: string
  /** triggers: their table */
  table: string | null
}

export type MyModel = {
  tables: Map<string, MyTable>
  /** name -> CREATE VIEW, as MySQL keeps it */
  views: Map<string, string>
  routines: Map<string, Routine>
  not_compared: [string, number][]
}

export const emptyMyModel = (): MyModel => ({ tables: new Map(), views: new Map(), routines: new Map(), not_compared: [] })

/* ---------- reading the schema ---------- */

const DEFINER = /\s+DEFINER\s*=\s*(?:`(?:[^`]|``)*`|'(?:[^']|'')*'|[^\s@]+)@(?:`(?:[^`]|``)*`|'(?:[^']|'')*'|\S+)/i

/** SHOW CREATE TABLE's text as parts. */
export function parseTable(ddl: string): MyTable {
  const t: MyTable = { columns: [], keys: new Map(), fks: new Map(), checks: new Map(), options: '' }
  const lines = ddl.replaceAll('\r\n', '\n').split('\n')
  const close = lines.findLastIndex((l) => l.startsWith(')'))
  for (const raw of lines.slice(1, close)) {
    const line = raw.trim().replace(/,$/, '')
    const name = /^`((?:[^`]|``)*)`/.exec(line)?.[1]?.replaceAll('``', '`')
    if (name !== undefined) t.columns.push([name, line])
    else if (/^PRIMARY KEY/i.test(line)) t.keys.set('PRIMARY', line)
    else if (/^CONSTRAINT /i.test(line)) {
      const cname = /^CONSTRAINT `((?:[^`]|``)*)`/i.exec(line)![1].replaceAll('``', '`')
      ;(/ FOREIGN KEY /i.test(line) ? t.fks : t.checks).set(cname, line)
    } else {
      const k = /^(?:UNIQUE |FULLTEXT |SPATIAL )?KEY `((?:[^`]|``)*)`/i.exec(line)
      if (k) t.keys.set(k[1].replaceAll('``', '`'), line)
    }
  }
  t.options = lines
    .slice(close)
    .join(' ')
    .replace(/^\)\s*/, '')
    .replace(/\s*AUTO_INCREMENT=\d+/i, '')
    .replace(/\s+/g, ' ')
    .trim()
  return t
}

/** A view as SHOW CREATE VIEW writes it, without what differs per environment: the definer, the defaults, the database name. */
export function normalizeView(ddl: string, database: string): string {
  return ddl
    .replace(DEFINER, '')
    .replace(/\s+ALGORITHM=UNDEFINED/i, '')
    .replace(/\s+SQL SECURITY DEFINER/i, '')
    .replaceAll(`${quote(database)}.`, '')
    .trim()
}

/** A routine or trigger as SHOW CREATE writes it, without the definer; line endings and trailing spaces do not count. */
export function normalizeRoutine(ddl: string): string {
  return ddl
    .replace(DEFINER, '')
    .replaceAll('\r\n', '\n')
    .split('\n')
    .map((l) => l.trimEnd())
    .join('\n')
    .trim()
}

export async function introspect(c: MySqlConn, _schemas: string[], excludeTable: string): Promise<MyModel> {
  const m = emptyMyModel()
  const own = ownTables(excludeTable).map(lit).join(', ')
  const s = (v: unknown) => String(v ?? '')
  for (const [name] of await c.query(`SELECT table_name FROM information_schema.tables WHERE table_schema = DATABASE() AND table_type = 'BASE TABLE' AND table_name NOT IN (${own})`)) {
    const [[, ddl]] = await c.query(`SHOW CREATE TABLE ${quote(s(name))}`)
    m.tables.set(s(name), parseTable(s(ddl)))
  }
  for (const [name] of await c.query('SELECT table_name FROM information_schema.views WHERE table_schema = DATABASE()')) {
    const [[, ddl]] = await c.query(`SHOW CREATE VIEW ${quote(s(name))}`)
    m.views.set(s(name), normalizeView(s(ddl), c.database))
  }
  let unreadable = 0
  for (const [type, name] of await c.query('SELECT routine_type, routine_name FROM information_schema.routines WHERE routine_schema = DATABASE()')) {
    const kind = s(type).toLowerCase() as RoutineKind
    const [row] = await c.query(`SHOW CREATE ${s(type)} ${quote(s(name))}`)
    // Without the right to read it, MySQL returns the routine with no text.
    if (row?.[2] == null) unreadable++
    else m.routines.set(s(name), { kind, def: normalizeRoutine(s(row[2])), table: null })
  }
  for (const [name, table] of await c.query('SELECT trigger_name, event_object_table FROM information_schema.triggers WHERE trigger_schema = DATABASE() ORDER BY event_object_table, action_order')) {
    if (!m.tables.has(s(table))) continue
    const [row] = await c.query(`SHOW CREATE TRIGGER ${quote(s(name))}`)
    if (row?.[2] == null) unreadable++
    else m.routines.set(s(name), { kind: 'trigger', def: normalizeRoutine(s(row[2])), table: s(table) })
  }
  const [[events]] = await c.query('SELECT COUNT(*) FROM information_schema.events WHERE event_schema = DATABASE()')
  if (Number(events) > 0) m.not_compared.push(['events', Number(events)])
  if (unreadable) m.not_compared.push(['routines and triggers this login may not read', unreadable])
  return m
}

/** Removes what the project's comparison filters exclude; a table takes its triggers along. */
export function applyFilters(m: MyModel, p: Project): void {
  if (!p.filters.length) return
  for (const k of [...m.tables.keys()]) if (!compares(p, 'table', '', k)) m.tables.delete(k)
  for (const k of [...m.views.keys()]) if (!compares(p, 'view', '', k)) m.views.delete(k)
  for (const [k, r] of [...m.routines]) {
    const keep = r.kind === 'trigger' ? m.tables.has(r.table!) && compares(p, 'trigger', '', k) : compares(p, 'function', '', k)
    if (!keep) m.routines.delete(k)
  }
}

/* ---------- DDL ---------- */

/** A statement whose body has semicolons (routines, triggers), between DELIMITER lines. */
const delimited = (sql: string) => `DELIMITER //\n${sql.trimEnd()} //\nDELIMITER ;`

const createTable = (name: string, t: MyTable, withFks: boolean) => {
  const lines = [...t.columns.map(([, l]) => l), ...t.keys.values(), ...t.checks.values(), ...(withFks ? t.fks.values() : [])]
  return `CREATE TABLE ${quote(name)} (\n${lines.map((l) => `  ${l}`).join(',\n')}\n)${t.options ? ` ${t.options}` : ''};`
}

/** The whole table as one readable block, for the side-by-side view and the schema model. */
export const tableDdl = (name: string, t: MyTable) => createTable(name, t, true)

const viewWord = (def: string) => def.replace(/^CREATE\s+/i, 'CREATE OR REPLACE ')

const word: Record<RoutineKind, string> = { procedure: 'PROCEDURE', function: 'FUNCTION', trigger: 'TRIGGER' }
const group: Record<RoutineKind, string> = { procedure: 'Procedures', function: 'Functions', trigger: 'Triggers' }

/** Views in an order that creates the ones a view selects from first (by name otherwise). */
function viewOrder(views: Map<string, string>): string[] {
  const names = [...views.keys()].sort()
  const out: string[] = []
  const seen = new Set<string>()
  const visit = (n: string, path: Set<string>) => {
    if (seen.has(n) || path.has(n)) return
    path.add(n)
    for (const other of names) if (other !== n && views.get(n)!.includes(quote(other))) visit(other, path)
    seen.add(n)
    out.push(n)
  }
  for (const n of names) visit(n, new Set())
  return out
}

/* ---------- compare ---------- */

/** Changes that turn `target` into `source`, each with the reverse steps for an undo script. */
export function diff(source: MyModel, target: MyModel): Change[] {
  return withUndo(compare(source, target), compare(target, source))
}

/** Everything in `m` as changes against an empty database (capture, squash). */
export const createAll = (m: MyModel) => compare(m, emptyMyModel())

/** The column before `name` among the columns both lists have, '' when it is the first. */
function before(cols: [string, string][], name: string, common: Set<string>): string {
  const shared = cols.filter(([n]) => common.has(n)).map(([n]) => n)
  return shared[shared.indexOf(name) - 1] ?? ''
}

export function compare(source: MyModel, target: MyModel): Change[] {
  const out: Change[] = []

  for (const [name, nw] of sorted(source.tables)) {
    const t = quote(name)
    const old = target.tables.get(name)
    const steps: Step[] = []
    let destructive = false
    if (!old) {
      // Foreign keys come once every table exists.
      steps.push(step(P_TABLES, createTable(name, nw, false)))
      for (const fk of nw.fks.values()) steps.push(step(P_FKS, `ALTER TABLE ${t} ADD ${fk};`))
    } else {
      const oldCols = new Map(old.columns)
      const common = new Set(nw.columns.map(([n]) => n).filter((n) => oldCols.has(n)))
      nw.columns.forEach(([n, line], i) => {
        const at = i === 0 ? ' FIRST' : ` AFTER ${quote(nw.columns[i - 1][0])}`
        if (!oldCols.has(n)) steps.push(step(P_TABLES, `ALTER TABLE ${t} ADD COLUMN ${line}${at};`))
        else if (oldCols.get(n) !== line || before(nw.columns, n, common) !== before(old.columns, n, common)) {
          destructive ||= oldCols.get(n) !== line
          steps.push(step(P_TABLES, `ALTER TABLE ${t} MODIFY COLUMN ${line}${at};`))
        }
      })
      for (const [n] of old.columns) {
        if (nw.columns.some(([x]) => x === n)) continue
        destructive = true
        steps.push(step(P_TABLES, `ALTER TABLE ${t} DROP COLUMN ${quote(n)};`, 1))
      }
      // Foreign keys go first (an index they use cannot be dropped before them), then keys.
      for (const [n, line] of sorted(old.fks)) if (nw.fks.get(n) !== line) steps.push(step(P_DROP, `ALTER TABLE ${t} DROP FOREIGN KEY ${quote(n)};`, 0))
      for (const [n, line] of sorted(old.checks)) if (nw.checks.get(n) !== line) steps.push(step(P_DROP, `ALTER TABLE ${t} DROP CHECK ${quote(n)};`, 1))
      for (const [n, line] of sorted(old.keys)) {
        if (nw.keys.get(n) !== line) steps.push(step(P_DROP, n === 'PRIMARY' ? `ALTER TABLE ${t} DROP PRIMARY KEY;` : `ALTER TABLE ${t} DROP INDEX ${quote(n)};`, 2))
      }
      for (const [n, line] of sorted(nw.keys)) if (old.keys.get(n) !== line) steps.push(step(P_KEYS, `ALTER TABLE ${t} ADD ${line};`))
      for (const [n, line] of sorted(nw.checks)) if (old.checks.get(n) !== line) steps.push(step(P_KEYS, `ALTER TABLE ${t} ADD ${line};`))
      for (const [n, line] of sorted(nw.fks)) if (old.fks.get(n) !== line) steps.push(step(P_FKS, `ALTER TABLE ${t} ADD ${line};`))
      if (old.options !== nw.options) {
        // A comment that is gone is set to empty: leaving it out of ALTER TABLE keeps it.
        const options = `${nw.options}${/\bCOMMENT=/i.test(old.options) && !/\bCOMMENT=/i.test(nw.options) ? " COMMENT=''" : ''}`.trim()
        if (options) steps.push(step(P_TABLES, `ALTER TABLE ${t} ${options};`, 2))
      }
    }
    if (steps.length) out.push(change('table', 'Tables', name, old ? 'changed' : 'added', destructive, steps, old ? tableDdl(name, old) : null, tableDdl(name, nw)))
  }
  for (const [name, old] of sorted(target.tables)) {
    if (source.tables.has(name)) continue
    // Its own foreign keys go first, so tables dropped together drop in any order.
    const steps = [step(P_DROP_TABLES, `DROP TABLE IF EXISTS ${quote(name)};`)]
    for (const n of old.fks.keys()) steps.push(step(P_DROP, `ALTER TABLE ${quote(name)} DROP FOREIGN KEY ${quote(n)};`))
    out.push(change('table', 'Tables', name, 'removed', true, steps, tableDdl(name, old), null))
  }

  const order = viewOrder(source.views)
  for (const [name, def] of sorted(source.views)) {
    const old = target.views.get(name)
    if (old === def) continue
    const s = { phase: P_VIEWS, order: order.indexOf(name), sql: `${old === undefined ? def : viewWord(def)};` }
    out.push(change('view', 'Views', name, old === undefined ? 'added' : 'changed', false, [s], old ?? null, def))
  }
  for (const [name, def] of sorted(target.views)) {
    if (!source.views.has(name)) out.push(change('view', 'Views', name, 'removed', false, [step(P_DROP, `DROP VIEW IF EXISTS ${quote(name)};`)], def, null))
  }

  const phaseOf = (r: Routine) => (r.kind === 'function' ? P_FUNCS : P_TRIGGERS)
  const orderOf = (r: Routine) => (r.kind === 'trigger' ? 1 : 0)
  for (const [name, r] of sorted(source.routines)) {
    const old = target.routines.get(name)
    if (old && old.def === r.def && old.kind === r.kind) continue
    const steps: Step[] = []
    if (old) steps.push(step(P_DROP, `DROP ${word[old.kind]} IF EXISTS ${quote(name)};`, 3))
    steps.push(step(phaseOf(r), delimited(r.def), orderOf(r)))
    out.push(change(r.kind, group[r.kind], name, old ? 'changed' : 'added', false, steps, old?.def ?? null, r.def))
  }
  for (const [name, r] of sorted(target.routines)) {
    if (source.routines.has(name)) continue
    // Dropping a table drops its triggers.
    if (r.table && !source.tables.has(r.table)) continue
    out.push(change(r.kind, group[r.kind], name, 'removed', false, [step(r.kind === 'function' ? P_DROP_OTHER : P_DROP, `DROP ${word[r.kind]} IF EXISTS ${quote(name)};`)], r.def, null))
  }
  return out
}

/** The schema model: one file per object, `<type>/<name>.sql`. */
export function files(m: MyModel): Map<string, string> {
  const f = (s: string) => s.replace(/[/\\:*?"<>|]/g, '_')
  const out = new Map<string, string>()
  const put = (p: string, body: string) => {
    // Only possible when two names differ only in characters a file name cannot hold.
    if (out.has(p)) throw configError(`two objects would share the schema-model file ${p}; rename one of them`)
    out.set(p, `${body.trimEnd()}\n`)
  }
  for (const [name, t] of sorted(m.tables)) put(`tables/${f(name)}.sql`, tableDdl(name, t))
  for (const [name, def] of sorted(m.views)) put(`views/${f(name)}.sql`, `${def};`)
  const dir: Record<RoutineKind, string> = { procedure: 'procedures', function: 'functions', trigger: 'triggers' }
  for (const [name, r] of sorted(m.routines)) put(`${dir[r.kind]}/${f(name)}.sql`, delimited(r.def))
  return out
}
