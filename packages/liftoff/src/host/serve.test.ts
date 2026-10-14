import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { Readable } from 'node:stream'
import { test } from 'node:test'
import { serve } from './serve.ts'

test('ui-host: one answer per request, by id; errors as reports; other lines ignored', async () => {
  const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'liftoff-host-'))
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'liftoff-host-project-'))
  const input = Readable.from([
    'not json\n',
    `${JSON.stringify({ id: 1, name: 'recent_projects', args: {} })}\n`,
    `${JSON.stringify({ id: 2, name: 'no_such_command', args: {} })}\n`,
    `${JSON.stringify({ id: 3, name: 'project_open', args: { path: project } })}\n`,
  ])
  const out: string[] = []
  await serve(input, (line) => out.push(line), configDir)
  const answers = out.map((l) => JSON.parse(l)).filter((m) => 'id' in m).sort((a, b) => a.id - b.id)
  assert.equal(answers.length, 3, out.join(''))
  assert.deepEqual(answers[0], { id: 1, ok: true, value: [] })
  assert.equal(answers[1].ok, false)
  assert.match(answers[1].error.message, /unknown command no_such_command/)
  // A folder without liftoff.toml: the same error report the CLI gives, with its code.
  assert.equal(answers[2].ok, false)
  assert.equal(answers[2].error.code, 'LIFTOFF_CONFIG')
  assert.ok(out.every((l) => l.endsWith('\n') && !l.slice(0, -1).includes('\n')), 'one line per message')
})
