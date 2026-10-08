import assert from 'node:assert/strict'
import * as path from 'node:path'
import { test } from 'node:test'

// The settings page's logic, loaded from the file the webview runs.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const page = require(path.join(__dirname, '../../media/settings.js')) as {
  changeOf: (original: unknown, state: unknown) => Record<string, unknown>
  problemsOf: (state: unknown) => Record<string, string>
}

const original = {
  project: { name: 'shop', engine: 'postgresql', migrations: 'migrations', schemas: ['public'], history_table: 'h', filters: [], lock: 'advisory', placeholders: {} },
  environments: [
    { name: 'dev', url: 'postgres://db/dev', user: null, role: 'dev', allow_clean: true, placeholders: {}, shared: true, has_password: false },
    { name: 'prod', url: 'postgres://app@db/prod', user: 'app', role: 'prod', allow_clean: false, placeholders: {}, shared: true, has_password: true },
  ],
}
const stateOf = () => ({
  project: structuredClone(original.project),
  environments: original.environments.map((e) => ({ ...structuredClone(e), password: '', isNew: false })),
  removed: [] as string[],
})

test('nothing changed: nothing to send', () => {
  assert.deepEqual(page.changeOf(original, stateOf()), {})
  const s = stateOf()
  s.environments[0].user = '  ' // blank is the same as none
  assert.deepEqual(page.changeOf(original, s), {})
})

test('only what changed is sent; a password only when typed', () => {
  const s = stateOf()
  s.project.schemas = ['public', 'sales']
  s.environments[1].password = 'new-secret'
  s.environments.splice(0, 1)
  s.removed.push('dev')
  s.environments.push({ name: 'qa', url: ' postgres://db/qa ', user: 'app', role: 'test', allow_clean: false, placeholders: {}, shared: false, has_password: false, password: '', isNew: true })
  const c = page.changeOf(original, s) as { project: { schemas: string[]; engine?: string }; environments: { name: string; url: string; password?: string }[]; remove: string[] }
  assert.deepEqual(c.project.schemas, ['public', 'sales'])
  assert.equal(c.project.engine, undefined, 'the engine is never sent')
  assert.deepEqual(c.environments.map((e) => [e.name, e.url, e.password]), [['prod', 'postgres://app@db/prod', 'new-secret'], ['qa', 'postgres://db/qa', undefined]])
  assert.ok(!('password' in c.environments[1]), 'no password key when none was typed')
  assert.deepEqual(c.remove, ['dev'])
})

test('problems are found before saving, on the field they belong to', () => {
  const s = stateOf()
  s.project.name = ' '
  s.project.migrations = '../elsewhere'
  s.environments.push({ ...s.environments[0], name: 'dev', isNew: true })
  s.environments.push({ ...s.environments[0], name: 'bad name', url: '', isNew: true })
  assert.deepEqual(Object.keys(page.problemsOf(s)).sort(), ['env-2-name', 'env-3-name', 'env-3-url', 'project-migrations', 'project-name'])
})
