// Compare (schema) against real databases: any two sides, snapshots, script, migration, apply.

import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { test } from 'node:test'
import * as cmp from '../src/core/compare.ts'
import { LiftoffError } from '../src/core/errors.ts'
import * as runner from '../src/core/runner.ts'
import { SqlServerConn } from '../src/core/sqlserver.ts'
import { pgSchemaReset, project, sql } from './helpers.ts'

const pg = process.env.LIFTOFF_TEST_PG
const ms = process.env.LIFTOFF_TEST_MSSQL
const side = cmp.parseSide

test('sides as written on the command line', () => {
  assert.deepEqual(side('prod'), { kind: 'env', name: 'prod' })
  assert.deepEqual(side('model'), { kind: 'model' })
  assert.deepEqual(side('migrations'), { kind: 'migrations' })
  assert.deepEqual(side('snapshot:snaps/prod'), { kind: 'snapshot', file: 'snaps/prod' })
  assert.deepEqual(side('prod-2026-10.json'), { kind: 'snapshot', file: 'prod-2026-10.json' })
  assert.deepEqual(side('postgres://u:pw@db:5432/shop'), { kind: 'url', url: 'postgres://u:pw@db:5432/shop' })
  assert.equal(cmp.sideLabel(side('postgres://u:pw@db:5432/shop')), 'db:5432/shop', 'no password in a label')
  assert.equal(cmp.sideLabel(side('sqlserver://db:1433;databaseName=shop;user=sa;password=x')), 'db:1433', 'no password in a label')
})

test('Compare on PostgreSQL: two databases, a URL, a snapshot, the model and the migrations', { skip: !pg && 'set LIFTOFF_TEST_PG' }, async () => {
  const p = project('postgresql', [
    ['dev', `${pg}/shop_dev`, 'dev'],
    ['scratch', `${pg}/shop_scratch`, 'scratch'],
    ['test', `${pg}/shop_test`, 'test'],
  ])
  const cfg = p.cfg()
  await sql(cfg, 'dev', `${pgSchemaReset} create table customers (id int primary key, email text not null); create view emails as select email from customers;`)
  await sql(cfg, 'test', `${pgSchemaReset} create table customers (id int primary key); create table legacy (id int);`)

  // Two databases: what makes test like dev.
  let r = await cmp.compare(cfg, side('dev'), side('test'), undefined)
  assert.deepEqual(r.changes.map((c) => `${c.kind} ${c.id}`).sort(), ['added view:public.emails', 'changed table:public.customers', 'removed table:public.legacy'])
  assert.ok(r.changes.find((c) => c.id === 'table:public.legacy')?.destructive, 'dropping a table may lose data')

  // A URL instead of an environment gives the same answer.
  const byUrl = await cmp.compare(cfg, side('dev'), side(`${pg}/shop_test`), undefined)
  assert.deepEqual(byUrl.changes.map((c) => c.id).sort(), r.changes.map((c) => c.id).sort())

  // Picking: unknown ids are refused; the script has only what was picked.
  assert.throws(() => cmp.pick(r.changes, ['table:public.nope']), /not one of the differences/)
  const script = cmp.syncScript(r, cmp.pick(r.changes, ['table:public.customers', 'view:public.emails']))
  assert.match(script, /Makes test match dev/)
  assert.match(script, /ADD COLUMN email/i)
  assert.doesNotMatch(script, /legacy/)

  // Snapshots: a snapshot of a database compared with that database is the same, exactly.
  const snap = await cmp.snapshot(cfg, side('dev'), 'snapshots/dev.json', undefined)
  assert.ok(snap.objects >= 2)
  assert.equal((await cmp.compare(cfg, side('snapshot:snapshots/dev.json'), side('dev'), undefined)).changes.length, 0)
  assert.throws(() => cmp.readSnapshot(cfg, 'snapshots/none.json'), /no snapshot/)
  fs.writeFileSync(path.join(p.dir, 'not-a-snapshot.json'), '{"hello": 1}')
  assert.throws(() => cmp.readSnapshot(cfg, 'not-a-snapshot.json'), /not a LiftOff snapshot/)

  // Apply: test becomes like dev (the chosen changes), outside its migration history.
  await cmp.apply(cfg, side('test'), script)
  r = await cmp.compare(cfg, side('dev'), side('test'), undefined)
  assert.deepEqual(r.changes.map((c) => c.id), ['table:public.legacy'], 'only the change that was not picked is left')
  // A failing script changes nothing (one transaction).
  await assert.rejects(cmp.apply(cfg, side('test'), 'create table half_done (id int);\nselect no_such_function();'))
  r = await cmp.compare(cfg, side('dev'), side('test'), undefined)
  assert.ok(!r.changes.some((c) => c.id === 'table:public.half_done'), 'rolled back')
  await assert.rejects(cmp.apply(cfg, side('migrations'), script), /only a database can be changed/)

  // The migrations and the schema model as sides (both are built on scratch).
  p.write('V1__customers.sql', 'create table customers (id int primary key);\n')
  fs.mkdirSync(path.join(p.dir, 'schema-model/tables'), { recursive: true })
  fs.writeFileSync(path.join(p.dir, 'schema-model/tables/public.customers.sql'), 'CREATE TABLE public.customers (id integer PRIMARY KEY, email text NOT NULL);\n')
  r = await cmp.compare(cfg, side('model'), side('migrations'), undefined)
  assert.deepEqual(r.changes.map((c) => `${c.kind} ${c.id}`), ['changed table:public.customers'])
  assert.deepEqual([r.source, r.target], ['the schema model', 'the migrations'])
  await assert.rejects(cmp.compare(cfg, side('dev'), side('dev'), undefined), /are the same/)
  // The migrations, as run on test, match what they build (test was migrated by LiftOff here).
  await sql(cfg, 'test', pgSchemaReset)
  await runner.migrate(cfg, 'test')
  assert.equal((await cmp.compare(cfg, side('migrations'), side('test'), undefined)).changes.length, 0)
})

