import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { test } from 'node:test'
import {
  applyPlaceholders,
  checksum,
  compareVersions,
  needsNoTransaction,
  nextVersion,
  parseName,
  parseVersion,
  scan,
  splitBatches,
  splitStatements,
  type Script,
} from './migration.ts'

test('file names', () => {
  assert.deepEqual(parseName('V1.2__add_orders.sql'), { kind: 'versioned', version: '1.2', description: 'add orders' })
  assert.deepEqual(parseName('R__views.sql'), { kind: 'repeatable', version: undefined, description: 'views' })
  assert.equal(parseName('U3__x.sql')?.kind, 'undo')
  assert.equal(parseName('R1__x.sql'), undefined)
  assert.equal(parseName('V__x.sql'), undefined)
  assert.equal(parseName('readme.md'), undefined)
})

test('versions sort as numbers', () => {
  const v = (s: string) => parseVersion(s)!
  assert.ok(compareVersions(v('1.10'), v('1.9')) > 0)
  assert.ok(compareVersions(v('2'), v('1.99')) > 0)
  assert.equal(compareVersions(v('1.0'), v('1')), 0)
  assert.equal(compareVersions(v('1_2'), v('1.2')), 0)
  assert.equal(parseVersion('1.a'), undefined)
})

test('checksum ignores line endings and the BOM', () => {
  const enc = (s: string) => new TextEncoder().encode(s)
  const lf = checksum(enc('create table a();\nselect 1;\n'))
  assert.equal(checksum(enc('create table a();\r\nselect 1;\r\n')), lf)
  assert.equal(checksum(new Uint8Array([0xef, 0xbb, 0xbf, ...enc('create table a();\nselect 1;\n')])), lf)
  assert.notEqual(checksum(enc('create table b();\nselect 1;\n')), lf)
})

test('checksums equal what Flyway stores (black-box fixtures)', () => {
  const dir = path.join(import.meta.dirname, '../../test/fixtures/checksum')
  const wrong: string[] = []
  for (const line of fs.readFileSync(path.join(dir, 'expected.txt'), 'utf8').split(/\r?\n/)) {
    if (!line.trim() || line.startsWith('#')) continue
    const [file, sum] = line.split(' ')
    const ours = checksum(fs.readFileSync(path.join(dir, file)))
    if (ours !== Number(sum)) wrong.push(`${file}: flyway ${sum}, liftoff ${ours}`)
  }
  assert.deepEqual(wrong, [])
})

test('next versions', () => {
  const now = new Date(Date.UTC(2026, 9, 8, 11, 4))
  const mk = (v: string): Script => ({ kind: 'versioned', version: parseVersion(v), description: '', fileName: '', path: '', checksum: 0, sql: '' })
  assert.equal(nextVersion([], now), '1', 'a new project counts V1, V2, V3')
  assert.equal(nextVersion([mk('1'), mk('2'), mk('10')], now), '11')
  assert.equal(nextVersion([mk('007')], now), '008')
  assert.equal(nextVersion([mk('1.9')], now), '1.10')
  assert.equal(nextVersion([mk('20261001.0900')], now), '20261008.1104')
  assert.equal(nextVersion([mk('20261008.1104')], now), '20261008.1105', 'same minute as the latest: bump instead of colliding')
})

test('GO batches', () => {
  const sql = "create table a (id int)\nGO\ncreate proc p as select 'GO\ngo' /* \nGO\n */\n  go 2 -- twice\n\nGO\nselect 1\ngo;\n"
  const b = splitBatches(sql)
  assert.equal(b.length, 3, JSON.stringify(b))
  assert.deepEqual(b[0], { sql: 'create table a (id int)\n', times: 1 })
  assert.ok(b[1].sql.includes("'GO\ngo'") && b[1].sql.includes('/* \nGO\n */') && b[1].times === 2)
  assert.equal(b[2].sql, 'select 1\ngo;\n', '`go;` is not a separator')
  assert.deepEqual(splitBatches('select 1'), [{ sql: 'select 1', times: 1 }])
  assert.deepEqual(splitBatches('\nGO\n'), [])
})

test('placeholders', () => {
  const v = new Map([['app_user', 'svc_shop']])
  const sql = "grant select on orders to ${app_user}; select '${not a name}', $$x$$;"
  assert.equal(applyPlaceholders(sql, v, true, 'V1'), "grant select on orders to svc_shop; select '${not a name}', $$x$$;")
  assert.throws(() => applyPlaceholders('${who}', v, true, 'V1'), /V1 uses placeholders with no value: who/)
  assert.equal(applyPlaceholders('${who}', v, false, 'V1'), '${who}', 'projects without placeholders are untouched')
})

test('statements split on ; outside quotes, dollar quotes and comments', () => {
  const sql =
    "create table a(x text default 'a;b'); -- c;\n" +
    'create function f() returns int as $body$ select 1; $body$ language sql;\n' +
    '/* x; */ create index concurrently i on a(x);\n-- trailing comment'
  const s = splitStatements(sql)
  assert.equal(s.length, 3, JSON.stringify(s))
  assert.ok(s[1].includes('$body$ select 1; $body$'))
  assert.ok(needsNoTransaction(s[2]))
  assert.ok(!needsNoTransaction(s[0]))
})

test("BUG-010: names that do not fit the history table are refused before anything runs", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lo-long-'))
  fs.writeFileSync(path.join(dir, `V1__${'a'.repeat(201)}.sql`), 'select 1;\n')
  assert.throws(() => scan(dir), /the description is 201 characters; the history table holds 200/)
  fs.rmSync(dir, { recursive: true })
  fs.mkdirSync(dir)
  fs.writeFileSync(path.join(dir, `V${'1'.repeat(51)}__x.sql`), 'select 1;\n')
  assert.throws(() => scan(dir), /the version is 51 characters; the history table holds 50/)
})
