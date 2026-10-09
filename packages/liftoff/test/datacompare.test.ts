// Data compare against real databases: exact differences on tables big enough to use buckets,
// values that are easy to get wrong, statement order by foreign key, and a sync script that leaves
// no differences behind.

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { parseSide } from '../src/core/compare.ts'
import { DataSession, parentsFirst } from '../src/core/datacompare.ts'
import { SqlServerConn } from '../src/core/sqlserver.ts'
import { pgSchemaReset, project, sql } from './helpers.ts'

const pg = process.env.LIFTOFF_TEST_PG
const ms = process.env.LIFTOFF_TEST_MSSQL

test('statement order: parents before children, cycles do not hang', () => {
  assert.deepEqual(parentsFirst(['s.lines', 's.orders', 's.customers'], [['s.lines', 's.orders'], ['s.orders', 's.customers']]), ['s.customers', 's.orders', 's.lines'])
  assert.deepEqual(parentsFirst(['a', 'b'], [['a', 'b'], ['b', 'a']]).sort(), ['a', 'b'])
})

const byTable = (s: DataSession) => Object.fromEntries(s.result.tables.map((t) => [t.table, t]))

test('data compare on PostgreSQL: 60,000 rows, tricky values, keys, order, and a script that fixes it', { skip: !pg && 'set LIFTOFF_TEST_PG' }, async () => {
  const p = project('postgresql', [
    ['dev', `${pg}/shop_dev`, 'dev'],
    ['test', `${pg}/shop_test`, 'test'],
  ])
  const cfg = p.cfg()
  const schema = `${pgSchemaReset}
    create table customers (
      id int generated always as identity primary key, email text not null, note text, amount numeric(12, 2),
      seen timestamptz, data bytea, tags text[], doubled numeric generated always as (amount * 2) stored);
    create table orders (id int primary key, customer_id int not null references customers (id));
    create table lines (order_id int not null references orders (id), line int not null, item text, primary key (order_id, line));
    create table nokey (a int, b text);`
  for (const env of ['dev', 'test']) {
    await sql(cfg, env, schema)
    await sql(cfg, env, `insert into customers (email, note, amount, seen, data, tags)
      select 'c' || i || '@example.com', case when i % 7 = 0 then null else 'note ' || i end, i * 1.25,
             timestamptz '2026-01-01 00:00:00+00' + i * interval '1 minute', decode(lpad(to_hex(i), 8, '0'), 'hex'), array['t' || (i % 3)]
        from generate_series(1, 60000) i;
      insert into orders select i, i from generate_series(1, 100) i;
      insert into lines select o, l, 'item ' || o || '-' || l from generate_series(1, 100) o, generate_series(1, 3) l;
      insert into nokey values (1, 'x');`)
  }
  // Only in dev (the source): a customer, an order with its lines.
  await sql(cfg, 'dev', `insert into customers (id, email) overriding system value values (60001, 'new@example.com');
    insert into orders values (101, 60001); insert into lines values (101, 1, 'new line'), (101, 2, 'second');`)
  // Changed or extra in test (the target).
  await sql(cfg, 'test', `update customers set note = '' where id = 7;          -- NULL in dev, '' in test
    update customers set amount = 12.51 where id = 10;                          -- 12.50 in dev
    update customers set data = '\\x00' where id = 40000;
    update customers set tags = array['t1', 't2'] where id = 59999;
    delete from lines where order_id = 5 and line = 2;
    delete from customers where id in (30001, 30002) and not exists (select 1 from orders where customer_id = customers.id);
    insert into customers (id, email) overriding system value values (70000, 'only-test@example.com');
    insert into orders values (200, 70000); insert into lines values (200, 1, 'stale');`)

  const logged: string[] = []
  const s = await DataSession.open(cfg, parseSide('dev'), parseSide('test'), undefined, (_l, m) => logged.push(m))
  try {
    const t = byTable(s)
    assert.ok(logged.some((m) => m.startsWith('public.customers: ') && m.includes('buckets differ')), `the bucket path ran: ${logged.join(' | ')}`)
    assert.deepEqual([t['public.customers'].only_in_source, t['public.customers'].only_in_target, t['public.customers'].different], [3, 1, 4], JSON.stringify(t['public.customers']))
    assert.deepEqual([t['public.orders'].only_in_source, t['public.orders'].only_in_target], [1, 1])
    assert.deepEqual([t['public.lines'].only_in_source, t['public.lines'].only_in_target, t['public.lines'].key], [3, 1, ['order_id', 'line']])
    assert.match(t['public.nokey'].skipped ?? '', /no primary key/)
    assert.ok(!('public.liftoff_schema_history' in t))

    // A page of differences with both rows: NULL stays null, '' stays ''.
    const page = await s.page('public.customers', 'different', 0, 10)
    assert.equal(page.total, 4)
    const note = page.columns.indexOf('note')
    const seven = page.rows.find((r) => r.key[0] === '7')!
    assert.deepEqual([seven.source![note], seven.target![note]], [null, ''])
    assert.ok(!page.columns.includes('doubled'), 'generated columns are not compared')

    // The script: deletes children first, inserts parents first, updates only changed columns.
    let script = ''
    for await (const chunk of s.script()) script += chunk
    const at = (re: RegExp) => script.search(re)
    assert.ok(at(/DELETE FROM "?public"?\."?lines"?/) < at(/DELETE FROM "?public"?\."?orders"?/), 'child rows are deleted first')
    assert.ok(at(/INSERT INTO "?public"?\."?customers"?/) < at(/INSERT INTO "?public"?\."?lines"?/), 'parent rows are inserted first')
    assert.match(script, /OVERRIDING SYSTEM VALUE/)
    // Test gets dev's values: NULL where test has '', 12.50 where test has 12.51.
    assert.match(script, /SET note = NULL WHERE id = '7'::integer/)
    assert.match(script, /SET amount = '12\.50'::numeric\(12,2\) WHERE id = '10'::integer/)
    assert.doesNotMatch(script, /doubled/)

    await s.apply()
  } finally {
    await s.close()
  }
  const again = await DataSession.open(cfg, parseSide('dev'), parseSide('test'))
  try {
    for (const r of again.result.tables.filter((x) => !x.skipped)) assert.deepEqual([r.table, r.only_in_source, r.only_in_target, r.different], [r.table, 0, 0, 0])
  } finally {
    await again.close()
  }
})

