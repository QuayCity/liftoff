// Rules on migration scripts (liftoff lint): a built-in catalogue that reads the SQL of versioned
// and repeatable scripts, a severity per rule in liftoff.toml, custom regex rules, and
// `-- liftoff:allow <rule>: <reason>` exceptions in a script.
//
// ponytail: no SQL parser. Comments and strings are blanked out (offsets kept), the rest is split
// into words and statements; a statement ends at `;`, a GO line, or a statement verb at the top
// level. Good for the usual DDL and DML; unusual layouts can miss or over-report, which the allow
// comment covers. Bodies of PostgreSQL functions ($$ … $$) are strings, so they are not checked.

import type { Config, Engine } from './config.ts'
import { configError, LiftoffError } from './errors.ts'
import { filesAt } from './git.ts'
import { scan, type Script } from './migration.ts'

export type Severity = 'off' | 'info' | 'warn' | 'error'
export const SEVERITIES: Severity[] = ['off', 'info', 'warn', 'error']

export type RuleSetting = { severity: Severity; pattern?: string }
export type CustomRule = { id: string; pattern: string; message: string; severity: Severity }
/** `[rules]` in liftoff.toml */
export type RulesConfig = { settings: Record<string, RuleSetting>; custom: CustomRule[] }

export type Finding = {
  rule: string
  severity: Exclude<Severity, 'off'>
  script: string
  line: number
  message: string
  /** set when the script allows this rule (`-- liftoff:allow`); the reason, or '' */
  allowed?: string
}

export type LintReport = {
  /** the scripts that were read */
  scripts: string[]
  findings: Finding[]
  /** findings at error severity that no allow comment covers */
  errors: number
  warnings: number
}

type Rule = { severity: Severity; help: string; engine?: Engine; needsPattern?: boolean }

/** The built-in catalogue with each rule's default severity. */
export const RULES: Record<string, Rule> = {
  'drop-table': { severity: 'warn', help: 'DROP TABLE: the data goes with it' },
  'drop-column': { severity: 'warn', help: 'ALTER TABLE … DROP COLUMN: the data goes with it' },
  truncate: { severity: 'warn', help: 'TRUNCATE empties a table' },
  'delete-without-where': { severity: 'error', help: 'DELETE without a WHERE clause removes every row' },
  'update-without-where': { severity: 'error', help: 'UPDATE without a WHERE clause changes every row' },
  'not-null-without-default': { severity: 'warn', help: 'Adding a NOT NULL column without a default fails on a table that has rows' },
  'table-without-primary-key': { severity: 'warn', help: 'CREATE TABLE with no primary key (in the statement or later in the script)' },
  'select-star': { severity: 'warn', help: 'SELECT * in a view or a script: the columns change when the table does' },
  permissions: { severity: 'info', help: 'GRANT, REVOKE or DENY: permission changes, for the reviewer' },
  'grant-to-public': { severity: 'warn', help: 'GRANT … TO PUBLIC gives every user access' },
  'grant-option': { severity: 'warn', help: 'WITH GRANT OPTION lets the grantee pass the permission on' },
  'users-and-roles': { severity: 'warn', help: 'Creates, changes or drops users, logins or roles' },
  'use-database': { severity: 'warn', help: 'USE switches database: the rest of the script runs there (SQL Server, MySQL)' },
  'sensitive-columns': { severity: 'info', help: 'A column name that suggests personal or financial data (ssn, iban, card number, date of birth, …)' },
  'table-names': { severity: 'off', needsPattern: true, help: 'New table names must match a pattern (set pattern = "regex")' },
  'column-names': { severity: 'off', needsPattern: true, help: 'New column names must match a pattern (set pattern = "regex")' },
  'undo-script': { severity: 'off', help: 'A versioned script needs a matching undo (U) script' },
}

export const NO_RULES: RulesConfig = { settings: {}, custom: [] }

function severityOf(v: unknown, what: string): Severity {
  if (!SEVERITIES.includes(v as Severity)) throw configError(`${what} must be off, info, warn or error`)
  return v as Severity
}

