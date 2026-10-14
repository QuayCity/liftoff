// The runner, compare, generate, undo, drift checks, capture, squash and the schema model on a real
// MySQL. Drops and recreates the databases shop_dev, shop_test and shop_dev_scratch on that server.

import assert from 'node:assert/strict'
import { test } from 'node:test'
import * as checks from '../src/core/checks.ts'
import { Config } from '../src/core/config.ts'
import * as diff from '../src/core/diff.ts'
import { MigrationError } from '../src/core/errors.ts'
import * as model from '../src/core/model.ts'
import { MySqlConn } from '../src/core/mysql.ts'
import * as runner from '../src/core/runner.ts'
import { project, sql, succeeds } from './helpers.ts'

const base = process.env.LIFTOFF_TEST_MYSQL

async function fresh(...dbs: string[]) {
  const admin = await MySqlConn.open('admin', { url: `${base}/mysql`, role: 'prod', allow_clean: false, placeholders: {} })
  for (const db of dbs) await admin.batch(`DROP DATABASE IF EXISTS \`${db}\`; CREATE DATABASE \`${db}\``)
  await admin.batch('DROP DATABASE IF EXISTS shop_dev_scratch')
  await admin.close()
}

test('the MySQL sample project runs and undoes', { skip: !base && 'set LIFTOFF_TEST_MYSQL' }, async () => {
  const { createSample } = await import('../src/core/sample.ts')
  const { saveEnvironment } = await import('../src/core/config.ts')
  const fs = await import('node:fs')
  const os = await import('node:os')
  const path = await import('node:path')
  await fresh('shop_sample')
  const root = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'lo-mysample-')), 'sample')
  createSample(root, 'mysql')
  saveEnvironment(root, 'test', { url: `${base}/shop_sample`, role: 'test', allow_clean: false, placeholders: {} }, true, false)
  const cfg = Config.load(root)
  const r = await runner.migrate(cfg, 'test')
  assert.deepEqual(r.applied.map((a) => a.script), ['V0001__customers.sql', 'V0002__orders.sql', 'V0003__orders_by_customer.sql', 'R__customer_totals.sql'])
  await runner.undo(cfg, 'test')
  assert.equal((await runner.info(cfg, 'test')).find((i) => i.script === 'V0003__orders_by_customer.sql')?.state, 'pending')
})