test('data compare on SQL Server: identity, binary, NULL vs empty, and back to no differences', { skip: !ms && 'set LIFTOFF_TEST_MSSQL' }, async () => {
  const master = await SqlServerConn.open('master', { url: `${ms};databaseName=master`, role: 'prod', allow_clean: false, placeholders: {} })
  for (const db of ['dc_a', 'dc_b']) {
    await master.batch(`IF DB_ID('${db}') IS NOT NULL BEGIN ALTER DATABASE [${db}] SET SINGLE_USER WITH ROLLBACK IMMEDIATE; DROP DATABASE [${db}]; END; CREATE DATABASE [${db}];`)
  }
  await master.close()
  const p = project('sqlserver', [
    ['a', `${ms};databaseName=dc_a`, 'dev'],
    ['b', `${ms};databaseName=dc_b`, 'test'],
  ])
  const cfg = p.cfg()
  for (const env of ['a', 'b']) {
    await sql(cfg, env, `CREATE TABLE dbo.items (
      id int IDENTITY(1, 1) PRIMARY KEY, code uniqueidentifier NOT NULL, name nvarchar(100) NULL, price float NULL,
      at datetime2(7) NULL, blob varbinary(16) NULL, total AS (price * 2), version rowversion);`)
    await sql(cfg, env, `WITH n AS (SELECT TOP (60000) ROW_NUMBER() OVER (ORDER BY (SELECT NULL)) AS i FROM sys.all_columns a CROSS JOIN sys.all_columns b)
      INSERT INTO dbo.items (code, name, price, at, blob)
      SELECT CAST(HASHBYTES('MD5', CAST(i AS varchar(10))) AS uniqueidentifier), CASE WHEN i % 5 = 0 THEN NULL ELSE CONCAT(N'item ', i) END,
             i / 3.0, DATEADD(SECOND, i, CAST('2026-01-01T00:00:00.1234567' AS datetime2(7))), CAST(i AS varbinary(16)) FROM n`)
  }
  await sql(cfg, 'b', `UPDATE dbo.items SET name = N'' WHERE id = 5;
    UPDATE dbo.items SET price = 0.1 + 0.2 WHERE id = 6;
    UPDATE dbo.items SET blob = 0x00 WHERE id = 50000;
    DELETE FROM dbo.items WHERE id = 100;`)
  await sql(cfg, 'a', `DELETE FROM dbo.items WHERE id = 200;`)

  const logged: string[] = []
  const s = await DataSession.open(cfg, parseSide('a'), parseSide('b'), undefined, (_l, m) => logged.push(m))
  try {
    const t = byTable(s)['dbo.items']
    assert.ok(logged.some((m) => m.startsWith('dbo.items: ') && m.includes('buckets differ')), `the bucket path ran: ${logged.join(' | ')}`)

    assert.deepEqual([t.only_in_source, t.only_in_target, t.different], [1, 1, 3], JSON.stringify(t))
    const page = await s.page('dbo.items', 'different', 0, 10)
    const name = page.columns.indexOf('name')
    const five = page.rows.find((r) => r.key[0] === '5')!
    assert.deepEqual([five.source![name], five.target![name]], [null, ''])
    assert.ok(!page.columns.includes('total') && !page.columns.includes('version'), 'computed and rowversion columns are left out')
    let script = ''
    for await (const chunk of s.script()) script += chunk
    assert.match(script, /SET IDENTITY_INSERT \[dbo\]\.\[items\] ON/)
    await s.apply()
  } finally {
    await s.close()
  }
  const again = await DataSession.open(cfg, parseSide('a'), parseSide('b'))
  try {
    const t = byTable(again)['dbo.items']
    assert.deepEqual([t.only_in_source, t.only_in_target, t.different], [0, 0, 0])
  } finally {
    await again.close()
  }
})
