// Migration files on disk: naming, versions, checksums, the next version, placeholders, and
// splitting scripts into statements (PostgreSQL) or batches (SQL Server).

import * as fs from 'node:fs'
import * as path from 'node:path'
import { crc32 } from 'node:zlib'
import { configError } from './errors.ts'

export type Kind = 'versioned' | 'repeatable' | 'undo' | 'baseline'

/** `1.2`, `1_2`, `20261008.1104`. Trailing zero parts do not count: 1.0 equals 1. */
export type Version = { parts: bigint[]; text: string }

export function parseVersion(s: string): Version | undefined {
  const raw = s.split(/[._]/)
  if (raw.some((p) => !/^\d+$/.test(p))) return undefined
  const parts = raw.map((p) => BigInt(p))
  while (parts.length > 1 && parts[parts.length - 1] === 0n) parts.pop()
  return { parts, text: s }
}

/** Negative, zero or positive, like a sort comparator. A missing version sorts first. */
export function compareVersions(a: Version | undefined, b: Version | undefined): number {
  if (!a || !b) return (a ? 1 : 0) - (b ? 1 : 0)
  for (let i = 0; i < Math.max(a.parts.length, b.parts.length); i++) {
    const x = a.parts[i]
    const y = b.parts[i]
    if (x === undefined) return -1
    if (y === undefined) return 1
    if (x !== y) return x < y ? -1 : 1
  }
  return 0
}

export const sameVersion = (a: Version | undefined, b: Version | undefined) => compareVersions(a, b) === 0 && !!a === !!b

export type Script = {
  kind: Kind
  version: Version | undefined
  description: string
  fileName: string
  path: string
  checksum: number
  sql: string
  /** a baseline script that starts the numbering again (`-- liftoff:restart` in it) */
  restart?: boolean
  /** `-- liftoff:for <expression>`: the environments it runs on (by name or role); none: all */
  for?: string
  /** `-- liftoff:topic a, b`: what it belongs to (a ticket, a feature), for `migrate --topic` */
  topics?: string[]
}

/** The line that marks a baseline script as a numbering restart (liftoff rebaseline --restart). */
export const RESTART_MARK = '-- liftoff:restart'

/** `V1.2__add_orders.sql` -> versioned, "1.2", "add orders" */
export function parseName(name: string): { kind: Kind; version: string | undefined; description: string } | undefined {
  if (!name.endsWith('.sql')) return undefined
  const stem = name.slice(0, -4)
  const sep = stem.indexOf('__')
  if (sep < 0) return undefined
  const head = stem.slice(0, sep)
  const kinds: Record<string, Kind> = { V: 'versioned', R: 'repeatable', U: 'undo', B: 'baseline' }
  const kind = kinds[head[0] ?? '']
  if (!kind) return undefined
  const version = head.slice(1)
  if (kind === 'repeatable' ? version !== '' : version === '') return undefined
  return { kind, version: kind === 'repeatable' ? undefined : version, description: stem.slice(sep + 2).replaceAll('_', ' ') }
}

/** Every script under `dir` (sub-folders too): versioned by version, then repeatables by description. */
export function scan(dir: string): Script[] {
  const scripts: Script[] = []
  const files = fs.existsSync(dir) ? (fs.readdirSync(dir, { recursive: true, withFileTypes: true }) as fs.Dirent[]) : []
  for (const f of files) {
    if (!f.isFile()) continue
    const parsed = parseName(f.name)
    if (!parsed) continue
    let version: Version | undefined
    if (parsed.version !== undefined) {
      version = parseVersion(parsed.version)
      if (!version) throw configError(`${f.name}: version '${parsed.version}' must be numbers separated by . or _`)
    }
    // The history table's columns: a longer name would run the script and then fail to record it.
    for (const [what, value, max] of [['description', parsed.description, 200], ['version', parsed.version ?? '', 50], ['file name', f.name, 1000]] as const) {
      const n = [...value].length
      if (n > max) throw configError(`${f.name}: the ${what} is ${n} characters; the history table holds ${max}`)
    }
    const file = path.join(f.parentPath, f.name)
    const bytes = fs.readFileSync(file)
    let sql: string
    try {
      sql = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes)
    } catch {
      throw configError(`${f.name} is not valid UTF-8`)
    }
    const restart = parsed.kind === 'baseline' && new RegExp(`^${RESTART_MARK}\\b`, 'm').test(sql)
    scripts.push({ kind: parsed.kind, version, description: parsed.description, fileName: f.name, path: file, checksum: checksum(bytes), sql, restart, ...marks(sql, f.name) })
  }
  for (const kind of ['versioned', 'undo', 'baseline'] as const) {
    const same = scripts.filter((s) => s.kind === kind).sort((a, b) => compareVersions(a.version, b.version))
    for (let i = 1; i < same.length; i++) {
      if (compareVersions(same[i - 1].version, same[i].version) === 0) {
        throw configError(`two scripts share version ${same[i - 1].version!.text}: ${same[i - 1].fileName} and ${same[i].fileName}`)
      }
    }
  }
  return scripts.sort(
    (a, b) =>
      Number(a.kind === 'repeatable') - Number(b.kind === 'repeatable') ||
      compareVersions(a.version, b.version) ||
      (a.description < b.description ? -1 : a.description > b.description ? 1 : 0),
  )
}

