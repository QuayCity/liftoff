// Data compare speed by table size and by how much differs, for a table with a key and for a heap.
//   LIFTOFF_TEST_MSSQL='sqlserver://…' node scripts/bench-datacompare-matrix.ts ms 10000,100000 1,5,10,20 3
//   LIFTOFF_TEST_PG=postgres://… node scripts/bench-datacompare-matrix.ts pg 10000,100000 1,5,10,20 3
// Arguments: engine, sizes (rows), changes (% of the rows), runs per measurement, tables (keyed,heap).
// Per size and percentage, bench_a and bench_b (dropped first) get N rows in a keyed table and in a
// heap with the same columns. bench_b then gets the same changes in both, spread over the table:
// a third of them rows with a changed value, a third rows missing, a third extra rows.
// The comparison and the script are timed `runs` times (median, min-max); the sync is applied once,
// then compared again. Every line checks the counts against the changes made.

import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { parseSide } from '../src/core/compare.ts'
import { Config, init, saveEnvironment } from '../src/core/config.ts'
import { DataSession } from '../src/core/datacompare.ts'
import { open } from '../src/core/db.ts'
import { PgConn, withDatabase } from '../src/core/postgres.ts'
import { SqlServerConn } from '../src/core/sqlserver.ts'

const [engine = 'ms', sizeList = '100,1000,10000,50000,100000,200000,300000', pctList = '1,5,10,20', runsArg = '3', tableList = 'keyed,heap'] = process.argv.slice(2)
const pg = engine === 'pg'
const runs = Number(runsArg)
const base = pg ? process.env.LIFTOFF_TEST_PG : process.env.LIFTOFF_TEST_MSSQL
if (!base) throw new Error(`set ${pg ? 'LIFTOFF_TEST_PG' : 'LIFTOFF_TEST_MSSQL'}`)
const urlOf = (db: string) => (pg ? withDatabase(base, db) : `${base};databaseName=${db}`)
const env = (db: string) => ({ url: urlOf(db), role: 'test' as const, allow_clean: false, placeholders: {} })

/** Changed, missing and extra rows made in bench_b. */
type Made = { changed: number; missing: number; extra: number }

// Rows are picked by a spread of their id over 0..9999: (id * 7919) % 10000, so the changes are
// scattered through the table rather than in one block.
const SPREAD = 10_000
const spread = (col: string) => `(${col} * 7919) % ${SPREAD}`

async function setUp(rows: number, pct: number): Promise<Made> {
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
  // pct% of the spread: the first third changed, the second third deleted; as many extra rows as deleted.
  const third = Math.round((SPREAD * pct) / 100 / 3)
  const b = await open('bench_b', env('bench_b'))
  const made: Made = { changed: 0, missing: 0, extra: 0 }
  for (const table of ['keyed', 'heap']) {
    const tbl = pg ? `public.${table}` : `dbo.${table}`
    const count = async (where: string) => {
      const sql = `SELECT COUNT(*) FROM ${tbl} WHERE ${where}`
      return Number(pg ? (await (b as PgConn).row(sql))[0] : (await (b as SqlServerConn).query(sql))[0][0])
    }
    made.changed = await count(`${spread('id')} < ${third}`)
    made.missing = await count(`${spread('id')} >= ${third} AND ${spread('id')} < ${2 * third}`)
    made.extra = made.missing
    await b.batch(`UPDATE ${tbl} SET amount = amount + 1, note = ${pg ? "coalesce(note, '') || ' (changed)'" : "CONCAT(note, N' (changed)')"} WHERE ${spread('id')} < ${third}`)
    await b.batch(`DELETE FROM ${tbl} WHERE ${spread('id')} >= ${third} AND ${spread('id')} < ${2 * third}`)
    await b.batch(
      pg
        ? `insert into ${tbl} select ${rows} + i, 1, 'extra', i, now(), 'extra ' || i from generate_series(1, ${made.extra}) i`
        : `WITH n AS (SELECT TOP (${made.extra}) ROW_NUMBER() OVER (ORDER BY (SELECT NULL)) AS i FROM sys.all_columns a CROSS JOIN sys.all_columns b CROSS JOIN sys.all_columns c)
           INSERT INTO ${tbl} SELECT ${rows} + i, 1, N'extra', i, SYSDATETIME(), CONCAT(N'extra ', i) FROM n`,
    )
  }
  await b.close()
  return made
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lo-bench-'))
init(dir, 'bench', pg ? 'postgresql' : 'sqlserver')
for (const db of ['bench_a', 'bench_b']) saveEnvironment(dir, db, env(db), true, false)
const cfg = Config.load(dir)

const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]
const timed = (xs: number[]) => (xs.length > 1 ? `${median(xs).toFixed(2)} (${Math.min(...xs).toFixed(2)}–${Math.max(...xs).toFixed(2)})` : xs[0].toFixed(2))
const sideA = parseSide('bench_a')
const sideB = parseSide('bench_b')

console.log(`SQL ${pg ? 'PostgreSQL' : 'Server'}; ${runs} run(s) per measurement; times in seconds: median (min–max)`)
console.log('| rows | changed | table | differences found (source / target / changed) | as made | compare | script | apply | compare again | then |')
console.log('| ---: | ---: | --- | --- | --- | ---: | ---: | ---: | ---: | --- |')
for (const rows of sizeList.split(',').map(Number)) {
  for (const pct of pctList.split(',').map(Number)) {
    const made = await setUp(rows, pct)
    for (const name of tableList.split(',')) {
      const t = pg ? `public.${name}` : `dbo.${name}`
      const compare: number[] = []
      const script: number[] = []
      let found = ''
      for (let r = 0; r < runs; r++) {
        let at = Date.now()
        const s = await DataSession.open(cfg, sideA, sideB, [t])
        compare.push((Date.now() - at) / 1000)
        const x = s.result.tables[0]
        found = `${x.only_in_source} / ${x.only_in_target} / ${x.whole_rows ? '–' : x.different}`
        at = Date.now()
        for await (const _ of s.script()) void _
        script.push((Date.now() - at) / 1000)
        if (r < runs - 1) await s.close()
        else {
          // The last run applies the sync, then compares again.
          at = Date.now()
          await s.apply()
          const apply = (Date.now() - at) / 1000
          await s.close()
          at = Date.now()
          const again = await DataSession.open(cfg, sideA, sideB, [t])
          const compareAgain = (Date.now() - at) / 1000
          const y = again.result.tables[0]
          await again.close()
          const left = y.only_in_source + y.only_in_target + y.different
          // A heap has no "changed": a changed row is one only in the source and one only in the target.
          const expected = name === 'keyed' ? `${made.missing} / ${made.extra} / ${made.changed}` : `${made.missing + made.changed} / ${made.extra + made.changed} / –`
          const total = made.changed + made.missing + made.extra
          console.log(
            `| ${rows.toLocaleString('en')} | ${pct}% (${total.toLocaleString('en')}) | ${name === 'keyed' ? 'key' : 'heap'} | ${found} | ${found === expected ? 'yes' : `NO, made ${expected}`} | ${timed(compare)} | ${timed(script)} | ${apply.toFixed(2)} | ${compareAgain.toFixed(2)} | ${left ? `${left} left!` : 'same'} |`,
          )
        }
      }
    }
  }
}
