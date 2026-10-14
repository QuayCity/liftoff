// The schema model (S05, C13): one readable file per object under schema-model/, so git keeps
// the history of every table, view and function. Compared as text with what dev would write.

import * as fs from 'node:fs'
import * as path from 'node:path'
import type { ChangeKind } from './changes.ts'
import type { Config } from './config.ts'
import type { Change } from './changes.ts'
import { dialect, open, type Conn } from './db.ts'
import { diffSchemas, modelOf, notComparedBetween, rebuildScratch, scratchEnv, type Comparison } from './diff.ts'
import { configError, DbError, ModelInvalidError } from './errors.ts'
import { quiet, type Log } from './runner.ts'
import { ops } from './engines.ts'

export const FOLDER = 'schema-model'

export type ModelChange = {
  /** relative to schema-model/, with `/` */
  path: string
  /** tables, views, functions, … */
  object_type: string
  kind: ChangeKind
  /** the file as it is (null when new) */
  before: string | null
  /** what dev has (null when the object is gone) */
  after: string | null
}

/** The folders objects are filed under: <type>/<schema>.<name>.sql. */
const TYPES = new Set(['tables', 'views', 'materialized-views', 'functions', 'procedures', 'triggers', 'sequences', 'types', 'domains'])

/**
 * LiftOff 0.1 filed objects as <schema>/<type>/<name>.sql. Moves those files to
 * <type>/<schema>.<name>.sql, so the same name in two schemas stays apart by its file name too.
 * git sees renames, so each object keeps its history. Returns how many files moved.
 */
export function upgradeLayout(root: string, log: Log = quiet): number {
  const base = path.join(root, FOLDER)
  if (!fs.existsSync(base)) return 0
  let moved = 0
  for (const f of fs.readdirSync(base, { recursive: true, withFileTypes: true }) as fs.Dirent[]) {
    if (!f.isFile() || !f.name.endsWith('.sql')) continue
    const parts = path.relative(base, path.join(f.parentPath, f.name)).split(path.sep)
    if (parts.length !== 3 || !TYPES.has(parts[1])) continue
    const [schema, type, name] = parts
    const to = path.join(base, type, `${schema}.${name}`)
    if (fs.existsSync(to)) {
      log('warn', `${FOLDER}/${parts.join('/')} not moved: ${FOLDER}/${type}/${schema}.${name} already exists`)
      continue
    }
    fs.mkdirSync(path.dirname(to), { recursive: true })
    fs.renameSync(path.join(base, ...parts), to)
    moved++
  }
  if (!moved) return 0
  // The <schema>/<type>/ folders that are empty now.
  for (const d of fs.readdirSync(base, { withFileTypes: true })) {
    if (!d.isDirectory() || TYPES.has(d.name) || d.name === 'extensions') continue
    const dir = path.join(base, d.name)
    for (const sub of fs.readdirSync(dir)) if (TYPES.has(sub) && !fs.readdirSync(path.join(dir, sub)).length) fs.rmdirSync(path.join(dir, sub))
    if (!fs.readdirSync(dir).length) fs.rmdirSync(dir)
  }
  log('info', `Moved ${moved} file(s) in ${FOLDER}/ to the layout <type>/<schema>.<name>.sql; commit the renames`)
  return moved
}

function readFolder(root: string, log: Log = quiet): Map<string, string> {
  const base = path.join(root, FOLDER)
  const out = new Map<string, string>()
  if (!fs.existsSync(base)) return out
  upgradeLayout(root, log)
  for (const f of fs.readdirSync(base, { recursive: true, withFileTypes: true }) as fs.Dirent[]) {
    if (!f.isFile() || !f.name.endsWith('.sql')) continue
    const full = path.join(f.parentPath, f.name)
    // Compared without line-ending noise from git's autocrlf.
    out.set(path.relative(base, full).replaceAll('\\', '/'), fs.readFileSync(full, 'utf8').replaceAll('\r\n', '\n'))
  }
  return out
}

/** Every file in the schema-model folder, relative to it, sorted (for object history, S20). */
export function listFiles(cfg: Config): string[] {
  return [...readFolder(cfg.root).keys()].sort()
}

/** The differences between the schema-model folder and what dev would write into it. */
export function compareFiles(onDisk: Map<string, string>, dev: Map<string, string>): ModelChange[] {
  const paths = [...new Set([...onDisk.keys(), ...dev.keys()])].sort()
  const out: ModelChange[] = []
  for (const p of paths) {
    const [before, after] = [onDisk.get(p), dev.get(p)]
    let kind: ChangeKind
    if (before === undefined) kind = 'added'
    else if (after === undefined) kind = 'removed'
    else if (before !== after) kind = 'changed'
    else continue
    out.push({ path: p, object_type: p.split('/').at(-2) ?? 'other', kind, before: before ?? null, after: after ?? null })
  }
  return out
}

