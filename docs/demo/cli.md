# Demo: LiftOff on the command line

A walkthrough to show LiftOff to colleagues or customers in about 30 minutes. It tells one short
story: a new database, a change written as a migration, deployed to test and production, and
someone changing production by hand.

Each part has what to **do** (copy the commands), what the audience will **see**, and what to
**say**. The [desktop app](desktop-app.md) and [VS Code](vscode.md) have their own demos.

| part | minutes |
| --- | ---: |
| [1. A project](#1-a-project) | 5 |
| [2. A change becomes a migration](#2-a-change-becomes-a-migration) | 6 |
| [3. Deploy to test and production](#3-deploy-to-test-and-production) | 7 |
| [4. Someone changes production by hand](#4-someone-changes-production-by-hand) | 6 |
| [5. The next change, and undo](#5-the-next-change-and-undo) | 4 |
| [6. Wrap up](#6-wrap-up) | 2 |

## Before the demo

Do this beforehand; it takes about 10 minutes.

1. Install `liftoff` ([Installing](../guide/installing.md)) and check `liftoff --version`.
2. Start a SQL Server in Docker:

   ```sh
   docker run -d --name shop-sql -p 1433:1433 -e ACCEPT_EULA=Y -e "MSSQL_SA_PASSWORD=Shop!Pass2026" mcr.microsoft.com/mssql/server:2022-latest
   ```

3. Create three empty databases on it (in SSMS, Azure Data Studio or `sqlcmd`):

   ```sql
   CREATE DATABASE shop_dev;
   CREATE DATABASE shop_test;
   CREATE DATABASE shop_prod;
   ```

4. Open a terminal with a large font, and a SQL tool connected to the server next to it. Set the
   password once in the terminal:

   ```powershell
   $env:SHOP_PASSWORD = 'Shop!Pass2026'      # PowerShell
   ```

   ```sh
   export SHOP_PASSWORD='Shop!Pass2026'      # bash
   ```

5. Keep this page open on a second screen to copy from.

Running it again? Drop the three databases and `shop_dev_scratch`, create the three again, and
delete the `shop-db` folder.

## 1. A project

**Say:** "LiftOff keeps a database's schema as plain SQL scripts in git, and runs them on every
environment. A project is just a folder."

**Do:**

```sh
mkdir shop-db
cd shop-db
git init
liftoff init --name shop --engine sqlserver
```

**See:** `Created liftoff.toml in …\shop-db`, and a `migrations` folder.

**Do:** add test and production at the end of `liftoff.toml`:

```toml
[environments.test]
url = "sqlserver://localhost:1433;databaseName=shop_test;encrypt=true;trustServerCertificate=true"
user = "sa"
password = "${env.SHOP_PASSWORD}"
role = "test"

[environments.prod]
url = "sqlserver://localhost:1433;databaseName=shop_prod;encrypt=true;trustServerCertificate=true"
user = "sa"
password = "${env.SHOP_PASSWORD}"
role = "prod"
```

and create `liftoff.user.toml` for dev:

```toml
[environments.dev]
url = "sqlserver://localhost:1433;databaseName=shop_dev;encrypt=true;trustServerCertificate=true"
user = "sa"
password = "${env.SHOP_PASSWORD}"
role = "dev"
```

**Say:** "Test and production are shared through git. My dev database is mine, so it is in a file
git ignores. No password is in any file: it comes from an environment variable or the keychain."

**Do:**

```sh
liftoff project
liftoff create-scratch
```

**See:**

```
shop (sqlserver, scripts in migrations)
dev              dev      SQL Server
prod             prod     SQL Server
test             test     SQL Server

Created database shop_dev_scratch and saved it as environment 'scratch' (role scratch, private)
```

**Say:** "The scratch database is an empty database LiftOff may erase. It runs the scripts there
to know what they build, so it can compare that with dev."

## 2. A change becomes a migration

**Say:** "I change dev the way I always do, in my SQL tool. No special tooling."

**Do,** in the SQL tool on `shop_dev`:

```sql
CREATE TABLE dbo.customers (
    id int IDENTITY PRIMARY KEY,
    email nvarchar(320) NOT NULL UNIQUE,
    name nvarchar(200) NOT NULL
);
```

Then in the terminal:

```sh
liftoff diff
```

**See:**

```
1 difference(s)
added    dbo.customers
```

**Do:**

```sh
liftoff generate --description "customers" --undo --record-on-dev
```

**See:** `Wrote …\migrations\V0001__customers.sql`. Open the file:

```sql
-- customers
-- Written by LiftOff. Review before committing.
--
--   Add table dbo.customers
GO

CREATE TABLE [dbo].[customers] (
    [id] int IDENTITY(1,1) NOT NULL,
    [email] nvarchar(320) NOT NULL,
    [name] nvarchar(200) NOT NULL
);
GO

ALTER TABLE [dbo].[customers] ADD PRIMARY KEY CLUSTERED ([id] ASC);
GO
ALTER TABLE [dbo].[customers] ADD UNIQUE NONCLUSTERED ([email] ASC);
GO
```

**Say:**
- "LiftOff wrote the script from what I changed. It is plain SQL: I review it like code, and I
  may edit it."
- "`--undo` also wrote `U0001`, which reverses it. `--record-on-dev` tells dev it already has this
  change, because I made it there by hand."

**Do:** `git add -A` and `git commit -m "customers"`.

## 3. Deploy to test and production

**Do:**

```sh
liftoff -e test info
liftoff -e test migrate
```

**See:**

```
Version          Description                      State           Ran on                   Took
0001             customers                        pending

Running V0001__customers.sql
Applied V0001__customers.sql in 20 ms
Applied 1 migration(s) to test in 196 ms
```

**Say:** "Each script runs in a transaction, and the database keeps a history table of what ran.
Run `migrate` again and nothing happens."

**Say:** "Before production I want to know three things, without changing anything."

**Do:**

```sh
liftoff -e prod check
```

**See:**

```
Drift: none
Pending changes: 1
  added    dbo.customers
Dry run:
-- Dry run for prod: nothing below has been executed.
…
BEGIN TRANSACTION;
…
COMMIT;
```

**Say:**
1. "**Drift: none**: nobody changed production outside the scripts."
2. "**Pending changes**: what the deploy will change."
3. "**Dry run**: the exact SQL it will run."
4. "`--report check.html` saves this as a page for a change request."

**Do:**

```sh
liftoff -e prod migrate
liftoff -e prod info
```

**See:** `0001  customers  applied  2026-…`

## 4. Someone changes production by hand

**Say:** "Now the real world: during an incident, someone adds an index on production directly."

**Do,** in the SQL tool on `shop_prod`:

```sql
CREATE INDEX ix_customers_name ON dbo.customers (name);
```

Then:

```sh
liftoff -e prod check
```

**See:**

```
Drift: 1
  changed  dbo.customers
Pending changes: none
…
error: drift found on 'prod': it has changes the migration scripts did not make
```

**Say:** "LiftOff noticed production no longer matches its scripts. It exits with code 13, so a
pipeline stops before deploying on top of an unknown state."

**Do:**

```sh
liftoff compare --source prod --target test
```

**See:**

```
test -> prod (SQL Server): 1 difference(s)
  changed  table:dbo.customers
```

**Say:** "Compare works between any two databases, or a database and the scripts. The team now
decides: turn the hotfix into a script, or remove it. Here we remove it."

**Do,** on `shop_prod`: `DROP INDEX ix_customers_name ON dbo.customers;`, then
`liftoff -e prod check` again. **See:** `Drift: none`.

## 5. The next change, and undo

**Do,** on `shop_dev`:

```sql
ALTER TABLE dbo.customers ADD phone nvarchar(30) NULL;
```

```sh
liftoff diff
liftoff generate --description "phone" --undo --record-on-dev
liftoff -e test migrate
```

**See:** `changed  dbo.customers`, then `Applied V0002__phone.sql`.

**Say:** "That is the daily loop: change dev, `diff`, `generate`, review, commit, deploy. And if
a change was wrong:"

**Do:**

```sh
liftoff -e test undo
liftoff -e test info
```

**See:**

```
Undid V0002__phone.sql in 60 ms; it is pending again

0001             customers                        applied         2026-…
0002             phone                            pending
```

## 6. Wrap up

**Say,** picking what fits the audience:
- "It does the same on **PostgreSQL**."
- "There is a **desktop app** and a **VS Code extension**. All three use the same project folder."
- "`liftoff ci --stage test --stage prod --write` writes a **GitHub Actions** pipeline. It checks
  numbering on pull requests and deploys on merge, with the drift check in front."
- "For an **existing database**, `liftoff adopt` captures it as a baseline script, and every
  environment is checked against it."
- "Coming from **Flyway**? LiftOff converts the settings and keeps the scripts."
- "Compare also does **data**, fast on tables with millions of rows."
- "It is open source (MIT) and talks to nothing but your databases: no telemetry, no update checks."

**Show:** [the documentation](../README.md) and its tutorials, for those who want to try it.