test('the runner on MySQL', { skip: !base && 'set LIFTOFF_TEST_MYSQL' }, async () => {
  await fresh('shop_test', 'shop_dev')
  const p = project('mysql', [
    ['test', `${base}/shop_test`, 'test'],
    ['dev', `${base}/shop_dev`, 'dev', { allow_clean: true }],
  ])
  const cfg = p.cfg()
  assert.deepEqual(cfg.project.schemas, [], 'MySQL manages the database the URL names')

  // DDL, a procedure with a BEGIN … END body, and a DELIMITER block as the mysql client writes it.
  p.write('V1__start.sql', "create table orders (id int auto_increment primary key, note varchar(100) not null default '');\n")
  p.write('V2__routines.sql', 'create procedure add_order(n varchar(100)) begin insert into orders (note) values (n); select last_insert_id(); end;\n')
  p.write('V3__function.sql', 'DELIMITER //\ncreate function order_count() returns int reads sql data begin return (select count(*) from orders); end //\nDELIMITER ;\n')
  p.write('R__view.sql', 'create or replace view order_notes as select id, note from orders;\n')
  p.write('U3__function.sql', 'drop function order_count;\n')
  const r = await runner.migrate(cfg, 'test')
  assert.deepEqual(r.applied.map((a) => a.script), ['V1__start.sql', 'V2__routines.sql', 'V3__function.sql', 'R__view.sql'])
  assert.equal(r.applied[0].transactional, false, 'MySQL commits DDL at once')
  assert.ok(await succeeds(cfg, 'test', 'call add_order(\'x\')'))
  assert.deepEqual((await runner.info(cfg, 'test')).map((i) => i.state), ['applied', 'applied', 'applied', 'applied'])

  // A dry run writes the history table without a schema; nothing runs.
  p.write('V4__more.sql', 'insert into orders (note) values (\'dry\');\n')
  p.write('U4__more.sql', 'delete from orders where note = \'dry\';\n')
  const dry = (await runner.migrate(cfg, 'test', { dryRun: true })).dry_run_sql!
  assert.ok(dry.includes('START TRANSACTION;') && dry.includes('INSERT INTO `liftoff_schema_history`'), dry)
  assert.equal((await runner.info(cfg, 'test')).find((i) => i.script === 'V4__more.sql')?.state, 'pending')

  // Data only: one transaction, so a failure leaves nothing behind and no failed row.
  p.write('V5__bad.sql', "insert into orders (note) values ('kept?');\ninsert into no_such_table values (1);\n")
  await assert.rejects(runner.migrate(cfg, 'test'), (e: unknown) => e instanceof MigrationError && /no_such_table/.test(e.message) && /error 1146/.test(e.message))
  assert.equal((await runner.info(cfg, 'test')).find((i) => i.script === 'V5__bad.sql')?.state, 'pending')
  assert.ok(!(await succeeds(cfg, 'test', "select 1 from orders where note = 'kept?' having count(*) > 0 into @x; signal sqlstate '45000' set message_text = 'kept'")))
  p.remove('V5__bad.sql')

  // DDL that fails part-way: recorded as failed, repair clears it.
  p.write('V5__ddl.sql', 'create table extra (id int);\nalter table no_such_table add column x int;\n')
  await assert.rejects(runner.migrate(cfg, 'test'))
  assert.equal((await runner.info(cfg, 'test')).find((i) => i.script === 'V5__ddl.sql')?.state, 'failed')
  const repaired = await runner.repair(cfg, 'test')
  assert.deepEqual(repaired.removed_failed, ['V5__ddl.sql'])
  p.remove('V5__ddl.sql')
  await sql(cfg, 'test', 'drop table extra')

  // Undo, clean, and a database with objects but no history.
  await runner.migrate(cfg, 'test')
  await runner.undo(cfg, 'test')
  assert.equal((await runner.info(cfg, 'test')).find((i) => i.script === 'V4__more.sql')?.state, 'pending')
  await runner.migrate(cfg, 'dev')
  await runner.clean(cfg, 'dev')
  assert.ok(!(await succeeds(cfg, 'dev', 'select 1 from orders')), 'clean drops everything')
  await sql(cfg, 'dev', 'create table stray (id int)')
  await assert.rejects(runner.migrate(cfg, 'dev'), /baseline|objects/i)
})

