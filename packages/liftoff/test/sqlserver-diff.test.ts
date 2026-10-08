// Compare, generate, undo, drift checks, capture, squash and the schema model on a real SQL Server
// (ported from crates/core/tests/mssql_diff.rs). Drops and recreates shop_dev, shop_test and shop_dev_scratch.

import assert from 'node:assert/strict'
import { test } from 'node:test'
import * as checks from '../src/core/checks.ts'
import { Config } from '../src/core/config.ts'
import * as diff from '../src/core/diff.ts'
import * as model from '../src/core/model.ts'
import * as runner from '../src/core/runner.ts'
import { SqlServerConn } from '../src/core/sqlserver.ts'
import { project, sql } from './helpers.ts'

const base = process.env.LIFTOFF_TEST_MSSQL

test('the diff loop on SQL Server', { skip: !base && 'set LIFTOFF_TEST_MSSQL' }, async () => {
  const master = await SqlServerConn.open('master', { url: `${base};databaseName=master`, role: 'prod', allow_clean: false, placeholders: {} })
  for (const db of ['shop_dev', 'shop_test', 'shop_dev_scratch']) {
    await master.batch(`IF DB_ID('${db}') IS NOT NULL BEGIN ALTER DATABASE [${db}] SET SINGLE_USER WITH ROLLBACK IMMEDIATE; DROP DATABASE [${db}]; END`)
  }
  for (const db of ['shop_dev', 'shop_test']) await master.batch(`CREATE DATABASE [${db}]`)
  await master.close()
  const p = project('sqlserver', [
    ['dev', `${base};databaseName=shop_dev`, 'dev'],
    ['test', `${base};databaseName=shop_test`, 'test'],
  ])
  const created = await diff.createScratch(p.cfg(), undefined, 'scratch')
  assert.equal(created.database, 'shop_dev_scratch')
  const cfg = Config.load(p.dir)
  const ids = (changes: { id: string }[]) => changes.map((c) => c.id).sort()

  // 1. The same scripts on two databases compare equal, whatever names SQL Server made up.
  p.write(
    'V1__start.sql',
    `CREATE TABLE dbo.orders (
       id int IDENTITY(1,1) PRIMARY KEY,
       note nvarchar(100) NOT NULL DEFAULT (N''),
       total decimal(10,2) NULL CHECK (total >= 0),
       qty int NOT NULL CONSTRAINT df_orders_qty DEFAULT (1),
       line_total AS (qty * total)
     );
     GO
     CREATE INDEX ix_orders_note ON dbo.orders (note);
     GO
     CREATE VIEW dbo.order_notes AS SELECT id, note FROM dbo.orders;
     GO
     CREATE PROCEDURE dbo.add_order @note nvarchar(100) AS INSERT INTO dbo.orders (note) VALUES (@note);
     GO
     CREATE FUNCTION dbo.order_count() RETURNS int AS BEGIN RETURN (SELECT COUNT(*) FROM dbo.orders) END;
     GO
`,
  )
  for (const e of ['dev', 'test']) await runner.migrate(cfg, e)
  assert.deepEqual(ids((await diff.devVsMigrations(cfg, undefined, undefined)).changes), [])

  // 2. Change dev by hand in every way the diff knows.
  for (const s of [
    'CREATE TYPE dbo.money_amount FROM decimal(12, 2) NOT NULL',
    'CREATE SEQUENCE dbo.invoice_no AS bigint START WITH 1000 INCREMENT BY 1',
    'CREATE TABLE dbo.customers (id int NOT NULL PRIMARY KEY, email nvarchar(200) NOT NULL UNIQUE, credit dbo.money_amount)',
    "ALTER TABLE dbo.orders ADD customer_id int NULL FOREIGN KEY REFERENCES dbo.customers (id), status varchar(20) NOT NULL CONSTRAINT df_orders_status DEFAULT ('new')",
    'ALTER TABLE dbo.orders ALTER COLUMN note nvarchar(200) NOT NULL',
    "CREATE INDEX ix_orders_open ON dbo.orders (customer_id) INCLUDE (total) WHERE status = 'new'",
    'CREATE OR ALTER VIEW dbo.order_notes AS SELECT id, note, status FROM dbo.orders',
    'CREATE OR ALTER PROCEDURE dbo.add_order @note nvarchar(200) AS INSERT INTO dbo.orders (note) VALUES (@note)',
    'CREATE TRIGGER dbo.orders_touch ON dbo.orders AFTER UPDATE AS SET NOCOUNT ON',
    'DROP FUNCTION dbo.order_count',
  ]) {
    await sql(cfg, 'dev', s)
  }
  let cmp = await diff.devVsMigrations(cfg, undefined, undefined)
  assert.deepEqual(ids(cmp.changes), [
    'function:dbo.order_count', 'procedure:dbo.add_order', 'sequence:dbo.invoice_no', 'table:dbo.customers',
    'table:dbo.orders', 'trigger:dbo.orders_touch', 'type:dbo.money_amount', 'view:dbo.order_notes',
  ])
  assert.ok(cmp.changes.find((c) => c.id === 'table:dbo.orders')!.destructive, 'a column type change may lose data')

  // 3. Generate with undo, run it on test, record it on dev: everything matches again.
  const g = diff.generate(cfg, cmp.changes, 'customers and status', true)
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
  assert.deepEqual(ids(drift), [], g.undo!.sql)

  // 5. Drift is seen: a hand-made index on test.
  await sql(cfg, 'test', 'CREATE INDEX ix_by_hand ON dbo.orders (total)')
  assert.deepEqual(ids((await checks.check(cfg, 'test', undefined, { drift: true })).drift!), ['table:dbo.orders'])

  // 6. Capture and squash build the whole schema from nothing, checked by a rebuild.
  const cap = await diff.capture(cfg, 'dev', 'existing schema', false)
  assert.ok(cap.sql.includes('CREATE TABLE [dbo].[customers]') && cap.sql.includes('CREATE TRIGGER'), cap.sql)
  const sq = await diff.squash(cfg, undefined, 'start', undefined, false)
  assert.ok(sq.path && sq.generated.file_name.startsWith('B'))

  // 7. The schema model writes one file per object.
  const paths = (await model.status(cfg, undefined)).map((f) => f.path)
  for (const f of ['dbo/tables/orders.sql', 'dbo/views/order_notes.sql', 'dbo/procedures/add_order.sql', 'dbo/triggers/orders_touch.sql', 'dbo/sequences/invoice_no.sql', 'dbo/types/money_amount.sql']) {
    assert.ok(paths.includes(f), `${f} in ${paths}`)
  }
})
