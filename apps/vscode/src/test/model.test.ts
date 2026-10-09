import assert from 'node:assert/strict'
import { test } from 'node:test'
import { describe, groupProblems, problemsFor, summary, type MigrationInfo } from '../model'

const row = (script: string, state: MigrationInfo['state'], checksum_mismatch = false): MigrationInfo => ({
  kind: 'versioned',
  version: script.slice(1, script.indexOf('__')),
  description: script,
  script,
  state,
  installed_on: state === 'applied' ? '2026-10-08T12:00:00Z' : null,
  execution_time_ms: state === 'applied' ? 5 : null,
  checksum_mismatch,
})

test('summary counts what needs doing', () => {
  assert.equal(summary([row('V1__a.sql', 'applied')]), 'up to date')
  assert.equal(summary([row('V1__a.sql', 'applied'), row('V2__b.sql', 'pending'), row('R__v.sql', 'outdated')]), '2 pending')
  assert.equal(summary([row('V1__a.sql', 'failed'), row('V2__b.sql', 'pending')]), '1 failed, 1 pending')
})

test('describe says when it ran and whether it was edited since', () => {
  assert.equal(describe(row('V1__a.sql', 'applied')), 'applied · 2026-10-08 12:00:00 UTC')
  assert.equal(describe(row('V1__a.sql', 'applied', true)), 'applied · edited after it ran · 2026-10-08 12:00:00 UTC')
  assert.equal(describe(row('V2__b.sql', 'pending')), 'pending')
})

test('edited and failed scripts become editor problems, grouped per file', () => {
  const test1 = problemsFor('test', [row('V1__a.sql', 'applied', true), row('V2__b.sql', 'failed'), row('V3__c.sql', 'pending')])
  assert.deepEqual(test1.map((p) => [p.script, p.severity]), [['V1__a.sql', 'warning'], ['V2__b.sql', 'error']])
  assert.match(test1[0].message, /Changed after it ran on test/)
  const prod = problemsFor('prod', [row('V1__a.sql', 'applied', true)])
  const grouped = groupProblems(new Map([['test', test1], ['prod', prod]]))
  assert.equal(grouped.get('V1__a.sql')?.length, 2, 'one warning per environment')
  assert.equal(grouped.has('V3__c.sql'), false)
})

test('schema-model changes are described from the dev side, problems grouped per file', async () => {
  const { describeModelChange, modelProblems } = await import('../model.js')
  const c = (kind: 'added' | 'changed' | 'removed', object_type: string) => ({ path: 'public/x.sql', object_type, kind, before: null, after: null })
  assert.equal(describeModelChange(c('added', 'tables')), 'table · new in dev')
  assert.equal(describeModelChange(c('removed', 'materialized-views')), 'materialized view · dropped in dev')
  const grouped = modelProblems([{ path: 'a.sql', message: 'one' }, { path: 'b.sql', message: 'x' }, { path: 'a.sql', message: 'two' }])
  assert.deepEqual([...grouped], [['a.sql', ['one', 'two']], ['b.sql', ['x']]])
})

test('which scripts can run on their own, and what running one leaves behind', async () => {
  const { pickable, olderNotRun } = await import('../model.js')
  const infos = [row('V1__a.sql', 'applied'), row('V1.9__b.sql', 'ignored'), row('V1.10__c.sql', 'pending'), row('V2__d.sql', 'pending'), row('V3__e.sql', 'failed')]
  assert.deepEqual(infos.filter(pickable).map((i) => i.script), ['V1.9__b.sql', 'V1.10__c.sql', 'V2__d.sql'])
  assert.deepEqual(olderNotRun(infos, infos[3]).map((i) => i.script), ['V1.9__b.sql', 'V1.10__c.sql'], '1.10 is older than 2, newer than 1.9')
  assert.deepEqual(olderNotRun(infos, infos[1]), [])
  assert.ok(pickable({ ...row('R__v.sql', 'applied'), kind: 'repeatable', version: null }), 'a repeatable can be run again on purpose')
})

test('what a migrate did, in one line: plain, and after a baseline check', async () => {
  const { migrateSummary } = await import('../model.js')
  const a = (script: string) => ({ script, version: null, execution_time_ms: 1, transactional: true })
  assert.equal(migrateSummary('test', { environment: 'test', applied: [], execution_time_ms: 0, dry_run_sql: null }), 'test is up to date')
  assert.equal(
    migrateSummary('test', { environment: 'test', applied: [a('B0001__x.sql'), a('V0002__y.sql')], execution_time_ms: 0, dry_run_sql: null, baseline_check: { script: 'B0001__x.sql', created: ['view:v'], accepted: [], restart: false } }),
    'test is now at B0001__x.sql; created 1 missing object; then applied 1 migration',
  )
})
