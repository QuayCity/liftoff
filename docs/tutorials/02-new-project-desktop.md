# Tutorial 2: a new project, in the desktop app

The same journey as [tutorial 1](01-new-project-cli.md), with clicks instead of commands. You
start a new application, **shop**, whose database does not exist yet. By the end you will have a
project in git with migration scripts written from your changes in dev, deployed to test and
production.

It takes about 30 minutes. The examples use SQL Server; for PostgreSQL pick **PostgreSQL** in
step 2 and the connection dialog asks for what PostgreSQL needs instead.

## Before you start

- **The desktop app is installed** (Windows or Linux): see [Installing](../guide/installing.md#the-desktop-app).
  On a Mac, follow [tutorial 1](01-new-project-cli.md) or [tutorial 3](03-new-project-vscode.md) instead.
- **git** is installed (the Commit screen uses it).
- **A SQL Server you can create databases on**, and a tool to run SQL on it. No server?
  `docker run -d --name shop-sql -p 1433:1433 -e ACCEPT_EULA=Y -e "MSSQL_SA_PASSWORD=Shop!Pass2026" mcr.microsoft.com/mssql/server:2022-latest`
- **An empty folder for the project**, made a git repository: `mkdir shop-db`, `cd shop-db`,
  `git init`.

Create three databases on the server:

```sql
CREATE DATABASE shop_dev;    -- you change this one by hand
CREATE DATABASE shop_test;
CREATE DATABASE shop_prod;
```

## Step 1: start the app

The start page has **New project…**, **Open folder…**, **Create sample…** and the projects you
opened before under **Recent**.

## Step 2: create the project

**New project…**:

| field | value |
| --- | --- |
| Folder | **Choose…** your `shop-db` folder |
| Project name | `shop` |
| Database engine | **SQL Server** |

**Create project**. The project opens on **Environments**, which is empty, with **Add
environment**. In the folder the app wrote `liftoff.toml`, `migrations/`, `schema-model/` and a
`.gitignore`.

## Step 3: add the dev database

**Add environment**:

| field | value |
| --- | --- |
| Name | `dev` |
| Role | **Dev** |
| Server | `localhost` (or your server's name) |
| Port | empty for 1433, or the port |
| Instance | empty, unless you use a named instance |
| Database | `shop_dev` |
| Encrypt the connection | on |
| Trust the server certificate | **on** for a local container (its certificate is self-signed); off for a real server |
| Sign in with | **SQL Server login** |
| User, Password | `sa`, `Shop!Pass2026` |
| Save the connection for | **Just me** |

Below the fields you see the connection URL they make; you never have to type one.

**Test connection** shows **Connected**, with the server version, user and database. **Save**.

Where it went: dev is in `liftoff.user.toml`, which git ignores, because your dev database is
yours alone. The password is in your operating system's keychain (Windows Credential Manager,
the Secret Service on Linux), not in any file.

> Azure SQL? Pick one of the **Microsoft Entra ID** choices under **Sign in with**: the account
> you are signed in with (`az login`), a browser sign-in with MFA, a service principal or a
> managed identity. Each shows when to use it. See
> [Connections](../guide/configuration.md#sql-server-with-microsoft-entra-id-azure-sql).

## Step 4: add test and production

**Add environment** twice more, with the same server details:

| | test | prod |
| --- | --- | --- |
| Name | `test` | `prod` |
| Role | **Test** | **Production** |
| Database | `shop_test` | `shop_prod` |
| Save the connection for | **Everyone on the project** | **Everyone on the project** |

**Everyone on the project** saves the URL and user in `liftoff.toml`, which goes into git, so the
team shares them. The password still stays on your computer.

Instead of the password itself, you can type `${env.SHOP_TEST_PASSWORD}`: the app then reads the
environment variable `SHOP_TEST_PASSWORD`, and keeps the reference as typed. Useful when everyone
(and the pipeline) gets the password their own way.

## Step 5: a scratch database

Click **Changes**. It says **A scratch database is needed**: to know what the migration scripts
build, LiftOff runs them on an empty database it may erase at will. **Create one…** and confirm.
It creates `shop_dev_scratch` next to dev and saves it as environment `scratch`.

## Step 6: make the first change in dev

In your SQL tool, on `shop_dev`:

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

Back in the app, **Changes** compares dev with **Migration scripts** (the toggle at the top). It
lists `dbo.customers` and `dbo.orders` as added. Click `dbo.orders`: **side by side**, nothing on
the left (the scripts do not make it yet), the `CREATE TABLE` on the right.

## Step 7: write the migration

Leave both ticked and click **Write migration…**:

| field | value |
| --- | --- |
| Description | `customers and orders` |
| Also write an undo script | ticked |
| Record it as applied on dev, which already has these changes | ticked (the default) |

**Review the migration** shows the script and the undo script. Read them as you would read code,
then **Save to migrations**. The folder now has `V0001__customers_and_orders.sql` and
`U0001__customers_and_orders.sql`.

## Step 8: commit

**Commit** lists the new files. Message `customers and orders`, then **Commit**. With a remote
set up, **Push** sends it.

## Step 9: deploy to test

**Environments** → **test**. The **Migrations** tab shows V0001 as **pending**. Click
**Run pending**. The log shows it running; V0001 becomes **applied**, with the time.

Dev shows V0001 as applied too: it was recorded there in step 7, not run.

## Step 10: check, then deploy to production

**Environments** → **prod** → the **Checks** tab:

- **Check for drift**: **No drift**. Nobody changed production outside the scripts.
- **Preview pending changes**: the two tables, as added.
- **Dry-run script**: the exact SQL that would run, including the history row, in a transaction.
- **Save report…**: the same as an HTML page, to attach to a change request.

Back on the **Migrations** tab, **Run pending**. Production is at V0001.

> **Run pending** does not ask again, even on production: the Checks tab is your review.

## Step 11: the next change

On `shop_dev`:

```sql
ALTER TABLE dbo.customers ADD phone nvarchar(30) NULL;
GO
CREATE PROCEDURE dbo.customer_count AS SELECT COUNT(*) FROM dbo.customers;
```

**Changes** lists `dbo.customers` changed and `dbo.customer_count` added. Untick the procedure:
only the column goes into this migration. **Write migration…**, description `phone`, **Save to
migrations**: `V0002__phone.sql`. Click **Changes** again: the procedure is still listed, waiting
for its own migration.

Try a change that loses data: `DROP TABLE dbo.orders;` on dev, then **Changes**. `dbo.orders` is
listed as removed and marked as possibly losing data, and **Write migration…** warns **This
migration may lose data**. Cancel, and put the table back by running the `CREATE TABLE dbo.orders`
from step 6 on dev.

## Step 12: run one script, undo one

**Environments** → **test**. Next to V0002, **Run only this** explains which older scripts would
stay behind (none here), then **Run this script only**.

Changed your mind? **Undo latest** runs `U0002` if you wrote one (tick **Also write an undo
script**), and V0002 is pending again. Without an undo script it says so.

## Step 13: the schema model (optional)

**Changes** → toggle **Schema model**. It compares dev with the `schema-model/` folder, one file
per object. Tick everything, **Save to model**. Commit. From then on, **Object history…** on an
object shows every commit that changed it. See [The schema model](../guide/schema-model.md).

## Step 14: a pipeline (optional)

**Pipelines** → GitHub Actions. **Deploy to, in this order**: test, then prod. Branch that
deploys: `main`. The **Workflow preview** shows the file, and **Repository secrets to add** lists
the secrets to create in GitHub. **Write .github/workflows/liftoff.yml**, then commit and push.
See [Teams, branches and pipelines](../guide/teams-and-pipelines.md#pipelines).

## What you did

| step | where |
| --- | --- |
| a project | start page → **New project…** |
| environments | **Environments** → **Add environment** |
| a scratch database | **Changes** → **Create one…** |
| see your changes | **Changes** |
| write the migration | **Write migration…** |
| deploy | an environment → **Run pending** |
| check before production | an environment → **Checks** |
| commit | **Commit** |

The project is the same one the command line and VS Code use: `liftoff -e test info` in the
folder shows what you see on the Environments screen.

Next: [an existing database in the desktop app](05-existing-database-desktop.md).
