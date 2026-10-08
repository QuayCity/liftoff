// The schema model (S05, C13): one readable file per object under schema-model/, so git keeps
// the history of every table, view and function. Compared as text with what dev would write.

import * as fs from 'node:fs'
import * as path from 'node:path'
import type { ChangeKind } from './changes.ts'
import type { Config } from './config.ts'
import { open } from './db.ts'
import { modelOf } from './diff.ts'
import { configError } from './errors.ts'
import * as ms from './msdiff.ts'
import * as pgd from './pgdiff.ts'

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

function readFolder(root: string): Map<string, string> {
  const base = path.join(root, FOLDER)
  const out = new Map<string, string>()
  if (!fs.existsSync(base)) return out
  for (const f of fs.readdirSync(base, { recursive: true, withFileTypes: true }) as fs.Dirent[]) {
    if (!f.isFile() || !f.name.endsWith('.sql')) continue
    const full = path.join(f.parentPath, f.name)
    // Compared without line-ending noise from git's autocrlf.
    out.set(path.relative(base, full).replaceAll('\\', '/'), fs.readFileSync(full, 'utf8').replaceAll('\r\n', '\n'))
  }
  return out
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

export async function status(cfg: Config, dev: string | undefined): Promise<ModelChange[]> {
  const [name, env] = cfg.pickRole(dev, 'dev')
  const c = await open(name, env)
  try {
    const s = await modelOf(cfg, c)
    const files = s.engine === 'pg' ? pgd.files(s.model) : ms.files(s.model)
    return compareFiles(readFolder(cfg.root), files)
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