/** The `-- liftoff:for` and `-- liftoff:topic` lines of a script, checked. */
function marks(sql: string, file: string): Pick<Script, 'for' | 'topics'> {
  const out: Pick<Script, 'for' | 'topics'> = {}
  const fors = [...sql.matchAll(/^[ \t]*--[ \t]*liftoff:for[ \t]+(.*?)[ \t]*\r?$/gm)].map((m) => m[1])
  if (fors.length > 1) throw configError(`${file}: one -- liftoff:for line per script (combine them with and / or)`)
  if (fors.length) {
    parseExpression(fors[0], `${file}: liftoff:for`)
    out.for = fors[0]
  }
  const topics = [...sql.matchAll(/^[ \t]*--[ \t]*liftoff:topics?[ \t]+(.*?)[ \t]*\r?$/gm)].flatMap((m) => m[1].split(/[\s,]+/).filter(Boolean))
  for (const t of topics) if (!WORD.test(t) || OPERATORS.has(t.toLowerCase())) throw configError(`${file}: '${t}' cannot be a topic (letters, digits, - _ . and no and / or / not)`)
  if (topics.length) out.topics = [...new Set(topics)]
  return out
}

/** A word in a `for` or `topic` expression: an environment name, a role or a topic. */
const WORD = /^[\p{L}\p{N}_.-]+$/u
const OPERATORS = new Set(['and', 'or', 'not'])

type Expr = { word: string } | { not: Expr } | { and: Expr[] } | { or: Expr[] }

/**
 * `prod or test`, `not prod`, `dev, test` (a comma is or), `(eu or us) and not prod`. `not` binds
 * tightest, then `and`, then `or`. Words compare without case.
 */
export function parseExpression(text: string, what: string): Expr {
  const tokens = text.match(/[()!,]|[^\s()!,]+/g) ?? []
  let i = 0
  const fail = (msg: string): never => {
    throw configError(`${what} '${text}': ${msg}`)
  }
  const or = (): Expr => {
    const parts = [and()]
    while (tokens[i] === ',' || tokens[i]?.toLowerCase() === 'or') (i++, parts.push(and()))
    return parts.length === 1 ? parts[0] : { or: parts }
  }
  const and = (): Expr => {
    const parts = [not()]
    while (tokens[i]?.toLowerCase() === 'and') (i++, parts.push(not()))
    return parts.length === 1 ? parts[0] : { and: parts }
  }
  const not = (): Expr => {
    const t = tokens[i++]
    if (t === undefined) return fail('it ends too early')
    if (t === '!' || t.toLowerCase() === 'not') return { not: not() }
    if (t === '(') {
      const e = or()
      if (tokens[i++] !== ')') fail('a ( has no )')
      return e
    }
    if (!WORD.test(t) || OPERATORS.has(t.toLowerCase())) return fail(`unexpected '${t}'`)
    return { word: t.toLowerCase() }
  }
  const e = or()
  if (i < tokens.length) fail(`unexpected '${tokens[i]}'`)
  return e
}

/** Whether the expression holds when exactly `words` are true. */
export function holds(e: Expr, words: Set<string>): boolean {
  if ('word' in e) return words.has(e.word)
  if ('not' in e) return !holds(e.not, words)
  if ('and' in e) return e.and.every((x) => holds(x, words))
  return e.or.some((x) => holds(x, words))
}

