# Demo: the LiftOff extension for VS Code

A walkthrough to show LiftOff to colleagues or customers in about 30 minutes, without leaving
the editor. It tells one short story: a new database, a change written as a migration, deployed
to test and production, and someone changing production by hand.

Each part has what to **do**, what the audience will **see**, and what to **say**. The
[command line](cli.md) and the [desktop app](desktop-app.md) have their own demos.

| part | minutes |
| --- | ---: |
| [1. A project](#1-a-project) | 6 |
| [2. A change becomes a migration](#2-a-change-becomes-a-migration) | 7 |
| [3. Deploy to test and production](#3-deploy-to-test-and-production) | 6 |
| [4. Someone changes production by hand](#4-someone-changes-production-by-hand) | 6 |
| [5. The next change, from the model](#5-the-next-change-from-the-model) | 4 |
| [6. Wrap up](#6-wrap-up) | 1 |

## Before the demo

Do this beforehand; it takes about 10 minutes.

1. Install the LiftOff extension ([Installing](../guide/installing.md#the-vs-code-extension)).
   The rocket appears in the activity bar.
2. Start a SQL Server in Docker:

   ```sh
   docker run -d --name shop-sql -p 1433:1433 -e ACCEPT_EULA=Y -e "MSSQL_SA_PASSWORD=Shop!Pass2026" mcr.microsoft.com/mssql/server:2022-latest
   ```

3. Create four empty databases on it (with the mssql extension, Azure Data Studio or `sqlcmd`):

   ```sql
   CREATE DATABASE shop_dev;
   CREATE DATABASE shop_scratch;
   CREATE DATABASE shop_test;
   CREATE DATABASE shop_prod;
   ```

4. Make an empty folder `shop-db`, run `git init` in it, and open it in VS Code
   (**File > Open Folder…**).
5. Have a SQL tool connected to the server, next to VS Code or in it.
6. Keep this page open on a second screen to copy from.

During the demo, let each command finish (its notification appears) before starting the next:
several of them rebuild the same scratch database.

Running it again? Drop the four databases, create them again, and empty the `shop-db` folder.

## 1. A project

**Say:** "LiftOff keeps a database's schema as plain SQL scripts in git, and runs them on every
environment. Everything happens here, next to the code."

**Do:** click the LiftOff rocket. **See:** **There is no LiftOff project in this workspace yet**.

**Do:** **Create LiftOff Project**, then **SQL Server**, **Empty project**, and the name `shop`.

**See:** `liftoff.toml`, `migrations/` and `schema-model/` in the Explorer, and the **LiftOff
Settings** tab with a first, empty environment.

**Do:** fill it in for dev, then **Save** (at the bottom):

| field | value |
| --- | --- |
| Name | `dev` |
| Connection URL | `sqlserver://localhost:1433;databaseName=shop_dev;encrypt=true;trustServerCertificate=true` |
| User, Password | `sa`, `Shop!Pass2026` |
| Role | **Dev** |
| Stored in | **liftoff.user.toml: this computer only** |

Then **Test connection** in its section. **See:** **Connected to shop_dev as sa** and the server
version.

**Say:** "Dev is mine, so it stays on this computer. The password goes into the operating
system's keychain, never into a project file."

**Do:** **Add environment** three times, the same but:
- `scratch`, database `shop_scratch`, Role **Scratch**, this computer only;
- `test`, database `shop_test`, Role **Test**, **liftoff.toml: shared with the team through git**;
- `prod`, database `shop_prod`, Role **Production**, shared.

**Save** after each one.

**Say:**
- "Test and production are in `liftoff.toml`, which the team shares through git."
- "The scratch database is an empty database LiftOff may erase. It runs the scripts there to
  know what they build."

**See:** the **Environments** view lists dev, prod, scratch and test.

## 2. A change becomes a migration

**Say:** "I change dev the way I always do, in my SQL tool."

**Do,** on `shop_dev`:

```sql
CREATE TABLE dbo.customers (
    id int IDENTITY PRIMARY KEY,
    email nvarchar(320) NOT NULL UNIQUE,
    name nvarchar(200) NOT NULL
);
```

**Do:** in the **Schema Model** view, **Compare with Dev**.

**See:** `customers`, **table · new in dev**. Click it: a diff editor, empty on the left, the
`CREATE TABLE` on the right.

**Say:** "The schema model is one file per object. It gives every table a history in git, and
every pull request shows the change to the table itself."

**Do:** the **Pull All into Schema Model** button at the top of the view (the cloud with a down arrow).
**See:** `schema-model/tables/dbo.customers.sql`, and **The schema model matches dev**.

**Do:** the view's **…** menu → **Generate Migration from Schema Model**, description
`customers`.

**See:** `migrations/V0001__customers.sql` opens:

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

**Say:** "LiftOff wrote the script from the model. It is plain SQL: I review it like code, and I
may edit it."

**Do:** commit the model file and the script in **Source Control**, message `customers`.

## 3. Deploy to test and production

**Do:** in the **Environments** view, expand **test**. **See:** `V0001__customers.sql`,
**pending**.

**Do:** right-click **test** → **Show the SQL That Would Run**. **See:** the script in a
transaction, with the history row, in a new editor tab.

**Do:** right-click **test** → **Run Pending Migrations** (or the ▷ button on the row). **See:**
**Applied 1 migration to test**.

**Say:** "Each script runs in a transaction, and the database keeps a history of what ran."

**Do:** right-click **prod** → **Check for Drift**. **See:** **No drift on prod: it matches its
applied scripts**.

**Do:** right-click **prod** → **Run Pending Migrations**. **See:** **Run the pending migrations on
prod? This is a production database.** Click **Run**.

**Say:** "Production always asks first."

## 4. Someone changes production by hand

**Say:** "Now the real world: during an incident, someone adds an index on production directly."

**Do,** on `shop_prod`:

```sql
CREATE INDEX ix_customers_name ON dbo.customers (name);
```

**Do:** right-click **prod** → **Check for Drift**.

**See:** **1 object on prod differs from its scripts**, with **Show the SQL**.

**Say:** "A pipeline runs the same check and stops here, before deploying on top of an unknown
state."

**Do:** open the **Compare** view (bottom of the LiftOff sidebar) → **Compare…** → source **prod**, target **test**.

**See:** **test → prod: 1 difference(s)**: `dbo.customers`, **tables · different**. Click it: the diff shows the extra
index.

**Say:** "Compare works between any two: environments, the schema model, what the migrations
build, a snapshot, any database by URL. From here I can open the sync script, write it as a
migration, or apply it. The team now decides: turn the hotfix into a script, or remove it. Here
we remove it."

**Do,** on `shop_prod`: `DROP INDEX ix_customers_name ON dbo.customers;`, then right-click
**prod** → **Check for Drift**. **See:** **No drift on prod**.

## 5. The next change, from the model

**Say:** "Changes can also start in the model file itself."

**Do:** open `schema-model/tables/dbo.customers.sql` and add a column inside the `CREATE TABLE`
(with a comma after the line before it):

```sql
    [phone] nvarchar(30) NULL
```

Save. **Do:** **Check Schema Model** (the double tick at the top of the Schema Model view). **See:**
**The schema model builds: 1 object file(s).** **Say:** "It
builds the whole folder on the scratch database; a typo would show in the Problems panel, on the
file that caused it."

**Do:** **Generate Migration from Schema Model**, description `phone`. **See:**
`V0002__phone.sql` with `ALTER TABLE [dbo].[customers] ADD [phone] nvarchar(30) NULL;`.

**Do:** right-click **test** → **Run Pending Migrations**.

**Say:** "That is the daily loop: change dev or the model, generate the migration, review,
commit, deploy."

## 6. Wrap up

**Say,** picking what fits the audience:
- "It does the same on **PostgreSQL**."
- "The same project works from the **command line** and in the **desktop app**. Pipelines run
  the command line; **LiftOff: Set Up Pipeline** writes a GitHub Actions workflow."
- "For an **existing database**, **Run Pending Migrations** offers to adopt it as a baseline
  script, and every environment is checked against it."
- "Coming from **Flyway**? **Import Flyway Project** converts the settings and keeps the scripts."
- "**Compare Data…** compares rows too, fast on tables with millions of rows."
- "**Show Log** shows every `liftoff` command the extension ran."
- "It is open source (MIT) and talks to nothing but your databases: no telemetry, no update checks."

**Show:** [the documentation](../README.md) and its tutorials, for those who want to try it.
