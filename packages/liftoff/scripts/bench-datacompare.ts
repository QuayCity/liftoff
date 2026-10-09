// How fast data compare is on big tables, against reading every row from both sides.
//   LIFTOFF_TEST_PG=postgres://… node scripts/bench-datacompare.ts pg 1000000
//   LIFTOFF_TEST_MSSQL='sqlserver://…' node scripts/bench-datacompare.ts ms 1000000
// Creates bench_a and bench_b (dropped first) with N rows each and 25 scattered differences.

import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { parseSide } from '../src/core/compare.ts'
import { Config, init, saveEnvironment } from '../src/core/config.ts'
import { DataSession } from '../src/core/datacompare.ts'
import { open, type Conn } from '../src/core/db.ts'
import { PgConn, withDatabase } from '../src/core/postgres.ts'
import { SqlServerConn } from '../src/core/sqlserver.ts'

const [engine = 'pg', n = '1000000'] = process.argv.slice(2)
const rows = Number(n)
const base = engine === 'pg' ? process.env.LIFTOFF_TEST_PG : process.env.LIFTOFF_TEST_MSSQL
if (!base) throw new Error(`set ${engine === 'pg' ? 'LIFTOFF_TEST_PG' : 'LIFTOFF_TEST_MSSQL'}`)
const urlOf = (db: string) => (engine === 'pg' ? withDatabase(base, db) : `${base};databaseName=${db}`)
const env = (db: string) => ({ url: urlOf(db), role: 'test' as const, allow_clean: false, placeholders: {} })
const seconds = (t: number) => `${((Date.now() - t) / 1000).toFixed(1)} s`

async function setUp(): Promise<void> {
  const admin = engine === 'pg' ? await PgConn.open('admin', env('postgres')) : await SqlServerConn.open('admin', env('master'))
  for (const db of ['bench_a', 'bench_b']) {
    await admin.batch(engine === 'pg' ? `drop database if exists ${db} with (force)` : `IF DB_ID('${db}') IS NOT NULL BEGIN ALTER DATABASE [${db}] SET SINGLE_USER WITH ROLLBACK IMMEDIATE; DROP DATABASE [${db}]; END`)
    await admin.batch(engine === 'pg' ? `create database ${db}` : `CREATE DATABASE [${db}]`)
  }
  await admin.close()
  const t = Date.now()
  for (const db of ['bench_a', 'bench_b']) {
    const c = await open(db, env(db))
    await c.batch(
      engine === 'pg'
        ? `create table public.events (id bigint primary key, account int not null, kind text not null, amount numeric(12, 2), at timestamptz not null, note text);
           insert into public.events select i, i % 5000, 'kind' || (i % 17), i * 0.37, timestamptz '2026-01-01' + i * interval '1 second', case when i % 9 = 0 then null else 'note ' || i end
             from generate_series(1, ${rows}) i;`
        : `CREATE TABLE dbo.events (id bigint PRIMARY KEY, account int NOT NULL, kind nvarchar(20) NOT NULL, amount decimal(12, 2), at datetime2 NOT NULL, note nvarchar(50));
           WITH n AS (SELECT TOP (${rows}) ROW_NUMBER() OVER (ORDER BY (SELECT NULL)) AS i FROM sys.all_columns a CROSS JOIN sys.all_columns b CROSS JOIN sys.all_columns c)
           INSERT INTO dbo.events SELECT i, i % 5000, CONCAT(N'kind', i % 17), i * 0.37, DATEADD(SECOND, i % 2000000000, CAST('2026-01-01' AS datetime2)), CASE WHEN i % 9 = 0 THEN NULL ELSE CONCAT(N'note ', i) END FROM n;`,
    )
    await c.close()
  }
  // 25 differences spread over the table: 10 changed, 10 deleted in b, 5 extra in b.
  const b = await open('bench_b', env('bench_b'))
  const step = Math.floor(rows / 26)
  const tbl = engine === 'pg' ? 'public.events' : 'dbo.events'
  for (let k = 1; k <= 10; k++) await b.batch(`UPDATE ${tbl} SET note = 'changed' WHERE id = ${k * step}`)
  for (let k = 11; k <= 20; k++) await b.batch(`DELETE FROM ${tbl} WHERE id = ${k * step}`)
  for (let k = 1; k <= 5; k++) await b.batch(`INSERT INTO ${tbl} (id, account, kind, amount, at, note) VALUES (${rows + k}, 1, 'x', 1, ${engine === 'pg' ? 'now()' : 'SYSDATETIME()'}, 'extra')`)
  await b.close()
  console.log(`set up: 2 x ${rows.toLocaleString()} rows in ${seconds(t)}`)
}

/** The obvious way: read every row from both sides (ordered by key) and compare in memory. */
async function naive(): Promise<number> {
  const read = async (db: string) => {
    const c: Conn = await open(db, env(db))
    const sql = engine === 'pg' ? 'select * from public.events order by id' : 'SELECT * FROM dbo.events ORDER BY id'
    const r = engine === 'pg' ? await (c as PgConn).rows(sql) : await (c as SqlServerConn).query(sql)
    await c.close()
    return new Map(r.map((row) => [String(row[0]), JSON.stringify(row)]))
  }
  const [a, b] = await Promise.all([read('bench_a'), read('bench_b')])
  let diffs = 0
  for (const [k, v] of a) if (b.get(k) !== v) diffs++
  for (const k of b.keys()) if (!a.has(k)) diffs++
  return diffs
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lo-bench-'))
init(dir, 'bench', engine === 'pg' ? 'postgresql' : 'sqlserver')
for (const db of ['bench_a', 'bench_b']) saveEnvironment(dir, db, env(db), true, false)
const cfg = Config.load(dir)

await setUp()
let t = Date.now()
const s = await DataSession.open(cfg, parseSide('bench_a'), parseSide('bench_b'), undefined, (_l, m) => console.log(`  ${m}`))
const r = s.result.tables.find((x) => x.table.endsWith('events'))!
console.log(`LiftOff data compare: ${seconds(t)} -> ${r.only_in_source} only in a, ${r.only_in_target} only in b, ${r.different} different`)
t = Date.now()
const page = await s.page(r.table, 'different', 0, 50)
console.log(`  first page of differences (${page.rows.length} rows, both sides): ${seconds(t)}`)
await s.close()
t = Date.now()
const mem = process.memoryUsage().rss
const d = await naive()
console.log(`Reading every row and comparing in memory: ${seconds(t)} -> ${d} differences (memory grew ${((process.memoryUsage().rss - mem) / 1e6).toFixed(0)} MB)`)
