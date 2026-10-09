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
}

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
    scripts.push({ kind: parsed.kind, version, description: parsed.description, fileName: f.name, path: file, checksum: checksum(bytes), sql })
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
 * The next number: V1, V2, V3 (the last part goes up by one with its padding kept: `007` -> `008`,
 * `1.9` -> `1.10`). Projects that already use timestamp versions (UTC `yyyyMMdd.HHmm`, often from
 * Flyway) keep getting timestamps, since a small number would sort before them.
 */
export function nextVersion(existing: Script[], now: Date): string {
  const versions = existing.filter((s) => s.kind === 'versioned' && s.version).map((s) => s.version!)
  const latest = versions.sort(compareVersions).at(-1)
  const p = (n: number, w = 2) => String(n).padStart(w, '0')
  const stamp = `${p(now.getUTCFullYear(), 4)}${p(now.getUTCMonth() + 1)}${p(now.getUTCDate())}.${p(now.getUTCHours())}${p(now.getUTCMinutes())}`
  if (!latest) return '1'
  const firstPart = latest.text.split(/[._]/)[0]
  if (firstPart.length >= 8) return compareVersions(parseVersion(stamp), latest) > 0 ? stamp : bump(latest.text)
  return bump(latest.text)
}

function bump(text: string): string {
  const cut = Math.max(text.lastIndexOf('.'), text.lastIndexOf('_')) + 1
  const last = text.slice(cut)
  const n = (BigInt(last || '0') + 1n).toString()
  return text.slice(0, cut) + n.padStart(last.length, '0')
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
