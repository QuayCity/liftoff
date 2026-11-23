// The runner, compare, generate (with table rebuilds), undo, drift checks, capture, squash, the
// schema model and data compare on SQLite: database files in a temporary folder, nothing to set up.

import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { test } from 'node:test'
import * as checks from '../src/core/checks.ts'
import { Config } from '../src/core/config.ts'
import * as diff from '../src/core/diff.ts'
import { MigrationError } from '../src/core/errors.ts'
import * as model from '../src/core/model.ts'
import * as runner from '../src/core/runner.ts'
import { project, sql, succeeds } from './helpers.ts'

test('the SQLite sample project runs and undoes', async () => {
  const { createSample } = await import('../src/core/sample.ts')
  const { saveEnvironment } = await import('../src/core/config.ts')
  const root = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'lo-litesample-')), 'sample')
  createSample(root, 'sqlite')
  // Relative: the file is in the project folder, wherever LiftOff runs from.
  saveEnvironment(root, 'test', { url: 'sqlite:shop_test.db', role: 'test', allow_clean: false, placeholders: {} }, true, false)
  const cfg = Config.load(root)
  const r = await runner.migrate(cfg, 'test')
  assert.deepEqual(r.applied.map((a) => a.script), ['V0001__customers.sql', 'V0002__orders.sql', 'V0003__orders_by_customer.sql', 'R__customer_totals.sql'])
  assert.ok(fs.existsSync(path.join(root, 'shop_test.db')))
  await runner.undo(cfg, 'test')
  assert.equal((await runner.info(cfg, 'test')).find((i) => i.script === 'V0003__orders_by_customer.sql')?.state, 'pending')
})

test('the runner on SQLite', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lo-lite-'))
  const p = project('sqlite', [
    ['test', `sqlite:${dir}/test.db`, 'test'],
    ['dev', `sqlite:${dir}/dev.db`, 'dev', { allow_clean: true }],
  ])
  const cfg = p.cfg()
  assert.deepEqual(cfg.project.schemas, [])
  p.write('V1__start.sql', "create table orders (id integer primary key, note text not null default '');\n")
  p.write('V2__more.sql', "insert into orders (note) values ('two');\n")
  p.write('U2__more.sql', "delete from orders where note = 'two';\n")
  p.write('R__view.sql', 'drop view if exists order_notes;\ncreate view order_notes as select id, note from orders;\n')
  const r = await runner.migrate(cfg, 'test')
  assert.deepEqual(r.applied.map((a) => [a.script, a.transactional]), [['V1__start.sql', true], ['V2__more.sql', true], ['R__view.sql', true]], 'SQLite rolls DDL back too')

  // A failing script leaves nothing behind: SQLite's DDL is transactional.
  p.write('V3__bad.sql', 'create table extra (id integer);\ninsert into no_such_table values (1);\n')
  await assert.rejects(runner.migrate(cfg, 'test'), (e: unknown) => e instanceof MigrationError && /no such table: no_such_table/.test(e.message))
  assert.equal((await runner.info(cfg, 'test')).find((i) => i.script === 'V3__bad.sql')?.state, 'pending')
  assert.ok(!(await succeeds(cfg, 'test', 'select 1 from extra')), 'rolled back')
  p.remove('V3__bad.sql')

  const dry = (await runner.migrate(cfg, 'dev', { dryRun: true })).dry_run_sql!
  assert.ok(dry.includes('BEGIN;') && dry.includes('INSERT INTO "liftoff_schema_history"'), dry)
  await runner.undo(cfg, 'test')
  assert.equal((await runner.info(cfg, 'test')).find((i) => i.script === 'V2__more.sql')?.state, 'pending')
  await runner.migrate(cfg, 'dev')
  await runner.clean(cfg, 'dev')
  assert.ok(!(await succeeds(cfg, 'dev', 'select 1 from orders')), 'clean drops everything')
  await sql(cfg, 'dev', 'create table stray (id integer)')
  await assert.rejects(runner.migrate(cfg, 'dev'), /baseline|objects/i)
})