/**
 * `[rules]`: `drop-table = "error"`, or a table for a rule with options
 * (`[rules.table-names] severity = "warn"` + `pattern = "…"`), and `[[rules.custom]]` entries
 * with id, pattern (a regular expression), message and severity.
 */
export function parseRules(t: unknown): RulesConfig {
  if (t === undefined) return NO_RULES
  if (typeof t !== 'object' || t === null || Array.isArray(t)) throw configError('[rules] must be a table')
  const out: RulesConfig = { settings: {}, custom: [] }
  for (const [id, v] of Object.entries(t as Record<string, unknown>)) {
    if (id === 'custom') continue
    if (typeof v === 'string') out.settings[id] = { severity: severityOf(v, `rules.${id}`) }
    else if (typeof v === 'object' && v !== null) {
      const o = v as Record<string, unknown>
      out.settings[id] = { severity: o.severity === undefined ? (RULES[id]?.needsPattern ? 'warn' : (RULES[id]?.severity ?? 'warn')) : severityOf(o.severity, `rules.${id}.severity`) }
      if (o.pattern !== undefined) out.settings[id].pattern = regex(o.pattern, `rules.${id}.pattern`)
    } else throw configError(`rules.${id} must be off, info, warn or error, or a table`)
  }
  const custom = (t as Record<string, unknown>).custom
  if (custom !== undefined) {
    if (!Array.isArray(custom)) throw configError('rules.custom must be a list ([[rules.custom]])')
    for (const c of custom as Record<string, unknown>[]) {
      if (typeof c.id !== 'string' || !/^[a-z0-9][a-z0-9-]*$/.test(c.id)) throw configError('[[rules.custom]]: id must be lower-case letters, digits and -')
      if (typeof c.message !== 'string') throw configError(`[[rules.custom]] ${c.id}: message must be text`)
      out.custom.push({ id: c.id, pattern: regex(c.pattern, `[[rules.custom]] ${c.id}: pattern`), message: c.message, severity: c.severity === undefined ? 'warn' : severityOf(c.severity, `[[rules.custom]] ${c.id}: severity`) })
    }
  }
  return out
}

function regex(v: unknown, what: string): string {
  if (typeof v !== 'string') throw configError(`${what} must be text`)
  try {
    new RegExp(v, 'u')
  } catch (e) {
    throw configError(`${what} is not a valid regular expression: ${(e as Error).message}`)
  }
  return v
}

/** The severity and pattern each built-in rule runs with, after liftoff.toml. */
export function effective(config: RulesConfig): Record<string, RuleSetting> {
  const out: Record<string, RuleSetting> = {}
  for (const [id, r] of Object.entries(RULES)) out[id] = config.settings[id] ?? { severity: r.severity }
  for (const id of Object.keys(config.settings)) if (!RULES[id]) throw configError(`[rules]: there is no rule '${id}' (see liftoff lint --list)`)
  for (const [id, s] of Object.entries(out)) {
    if (s.severity !== 'off' && RULES[id].needsPattern && !s.pattern) throw configError(`[rules.${id}]: needs a pattern, e.g. pattern = "^[a-z][a-z0-9_]*$"`)
  }
  for (const c of config.custom) if (RULES[c.id]) throw configError(`[[rules.custom]]: '${c.id}' is a built-in rule; pick another id`)
  return out
}

// ---- reading SQL ----

type Token = { up: string; raw: string; at: number; line: number; depth: number }

