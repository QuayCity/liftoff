// Keeping V1, V2, V3 when people work on branches at the same time: the scripts a branch adds must
// come after everything on the main branch. `check` says which do not; `renumber` moves them to
// the next free numbers (with their undo scripts). Scripts already on the main branch never move.
// Versions then follow merge order: no two V5s, no script older than one already deployed.

import * as fs from 'node:fs'
import * as path from 'node:path'
import type { Config } from './config.ts'
import { configError, validateError } from './errors.ts'
import { filesAt } from './git.ts'
import { compareVersions, nextVersion, parseName, parseVersion, type Script, type Version } from './migration.ts'

export type Renamed = { from: string; to: string }

export type OrderReport = {
  /** the branch compared with, e.g. origin/main */
  base: string
  /** the newest version on it */
  latest: string | null
  /** versioned, undo and baseline scripts this branch adds */
  added: string[]
  /** added scripts numbered at or below `latest` */
  behind: string[]
  /** what renumbering did (only when asked to) */
  renamed: Renamed[]
}

type File = { name: string; full: string; kind: string; version: Version }

/** The script files in the migrations folder, read by name only (two V5s are fine here). */
function local(dir: string): File[] {
  const out: File[] = []
  const entries = fs.existsSync(dir) ? (fs.readdirSync(dir, { recursive: true, withFileTypes: true }) as fs.Dirent[]) : []
  for (const e of entries) {
    const p = e.isFile() ? parseName(e.name) : undefined
    const v = p?.version !== undefined ? parseVersion(p.version) : undefined
    if (p && v) out.push({ name: e.name, full: path.join(e.parentPath, e.name), kind: p.kind, version: v })
  }
  return out
}

/** Compares the branch's new scripts with `base`; with `apply`, renames those that are behind. */
export function versionsAfter(cfg: Config, base: string, apply: boolean, now = new Date()): OrderReport {
  const dir = cfg.migrationsDir()
  const onBase = new Set(filesAt(cfg.root, base, dir))
  const baseVersions = [...onBase].map((n) => parseName(n)?.version).filter((v): v is string => !!v).map((v) => parseVersion(v)!)
  const latest = baseVersions.sort(compareVersions).at(-1)
  const files = local(dir)
  const added = files.filter((f) => !onBase.has(f.name))
  const isBehind = (f: File) => f.kind !== 'undo' && latest !== undefined && compareVersions(f.version, latest) <= 0
  const behind = added.filter(isBehind)
  const report: OrderReport = { base, latest: latest?.text ?? null, added: added.map((f) => f.name).sort(), behind: behind.map((f) => f.name).sort(), renamed: [] }
  if (!apply) {
    if (behind.length) {
      throw validateError(
        `${behind.length} new script(s) are not numbered after ${base} (its newest is ${latest!.text}):\n${report.behind.map((n) => `  ${n}`).join('\n')}\n` +
          `Run \`liftoff renumber --after ${base}\` (the pipeline does this when it writes the scripts).`,
      )
    }
    return report
  }
  const baselines = behind.filter((f) => f.kind === 'baseline')
  if (baselines.length) throw configError(`${baselines.map((f) => f.name).join(', ')}: a baseline script is not renumbered; squash again on top of ${base}`)
  // Versions taken: everything on the base, and the new scripts that are fine where they are.
  const taken: Script[] = [...baseVersions, ...added.filter((f) => !isBehind(f) && f.kind === 'versioned').map((f) => f.version)].map(
    (version) => ({ kind: 'versioned', version }) as Script,
  )
  for (const f of behind.sort((a, b) => compareVersions(a.version, b.version))) {
    const to = nextVersion(taken, now)
    taken.push({ kind: 'versioned', version: parseVersion(to)! } as Script)
    // The script and its undo script move together.
    const moving = added.filter((x) => (x === f || x.kind === 'undo') && compareVersions(x.version, f.version) === 0).sort((a, b) => Number(a.kind === 'undo') - Number(b.kind === 'undo'))
    for (const g of moving) {
      const prefix = g.kind === 'undo' ? 'U' : 'V'
      const name = `${prefix}${to}__${g.name.slice(g.name.indexOf('__') + 2)}`
      fs.renameSync(g.full, path.join(path.dirname(g.full), name))
      report.renamed.push({ from: g.name, to: name })
    }
  }
  return report
}
