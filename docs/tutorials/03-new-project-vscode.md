# Tutorial 3: a new project, in VS Code

The same journey as [tutorial 1](01-new-project-cli.md), without leaving the editor. You start a
new application, **shop**, whose database does not exist yet. This tutorial works through the
**schema model**: you change dev, pull the change into one file per object, and generate the
migration from those files, so every pull request shows the change to each table as well as the
script.

It takes about 30 minutes. The examples use SQL Server; for PostgreSQL pick **PostgreSQL** in
step 1 and use `postgres://` URLs.

## Before you start

- **The LiftOff extension is installed**: the rocket is in the activity bar. See
  [Installing](../guide/installing.md#the-vs-code-extension).
- **A SQL Server you can create databases on**, and a way to run SQL on it (the mssql extension
  for VS Code works well). No server?
  `docker run -d --name shop-sql -p 1433:1433 -e ACCEPT_EULA=Y -e "MSSQL_SA_PASSWORD=Shop!Pass2026" mcr.microsoft.com/mssql/server:2022-latest`
- **An empty folder**, made a git repository (`git init`), opened in VS Code (**File > Open
  Folder…**).

Create four databases:

```sql
CREATE DATABASE shop_dev;
CREATE DATABASE shop_scratch;   -- empty; LiftOff erases and rebuilds it to compare
CREATE DATABASE shop_test;
CREATE DATABASE shop_prod;
```

## Step 1: create the project

Click the LiftOff rocket. The sidebar says **There is no LiftOff project in this workspace yet**.
Click **Create LiftOff Project**, then:

1. **SQL Server**;
2. **Empty project** (the other choice, **Sample shop project**, gives you a few ready-made
   scripts to explore);
3. the name: `shop`.

`liftoff.toml`, `migrations/` and `schema-model/` appear in the Explorer, and the project
settings open in an editor tab.

## Step 2: add the environments

The settings tab opens with a first, empty environment ready to fill in. Fill it in for `dev`,
then click **Add environment** for each of the others:

| Name | Connection URL | Role | Stored in |
| --- | --- | --- | --- |
| `dev` | `sqlserver://localhost:1433;databaseName=shop_dev;encrypt=true;trustServerCertificate=true` | Dev | liftoff.user.toml: this computer only |
| `scratch` | `sqlserver://localhost:1433;databaseName=shop_scratch;encrypt=true;trustServerCertificate=true` | Scratch | liftoff.user.toml: this computer only |
| `test` | `…databaseName=shop_test…` | Test | liftoff.toml: shared with the team through git |
| `prod` | `…databaseName=shop_prod…` | Production | liftoff.toml: shared with the team through git |

User `sa` and password `Shop!Pass2026` for each. `trustServerCertificate=true` accepts a local
container's self-signed certificate; leave it out for a real server. Click **Save** (at the bottom) after
each one, then **Test connection** in its section: the bottom line says **Connected to shop_dev as
sa** and the server version. (Test connection works on saved environments only.)

The passwords go to your operating system's keychain, never into the files. To share how to get a
password without sharing the password, type `${env.SHOP_TEST_PASSWORD}` instead: the extension
keeps the reference and reads the variable when it connects. (Start VS Code from a terminal where
the variable is set, so it can see it.)

The **Environments** view now lists the four environments, each with no scripts yet.

## Step 3: make the first change in dev

Run this on `shop_dev`:

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

## Step 4: pull it into the schema model

In the **Schema Model** view, **Compare with Dev**. It lists `dbo.customers` and `dbo.orders`:
dev has them, the model files do not. Click one (**Show the Difference**) for a diff editor: an
empty file on the left, the `CREATE TABLE` on the right.

**Pull All into Schema Model**. The files appear: `schema-model/tables/dbo.customers.sql` and
`orders.sql`. Source Control shows them as new.

## Step 5: generate the migration

Turn on the setting `liftoff.generateUndo` (**File > Preferences > Settings**, search for
"liftoff") if you want an undo script with each migration.

**Generate Migration from Schema Model** (in the Schema Model view's menu), description
`customers and orders`. `migrations/V0001__customers_and_orders.sql` opens: it creates both
tables, their keys and the foreign key, separated by `GO`. Review it.

Commit the model files and the script together in **Source Control**: message `customers and
orders`.

## Step 6: deploy to test

In the **Environments** view, expand an environment: V0001 is listed, **pending**. Under dev too: the
script was generated from the model, so dev's history does not know dev has the tables. You never
deploy to dev here, so that is fine.

Right-click **test**:

- **Show the SQL That Would Run**: the exact SQL in an editor, history insert included.
- **Run Pending Migrations**: V0001 runs on test, and its state turns to applied.

## Step 7: production, carefully

Right-click **prod** → **Check for Drift**: **No drift on prod: it matches its applied scripts**.
Nobody changed it by hand. **Show the SQL That Would Run** to review. Then **Run Pending
Migrations**: because prod has the Production role, it asks first (**Run the pending migrations
on prod? This is a production database.**). Click **Run**.

## Step 8: the next change, from the model

This time, change the model file itself. Open `schema-model/tables/dbo.customers.sql` and add a
column inside the `CREATE TABLE`:

```sql
    [phone] nvarchar(30) NULL
```

(put a comma after the line before it). Save. **Check Schema Model** builds the whole folder on
the scratch database; a typo shows up in the **Problems** panel, on the file that caused it. Turn
on `liftoff.checkModelOnSave` to check on every save.

**Generate Migration from Schema Model**, description `phone`: `V0002__phone.sql` holds the
`ALTER TABLE … ADD [phone]`. Commit, then **Run Pending Migrations** on test.

Dev does not have the column yet: run `ALTER TABLE dbo.customers ADD phone nvarchar(30) NULL;` on
it, or work from dev as in step 3 next time. Both directions work; pick one per change.

## Step 9: a warning where you type

Open `V0001__customers_and_orders.sql`, which already ran on test and prod, add a comment, and
save. Right-click **test** → **Validate**: **V0001__customers_and_orders.sql changed after it was
applied (checksum mismatch)**. The file gets a warning on its first line, in the **Problems**
panel too; from then on it follows every save, for each environment you have expanded or
validated. Undo the edit and save; the warning goes away. The next change always goes in a new
script.

## Step 10: run one script only

Add two scripts by hand: `migrations/V0003__a.sql` with `CREATE TABLE dbo.a (id int);` and
`migrations/V0004__b.sql` with `CREATE TABLE dbo.b (id int);`. In the Environments view,
right-click V0004 under **prod** → **Run This Script Only**. It tells you which older scripts stay
behind on prod (V0002, which only ran on test, and V0003) and that prod is a production database;
**Run This Script Only** then runs V0004 alone. Useful for a hotfix that cannot wait for the rest.

## Step 11: a pipeline (optional)

Command palette (**Ctrl+Shift+P**) → **LiftOff: Set Up Pipeline** → test, then prod. It writes
`.github/workflows/liftoff.yml`; its first lines list the GitHub secrets to add. With the model in
git, consider `--model generate` on the command line (`liftoff ci --stage test --stage prod
--model generate --write`): every pull request that changes `schema-model/` then gets its
migration script written and committed by the pipeline. See
[Teams, branches and pipelines](../guide/teams-and-pipelines.md#pipelines).

## What you did

| step | where |
| --- | --- |
| a project | **Create LiftOff Project** |
| environments | the settings tab (the gear) |
| dev into the model | Schema Model → **Compare with Dev** → **Pull All into Schema Model** |
| a migration from the model | **Generate Migration from Schema Model** |
| deploy | an environment → **Run Pending Migrations** |
| check first | **Check for Drift**, **Show the SQL That Would Run** |
| one script | a script → **Run This Script Only** |

**Show Log** (command palette) shows every `liftoff` command the extension ran, so you can do the
same from a terminal or a pipeline.

Next: [an existing database in VS Code](06-existing-database-vscode.md).