test('data compare on MySQL: 60,000 rows, tricky values, keys, order, and a script that fixes it', { skip: !base && 'set LIFTOFF_TEST_MYSQL' }, async () => {
  await fresh('dc_a', 'dc_b')
  const p = project('mysql', [
    ['a', `${base}/dc_a`, 'dev'],
    ['b', `${base}/dc_b`, 'test'],
  ])
  const cfg = p.cfg()
  for (const env of ['a', 'b']) {
    await sql(cfg, env, `create table customers (
        id int auto_increment primary key, email varchar(100) not null, note varchar(100) null, amount decimal(12, 2),
        seen datetime(3), data varbinary(16), flag bit(1), doubled decimal(14, 2) as (amount * 2) stored);
      create table orders (id int primary key, customer_id int not null, foreign key (customer_id) references customers (id));
      create table line_items (order_id int not null, line int not null, item varchar(50), primary key (order_id, line), foreign key (order_id) references orders (id));
      create table nokey (a int, b varchar(10));
      set session cte_max_recursion_depth = 100000;
      insert into customers (email, note, amount, seen, data, flag)
        with recursive n(i) as (select 1 union all select i + 1 from n where i < 60000)
        select concat('c', i, '@example.com'), if(i % 7 = 0, null, concat('note ', i)), i * 1.25,
               timestamp('2026-01-01') + interval i minute, unhex(lpad(hex(i), 8, '0')), i % 2 from n;
      insert into orders with recursive n(i) as (select 1 union all select i + 1 from n where i < 100) select i, i from n;
      insert into line_items select o.id, l.i, concat('item ', o.id, '-', l.i) from orders o, (select 1 i union all select 2 union all select 3) l;
      insert into nokey values (1, 'x'), (2, 'y'), (3, null);`)
  }
  await sql(cfg, 'a', `insert into nokey values (2, 'y');
    insert into customers (id, email) values (60001, 'new@example.com'); insert into orders values (101, 60001);
    insert into line_items values (101, 1, 'new line'), (101, 2, 'O''Brien \\\\ back');`)
  await sql(cfg, 'b', `update nokey set b = 'z' where a = 3; insert into nokey values (4, 'w');
    update customers set note = '' where id = 7;
    update customers set amount = 12.51 where id = 10;
    update customers set data = unhex('00') where id = 40000;
    update customers set flag = 0 where id = 59999;
    delete from line_items where order_id = 5 and line = 2;
    insert into customers (id, email) values (70000, 'only-b@example.com'); insert into orders values (200, 70000); insert into line_items values (200, 1, 'stale');`)

  const { DataSession } = await import('../src/core/datacompare.ts')
  const { parseSide } = await import('../src/core/compare.ts')
  const logged: string[] = []
  const s = await DataSession.open(cfg, parseSide('a'), parseSide('b'), undefined, (_l, m) => logged.push(m))
  try {
    const t = Object.fromEntries(s.result.tables.map((x) => [x.table, x]))
    assert.ok(logged.some((m) => m.startsWith('customers: ') && m.includes('buckets differ')), `the bucket path ran: ${logged.join(' | ')}`)
    assert.deepEqual([t.customers.only_in_source, t.customers.only_in_target, t.customers.different], [1, 1, 4], JSON.stringify(t.customers))
    assert.deepEqual([t.orders.only_in_source, t.orders.only_in_target], [1, 1])
    assert.deepEqual([t.line_items.only_in_source, t.line_items.only_in_target, t.line_items.key], [3, 1, ['order_id', 'line']])
    assert.deepEqual([t.nokey.only_in_source, t.nokey.only_in_target, t.nokey.whole_rows], [2, 2, true])
    assert.ok(!('liftoff_schema_history' in t))
    const page = await s.page('customers', 'different', 0, 10)
    const note = page.columns.indexOf('note')
    const seven = page.rows.find((r) => r.key[0] === '7')!
    assert.deepEqual([seven.source![note], seven.target![note]], [null, ''])
    assert.ok(!page.columns.includes('doubled'), 'generated columns are not compared')

    let script = ''
    for await (const chunk of s.script()) script += chunk
    assert.ok(script.search(/DELETE FROM `line_items`/) < script.search(/DELETE FROM `orders`/), 'child rows are deleted first')
    assert.ok(script.search(/INSERT INTO `customers`/) < script.search(/INSERT INTO `line_items`/), 'parent rows are inserted first')
    assert.match(script, /SET `note` = NULL WHERE `id` = '7'/)
    assert.match(script, /'O''Brien \\\\ back'/)
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

test('the diff loop on MySQL', { skip: !base && 'set LIFTOFF_TEST_MYSQL' }, async () => {
  await fresh('shop_dev', 'shop_test')
  const p = project('mysql', [
    ['dev', `${base}/shop_dev`, 'dev'],
    ['test', `${base}/shop_test`, 'test'],
  ])
  const created = await diff.createScratch(p.cfg(), undefined, 'scratch')
  assert.equal(created.database, 'shop_dev_scratch')
  const cfg = Config.load(p.dir)
  const ids = (changes: { id: string }[]) => changes.map((c) => c.id).sort()

  // 1. The same scripts on databases of different names compare equal.
  p.write(
    'V1__start.sql',
    `create table customers (id int auto_increment primary key, email varchar(200) not null, unique key email_uq (email));
create table orders (
  id int auto_increment primary key,
  customer_id int not null,
  note varchar(100) not null default '',
  total decimal(10,2) null check (total >= 0),
  foreign key (customer_id) references customers (id)
);
create index ix_orders_note on orders (note);
create view order_notes as select id, note from orders;
create procedure add_order(n varchar(100)) begin insert into orders (customer_id, note) values (1, n); end;
create function order_count() returns int reads sql data return (select count(*) from orders);
`,
  )
  for (const e of ['dev', 'test']) await runner.migrate(cfg, e)
  assert.deepEqual(ids((await diff.devVsMigrations(cfg, undefined, undefined)).changes), [])

  // 2. Change dev by hand in every way the diff knows.
  for (const s of [
    'create table invoices (id int primary key, order_id int, constraint fk_invoice_order foreign key (order_id) references orders (id))',
    "alter table orders add column status varchar(20) not null default 'new' after note",
    'alter table orders modify column note varchar(200) not null',
    'create index ix_orders_status on orders (status, total)',
    'drop index ix_orders_note on orders',
    "alter table customers comment = 'who buys'",
    'create or replace view order_notes as select id, note, status from orders',
    'drop procedure add_order',
    'create procedure add_order(n varchar(200)) begin insert into orders (customer_id, note) values (1, n); end',
    'create trigger orders_touch before update on orders for each row set new.note = trim(new.note)',
    'drop function order_count',
  ]) {
    await sql(cfg, 'dev', s)
  }
  let cmp = await diff.devVsMigrations(cfg, undefined, undefined)
  assert.deepEqual(ids(cmp.changes), ['function:order_count', 'procedure:add_order', 'table:customers', 'table:invoices', 'table:orders', 'trigger:orders_touch', 'view:order_notes'])
  assert.ok(cmp.changes.find((c) => c.id === 'table:orders')!.destructive, 'a column type change may lose data')
  assert.equal(cmp.not_compared.length, 0)

  // 3. Generate with undo, run it on test, record it on dev: everything matches again.
  const g = diff.generate(cfg, cmp.changes, 'invoices and status', true)
  diff.save(cfg, g.file_name, g.sql)
  diff.save(cfg, g.undo!.file_name, g.undo!.sql)
  await runner.migrate(cfg, 'test')
  await runner.markApplied(cfg, 'dev', g.file_name)
  cmp = await diff.devVsMigrations(cfg, undefined, undefined)
  assert.deepEqual(ids(cmp.changes), [], g.sql)

  // 4. No drift on test; the undo script takes test back and there is still no drift.
  let drift = (await checks.check(cfg, 'test', undefined, { drift: true })).drift!
  assert.deepEqual(ids(drift), [])
  await runner.undo(cfg, 'test')
  drift = (await checks.check(cfg, 'test', undefined, { drift: true })).drift!
  assert.deepEqual(ids(drift), [], `${g.undo!.sql}\n${drift.map((d) => `${d.before}\n---\n${d.after}`).join('\n')}`)

  // 5. Drift is seen: a hand-made index on test.
  await sql(cfg, 'test', 'create index ix_by_hand on orders (total)')
  assert.deepEqual(ids((await checks.check(cfg, 'test', undefined, { drift: true })).drift!), ['table:orders'])

  // 6. Capture and squash build the whole schema from nothing, checked by a rebuild.
  const cap = await diff.capture(cfg, 'dev', 'existing schema', false)
  assert.ok(cap.sql.includes('CREATE TABLE `customers`') && cap.sql.includes('DELIMITER //'), cap.sql)
  const sq = await diff.squash(cfg, undefined, 'start', undefined, false)
  assert.ok(sq.path && sq.generated.file_name.startsWith('B'))

  // 7. The schema model writes one file per object, and builds again.
  const changes = await model.status(cfg, undefined)
  const paths = changes.map((f) => f.path)
  for (const f of ['tables/orders.sql', 'views/order_notes.sql', 'procedures/add_order.sql', 'triggers/orders_touch.sql']) assert.ok(paths.includes(f), `${f} in ${paths}`)
  model.save(cfg, changes)
  assert.equal(await model.check(cfg, undefined), paths.length)
  assert.deepEqual(ids((await model.versusMigrations(cfg, undefined)).changes), [])
})