/** Whether a script runs on an environment: its `for` expression against the name and the role. */
export function isFor(s: Pick<Script, 'for' | 'fileName'>, env: { name: string; role: string }): boolean {
  return s.for === undefined || holds(parseExpression(s.for, `${s.fileName}: liftoff:for`), new Set([env.name.toLowerCase(), env.role.toLowerCase()]))
}

/**
 * CRC32 over the script's lines without their line endings (`\n`, `\r\n` or a lone `\r`), with a
 * UTF-8 BOM removed, so checkouts with different line endings match. Equals the checksum Flyway
 * stores; pinned by the black-box fixtures in test/fixtures/checksum.
 */
export function checksum(bytes: Uint8Array): number {
  let b = bytes
  if (b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf) b = b.subarray(3)
  let crc = 0
  let start = 0
  for (let i = 0; i < b.length; i++) {
    if (b[i] === 0x0a || b[i] === 0x0d) {
      crc = crc32(b.subarray(start, i), crc)
      if (b[i] === 0x0d && b[i + 1] === 0x0a) i++
      start = i + 1
    }
  }
  crc = crc32(b.subarray(start), crc)
  return crc | 0 // stored as a signed 32-bit integer
}

/**
 * The next number, four digits: V0001, V0002, V0003 (after V9999 it keeps counting). A dotted version
 * goes up in its last part (`1.9` -> `1.10`). Baseline scripts count too: after B0150 comes V0151.
 * Projects that already use timestamp versions (UTC `yyyyMMdd.HHmm`, often from Flyway) keep getting
 * timestamps, since a small number would sort before them.
 */
export function nextVersion(existing: Script[], now: Date): string {
  const versions = existing.filter((s) => (s.kind === 'versioned' || s.kind === 'baseline') && s.version).map((s) => s.version!)
  const latest = versions.sort(compareVersions).at(-1)
  const p = (n: number, w = 2) => String(n).padStart(w, '0')
  const stamp = `${p(now.getUTCFullYear(), 4)}${p(now.getUTCMonth() + 1)}${p(now.getUTCDate())}.${p(now.getUTCHours())}${p(now.getUTCMinutes())}`
  if (!latest) return '0001'
  const firstPart = latest.text.split(/[._]/)[0]
  if (firstPart.length >= 8) return compareVersions(parseVersion(stamp), latest) > 0 ? stamp : bump(latest.text)
  return bump(latest.text)
}

/** From V9990 on: time to rebaseline with a restart, before four digits run out. */
export function versionNote(scripts: Script[]): string | undefined {
  const latest = scripts.filter((s) => (s.kind === 'versioned' || s.kind === 'baseline') && s.version).map((s) => s.version!).sort(compareVersions).at(-1)
  if (!latest || !/^\d{1,7}$/.test(latest.text) || Number(latest.text) < 9990) return undefined
  return `the scripts have reached version ${latest.text}; rebaseline with a restart (liftoff rebaseline --restart) so the numbering starts again at 0001`
}

function bump(text: string): string {
  const cut = Math.max(text.lastIndexOf('.'), text.lastIndexOf('_')) + 1
  const last = text.slice(cut)
  const n = (BigInt(last || '0') + 1n).toString()
  // A plain counter has at least four digits; a part of a dotted version keeps its own width.
  return text.slice(0, cut) + n.padStart(cut === 0 ? Math.max(4, last.length) : last.length, '0')
}

/**
 * Replaces `${name}` with its value. When the project uses placeholders (`strict`), a `${name}`
 * without a value is an error naming it; projects without placeholders run their scripts untouched.
 */
export function applyPlaceholders(sql: string, values: Map<string, string>, strict: boolean, script: string): string {
  const missing: string[] = []
  const out = sql.replace(/\$\{([\p{L}\p{N}_.:-]+)\}/gu, (whole, name: string) => {
    const v = values.get(name)
    if (v !== undefined) return v
    if (strict && !missing.includes(name)) missing.push(name)
    return whole
  })
  if (missing.length) throw configError(`${script} uses placeholders with no value: ${missing.join(', ')}`)
  return out
}

/**
 * PostgreSQL statements that cannot run inside a transaction.
 * ponytail: a keyword scan, so a match in a comment or string counts too (the safe direction: the
 * script then runs without a transaction).
 */