test('callbacks around migrate, each script, undo and clean, on SQLite', async () => {
  const { DatabaseSync } = await import('node:sqlite')
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lo-litecb-'))
  const p = project('sqlite', [
    ['test', `sqlite:${dir}/test.db`, 'test', { allow_clean: true }],
    ['prod', `sqlite:${dir}/prod.db`, 'prod'],
  ])
  const cfg = p.cfg()
  const log = (env: string) => {
    const db = new DatabaseSync(path.join(dir, `${env}.db`))
    try {
      return (db.prepare('select what from cb_log order by n').all() as { what: string }[]).map((r) => r.what)
    } finally {
      db.close()
    }
  }
  // The log table lives outside the migrations, as a callback's own work would.
  await sql(cfg, 'test', 'create table cb_log (n integer primary key, what text)')
  await sql(cfg, 'prod', 'create table cb_log (n integer primary key, what text)')
  p.write('before-migrate.sql', "insert into cb_log (what) values ('before ${liftoff:environment}');\n")
  p.write('beforeEachMigrate.sql', "insert into cb_log (what) values ('each');\n")
  p.write('after-migrate__a.sql', "insert into cb_log (what) values ('after a');\n")
  p.write('after-migrate__b.sql', "-- liftoff:for test\ninsert into cb_log (what) values ('after b, test only');\n")
  p.write('after-undo.sql', "insert into cb_log (what) values ('undone');\n")
  p.write('V1__start.sql', 'create table t (id integer primary key);\n')
  p.write('V2__more.sql', 'create table u (id integer primary key);\n')
  p.write('U2__more.sql', 'drop table u;\n')

  const r = await runner.migrate(cfg, 'test', { allowNonEmpty: true })
  assert.deepEqual(r.applied.map((a) => a.script), ['V1__start.sql', 'V2__more.sql'], 'callbacks are not migrations')
  assert.deepEqual(log('test'), ['before test', 'each', 'each', 'after a', 'after b, test only'])
  assert.ok(!(await runner.info(cfg, 'test')).some((i) => /migrate/.test(i.script)), 'not in the history')

  // Nothing pending: before and after migrate run all the same; -- liftoff:for leaves prod out.
  await runner.migrate(cfg, 'test')
  await runner.migrate(cfg, 'prod', { allowNonEmpty: true })
  assert.deepEqual(log('prod'), ['before prod', 'each', 'each', 'after a'])

  const dry = (await runner.migrate(cfg, 'test', { dryRun: true })).dry_run_sql!
  assert.ok(dry.includes('-- before-migrate.sql (callback: before-migrate)') && dry.includes("'before test'") && dry.includes('after-migrate__a.sql'), dry)

  await runner.undo(cfg, 'test')
  assert.equal(log('test').at(-1), 'undone')

  // A failing script: the error callback runs, and the script's error is what comes back.
  p.write('after-migrate-error.sql', 'create table failed_marker (id integer);\n')
  p.write('V3__bad.sql', 'insert into no_such_table values (1);\n')
  await assert.rejects(runner.migrate(cfg, 'test'), (e: unknown) => e instanceof MigrationError && e.message.includes('V3__bad.sql'))
  assert.ok(await succeeds(cfg, 'test', 'select 1 from failed_marker'))
  p.remove('V3__bad.sql')

  // A failing callback stops the run like a failing script.
  p.write('before-each-script__bad.sql', 'insert into no_such_table values (1);\n')
  p.write('V3__fine.sql', 'create table v (id integer primary key);\n')
  await assert.rejects(runner.migrate(cfg, 'test'), (e: unknown) => e instanceof MigrationError && e.message.includes('before-each-script__bad.sql'))
  assert.equal((await runner.info(cfg, 'test')).find((i) => i.script === 'V3__fine.sql')?.state, 'pending')
  p.remove('before-each-script__bad.sql')

  p.write('after-clean.sql', 'create table after_clean (id integer);\n')
  await runner.clean(cfg, 'test')
  assert.ok(await succeeds(cfg, 'test', 'select 1 from after_clean'))
  assert.ok(!(await succeeds(cfg, 'test', 'select 1 from t')))
})

