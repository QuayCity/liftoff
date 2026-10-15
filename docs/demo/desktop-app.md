# Demo: the LiftOff desktop app

A walkthrough to show LiftOff to colleagues or customers in about 30 minutes, all by clicking. It
tells one short story: a new database, a change written as a migration, deployed to test and
production, and someone changing production by hand.

Each part has what to **do**, what the audience will **see**, and what to **say**. The
[command line](cli.md) and [VS Code](vscode.md) have their own demos.

| part | minutes |
| --- | ---: |
| [1. A project](#1-a-project) | 6 |
| [2. A change becomes a migration](#2-a-change-becomes-a-migration) | 6 |
| [3. Deploy to test and production](#3-deploy-to-test-and-production) | 7 |
| [4. Someone changes production by hand](#4-someone-changes-production-by-hand) | 6 |
| [5. The next change, and undo](#5-the-next-change-and-undo) | 4 |
| [6. Wrap up](#6-wrap-up) | 1 |

## Before the demo

Do this beforehand; it takes about 10 minutes.

1. Install the desktop app (Windows or Linux, see [Installing](../guide/installing.md#the-desktop-app))
   and git.
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

4. Make an empty folder `shop-db`.
5. Arrange the screen: the app on one side, a SQL tool connected to the server on the other.
   Pick light or dark in the theme menu (top right), whichever shows best on the projector.
6. Keep this page open on a second screen to copy from.

Running it again? Drop the three databases and `shop_dev_scratch`, create the three again, and
empty the `shop-db` folder.

## 1. A project

**Say:** "LiftOff keeps a database's schema as plain SQL scripts in git, and runs them on every
environment. A project is just a folder."

**Do:** **New project…**:
- Folder: **Choose…** `shop-db`;
- Project name: `shop`;
- Database engine: **SQL Server**;
- then **Create project**.

**See:** the project opens on **Environments**, still empty.

**Do:** **Add environment**:

| field | value |
| --- | --- |
| Name | `dev` |
| Role | **Dev** |
| Server | `localhost` |
| Database | `shop_dev` |
| Trust the server certificate | **on** (the container's certificate is self-signed) |
| User, Password | `sa`, `Shop!Pass2026` |
| Save the connection for | **Just me** |

Click **Test connection**. **See:** **Connected**, with the server version. Then **Save**.

**Say:** "Dev is mine, so it is saved only for me. The password goes into Windows Credential
Manager, never into a project file."

**Do:** **Add environment** twice more, the same but:
- Name `test`, Role **Test**, Database `shop_test`;
- Name `prod`, Role **Production**, Database `shop_prod`;
- Save the connection for **Everyone on the project** for both.

**Say:** "Test and production go into `liftoff.toml`, which the team shares through git. Each
person still keeps their own password."

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

**Do:** click **Changes**. The first time it says **A scratch database is needed**: click
**Create one…**, tick **I understand LiftOff erases and rebuilds it on every comparison**, and
**Create**. Then click **Compare** (top right).

**Say:** "The scratch database is an empty database LiftOff may erase. It runs the scripts there
to know what they build, so it can compare that with dev."

**See:** `dbo.customers`, added. Click it to show it **side by side**: nothing on the left (the
scripts do not make it yet), the table on the right.

**Do,** at the bottom of the screen:
- Description: `customers`;
- tick **Also write an undo script**;
- click **Write migration…**.

**See:** **Review the migration** shows the script LiftOff wrote: `CREATE TABLE`, the primary key
and the unique constraint. Below it, **Record it as applied on dev** is ticked.

**Say:** "It is plain SQL. I review it like code, and I may edit it. The undo script reverses it.
Dev is marked as having it already, because I made the change there by hand."

**Do:** **Save to migrations**. Then the **Commit** workspace: the project files are ticked
(`liftoff.toml`, `.gitignore` and the two scripts; `liftoff.user.toml` is not listed, git ignores
it). Commit message `customers`, then **Commit 4 files**.

## 3. Deploy to test and production

**Do:** **Environments**. Each environment has a card: connected, how many scripts are pending,
when it last ran, drift. Click **test**'s card. **See:** V0001 **pending**.

**Do:** **Run pending**, below the list of scripts. **See:** the log, then V0001 **applied**, with the time.

**Say:** "Each script runs in a transaction, and the database keeps a history of what ran. Run it
again and nothing happens."

**Say:** "Before production I want to know three things, without changing anything."

**Do:** click **prod**'s card, then the **Checks** tab. Click each in turn:

| click | see | say |
| --- | --- | --- |
| **Check for drift** | **No drift** | "Nobody changed production outside the scripts." |
| **Preview pending changes** | `dbo.customers`, added | "What the deploy will change." |
| **Dry-run script** | the SQL, in a transaction, with the history row | "Exactly what will run." |

**Say:** "**Save report…** turns this into a page for a change request."

**Do:** back on the **Migrations** tab, **Run pending**. **See:** V0001 **applied** on prod.

## 4. Someone changes production by hand

**Say:** "Now the real world: during an incident, someone adds an index on production directly."

**Do,** in the SQL tool on `shop_prod`:

```sql
CREATE INDEX ix_customers_name ON dbo.customers (name);
```

**Do:** **prod** → **Checks** → **Check for drift**.

**See:** **1 object changed outside the scripts**: "Someone changed prod by hand. Turn the change
into a script, or undo it, before deploying." `dbo.customers` is listed, side by side: what the
applied scripts build on the left, prod on the right, with the extra index marked. The prod card
now says **Drift: Detected**.

**Say:** "A pipeline runs the same check and stops here, before deploying on top of an unknown
state."

**Do:** the **Compare** workspace: Source **prod (prod)**, Target **test (test)**, then **Compare**.

**See:** **1 difference: what would make test match prod**, `dbo.customers` side by side, and the
SQL: `CREATE NONCLUSTERED INDEX [ix_customers_name] …`. At the bottom: **Save script…**,
**Write migration…** and **Apply to test…**.

**Say:** "Compare works between any two databases, the scripts, the schema model or a snapshot. It
can also save a script or write a migration from what it finds. The team now decides: turn the
hotfix into a script, or remove it. Here we remove it."

**Do,** on `shop_prod`: `DROP INDEX ix_customers_name ON dbo.customers;`. Then **prod** →
**Checks** → **Check for drift**. **See:** **No drift**.

## 5. The next change, and undo

**Do,** on `shop_dev`:

```sql
ALTER TABLE dbo.customers ADD phone nvarchar(30) NULL;
```

**Do:** **Changes** → **Compare**. **See:** `dbo.customers`, changed: the new column side by side.
Description `phone`, tick **Also write an undo script**, **Write migration…**, **Save to
migrations**.

**Do:** **Environments** → **test** → **Run pending**. **See:** V0002 **applied**.

**Say:** "That is the daily loop: change dev, look at **Changes**, write the migration, review,
commit, deploy. And if a change was wrong:"

**Do:** in the list next to the **Run pending** button below the scripts, pick **Undo latest**,
then click the button (it now says **Undo latest**). **See:** the log says it ran `U0002__phone.sql`,
and V0002 is **pending** again.

## 6. Wrap up

**Say,** picking what fits the audience:
- "It does the same on **PostgreSQL**."
- "The same project works from the **command line** and in **VS Code**. Pipelines run the command line."
- "**Pipelines** writes a **GitHub Actions** workflow that checks for drift and deploys on merge."
- "For an **existing database**, **Adopt as B0001** captures it as a baseline script, and every
  environment is checked against it."
- "Coming from **Flyway**? **Open folder…** offers to convert the settings and keeps the scripts."
- "**Compare** → **Data** compares rows too, fast on tables with millions of rows."
- "It is open source (MIT), with no telemetry. Besides your databases it talks to one thing: GitHub,
  to see whether there is a newer LiftOff. **App settings** switches that off."

**Show:** [the documentation](../README.md) and its tutorials, for those who want to try it.