export function needsNoTransaction(sql: string): boolean {
  const up = sql.toUpperCase()
  return ['CONCURRENTLY', 'VACUUM', 'CREATE DATABASE', 'DROP DATABASE', 'ALTER SYSTEM', 'CREATE TABLESPACE', 'DROP TABLESPACE'].some((k) => up.includes(k))
}

/**
 * SQLite: VACUUM, and the pragmas that are ignored inside a transaction (switching foreign keys off
 * to rebuild a table, the journal mode), need a script that runs outside one.
 */
export function sqliteNeedsNoTransaction(sql: string): boolean {
  return /\bVACUUM\b|\bPRAGMA\s+(foreign_keys|journal_mode|legacy_alter_table)\b/i.test(sql.replace(/--[^\n]*|\/\*[\s\S]*?\*\//g, ''))
}

/** SQL Server statements that cannot run inside a transaction. */
export function tsqlNeedsNoTransaction(sql: string): boolean {
  const up = sql.toUpperCase()
  return ['CREATE DATABASE', 'ALTER DATABASE', 'DROP DATABASE', 'BACKUP ', 'RESTORE ', 'RECONFIGURE', 'CREATE FULLTEXT', 'ALTER FULLTEXT', 'DROP FULLTEXT'].some((k) =>
    up.includes(k),
  )
}

/**
 * Splits a SQL Server script into batches on `GO` lines, as sqlcmd and SSMS do; `GO 3` runs the
 * batch three times. A GO inside a string or a block comment does not count.
 */
export function splitBatches(sql: string): { sql: string; times: number }[] {
  const out: { sql: string; times: number }[] = []
  let cur = ''
  let inString = false
  let commentDepth = 0
  for (const line of sql.split(/(?<=\n)/)) {
    if (!inString && commentDepth === 0) {
      const words = line.trim().split('--')[0].trim().split(/\s+/).filter(Boolean)
      const count = words[1]
      if (words[0]?.toLowerCase() === 'go' && words.length <= 2 && (count === undefined || /^\d+$/.test(count))) {
        if (cur.trim()) out.push({ sql: cur, times: count === undefined ? 1 : Number(count) })
        cur = ''
        continue
      }
    }
    for (let i = 0; i < line.length; i++) {
      const c = line[i]
      const next = line[i + 1]
      if (c === "'" && commentDepth === 0) inString = !inString
      else if (c === '-' && next === '-' && !inString && commentDepth === 0) break
      else if (c === '/' && next === '*' && !inString) {
        commentDepth++
        i++
      } else if (c === '*' && next === '/' && !inString && commentDepth > 0) {
        commentDepth--
        i++
      }
    }
    cur += line
  }
  if (cur.trim()) out.push({ sql: cur, times: 1 })
  return out
}

/**
 * Splits a PostgreSQL script into statements on `;`, respecting quotes, dollar quotes and
 * comments. Only needed for scripts that run outside a transaction (each statement is then its
 * own implicit one).
 */
export function splitStatements(sql: string): string[] {
  const out: string[] = []
  const push = (s: string) => {
    if (s.split('\n').some((l) => l.trim() && !l.trim().startsWith('--'))) out.push(s.trim())
  }
  let start = 0
  for (let i = 0; i < sql.length; i++) {
    const c = sql[i]
    if (c === "'" || c === '"') {
      i++
      while (i < sql.length && sql[i] !== c) i++
    } else if (c === '-' && sql[i + 1] === '-') {
      while (i < sql.length && sql[i] !== '\n') i++
    } else if (c === '/' && sql[i + 1] === '*') {
      i += 2
      while (i + 1 < sql.length && !(sql[i] === '*' && sql[i + 1] === '/')) i++
      i++
    } else if (c === '$') {
      // $tag$ ... $tag$ (the tag may be empty)
      const end = sql.indexOf('$', i + 1)
      if (end > 0) {
        const tag = sql.slice(i, end + 1)
        if (/^\$[\p{L}\p{N}_]*\$$/u.test(tag)) {
          const close = sql.indexOf(tag, i + tag.length)
          if (close >= 0) i = close + tag.length - 1
        }
      }
    } else if (c === ';') {
      push(sql.slice(start, i))
      start = i + 1
    }
  }
  push(sql.slice(Math.min(start, sql.length)))
  return out
}
