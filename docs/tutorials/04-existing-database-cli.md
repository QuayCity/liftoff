# Tutorial 4: an existing database, on the command line

Your **shop** database has been in production for years. It was built by hand and by ad-hoc
scripts; nobody is sure the test and acceptance copies still match it. You want it under version
control, so every change from now on is a reviewed script that runs the same way everywhere.

By the end of this tutorial:

- every object production has is captured in one baseline script, `B0001`, checked to rebuild
  production exactly;
- production, test and acceptance are recorded at `B0001`, with what each of them lacked or had
  differently found and dealt with;
- a fresh dev database is built from `B0001`, and the schema model holds one file per object;
- the first new change is written as `V0002` and deployed.

Your data is never touched: adopting only reads production's schema and adds a history table.

It takes about 30 minutes. The examples use SQL Server; the [PostgreSQL notes](#on-postgresql)
list what differs. If you have not read [the concepts](../guide/concepts.md) yet, the sections on
the scratch database and baselines help here.

## Before you start

- **`liftoff` is installed**: `liftoff --version` prints a version.
- **git** is installed.
- **A SQL Server you can create databases on**, and a tool to run SQL (SSMS, Azure Data Studio,
  `sqlcmd`). No server? `docker run -d --name shop-sql -p 1433:1433 -e ACCEPT_EULA=Y -e
  "MSSQL_SA_PASSWORD=Shop!Pass2026" mcr.microsoft.com/mssql/server:2022-latest`

## Step 0: the existing databases (only to follow along)

You probably have your own databases. To follow along exactly, make four databases that look like
a typical estate:

```sql
CREATE DATABASE shop_prod;    -- production: the truth
CREATE DATABASE shop_test;    -- a copy, missing a view and a procedure someone forgot
CREATE DATABASE shop_acc;     -- acceptance: a copy with an extra column someone added by hand
CREATE DATABASE shop_dev;     -- empty: your new dev database
```

Then run [`files/existing-shop.sql`](files/existing-shop.sql) on **shop_prod**, **shop_test** and
**shop_acc**. It creates four tables (customers, products, orders, order_lines) with keys, checks,
defaults and an index, a view, a function, a procedure and a trigger. Run
[`files/existing-shop-rows.sql`](files/existing-shop-rows.sql) on **shop_prod** for a few rows.
Then make the copies drift, as real ones do:

```sql
-- on shop_test
DROP PROCEDURE dbo.orders_for_customer;
DROP VIEW dbo.order_summary;

-- on shop_acc
ALTER TABLE dbo.customers ADD loyalty_points int NULL;
```

## Step 1: create the project

```sh
mkdir shop-db
cd shop-db
git init
liftoff init --name shop --engine sqlserver
```

This writes `liftoff.toml`, an empty `migrations/` and `schema-model/`, and a `.gitignore` for
your private settings file.

## Step 2: add the environments

The shared environments go at the end of `liftoff.toml`:

```toml
[environments.test]
url = "sqlserver://localhost:1433;databaseName=shop_test;encrypt=true;trustServerCertificate=true"
user = "sa"
password = "${env.SHOP_TEST_PASSWORD}"
role = "test"

[environments.acceptance]
url = "sqlserver://localhost:1433;databaseName=shop_acc;encrypt=true;trustServerCertificate=true"
user = "sa"
password = "${env.SHOP_ACC_PASSWORD}"
role = "test"

[environments.prod]
url = "sqlserver://localhost:1433;databaseName=shop_prod;encrypt=true;trustServerCertificate=true"
user = "sa"
password = "${env.SHOP_PROD_PASSWORD}"
role = "prod"
```

Your dev database goes in `liftoff.user.toml` (create it; git ignores it):

```toml
[environments.dev]
url = "sqlserver://localhost:1433;databaseName=shop_dev;encrypt=true;trustServerCertificate=true"
user = "sa"
password = "${env.SHOP_DEV_PASSWORD}"
role = "dev"
```

Set the password variables:

```powershell
# PowerShell
$env:SHOP_DEV_PASSWORD = 'Shop!Pass2026'; $env:SHOP_TEST_PASSWORD = 'Shop!Pass2026'
$env:SHOP_ACC_PASSWORD = 'Shop!Pass2026'; $env:SHOP_PROD_PASSWORD = 'Shop!Pass2026'
```

```sh
# bash
export SHOP_DEV_PASSWORD='Shop!Pass2026' SHOP_TEST_PASSWORD='Shop!Pass2026' SHOP_ACC_PASSWORD='Shop!Pass2026' SHOP_PROD_PASSWORD='Shop!Pass2026'
```

Use real server names and logins for your own databases. The login LiftOff uses on production
needs to read the schema and create one table (the history table); for deploying later, it needs
to change the schema. See [Connections](../guide/configuration.md#connection-urls) for other ways to
sign in, including Azure SQL with Microsoft Entra ID.

Then a scratch database, an empty database LiftOff may erase at will. It checks the capture there:

```sh
liftoff create-scratch
```

```
Created database shop_dev_scratch and saved it as environment 'scratch' (role scratch, private)
```

## Step 3: why LiftOff will not just run

Try deploying to production:

```sh
liftoff -e prod migrate
```

```
error: 'prod' already has tables but no migration history. Baseline it first (`liftoff baseline --version …`), or run the scripts anyway with --allow-non-empty
```

Exit code 12. LiftOff refuses to run scripts on a database that has objects it knows nothing
about: a `CREATE TABLE customers` would fail halfway, or worse. First it has to learn what
production already has.

## Step 4: adopt production

```sh
liftoff -e prod adopt
```

```
Capturing the objects of 'prod'
prod already has objects: checking them against B0001__existing_schema.sql (built on 'scratch')
Rebuilding scratch database 'scratch' from migrations up to 0001
Empty database: building it from B0001__existing_schema.sql
prod is now at B0001__existing_schema.sql
Wrote …\shop-db\migrations\B0001__existing_schema.sql from prod and recorded it there.
Other environments that already have these objects are checked against it on their next migrate; empty ones are built from it. New scripts start at the next number.
```

Three things happened:

1. **Capture.** Every object in production's `dbo` schema was written to
   `migrations/B0001__existing_schema.sql`.
2. **Check.** That script was run on the empty scratch database, and the result compared with
   production. It matched exactly, which proves the capture is complete. Had anything been
   missing, nothing would have been kept, and the differences listed.
3. **Record.** Production got a history table, `dbo.liftoff_schema_history`, saying it is at
   `B0001`. Nothing else on production changed; its rows are untouched.

```sh
liftoff -e prod info
```

```
Version          Description                      State           Ran on                   Took
0001             existing schema                  baseline        2026-10-12T12:38:04Z     0 ms
```

Open `B0001__existing_schema.sql`. It lists what it holds at the top, then creates it in an order
that runs: tables, then their keys, checks and indexes, then foreign keys, then the function
before the view and the procedure that use it, then the trigger.

```sql
-- existing schema
-- Written by LiftOff. Review before committing.
--
--   Add function dbo.order_total
--   Add procedure dbo.orders_for_customer
--   Add table dbo.customers
--   Add table dbo.order_lines
--   Add table dbo.orders
--   Add table dbo.products
--   Add trigger dbo.orders_touch
--   Add view dbo.order_summary
GO

CREATE TABLE [dbo].[customers] (
    [id] int IDENTITY(1,1) NOT NULL,
    [email] nvarchar(320) NOT NULL,
    [name] nvarchar(200) NOT NULL,
    [created_at] datetime2(7) NOT NULL CONSTRAINT [df_customers_created] DEFAULT (sysutcdatetime())
);
GO
…
ALTER TABLE [dbo].[customers] ADD CONSTRAINT [pk_customers] PRIMARY KEY CLUSTERED ([id] ASC);
GO
…
```

Constraint names are kept as production has them. Commit it:

```sh
git add -A
git commit -m "B0001: the existing shop schema"
```

> **Objects LiftOff does not compare yet** (on SQL Server: synonyms, table types, CLR objects,
> permissions and a few others) are counted and named in the output, never left out silently.
> Keep those in hand-written scripts. Objects you do not want managed at all, such as another
> application's tables, can be left out with [filters](../guide/configuration.md#filters) before
> you adopt.

## Step 5: the other environments

Each environment that already has objects is checked against `B0001` on its first `migrate`.

**Test** lacks the view and the procedure:

```sh
liftoff -e test migrate
```

```
test already has objects: checking them against B0001__existing_schema.sql (built on 'scratch')
test: creating what it lacks of B0001__existing_schema.sql: view:dbo.order_summary, procedure:dbo.orders_for_customer
test is now at B0001__existing_schema.sql
Applied 1 migration(s) to test in 3582 ms
```

The missing objects were created, then `B0001` recorded. Test now has exactly what production has.

**Acceptance** has a column production does not:

```sh
liftoff -e acceptance migrate
```

```
error: 'acceptance' has objects that differ from B0001__existing_schema.sql:
  different: table:dbo.customers
Make them match, or keep them and record the baseline anyway with --accept-differences (they then show up as drift).
```

Exit code 12, and nothing on acceptance changed. LiftOff will not decide for you which side is
right. See exactly what differs:

```sh
liftoff compare --source migrations --target acceptance --script -
```

```
acceptance -> the migrations (SQL Server): 1 difference(s)
  changed  table:dbo.customers  (may lose data)
ALTER TABLE [dbo].[customers] DROP COLUMN [loyalty_points];
```

Now choose:

- **Production is right.** Run that script on acceptance (it drops the column and its data), or
  apply it with `liftoff compare --source migrations --target acceptance --apply`. Then
  `liftoff -e acceptance migrate` again: it matches, and `B0001` is recorded.
- **The column should exist everywhere.** Record acceptance as it is, then make the change
  properly: add the column in dev and write a migration (step 7). Every environment, production
  included, then gets it.
- **Not decided yet.** Record it anyway and deal with it later:

```sh
liftoff -e acceptance migrate --accept-differences
```

```
warning: acceptance: table:dbo.customers differs from B0001__existing_schema.sql; kept as it is (it shows up as drift)
acceptance is now at B0001__existing_schema.sql
```

The difference does not disappear: each check reports it until it is fixed.

```sh
liftoff -e acceptance check --drift
```

```
Drift: 1
  changed  dbo.customers
```

Exit code 13, so a pipeline stops before deploying to acceptance until someone decides.

## Step 6: a dev database, and the schema model

Your dev database is empty. Build it from `B0001`:

```sh
liftoff -e dev migrate
```

```
Empty database: building it from B0001__existing_schema.sql
Applied 1 migration(s) to dev in 668 ms
```

Dev has production's schema now, without its data. (If you would rather use a restored copy of
production as dev, that works too: `migrate` checks it against `B0001` like test and acceptance.)

Fill the schema model from dev, one file per object:

```sh
liftoff model
```

```
Updated 8 file(s) in schema-model
```

```
schema-model/dbo/functions/order_total.sql
schema-model/dbo/procedures/orders_for_customer.sql
schema-model/dbo/tables/customers.sql
schema-model/dbo/tables/order_lines.sql
schema-model/dbo/tables/orders.sql
schema-model/dbo/tables/products.sql
schema-model/dbo/triggers/orders_touch.sql
schema-model/dbo/views/order_summary.sql
```

From now on `git log schema-model/dbo/tables/orders.sql` is the history of the orders table.

```sh
git add -A
git commit -m "schema model"
```

## Step 7: the first change under LiftOff

From here on, it is the everyday loop of [tutorial 1](01-new-project-cli.md). Change dev, on
`shop_dev`:

```sql
ALTER TABLE dbo.products ADD weight_kg decimal(6,2) NULL;
```

```sh
liftoff diff
```

```
changed  dbo.products
```

```sh
liftoff generate --description "product weight" --undo --record-on-dev
liftoff model
```

`migrations/V0002__product_weight.sql` is the first script after the baseline; `model` updates
`products.sql`. Review both and commit:

```sh
git add -A
git commit -m "product weight"
```

Deploy:

```sh
liftoff -e test migrate
liftoff -e prod check
liftoff -e prod migrate
```

```
Applied 1 migration(s) to prod in 407 ms
```

`liftoff -e prod info` now shows `0001 existing schema baseline` and `0002 product weight
applied`.

## What you did

| step | command |
| --- | --- |
| a project and its environments | `liftoff init`, `liftoff.toml`, `liftoff.user.toml` |
| a scratch database | `liftoff create-scratch` |
| capture production and record it | `liftoff -e prod adopt` |
| bring each environment under LiftOff | `liftoff -e <env> migrate` (checked against `B0001`) |
| see what differs, decide | `liftoff compare --source migrations --target <env>`, `--accept-differences` |
| a dev database | `liftoff -e dev migrate` on an empty database |
| the schema model | `liftoff model` |
| the first change | `liftoff generate`, then deploy |

## Questions

**Can I adopt without writing to production?** Adopt a restored copy instead
(`liftoff -e prodcopy adopt`), commit `B0001`, then let the pipeline run
`liftoff -e prod migrate`: production is checked against `B0001` and recorded, like test was.

**Production has several schemas.** List them in `liftoff.toml` before you adopt:
`schemas = ["dbo", "sales", "audit"]`. The first holds the history table.

**What about a new, empty environment later?** `migrate` builds it from `B0001`, then the `V`
scripts.

**I would rather not use `adopt`.** The pieces are available on their own:
`liftoff -e prod capture --as-baseline-script` writes the script without checking or recording,
and `liftoff -e prod baseline --version 1` records a database as being at version 1. See
[Existing databases](../guide/existing-databases.md#doing-it-by-hand).

**The database was managed by Flyway.** Convert the project instead: [tutorial 7](07-from-flyway.md).

## On PostgreSQL

The steps are the same. What differs:

- `liftoff init --name shop --engine postgresql`; the schema is `public`. Set `schemas` if your
  objects live elsewhere.
- URLs: `postgres://localhost:5432/shop_prod`, `user = "postgres"` (or your login).
- `B0001` also holds extensions, enums, domains, sequences, grants and comments.
- To follow along, write the step 0 schema in PostgreSQL's dialect, or adopt any database you
  have: the steps do not depend on what is in it.
