import assert from 'node:assert/strict'
import { test } from 'node:test'
import { buildUrl, emptyFields, splitUrl } from './connection.ts'
import { engineForUrl } from './db.ts'
import { oracleNeedsNoTransaction } from './migration.ts'
import { parseUrl, quote, splitScript } from './oracle.ts'

test('Oracle URLs: LiftOff and JDBC forms to a connect string', () => {
  assert.deepEqual(parseUrl('oracle://db.internal:1522/SHOP'), { connectString: 'db.internal:1522/SHOP' })
  assert.deepEqual(parseUrl('oracle://me:p%40ss@db/SHOP?ssl=true'), { connectString: 'tcps://db:2484/SHOP', user: 'me', password: 'p@ss' })
  assert.deepEqual(parseUrl('jdbc:oracle:thin:@//db:1521/SHOP'), { connectString: 'db:1521/SHOP' })
  assert.deepEqual(parseUrl('jdbc:oracle:thin:scott/tiger@db:1521:ORCL'), {
    connectString: '(DESCRIPTION=(ADDRESS=(PROTOCOL=TCP)(HOST=db)(PORT=1521))(CONNECT_DATA=(SID=ORCL)))', user: 'scott', password: 'tiger',
  })
  assert.throws(() => parseUrl('oracle://db:1521'), /names no service/)
  assert.equal(engineForUrl('jdbc:oracle:thin:@//db/x').name, 'Oracle')
})

test('Oracle: server fields to a URL and back', () => {
  const url = buildUrl('oracle', { ...emptyFields(), server: 'db', port: '1522', database: 'SHOP', sslmode: 'require' })
  assert.equal(url, 'oracle://db:1522/SHOP?ssl=true')
  const s = splitUrl('oracle', url)!
  assert.deepEqual([s.server, s.port, s.database, s.sslmode, s.extra], ['db', '1522', 'SHOP', 'require', ''])
  assert.equal(splitUrl('oracle', 'jdbc:oracle:thin:@//db/x'), undefined, 'the JDBC form stays a URL')
})

test('Oracle scripts: ; ends SQL, a / line ends PL/SQL, strings and comments are skipped', () => {
  const parts = splitScript(
    [
      'create table a (x varchar2(10) default \';\');',
      "insert into a values (q'[it's; fine]');",
      '-- a comment; with a semicolon',
      'create or replace procedure p is',
      'begin',
      '  insert into a values (\'x\');',
      'end;',
      '/',
      'begin null; end;',
      '/',
      'select 1 from dual',
      '/',
    ].join('\n'),
  )
  assert.deepEqual(parts, [
    "create table a (x varchar2(10) default ';')",
    "insert into a values (q'[it's; fine]')",
    "-- a comment; with a semicolon\ncreate or replace procedure p is\nbegin\n  insert into a values ('x');\nend;",
    'begin null; end;',
    'select 1 from dual',
  ])
  assert.deepEqual(splitScript(''), [])
})

test('Oracle: names as stored, written so they read back the same', () => {
  assert.equal(quote('ORDERS'), 'orders')
  assert.equal(quote('Orders'), '"Orders"')
  assert.equal(quote('ORDER'), '"ORDER"', 'a reserved word')
  assert.equal(quote('liftoff_schema_history'), '"liftoff_schema_history"')
  assert.equal(oracleNeedsNoTransaction('insert into a values (1);'), false)
  assert.equal(oracleNeedsNoTransaction('comment on table a is \'x\';'), true)
})
