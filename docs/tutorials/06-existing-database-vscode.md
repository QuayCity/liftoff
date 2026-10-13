# Tutorial 6: an existing database, in VS Code

The same journey as [tutorial 4](04-existing-database-cli.md), in the editor. Your **shop**
database has been in production for years without a migration tool, and its copies have drifted.
You will capture production into a baseline script, bring every environment under LiftOff, fill
the schema model, and make the first new change.

Your data is never touched: adopting only reads production's schema and adds a history table.

It takes about 30 minutes. [Tutorial 4](04-existing-database-cli.md) explains what happens behind
each step in more detail.

## Before you start

- **The LiftOff extension is installed** ([Installing](../guide/installing.md#the-vs-code-extension)).
- **The databases.** Use your own, or follow [step 0 of tutorial 4](04-existing-database-cli.md#step-0-the-existing-databases-only-to-follow-along)
  to make `shop_prod` (the truth, with rows), `shop_test` (missing a view and a procedure),
  `shop_acc` (an extra column) and an empty `shop_dev`. Also create an empty `shop_scratch`.
- **An empty folder**, made a git repository (`git init`), opened in VS Code.

## Step 1: create the project and the environments

LiftOff rocket → **Create LiftOff Project** → **SQL Server** → **Empty project** → name `shop`.

The settings tab opens with a first, empty environment: fill it in for `dev`, then **Add
environment** for each of the others (user and password as for your server;
`trustServerCertificate=true` only for a local container):

| Name | Connection URL | Role | Stored in |
| --- | --- | --- | --- |
| `dev` | `sqlserver://localhost:1433;databaseName=shop_dev;encrypt=true;trustServerCertificate=true` | Dev | this computer only |
| `scratch` | `…databaseName=shop_scratch…` | Scratch | this computer only |
| `test` | `…databaseName=shop_test…` | Test | shared with the team through git |
| `acceptance` | `…databaseName=shop_acc…` | Test | shared with the team through git |
| `prod` | `…databaseName=shop_prod…` | Production | shared with the team through git |

**Save** after each one, then **Test connection** in its section (it tests saved environments
only). The login used on production needs to read the
schema and create one table (the history table); to deploy later, it needs to change the schema.

> Faster: open `liftoff.toml` and paste the `[environments.…]` sections from
> [tutorial 4, step 2](04-existing-database-cli.md#step-2-add-the-environments). The view reloads
> when you save.

## Step 2: adopt production

In the **Environments** view, right-click **prod** → **Run Pending Migrations**. Production has
tables, the project has no scripts, and LiftOff will not run scripts on a database it knows
nothing about. First it asks to confirm, because prod is production: **Run**. Then it says
**prod already has tables, and this project has no scripts yet.** and offers **Adopt as B0001**.
Click it (or run **LiftOff: Adopt Existing Database…** from the command palette and pick prod).
When it is done: **Captured prod as B0001__existing_schema.sql and recorded it there. New scripts
start at V0002.**

LiftOff then:

1. writes every object production has into `migrations/B0001__existing_schema.sql`;
2. builds that script on the scratch database and checks it matches production exactly (if not,
   nothing is kept and the differences are listed);
3. records production as being at B0001, without running anything there.

`B0001__existing_schema.sql` appears under every environment. Open it from the view and read it:
the tables with their keys, checks, defaults and indexes, then the function, the view, the
procedure and the trigger, in an order that runs. Commit it from Source Control:
`B0001: the existing shop schema`.

## Step 3: the other environments

Right-click **test** → **Run Pending Migrations**. Test lacks the view and the procedure: they are
created, then B0001 is recorded. **Show Log** shows which objects it created.

Right-click **acceptance** → **Run Pending Migrations**. Acceptance has an extra column. It stops:
**acceptance differs from the baseline script. Nothing was changed.**, with
`table:dbo.customers: different`, and offers **Record Anyway**. Click **Cancel** for now.

Before deciding, look: **LiftOff: Compare…** → source **What the migrations build**, target
**acceptance**. The **Compare** view opens with **acceptance → the migrations: 1 difference**:
`dbo.customers`, **different · may lose data**, so it starts unticked. Click it: the diff shows
the extra `loyalty_points` column. Then:

- **Production is right**: tick `dbo.customers`, then **Apply to the Target** (in the Compare
  view's **…** menu) drops the column on acceptance (and its data).
  Run Pending Migrations again: B0001 is recorded cleanly.
- **The column should exist everywhere**: record anyway, then add it in dev and write a
  migration (step 5).
- **Not decided yet**: **Record Anyway**. **Check for Drift** on acceptance keeps saying **1
  object on acceptance differs from its scripts** until it is fixed.

## Step 4: dev and the schema model

Right-click **dev** → **Run Pending Migrations**. Dev is empty, so it is built from B0001:
production's schema without its data.

**Schema Model** view → **Compare with Dev**: every object is listed, since the folder is empty.
**Pull All into Schema Model**. `schema-model/` now has `tables/`, `views/`, `functions/`,
`procedures/` and `triggers/`, one file per object, named like `dbo.orders.sql`. Commit: `schema model`.

## Step 5: the first change under LiftOff

Open `schema-model/tables/dbo.products.sql` and add a column inside the `CREATE TABLE`:

```sql
    [weight_kg] decimal(6,2) NULL
```

(with a comma after the line before it). **Check Schema Model** confirms the folder still builds.
**Generate Migration from Schema Model**, description `product weight`:
`V0002__product_weight.sql`, the first script after the baseline. Commit both files.

Deploy: test → **Run Pending Migrations**; prod → **Check for Drift**, **Show the SQL That Would
Run**, then **Run Pending Migrations** and **Run** to confirm.

Bring dev along too: it does not have the column yet (you changed the model, not dev). Run
`ALTER TABLE dbo.products ADD weight_kg decimal(6,2) NULL;` on dev, then **Compare with Dev**
should list nothing.

## What you did

| step | where |
| --- | --- |
| capture production and record it | prod → **Run Pending Migrations** → **Adopt Existing Database…** |
| bring each environment under LiftOff | the environment → **Run Pending Migrations** (checked against B0001) |
| see what differs | **LiftOff: Compare…**, **Check for Drift** |
| a dev database | dev (empty) → **Run Pending Migrations** |
| the schema model | Schema Model → **Pull All into Schema Model** |
| the first change | edit the model → **Generate Migration from Schema Model** |

The project works the same from the command line (`liftoff -e prod info`) and the desktop app.
