import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { test } from 'node:test'
import { Config, init } from './config.ts'
import { LiftoffError } from './errors.ts'
import { versionsAfter } from './renumber.ts'

const git = (dir: string, ...args: string[]) => {
  const r = spawnSync('git', args, { cwd: dir, encoding: 'utf8' })
  assert.equal(r.status, 0, r.stderr)
  return r.stdout
}

/** main has V1, V2 and (merged meanwhile) V3; the branch adds its own V3 with an undo script, and a V4. */
function repo(): { dir: string; cfg: Config; m: (f: string) => string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lo-renum-'))
  git(dir, 'init', '-q', '-b', 'main')
  git(dir, 'config', 'user.email', 'test@example.com')
  git(dir, 'config', 'user.name', 'test')
  init(dir, 'shop', 'postgresql')
  const m = (f: string) => path.join(dir, 'migrations', f)
  fs.writeFileSync(m('V1__a.sql'), 'select 1;\n')
  fs.writeFileSync(m('V2__b.sql'), 'select 2;\n')
  git(dir, 'add', '-A')
  git(dir, 'commit', '-qm', 'base')
  git(dir, 'checkout', '-qb', 'feature')
  fs.writeFileSync(m('V3__mine.sql'), 'select 3;\n')
  fs.writeFileSync(m('U3__mine.sql'), 'select -3;\n')
  fs.writeFileSync(m('V4__also_mine.sql'), 'select 4;\n')
  git(dir, 'add', '-A')
  git(dir, 'commit', '-qm', 'feature')
  git(dir, 'checkout', '-q', 'main')
  fs.writeFileSync(m('V3__theirs.sql'), 'select 33;\n')
  git(dir, 'add', '-A')
  git(dir, 'commit', '-qm', 'merged first')
  git(dir, 'checkout', '-q', 'feature')
  // The branch brings main in: now there are two V3s.
  git(dir, 'merge', '-q', '--no-edit', 'main')
  return { dir, cfg: Config.load(dir), m }
}

test('the check names the new scripts that are not after the base branch', () => {
  const { cfg } = repo()
  assert.throws(() => versionsAfter(cfg, 'main', false), (e: unknown) => e instanceof LiftoffError && e.exitCode === 12 && /V3__mine\.sql/.test(e.message) && !/V4__also_mine/.test(e.message))
  assert.throws(() => versionsAfter(cfg, 'no-such-branch', false), /fetch-depth: 0/)
})

test('renumbering moves them, undo scripts too, after the base and after each other', () => {
  const { cfg, m } = repo()
  const r = versionsAfter(cfg, 'main', true)
  assert.deepEqual(r.renamed, [
    { from: 'V3__mine.sql', to: 'V5__mine.sql' },
    { from: 'U3__mine.sql', to: 'U5__mine.sql' },
  ])
  assert.ok(fs.existsSync(m('V5__mine.sql')) && fs.existsSync(m('U5__mine.sql')) && fs.existsSync(m('V3__theirs.sql')), 'what is on main stays')
  assert.ok(fs.existsSync(m('V4__also_mine.sql')), 'a new script already after main stays')
  assert.equal(versionsAfter(cfg, 'main', false).behind.length, 0)
  assert.deepEqual(versionsAfter(cfg, 'main', true).renamed, [], 'running it again changes nothing')
})
