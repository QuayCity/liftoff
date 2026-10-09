// Rebaselining a project: one baseline script (B…) replaces the versioned scripts up to a version,
// and those scripts leave the migrations folder. Empty databases start from the baseline; databases
// that already ran the old scripts see them as covered by it. Fewer files, same result.
//
// The baseline is checked first (squash builds it on the scratch database and compares it with
// what the scripts build); only then are files removed. Removing means deleting files that are
// committed to git (their history stays there), or moving them to an archive folder.

import * as fs from 'node:fs'
import * as path from 'node:path'
import type { Config } from './config.ts'
import { squash } from './diff.ts'
import { configError } from './errors.ts'
import { run as git } from './git.ts'
import { compareVersions, parseVersion, scan } from './migration.ts'
import { quiet, type Log } from './runner.ts'

export type RebaselineOptions = {
  /** the last version to fold in (default: all of them) */
  upTo?: string
  description?: string
  scratch?: string
  /** move the old scripts into this folder (relative to the project) instead of deleting them */
  archive?: string
}

export type Rebaselined = {
  baseline: string
  version: string
  /** the scripts taken out of the migrations folder */
  removed: string[]
  /** where they went, when archived */
  archived_to: string | null
}

export async function rebaseline(cfg: Config, o: RebaselineOptions = {}, log: Log = quiet): Promise<Rebaselined> {
  const dir = cfg.migrationsDir()
  const archive = o.archive ? path.resolve(cfg.root, o.archive) : null
  if (archive && (archive === dir || archive.startsWith(dir + path.sep))) throw configError('the archive folder must be outside the migrations folder')
  // What will go: decided before anything is written, so a refusal changes nothing.
  const upTo = o.upTo !== undefined ? parseVersion(o.upTo) : undefined
  if (o.upTo !== undefined && !upTo) throw configError(`'${o.upTo}' is not a version`)
  const going = (version: ReturnType<typeof parseVersion>) => !upTo || compareVersions(version!, upTo) <= 0
  const candidates = scan(dir).filter((s) => (s.kind === 'versioned' || s.kind === 'undo' || s.kind === 'baseline') && s.version && going(s.version))
  if (!candidates.some((s) => s.kind === 'versioned')) throw configError('there are no versioned scripts to fold into a baseline')
  if (!archive) {
    // Deleting is safe only when git has them.
    const files = candidates.map((s) => path.relative(cfg.root, s.path))
    let dirty: string
    try {
      git(cfg.root, ['ls-files', '--error-unmatch', '--', ...files])
      dirty = git(cfg.root, ['status', '--porcelain', '--', ...files]).trim()
    } catch {
      throw configError('the scripts to remove are not all committed to git; commit them first, or pass --archive <folder> to move them instead')
    }
    if (dirty) throw configError(`these scripts have changes that are not committed; commit them first, or pass --archive <folder>:\n${dirty}`)
  }

  const { generated, path: written } = await squash(cfg, o.upTo, o.description ?? 'baseline', o.scratch, false, log)
  const removed: string[] = []
  for (const s of candidates) {
    // The new baseline itself stays; an older one has nothing left to do.
    if (s.fileName === generated.file_name) continue
    if (archive) {
      const to = path.join(archive, path.relative(dir, s.path))
      fs.mkdirSync(path.dirname(to), { recursive: true })
      fs.renameSync(s.path, to)
    } else {
      fs.rmSync(s.path)
    }
    removed.push(s.fileName)
  }
  log('info', `${generated.file_name} replaces ${removed.length} script(s)`)
  return { baseline: written!, version: generated.version, removed: removed.sort(), archived_to: archive }
}
