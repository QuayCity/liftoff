// Data compare speed by table size, for a table with a key and for a heap (no key).
//   LIFTOFF_TEST_MSSQL='sqlserver://…' node scripts/bench-datacompare-matrix.ts ms 100,1000,10000
//   LIFTOFF_TEST_PG=postgres://… node scripts/bench-datacompare-matrix.ts pg 100,1000,10000
// Per size: bench_a and bench_b (dropped first) get N rows in a keyed table and in a heap with the
// same columns; bench_b then gets 25 scattered differences (10 changed, 10 deleted, 5 extra).
// Times: the comparison, the first page of rows, the sync script, applying it, and comparing again.

import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { parseSide } from '../src/core/compare.ts'
import { Config, init, saveEnvironment } from '../src/core/config.ts'
import { DataSession } from '../src/core/datacompare.ts'
import { open } from '../src/core/db.ts'
import { PgConn, withDatabase } from '../src/core/postgres.ts'
import { SqlServerConn } from '../src/core/sqlserver.ts'

const [engine = 'ms', list = '100,1000,10000,50000,100000,200000,300000'] = process.argv.slice(2)
const pg = engine === 'pg'
const base = pg ? process.env.LIFTOFF_TEST_PG : process.env.LIFTOFF_TEST_MSSQL
if (!base) throw new Error(`set ${pg ? 'LIFTOFF_TEST_PG' : 'LIFTOFF_TEST_MSSQL'}`)
const urlOf = (db: string) => (pg ? withDatabase(base, db) : `${base};databaseName=${db}`)
const env = (db: string) => ({ url: urlOf(db), role: 'test' as const, allow_clean: false, placeholders: {} })
const since = (t: number) => (Date.now() - t) / 1000

async function setUp(rows: number): Promise<void> {
  const admin = pg ? await PgConn.open('admin', env('postgres')) : await SqlServerConn.open('admin', env('master'))
  for (const db of ['bench_a', 'bench_b']) {
    await admin.batch(pg ? `drop database if exists ${db} with (force)` : `IF DB_ID('${db}') IS NOT NULL BEGIN ALTER DATABASE [${db}] SET SINGLE_USER WITH ROLLBACK IMMEDIATE; DROP DATABASE [${db}]; END`)
    await admin.batch(pg ? `create database ${db}` : `CREATE DATABASE [${db}]`)
  }
  await admin.close()
  for (const db of ['bench_a', 'bench_b']) {
    const c = await open(db, env(db))
    for (const [table, key] of [['keyed', true], ['heap', false]] as const) {
      await c.batch(
        pg
          ? `create table public.${table} (id bigint${key ? ' primary key' : ' not null'}, account int not null, kind text not null, amount numeric(12, 2), at timestamptz not null, note text);
             insert into public.${table} select i, i % 5000, 'kind' || (i % 17), i * 0.37, timestamptz '2026-01-01' + i * interval '1 second', case when i % 9 = 0 then null else 'note ' || i end
               from generate_series(1, ${rows}) i;`
          : `CREATE TABLE dbo.${table} (id bigint NOT NULL${key ? ' PRIMARY KEY' : ''}, account int NOT NULL, kind nvarchar(20) NOT NULL, amount decimal(12, 2), at datetime2 NOT NULL, note nvarchar(50));
             WITH n AS (SELECT TOP (${rows}) ROW_NUMBER() OVER (ORDER BY (SELECT NULL)) AS i FROM sys.all_columns a CROSS JOIN sys.all_columns b CROSS JOIN sys.all_columns c)
             INSERT INTO dbo.${table} SELECT i, i % 5000, CONCAT(N'kind', i % 17), i * 0.37, DATEADD(SECOND, i, CAST('2026-01-01' AS datetime2)), CASE WHEN i % 9 = 0 THEN NULL ELSE CONCAT(N'note ', i) END FROM n;`,
      )
    }
    await c.close()
  }
  const b = await open('bench_b', env('bench_b'))
  const step = Math.max(1, Math.floor(rows / 26))
  for (const table of ['keyed', 'heap']) {
    const tbl = pg ? `public.${table}` : `dbo.${table}`
    for (let k = 1; k <= 10; k++) await b.batch(`UPDATE ${tbl} SET note = 'changed' WHERE id = ${k * step}`)
    for (let k = 11; k <= 20; k++) await b.batch(`DELETE FROM ${tbl} WHERE id = ${k * step}`)
    for (let k = 1; k <= 5; k++) await b.batch(`INSERT INTO ${tbl} (id, account, kind, amount, at, note) VALUES (${rows + k}, 1, 'x', 1, ${pg ? 'now()' : 'SYSDATETIME()'}, 'extra')`)
  }
  await b.close()
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lo-bench-'))
init(dir, 'bench', pg ? 'postgresql' : 'sqlserver')
for (const db of ['bench_a', 'bench_b']) saveEnvironment(dir, db, env(db), true, false)
const cfg = Config.load(dir)

const table = (name: string) => (pg ? `public.${name}` : `dbo.${name}`)
console.log('| rows | table | compare (s) | found (src / tgt / diff) | first page (s) | script (s) | apply (s) | compare again (s) | then |')
console.log('| ---: | --- | ---: | --- | ---: | ---: | ---: | ---: | --- |')
for (const rows of list.split(',').map(Number)) {
  await setUp(rows)
  for (const name of ['keyed', 'heap']) {
    const t = table(name)
    let at = Date.now()
    const s = await DataSession.open(cfg, parseSide('bench_a'), parseSide('bench_b'), [t])
    const compare = since(at)
    const r = s.result.tables[0]
    at = Date.now()
    await s.page(t, r.different ? 'different' : 'only_in_target', 0, 50)
    const page = since(at)
    at = Date.now()
    for await (const _ of s.script()) void _
    const script = since(at)
    at = Date.now()
    await s.apply()
    const apply = since(at)
    await s.close()
    at = Date.now()
    const again = await DataSession.open(cfg, parseSide('bench_a'), parseSide('bench_b'), [t])
    const compareAgain = since(at)
    const x = again.result.tables[0]
    await again.close()
    const left = x.only_in_source + x.only_in_target + x.different
    console.log(`| ${rows.toLocaleString('en')} | ${name === 'keyed' ? 'key' : 'heap'} | ${compare.toFixed(2)} | ${r.only_in_source} / ${r.only_in_target} / ${r.different} | ${page.toFixed(2)} | ${script.toFixed(2)} | ${apply.toFixed(2)} | ${compareAgain.toFixed(2)} | ${left ? `${left} left!` : 'same'} |`)
  }
}
