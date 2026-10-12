# Tutorial 5: an existing database, in the desktop app

The same journey as [tutorial 4](04-existing-database-cli.md), with clicks. Your **shop**
database has been in production for years without a migration tool, and the test and acceptance
copies have drifted. You will capture production into a baseline script, bring every environment
under LiftOff, and make the first new change.

Your data is never touched: adopting only reads production's schema and adds a history table.

It takes about 30 minutes. Read [tutorial 4](04-existing-database-cli.md)'s step 4 for what
happens behind each button; this page shows where the buttons are.

## Before you start

- **The desktop app is installed** (Windows or Linux; on a Mac, use [tutorial 4](04-existing-database-cli.md) or [6](06-existing-database-vscode.md)) ([Installing](../guide/installing.md#the-desktop-app)), and **git** is
  installed.
- **The databases.** Use your own, or follow [step 0 of tutorial 4](04-existing-database-cli.md#step-0-the-existing-databases-only-to-follow-along)
  to make `shop_prod` (the truth, with rows), `shop_test` (missing a view and a procedure),
  `shop_acc` (an extra column) and an empty `shop_dev`.
- **An empty folder** for the project, made a git repository (`git init`).

## Step 1: create the project

Start page → **New project…** → your folder, name `shop`, **SQL Server** → **Create project**.
The project opens on **Environments**, empty.

## Step 2: add the environments

**Add environment** for each. The server details are the same for all four (Server, Port,
**Encrypt the connection** on, **Trust the server certificate** on for a local container, user and
password); what changes:

| Name | Role | Database | Save the connection for |
| --- | --- | --- | --- |
| `dev` | **Dev** | `shop_dev` | **Just me** |
| `test` | **Test** | `shop_test` | **Everyone on the project** |
| `acceptance` | **Test** | `shop_acc` | **Everyone on the project** |
| `prod` | **Production** | `shop_prod` | **Everyone on the project** |

**Test connection** on each before **Save**. The login used on production needs to read the
schema and create one table, the history table; to deploy later, it needs to change the schema.

Then a scratch database: click **Changes** → **Create one…**, tick **I understand LiftOff erases and rebuilds it on every comparison**, and **Create**. It creates an empty
`shop_dev_scratch` that LiftOff may erase at will; it checks the capture there.

> You can also paste environments into `liftoff.toml` with a text editor: the app reads the file
> again as soon as its window gets focus.

## Step 3: adopt production

**Environments** → **prod**. Because production has tables and the project has no scripts, the
app asks **Starting from an existing database?** and offers **Adopt as B0001**. (It is also in the
environment's command list: **Adopt as B0001 (capture this database)**.)

Click it. The app:

1. writes every object production has into `migrations/B0001__existing_schema.sql`;
2. builds that script on the scratch database and checks the result matches production exactly
   (if not, nothing is kept and the differences are listed);
3. records production as being at B0001, without running anything there.

Production now shows `0001 existing schema` as its baseline. Open the script from **Scripts** and
read it: every table with its keys, checks, defaults and indexes, then the function, the view, the
procedure and the trigger, in an order that runs.

**Commit**: message `B0001: the existing shop schema` → **Commit**.

## Step 4: the other environments

Each environment with objects is checked against B0001 the first time it runs.

**test** → **Run pending**. Test lacks the view and the procedure: they are created, then B0001
is recorded. The log says which objects it created.

**acceptance** → **Run pending**. Acceptance has an extra column. A dialog lists the objects that
differ (`table:dbo.customers`) with **Cancel** and **Record anyway**. Nothing has changed yet.

Decide:

- **Production is right**: **Cancel**. Then **Compare** → **Schema**, Source **What the migrations build**,
  Target **acceptance**: it shows `dbo.customers` changed, may lose data. Click it to see the
  column side by side. **Apply** drops the column (and its data) on acceptance; then **Run
  pending** again records B0001 cleanly.
- **The column should exist everywhere**: **Record anyway** now, then add the column in dev and
  write a migration (step 6), so every environment gets it.
- **Not decided yet**: **Record anyway**. B0001 is recorded and the difference stays. On the
  **Checks** tab, **Check for drift** shows `dbo.customers` until it is fixed.

## Step 5: dev and the schema model

**dev** → **Run pending**. Dev is empty, so it is built from B0001: production's schema without
its data.

**Changes** → toggle **Schema model**. Every object is listed, since the folder is empty. Tick
them all → **Save to model**. `schema-model/` now has one file per object. **Commit**: `schema
model`.

## Step 6: the first change under LiftOff

On `shop_dev`, in your SQL tool:

```sql
ALTER TABLE dbo.products ADD weight_kg decimal(6,2) NULL;
```

**Changes** (toggle **Migration scripts**) lists `dbo.products` changed. **Write migration…**,
description `product weight`, **Also write an undo script**, **Save to migrations**:
`V0002__product_weight.sql`, the first script after the baseline. Toggle **Schema model** and
**Save to model** to update `products.sql`. **Commit**.

Deploy: **test** → **Run pending**; **prod** → **Checks** (drift, preview, dry run) → **Migrations**
→ **Run pending**.

## What you did

| step | where |
| --- | --- |
| capture production and record it | prod → **Adopt as B0001** |
| bring each environment under LiftOff | the environment → **Run pending** (checked against B0001) |
| see what differs, decide | the differences dialog; **Compare** → **Schema** |
| a dev database | dev (empty) → **Run pending** |
| the schema model | **Changes** → **Schema model** → **Save to model** |
| the first change | **Changes** → **Write migration…** |

## Another way: a baseline without a script

If a database already matches your scripts up to some version (it was kept up to date some other
way), select it → **Baseline…** → the version and a description → **Set baseline**. The scripts
up to that version never run there. See
[Existing databases](../guide/existing-databases.md#doing-it-by-hand).
