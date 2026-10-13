// Scripts for some environments only (-- liftoff:for) and deploying by topic (migrate --topic).

import assert from 'node:assert/strict'
import { test } from 'node:test'
import * as checks from '../src/core/checks.ts'
import { LiftoffError } from '../src/core/errors.ts'
import * as runner from '../src/core/runner.ts'
import { pgSchemaReset, project, sql } from './helpers.ts'

const base = process.env.LIFTOFF_TEST_PG

test('-- liftoff:for and migrate --topic on PostgreSQL', { skip: !base && 'set LIFTOFF_TEST_PG' }, async () => {
  const p = project('postgresql', [
    ['dev', `${base}/shop_dev`, 'dev'],
    ['scratch', `${base}/shop_scratch`, 'scratch'],
    ['test', `${base}/shop_test`, 'test'],
  ])
  const cfg = p.cfg()
  for (const e of ['dev', 'scratch', 'test']) await sql(cfg, e, pgSchemaReset)
  const states = async (env: string) => Object.fromEntries((await runner.info(cfg, env)).map((i) => [i.script, i.state]))

  // A script for test only: it runs there, dev passes over it, and nothing is recorded on dev.
  p.write('V1__orders.sql', 'create table orders (id int primary key);\n')
  p.write('V2__test_fixtures.sql', '-- liftoff:for test\ncreate table fixtures (id int primary key);\ninsert into orders values (1);\n')
  p.write('V3__customers.sql', 'create table customers (id int primary key);\n')
  assert.deepEqual((await runner.migrate(cfg, 'dev')).applied.map((a) => a.script), ['V1__orders.sql', 'V3__customers.sql'])
  assert.deepEqual(await states('dev'), { 'V1__orders.sql': 'applied', 'V2__test_fixtures.sql': 'excluded', 'V3__customers.sql': 'applied' })
  assert.equal((await runner.migrate(cfg, 'dev')).applied.length, 0, 'excluded is not pending')
  await assert.rejects(runner.markApplied(cfg, 'dev', 'V2__test_fixtures.sql'), /is excluded on dev/)
  assert.deepEqual((await runner.migrate(cfg, 'test')).applied.map((a) => a.script), ['V1__orders.sql', 'V2__test_fixtures.sql', 'V3__customers.sql'])

  // Drift is measured against what each environment's own scripts build: fixtures belongs on test, not on dev.
  assert.deepEqual((await checks.check(cfg, 'test', undefined, { drift: true })).drift, [])
  assert.deepEqual((await checks.check(cfg, 'dev', undefined, { drift: true })).drift, [])

  // By topic: only the scripts whose topics match run; the older one without stays behind.
  p.write('V4__invoices.sql', '-- liftoff:topic JIRA-7\ncreate table invoices (id int primary key);\n')
  p.write('V5__credits.sql', '-- liftoff:topic JIRA-8, billing\ncreate table credits (id int primary key);\n')
  const dry = await runner.migrate(cfg, 'test', { topic: 'jira-8 or nothing', dryRun: true })
  assert.deepEqual(dry.applied.map((a) => a.script), ['V5__credits.sql'])
  const r = await runner.migrate(cfg, 'test', { topic: 'billing and not JIRA-7' })
  assert.deepEqual([r.applied.map((a) => a.script), r.left_behind], [['V5__credits.sql'], ['V4__invoices.sql']])
  assert.equal((await runner.migrate(cfg, 'test', { topic: 'JIRA-99' })).applied.length, 0)
  assert.deepEqual((await runner.migrate(cfg, 'test', { topic: 'JIRA-7' })).applied.map((a) => a.script), ['V4__invoices.sql'], 'a topic run may pick an older script')
  await assert.rejects(runner.migrate(cfg, 'test', { topic: 'JIRA-7 and', dryRun: true }), (e: unknown) => e instanceof LiftoffError && /--topic 'JIRA-7 and'/.test(e.message))
  await assert.rejects(runner.migrate(cfg, 'test', { topic: 'x', only: ['4'] }), /--topic on its own/)
  assert.deepEqual((await runner.info(cfg, 'test')).find((i) => i.script === 'V5__credits.sql')?.topics, ['JIRA-8', 'billing'])
})
