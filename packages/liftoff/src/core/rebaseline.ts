// Rebaselining a project: one baseline script (B…) replaces the versioned scripts up to a version,
// and those scripts leave the migrations folder. Empty databases start from the baseline; databases
// that already ran the old scripts see them as covered by it. Fewer files, same result.
//
// The baseline is checked first (squash builds it on the scratch database and compares it with
// what the scripts build); only then are files removed. Removing means deleting files that are
// committed to git (their history stays there), or moving them to an archive folder.

import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import type { Config } from './config.ts'
import { diffSchemas, modelOf, rebuildScratch, save, scratchEnv, squash } from './diff.ts'
import { configError } from './errors.ts'
import { run as git } from './git.ts'
import { compareVersions, parseVersion, RESTART_MARK, scan } from './migration.ts'
import { quiet, type Log } from './runner.ts'

export type RebaselineOptions = {
  /** the last version to fold in (default: all of them) */
  upTo?: string
  description?: string
  scratch?: string
  /** move the old scripts into this folder (relative to the project) instead of deleting them */
  archive?: string
  /**
   * Start the numbering again: the baseline is B0001 and replaces every script. Databases that ran
   * the old ones are checked against it on their next migrate (liftoff migrate does that).
   */
  restart?: boolean
}

export type Rebaselined = {
  baseline: string
  version: string
  /** the scripts taken out of the migrations folder */
  removed: string[]
  /** where they went, when archived */
  archived_to: string | null
}

/**
 * B0001 for a restart: what every script builds, captured; then checked by building it alone (the
 * old scripts set aside) and comparing. If the two differ, everything is put back as it was.
 */
async function restartBaseline(cfg: Config, files: string[], o: RebaselineOptions, log: Log) {
  const dir = cfg.migrationsDir()
  const [name, env] = scratchEnv(cfg, o.scratch)
  const before = await rebuildScratch(cfg, name, env, undefined, log)
  let expected
  try {
    expected = await modelOf(cfg, before)
  } finally {
    await before.close()
  }
  const { generated: g } = await squash(cfg, undefined, o.description ?? 'baseline', o.scratch, true, log)
  const replaced = g.version
  g.version = '0001'
  g.file_name = `B0001__${g.file_name.slice(g.file_name.indexOf('__') + 2)}`
  g.sql = `${RESTART_MARK}: the numbering starts again here; this replaces the scripts up to ${replaced}.\n${g.sql}`
  // The old scripts wait here while the new baseline is checked on its own.
  const held = fs.mkdtempSync(path.join(os.tmpdir(), 'liftoff-rebaseline-'))
  const putBack = () => {
    for (const f of files) {
      const from = path.join(held, path.relative(dir, f))
      if (fs.existsSync(from)) {
        fs.mkdirSync(path.dirname(f), { recursive: true })
        fs.renameSync(from, f)
      }
    }
  }
  for (const f of files) {
    const to = path.join(held, path.relative(dir, f))
    fs.mkdirSync(path.dirname(to), { recursive: true })
    fs.renameSync(f, to)
  }
  let file: string | undefined
  try {
    file = save(cfg, g.file_name, g.sql)
    log('info', `Checking: rebuilding '${name}' from ${g.file_name} alone`)
    const after = await rebuildScratch(cfg, name, env, undefined, log)
    let actual
    try {
      actual = await modelOf(cfg, after)
    } finally {
      await after.close()
    }
    const left = diffSchemas(expected, actual)
    if (left.length) throw configError(`the baseline does not build the same schema (${left.map((c) => c.id).join(', ')}); nothing was changed`)
  } catch (e) {
    if (file) fs.rmSync(file, { force: true })
    putBack()
    fs.rmSync(held, { recursive: true, force: true })
    throw e
  }
  return { generated: g, path: file, held }
}

export async function rebaseline(cfg: Config, o: RebaselineOptions = {}, log: Log = quiet): Promise<Rebaselined> {
  const dir = cfg.migrationsDir()
  const archive = o.archive ? path.resolve(cfg.root, o.archive) : null
  if (archive && (archive === dir || archive.startsWith(dir + path.sep))) throw configError('the archive folder must be outside the migrations folder')
  // What will go: decided before anything is written, so a refusal changes nothing.
  if (o.restart && o.upTo !== undefined) throw configError('a restart replaces every script; leave out --up-to')
  const upTo = o.upTo !== undefined ? parseVersion(o.upTo) : undefined
  if (o.upTo !== undefined && !upTo) throw configError(`'${o.upTo}' is not a version`)
  const going = (version: ReturnType<typeof parseVersion>) => !upTo || compareVersions(version!, upTo) <= 0
  const candidates = scan(dir).filter((s) => (s.kind === 'versioned' || s.kind === 'undo' || s.kind === 'baseline') && s.version && going(s.version))
  // A restart may also renumber a project that is only a baseline script by now.
  if (!candidates.some((s) => s.kind === 'versioned' || (o.restart && s.kind === 'baseline'))) throw configError('there are no versioned scripts to fold into a baseline')
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

  let held: string | undefined
  let made: Awaited<ReturnType<typeof squash>>
  if (o.restart) {
    const r = await restartBaseline(cfg, candidates.map((s) => s.path), o, log)
    made = r
    held = r.held
  } else {
    made = await squash(cfg, o.upTo, o.description ?? 'baseline', o.scratch, false, log)
  }
  const { generated, path: written } = made
  const removed: string[] = []
  for (const s of candidates) {
    // The new baseline itself stays; an older one has nothing left to do.
    if (s.fileName === generated.file_name && !o.restart) continue
    // A restart already set the old scripts aside (in `held`) to check the new baseline alone.
    if (o.restart) {
      const from = path.join(held!, path.relative(dir, s.path))
      if (archive) {
        const to = path.join(archive, path.relative(dir, s.path))
        fs.mkdirSync(path.dirname(to), { recursive: true })
        fs.renameSync(from, to)
      }
      removed.push(s.fileName)
      continue
    }
    if (archive) {
      const to = path.join(archive, path.relative(dir, s.path))
      fs.mkdirSync(path.dirname(to), { recursive: true })
      fs.renameSync(s.path, to)
    } else {
      fs.rmSync(s.path)
    }
    removed.push(s.fileName)
  }
  if (held) fs.rmSync(held, { recursive: true, force: true })
  log('info', `${generated.file_name} replaces ${removed.length} script(s)`)
  return { baseline: written!, version: generated.version, removed: removed.sort(), archived_to: archive }
}
