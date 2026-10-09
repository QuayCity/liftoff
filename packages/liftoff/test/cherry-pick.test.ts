// migrate --only: run chosen scripts and nothing else, on PostgreSQL and SQL Server.

import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { Role } from '../src/core/config.ts'
import { LiftoffError } from '../src/core/errors.ts'
import * as runner from '../src/core/runner.ts'
import { SqlServerConn } from '../src/core/sqlserver.ts'
import { pgSchemaReset, project, sql } from './helpers.ts'

const pg = process.env.LIFTOFF_TEST_PG
const ms = process.env.LIFTOFF_TEST_MSSQL

/** The same cherry-pick story on either engine. */
async function story(p: ReturnType<typeof project>, table: (n: string) => string) {
  const cfg = p.cfg()
  const state = async (script: string) => (await runner.info(cfg, 'test')).find((i) => i.script === script)?.state
  p.write('V1__customers.sql', `${table('customers')}\n`)
  p.write('V2__orders.sql', `${table('orders')}\n`)
  p.write('V3__invoices.sql', `${table('invoices')}\n`)
  p.write('R__report.sql', 'SELECT 1 AS ok;\n')

  // A hotfix first: only V2. V1 is older and stays behind, V3 newer and stays pending.
  let r = await runner.migrate(cfg, 'test', { only: ['2'] })
  assert.deepEqual(r.applied.map((a) => a.script), ['V2__orders.sql'])
  assert.deepEqual(r.left_behind, ['V1__customers.sql'])
  assert.deepEqual([await state('V1__customers.sql'), await state('V2__orders.sql'), await state('V3__invoices.sql'), await state('R__report.sql')], ['ignored', 'applied', 'pending', 'pending'])

  // A dry run picks the same way and changes nothing.
  const dry = await runner.migrate(cfg, 'test', { only: ['V3__invoices.sql'], dryRun: true })
  assert.match(dry.dry_run_sql ?? '', /invoices/)
  assert.doesNotMatch(dry.dry_run_sql ?? '', /customers/)
  assert.equal(await state('V3__invoices.sql'), 'pending')

  // What cannot be picked, and why: applied, unknown, an undo script.
  for (const [only, why] of [
    [['2'], /V2__orders\.sql has already run/],
    [['9'], /--only 9: no script/],
    [['nothing like this'], /--only nothing like this: no script/],
  ] as const) {
    await assert.rejects(runner.migrate(cfg, 'test', { only: [...only] }), (e: unknown) => e instanceof LiftoffError && why.test(e.message))
  }

  // The script left behind: a plain migrate now asks for --out-of-order, and picking it is enough.
  await assert.rejects(runner.migrate(cfg, 'test'), /older than the latest applied version; use --out-of-order/)
  r = await runner.migrate(cfg, 'test', { only: ['1', 'report'] })
  assert.deepEqual(r.applied.map((a) => a.script), ['V1__customers.sql', 'R__report.sql'])
  assert.deepEqual(r.left_behind, [])
  r = await runner.migrate(cfg, 'test')
  assert.deepEqual(r.applied.map((a) => a.script), ['V3__invoices.sql'])

  // A repeatable can be run again on purpose.
  r = await runner.migrate(cfg, 'test', { only: ['R__report.sql'] })
  assert.deepEqual(r.applied.map((a) => a.script), ['R__report.sql'])
}

test('migrate --only on PostgreSQL', { skip: !pg && 'set LIFTOFF_TEST_PG' }, async () => {
  const p = project('postgresql', [['test', `${pg}/shop_test`, 'test' as Role]])
  await sql(p.cfg(), 'test', pgSchemaReset)
  await story(p, (n) => `create table ${n} (id int primary key);`)
})

test('migrate --only on SQL Server', { skip: !ms && 'set LIFTOFF_TEST_MSSQL' }, async () => {
  const master = await SqlServerConn.open('master', { url: `${ms};databaseName=master`, role: 'prod', allow_clean: false, placeholders: {} })
  await master.batch(`IF DB_ID('shop_pick') IS NOT NULL BEGIN ALTER DATABASE [shop_pick] SET SINGLE_USER WITH ROLLBACK IMMEDIATE; DROP DATABASE [shop_pick]; END; CREATE DATABASE [shop_pick];`)
  await master.close()
  const p = project('sqlserver', [['test', `${ms};databaseName=shop_pick`, 'test' as Role]])
  await story(p, (n) => `CREATE TABLE dbo.${n} (id int PRIMARY KEY);`)
})
