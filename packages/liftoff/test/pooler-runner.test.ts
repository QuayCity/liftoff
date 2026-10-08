// The runner through PgBouncer in transaction-pooling mode with prepared statements off
// (max_prepared_statements = 0), using the lease lock (ported from crates/core/tests/pooler.rs).

import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import { test } from 'node:test'
import { saveProject } from '../src/core/config.ts'
import * as runner from '../src/core/runner.ts'
import { pgSchemaReset, project, sql } from './helpers.ts'

const base = process.env.LIFTOFF_TEST_PGBOUNCER

test('the runner through PgBouncer transaction pooling', { skip: !base && 'set LIFTOFF_TEST_PGBOUNCER' }, async () => {
  const p = project('postgresql', [['test', `${base}/shop_test`, 'test']])
  const loaded = p.cfg()
  saveProject(p.dir, { ...loaded.project, lock: 'table' })
  const cfg = p.cfg()
  assert.equal(cfg.project.lock, 'table', 'saved to liftoff.toml')
  assert.match(fs.readFileSync(`${p.dir}/liftoff.toml`, 'utf8'), /lock = "table"/)
  await sql(cfg, 'test', pgSchemaReset)

  p.write('V1__orders.sql', 'create table orders (id bigint primary key, note text);\n')
  p.write('V2__note_index.sql', 'create index concurrently orders_note_idx on orders (note);\n')
  p.write('R__order_ids.sql', 'create or replace view order_ids as select id from orders;\n')

  // Three runs at once: the lease lets exactly one apply each script.
  const runs = await Promise.all([runner.migrate(cfg, 'test'), runner.migrate(cfg, 'test'), runner.migrate(cfg, 'test')])
  assert.equal(runs.reduce((n, r) => n + r.applied.length, 0), 3, 'each script ran exactly once')
  assert.ok((await runner.info(cfg, 'test')).every((i) => i.state === 'applied'))
  await runner.validateEnv(cfg, 'test')

  // A lease left by a crashed run expires; a live one is waited for.
  await sql(cfg, 'test', "insert into liftoff_schema_history_lock values (1, 'crashed run', now() - interval '1 minute')")
  p.write('V3__more.sql', 'alter table orders add column total numeric;\n')
  assert.equal((await runner.migrate(cfg, 'test')).applied.length, 1, 'a stale lease does not block')
  await sql(cfg, 'test', "insert into liftoff_schema_history_lock values (1, 'someone else', now() + interval '1 minute')")
  p.write('V4__more.sql', 'alter table orders add column paid boolean;\n')
  const started = Date.now()
  const release = new Promise((r) => setTimeout(r, 2000)).then(() => sql(cfg, 'test', 'delete from liftoff_schema_history_lock'))
  const [r] = await Promise.all([runner.migrate(cfg, 'test'), release])
  assert.equal(r.applied.length, 1)
  assert.ok(Date.now() - started >= 2000, 'it waited for the live lease')
})
