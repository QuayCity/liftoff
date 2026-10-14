// Compare: the schema of any two of these, and what turns one into the other.
//   an environment     dev, test, prod: a database in liftoff.toml
//   a database URL     any database, also one outside the project
//   the schema model   schema-model/, built on the scratch database
//   the migrations     what the scripts build, on the scratch database
//   a snapshot         a schema saved to a file earlier (`liftoff snapshot`), no connection needed
// The differences can be saved as a script, written as the next migration, or applied to the target.

import * as fs from 'node:fs'
import * as path from 'node:path'
import type { Change } from './changes.ts'
import type { Config, Environment } from './config.ts'
import { dialect, open, type Conn } from './db.ts'
import { createAll, diffSchemas, modelOf, notComparedBetween, rebuildScratch, renderScript, scratchEnv, type Schema } from './diff.ts'
import { configError } from './errors.ts'
import { ops, type Model } from './engines.ts'
import { applyModel, FOLDER } from './model.ts'
import { quiet, type Log } from './runner.ts'

/** One side of a comparison. */
export type Side =
  | { kind: 'env'; name: string }
  | { kind: 'url'; url: string }
  | { kind: 'model' }
  | { kind: 'migrations' }
  | { kind: 'snapshot'; file: string }

/**
 * How a side is written on the command line: `model`, `migrations`, `snapshot:<file>` (or a path
 * ending in .json), a URL (`postgres://…`, `sqlserver://…`), else an environment name.
 */
