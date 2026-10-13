import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { test } from 'node:test'
import { key } from './changes.ts'
import type { Config } from './config.ts'
import { compareFiles, listFiles, upgradeLayout } from './model.ts'
import { createOrAlter, diff, files, normalize, typeName, type MsConstraint, type MsModel } from './msdiff.ts'

test('schema model files compare as text', () => {
  const disk = new Map([
    ['tables/public.a.sql', 'CREATE TABLE a ();\n'],
    ['tables/public.old.sql', 'x\n'],
    ['views/public.v.sql', 'same\n'],
  ])
  const dev = new Map([
    ['tables/public.a.sql', 'CREATE TABLE a (id int);\n'],
    ['views/public.v.sql', 'same\n'],
    ['functions/public.f(x int).sql', 'fn\n'],
  ])
  assert.deepEqual(
    compareFiles(disk, dev).map((c) => [c.path, c.kind, c.object_type]),
    [
      ['functions/public.f(x int).sql', 'added', 'functions'],
      ['tables/public.a.sql', 'changed', 'tables'],
      ['tables/public.old.sql', 'removed', 'tables'],
    ],
  )
})

test('model files are <type>/<schema>.<name>.sql: the same table in two schemas, two files', () => {
  const table = { columns: [], constraints: [], indexes: new Map() }
  const m = (keys: string[]): MsModel => ({ tables: new Map(keys.map((k) => [k, table])), modules: new Map(), sequences: new Map(), types: new Map(), not_compared: [] })
  assert.deepEqual([...files(m([key('dbo', 'customers'), key('sales', 'customers')])).keys()], ['tables/dbo.customers.sql', 'tables/sales.customers.sql'])
  // a.b + c and a + b.c would both be tables/a.b.c.sql: refused, not one overwriting the other.
  assert.throws(() => files(m([key('a.b', 'c'), key('a', 'b.c')])), /two objects would share the schema-model file tables\/a\.b\.c\.sql/)
})

test('a project in the old <schema>/<type>/<name>.sql layout is moved to the new one', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lo-layout-'))
  const write = (p: string, s: string) => {
    fs.mkdirSync(path.dirname(path.join(root, 'schema-model', p)), { recursive: true })
    fs.writeFileSync(path.join(root, 'schema-model', p), s)
  }
  write('dbo/tables/customers.sql', 'dbo customers\n')
  write('sales/tables/customers.sql', 'sales customers\n')
  write('public/triggers/orders.touch.sql', 'trigger\n')
  write('extensions/citext.sql', 'extension\n')
  write('tables/dbo.orders.sql', 'already new\n')
  const lines: string[] = []
  assert.equal(upgradeLayout(root, (_level, msg) => lines.push(msg)), 3)
  assert.deepEqual(listFiles({ root } as Config), ['extensions/citext.sql', 'tables/dbo.customers.sql', 'tables/dbo.orders.sql', 'tables/sales.customers.sql', 'triggers/public.orders.touch.sql'])
  assert.equal(fs.readFileSync(path.join(root, 'schema-model/tables/sales.customers.sql'), 'utf8'), 'sales customers\n')
  assert.deepEqual(fs.readdirSync(path.join(root, 'schema-model')).sort(), ['extensions', 'tables', 'triggers'], 'the emptied schema folders are gone')
  assert.match(lines.join('\n'), /Moved 3 file\(s\)/)
  assert.equal(upgradeLayout(root), 0, 'nothing to move the second time')
  fs.rmSync(root, { recursive: true, force: true })
})

test('SQL Server types, CREATE OR ALTER and normalised module text', () => {
  assert.equal(typeName('nvarchar', false, '', 200, 0, 0), 'nvarchar(100)')
  assert.equal(typeName('varbinary', false, '', -1, 0, 0), 'varbinary(max)')
  assert.equal(typeName('decimal', false, '', 9, 10, 2), 'decimal(10,2)')
  assert.equal(typeName('money_amount', true, 'dbo', 9, 12, 2), '[dbo].[money_amount]')
  assert.equal(createOrAlter('-- note\n/* x */ create view v as select 1'), '-- note\n/* x */ CREATE OR ALTER view v as select 1')
  assert.equal(createOrAlter('CREATE OR ALTER PROC p AS SELECT 1'), 'CREATE OR ALTER PROC p AS SELECT 1')
  assert.equal(normalize('a  \r\nb\t\r\n\r\n'), 'a\nb')
  assert.equal(normalize('CREATE   VIEW v AS SELECT 1'), 'CREATE VIEW v AS SELECT 1', 'how SQL Server stores CREATE OR ALTER')
  assert.equal(normalize('create or  alter view v AS SELECT 1'), 'CREATE view v AS SELECT 1')
})

test('SQL Server constraints with made-up names match by definition', () => {
  const pk = (name: string): MsConstraint => ({ name, system_named: true, def: 'PRIMARY KEY CLUSTERED ([id] ASC)', kind: 'PK', cols: 'id' })
  const model = (c: MsConstraint): MsModel => ({ tables: new Map([[key('dbo', 'orders'), { columns: [], constraints: [c], indexes: new Map() }]]), modules: new Map(), sequences: new Map(), types: new Map(), not_compared: [] })
  assert.deepEqual(diff(model(pk('PK__orders__1')), model(pk('PK__orders__2'))), [], 'random names are not a difference')
})