/** The SQL with comments and string contents replaced by spaces (newlines kept), and quoted identifiers. */
export function mask(sql: string, engine: Engine): { text: string; quoted: Map<number, string> } {
  const out = sql.split('')
  const quoted = new Map<number, string>()
  const blank = (from: number, to: number) => {
    for (let k = from; k < to; k++) if (out[k] !== '\n' && out[k] !== '\r') out[k] = ' '
  }
  let i = 0
  while (i < sql.length) {
    const c = sql[i]
    const next = sql[i + 1]
    if ((c === '-' && next === '-') || (c === '#' && engine === 'mysql')) {
      const end = sql.indexOf('\n', i)
      const stop = end < 0 ? sql.length : end
      blank(i, stop)
      i = stop
    } else if (c === '/' && next === '*') {
      let depth = 0
      let j = i
      do {
        if (sql[j] === '/' && sql[j + 1] === '*') (depth++, (j += 2))
        else if (sql[j] === '*' && sql[j + 1] === '/') (depth--, (j += 2))
        else j++
      } while (depth > 0 && j < sql.length)
      blank(i, j)
      i = j
    } else if (c === "'") {
      // MySQL strings always take backslash escapes; PostgreSQL's only as E'…'.
      const backslash = engine === 'mysql' || (engine === 'postgresql' && /[eE]/.test(sql[i - 1] ?? '') && !/[\p{L}\p{N}_]/u.test(sql[i - 2] ?? ''))
      let j = i + 1
      while (j < sql.length) {
        if (backslash && sql[j] === '\\') j += 2
        else if (sql[j] === "'" && sql[j + 1] === "'") j += 2
        else if (sql[j] === "'") break
        else j++
      }
      blank(i + 1, j)
      i = j + 1
    } else if (c === '"' || (c === '[' && engine === 'sqlserver') || (c === '`' && engine === 'mysql')) {
      const close = c === '[' ? ']' : c
      let j = i + 1
      let name = ''
      while (j < sql.length) {
        if (sql[j] === close && sql[j + 1] === close) (name += close, (j += 2))
        else if (sql[j] === close) break
        else name += sql[j++]
      }
      // A quoted name is one word: underscores keep keywords inside it from matching.
      for (let k = i; k <= j && k < sql.length; k++) if (out[k] !== '\n') out[k] = '_'
      quoted.set(i, name)
      i = j + 1
    } else if (c === '$' && engine === 'postgresql') {
      const m = /^\$([\p{L}_][\p{L}\p{N}_]*)?\$/u.exec(sql.slice(i))
      const close = m ? sql.indexOf(m[0], i + m[0].length) : -1
      if (m && close >= 0) {
        blank(i + m[0].length, close)
        i = close + m[0].length
      } else i++
    } else i++
  }
  return { text: out.join(''), quoted }
}

