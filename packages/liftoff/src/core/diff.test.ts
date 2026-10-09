import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { Change } from './changes.ts'
import { renderScript } from './diff.ts'

const change = (sql: string): Change => ({
  id: 'procedure:dbo.p', object_type: 'Procedures', name: 'dbo.p', kind: 'added', destructive: false, sql,
  steps: [{ phase: 5, order: 0, sql }], undo_steps: [], before: null, after: sql,
})

test('on SQL Server the header is its own batch, so it never becomes part of a view or procedure', () => {
  const sql = renderScript('-- Written by LiftOff', [change('CREATE PROCEDURE dbo.p AS SELECT 1;\nGO')])
  const batches = sql.split(/^GO$/m)
  assert.ok(!batches.some((b) => b.includes('-- Written by LiftOff') && b.includes('CREATE PROCEDURE')), sql)
})

test('on PostgreSQL nothing changes (no GO there)', () => {
  const sql = renderScript('-- Written by LiftOff', [change('create view v as select 1;')])
  assert.doesNotMatch(sql, /^GO$/m)
})
