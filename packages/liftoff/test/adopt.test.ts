// Starting from existing databases: adopt captures one as B0001; the others are checked against it
// on their next migrate (missing objects created, differences listed), empty ones built from it.

import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { test } from 'node:test'
import { adopt } from '../src/core/adopt.ts'
import { compare, parseSide } from '../src/core/compare.ts'
import { BaselineDiffersError, LiftoffError } from '../src/core/errors.ts'
import { PgConn } from '../src/core/postgres.ts'
import * as runner from '../src/core/runner.ts'
import { SqlServerConn } from '../src/core/sqlserver.ts'
import { pgSchemaReset, project, sql } from './helpers.ts'

const pg = process.env.LIFTOFF_TEST_PG
const ms = process.env.LIFTOFF_TEST_MSSQL

async function pgDatabases(...names: string[]) {
  const admin = await PgConn.open('admin', { url: `${pg}/postgres`, role: 'test', allow_clean: false, placeholders: {} })
  for (const n of names) {
    await admin.batch(`drop database if exists ${n} with (force)`)
    await admin.batch(`create database ${n}`)
  }
  await admin.close()
}

const SCHEMA = `
  create table customers (id int primary key, email text not null);
  create table orders (id int primary key, customer_id int not null references customers (id));
  create view order_count as select customer_id, count(*) n from orders group by customer_id;
  create function customer_email(i int) returns text language sql stable as 'select email from customers where id = i';`

test('adopt on PostgreSQL: B0001 from prod, then acceptance, test and an empty database', { skip: !pg && 'set LIFTOFF_TEST_PG' }, async () => {
  await pgDatabases('lo_prod', 'lo_acc', 'lo_test', 'lo_empty', 'lo_scratch')
  const p = project('postgresql', [
    ['prod', `${pg}/lo_prod`, 'prod'],
    ['acceptance', `${pg}/lo_acc`, 'test'],
    ['test', `${pg}/lo_test`, 'test'],
    ['fresh', `${pg}/lo_empty`, 'test'],
    ['scratch', `${pg}/lo_scratch`, 'scratch'],
  ])
  const cfg = p.cfg()
  await sql(cfg, 'prod', SCHEMA)
  // Acceptance lacks the view and the function; test has a nullable email and an extra table.
  await sql(cfg, 'acceptance', `${pgSchemaReset} ${SCHEMA} drop view order_count; drop function customer_email(int);`)
  await sql(cfg, 'test', `${pgSchemaReset} ${SCHEMA} alter table customers alter column email drop not null; create table extra (id int);`)

  const a = await adopt(cfg, 'prod')
  assert.equal(path.basename(a.baseline), 'B0001__existing_schema.sql')
  assert.deepEqual((await runner.info(cfg, 'prod')).map((i) => [i.script, i.state]), [['B0001__existing_schema.sql', 'baseline']])
  await assert.rejects(adopt(cfg, 'test'), /already has migration scripts/)

  // Acceptance: only missing objects; they are created and the baseline recorded.
  let r = await runner.migrate(cfg, 'acceptance')
  assert.deepEqual(r.baseline_check?.created.sort(), ['function:public.customer_email(i integer)', 'view:public.order_count'])
  assert.equal((await compare(cfg, parseSide('prod'), parseSide('acceptance'), undefined)).changes.length, 0)

  // Test: differences stop it, named; nothing changed. Accepting them records the baseline.
  await assert.rejects(runner.migrate(cfg, 'test'), (e: unknown) => {
    assert.ok(e instanceof BaselineDiffersError, String(e))
    assert.deepEqual(e.differences.map((d) => `${d.kind} ${d.id}`).sort(), ['changed table:public.customers', 'removed table:public.extra'])
    return true
  })
  assert.equal((await runner.info(cfg, 'test')).filter((i) => i.installed_on).length, 0, 'nothing recorded')
  r = await runner.migrate(cfg, 'test', { acceptDifferences: true })
  assert.deepEqual(r.baseline_check?.accepted.sort(), ['table:public.customers', 'table:public.extra'])

  // An empty database is built from B0001; then work goes on at V0002 everywhere.
  p.write('V0002__phone.sql', 'alter table customers add column phone text;\n')
  assert.deepEqual((await runner.migrate(cfg, 'fresh')).applied.map((x) => x.script), ['B0001__existing_schema.sql', 'V0002__phone.sql'])
  for (const env of ['prod', 'acceptance', 'test']) assert.deepEqual((await runner.migrate(cfg, env)).applied.map((x) => x.script), ['V0002__phone.sql'], env)
  assert.equal((await compare(cfg, parseSide('prod'), parseSide('fresh'), undefined)).changes.length, 0)
})

test('adopt needs a scratch database to check the capture, and refuses a database with history', { skip: !pg && 'set LIFTOFF_TEST_PG' }, async () => {
  await pgDatabases('lo_prod')
  const p = project('postgresql', [['prod', `${pg}/lo_prod`, 'prod']])
  await sql(p.cfg(), 'prod', SCHEMA)
  await assert.rejects(adopt(p.cfg(), 'prod'), (e: unknown) => e instanceof LiftoffError && /scratch database/.test(e.message))
  assert.deepEqual(fs.readdirSync(path.join(p.dir, 'migrations')), [], 'no capture kept')
})

test('adopt on SQL Server: a missing procedure is created on the next environment', { skip: !ms && 'set LIFTOFF_TEST_MSSQL' }, async () => {
  const master = await SqlServerConn.open('master', { url: `${ms};databaseName=master`, role: 'prod', allow_clean: false, placeholders: {} })
  for (const db of ['ad_prod', 'ad_test', 'ad_scratch']) {
    await master.batch(`IF DB_ID('${db}') IS NOT NULL BEGIN ALTER DATABASE [${db}] SET SINGLE_USER WITH ROLLBACK IMMEDIATE; DROP DATABASE [${db}]; END; CREATE DATABASE [${db}];`)
  }
  await master.close()
  const p = project('sqlserver', [
    ['prod', `${ms};databaseName=ad_prod`, 'prod'],
    ['test', `${ms};databaseName=ad_test`, 'test'],
    ['scratch', `${ms};databaseName=ad_scratch`, 'scratch'],
  ])
  const cfg = p.cfg()
  for (const env of ['prod', 'test']) await sql(cfg, env, 'CREATE TABLE dbo.items (id int PRIMARY KEY, name nvarchar(50) NOT NULL);')
  await sql(cfg, 'prod', 'CREATE PROCEDURE dbo.item_count AS SELECT COUNT(*) FROM dbo.items;')
  await adopt(cfg, 'prod')
  const r = await runner.migrate(cfg, 'test')
  assert.deepEqual(r.baseline_check?.created, ['procedure:dbo.item_count'])
  assert.equal((await compare(cfg, parseSide('prod'), parseSide('test'), undefined)).changes.length, 0)
})