test('the diff loop on SQLite, with table rebuilds', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lo-lite-'))
  const p = project('sqlite', [
    ['dev', `sqlite:${dir}/shop_dev.db`, 'dev'],
    ['test', `sqlite:${dir}/shop_test.db`, 'test'],
  ])
  const created = await diff.createScratch(p.cfg(), undefined, 'scratch')
  assert.equal(created.database, 'shop_dev_scratch')
  assert.ok(fs.existsSync(path.join(dir, 'shop_dev_scratch.db')))
  const cfg = Config.load(p.dir)
  const ids = (changes: { id: string }[]) => changes.map((c) => c.id).sort()

  p.write(
    'V1__start.sql',
    `create table customers (id integer primary key, email text not null unique);
create table orders (
  id integer primary key,
  customer_id integer not null references customers (id) on delete cascade,
  note text not null default 'none', -- what the customer wrote
  total numeric check (total >= 0)
);
create index ix_orders_note on orders (note);
create view order_notes as select id, note from orders;
create trigger orders_touch after update on orders begin update orders set note = trim(note) where id = new.id; end;
insert into customers values (1, 'a@example.com');
insert into orders values (1, 1, ' x ', 5);
`,
  )
  for (const e of ['dev', 'test']) await runner.migrate(cfg, e)
  assert.deepEqual(ids((await diff.devVsMigrations(cfg, undefined, undefined)).changes), [])

  // Added columns (ALTER TABLE ADD COLUMN), a type change (a rebuild), a new table, index, view.
  for (const s of [
    'create table invoices (id integer primary key, order_id integer references orders (id))',
    "alter table customers add column country text not null default 'NL'",
    'create index ix_orders_total on orders (total)',
    'drop index ix_orders_note',
    'drop view order_notes',
    'create view order_notes as select id, note, total from orders',
  ]) {
    await sql(cfg, 'dev', s)
  }
  // The rebuild by hand on dev: total becomes an integer with a stricter check.
  await sql(cfg, 'dev', `PRAGMA foreign_keys = OFF; PRAGMA legacy_alter_table = ON; BEGIN;
    create table orders_x (id integer primary key, customer_id integer not null references customers (id) on delete cascade,
      note text not null default 'none', total integer check (total > 0));
    insert into orders_x select id, customer_id, note, total from orders; drop table orders; alter table orders_x rename to orders;
    create index ix_orders_total on orders (total);
    create trigger orders_touch after update on orders begin update orders set note = trim(note) where id = new.id; end;
    COMMIT; PRAGMA legacy_alter_table = OFF; PRAGMA foreign_keys = ON;`)
  let cmp = await diff.devVsMigrations(cfg, undefined, undefined)
  assert.deepEqual(ids(cmp.changes), ['table:customers', 'table:invoices', 'table:orders', 'view:order_notes'])
  const orders = cmp.changes.find((c) => c.id === 'table:orders')!
  assert.ok(orders.destructive && orders.sql.includes('INSERT INTO liftoff_new_orders'), orders.sql)
  assert.match(cmp.changes.find((c) => c.id === 'table:customers')!.sql, /ALTER TABLE customers ADD COLUMN country text not null default 'NL';/)

  // Generate with undo, run it on test (rows kept through the rebuild), record it on dev.
  const g = diff.generate(cfg, cmp.changes, 'invoices and totals', true)
  diff.save(cfg, g.file_name, g.sql)
  diff.save(cfg, g.undo!.file_name, g.undo!.sql)
  await runner.migrate(cfg, 'test')
  assert.ok(await succeeds(cfg, 'test', "select 1 from orders where id = 1 and total = 5 and note = ' x '"), 'the rebuild kept the row')
  assert.ok(!(await succeeds(cfg, 'test', 'insert into orders (id, customer_id, total) values (2, 1, 0)')), 'the new check holds')
  await runner.markApplied(cfg, 'dev', g.file_name)
  cmp = await diff.devVsMigrations(cfg, undefined, undefined)
  assert.deepEqual(ids(cmp.changes), [], g.sql)

  // No drift; the undo takes test back; a hand-made index is drift.
  assert.deepEqual(ids((await checks.check(cfg, 'test', undefined, { drift: true })).drift!), [])
  await runner.undo(cfg, 'test')
  const drift = (await checks.check(cfg, 'test', undefined, { drift: true })).drift!
  assert.deepEqual(ids(drift), [], `${g.undo!.sql}\n${drift.map((d) => `${d.before}\n---\n${d.after}`).join('\n')}`)
  await sql(cfg, 'test', 'create index ix_by_hand on orders (note)')
  assert.deepEqual(ids((await checks.check(cfg, 'test', undefined, { drift: true })).drift!), ['table:orders'])

  // Capture, squash, and the schema model.
  const cap = await diff.capture(cfg, 'dev', 'existing schema', false)
  assert.ok(cap.sql.includes('CREATE TABLE customers') || cap.sql.includes('create table customers'), cap.sql)
  const sq = await diff.squash(cfg, undefined, 'start', undefined, false)
  assert.ok(sq.path && sq.generated.file_name.startsWith('B'))
  const changes = await model.status(cfg, undefined)
  const paths = changes.map((f) => f.path)
  for (const f of ['tables/orders.sql', 'views/order_notes.sql', 'triggers/orders_touch.sql']) assert.ok(paths.includes(f), `${f} in ${paths}`)
  model.save(cfg, changes)
  assert.equal(await model.check(cfg, undefined), paths.length)
  assert.deepEqual(ids((await model.versusMigrations(cfg, undefined)).changes), [])
})

