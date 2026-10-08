import assert from 'node:assert/strict'
import { test } from 'node:test'
import { key } from './changes.ts'
import { compareFiles } from './model.ts'
import { createOrAlter, diff, normalize, typeName, type MsConstraint, type MsModel } from './msdiff.ts'

test('schema model files compare as text', () => {
  const disk = new Map([
    ['public/tables/a.sql', 'CREATE TABLE a ();\n'],
    ['public/tables/old.sql', 'x\n'],
    ['public/views/v.sql', 'same\n'],
  ])
  const dev = new Map([
    ['public/tables/a.sql', 'CREATE TABLE a (id int);\n'],
    ['public/views/v.sql', 'same\n'],
    ['public/functions/f(x int).sql', 'fn\n'],
  ])
  assert.deepEqual(
    compareFiles(disk, dev).map((c) => [c.path, c.kind, c.object_type]),
    [
      ['public/functions/f(x int).sql', 'added', 'functions'],
      ['public/tables/a.sql', 'changed', 'tables'],
      ['public/tables/old.sql', 'removed', 'tables'],
    ],
  )
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
