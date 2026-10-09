// Rebaselining against real PostgreSQL: one B script replaces the old ones, migrated databases
// keep working, empty ones build the same schema, and nothing is removed that git cannot give back.

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { test } from 'node:test'
import { compare, parseSide } from '../src/core/compare.ts'
import { LiftoffError } from '../src/core/errors.ts'
import { rebaseline } from '../src/core/rebaseline.ts'
import * as runner from '../src/core/runner.ts'
import { pgSchemaReset, project, sql } from './helpers.ts'

const base = process.env.LIFTOFF_TEST_PG
const git = (dir: string, ...args: string[]) => {
  const r = spawnSync('git', args, { cwd: dir, encoding: 'utf8' })
  assert.equal(r.status, 0, r.stderr)
}

function setUp() {
  const p = project('postgresql', [
    ['dev', `${base}/shop_dev`, 'dev', { allow_clean: true }],
    ['scratch', `${base}/shop_scratch`, 'scratch'],
    ['test', `${base}/shop_test`, 'test'],
  ])
  p.write('V0001__customers.sql', 'create table customers (id int primary key, email text);\n')
  p.write('V0002__orders.sql', 'create table orders (id int primary key, customer_id int references customers (id));\n')
  p.write('V0003__note.sql', 'alter table orders add column note text;\n')
  p.write('U0003__note.sql', 'alter table orders drop column note;\n')
  p.write('V0004__index.sql', 'create index orders_customer on orders (customer_id);\n')
  p.write('V0005__email_not_null.sql', 'update customers set email = \'\' where email is null; alter table customers alter column email set not null;\n')
  p.write('R__order_count.sql', 'create or replace view order_count as select customer_id, count(*) n from orders group by customer_id;\n')
  git(p.dir, 'init', '-q')
  git(p.dir, 'config', 'user.email', 'test@example.com')
  git(p.dir, 'config', 'user.name', 'test')
  git(p.dir, 'add', '-A')
  git(p.dir, 'commit', '-qm', 'scripts')
  return p
}

test('rebaseline: B0005 replaces V0001 to V0005, migrated databases keep working, empty ones build the same', { skip: !base && 'set LIFTOFF_TEST_PG' }, async () => {
  const p = setUp()
  const cfg = p.cfg()
  for (const env of ['dev', 'test']) await sql(cfg, env, pgSchemaReset)
  await runner.migrate(cfg, 'test')

  // A script that is not committed: refused, and nothing changes.
  p.write('V0005__email_not_null.sql', '-- edited, not committed\nalter table customers alter column email set not null;\n')
  await assert.rejects(rebaseline(cfg), (e: unknown) => e instanceof LiftoffError && /not committed/.test(e.message))
  assert.deepEqual(fs.readdirSync(path.join(p.dir, 'migrations')).filter((f) => f.startsWith('B')), [], 'no baseline written')
  git(p.dir, 'checkout', '--', 'migrations')

  const r = await rebaseline(cfg)
  assert.equal(path.basename(r.baseline), 'B0005__baseline.sql')
  assert.deepEqual(r.removed, ['U0003__note.sql', 'V0001__customers.sql', 'V0002__orders.sql', 'V0003__note.sql', 'V0004__index.sql', 'V0005__email_not_null.sql'])
  assert.deepEqual(fs.readdirSync(path.join(p.dir, 'migrations')).sort(), ['B0005__baseline.sql', 'R__order_count.sql'])

  // The database that ran the old scripts: nothing pending, nothing missing, valid.
  const infos = await runner.info(cfg, 'test')
  assert.ok(infos.filter((i) => i.kind === 'versioned').every((i) => i.state === 'below_baseline'), JSON.stringify(infos.map((i) => [i.script, i.state])))
  await runner.validateEnv(cfg, 'test')
  assert.equal((await runner.migrate(cfg, 'test')).applied.length, 0)

  // Work goes on after the baseline; an empty database builds the same schema.
  p.write('V0006__phone.sql', 'alter table customers add column phone text;\n')
  assert.deepEqual((await runner.migrate(cfg, 'test')).applied.map((a) => a.script), ['V0006__phone.sql'])
  assert.deepEqual((await runner.migrate(cfg, 'dev')).applied.map((a) => a.script), ['B0005__baseline.sql', 'V0006__phone.sql', 'R__order_count.sql'])
  assert.equal((await compare(cfg, parseSide('dev'), parseSide('test'), undefined)).changes.length, 0)
})

test('rebaseline up to a version, into an archive folder', { skip: !base && 'set LIFTOFF_TEST_PG' }, async () => {
  const p = setUp()
  const cfg = p.cfg()
  const r = await rebaseline(cfg, { upTo: '0003', archive: 'old-scripts', description: 'first three' })
  assert.equal(path.basename(r.baseline), 'B0003__first_three.sql')
  assert.deepEqual(fs.readdirSync(path.join(p.dir, 'old-scripts')).sort(), ['U0003__note.sql', 'V0001__customers.sql', 'V0002__orders.sql', 'V0003__note.sql'])
  assert.deepEqual(fs.readdirSync(path.join(p.dir, 'migrations')).sort(), ['B0003__first_three.sql', 'R__order_count.sql', 'V0004__index.sql', 'V0005__email_not_null.sql'])
  await assert.rejects(rebaseline(cfg, { archive: 'migrations/inside' }), /outside the migrations folder/)
})
