import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { test } from 'node:test'
import { Config } from './config.ts'
import { scan } from './migration.ts'
import { createSample } from './sample.ts'

test('the sample project is a working project with every kind of script', () => {
  const root = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'lo-sample-')), 'liftoff-sample')
  createSample(root)
  const cfg = Config.load(root)
  assert.equal(cfg.project.name, 'shop-sample')
  assert.deepEqual(scan(cfg.migrationsDir()).map((s) => s.fileName).sort(), ['R__customer_totals.sql', 'U3__orders_by_customer.sql', 'V1__customers.sql', 'V2__orders.sql', 'V3__orders_by_customer.sql'])
  assert.throws(() => createSample(root), /not empty/)
})