test('data compare on SQLite: values by type, keys, a table without a key, and a script that fixes it', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lo-litedc-'))
  const p = project('sqlite', [
    ['a', `sqlite:${dir}/a.db`, 'dev'],
    ['b', `sqlite:${dir}/b.db`, 'test'],
  ])
  const cfg = p.cfg()
  for (const e of ['a', 'b']) {
    await sql(cfg, e, `create table customers (id integer primary key, email text not null, note text, amount real, data blob, doubled real generated always as (amount * 2));
      create table orders (id integer primary key, customer_id integer not null references customers (id));
      create table line_items (order_id integer not null references orders (id), line integer not null, item text, primary key (order_id, line));
      create table nokey (a, b);
      with recursive n(i) as (select 1 union all select i + 1 from n where i < 8000)
        insert into customers (id, email, note, amount, data) select i, 'c' || i || '@example.com', case when i % 7 = 0 then null else 'note ' || i end, i * 1.25, x'0102' from n;
      with recursive n(i) as (select 1 union all select i + 1 from n where i < 100) insert into orders select i, i from n;
      insert into line_items select o.id, l.i, 'item ' || o.id || '-' || l.i from orders o, (select 1 i union all select 2 union all select 3) l;
      insert into nokey values (1, 'x'), (2, 'y'), (3, null);`)
  }
  await sql(cfg, 'a', `insert into nokey values (2, 'y');
    insert into customers (id, email) values (8001, 'new@example.com'); insert into orders values (101, 8001);
    insert into line_items values (101, 1, 'new line'), (101, 2, 'O''Brien');`)
  await sql(cfg, 'b', `update nokey set b = 'z' where a = 3; insert into nokey values (4, 'w');
    update customers set note = '' where id = 7;
    update customers set amount = 12.51 where id = 10;
    update customers set data = x'00' where id = 4000;
    update nokey set a = '1' where a = 1;
    delete from line_items where order_id = 5 and line = 2;
    insert into customers (id, email) values (9000, 'only-b@example.com'); insert into orders values (200, 9000); insert into line_items values (200, 1, 'stale');`)

  const { DataSession } = await import('../src/core/datacompare.ts')
  const { parseSide } = await import('../src/core/compare.ts')
  const s = await DataSession.open(cfg, parseSide('a'), parseSide('b'))
  try {
    const t = Object.fromEntries(s.result.tables.map((x) => [x.table, x]))
    assert.deepEqual([t.customers.only_in_source, t.customers.only_in_target, t.customers.different], [1, 1, 3], JSON.stringify(t.customers))
    assert.deepEqual([t.orders.only_in_source, t.orders.only_in_target], [1, 1])
    assert.deepEqual([t.line_items.only_in_source, t.line_items.only_in_target, t.line_items.key], [3, 1, ['order_id', 'line']])
    // nokey's columns have no type: the integer 1 in a and the text '1' in b are different values.
    assert.deepEqual([t.nokey.only_in_source, t.nokey.only_in_target, t.nokey.whole_rows], [3, 3, true])
    const extra = await s.page('nokey', 'only_in_target', 0, 10)
    assert.ok(extra.rows.some((r) => r.target![0] === "'1'"), JSON.stringify(extra.rows))
    const page = await s.page('customers', 'different', 0, 10)
    const note = page.columns.indexOf('note')
    const seven = page.rows.find((r) => r.key[0] === '7')!
    assert.deepEqual([seven.source![note], seven.target![note]], [null, "''"])
    assert.ok(!page.columns.includes('doubled'), 'generated columns are not compared')
    let script = ''
    for await (const chunk of s.script()) script += chunk
    assert.ok(script.search(/DELETE FROM line_items/) < script.search(/DELETE FROM orders/), 'child rows are deleted first')
    assert.doesNotMatch(script, /liftoff_/, 'the script runs without LiftOff')
    await s.apply()
  } finally {
    await s.close()
  }
  const again = await DataSession.open(cfg, parseSide('a'), parseSide('b'))
  try {
    for (const r of again.result.tables.filter((x) => !x.skipped)) assert.deepEqual([r.table, r.only_in_source, r.only_in_target, r.different], [r.table, 0, 0, 0])
  } finally {
    await again.close()
  }
})