export async function status(cfg: Config, dev: string | undefined, log: Log = quiet): Promise<ModelChange[]> {
  const [name, env] = cfg.pickRole(dev, 'dev')
  const c = await open(name, env)
  try {
    const s = await modelOf(cfg, c)
    const files = ops[s.engine].files(s.model)
    return compareFiles(readFolder(cfg.root, log), files)
  } finally {
    await c.close()
  }
}

/** Writes (or deletes) exactly the given changes; files outside schema-model/ are refused. */
export function save(cfg: Config, changes: ModelChange[]): number {
  const base = path.join(cfg.root, FOLDER)
  for (const c of changes) {
    if (c.path.includes('..') || path.isAbsolute(c.path) || !c.path.endsWith('.sql')) throw configError(`'${c.path}' is not a schema-model file`)
    const file = path.join(base, c.path)
    if (c.after !== null) {
      fs.mkdirSync(path.dirname(file), { recursive: true })
      fs.writeFileSync(file, c.after)
    } else {
      fs.rmSync(file, { force: true })
    }
  }
  return changes.length
}

/* ---------- the schema model as the source of truth ---------- */

/** Which kinds of object are created first; dependencies the order misses are retried. */
const ORDER = ['extensions', 'types', 'domains', 'sequences', 'tables', 'functions', 'views', 'materialized-views', 'procedures', 'triggers']
const rank = (file: string) => {
  const kind = file.split('/').at(-2) ?? ''
  const i = ORDER.indexOf(kind)
  return i < 0 ? ORDER.length : i
}

/** Only the given schema-model files (relative to schema-model/); all of them when not given. */
export function pick(changes: ModelChange[], only: string[] | undefined): ModelChange[] {
  if (!only?.length) return changes
  const wanted = new Set(only.map((p) => p.replaceAll('\\', '/').replace(/^schema-model\//, '')))
  const missing = [...wanted].filter((w) => !changes.some((c) => c.path === w))
  if (missing.length) throw configError(`not a change between dev and the schema model: ${missing.join(', ')}`)
  return changes.filter((c) => wanted.has(c.path))
}

/**
 * Builds the schema-model files into the (empty) database `c` is connected to. Each file runs in
 * its own transaction; files that fail because something they need is not there yet are tried
 * again, pass by pass, until everything is in. When a pass makes no progress, what is left are
 * real errors in those files.
 */
export async function applyModel(cfg: Config, c: Conn, log: Log = quiet): Promise<number> {
  const files = [...readFolder(cfg.root, log)].sort(([a], [b]) => rank(a) - rank(b) || (a < b ? -1 : a > b ? 1 : 0))
  if (!files.length) throw configError(`the ${FOLDER} folder is empty; save dev into it first (liftoff model)`)
  const d = dialect[c.engine]
  let todo = files
  let problems: { path: string; message: string }[] = []
  while (todo.length) {
    const left: [string, string][] = []
    problems = []
    for (const [file, sql] of todo) {
      const transactional = !d.needsNoTransaction(sql)
      try {
        if (transactional) await c.batch(d.begin)
        await c.script(sql, transactional)
        if (transactional) await c.batch('COMMIT')
      } catch (e) {
        if (transactional) await c.batch('ROLLBACK').catch(() => {})
        left.push([file, sql])
        problems.push({ path: file, message: e instanceof DbError ? e.detail : e instanceof Error ? e.message : String(e) })
      }
    }
    if (left.length === todo.length) throw new ModelInvalidError(problems)
    todo = left
  }
  log('info', `Built ${files.length} object file(s) from ${FOLDER}/`)
  return files.length
}

/** Checks that the schema model builds, on the scratch database. */
export async function check(cfg: Config, scratch: string | undefined, log: Log = quiet): Promise<number> {
  const [name, env] = scratchEnv(cfg, scratch)
  log('info', `Building ${FOLDER}/ on '${name}'`)
  const c = await open(name, env)
  try {
    await c.resetSchemas(cfg.project.schemas)
    return await applyModel(cfg, c, log)
  } finally {
    await c.close()
  }
}

/**
 * The schema model against the migrations: what a new migration must change so the scripts build
 * what the files describe. One scratch database, used twice: built from the scripts, then from the
 * files. No dev database needed, so it runs in a pipeline.
 */
export async function versusMigrations(cfg: Config, scratch: string | undefined, log: Log = quiet): Promise<Comparison> {
  const [name, env] = scratchEnv(cfg, scratch)
  const s = await rebuildScratch(cfg, name, env, undefined, log)
  try {
    const target = await modelOf(cfg, s)
    log('info', `Building ${FOLDER}/ on '${name}'`)
    await s.resetSchemas(cfg.project.schemas)
    await applyModel(cfg, s, log)
    const source = await modelOf(cfg, s)
    const changes: Change[] = diffSchemas(source, target)
    const notCompared = notComparedBetween(source, target, 'the schema model', 'the scripts')
    log('info', `${changes.length} difference(s) between the schema model and the scripts`)
    return { changes, not_compared: notCompared }
  } finally {
    await s.close()
  }
}
