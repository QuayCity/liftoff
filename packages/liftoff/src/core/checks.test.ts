import assert from 'node:assert/strict'
import { test } from 'node:test'
import { change, type Change } from './changes.ts'
import { driftChanged } from './checks.ts'

const c = (name: string): Change => change('table', 'Tables', name, 'changed', false, [], null, null)

test('drifted objects the pending scripts change too', () => {
  assert.deepEqual(driftChanged({ drift: [c('orders'), c('customers')], changes: [c('orders'), c('notes')] }), ['orders'])
  assert.deepEqual(driftChanged({ drift: [c('orders')], changes: null }), [], 'no changes computed')
  assert.deepEqual(driftChanged({ drift: null, changes: [c('orders')] }), [], 'no drift computed')
})