export function parseSide(text: string): Side {
  const t = text.trim()
  if (t === 'model') return { kind: 'model' }
  if (t === 'migrations') return { kind: 'migrations' }
  if (t.startsWith('snapshot:')) return { kind: 'snapshot', file: t.slice('snapshot:'.length) }
  if (/\.json$/i.test(t)) return { kind: 'snapshot', file: t }
  if (/^[a-z]+:\/\//i.test(t) || t.startsWith('sqlserver:')) return { kind: 'url', url: t }
  return { kind: 'env', name: t }
}

/** A side as people read it: `prod`, `the schema model`, `snapshot prod-2026-10.json`. */
export function sideLabel(s: Side): string {
  if (s.kind === 'env') return s.name
  if (s.kind === 'url') return redactedHost(s.url)
  if (s.kind === 'model') return 'the schema model'
  if (s.kind === 'migrations') return 'the migrations'
  return `snapshot ${path.basename(s.file)}`
}

/** `postgres://u:p@host:5432/db` -> `host:5432/db`; never shows a password. */
function redactedHost(url: string): string {
  const m = /^[a-z]+:\/\/(?:[^@/]*@)?([^/;?]+)(\/[^?;]*)?/i.exec(url)
  if (m) return `${m[1]}${m[2] ?? ''}`
  const db = /databaseName=([^;]+)/i.exec(url)?.[1]
  return db ? `SQL Server ${db}` : 'a database'
}

/** A URL outside the project, connected to as an ad hoc environment. */
const urlEnv = (url: string): Environment => ({ url, role: 'test', allow_clean: false, placeholders: {} })

/** Reads one side's schema. Model and migrations use (and erase) the scratch database. */
export async function schemaOf(cfg: Config, side: Side, scratch: string | undefined, log: Log = quiet): Promise<Schema> {
  if (side.kind === 'snapshot') return readSnapshot(cfg, side.file)
  if (side.kind === 'env' || side.kind === 'url') {
    const [name, env] = side.kind === 'env' ? cfg.pick(side.name) : [sideLabel(side), urlEnv(side.url)]
    log('info', `Reading the schema of ${name}`)
    const c = await open(name, env)
    try {
      return await modelOf(cfg, c)
    } finally {
      await c.close()
    }
  }
  const [name, env] = scratchEnv(cfg, scratch)
  const s = await rebuildScratch(cfg, name, env, undefined, log)
  try {
    if (side.kind === 'model') {
      log('info', `Building ${FOLDER}/ on '${name}'`)
      await s.resetSchemas(cfg.project.schemas)
      await applyModel(cfg, s, log)
    }
    return await modelOf(cfg, s)
  } finally {
    await s.close()
  }
}

export type CompareResult = {
  source: string
  target: string
  engine: string
  /** what turns the target into the source, each with its SQL and undo SQL */
  changes: Change[]
  /** objects that exist but are not compared */
  not_compared: string[]
}

/** The differences between two sides: the changes that would make `target` like `source`. */
export async function compare(cfg: Config, source: Side, target: Side, scratch: string | undefined, log: Log = quiet): Promise<CompareResult> {
  if (JSON.stringify(source) === JSON.stringify(target)) throw configError('the source and the target are the same')
  const a = await schemaOf(cfg, source, scratch, log)
  const b = await schemaOf(cfg, target, scratch, log)
  if (a.engine !== b.engine) throw configError(`${sideLabel(source)} is ${engineName(a)} and ${sideLabel(target)} is ${engineName(b)}; compare databases of the same engine`)
  const changes = diffSchemas(a, b)
  const notCompared = notComparedBetween(a, b, sideLabel(source), sideLabel(target))
  log('info', `${changes.length} difference(s)`)
  return { source: sideLabel(source), target: sideLabel(target), engine: engineName(a), changes, not_compared: notCompared }
}

const engineName = (s: Schema) => ops[s.engine].name

/** The chosen changes (`ids`: Change ids; all when not given). */
export function pick(changes: Change[], ids: string[] | undefined): Change[] {
  if (!ids?.length) return changes
  for (const id of ids) if (!changes.some((c) => c.id === id)) throw configError(`'${id}' is not one of the differences; they are: ${changes.map((c) => c.id).join(', ') || 'none'}`)
  return changes.filter((c) => ids.includes(c.id))
}

/** A script that makes the target like the source, for the chosen changes. */
export function syncScript(r: Pick<CompareResult, 'source' | 'target'>, changes: Change[]): string {
  if (!changes.length) throw configError('nothing selected')
  return renderScript(`-- Makes ${r.target} match ${r.source}\n-- Written by LiftOff ${new Date().toISOString()}. Review before running.`, changes)
}

/**
 * Runs the sync script on the target database, in one transaction when the statements allow it.
 * The target's migration history is not touched: afterwards it differs from its scripts (drift).
 */
export async function apply(cfg: Config, target: Side, script: string, log: Log = quiet): Promise<{ target: string; transactional: boolean }> {
  if (target.kind !== 'env' && target.kind !== 'url') throw configError(`only a database can be changed; ${sideLabel(target)} is not one`)
  const [name, env] = target.kind === 'env' ? cfg.pick(target.name) : [sideLabel(target), urlEnv(target.url)]
  const c: Conn = await open(name, env)
  try {
    const d = dialect[c.engine]
    const transactional = !d.needsNoTransaction(script)
    log('info', `Applying the differences to ${name}${transactional ? ' in one transaction' : ' (outside a transaction: some statements need that)'}`)
    if (!transactional) {
      await c.script(script, false)
    } else {
      await c.batch(d.begin)
      try {
        await c.script(script, true)
      } catch (e) {
        await c.batch('ROLLBACK').catch(() => {})
        throw e
      }
      await c.batch('COMMIT')
    }
    return { target: name, transactional }
  } finally {
    await c.close()
  }
}

/* ---------- snapshots ---------- */

const FORMAT = 'liftoff-snapshot'

/** A snapshot file: a schema as read at one moment, readable without a connection. */
export type SnapshotFile = {
  format: typeof FORMAT
  version: 1
  /** the engine's tag (engines.ts): pg, ms, … */
  engine: string
  /** what was read, e.g. `prod` */
  of: string
  taken_at: string
  schemas: string[]
  model: Model
}

// Maps and Sets as tagged arrays, so the model survives JSON.
const replacer = (_k: string, v: unknown) => (v instanceof Map ? { $map: [...v] } : v instanceof Set ? { $set: [...v] } : v)
const reviver = (_k: string, v: unknown) => {
  if (v && typeof v === 'object' && !Array.isArray(v)) {
    const o = v as Record<string, unknown>
    if (Array.isArray(o.$map) && Object.keys(o).length === 1) return new Map(o.$map as [unknown, unknown][])
    if (Array.isArray(o.$set) && Object.keys(o).length === 1) return new Set(o.$set)
  }
  return v
}

/** Saves a side's schema to a file. */
export async function snapshot(cfg: Config, side: Side, file: string, scratch: string | undefined, log: Log = quiet): Promise<{ file: string; objects: number }> {
  if (side.kind === 'snapshot') throw configError('that is already a snapshot')
  const s = await schemaOf(cfg, side, scratch, log)
  const out = path.resolve(cfg.root, file)
  const doc: SnapshotFile = { format: FORMAT, version: 1, engine: s.engine, of: sideLabel(side), taken_at: new Date().toISOString(), schemas: cfg.project.schemas, model: s.model }
  fs.mkdirSync(path.dirname(out), { recursive: true })
  fs.writeFileSync(out, JSON.stringify(doc, replacer, 1) + '\n')
  return { file: out, objects: createAll(s).length }
}

/** Reads a snapshot, with the project's comparison filters applied as for a database. */
export function readSnapshot(cfg: Config, file: string): Schema {
  const p = path.resolve(cfg.root, file)
  if (!fs.existsSync(p)) throw configError(`no snapshot at ${p}`)
  let doc: SnapshotFile
  try {
    doc = JSON.parse(fs.readFileSync(p, 'utf8'), reviver) as SnapshotFile
  } catch (e) {
    throw configError(`${p} is not a LiftOff snapshot: ${e instanceof Error ? e.message : String(e)}`)
  }
  if (doc.format !== FORMAT || doc.version !== 1) throw configError(`${p} is not a LiftOff snapshot (format ${String(doc.format)} ${String(doc.version)})`)
  const o = ops[doc.engine]
  if (!o) throw configError(`${p} is a snapshot of an engine this LiftOff does not know (${String(doc.engine)})`)
  o.applyFilters(doc.model, cfg.project)
  return { engine: doc.engine, model: doc.model }
}

/** For the CLI: is this side a database that apply may change, and is it production? */
export function isProduction(cfg: Config, side: Side): boolean {
  return side.kind === 'env' && cfg.env(side.name).role === 'prod'
}
