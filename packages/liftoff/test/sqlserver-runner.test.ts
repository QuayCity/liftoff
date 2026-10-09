// The runner against a real SQL Server (ported from crates/core/tests/mssql.rs).
// Drops and recreates the databases shop_test and shop_dev on that server.

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { saveProject } from '../src/core/config.ts'
import { LiftoffError, MigrationError } from '../src/core/errors.ts'
import * as runner from '../src/core/runner.ts'
import { SqlServerConn } from '../src/core/sqlserver.ts'
import { project, sql, succeeds } from './helpers.ts'

const base = process.env.LIFTOFF_TEST_MSSQL

test('the SQL Server sample project runs and undoes', { skip: !base && 'set LIFTOFF_TEST_MSSQL' }, async () => {
  const { createSample } = await import('../src/core/sample.ts')
  const { Config, saveEnvironment } = await import('../src/core/config.ts')
  const fs = await import('node:fs')
  const os = await import('node:os')
  const path = await import('node:path')
  const master = await SqlServerConn.open('master', { url: `${base};databaseName=master`, role: 'prod', allow_clean: false, placeholders: {} })
  await master.batch(`IF DB_ID('shop_sample') IS NOT NULL BEGIN ALTER DATABASE [shop_sample] SET SINGLE_USER WITH ROLLBACK IMMEDIATE; DROP DATABASE [shop_sample]; END; CREATE DATABASE [shop_sample];`)
  await master.close()
  const root = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'lo-mssample-')), 'sample')
  createSample(root, 'sqlserver')
  saveEnvironment(root, 'test', { url: `${base};databaseName=shop_sample`, role: 'test', allow_clean: false, placeholders: {} }, true, false)
  const cfg = Config.load(root)
  const r = await runner.migrate(cfg, 'test')
  assert.deepEqual(r.applied.map((a) => a.script), ['V1__customers.sql', 'V2__orders.sql', 'V3__orders_by_customer.sql', 'R__customer_totals.sql'])
  await runner.undo(cfg, 'test')
  assert.equal((await runner.info(cfg, 'test')).find((i) => i.script === 'V3__orders_by_customer.sql')?.state, 'pending')
})

test('a batch with several SQL Server errors reports every one of them', { skip: !base && 'set LIFTOFF_TEST_MSSQL' }, async () => {
  const c = await SqlServerConn.open('master', { url: `${base};databaseName=master`, role: 'test', allow_clean: false, placeholders: {} })
  try {
    await assert.rejects(c.batch('SELECT 1 FROM no_such_table_a;\nSELEC 2;\nCREATE TABLE #t (id int);\nCREATE VIEW v AS SELECT 1 AS a;'), (e: unknown) => {
      const m = e instanceof Error ? e.message : ''
      assert.match(m, /must be the first statement in a query batch/, m)
      assert.match(m, /\(error 111, line 4\)/, m)
      return true
    })
  } finally {
    await c.close()
  }
})

