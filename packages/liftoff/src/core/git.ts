// Version control for the Commit workspace (S14), through the user's own `git`, so their
// credentials, hooks and SSH config apply. Never prompts: a credential prompt fails instead.

import { spawnSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { configError, GitError, type GitErrorKind } from './errors.ts'

export type FileChange = {
  path: string
  /** added, modified, deleted, renamed, untracked, conflicted */
  change: string
}

export type Status = {
  branch: string | null
  upstream: string | null
  ahead: number
  behind: number
  files: FileChange[]
}

function git(root: string, args: string[]): string {
  const r = spawnSync('git', args, { cwd: root, env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_ASKPASS: '' }, encoding: 'utf8', windowsHide: true })
  if (r.error) throw configError(`git could not be started (${r.error.message}); install Git and make sure it is on PATH`)
  if (r.status === 0) return r.stdout
  const err = r.stderr.trim()
  throw new GitError(classify(err), err)
}

/** Stable codes for the failures the app has a specific answer to. */
export function classify(stderr: string): GitErrorKind {
  const e = stderr.toLowerCase()
  if (e.includes('not a git repository')) return 'not_a_repository'
  if (e.includes('rejected') && (e.includes('fetch first') || e.includes('non-fast-forward'))) return 'push_rejected'
  if (e.includes('no upstream') || e.includes('has no upstream branch')) return 'no_upstream'
  if (e.includes('not possible to fast-forward') || e.includes('diverging branches')) return 'diverged'
  if (e.includes('authentication') || e.includes('could not read username') || e.includes('permission denied')) return 'auth'
  return 'other'
}

export function status(root: string): Status {
  return parseStatus(git(root, ['status', '--porcelain=v2', '--branch', '--untracked-files=all', '-z']))
}

export function parseStatus(raw: string): Status {
  const s: Status = { branch: null, upstream: null, ahead: 0, behind: 0, files: [] }
  const entries = raw.split('\0').filter(Boolean)
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i]
    if (e.startsWith('# branch.head ')) {
      const h = e.slice('# branch.head '.length)
      s.branch = h === '(detached)' ? null : h
    } else if (e.startsWith('# branch.upstream ')) s.upstream = e.slice('# branch.upstream '.length)
    else if (e.startsWith('# branch.ab ')) {
      const [a, b] = e.slice('# branch.ab '.length).split(' ')
      s.ahead = Number(a?.replace('+', '')) || 0
      s.behind = Number(b?.replace('-', '')) || 0
    } else if (e.startsWith('? ')) s.files.push({ path: e.slice(2), change: 'untracked' })
    else if (e.startsWith('1 ') || e.startsWith('2 ')) {
      // "1 XY sub mH mI mW hH hI path" / "2 XY … Xscore path\0origPath"
      const renamed = e.startsWith('2')
      const fields = splitN(e, ' ', renamed ? 10 : 9)
      const xy = fields[1]
      if (renamed) i++ // the original path of a rename
      const change = renamed ? 'renamed' : xy.includes('D') ? 'deleted' : xy.includes('A') ? 'added' : 'modified'
      s.files.push({ path: fields.at(-1)!, change })
    } else if (e.startsWith('u ')) s.files.push({ path: e.split(' ').at(-1)!, change: 'conflicted' })
  }
  return s
}

/** Splits into at most `n` parts; the last part keeps any remaining separators (paths with spaces). */
function splitN(s: string, sep: string, n: number): string[] {
  const parts = s.split(sep)
  return [...parts.slice(0, n - 1), parts.slice(n - 1).join(sep)]
}

/** The change to one file: a diff for tracked files, the whole content for untracked ones. */
export function diff(root: string, file: string): string {
  if (!git(root, ['ls-files', '--', file]).trim()) {
    try {
      return fs.readFileSync(path.join(root, file), 'utf8')
    } catch {
      return ''
    }
  }
  return git(root, ['diff', 'HEAD', '--', file])
}

/** Commits exactly these paths (new files included), nothing else that happens to be staged. */
export function commit(root: string, paths: string[], message: string): string {
  if (!paths.length) throw configError('choose at least one file to commit')
  if (!message.trim()) throw configError('write a commit message')
  git(root, ['add', '--all', '--', ...paths])
  git(root, ['commit', '-m', message.trim(), '--', ...paths])
  return git(root, ['rev-parse', '--short', 'HEAD']).trim()
}

/** Pushes the current branch; sets the upstream on its first push. */
export function push(root: string): void {
  const st = status(root)
  if (st.upstream) git(root, ['push'])
  else if (st.branch) git(root, ['push', '--set-upstream', 'origin', st.branch])
  else throw configError('not on a branch; check out a branch to push')
}

/** Fast-forward only: a pull never creates a merge commit from inside LiftOff. */
export function pull(root: string): void {
  git(root, ['pull', '--ff-only'])
}

/** For tests: run git and return its output. */
export const run = git
