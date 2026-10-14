import assert from 'node:assert/strict'
import { test } from 'node:test'
import { buildUrl, emptyFields, splitUrl } from './connection.ts'
import { engineForUrl } from './db.ts'
import { mysqlNeedsNoTransaction } from './migration.ts'
import { parseUrl, splitScript, withDatabase } from './mysql.ts'
import { normalizeView, parseTable } from './mysqldiff.ts'

test('MySQL URLs: parts, another database, the engine they name', () => {
  assert.deepEqual(parseUrl('mysql://me:p%40ss@db.internal:3307/shop?sslmode=require'), { host: 'db.internal', port: 3307, database: 'shop', user: 'me', password: 'p@ss', sslmode: 'require' })
  assert.deepEqual(parseUrl('jdbc:mysql://db/shop?ssl-mode=VERIFY_IDENTITY'), { host: 'db', port: 3306, database: 'shop', sslmode: 'verify-identity' })
  assert.equal(withDatabase('mysql://db:3306/shop?sslmode=require', 'shop_scratch'), 'mysql://db:3306/shop_scratch?sslmode=require')
  assert.equal(engineForUrl('mysql://db/shop').name, 'MySQL')
})

test('MySQL: server fields to a URL and back', () => {
  const url = buildUrl('mysql', { ...emptyFields(), server: 'db', port: '3307', database: 'shop', sslmode: 'require' })
  assert.equal(url, 'mysql://db:3307/shop?sslmode=require')
  const s = splitUrl('mysql', 'mysql://me@db/shop')!
  assert.deepEqual([s.user, s.server, s.port, s.database], ['me', 'db', '', 'shop'])
  assert.equal(splitUrl('mysql', 'postgres://db/shop'), undefined)
  assert.equal(splitUrl('mysql', 'mysql://me:secret@db/shop'), undefined)
})

test('MySQL scripts: sent whole, except at DELIMITER lines', () => {
  assert.deepEqual(splitScript('create table a (x int);\ninsert into a values (1);\n'), ['create table a (x int);\ninsert into a values (1);'])
  const parts = splitScript("DELIMITER //\ncreate procedure p() begin select ';'; select 1; end //\n# a comment //\nselect 'it''s //' //\nDELIMITER ;\nselect 2;\n")
  assert.deepEqual(parts, ["create procedure p() begin select ';'; select 1; end", "# a comment //\nselect 'it''s //'", 'select 2;'])
  assert.deepEqual(splitScript('-- only a comment\n'), [])
})

test('MySQL: DDL runs outside a transaction, data changes inside one', () => {
  assert.equal(mysqlNeedsNoTransaction('create table a (x int);'), true)
  assert.equal(mysqlNeedsNoTransaction('-- create nothing\ninsert into a values (1);\nupdate a set x = 2;'), false)
})

test('MySQL: SHOW CREATE TABLE as parts, without AUTO_INCREMENT=n', () => {
  const t = parseTable(
    'CREATE TABLE `orders` (\n  `id` int NOT NULL AUTO_INCREMENT,\n  `note` varchar(10) DEFAULT \'a,b\',\n  PRIMARY KEY (`id`),\n  UNIQUE KEY `u` (`note`),\n  KEY `k` (`note`),\n' +
      '  CONSTRAINT `fk` FOREIGN KEY (`id`) REFERENCES `customers` (`id`),\n  CONSTRAINT `c` CHECK ((`id` > 0))\n) ENGINE=InnoDB AUTO_INCREMENT=42 DEFAULT CHARSET=utf8mb4',
  )
  assert.deepEqual(t.columns.map(([n]) => n), ['id', 'note'])
  assert.equal(t.columns[1][1], "`note` varchar(10) DEFAULT 'a,b'")
  assert.deepEqual([...t.keys.keys()], ['PRIMARY', 'u', 'k'])
  assert.deepEqual([[...t.fks.keys()], [...t.checks.keys()]], [['fk'], ['c']])
  assert.equal(t.options, 'ENGINE=InnoDB DEFAULT CHARSET=utf8mb4')
  assert.equal(
    normalizeView('CREATE ALGORITHM=UNDEFINED DEFINER=`root`@`%` SQL SECURITY DEFINER VIEW `v` AS select `shop_dev`.`t`.`id` AS `id` from `shop_dev`.`t`', 'shop_dev'),
    'CREATE VIEW `v` AS select `t`.`id` AS `id` from `t`',
  )
})