function tokenize(sql: string, engine: Engine): Token[] {
  const { text, quoted } = mask(sql, engine)
  const lineAt: number[] = []
  let line = 1
  for (let k = 0; k < text.length; k++) {
    lineAt.push(line)
    if (text[k] === '\n') line++
  }
  const tokens: Token[] = []
  let depth = 0
  const re = /[\p{L}\p{N}_@#$]+|\S/gu
  // SQL Server batches end at a GO line; treat it as a statement end.
  const go = engine === 'sqlserver' ? /^[ \t]*go(?:[ \t]+\d+)?[ \t]*\r?$/gim : undefined
  const goAt = new Set<number>()
  if (go) for (const m of text.matchAll(go)) goAt.add(m.index + m[0].search(/\S/))
  for (const m of text.matchAll(re)) {
    const at = m.index
    const raw = m[0]
    if (goAt.has(at)) {
      tokens.push({ up: ';', raw, at, line: lineAt[at], depth: 0 })
      depth = 0
      continue
    }
    if (raw === ')') depth = Math.max(0, depth - 1)
    const q = quoted.get(at)
    tokens.push({ up: q === undefined ? raw.toUpperCase() : `"${q}`, raw: q ?? raw, at, line: lineAt[at], depth })
    if (raw === '(') depth++
  }
  return tokens
}

/** Verbs that start a statement at the top level, unless the word before says otherwise. */
const VERBS = new Set(['CREATE', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'GRANT', 'REVOKE', 'DENY', 'MERGE', 'SELECT', 'EXEC', 'EXECUTE', 'DECLARE', 'USE', 'BEGIN', 'PRINT', 'RETURN', 'COMMENT'])
/** ALTER and DROP also appear inside ALTER TABLE; they start a statement only before these. */
const OBJECTS = new Set(['TABLE', 'VIEW', 'INDEX', 'FUNCTION', 'PROCEDURE', 'PROC', 'TRIGGER', 'SCHEMA', 'SEQUENCE', 'TYPE', 'USER', 'ROLE', 'LOGIN', 'DATABASE', 'EXTENSION', 'MATERIALIZED', 'SYNONYM', 'POLICY', 'DOMAIN', 'OWNED'])
/** `ON DELETE`, `AFTER UPDATE`, `GRANT SELECT, UPDATE`, `MERGE … THEN DELETE`, `UNION SELECT`, … */
const NOT_AFTER = new Set(['ON', 'AFTER', 'BEFORE', 'OF', 'FOR', 'GRANT', 'REVOKE', 'DENY', ',', 'INSTEAD', 'OR', 'THEN', 'AS', 'UNION', 'ALL', 'EXCEPT', 'INTERSECT', 'WITH', '('])

function statements(tokens: Token[]): Token[][] {
  const out: Token[][] = []
  let cur: Token[] = []
  const flush = () => {
    if (cur.length) out.push(cur)
    cur = []
  }
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]
    if (t.up === ';') {
      flush()
      continue
    }
    const prev = cur.at(-1)
    const starts =
      prev !== undefined &&
      t.depth === cur[0].depth &&
      !NOT_AFTER.has(prev.up) &&
      (VERBS.has(t.up) || ((t.up === 'ALTER' || t.up === 'DROP') && OBJECTS.has(tokens[i + 1]?.up ?? '')))
    if (starts) flush()
    cur.push(t)
  }
  flush()
  return out
}

