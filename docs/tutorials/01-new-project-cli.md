# Tutorial 1: a new project, on the command line

You are starting a new application, **shop**, and its database does not exist yet. By the end of
this tutorial you will have:

- a project in git with its first two migration scripts, written for you from the changes you
  made in a dev database;
- those scripts deployed to a test and a production database, with the checks a production
  deploy deserves;
- a schema model, and a pipeline that deploys on every merge.

It takes about 30 minutes. The commands are the same on Windows, macOS and Linux; where the shell
matters, both PowerShell and bash are shown. The examples use SQL Server; the
[PostgreSQL notes](#on-postgresql) at the end list what differs.

## Before you start

- **`liftoff` is installed**: `liftoff --version` prints a version. See [Installing](../guide/installing.md).
- **git** is installed.
- **A SQL Server you can create databases on**, and a tool to run SQL on it (SSMS, Azure Data
  Studio, VS Code with the mssql extension, or `sqlcmd`).

No server at hand? Run one in Docker:

```sh
docker run -d --name shop-sql -p 1433:1433 -e ACCEPT_EULA=Y -e "MSSQL_SA_PASSWORD=Shop!Pass2026" mcr.microsoft.com/mssql/server:2022-latest
```

It listens on `localhost,1433`, user `sa`, password `Shop!Pass2026`, with a self-signed
certificate.

## Step 1: create the databases

Real projects have their test and production databases on other servers. Here everything is on
one server, so you can follow along. Run this on the server:

```sql
CREATE DATABASE shop_dev;    -- you change this one by hand
CREATE DATABASE shop_test;   -- deployed to first
CREATE DATABASE shop_prod;   -- deployed to last
```

A fourth database, the scratch database, comes in step 4.

## Step 2: create the project

```sh
mkdir shop-db
cd shop-db
git init
liftoff init --name shop --engine sqlserver
```

```
Created liftoff.toml in …\shop-db
```

You now have:

```
shop-db/
  .gitignore          holds liftoff.user.toml
  liftoff.toml        the project settings
  migrations/         the scripts will go here
  schema-model/       one file per object, later
```

`liftoff.toml`:

```toml
[project]
name = "shop"
engine = "sqlserver"
migrations = "migrations"
schemas = [ "dbo" ]
history_table = "liftoff_schema_history"
```

## Step 3: add the environments

An environment is a database LiftOff knows by name. Test and production are shared with the
team, so they go in `liftoff.toml`. Add this at the end of it (with your server's name instead of
`localhost` if it is elsewhere):

```toml
[environments.test]
url = "sqlserver://localhost:1433;databaseName=shop_test;encrypt=true;trustServerCertificate=true"
user = "sa"
password = "${env.SHOP_TEST_PASSWORD}"
role = "test"

[environments.prod]
url = "sqlserver://localhost:1433;databaseName=shop_prod;encrypt=true;trustServerCertificate=true"
user = "sa"
password = "${env.SHOP_PROD_PASSWORD}"
role = "prod"
```

Your dev database is yours alone, so it goes in `liftoff.user.toml`, which git ignores. Create
that file:

```toml
[environments.dev]
url = "sqlserver://localhost:1433;databaseName=shop_dev;encrypt=true;trustServerCertificate=true"
user = "sa"
password = "${env.SHOP_DEV_PASSWORD}"
role = "dev"
```

The passwords are not in the files: `${env.SHOP_TEST_PASSWORD}` reads the environment variable
`SHOP_TEST_PASSWORD`. Set the three variables in your shell:

```powershell
# PowerShell
$env:SHOP_DEV_PASSWORD = 'Shop!Pass2026'; $env:SHOP_TEST_PASSWORD = 'Shop!Pass2026'; $env:SHOP_PROD_PASSWORD = 'Shop!Pass2026'
```

```sh
# bash
export SHOP_DEV_PASSWORD='Shop!Pass2026' SHOP_TEST_PASSWORD='Shop!Pass2026' SHOP_PROD_PASSWORD='Shop!Pass2026'
```

> `trustServerCertificate=true` accepts the container's self-signed certificate. For a real
> server with a proper certificate, leave it out. Other ways to sign in, including Azure SQL with
> Microsoft Entra ID, are in [Connections](../guide/configuration.md#connection-urls).

Check:

```sh
liftoff project
liftoff -e dev test-connection
```

```
shop (sqlserver, scripts in migrations)
dev              dev      SQL Server
prod             prod     SQL Server
test             test     SQL Server

Connected to dev: shop_dev as sa (SQL Server 16.0.4222.2)
```

## Step 4: a scratch database

To write a migration, LiftOff builds what the existing scripts make on an empty database, then
compares your dev database with it. That empty database is the **scratch** database. Let
LiftOff create one next to dev:

```sh
liftoff create-scratch
```

```
Created database shop_dev_scratch and saved it as environment 'scratch' (role scratch, private)
```

It is saved in `liftoff.user.toml`, with the dev password copied into your operating system's
keychain. Never put anything you want to keep in it: LiftOff erases it whenever it needs to.

## Step 5: make the first change in dev

Change dev the way you always would. Run this on `shop_dev`:

```sql
CREATE TABLE dbo.customers (
    id int IDENTITY PRIMARY KEY,
    email nvarchar(320) NOT NULL UNIQUE,
    name nvarchar(200) NOT NULL,
    created_at datetime2 NOT NULL DEFAULT SYSUTCDATETIME()
);
CREATE TABLE dbo.orders (
    id int IDENTITY PRIMARY KEY,
    customer_id int NOT NULL REFERENCES dbo.customers (id),
    total decimal(10,2) NOT NULL,
    placed_at datetime2 NOT NULL DEFAULT SYSUTCDATETIME()
);
```

Ask LiftOff what changed:

```sh
liftoff diff
```

```
Rebuilding scratch database 'scratch' from migrations
scratch is up to date
Comparing 'dev' with the migrations
2 difference(s)
added    dbo.customers
added    dbo.orders
```

*Added* means dev has it and the scripts do not make it yet.

## Step 6: write the migration

```sh
liftoff generate --description "customers and orders" --undo --record-on-dev
```

```
2 difference(s)
Recorded V0001__customers_and_orders.sql as applied on dev without running it
Wrote …\shop-db\migrations\V0001__customers_and_orders.sql
```

- `--undo` also writes `U0001__customers_and_orders.sql`, which reverses it.
- `--record-on-dev` tells dev's history that dev already has this change (you made it by hand),
  so a later `migrate` on dev does not try to create the tables again.

Open `migrations/V0001__customers_and_orders.sql`:

```sql
-- customers and orders
-- Written by LiftOff. Review before committing.
--
--   Add table dbo.customers
--   Add table dbo.orders
GO

CREATE TABLE [dbo].[customers] (
    [id] int IDENTITY(1,1) NOT NULL,
    [email] nvarchar(320) NOT NULL,
    [name] nvarchar(200) NOT NULL,
    [created_at] datetime2(7) NOT NULL DEFAULT (sysutcdatetime())
);
GO
CREATE TABLE [dbo].[orders] (
    …
);
GO

ALTER TABLE [dbo].[customers] ADD PRIMARY KEY CLUSTERED ([id] ASC);
GO
ALTER TABLE [dbo].[customers] ADD UNIQUE NONCLUSTERED ([email] ASC);
GO
ALTER TABLE [dbo].[orders] ADD PRIMARY KEY CLUSTERED ([id] ASC);
GO

ALTER TABLE [dbo].[orders] ADD FOREIGN KEY ([customer_id]) REFERENCES [dbo].[customers] ([id]);
GO
```

**Review it** as you would review code. It is yours now: edit it freely until it has run
somewhere other than dev. Then commit:

```sh
git add -A
git commit -m "customers and orders"
```

## Step 7: deploy to test

See what test has and what is pending:

```sh
liftoff -e test info
```

```
Version          Description                      State           Ran on                   Took
0001             customers and orders             pending
```

Run it:

```sh
liftoff -e test migrate
```

```
Connected to test (shop_test as sa, SQL Server 16.0.4222.2)
Running V0001__customers_and_orders.sql
Applied V0001__customers_and_orders.sql in 1379 ms
Applied 1 migration(s) to test in 6349 ms
```

The script ran in one transaction, and test's history table, `dbo.liftoff_schema_history`, now
has a row for it. Run `migrate` again and nothing happens: there is nothing pending.

## Step 8: deploy to production, carefully

Before production, check:

```sh
liftoff -e prod check
```

```
Drift: none
Pending changes: 2
  added    dbo.customers
  added    dbo.orders
Dry run:
-- Dry run for prod: nothing below has been executed.
-- History table: [dbo].[liftoff_schema_history]

-- V0001__customers_and_orders.sql
BEGIN TRANSACTION;
…
INSERT INTO [dbo].[liftoff_schema_history] (…) …;
COMMIT;
```

Three answers, without changing anything:

1. **Drift: none.** Nobody changed prod outside the scripts. If someone had, `check` would list
   the objects and exit with code 13, so a pipeline stops.
2. **Pending changes.** What the pending scripts will change, worked out by running them on the
   scratch database. Changes that may lose data are marked.
3. **The dry run.** The exact SQL `migrate` will run.

`liftoff -e prod check --report check.html` writes the same as a web page, to attach to a change
request. Then deploy:

```sh
liftoff -e prod migrate
```

```
Applied V0001__customers_and_orders.sql in 26 ms
Applied 1 migration(s) to prod in 589 ms
```

## Step 9: the next change, and undo

Back in dev, add a column and a view. On `shop_dev`:

```sql
ALTER TABLE dbo.customers ADD phone nvarchar(30) NULL;
GO
CREATE VIEW dbo.customer_totals AS
SELECT c.id, c.email, COUNT(o.id) AS orders, COALESCE(SUM(o.total), 0) AS spent
FROM dbo.customers c LEFT JOIN dbo.orders o ON o.customer_id = c.id
GROUP BY c.id, c.email;
```

```sh
liftoff diff
```

```
changed  dbo.customers
added    dbo.customer_totals
```

```sh
liftoff generate --description "phone and totals" --undo --record-on-dev
```

writes `V0002__phone_and_totals.sql`:

```sql
ALTER TABLE [dbo].[customers] ADD [phone] nvarchar(30) NULL;
GO

CREATE VIEW dbo.customer_totals AS …
GO
```

Deploy it to test, then change your mind:

```sh
liftoff -e test migrate
liftoff -e test undo
```

```
Undoing V0002__phone_and_totals.sql with U0002__phone_and_totals.sql
Undid V0002__phone_and_totals.sql in 65 ms; it is pending again
```

Test is back at version 1, and `info` shows V0002 as pending. Run `liftoff -e test migrate` to
apply it again, then commit:

```sh
liftoff -e test migrate
git add -A
git commit -m "phone and totals"
```

> **One rule:** never edit a script after it ran on a shared environment. LiftOff keeps a
> checksum of every script it ran, and `migrate` refuses to continue if a file changed. Put the
> next change in a new script.

## Step 10: the schema model (optional)

Scripts tell how to get from one version to the next. The schema model shows what each object
looks like now, one file per object, so git has the history of every table:

```sh
liftoff model
```

```
added    tables/dbo.customers.sql
added    tables/dbo.orders.sql
added    views/dbo.customer_totals.sql
Updated 3 file(s) in schema-model
```

`schema-model/tables/dbo.customers.sql`:

```sql
CREATE TABLE [dbo].[customers] (
    [id] int IDENTITY(1,1) NOT NULL,
    [email] nvarchar(320) NOT NULL,
    [name] nvarchar(200) NOT NULL,
    [created_at] datetime2(7) NOT NULL DEFAULT (sysutcdatetime()),
    [phone] nvarchar(30) NULL
);
GO
ALTER TABLE [dbo].[customers] ADD PRIMARY KEY CLUSTERED ([id] ASC);
GO
ALTER TABLE [dbo].[customers] ADD UNIQUE NONCLUSTERED ([email] ASC);
GO
```

From now on, run `liftoff model` with every `generate`, and commit both. `liftoff check --model`
confirms the scripts make everything the model has. See [The schema model](../guide/schema-model.md).

```sh
git add -A
git commit -m "schema model"
```

## Step 11: let a pipeline deploy (optional)

If the repository is on GitHub:

```sh
liftoff ci --stage test --stage prod --write
```

writes `.github/workflows/liftoff.yml`. Its first lines say which secrets to add:

```
# Written by LiftOff. Add these repository secrets: LIFTOFF_ENV_TEST_PASSWORD, LIFTOFF_ENV_PROD_PASSWORD
```

Add those in GitHub (**Settings > Secrets and variables > Actions**). From then on:

- every pull request checks that its new scripts are numbered after everything on main;
- every merge to main that touches `migrations/` deploys to test, then to prod: each stage
  validates, checks for drift (the report is kept with the run), then migrates.

To require an approval before production, add a required reviewer to the `prod` environment
under **Settings > Environments**. The runner must be able to reach your databases; `localhost`
in the URLs will not work there, so use the servers' real names. See
[Teams, branches and pipelines](../guide/teams-and-pipelines.md).

## What you did

| step | command |
| --- | --- |
| a project | `liftoff init --engine sqlserver` |
| environments | `liftoff.toml` (shared), `liftoff.user.toml` (yours) |
| a scratch database | `liftoff create-scratch` |
| see your changes | `liftoff diff` |
| write the migration | `liftoff generate --description "…" --undo --record-on-dev` |
| deploy | `liftoff -e test migrate` |
| check before production | `liftoff -e prod check` |
| step back | `liftoff -e test undo` |
| the model | `liftoff model` |
| the pipeline | `liftoff ci --stage test --stage prod --write` |

Your daily loop is now: **change dev → `liftoff diff` → `liftoff generate` → review → commit →
deploy.**

Next: the same in the [desktop app](02-new-project-desktop.md) or [VS Code](03-new-project-vscode.md),
or what to do when the database [already exists](04-existing-database-cli.md).

## On PostgreSQL

Everything works the same way. What differs:

- `liftoff init --name shop --engine postgresql`; the schema is `public`.
- Create the databases with `createdb shop_dev` (and so on), or `CREATE DATABASE shop_dev;` in psql.
- URLs look like `postgres://localhost:5432/shop_test`, with `user = "postgres"`. Add
  `?sslmode=require` for a server that needs TLS.
- No `GO` lines: statements end with `;`. A Docker server:
  `docker run -d --name shop-pg -p 5432:5432 -e POSTGRES_PASSWORD=Shop!Pass2026 postgres:16`.
- The SQL for step 5:

  ```sql
  CREATE TABLE customers (
      id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      email text NOT NULL UNIQUE,
      name text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now()
  );
  CREATE TABLE orders (
      id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      customer_id bigint NOT NULL REFERENCES customers (id),
      total numeric(10,2) NOT NULL,
      placed_at timestamptz NOT NULL DEFAULT now()
  );
  ```
- A script with `CREATE INDEX CONCURRENTLY` runs outside a transaction automatically. See
  [Transactions](../guide/scripts.md#transactions).
