import assert from 'node:assert/strict'
import * as os from 'node:os'
import { test } from 'node:test'
import { DEFAULT_INSTALL, githubActions } from './ci.ts'
import { Config, type Environment, type Role } from './config.ts'

const env = (role: Role): Environment => ({ url: 'postgres://h/db', role, allow_clean: false, placeholders: {} })

test('stages run in order, with secrets from the repository', () => {
  const cfg = new Config(
    os.tmpdir(),
    { name: 'shop', engine: 'postgresql', migrations: 'migrations', schemas: ['public'], history_table: 'h', filters: [], lock: 'advisory', placeholders: {} },
    new Map([
      ['dev', env('dev')],
      ['staging', env('test')],
      ['prod-eu', env('prod')],
    ]),
  )
  const o = { stages: ['staging', 'prod-eu'], branch: 'main', checks: true, install: DEFAULT_INSTALL }
  const y = githubActions(cfg, o)
  assert.ok(y.includes('  prod-eu:\n') && y.includes('    needs: staging\n'), y)
  assert.ok(y.includes('LIFTOFF_ENV_PROD_EU_PASSWORD: ${{ secrets.LIFTOFF_ENV_PROD_EU_PASSWORD }}'), y)
  assert.ok(y.includes("run: liftoff --environment 'staging' check --drift --report checks-staging.html"), y)
  assert.ok(y.includes("paths: ['migrations/**', 'liftoff.toml']"), y)
  assert.ok(!y.includes('postgres://'), 'no connection details in the file')
  assert.ok(!y.includes('\t'), 'YAML forbids tabs for indentation')
  assert.throws(() => githubActions(cfg, { ...o, stages: ['dev'] }), /dev database/)
})
