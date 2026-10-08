import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { test } from 'node:test'
import { GitError } from './errors.ts'
import { classify, commit, diff, parseStatus, pull, push, run, status } from './git.ts'

test('reads git status --porcelain=v2', () => {
  const raw =
    '# branch.oid abc\0# branch.head main\0# branch.upstream origin/main\0# branch.ab +2 -1\0' +
    '1 .M N... 100644 100644 100644 aa bb migrations/V1__a.sql\0' +
    '1 A. N... 000000 100644 100644 00 cc liftoff.toml\0' +
    '2 R. N... 100644 100644 100644 dd dd R100 migrations/V3__new name.sql\0migrations/V3__old.sql\0' +
    '? migrations/V4__b.sql\0'
  const s = parseStatus(raw)
  assert.deepEqual([s.branch, s.upstream, s.ahead, s.behind], ['main', 'origin/main', 2, 1])
  assert.deepEqual(
    s.files.map((f) => [f.path, f.change]),
    [
      ['migrations/V1__a.sql', 'modified'],
      ['liftoff.toml', 'added'],
      ['migrations/V3__new name.sql', 'renamed'],
      ['migrations/V4__b.sql', 'untracked'],
    ],
  )
})

test('classifies git failures', () => {
  assert.equal(classify('! [rejected] main -> main (fetch first)\nerror: failed to push'), 'push_rejected')
  assert.equal(classify('fatal: not a git repository (or any of the parent directories): .git'), 'not_a_repository')
  assert.equal(classify('fatal: Not possible to fast-forward, aborting.'), 'diverged')
})

test('a real repository with a remote: commit, push, rejected push, no merge on pull', () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'lo-git-'))
  const [remote, a, b] = [path.join(base, 'remote.git'), path.join(base, 'a'), path.join(base, 'b')]
  fs.mkdirSync(a)
  run(base, ['init', '--bare', '-b', 'main', remote])
  run(a, ['init', '-b', 'main'])
  const identity = (dir: string, name: string) => {
    for (const [k, v] of [['user.name', name], ['user.email', `${name.toLowerCase()}@example.test`], ['commit.gpgsign', 'false']]) run(dir, ['config', k, v])
  }
  identity(a, 'Test')
  run(a, ['remote', 'add', 'origin', remote])
  fs.mkdirSync(path.join(a, 'migrations'))
  fs.writeFileSync(path.join(a, 'migrations/V1__a.sql'), 'select 1;\n')
  fs.writeFileSync(path.join(a, 'notes.txt'), 'not part of the commit\n')

  assert.equal(status(a).files.length, 2)
  assert.equal(diff(a, 'migrations/V1__a.sql'), 'select 1;\n')
  commit(a, ['migrations/V1__a.sql'], 'add V1')
  assert.deepEqual(status(a).files.map((f) => f.path), ['notes.txt'], 'only the chosen file was committed')
  push(a)
  assert.equal(status(a).upstream, 'origin/main')

  run(base, ['clone', remote, b])
  identity(b, 'Other')
  fs.writeFileSync(path.join(b, 'migrations/V2__b.sql'), 'select 2;\n')
  commit(b, ['migrations/V2__b.sql'], 'add V2')
  push(b)

  fs.writeFileSync(path.join(a, 'migrations/V3__c.sql'), 'select 3;\n')
  commit(a, ['migrations/V3__c.sql'], 'add V3')
  assert.throws(() => push(a), (e: unknown) => e instanceof GitError && e.kind === 'push_rejected')
  // Diverged history: a fast-forward pull refuses rather than merging behind the user's back.
  assert.throws(() => pull(a), (e: unknown) => e instanceof GitError && e.kind === 'diverged')
})
