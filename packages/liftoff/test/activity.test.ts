// The activity table: every run that changes something is written, failed or not; the overview
// reads it next to each environment's state. On PostgreSQL and SQL Server.

import assert from 'node:assert/strict'
import { test } from 'node:test'
import * as activity from '../src/core/activity.ts'
import * as checks from '../src/core/checks.ts'
import type { Role } from '../src/core/config.ts'
import * as runner from '../src/core/runner.ts'
import { SqlServerConn } from '../src/core/sqlserver.ts'
import { pgSchemaReset, project, sql } from './helpers.ts'

const pg = process.env.LIFTOFF_TEST_PG
const ms = process.env.LIFTOFF_TEST_MSSQL

test('pipelineOf: the CI run page from the variables each service sets', () => {
  assert.equal(runner.pipelineOf({ GITHUB_ACTIONS: 'true', GITHUB_SERVER_URL: 'https://github.com', GITHUB_REPOSITORY: 'o/r', GITHUB_RUN_ID: '42' }), 'https://github.com/o/r/actions/runs/42')
  assert.equal(runner.pipelineOf({ TF_BUILD: 'True', BUILD_BUILDID: '7', SYSTEM_COLLECTIONURI: 'https://dev.azure.com/org/', SYSTEM_TEAMPROJECT: 'Shop DB' }), 'https://dev.azure.com/org/Shop%20DB/_build/results?buildId=7')
  assert.equal(runner.pipelineOf({ GITLAB_CI: 'true', CI_JOB_URL: 'https://gitlab.com/o/r/-/jobs/9' }), 'https://gitlab.com/o/r/-/jobs/9')
  assert.equal(runner.pipelineOf({ JENKINS_URL: 'https://ci/', BUILD_URL: 'https://ci/job/x/3/' }), 'https://ci/job/x/3/')
  assert.equal(runner.pipelineOf({}), null)
})

async function story(p: ReturnType<typeof project>, table: (n: string) => string) {
  const cfg = p.cfg()
  const runs = async () => activity.runs(await activity.overview(cfg, 50, 'test'))
  p.write('V1__customers.sql', `${table('customers')}\n`)
  p.write('V2__orders.sql', `${table('orders')}\n`)

  const r = await runner.migrate(cfg, 'test')
  assert.ok(r.deployment_id)
  let list = await runs()
  assert.equal(list.length, 1)
  assert.deepEqual([list[0].id, list[0].operation, list[0].success, list[0].scripts, list[0].environment], [r.deployment_id, 'migrate', true, ['V1__customers.sql', 'V2__orders.sql'], 'test'])
  assert.ok(list[0].installed_by && list[0].host)

  // Nothing to do: nothing written. A dry run never writes.
  assert.equal((await runner.migrate(cfg, 'test')).deployment_id, undefined)
  p.write('V3__broken.sql', 'SELECT * FROM no_such_table;\n')
  await runner.migrate(cfg, 'test', { dryRun: true })
  assert.equal((await runs()).length, 1)

  // A failure is written, with the database's error.
  await assert.rejects(runner.migrate(cfg, 'test'), /V3__broken\.sql failed/)
  list = await runs()
  assert.deepEqual([list.length, list[0].operation, list[0].success], [2, 'migrate', false])
  assert.match(list[0].detail ?? '', /no_such_table/)

  p.write('V3__broken.sql', `${table('invoices')}\n`)
  await runner.repair(cfg, 'test')
  await runner.migrate(cfg, 'test', { topic: 'nothing' })
  p.write('V4__credits.sql', `${table('credits')}\n`)
  await runner.migrate(cfg, 'test', { only: ['3'] })
  await sql(cfg, 'test', table('credits'))
  await runner.markApplied(cfg, 'test', 'V4__credits.sql')
  list = await runs()
  assert.deepEqual(list.slice(0, 2).map((x) => [x.operation, x.scripts, x.detail]), [
    ['mark-applied', ['V4__credits.sql'], null],
    ['migrate', ['V3__broken.sql'], '--only 3'],
  ])

  // The overview: version, pending, and the table is not an object of the schema (no drift, no baseline needed).
  const [o] = await activity.overview(cfg, 50, 'test')
  assert.deepEqual([o.error, o.version, o.pending, o.failed], [null, '4', 0, 0])
  assert.deepEqual((await checks.check(cfg, 'test', undefined, { drift: true })).drift, [])

  // Clean erases it with everything else; the clean is the first row again, and migrate does not see an object.
  await runner.clean(cfg, 'test')
  list = await runs()
  assert.deepEqual(list.map((x) => x.operation), ['clean'])
  assert.equal((await runner.migrate(cfg, 'test')).applied.length, 4)
}

test('activity on PostgreSQL', { skip: !pg && 'set LIFTOFF_TEST_PG' }, async () => {
  const p = project('postgresql', [
    ['test', `${pg}/shop_test`, 'test' as Role, { allow_clean: true }],
    ['scratch', `${pg}/shop_scratch`, 'scratch' as Role],
  ])
  await sql(p.cfg(), 'test', pgSchemaReset)
  await story(p, (n) => `create table ${n} (id int primary key);`)
})

test('activity on SQL Server', { skip: !ms && 'set LIFTOFF_TEST_MSSQL' }, async () => {
  const master = await SqlServerConn.open('master', { url: `${ms};databaseName=master`, role: 'prod', allow_clean: false, placeholders: {} })
  await master.batch(`IF DB_ID('shop_activity') IS NOT NULL BEGIN ALTER DATABASE [shop_activity] SET SINGLE_USER WITH ROLLBACK IMMEDIATE; DROP DATABASE [shop_activity]; END; CREATE DATABASE [shop_activity]; IF DB_ID('shop_activity_scratch') IS NULL CREATE DATABASE [shop_activity_scratch];`)
  await master.close()
  const p = project('sqlserver', [
    ['test', `${ms};databaseName=shop_activity`, 'test' as Role, { allow_clean: true }],
    ['scratch', `${ms};databaseName=shop_activity_scratch`, 'scratch' as Role],
  ])
  await story(p, (n) => `CREATE TABLE dbo.${n} (id int PRIMARY KEY);`)
})

test('overview: an environment that cannot be reached says why, the others are read', { skip: !pg && 'set LIFTOFF_TEST_PG' }, async () => {
  const p = project('postgresql', [
    ['test', `${pg}/shop_test`, 'test' as Role],
    ['gone', 'postgres://nobody:x@127.0.0.1:1/none', 'prod' as Role],
    ['scratch', `${pg}/shop_scratch`, 'scratch' as Role],
  ])
  const o = await activity.overview(p.cfg())
  assert.deepEqual(o.map((e) => e.name), ['test', 'gone'])
  assert.equal(o[0].error, null)
  assert.ok(o[1].error)
})
