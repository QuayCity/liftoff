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
  assert.deepEqual(scan(cfg.migrationsDir()).map((s) => s.fileName).sort(), ['R__customer_totals.sql', 'U0003__orders_by_customer.sql', 'V0001__customers.sql', 'V0002__orders.sql', 'V0003__orders_by_customer.sql'])
  assert.throws(() => createSample(root), /not empty/)
})

test('the sample in T-SQL for SQL Server projects', () => {
  const root = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'lo-sample-')), 'liftoff-sample')
  createSample(root, 'sqlserver')
  const cfg = Config.load(root)
  assert.deepEqual([cfg.project.engine, cfg.project.schemas], ['sqlserver', ['dbo']])
  const v1 = fs.readFileSync(path.join(cfg.migrationsDir(), 'V0001__customers.sql'), 'utf8')
  assert.match(v1, /IDENTITY\(1, 1\)/)
  assert.doesNotMatch(v1, /timestamptz|generated always/)
})
