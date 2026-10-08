// The CLI wrapper against the real liftoff program (the single-file build: npm run build:cli in packages/liftoff).
// Set LIFTOFF_CLI to use another build.

import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { test } from 'node:test'
import { findBinary, LiftoffError, parseAnswer, runCli } from '../cli'
import type { Project } from '../model'

const repo = path.resolve(__dirname, '../../../..')
const binary = process.env.LIFTOFF_CLI ?? path.join(repo, 'packages', 'liftoff', 'build', process.platform === 'win32' ? 'liftoff.exe' : 'liftoff')

test('parseAnswer finds the JSON line', () => {
  assert.deepEqual(parseAnswer('noise\n{"ok":true,"result":[1]}\n'), { ok: true, result: [1] })
  assert.equal(parseAnswer('not json'), undefined)
})

test('findBinary prefers the setting, then the shipped program, then PATH', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lo-ext-'))
  assert.equal(findBinary(dir, ' /opt/liftoff '), '/opt/liftoff')
  assert.equal(findBinary(dir, ''), 'liftoff')
  fs.mkdirSync(path.join(dir, 'bin'))
  const shipped = path.join(dir, 'bin', process.platform === 'win32' ? 'liftoff.exe' : 'liftoff')
  fs.writeFileSync(shipped, '')
  assert.equal(findBinary(dir, ''), shipped)
})

test('runs the real CLI: a project, a CLI error, a missing program', { skip: !fs.existsSync(binary) && `no CLI at ${binary}` }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lo-ext-'))
  execFileSync(binary, ['-C', dir, 'init', '--name', 'shop'])
  fs.appendFileSync(path.join(dir, 'liftoff.toml'), '\n[environments.test]\nurl = "postgres://localhost:1/none"\nrole = "test"\n')

  const project = await runCli<Project>(binary, ['project'], { projectDir: dir })
  assert.equal(project.name, 'shop')
  assert.equal(project.migrations, 'migrations')
  assert.deepEqual(project.environments.map((e) => [e.name, e.role, e.engine]), [['test', 'test', 'PostgreSQL']])

  await assert.rejects(runCli(binary, ['info'], { projectDir: dir, environment: 'nope' }), (e: unknown) => {
    assert.ok(e instanceof LiftoffError)
    assert.equal(e.report.code, 'LIFTOFF_CONFIG')
    assert.match(e.message, /no environment 'nope'/)
    return true
  })

  await assert.rejects(runCli('/no/such/liftoff', ['project'], { projectDir: dir }), (e: unknown) => e instanceof LiftoffError && e.report.code === 'LIFTOFF_NOT_STARTED')
})