test('Compare on SQL Server: snapshot round trip, apply, and no mixing of engines', { skip: (!ms || !pg) && 'set LIFTOFF_TEST_MSSQL and LIFTOFF_TEST_PG' }, async () => {
  const master = await SqlServerConn.open('master', { url: `${ms};databaseName=master`, role: 'prod', allow_clean: false, placeholders: {} })
  for (const db of ['cmp_a', 'cmp_b']) {
    await master.batch(`IF DB_ID('${db}') IS NOT NULL BEGIN ALTER DATABASE [${db}] SET SINGLE_USER WITH ROLLBACK IMMEDIATE; DROP DATABASE [${db}]; END; CREATE DATABASE [${db}];`)
  }
  await master.close()
  const p = project('sqlserver', [
    ['a', `${ms};databaseName=cmp_a`, 'dev'],
    ['b', `${ms};databaseName=cmp_b`, 'test'],
  ])
  const cfg = p.cfg()
  // One batch per statement: CREATE VIEW and CREATE PROCEDURE must each start a batch.
  await sql(cfg, 'a', 'CREATE TABLE dbo.orders (id int PRIMARY KEY, total decimal(10, 2) NOT NULL DEFAULT 0);')
  await sql(cfg, 'a', 'CREATE VIEW dbo.big_orders AS SELECT id FROM dbo.orders WHERE total > 100;')
  await sql(cfg, 'a', 'CREATE PROCEDURE dbo.count_orders AS SELECT COUNT(*) FROM dbo.orders;')
  await sql(cfg, 'b', 'CREATE TABLE dbo.orders (id int PRIMARY KEY);')

  await cmp.snapshot(cfg, side('a'), 'a.json', undefined)
  assert.equal((await cmp.compare(cfg, side('a.json'), side('a'), undefined)).changes.length, 0, 'the snapshot reads back exactly')

  const r = await cmp.compare(cfg, side('a'), side('b'), undefined)
  assert.deepEqual(r.changes.map((c) => c.id).sort(), ['procedure:dbo.count_orders', 'table:dbo.orders', 'view:dbo.big_orders'])
  await cmp.apply(cfg, side('b'), cmp.syncScript(r, r.changes))
  assert.equal((await cmp.compare(cfg, side('a'), side('b'), undefined)).changes.length, 0)

  // A PostgreSQL snapshot against SQL Server: refused, with both engines named.
  const pgp = project('postgresql', [['dev', `${pg}/shop_dev`, 'dev']])
  await sql(pgp.cfg(), 'dev', `${pgSchemaReset} create table t (id int);`)
  await cmp.snapshot(pgp.cfg(), side('dev'), path.join(p.dir, 'pg.json'), undefined)
  await assert.rejects(cmp.compare(cfg, side('pg.json'), side('b'), undefined), (e: unknown) => e instanceof LiftoffError && /PostgreSQL and .* SQL Server/.test(e.message))
})
