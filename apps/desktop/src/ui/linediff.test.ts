// node --test src/ui/linediff.test.ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { lineDiff } from './linediff.ts'

test('identical text is all same', () => {
  assert.deepEqual(lineDiff('a\nb', 'a\nb').map((r) => r.kind), ['same', 'same'])
})

test('a replaced line pairs up as changed; additions and removals stay one-sided', () => {
  const rows = lineDiff('CREATE TABLE t (\n    id int,\n    old text\n);', 'CREATE TABLE t (\n    id bigint,\n    old text,\n    note text\n);')
  assert.deepEqual(rows.map((r) => r.kind), ['same', 'changed', 'changed', 'added', 'same'])
  assert.equal(rows[1].left?.text, '    id int,')
  assert.equal(rows[1].right?.text, '    id bigint,')
  assert.equal(rows[3].right?.text, '    note text')
})

test('missing side is empty', () => {
  assert.deepEqual(lineDiff('', 'x\ny').map((r) => r.kind), ['added', 'added'])
  assert.deepEqual(lineDiff('x', '').map((r) => r.kind), ['removed'])
})
