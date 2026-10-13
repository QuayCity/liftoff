// The schema model as the source of truth: build it into a database, compare it with the
// migrations, generate the migration from it. On PostgreSQL and SQL Server, with the scratch
// database defined only by environment variables, the way a CI job would.

import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { test } from 'node:test'
import { Config } from '../src/core/config.ts'
import * as diff from '../src/core/diff.ts'
import { ModelInvalidError } from '../src/core/errors.ts'
import * as model from '../src/core/model.ts'
import * as runner from '../src/core/runner.ts'
import { SqlServerConn } from '../src/core/sqlserver.ts'
import { pgSchemaReset, project, sql } from './helpers.ts'

const pgBase = process.env.LIFTOFF_TEST_PG
const msBase = process.env.LIFTOFF_TEST_MSSQL

/** A scratch database that exists only as variables, like a pipeline's service container. */
function ciScratch(url: string): () => void {
  process.env.LIFTOFF_ENV_CI_SCRATCH_URL = url
  process.env.LIFTOFF_ENV_CI_SCRATCH_ROLE = 'scratch'
  return () => {
    delete process.env.LIFTOFF_ENV_CI_SCRATCH_URL
    delete process.env.LIFTOFF_ENV_CI_SCRATCH_ROLE
  }
}

test('PostgreSQL: dev -> schema model -> migration, then a hand edit of the model', { skip: !pgBase && 'set LIFTOFF_TEST_PG' }, async () => {
  const p = project('postgresql', [
    ['dev', `${pgBase}/shop_dev`, 'dev'],
    ['test', `${pgBase}/shop_test`, 'test'],
  ])
  const cleanup = ciScratch(`${pgBase}/shop_scratch`)
  try {
    const cfg = p.cfg()
    assert.equal(cfg.env('ci_scratch').role, 'scratch', 'an environment from variables alone')
    for (const e of ['dev', 'test', 'ci_scratch']) await sql(cfg, e, pgSchemaReset)
    await sql(
      cfg,
      'dev',
      `create type mood as enum ('sad', 'ok', 'happy');
       create domain email as text check (value like '%@%');
       create sequence invoice_no start 1000;
       create table customers (id bigint generated always as identity primary key, contact email not null unique, mood mood not null default 'ok');
       create table orders (id bigserial primary key, customer_id bigint not null references customers (id), total numeric(10,2) not null default 0);
       create index orders_customer_idx on orders (customer_id);
       create function tax(amount numeric) returns numeric language sql immutable as $$ select amount * 0.21 $$;
       create view order_totals as select o.id, o.total, tax(o.total) as vat from orders o;
       create view big_orders as select id from order_totals where total > 100;
       create table events (id bigint, at timestamptz not null, primary key (id, at)) partition by range (at);
       create table events_2026 partition of events for values from ('2026-01-01') to ('2027-01-01');
       comment on table customers is 'People who buy';`,
    )

    // 1. Pull dev into the schema model; it builds back into an identical database.
    const pulled = await model.status(cfg, 'dev')
    model.save(cfg, pulled)
    assert.ok(fs.existsSync(path.join(p.dir, 'schema-model/tables/public.orders.sql')), JSON.stringify(pulled.map((c) => c.path)))
    assert.equal(await model.check(cfg, 'ci_scratch'), 10, 'type, domain, sequence, 4 tables, function, 2 views')

    // 2. No migrations yet: the model is ahead by everything; generate the first migration from it.
    let cmp = await model.versusMigrations(cfg, 'ci_scratch')
    assert.ok(cmp.changes.some((c) => c.id === 'table:public.orders') && cmp.changes.some((c) => c.id === 'view:public.big_orders'), JSON.stringify(cmp.changes.map((c) => c.id)))
    const first = diff.generate(cfg, cmp.changes, 'from the model', false)
    diff.save(cfg, first.file_name, first.sql)
    cmp = await model.versusMigrations(cfg, 'ci_scratch')
    assert.deepEqual(cmp.changes.map((c) => c.id), [], `nothing left after the first migration\n${first.sql}`)
    // And the scripts build what dev has.
    assert.deepEqual((await diff.devVsMigrations(cfg, 'dev', 'ci_scratch')).changes.map((c) => c.id), [])

    // 3. A simple change straight in the model file: the next migration is exactly that change.
    const orders = path.join(p.dir, 'schema-model/tables/public.orders.sql')
    fs.writeFileSync(orders, fs.readFileSync(orders, 'utf8').replace('    total numeric(10,2) DEFAULT 0 NOT NULL', '    total numeric(10,2) DEFAULT 0 NOT NULL,\n    paid_at timestamp with time zone'))
    cmp = await model.versusMigrations(cfg, 'ci_scratch')
    assert.deepEqual(cmp.changes.map((c) => c.id), ['table:public.orders'], fs.readFileSync(orders, 'utf8'))
    assert.match(cmp.changes[0].sql, /ADD COLUMN paid_at timestamp with time zone/)
    const second = diff.generate(cfg, cmp.changes, 'paid at', false)
    diff.save(cfg, second.file_name, second.sql)
    await runner.migrate(cfg, 'test')
    assert.deepEqual((await model.versusMigrations(cfg, 'ci_scratch')).changes, [])

    // 4. A broken edit: the build names the file and the database's error.
    fs.writeFileSync(path.join(p.dir, 'schema-model/views/public.broken.sql'), 'CREATE VIEW public.broken AS\nSELECT no_such_column FROM public.orders;\n')
    await assert.rejects(model.check(cfg, 'ci_scratch'), (e: unknown) => {
      assert.ok(e instanceof ModelInvalidError)
      assert.deepEqual(e.problems.map((x) => x.path), ['views/public.broken.sql'])
      assert.match(e.problems[0].message, /no_such_column/)
      return true
    })
  } finally {
    cleanup()
  }
})