/** `schema.name` starting at token i; returns the text and the index after it. */
function nameAt(s: Token[], i: number): [string, number] {
  const parts: string[] = []
  while (i < s.length && /^[\p{L}\p{N}_@#$"]/u.test(s[i].up)) {
    parts.push(s[i].raw)
    if (s[i + 1]?.up !== '.') return [parts.join('.'), i + 1]
    i += 2
  }
  return [parts.join('.'), i]
}

const lastPart = (name: string) => name.split('.').at(-1)!.toLowerCase()
const is = (s: Token[], i: number, ...words: string[]) => words.every((w, k) => s[i + k]?.up === w)
/** skips `IF EXISTS` / `IF NOT EXISTS` */
const skipIf = (s: Token[], i: number) => (is(s, i, 'IF', 'EXISTS') ? i + 2 : is(s, i, 'IF', 'NOT', 'EXISTS') ? i + 3 : i)
const CONSTRAINT_WORDS = new Set(['CONSTRAINT', 'PRIMARY', 'FOREIGN', 'UNIQUE', 'CHECK', 'INDEX', 'EXCLUDE', 'LIKE', 'PERIOD'])
const SENSITIVE =
  /(^|_)(ssn|social_?security(_?number)?|passport(_?(no|number))?|iban|bank_?account(_?number)?|credit_?card(_?number)?|card_?number|cvv|cvc|tax_?id|national_?id|date_?of_?birth|birth_?date|dob)(_|$)/

type Hit = { rule: string; line: number; message: string }

/** Index after `ALTER TABLE [IF EXISTS] [ONLY] name`, and the name. */
function alterTable(s: Token[]): [string, number] | undefined {
  if (!is(s, 0, 'ALTER', 'TABLE')) return undefined
  let i = skipIf(s, 2)
  if (s[i]?.up === 'ONLY') i++
  return nameAt(s, i)
}

/** The columns a CREATE TABLE defines: the first word of each top-level item in its parentheses. */
function columnsOf(s: Token[], open: number): Token[] {
  const inner = s[open].depth + 1
  const cols: Token[] = []
  let first = true
  for (let i = open + 1; i < s.length && !(s[i].up === ')' && s[i].depth === s[open].depth); i++) {
    if (s[i].depth !== inner) continue
    if (first && !CONSTRAINT_WORDS.has(s[i].up)) cols.push(s[i])
    first = s[i].up === ','
  }
  return cols
}

function check(statementsOf: Token[][], engine: Engine, settings: Record<string, RuleSetting>): Hit[] {
  const hits: Hit[] = []
  const created = new Set<string>()
  const withKey = new Set<string>()
  const pendingKey: { name: string; line: number }[] = []
  const columns: { name: string; line: number }[] = []
  for (const s of statementsOf) {
    const d = s[0].depth
    const at = (i: number) => s[Math.min(i, s.length - 1)].line
    const v0 = s[0].up
    if (v0 === 'DROP' && s[1]?.up === 'TABLE') {
      let i = skipIf(s, 2)
      do {
        const [name, next] = nameAt(s, i)
        hits.push({ rule: 'drop-table', line: at(0), message: `drops table ${name}` })
        i = next + 1
      } while (s[i - 1]?.up === ',')
    }
    if (v0 === 'TRUNCATE') {
      const [name] = nameAt(s, s[1]?.up === 'TABLE' ? 2 : 1)
      hits.push({ rule: 'truncate', line: at(0), message: `empties table ${name}` })
    }
    if ((v0 === 'DELETE' || v0 === 'UPDATE') && s[1]?.up !== 'STATISTICS' && s[1]?.up !== '(') {
      if (!s.some((t) => t.up === 'WHERE' && t.depth === d)) {
        let i = 1
        if (s[i]?.up === 'TOP') i = s[i + 1]?.up === '(' ? i + 4 : i + 2
        if (s[i]?.up === 'FROM' || s[i]?.up === 'ONLY') i++
        const [name] = nameAt(s, i)
        hits.push(
          v0 === 'DELETE'
            ? { rule: 'delete-without-where', line: at(0), message: `deletes every row of ${name}` }
            : { rule: 'update-without-where', line: at(0), message: `updates every row of ${name}` },
        )
      }
    }
    for (let i = 0; i < s.length; i++) {
      if (s[i].up !== 'SELECT' || (s[i - 1]?.up === '(' && s[i - 2]?.up === 'EXISTS')) continue
      let j = i + 1
      while (s[j]?.up === 'DISTINCT' || s[j]?.up === 'ALL') j++
      if (s[j]?.up === 'TOP') j = s[j + 1]?.up === '(' ? j + 4 : j + 2
      while (s[j]?.up === 'PERCENT' || is(s, j, 'WITH', 'TIES')) j += s[j].up === 'PERCENT' ? 1 : 2
      if (s[j]?.up === '*') {
        hits.push({ rule: 'select-star', line: s[i].line, message: 'SELECT *: list the columns' })
        break
      }
    }
    if (v0 === 'GRANT' || v0 === 'REVOKE' || v0 === 'DENY') {
      const text = s.map((t) => t.raw).join(' ').replace(/ ([,.)]) ?/g, '$1 ').replace(/\( /g, '(')
      hits.push({ rule: 'permissions', line: at(0), message: text.length > 100 ? `${text.slice(0, 97)}…` : text })
      if (v0 === 'GRANT' && s.some((t, i) => t.up === 'TO' && s[i + 1]?.up === 'PUBLIC')) hits.push({ rule: 'grant-to-public', line: at(0), message: 'grants to PUBLIC: every user gets it' })
      if (v0 === 'GRANT' && s.some((_, i) => is(s, i, 'WITH', 'GRANT', 'OPTION'))) hits.push({ rule: 'grant-option', line: at(0), message: 'WITH GRANT OPTION: the grantee can pass it on' })
    }
    if ((v0 === 'CREATE' || v0 === 'ALTER' || v0 === 'DROP') && ['USER', 'ROLE', 'LOGIN'].includes(s[1]?.up ?? '')) {
      const [name] = nameAt(s, skipIf(s, 2))
      hits.push({ rule: 'users-and-roles', line: at(0), message: `${v0.toLowerCase()}s ${s[1].up.toLowerCase()} ${name}` })
    }
    if ((v0 === 'EXEC' || v0 === 'EXECUTE') && /^sp_(add|drop)(srv)?rolemember$|^sp_addlogin$|^sp_adduser$/i.test(s[1]?.raw ?? '')) {
      hits.push({ rule: 'users-and-roles', line: at(0), message: `runs ${s[1].raw}` })
    }
    if (v0 === 'USE' && engine !== 'postgresql') hits.push({ rule: 'use-database', line: at(0), message: `switches to database ${s[1]?.raw ?? ''}` })

    // CREATE TABLE
    if (v0 === 'CREATE') {
      let i = 1
      let temporary = false
      while (['GLOBAL', 'LOCAL', 'TEMP', 'TEMPORARY', 'UNLOGGED'].includes(s[i]?.up ?? '')) (temporary ||= s[i].up.startsWith('TEMP')), i++
      if (s[i]?.up === 'TABLE') {
        const [name, next] = nameAt(s, skipIf(s, i + 1))
        temporary ||= name.startsWith('#')
        if (!temporary && s[next]?.up === '(') {
          created.add(lastPart(name))
          if (s.some((_, k) => is(s, k, 'PRIMARY', 'KEY'))) withKey.add(lastPart(name))
          else pendingKey.push({ name, line: at(0) })
          if (settings['table-names'].pattern && !new RegExp(settings['table-names'].pattern, 'u').test(name.split('.').at(-1)!)) {
            hits.push({ rule: 'table-names', line: at(0), message: `table ${name} does not match ${settings['table-names'].pattern}` })
          }
          for (const c of columnsOf(s, next)) columns.push({ name: c.raw, line: c.line })
        }
      }
    }

    // ALTER TABLE: dropped columns, added columns, keys added later
    const alter = alterTable(s)
    if (alter) {
      const [table, start] = alter
      if (s.some((_, k) => is(s, k, 'PRIMARY', 'KEY'))) withKey.add(lastPart(table))
      for (let i = start; i < s.length; i++) {
        if (s[i].depth !== d) continue
        const actionStart = i === start || s[i - 1]?.up === ','
        if (s[i].up === 'DROP' && (s[i + 1]?.up === 'COLUMN' || (engine === 'postgresql' && actionStart && !['CONSTRAINT', 'NOT', 'DEFAULT', 'IDENTITY', 'EXPRESSION'].includes(s[i + 1]?.up ?? '')))) {
          let k = skipIf(s, s[i + 1].up === 'COLUMN' ? i + 2 : i + 1)
          do {
            const [col, next] = nameAt(s, k)
            hits.push({ rule: 'drop-column', line: s[i].line, message: `drops column ${col} of ${table}` })
            k = next + 1
            // SQL Server: DROP COLUMN a, b
          } while (engine === 'sqlserver' && s[k - 1]?.up === ',' && s[k]?.up !== 'DROP' && s[k]?.up !== 'ADD' && s[k]?.up !== 'ALTER' && k < s.length)
        }
        if (s[i].up === 'ADD' || (engine === 'sqlserver' && s[i].up === ',' && inAddList(s, i, d))) {
          let k = i + 1
          if (s[k]?.up === 'COLUMN') k++
          k = skipIf(s, k)
          if (CONSTRAINT_WORDS.has(s[k]?.up ?? '') || s[k]?.up === '(') continue
          let end = k
          while (end < s.length && !(s[end].depth === d && s[end].up === ',')) end++
          const clause = s.slice(k, end)
          if (!clause.length) continue
          columns.push({ name: clause[0].raw, line: clause[0].line })
          const has = (w: string) => clause.some((t) => t.up === w)
          const notNull = clause.some((t, n) => t.up === 'NOT' && clause[n + 1]?.up === 'NULL')
          const filled = has('DEFAULT') || has('IDENTITY') || has('GENERATED') || clause[1]?.up === 'AS' || /^(SMALL|BIG)?SERIAL\d?$/.test(clause[1]?.up ?? '')
          if (notNull && !filled && !created.has(lastPart(table))) {
            hits.push({ rule: 'not-null-without-default', line: clause[0].line, message: `adds column ${clause[0].raw} to ${table} as NOT NULL without a default: fails when the table has rows` })
          }
        }
      }
    }
  }
  for (const p of pendingKey) {
    if (!withKey.has(lastPart(p.name))) hits.push({ rule: 'table-without-primary-key', line: p.line, message: `table ${p.name} has no primary key` })
  }
  for (const c of columns) {
    const snake = c.name.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase()
    if (SENSITIVE.test(snake)) hits.push({ rule: 'sensitive-columns', line: c.line, message: `column ${c.name} may hold personal or financial data` })
    const p = settings['column-names'].pattern
    if (p && !new RegExp(p, 'u').test(c.name)) hits.push({ rule: 'column-names', line: c.line, message: `column ${c.name} does not match ${p}` })
  }
  return hits
}

/** SQL Server `ALTER TABLE t ADD a int, b int`: a comma inside an ADD list starts another column. */
function inAddList(s: Token[], comma: number, d: number): boolean {
  for (let i = comma - 1; i >= 0; i--) {
    if (s[i].depth !== d) continue
    if (s[i].up === 'ADD') return true
    if (i > 1 && ['DROP', 'ALTER', 'WITH', 'NOCHECK', 'CHECK'].includes(s[i].up)) return false
  }
  return false
}

/** `-- liftoff:allow drop-table, truncate: the archive replaced it` -> rule -> reason */
export function allowsIn(sql: string, file: string, known: Set<string>): Map<string, string> {
  const out = new Map<string, string>()
  for (const m of sql.matchAll(/--[ \t]*liftoff:allow[ \t]+([^\r\n]*)/g)) {
    const colon = m[1].indexOf(':')
    const ids = (colon < 0 ? m[1] : m[1].slice(0, colon)).split(/[\s,]+/).filter(Boolean)
    const reason = colon < 0 ? '' : m[1].slice(colon + 1).trim()
    for (const id of ids) {
      if (!known.has(id)) throw configError(`${file}: liftoff:allow names '${id}', which is not a rule (see liftoff lint --list)`)
      out.set(id, reason)
    }
  }
  return out
}

/** Checks one script's SQL; findings sorted by line. */
export function lintScript(script: Pick<Script, 'fileName' | 'sql' | 'kind' | 'version'>, engine: Engine, config: RulesConfig, all: Pick<Script, 'kind' | 'version'>[] = []): Finding[] {
  const settings = effective(config)
  const hits = check(statements(tokenize(script.sql, engine)), engine, settings)
  if (script.kind === 'versioned' && !all.some((s) => s.kind === 'undo' && s.version?.text !== undefined && sameText(s.version.text, script.version?.text))) {
    hits.push({ rule: 'undo-script', line: 1, message: 'has no undo (U) script' })
  }
  const { text } = mask(script.sql, engine)
  for (const c of config.custom) {
    if (c.severity === 'off') continue
    const re = new RegExp(c.pattern, 'giu')
    for (const m of text.matchAll(re)) hits.push({ rule: c.id, line: text.slice(0, m.index).split('\n').length, message: c.message })
  }
  const known = new Set([...Object.keys(RULES), ...config.custom.map((c) => c.id)])
  const allowed = allowsIn(script.sql, script.fileName, known)
  const severityOf = (id: string) => settings[id]?.severity ?? config.custom.find((c) => c.id === id)!.severity
  return hits
    .filter((h) => severityOf(h.rule) !== 'off' && (!RULES[h.rule]?.engine || RULES[h.rule].engine === engine))
    .map((h): Finding => {
      const f: Finding = { rule: h.rule, severity: severityOf(h.rule) as Finding['severity'], script: script.fileName, line: h.line, message: h.message }
      if (allowed.has(h.rule)) f.allowed = allowed.get(h.rule)!
      return f
    })
    .sort((a, b) => a.line - b.line || a.rule.localeCompare(b.rule))
}

const sameText = (a: string, b: string | undefined) => b !== undefined && a.replaceAll('_', '.').replace(/(\.0+)+$/, '') === b.replaceAll('_', '.').replace(/(\.0+)+$/, '')

/** Counts errors and warnings that no allow comment covers. */
export function summarize(scripts: string[], findings: Finding[]): LintReport {
  const open = findings.filter((f) => f.allowed === undefined)
  return { scripts, findings, errors: open.filter((f) => f.severity === 'error').length, warnings: open.filter((f) => f.severity === 'warn').length }
}

/**
 * Lints the project's versioned and repeatable scripts: all of them, the ones named, or (with
 * `since`, a git ref such as origin/main) the ones that are not on that ref yet.
 */
export function lint(cfg: Config, opts: { scripts?: string[]; since?: string } = {}): LintReport {
  const all = scan(cfg.migrationsDir())
  let picked = all.filter((s) => s.kind === 'versioned' || s.kind === 'repeatable')
  if (opts.scripts?.length) {
    const wanted = new Set(opts.scripts.map((n) => n.split(/[\\/]/).pop()!))
    for (const n of wanted) if (!all.some((s) => s.fileName === n)) throw configError(`no script ${n} in ${cfg.project.migrations}`)
    picked = all.filter((s) => wanted.has(s.fileName))
  }
  if (opts.since) {
    const onRef = new Set(filesAt(cfg.root, opts.since, cfg.migrationsDir()))
    picked = picked.filter((s) => !onRef.has(s.fileName))
  }
  const engine = cfg.project.engine as Engine
  return summarize(
    picked.map((s) => s.fileName),
    picked.flatMap((s) => lintScript(s, engine, cfg.rules, all)),
  )
}

export const rulesError = (r: LintReport) =>
  new LiftoffError('LIFTOFF_RULES', 15, `${r.errors} rule error(s) in the scripts; fix them or allow them with a reason (-- liftoff:allow <rule>: <why>)`)

const esc = (s: string) => s.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;')

/** The findings as an HTML section (also used inside the check report). */
export function findingsHtml(r: LintReport): string {
  let h = `<h2>Rules (${r.errors} error(s), ${r.warnings} warning(s), ${r.scripts.length} script(s))</h2>`
  if (!r.findings.length) return `${h}<p class=ok>No findings.</p>`
  h += '<table><tr><th>Script</th><th>Line</th><th>Severity</th><th>Rule</th><th>Finding</th></tr>'
  for (const f of r.findings) {
    const sev = f.allowed !== undefined ? `allowed${f.allowed ? `: ${esc(f.allowed)}` : ''}` : f.severity
    h += `<tr class=${f.allowed !== undefined ? 'allowed' : f.severity}><td>${esc(f.script)}</td><td>${f.line}</td><td>${sev}</td><td>${esc(f.rule)}</td><td>${esc(f.message)}</td></tr>`
  }
  return `${h}</table>`
}

export const FINDINGS_CSS =
  'table{border-collapse:collapse;width:100%}td,th{border-bottom:1px solid #d5d9de;padding:.3rem .5rem;text-align:left;vertical-align:top}' +
  'tr.error td:nth-child(3){color:#b42d25;font-weight:600}tr.warn td:nth-child(3){color:#8a5a00}tr.allowed{color:#5d6670}'

/** A self-contained HTML report of a lint run. */
export function lintReportHtml(r: LintReport, project: string, generatedAt: string): string {
  return (
    `<!doctype html><html lang=en><head><meta charset=utf-8><title>Rules for ${esc(project)}</title><style>` +
    `body{font:14px system-ui,sans-serif;margin:2rem;max-width:72rem;color:#15181c}.ok{color:#17734a}${FINDINGS_CSS}</style></head><body>` +
    `<h1>Rules for ${esc(project)}</h1><p>Generated ${esc(generatedAt)}</p>${findingsHtml(r)}</body></html>`
  )
}
