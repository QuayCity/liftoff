// Compare, generate, undo, checks, capture, Flyway import, B scripts, scratch, filters, the
// schema model and squash on a real PostgreSQL (ported from crates/core/tests/postgres.rs and fixes.rs).

import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { test } from 'node:test'
import * as checks from '../src/core/checks.ts'
import { Config, saveProject } from '../src/core/config.ts'
import { open } from '../src/core/db.ts'
import * as diff from '../src/core/diff.ts'
import * as flyway from '../src/core/flyway.ts'
import * as model from '../src/core/model.ts'
import type { PgConn } from '../src/core/postgres.ts'
import * as runner from '../src/core/runner.ts'
import { pgSchemaReset, project, sql } from './helpers.ts'

const base = process.env.LIFTOFF_TEST_PG

test('compare, generate and the rest on PostgreSQL', { skip: !base && 'set LIFTOFF_TEST_PG' }, async () => {
  const p = project('postgresql', [
    ['dev', `${base}/shop_dev`, 'dev'],
    ['scratch', `${base}/shop_scratch`, 'scratch'],
    ['test', `${base}/shop_test`, 'test'],
  ])
  const cfg = p.cfg()
  for (const e of ['dev', 'scratch', 'test']) await sql(cfg, e, pgSchemaReset)
  const state = async (env: string, script: string) => (await runner.info(cfg, env)).find((i) => i.script === script)?.state
  const pg = async (env: string) => (await open(env, cfg.env(env))) as PgConn

  p.write('V1__orders.sql', 'create table orders (id serial, note text);\n')
  p.write('R__order_view.sql', 'create or replace view order_ids as select id from orders;\n')
  p.write('V2__index.sql', 'create index concurrently orders_note_idx on orders (note);\n')
  await runner.migrate(cfg, 'test')

  // 6. Dev changes -> generated migration -> applied -> no differences left.
  await runner.migrate(cfg, 'dev')
  await sql(
    cfg,
    'dev',
    `alter table orders add column total numeric(10,2) not null default 0;
     alter table orders alter column note set not null;
     create table customers (id bigint generated always as identity primary key, "Name" text not null unique,
                             created_at timestamptz default now(), check (length("Name") > 0));
     alter table orders add column customer_id bigint references customers(id);
     alter table orders add primary key (id);
     create index orders_customer_idx on orders (customer_id) where customer_id is not null;
     create type mood as enum ('sad', 'ok', 'happy');
     alter table customers add column mood mood not null default 'ok';
     create sequence invoice_no start 1000;
     create function tax(amount numeric) returns numeric language sql immutable as $$ select amount * 0.21 $$;
     create view order_totals as select id, total, tax(total) as vat from orders;
     create view big_orders as select id from order_totals where total > 100;
     create extension if not exists pgcrypto;
     create domain email as text check (value like '%@%');
     alter table customers add column contact email;
     create table events (id bigint, at timestamptz not null, primary key (id, at)) partition by range (at);
     create table events_2026 partition of events for values from ('2026-01-01') to ('2027-01-01');
     create index events_at_idx on events (at);
     create function touch() returns trigger language plpgsql as $$ begin new.created_at := now(); return new; end $$;
     create trigger customers_touch before insert on customers for each row execute function touch();
     create materialized view order_counts as select count(*) as n from orders;
     create unique index order_counts_n on order_counts (n);
     do $$ begin if not exists (select from pg_roles where rolname = 'liftoff_reader') then create role liftoff_reader; end if; end $$;
     grant select on orders to liftoff_reader;
     grant select on order_totals to liftoff_reader;
     comment on table customers is 'People who buy';
     comment on column orders.note is 'Free text';`,
  )
  const changes = (await diff.devVsMigrations(cfg, undefined, undefined)).changes
  assert.deepEqual(
    changes.map((c) => c.id).sort(),
    [
      'comment:COLUMN public.orders.note', 'comment:TABLE public.customers', 'domain:public.email', 'extension:pgcrypto',
      'function:public.tax(amount numeric)', 'function:public.touch()', 'grant:TABLE public.orders',
      'sequence:public.invoice_no', 'table:public.customers', 'table:public.events', 'table:public.events_2026', 'table:public.orders',
      'trigger:public.customers.customers_touch', 'type:public.mood', 'view:public.big_orders', 'view:public.order_counts', 'view:public.order_totals',
    ],
  )
  // The new view's grant travels with the view, not as a separate change.
  assert.ok(changes.find((c) => c.id === 'view:public.order_totals')!.sql.includes('GRANT SELECT ON TABLE public.order_totals TO liftoff_reader'))
  assert.ok(changes.every((c) => c.after !== null), 'every change carries its after-DDL')
  const g = diff.generate(cfg, changes, 'customers and totals', true)
  const u = g.undo!
  assert.ok(u.file_name.startsWith('U') && u.sql.includes('DROP TABLE IF EXISTS public.customers;'), u.sql)
  diff.save(cfg, u.file_name, u.sql)
  assert.ok(g.file_name.startsWith('V') && g.file_name.endsWith('__customers_and_totals.sql'), g.file_name)
  diff.save(cfg, g.file_name, g.sql)
  assert.throws(() => diff.save(cfg, g.file_name, g.sql), /already exists/, 'never overwrites')
  assert.equal((await runner.migrate(cfg, 'test')).applied.length, 1)
  const after = (await diff.devVsMigrations(cfg, undefined, undefined)).changes
  assert.deepEqual(after.map((c) => c.id), [], `round trip left differences\n--- script ---\n${g.sql}`)

  // 6-nc. Objects the diff does not compare are reported, not silently skipped.
  await sql(cfg, 'dev', 'create policy everyone on orders using (true)')
  const cmp = await diff.devVsMigrations(cfg, undefined, undefined)
  assert.deepEqual(cmp.changes, [])
  assert.deepEqual(cmp.not_compared, ['row-level security policies: 1 in dev, 0 in the scripts'])
  await sql(cfg, 'dev', 'drop policy everyone on orders')

  // 6a. Undo, dry run, the changes report, redo, drift.
  let report = await checks.check(cfg, 'test', undefined, { drift: true, changes: true })
  assert.ok(!checks.hasDrift(report), 'freshly migrated')
  assert.deepEqual(report.changes, [], 'nothing pending')
  assert.equal((await runner.undo(cfg, 'test')).script, u.file_name)
  assert.equal(await state('test', g.file_name), 'pending')
  report = await checks.check(cfg, 'test', undefined, { drift: true, changes: true, dryRun: true })
  assert.ok(!checks.hasDrift(report), `undo restores what the earlier scripts built: ${JSON.stringify(report.drift?.map((d) => d.sql))}`)
  assert.equal(report.changes!.length, changes.length, 'the pending script changes what dev changed')
  assert.ok(report.dry_run_sql!.includes(g.file_name) && report.dry_run_sql!.includes('BEGIN;') && report.dry_run_sql!.includes('INSERT INTO public.liftoff_schema_history'))
  assert.equal(await state('test', g.file_name), 'pending', 'a dry run changes nothing')
  assert.ok(checks.reportHtml(report, 'shop', '2026-10-08').includes('<h2>Pending changes ('))
  assert.equal((await runner.migrate(cfg, 'test')).applied.length, 1, 'redo after undo')
  await sql(cfg, 'test', 'alter table orders add column hotfix int')
  const drift = (await checks.check(cfg, 'test', undefined, { drift: true })).drift!
  assert.deepEqual(drift.map((d) => d.id), ['table:public.orders'])
  assert.ok(drift[0].sql.includes('ADD COLUMN hotfix integer'), drift[0].sql)
  await sql(cfg, 'test', 'alter table orders drop column hotfix')

  // 6b. Dev already has the generated change: record it there instead of running it.
  await runner.markApplied(cfg, 'dev', g.file_name)
  assert.equal(await state('dev', g.file_name), 'applied')
  assert.equal((await runner.migrate(cfg, 'dev')).applied.length, 0)

  // 6b2. Capture: the whole dev schema as one script; on an empty database it rebuilds dev exactly.
  const cap = await diff.capture(cfg, 'dev', 'existing schema', false)
  assert.ok(cap.sql.includes('CREATE TABLE public.customers') && cap.sql.includes('FOREIGN KEY'), cap.sql)
  await runner.clean(cfg, 'scratch')
  await sql(cfg, 'scratch', cap.sql)
  const [dv, sc] = [await pg('dev'), await pg('scratch')]
  const left = diff.diffSchemas(await diff.modelOf(cfg, dv), await diff.modelOf(cfg, sc))
  await Promise.all([dv.close(), sc.close()])
  assert.deepEqual(left.map((c) => c.id), [], 'the capture round trip left differences')

  // 6b3. Hand-written scripts get the next version, or R__ for repeatables.
  const added = diff.add(cfg, false, 'fix totals', '')
  assert.match(path.basename(added), /^V.*__fix_totals\.sql$/)
  assert.ok(diff.add(cfg, true, 'totals view', 'select 1;').endsWith('R__totals_view.sql'))
  assert.throws(() => diff.add(cfg, true, 'totals view', 'select 1;'), /already exists/)
  fs.rmSync(added)
  p.remove('R__totals_view.sql')

  // 8. A one-time import of a Flyway history table.
  await sql(cfg, 'test', pgSchemaReset)
  const fw = new Config(cfg.root, { ...cfg.project, history_table: 'flyway_schema_history' }, cfg.environments)
  const tc = await pg('test')
  await tc.ensureHistory('public', 'flyway_schema_history')
  await tc.batch("insert into flyway_schema_history values (0, '0', '<< schema creation >>', 'SCHEMA', '\"public\"', null, 'me', now(), 0, true)")
  await runner.migrate(fw, 'test', { outOfOrder: true })
  const flywayRows = (await tc.readHistory('public', 'flyway_schema_history')).length
  p.write('V1__orders.sql', '-- edited after it ran\ncreate table orders (id serial, note text);\n')
  await assert.rejects(flyway.importHistory(cfg, 'test', 'flyway_schema_history', false), /V1__orders.sql[\s\S]*--accept-edited/)
  assert.deepEqual(await tc.readHistory('public', cfg.project.history_table), [], 'a refused import writes nothing')
  p.write('V1__orders.sql', 'create table orders (id serial, note text);\n')
  const imp = await flyway.importHistory(cfg, 'test', 'flyway_schema_history', false)
  assert.deepEqual([imp.imported, imp.skipped.length], [flywayRows - 1, 1])
  await runner.validateEnv(cfg, 'test')
  assert.equal((await runner.migrate(cfg, 'test')).applied.length, 0, 'nothing runs again after an import')
  assert.equal((await tc.readHistory('public', 'flyway_schema_history')).length, flywayRows, "Flyway's table is left alone")
  await assert.rejects(flyway.importHistory(cfg, 'test', 'flyway_schema_history', false), /only runs once/)
  await tc.close()

  // 9. B scripts: an empty database starts from the baseline script, then only later V scripts run.
  await sql(cfg, 'test', pgSchemaReset)
  const b = await diff.capture(cfg, 'dev', 'dev schema', true)
  assert.ok(b.file_name.startsWith('B'), b.file_name)
  diff.save(cfg, b.file_name, b.sql)
  const rb = await runner.migrate(cfg, 'test')
  assert.equal(rb.applied[0].script, b.file_name)
  const infos = await runner.info(cfg, 'test')
  assert.ok(infos.every((i) => i.state !== 'pending'), JSON.stringify(infos))
  assert.ok(infos.some((i) => i.state === 'baseline' && i.script === b.file_name))
  const [dv2, tv] = [await pg('dev'), await pg('test')]
  const left2 = diff.diffSchemas(await diff.modelOf(cfg, dv2), await diff.modelOf(cfg, tv))
  await Promise.all([dv2.close(), tv.close()])
  assert.deepEqual(left2.map((c) => c.id), [], 'the B script rebuilds dev')
  p.remove(b.file_name)

  // 10. Guided scratch: a new database next to dev, saved as a private environment; never reuses one.
  await sql(cfg, 'dev', 'DROP DATABASE IF EXISTS shop_dev_scratch')
  const solo = new Config(cfg.root, cfg.project, new Map([...cfg.environments].filter(([n]) => n !== 'scratch')))
  const created = await diff.createScratch(solo, undefined, 'scratch2')
  assert.equal(created.database, 'shop_dev_scratch')
  assert.equal(Config.load(p.dir).env('scratch2').role, 'scratch')
  await assert.rejects(diff.createScratch(solo, undefined, 'scratch3'), /already exists/)
  await sql(cfg, 'dev', 'DROP DATABASE shop_dev_scratch')

  // 11. Comparison filters: an excluded table (and its grants and comments) is not compared.
  await sql(cfg, 'dev', "create table audit_log (id int); comment on table audit_log is 'noise'; grant select on audit_log to liftoff_reader;")
  const filtered = new Config(cfg.root, { ...cfg.project, filters: [{ action: 'exclude', object: 'table', pattern: 'audit_*' }] }, cfg.environments)
  const fcmp = await diff.devVsMigrations(filtered, undefined, undefined)
  assert.ok(fcmp.changes.every((c) => !c.name.includes('audit_log')), JSON.stringify(fcmp.changes.map((c) => c.id)))
  assert.ok((await diff.devVsMigrations(cfg, undefined, undefined)).changes.some((c) => c.id === 'table:public.audit_log'))
  await sql(cfg, 'dev', 'drop table audit_log')

  // 12. The schema model: save everything from dev, then only real changes show.
  const first = await model.status(cfg, undefined)
  assert.ok(first.some((c) => c.path === 'public/tables/orders.sql') && first.some((c) => c.path === 'extensions/pgcrypto.sql'), JSON.stringify(first.map((c) => c.path)))
  model.save(cfg, first)
  assert.deepEqual(await model.status(cfg, undefined), [], 'nothing differs right after saving')
  const orders = fs.readFileSync(path.join(p.dir, 'schema-model/public/tables/orders.sql'), 'utf8')
  assert.ok(orders.includes('CREATE TABLE public.orders') && orders.includes('GRANT SELECT ON TABLE public.orders TO liftoff_reader'), orders)
  await sql(cfg, 'dev', 'alter table orders add column shipped_at timestamptz')
  const next = await model.status(cfg, undefined)
  assert.deepEqual(next.map((c) => [c.path, c.kind]), [['public/tables/orders.sql', 'changed']])
  assert.ok(next[0].after!.includes('shipped_at'))
  assert.throws(() => model.save(cfg, [{ path: '../escape.sql', object_type: 'x', kind: 'added', before: null, after: 'x' }]), /not a schema-model file/)
  await sql(cfg, 'dev', 'alter table orders drop column shipped_at')

  // 13. Squash: a B script checked to build the same schema; used by empty databases only.
  saveProject(p.dir, cfg.project)
  for (const f of fs.readdirSync(path.join(p.dir, 'migrations'))) fs.rmSync(path.join(p.dir, 'migrations', f))
  p.write('V1__orders.sql', 'create table orders (id bigint primary key, note text);\n')
  p.write('V2__total.sql', 'alter table orders add column total numeric;\n')
  p.write('V3__drop_note.sql', 'alter table orders drop column note;\n')
  p.write('R__counter.sql', "create or replace function order_count() returns bigint language sql as 'select count(*) from orders';\n")
  await sql(cfg, 'test', pgSchemaReset)
  await runner.migrate(cfg, 'test')
  const { generated, path: written } = await diff.squash(cfg, '2', 'start', undefined, false)
  assert.equal(generated.file_name, 'B2__start.sql')
  assert.ok(written && fs.existsSync(written))
  assert.ok(generated.sql.includes('total') && generated.sql.includes('note') && !generated.sql.includes('order_count'), generated.sql)
  await sql(cfg, 'dev', pgSchemaReset)
  assert.deepEqual((await runner.migrate(cfg, 'dev')).applied.map((a) => a.script), ['B2__start.sql', 'V3__drop_note.sql', 'R__counter.sql'])
  assert.equal((await runner.migrate(cfg, 'test')).applied.length, 0, 'databases with history are not affected')
  await assert.rejects(diff.squash(cfg, '2', 'start', undefined, false), /B2__start.sql already exists/)

  // 7. Refuses to rebuild a database that is not a scratch database.
  await assert.rejects(diff.devVsMigrations(cfg, 'dev', 'test'), /refusing/)
})
