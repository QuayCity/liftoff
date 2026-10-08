// The runner against a real PostgreSQL (ported from crates/core/tests/postgres.rs and fixes.rs).

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { open } from '../src/core/db.ts'
import { LiftoffError, MigrationError } from '../src/core/errors.ts'
import * as runner from '../src/core/runner.ts'
import { pgSchemaReset, project, sql } from './helpers.ts'

const base = process.env.LIFTOFF_TEST_PG

test('the runner on PostgreSQL', { skip: !base && 'set LIFTOFF_TEST_PG' }, async () => {
  const p = project('postgresql', [
    ['dev', `${base}/shop_dev`, 'dev'],
    ['scratch', `${base}/shop_scratch`, 'scratch'],
    ['test', `${base}/shop_test`, 'test'],
  ])
  let cfg = p.cfg()
  for (const e of ['dev', 'scratch', 'test']) await sql(cfg, e, pgSchemaReset)
  const state = async (env: string, script: string) => (await runner.info(cfg, env)).find((i) => i.script === script)?.state

  // 1. Versioned and repeatable apply in order; a second run is a no-op.
  p.write('V1__orders.sql', 'create table orders (id serial, note text);\n')
  p.write('R__order_view.sql', 'create or replace view order_ids as select id from orders;\n')
  const r = await runner.migrate(cfg, 'test')
  assert.deepEqual(r.applied.map((a) => a.script), ['V1__orders.sql', 'R__order_view.sql'])
  assert.equal((await runner.migrate(cfg, 'test')).applied.length, 0)
  assert.ok((await runner.info(cfg, 'test')).every((i) => i.state === 'applied'))

  // 2. A failing transactional script rolls back completely and leaves no history row.
  p.write('V2__broken.sql', 'create table half_done (id int);\nselect * from no_such_table;\n')
  await assert.rejects(runner.migrate(cfg, 'test'), (e: unknown) => e instanceof MigrationError && /no_such_table/.test(e.message))
  const c = await open('test', cfg.env('test'))
  assert.equal(((await (c as import('../src/core/postgres.ts').PgConn).row("select to_regclass('public.half_done') is not null"))[0]), false, 'rolled back')
  await c.close()
  assert.equal(await state('test', 'V2__broken.sql'), 'pending')
  p.remove('V2__broken.sql')

  // 3. Statements that cannot run in a transaction run one by one.
  p.write('V2__index.sql', 'create index concurrently orders_note_idx on orders (note);\n')
  const idx = await runner.migrate(cfg, 'test')
  assert.deepEqual(idx.applied.map((a) => [a.script, a.transactional]), [['V2__index.sql', false]])

  // 4. Editing an applied script blocks migrate.
  p.write('V1__orders.sql', 'create table orders (id serial, note text, extra int);\n')
  await assert.rejects(runner.migrate(cfg, 'test'), (e: unknown) => e instanceof LiftoffError && e.code === 'LIFTOFF_VALIDATE' && /checksum/.test(e.message))
  p.write('V1__orders.sql', 'create table orders (id serial, note text);\n')

  // 5. Two runs at once on a fresh database: the lock lets each script run exactly once.
  await sql(cfg, 'test', pgSchemaReset)
  const [a, b] = await Promise.all([runner.migrate(cfg, 'test'), runner.migrate(cfg, 'test')])
  assert.equal(a.applied.length + b.applied.length, 3)

  // 6. Repair: a failed non-transactional script, an edited file and a deleted file.
  p.write('V900__bad_index.sql', 'create index concurrently bad_idx on no_such_table (x);\n')
  await assert.rejects(runner.migrate(cfg, 'test'))
  assert.equal(await state('test', 'V900__bad_index.sql'), 'failed')
  p.remove('V900__bad_index.sql')
  p.write('V1__orders.sql', '-- reformatted after it ran\ncreate table orders (id serial, note text);\n')
  p.remove('V2__index.sql')
  // A later script exists, so V2 is missing rather than "from another branch" (future).
  p.write('V50__later.sql', 'select 1;\n')
  await assert.rejects(runner.validateEnv(cfg, 'test'), (e: Error) => {
    assert.match(e.message, /V900__bad_index.sql failed/)
    assert.match(e.message, /V1__orders.sql changed/)
    assert.match(e.message, /V2__index.sql was applied/)
    return true
  })
  const rep = await runner.repair(cfg, 'test')
  assert.deepEqual([rep.removed_failed, rep.realigned, rep.forgotten], [['V900__bad_index.sql'], ['V1__orders.sql'], ['V2__index.sql']])
  await runner.validateEnv(cfg, 'test')
  p.remove('V50__later.sql')

  // 7. Clean is refused on a test database and allowed on scratch; baseline skips older scripts.
  await assert.rejects(runner.clean(cfg, 'test'), /allow_clean/)
  await runner.clean(cfg, 'scratch')
  await sql(cfg, 'scratch', 'create table orders (id serial, note text);')
  await assert.rejects(runner.migrate(cfg, 'scratch'), (e: unknown) => e instanceof LiftoffError && e.code === 'LIFTOFF_NOT_BASELINED')
  await runner.baseline(cfg, 'scratch', '1', 'existing schema')
  await assert.rejects(runner.baseline(cfg, 'scratch', '1', 'again'), /already has migration history/)
  const rb = await runner.migrate(cfg, 'scratch')
  assert.ok(rb.applied.every((x) => x.script !== 'V1__orders.sql'))
  assert.equal(await state('scratch', 'V1__orders.sql'), 'below_baseline')

  // 8. Undo runs the U script; the version is pending again. Mark-applied records without running.
  p.write('V3__total.sql', 'alter table orders add column total numeric;\n')
  p.write('U3__total.sql', 'alter table orders drop column total;\n')
  await runner.migrate(cfg, 'test')
  assert.equal((await runner.undo(cfg, 'test')).script, 'U3__total.sql')
  assert.equal(await state('test', 'V3__total.sql'), 'pending')
  await runner.markApplied(cfg, 'test', 'V3__total.sql')
  assert.equal(await state('test', 'V3__total.sql'), 'applied')
  await assert.rejects(runner.markApplied(cfg, 'test', 'V3__total.sql'), /only pending scripts/)

  // 9. Dry run: the SQL and history inserts, nothing executed.
  p.write('V4__more.sql', 'alter table orders add column paid boolean;\n')
  const dry = (await runner.migrate(cfg, 'test', { dryRun: true })).dry_run_sql!
  assert.ok(dry.includes('V4__more.sql') && dry.includes('BEGIN;') && dry.includes('INSERT INTO public.liftoff_schema_history'), dry)
  assert.equal(await state('test', 'V4__more.sql'), 'pending', 'a dry run changes nothing')

  // 10. A B script builds an empty database, then only later V scripts run.
  p.write('B3__start.sql', 'create table orders (id serial, note text, total numeric);\ncreate or replace view order_ids as select id from orders;\n')
  await sql(cfg, 'dev', pgSchemaReset)
  const fromB = await runner.migrate(cfg, 'dev')
  assert.deepEqual(fromB.applied.map((x) => x.script), ['B3__start.sql', 'V4__more.sql', 'R__order_view.sql'])
  assert.ok((await runner.info(cfg, 'dev')).some((i) => i.state === 'baseline' && i.script === 'B3__start.sql'))
  p.remove('B3__start.sql')

  // 11. Placeholders per environment, and re-running unchanged repeatables.
  p.write('V5__note.sql', "comment on table orders is 'for ${app_note} in ${flyway:defaultSchema}';\n")
  const toml = (await import('node:fs')).readFileSync(`${p.dir}/liftoff.toml`, 'utf8')
  ;(await import('node:fs')).writeFileSync(`${p.dir}/liftoff.toml`, toml.replace('[environments.test]', '[environments.test.placeholders]\napp_note = "test_app"\n\n[environments.test]'))
  cfg = p.cfg()
  await runner.migrate(cfg, 'test')
  const tc = (await open('test', cfg.env('test'))) as import('../src/core/postgres.ts').PgConn
  assert.equal((await tc.row("select obj_description('public.orders'::regclass)"))[0], 'for test_app in public')
  await tc.close()
  p.write('V6__oops.sql', "select '${nobody}';\n")
  await assert.rejects(runner.migrate(cfg, 'test'), /V6__oops.sql uses placeholders with no value: nobody/)
  p.remove('V6__oops.sql')
  assert.equal((await runner.migrate(cfg, 'test')).applied.length, 0)
  assert.deepEqual((await runner.migrate(cfg, 'test', { rerunRepeatables: true })).applied.map((x) => x.script), ['R__order_view.sql'])
})
