import assert from 'node:assert/strict'
import * as path from 'node:path'
import { test } from 'node:test'
import { anchored } from './config.ts'
import { buildUrl, emptyFields, splitUrl } from './connection.ts'
import { engineForUrl } from './db.ts'
import { jdbcToUrl } from './flyway.ts'
import { parseTable, q } from './litediff.ts'
import { sqliteNeedsNoTransaction } from './migration.ts'
import { fileOf, withDatabase } from './sqlite.ts'

test('SQLite URLs: a relative file is in the project folder; absolute ones stay', () => {
  const root = path.resolve('/projects/shop')
  assert.equal(anchored(root, 'sqlite:data/shop.db'), `sqlite:${path.join(root, 'data/shop.db').replaceAll('\\', '/')}`)
  for (const u of ['sqlite:/srv/shop.db', 'sqlite:C:/data/shop.db', 'sqlite:///srv/shop.db', 'sqlite:${env.SHOP_DB}', 'postgres://db/shop']) assert.equal(anchored(root, u), u)
  assert.equal(fileOf('sqlite:///srv/shop.db'), '/srv/shop.db')
  assert.equal(fileOf('jdbc:sqlite:C:/data/shop.db'), 'C:/data/shop.db')
  assert.equal(withDatabase('sqlite:C:/data/shop_dev.db', 'shop_dev_scratch'), 'sqlite:C:/data/shop_dev_scratch.db')
  assert.equal(engineForUrl('sqlite:shop.db').name, 'SQLite')
  assert.equal(jdbcToUrl('jdbc:sqlite:data/shop.db'), 'sqlite:data/shop.db')
})

test('SQLite: the file field to a URL and back', () => {
  assert.equal(buildUrl('sqlite', { ...emptyFields(), database: 'data/shop.db' }), 'sqlite:data/shop.db')
  assert.equal(splitUrl('sqlite', 'sqlite:data/shop.db')?.database, 'data/shop.db')
  assert.equal(splitUrl('sqlite', 'sqlite:${env.DB}'), undefined)
})

test('SQLite: CREATE TABLE as columns, constraints and options; comments and spacing do not count', () => {
  const t = parseTable(`CREATE TABLE "order items" (
    id integer primary key, -- the key, with a comment, here
    note   text default 'a, (b)',
    "total ""x""" numeric check (total >= 0),
    foreign key (id) references orders (id) on delete cascade
  ) STRICT`)
  assert.deepEqual(t.columns, [['id', 'id integer primary key'], ['note', "note text default 'a, (b)'"], ['total "x"', '"total ""x""" numeric check (total >= 0)']])
  assert.deepEqual(t.constraints, ['foreign key (id) references orders (id) on delete cascade'])
  assert.equal(t.options, 'STRICT')
  // ALTER TABLE ADD COLUMN appends to the stored text: the parts are the same as a fresh CREATE.
  assert.deepEqual(parseTable('CREATE TABLE t (a int\n, b text)'), parseTable('CREATE TABLE t (a int, b text)'))
  assert.equal(q('orders'), 'orders')
  assert.equal(q('order'), '"order"')
  assert.equal(sqliteNeedsNoTransaction('PRAGMA foreign_keys = OFF;'), true)
  assert.equal(sqliteNeedsNoTransaction('create table a (x int);'), false)
})