test('SQL Server: dev -> schema model -> migration', { skip: !msBase && 'set LIFTOFF_TEST_MSSQL' }, async () => {
  const master = await SqlServerConn.open('master', { url: `${msBase};databaseName=master`, role: 'prod', allow_clean: false, placeholders: {} })
  for (const db of ['shop_dev', 'shop_scratch']) {
    await master.batch(`IF DB_ID('${db}') IS NOT NULL BEGIN ALTER DATABASE [${db}] SET SINGLE_USER WITH ROLLBACK IMMEDIATE; DROP DATABASE [${db}]; END; CREATE DATABASE [${db}];`)
  }
  await master.close()
  const p = project('sqlserver', [['dev', `${msBase};databaseName=shop_dev`, 'dev']])
  const cleanup = ciScratch(`${msBase};databaseName=shop_scratch`)
  try {
    const cfg = Config.load(p.dir)
    for (const s of [
      'CREATE SCHEMA sales',
      'CREATE TYPE dbo.money_amount FROM decimal(12, 2) NOT NULL',
      'CREATE TABLE sales.customers (id int IDENTITY PRIMARY KEY, email nvarchar(200) NOT NULL UNIQUE)',
      "CREATE TABLE dbo.orders (id int IDENTITY PRIMARY KEY, customer_id int NOT NULL REFERENCES sales.customers (id), total dbo.money_amount, status varchar(20) NOT NULL CONSTRAINT df_status DEFAULT ('new'))",
      'CREATE VIEW dbo.open_orders AS SELECT id, total FROM dbo.orders WHERE status = \'new\'',
      'CREATE PROCEDURE dbo.add_order @c int AS INSERT INTO dbo.orders (customer_id, total) VALUES (@c, 0)',
    ]) {
      await sql(cfg, 'dev', s)
    }
    const withSales = new Config(cfg.root, { ...cfg.project, schemas: ['dbo', 'sales'] }, cfg.environments)
    model.save(withSales, await model.status(withSales, 'dev'))
    let cmp = await model.versusMigrations(withSales, 'ci_scratch')
    assert.ok(cmp.changes.length >= 5, JSON.stringify(cmp.changes.map((c) => c.id)))
    const g = diff.generate(withSales, cmp.changes, 'from the model', false)
    diff.save(withSales, g.file_name, g.sql)
    cmp = await model.versusMigrations(withSales, 'ci_scratch')
    assert.deepEqual(cmp.changes.map((c) => c.id), [], g.sql)
  } finally {
    cleanup()
  }
})