test('the runner on SQL Server', { skip: !base && 'set LIFTOFF_TEST_MSSQL' }, async () => {
  const master = await SqlServerConn.open('master', { url: `${base};databaseName=master`, role: 'prod', allow_clean: false, placeholders: {} })
  for (const db of ['shop_test', 'shop_dev']) {
    await master.batch(`IF DB_ID('${db}') IS NOT NULL BEGIN ALTER DATABASE [${db}] SET SINGLE_USER WITH ROLLBACK IMMEDIATE; DROP DATABASE [${db}]; END; CREATE DATABASE [${db}];`)
  }
  await master.close()
  const p = project('sqlserver', [
    ['test', `${base};databaseName=shop_test`, 'test'],
    ['dev', `${base};databaseName=shop_dev`, 'dev', { allow_clean: true }],
  ])
  const first = p.cfg()
  assert.equal(first.project.engine, 'sqlserver')
  assert.deepEqual(first.project.schemas, ['dbo'])
  saveProject(p.dir, { ...first.project, placeholders: { app_role: 'shop_app' } })
  const cfg = p.cfg()
  const state = async (env: string, script: string) => (await runner.info(cfg, env)).find((i) => i.script === script)?.state

  // 1. GO batches, a procedure, a repeated batch, a placeholder, a repeatable; three runs at once.
  p.write(
    'V1__orders.sql',
    'CREATE ROLE ${app_role};\nGO\nCREATE TABLE dbo.orders (id int IDENTITY PRIMARY KEY, note nvarchar(100) NOT NULL);\nGO\n' +
      'CREATE PROCEDURE dbo.add_order @note nvarchar(100) AS\nBEGIN\n  INSERT INTO dbo.orders (note) VALUES (@note);\nEND\nGO\n' +
      "EXEC dbo.add_order N'GO on its own line inside a string\nGO\nstill one string';\nGO 2\n",
  )
  p.write('R__order_view.sql', 'CREATE OR ALTER VIEW dbo.order_notes AS SELECT id, note FROM dbo.orders;\n')
  const runs = await Promise.all([runner.migrate(cfg, 'test'), runner.migrate(cfg, 'test'), runner.migrate(cfg, 'test')])
  assert.equal(runs.reduce((n, r) => n + r.applied.length, 0), 2, 'the application lock let each script run once')
  assert.equal((await runner.migrate(cfg, 'test')).applied.length, 0)
  assert.ok((await runner.info(cfg, 'test')).every((i) => i.state === 'applied'))
  assert.ok(await succeeds(cfg, 'test', "IF (SELECT COUNT(*) FROM dbo.orders) <> 2 THROW 50000, 'GO 2 should insert twice', 1;"))
  assert.ok(await succeeds(cfg, 'test', "IF DATABASE_PRINCIPAL_ID('shop_app') IS NULL THROW 50000, 'placeholder not replaced', 1;"))

  // 2. A failing script rolls back completely (XACT_ABORT) and leaves no history row.
  p.write('V2__broken.sql', 'CREATE TABLE dbo.half_done (id int);\nGO\nINSERT INTO dbo.no_such_table VALUES (1);\n')
  await assert.rejects(runner.migrate(cfg, 'test'), (e: unknown) => e instanceof MigrationError && /no_such_table/.test(e.message) && /error 208/.test(e.message))
  assert.ok(await succeeds(cfg, 'test', "IF OBJECT_ID(N'dbo.half_done') IS NOT NULL THROW 50000, 'not rolled back', 1;"))
  assert.equal(await state('test', 'V2__broken.sql'), 'pending')

  // 3. Fixed, plus a script that cannot run in a transaction.
  p.write('V2__broken.sql', 'CREATE TABLE dbo.half_done (id int);\n')
  p.write('V3__recovery.sql', 'ALTER DATABASE CURRENT SET RECOVERY SIMPLE;\n')
  const r3 = await runner.migrate(cfg, 'test')
  assert.deepEqual(r3.applied.map((a) => [a.script, a.transactional]), [['V2__broken.sql', true], ['V3__recovery.sql', false]])

  // 4. An edited script is caught and repair realigns it; undo runs the U script.
  p.write('V2__broken.sql', 'CREATE TABLE dbo.half_done (id int, x int);\n')
  await assert.rejects(runner.migrate(cfg, 'test'), /V2__broken.sql changed after it was applied/)
  assert.deepEqual((await runner.repair(cfg, 'test')).realigned, ['V2__broken.sql'])
  await runner.validateEnv(cfg, 'test')
  p.write('V4__total.sql', 'ALTER TABLE dbo.orders ADD total decimal(10, 2) NULL;\n')
  p.write('U4__total.sql', 'ALTER TABLE dbo.orders DROP COLUMN total;\n')
  await runner.migrate(cfg, 'test')
  assert.equal((await runner.undo(cfg, 'test')).script, 'U4__total.sql')
  assert.ok(await succeeds(cfg, 'test', "IF COL_LENGTH('dbo.orders', 'total') IS NOT NULL THROW 50000, 'undo did not run', 1;"))
  assert.equal(await state('test', 'V4__total.sql'), 'pending')

  // 5. The dry run speaks T-SQL.
  const dry = (await runner.migrate(cfg, 'test', { dryRun: true })).dry_run_sql!
  assert.ok(dry.includes('BEGIN TRANSACTION;') && dry.includes('SUSER_SNAME()') && dry.includes('[dbo].[liftoff_schema_history]'), dry)

  // 6. Tables but no history: a baseline is needed first; then only later scripts run.
  await sql(cfg, 'dev', 'CREATE TABLE dbo.legacy (id int PRIMARY KEY); CREATE TABLE dbo.orders (id int IDENTITY PRIMARY KEY, note nvarchar(100) NOT NULL);')
  await assert.rejects(runner.migrate(cfg, 'dev'), (e: unknown) => e instanceof LiftoffError && e.code === 'LIFTOFF_NOT_BASELINED')
  await runner.baseline(cfg, 'dev', '3', 'existing')
  assert.deepEqual((await runner.migrate(cfg, 'dev')).applied.map((a) => a.script), ['V4__total.sql', 'R__order_view.sql'])

  // 7. Clean removes everything, whatever depends on what; the schema stays.
  await sql(
    cfg,
    'dev',
    'CREATE TABLE dbo.customers (id int PRIMARY KEY); ALTER TABLE dbo.legacy ADD customer_id int REFERENCES dbo.customers (id); ' +
      'CREATE TYPE dbo.money_amount FROM decimal(12, 2); CREATE SEQUENCE dbo.invoice_no START WITH 1;',
  )
  await sql(cfg, 'dev', 'CREATE VIEW dbo.legacy_ids WITH SCHEMABINDING AS SELECT id FROM dbo.legacy;')
  await sql(cfg, 'dev', 'CREATE FUNCTION dbo.legacy_count() RETURNS int AS BEGIN RETURN (SELECT COUNT(*) FROM dbo.legacy_ids) END;')
  await assert.rejects(runner.clean(cfg, 'test'), /allow_clean/)
  await runner.clean(cfg, 'dev')
  assert.ok(
    await succeeds(
      cfg,
      'dev',
      "IF EXISTS (SELECT 1 FROM sys.objects WHERE schema_id = SCHEMA_ID('dbo') AND is_ms_shipped = 0 AND parent_object_id = 0) " +
        "OR EXISTS (SELECT 1 FROM sys.types WHERE is_user_defined = 1 AND schema_id = SCHEMA_ID('dbo')) THROW 50000, 'clean left objects behind', 1;",
    ),
  )
  assert.equal((await runner.migrate(cfg, 'dev')).applied.length, 5, 'a cleaned database takes every script again')
})
