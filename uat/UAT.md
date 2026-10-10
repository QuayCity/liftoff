# LiftOff user acceptance tests (SQL Server)

Every feature, tried by hand the way a user would, on SQL Server. Each scenario starts from a
known state that one script sets up, so you can do them in any order, stop halfway and start a
scenario over.

PostgreSQL comes later. The extra scenarios it needs are listed at the end (§ 15).

## 0. Before you start

### Set up once

In PowerShell 7, from the repository root:

```powershell
.\uat\setup.ps1              # SQL Server container + the single-file liftoff program
.\uat\setup.ps1 -VSCode      # also package and install the VS Code extension (for § 13)
.\uat\setup.ps1 -Desktop     # also install the desktop app's packages (for § 12)
.\uat\reset.ps1 all          # every scenario's databases and project folders
```

- **The container.** `setup.ps1` starts its own SQL Server container, `liftoff-uat-mssql` on port
  61433. The automated tests' container is left alone.
- **Another port.** If Windows reserved 61433, set `$env:LIFTOFF_UAT_PORT = 61500` in every
  window, then run `.\uat\teardown.ps1` and `.\uat\setup.ps1` again. The reserved ranges are
  listed by `netsh interface ipv4 show excludedportrange protocol=tcp`.

### In every PowerShell window you test from

```powershell
. .\uat\env.ps1              # note the leading dot and space
```

This gives you:

| what | does |
| --- | --- |
| `liftoff …` | the single-file program in `packages\liftoff\build\liftoff.exe`, as it ships |
| `uatsql <db> "<T-SQL>"` | changes a database by hand: your "SSMS". Separate batches with a line holding only `GO` |
| `uaturl <db>` | a full connection URL with the password, for `--source` / `--target` |
| `$UatRoot` | where the project folders are: `~\liftoff-uat\<scenario>` |
| `$env:LIFTOFF_UAT_PASSWORD` | the SQL Server password; the projects' `liftoff.toml` files read it as `${env.LIFTOFF_UAT_PASSWORD}` |

To look at a database in a GUI tool (SSMS, Azure Data Studio, VS Code mssql), connect to
`localhost,61433` as `sa`, password `Liftoff!Uat2026`, and trust the server certificate.

Start VS Code and the desktop app **from a window with env.ps1 loaded** (`code <folder>`,
`npm start`), so they see the password variable.

### Starting over and cleaning up

| to | run |
| --- | --- |
| start one scenario over | `.\uat\reset.ps1 <scenario>` |
| start everything over | `.\uat\reset.ps1 all` |
| remove the container and all folders | `.\uat\teardown.ps1` |

### What "exit" means in the tables

`$LASTEXITCODE` after a command. These codes are a contract that CI pipelines rely on, so check
them.

| exit | means |
| --- | --- |
| 0 | it worked |
| 1 | a database, file or git error |
| 2 | wrong usage or configuration |
| 10 | could not connect |
| 11 | a migration script failed |
| 12 | refused: validation failed, or the database differs from the baseline, or the schema model does not build |
| 13 | drift found |
| 14 | the schema model has changes no script makes |

### PowerShell quoting

PowerShell splits `-name:value` arguments at the colon. Quote any Flyway-style argument that
holds a colon, e.g. `"-locations=filesystem:sql"`, and quote anything that holds a `;` or a `$`.

### Recording results

Mark the **Result** column as ✅ (pass), ❌ (fail) or ⚠️ (works, but something is off). For each
❌ and ⚠️, note:
- the step number,
- the exact command,
- the output (`--output-type json` gives the error code),
- `liftoff --version`.

## Scenario map

| § | scenario | reset | what it proves |
| --- | --- | --- | --- |
| 1 | Smoke test | none | the program runs, helps, and answers in JSON |
| 2 | Greenfield project | `greenfield` | from an empty folder to a change deployed to test and prod |
| 3 | Everyday changes | `changes` | every kind of change in dev becomes a correct migration; undo; hand-written and repeatable scripts |
| 4 | Deploying safely | `deploy` | the checks before a deploy, drift, edited and failed scripts, repair, partial deploys, placeholders, clean |
| 5 | Schema model | `model` | one file per object, generating from the model, the pull-request gate |
| 6 | Existing database (adopt) | `adopt` | a database that was never under a migration tool becomes the baseline; other environments are checked against it |
| 7 | Flyway project | `flyway` | a Flyway project and its databases carry over |
| 8 | Schema compare | `compare` | compare any two sides, then write a script or migration, or apply it |
| 9 | Data compare | `data` | row differences, fast; browse, script and apply them |
| 10 | Branches, rebaseline, pipelines | `branches` | numbering across branches, squash and rebaseline, the generated CI workflow |
| 11 | Settings, secrets, connections | `greenfield` | where passwords go, `${env.X}`, clear connection errors |
| 12 | Desktop app | per step | the same flows in the desktop app |
| 13 | VS Code extension | per step | the same flows in VS Code |
| 14 | Fixed while preparing this plan | none | regression checks for bugs found on 2026-10-10 |
| 15 | Later: PostgreSQL | none | what to add when testing PostgreSQL |

---

## 1. Smoke test

**Tests:** the program starts, `--help` and `--version`, a usage error, JSON output.

| # | do | expect | result |
| --- | --- | --- | --- |
| 1.1 | `liftoff --help` | the rocket, then every command with one line each | ☐ |
| 1.2 | `liftoff --version` and `liftoff -V` | `liftoff 0.1.0` | ☐ |
| 1.3 | `liftoff migrate --help` | the options of migrate only, plus the global ones | ☐ |
| 1.4 | `liftoff nosuchcommand` | `unknown command`; exit 2 | ☐ |
| 1.5 | `liftoff migrate --nosuchflag` | a usage error; exit 2 | ☐ |
| 1.6 | in an empty folder: `liftoff info` | `no liftoff.toml in …; run liftoff init first`; exit 2 | ☐ |
| 1.7 | the same with `--output-type json` | exactly one JSON object on stdout: `{"ok":false,"error":{"code":"LIFTOFF_CONFIG","exit_code":2,…}}` | ☐ |
| 1.8 | `Get-Item packages\liftoff\build\liftoff.exe` | one file of about 96 MB; it runs on a machine without Node | ☐ |

---

## 2. Greenfield project

`.\uat\reset.ps1 greenfield`, then `cd $UatRoot\greenfield`.

**Start:** an empty folder, and three empty databases: gf_dev, gf_test, gf_prod.

**Tests:**
- `init` for SQL Server, and adding environments;
- `create-scratch`;
- the first table made in dev and written as `V0001` with its undo script;
- dev recorded as already having it;
- deploying to test, then the pre-deploy check and deploy on prod.

| # | do | expect | result |
| --- | --- | --- | --- |
| 2.1 | `liftoff init --engine sqlserver` | `Created liftoff.toml`; the folders `migrations\` and `schema-model\` and a `.gitignore` holding `liftoff.user.toml` | ☐ |
| 2.2 | open `liftoff.toml` | `engine = "sqlserver"`, `schemas = [ "dbo" ]`, `history_table = "liftoff_schema_history"` | ☐ |
| 2.3 | `Get-Content $UatRoot\greenfield-environments.toml \| Add-Content liftoff.toml` | dev, test and prod environments, with `password = "${env.LIFTOFF_UAT_PASSWORD}"` | ☐ |
| 2.4 | `liftoff project` | `greenfield (sqlserver, scripts in migrations)`, then dev, prod and test with their roles. No URLs | ☐ |
| 2.5 | `liftoff -e dev test-connection` | `Connected to dev: gf_dev as sa (SQL Server 16…)` | ☐ |
| 2.6 | `liftoff diff` | no environment with role 'scratch'; add one or name it explicitly (`liftoff create-scratch` makes one next to the dev database); exit 2 | ☐ |
| 2.7 | `liftoff create-scratch` | `Created database gf_dev_scratch and saved it as environment 'scratch' (role scratch, private)` | ☐ |
| 2.8 | open `liftoff.user.toml` | `[environments.scratch]` with `allow_clean = true`. **No password in it or in `liftoff.toml`**: it is in Windows Credential Manager | ☐ |
| 2.9 | `liftoff create-scratch` again | refused: an environment named 'scratch' already exists; exit 2 | ☐ |
| 2.10 | `uatsql gf_dev "CREATE TABLE dbo.customers (id int IDENTITY PRIMARY KEY, email nvarchar(320) NOT NULL UNIQUE, created_at datetime2 NOT NULL DEFAULT SYSUTCDATETIME())"` | nothing printed | ☐ |
| 2.11 | `liftoff diff` | `Rebuilding scratch database…`, `1 difference(s)`, `added dbo.customers` | ☐ |
| 2.12 | `liftoff generate --description "customers" --dry-run` | the script on screen, nothing written | ☐ |
| 2.13 | `liftoff generate --description "customers" --undo` | `Wrote …\migrations\V0001__customers.sql`, and `U0001__customers.sql` next to it | ☐ |
| 2.14 | read both files | V0001: `CREATE TABLE [dbo].[customers]`, the primary key, the unique key, the default. U0001: `DROP TABLE IF EXISTS [dbo].[customers]`. Each starts with a "Written by LiftOff" header | ☐ |
| 2.15 | `liftoff -e dev info` | `0001 customers pending`. Dev has the table, but the history does not know yet | ☐ |
| 2.16 | `liftoff -e dev mark-applied V0001__customers.sql` | `Recorded … as applied on dev without running it`; `info` now says applied | ☐ |
| 2.17 | `liftoff -e test info`, then `liftoff -e test migrate` | pending, then `Applied 1 migration(s) to test` | ☐ |
| 2.18 | `liftoff -e test migrate` again | nothing to do; exit 0 | ☐ |
| 2.19 | `liftoff -e prod check` | `Drift: none`, `Pending changes: 1 added dbo.customers`, then the dry-run SQL. It includes the history insert and is wrapped in a transaction. Exit 0 | ☐ |
| 2.20 | `liftoff -e prod migrate --dry-run` | the same SQL; gf_prod still has no table (`uatsql gf_prod "SELECT name FROM sys.tables"`) | ☐ |
| 2.21 | `liftoff -e prod migrate` | `Applied 1 migration(s) to prod` | ☐ |
| 2.22 | `liftoff -e prod info --output-type json` | one JSON object listing V0001 as applied, with the time it ran | ☐ |
| 2.23 | `uatsql gf_prod "SELECT version, script, success FROM dbo.liftoff_schema_history"` | one row: 0001, V0001__customers.sql, 1 | ☐ |

**Variant 2b:** try the sample. In an empty folder, run `liftoff init --sample --engine sqlserver`.
You should get V0001–V0003, U0003, `R__customer_totals.sql` and a README, all in T-SQL.

---

## 3. Everyday changes

`.\uat\reset.ps1 changes`, then `cd $UatRoot\changes`.

**Start:** the sample shop project (V0001–V0003 and a repeatable view), applied on ch_dev,
ch_test and ch_prod; ch_scratch is empty; the folder is a git repository.

**Tests:**
- every object type made in dev becomes the right T-SQL;
- `--record-on-dev`;
- changes that can lose data, and `--skip-destructive`;
- undo;
- repeatable scripts;
- hand-written scripts (`add`);
- `capture`.

| # | do | expect | result |
| --- | --- | --- | --- |
| 3.1 | `liftoff diff` | `No differences` (dev matches the scripts) | ☐ |
| 3.2 | make several changes at once (block below) | nothing printed | ☐ |
| 3.3 | `liftoff diff` | 4 differences: procedure `dbo.customer_count`, table `dbo.notes`, trigger `dbo.orders_guard`, table `dbo.customers` changed | ☐ |
| 3.4 | `liftoff generate --description "phone and notes" --record-on-dev --undo` | `V0004__phone_and_notes.sql` and `U0004…`; `Recorded V0004… as applied on dev` | ☐ |
| 3.5 | read V0004 | `ALTER TABLE … ADD [phone]`, `CREATE TABLE [dbo].[notes]` with its key, the procedure and the trigger. Every batch separated by `GO`, in an order that runs | ☐ |
| 3.6 | `liftoff -e test migrate`, then `liftoff -e test info` | V0004 applied; the repeatable view is not re-run (it did not change) | ☐ |
| 3.7 | `liftoff -e test undo` | `Undoing V0004… with U0004…`, then `Undid …; it is pending again`. ch_test has no notes table and no phone column | ☐ |
| 3.8 | `liftoff -e test undo` again | V0003 has an undo script (U0003), so this undoes V0003: the index is dropped. Then `liftoff -e test migrate` to go back | ☐ |
| 3.9 | `uatsql ch_dev "DROP TABLE dbo.notes; ALTER TABLE dbo.customers DROP COLUMN phone"` | nothing printed | ☐ |
| 3.10 | `liftoff generate --description "drop notes" --dry-run` | `warning: the script includes changes that may lose data`; both lines are marked `(may lose data)` | ☐ |
| 3.11 | `liftoff generate --description "drop notes" --skip-destructive --dry-run` | `No differences; nothing written` (every change found was destructive) | ☐ |
| 3.12 | `uatsql ch_dev "ALTER TABLE dbo.orders ALTER COLUMN total decimal(12,2) NOT NULL"`, then `liftoff diff` | `changed dbo.orders`, marked as possibly losing data (a type change) | ☐ |
| 3.13 | `uatsql ch_dev "CREATE INDEX orders_placed_idx ON dbo.orders (placed_at)"` + a function (block below), then `liftoff generate --description "more" --record-on-dev` | one script holding the column type change, the index and the function; it runs on test (`liftoff -e test migrate`) | ☐ |
| 3.14 | edit `migrations\R__customer_totals.sql` (add `, MAX(o.placed_at) AS last_order` to the select list), then `liftoff -e test migrate` | only `R__customer_totals.sql` runs (it changed) | ☐ |
| 3.15 | `liftoff -e test migrate --rerun-repeatables` | the repeatable runs again although it did not change | ☐ |
| 3.16 | `liftoff add --description "seed statuses"` | an empty `V00xx__seed_statuses.sql` with the next number | ☐ |
| 3.17 | `Set-Content seed.sql "SELECT 1"`; `liftoff add --description "from file" --from-file seed.sql` | a new script holding `SELECT 1` | ☐ |
| 3.18 | `liftoff add --description "lookups" --repeatable` | `R__lookups.sql` | ☐ |
| 3.19 | delete the three files from 3.16–3.18 | (clean-up) | ☐ |
| 3.20 | `liftoff -e prod capture --dry-run` | the whole prod schema as one script on screen | ☐ |
| 3.21 | `liftoff -e prod capture --as-baseline-script --dry-run` | the same, as a B script | ☐ |

Changes for 3.2:

```powershell
uatsql ch_dev @"
ALTER TABLE dbo.customers ADD phone nvarchar(30) NULL;
CREATE TABLE dbo.notes (id int PRIMARY KEY, body nvarchar(max) NULL);
GO
CREATE PROCEDURE dbo.customer_count AS SELECT COUNT(*) FROM dbo.customers
GO
CREATE TRIGGER dbo.orders_guard ON dbo.orders AFTER DELETE AS BEGIN SET NOCOUNT ON; END
"@
```

Function for 3.13:

```powershell
uatsql ch_dev @"
CREATE FUNCTION dbo.order_count (@customer_id bigint) RETURNS int AS
BEGIN RETURN (SELECT COUNT(*) FROM dbo.orders WHERE customer_id = @customer_id); END
"@
```

---

## 4. Deploying safely

`.\uat\reset.ps1 deploy`, then `cd $UatRoot\deploy`.

**Start:** the shop at V0003 on dp_dev, dp_test and dp_prod; test has `allow_clean = true`.

**Tests:**
- `check` and its parts, and the HTML report;
- drift;
- validate and repair after an applied script is edited;
- a failing script;
- deploying part of the scripts: `--target`, `--only`, `--out-of-order`;
- placeholders;
- clean: allowed on test, refused on prod.

| # | do | expect | result |
| --- | --- | --- | --- |
| 4.1 | `liftoff -e prod check` | no drift, nothing pending; exit 0 | ☐ |
| 4.2 | `uatsql dp_prod "ALTER TABLE dbo.customers ADD hotfix bit NULL"` (someone changed prod by hand) | nothing printed | ☐ |
| 4.3 | `liftoff -e prod check --drift` | `Drift: 1`, `changed dbo.customers`, `drift found on 'prod'`; **exit 13** | ☐ |
| 4.4 | `liftoff -e prod check --report report.html`, then `start report.html` | the report opens in a browser, stands alone, and shows the drift | ☐ |
| 4.5 | `uatsql dp_prod "ALTER TABLE dbo.customers DROP COLUMN hotfix"`, then check again | no drift; exit 0 | ☐ |
| 4.6 | `liftoff -e test validate` | `4 script(s) checked; no problems` | ☐ |
| 4.7 | edit `migrations\V0002__orders.sql` (add a comment line), then `liftoff -e test validate` | `V0002__orders.sql changed after it was applied (checksum mismatch)`; **exit 12** | ☐ |
| 4.8 | `liftoff -e test info` | V0002 shows `(changed!)` | ☐ |
| 4.9 | `liftoff -e test migrate` | the same error; nothing runs; **exit 12** | ☐ |
| 4.10 | `liftoff -e test repair`, then `validate` | the edit is accepted; no problems | ☐ |
| 4.11 | `git checkout migrations`, then `liftoff -e test repair` | back to the committed file; validate passes on test | ☐ |
| 4.12 | `Set-Content migrations\V0004__broken.sql "CREATE TABLE dbo.x (id int); SELECT * FROM dbo.nope;"`, then `liftoff -e test migrate` | `V0004__broken.sql failed; rolled back`, `…Invalid object name 'dbo.nope'. (error 208, line 2)`; **exit 11**. Table `dbo.x` does **not** exist: `uatsql dp_test "SELECT OBJECT_ID('dbo.x')"` gives NULL | ☐ |
| 4.13 | `liftoff -e test info` | V0004 is still **pending**: on SQL Server the whole script ran in one transaction that was rolled back, so nothing is recorded | ☐ |
| 4.14 | fix the file (remove the SELECT line), `liftoff -e test migrate` | V0004 applies. (`repair` is not needed; it would report 0 failed rows) | ☐ |
| 4.15 | add `V0005__a.sql` (`CREATE TABLE dbo.a (id int)`) and `V0006__b.sql` (`CREATE TABLE dbo.b (id int)`), then `liftoff -e prod migrate --target 4` | V0004 runs, V0005 and V0006 stay pending | ☐ |
| 4.16 | `liftoff -e prod migrate --only 6` | only V0006 runs; info shows V0005 pending and V0006 applied | ☐ |
| 4.17 | `liftoff -e prod migrate` | `V0005__a.sql is older than the latest applied version; use --out-of-order to run it`; **exit 12**. `info` shows V0005 as `ignored` | ☐ |
| 4.18 | `liftoff -e prod migrate --out-of-order` | V0005 runs | ☐ |
| 4.19 | placeholders: add `V0007__owner.sql` holding `CREATE TABLE ${schemaName}.c (id int)`, then add the block below to `liftoff.toml` and run `liftoff -e test migrate` | `dbo.c` is created on test | ☐ |
| 4.20 | `liftoff -e prod migrate --placeholder schemaName=dbo` | prod has no value in the file; the command-line value is used | ☐ |
| 4.21 | `liftoff -e dev migrate` with no value anywhere for the placeholder | `V0007__owner.sql uses placeholders with no value: schemaName`; exit 2; nothing runs. (The check applies once the project uses placeholders at all, as it does after 4.19) | ☐ |
| 4.22 | `liftoff -e test clean` | every object in dbo on dp_test is erased, history included | ☐ |
| 4.23 | `liftoff -e test migrate` | built again from V0001 | ☐ |
| 4.24 | `liftoff -e prod clean` | `clean is turned off for 'prod'`; exit 2. Nothing erased | ☐ |
| 4.25 | `liftoff -e prod migrate --output-type json` with nothing pending | one JSON object, `ok: true`; the logs go to stderr only | ☐ |

Placeholders for 4.19:

```toml
[environments.test.placeholders]
schemaName = "dbo"
```

---

## 5. Schema model

`.\uat\reset.ps1 model`, then `cd $UatRoot\model`.

**Start:** the shop at V0003 everywhere, with `schema-model\` filled from md_dev (one file per
table and view), committed.

**Tests:**
- `model` and `model --status`;
- pulling a single object with `--path`;
- `model --check`, with a broken file;
- `diff` and `generate --from model`;
- the pull-request gate, `check --model`.

| # | do | expect | result |
| --- | --- | --- | --- |
| 5.1 | look at `schema-model\dbo\tables\customers.sql` and the other files | one readable `CREATE` per object, under `dbo\tables` and `dbo\views` | ☐ |
| 5.2 | `liftoff model --status` | nothing differs | ☐ |
| 5.3 | `uatsql md_dev "ALTER TABLE dbo.customers ADD phone nvarchar(30) NULL; CREATE TABLE dbo.tags (id int PRIMARY KEY, name nvarchar(50) NOT NULL)"`, then `liftoff model --status` | `changed dbo/tables/customers.sql`, `added dbo/tables/tags.sql`; no files written | ☐ |
| 5.4 | `liftoff model --path dbo/tables/tags.sql` | only `tags.sql` is written; `customers.sql` is untouched | ☐ |
| 5.5 | `liftoff model` | `customers.sql` now has `phone`; `git diff` shows exactly that | ☐ |
| 5.6 | `liftoff check --model` | the model has changes no script makes; **exit 14** | ☐ |
| 5.7 | `liftoff diff --from model` | phone and tags, without touching md_dev | ☐ |
| 5.8 | `liftoff generate --description "phone and tags" --from model` | `V0004__phone_and_tags.sql` | ☐ |
| 5.9 | `liftoff check --model` | exit 0 | ☐ |
| 5.10 | edit by hand: in `tags.sql` change `nvarchar(50)` to `nvarchar(80)`. Then `liftoff model --check` | the model builds on the scratch database; exit 0 | ☐ |
| 5.11 | break it: type `CREAT TABLE` in `tags.sql`, then `liftoff model --check` | `1 schema-model file(s) do not build: dbo/tables/tags.sql: …`; **exit 12** | ☐ |
| 5.12 | `git checkout schema-model` | (clean-up) | ☐ |

---

## 6. Existing database (adopt)

`.\uat\reset.ps1 adopt`, then `cd $UatRoot\adopt`.

**Start:** an empty folder. The databases:

| database | holds |
| --- | --- |
| lg_prod | a legacy schema with rows, and no history: 4 tables, a view, a function, a procedure and a trigger, with checks, defaults, unique keys, foreign keys and an index |
| lg_test | the same schema |
| lg_stage | the schema without the view and the procedure |
| lg_qa | `products.name` is `nvarchar(50)` instead of 100, plus an extra column `customers.loyalty_points` |
| lg_new | empty |
| lg_scratch | empty |

**Tests:**
- the refusal to run scripts on a database that has tables but no history;
- `adopt` writing B0001 and checking it;
- the smart baseline on each kind of database: the same, missing objects, different, and empty;
- `--accept-differences` and the drift it leaves;
- `baseline` and `--allow-non-empty`.

| # | do | expect | result |
| --- | --- | --- | --- |
| 6.1 | `liftoff init --engine sqlserver`, then `Get-Content $UatRoot\adopt-environments.toml \| Add-Content liftoff.toml` | environments prod, scratch, test, stage, qa and new | ☐ |
| 6.2 | `liftoff -e prod migrate` | `'prod' already has tables but no migration history. Baseline it first … or … --allow-non-empty`; **exit 12** | ☐ |
| 6.3 | `liftoff -e prod adopt` | captures prod, builds the capture on scratch to check it, `prod is now at B0001__existing_schema.sql`, `Wrote … and recorded it there` | ☐ |
| 6.4 | read `migrations\B0001__existing_schema.sql` | all 4 tables, with keys, checks, defaults and the index, plus the view, the function, the procedure and the trigger. In an order that runs: tables before foreign keys, the function before the procedure that uses it | ☐ |
| 6.5 | `uatsql lg_prod "SELECT COUNT(*) FROM dbo.order_lines"` | 4: the rows are untouched | ☐ |
| 6.6 | `liftoff -e test migrate` (same schema) | checked against B0001: `test is now at B0001…`; nothing created | ☐ |
| 6.7 | `liftoff -e stage migrate` (missing objects) | `creating what it lacks of B0001…: view:dbo.order_summary, procedure:dbo.orders_for_customer`; then at B0001 | ☐ |
| 6.8 | `liftoff -e qa migrate` (different) | `'qa' has objects that differ…: different: table:dbo.customers, table:dbo.products`; **exit 12**. Nothing changed on lg_qa | ☐ |
| 6.9 | `liftoff -e qa migrate --accept-differences` | two warnings `…differs…; kept as it is (it shows up as drift)`; `qa is now at B0001…` | ☐ |
| 6.10 | `liftoff -e qa check --drift` | `Drift: 2`; products is marked `(may lose data)`; exit 13 | ☐ |
| 6.11 | `liftoff -e new migrate` (empty) | `Empty database: building it from B0001…`; every object is created | ☐ |
| 6.12 | `uatsql lg_prod "ALTER TABLE dbo.products ADD weight_kg decimal(6,2) NULL"`, then `liftoff -e prod info` | B0001 applied | ☐ |
| 6.13 | add a scratch-backed dev to `liftoff.toml` (copy `[environments.prod]` as `[environments.dev]` with `role = "dev"`), then `liftoff generate --description "weight"` | `V0002__weight.sql`: new scripts start after B0001 | ☐ |
| 6.14 | `liftoff -e test migrate`, `liftoff -e new migrate` | V0002 runs on both | ☐ |

**Variant 6b, a manual baseline instead of adopt:**
1. `.\uat\reset.ps1 adopt` again, then `liftoff init --engine sqlserver` and the environments.
2. `liftoff -e prod baseline --version 1 --description "before LiftOff"` should say `prod is now at baseline 1`.
3. `liftoff -e prod info` should show the baseline row.

**Variant 6c, running every script anyway:**
`liftoff -e test migrate --allow-non-empty` runs every script on a database that has tables but
no history. With no scripts, it records nothing.

---

## 7. Flyway project

`.\uat\reset.ps1 flyway`, then `cd $UatRoot\flyway`.

**Start:** a project as Flyway would have it:
- `flyway.toml` with environments development, shadow, test and production;
- a `${tableOwner}` placeholder;
- `cleanDisabled`, `baselineOnMigrate` and `validateOnMigrate`;
- `sql\V1__…`, `V2__…`, `V3__…` and `R__customer_totals.sql`.

The databases:

| database | holds |
| --- | --- |
| fw_development | V1–V3 and the repeatable, with a `flyway_schema_history` table |
| fw_production | the same as fw_development |
| fw_test | only V1 and V2 |
| fw_shadow | empty |

**Tests:**
- the preview;
- the conversion: environment roles, the placeholder, what is not converted, passwords;
- the scripts keep their names;
- the history import on SQL Server, which is refused with a clear message;
- `baseline` per database;
- the next script after the Flyway versions;
- Flyway's history table is never compared;
- Flyway-style command-line arguments.

| # | do | expect | result |
| --- | --- | --- | --- |
| 7.1 | `liftoff info` | `no liftoff.toml in …; run liftoff init first`; exit 2 (not converted yet) | ☐ |
| 7.2 | `liftoff init --from-flyway --preview` | `Would convert … (nothing written)`. Migrations: `sql`; schemas: `dbo`. development → dev, shadow → scratch, test → test, production → prod. URLs are shown without passwords; `not converted: baselineOnMigrate…`, `validateOnMigrate…`. No `liftoff.toml` is written | ☐ |
| 7.3 | `liftoff init --from-flyway --role test=prod --preview` | test is now shown as prod. Do not convert this way | ☐ |
| 7.4 | `liftoff init --from-flyway` | (plain `liftoff init` here would print a note that the folder has a Flyway config) `Converted …`; `note: flyway_schema_history is left out of comparisons…`. The hint says `baseline --version`, **not** import-flyway-history (that is PostgreSQL only) | ☐ |
| 7.5 | open `liftoff.toml` | `engine = "sqlserver"`, `migrations = "sql"`, `[project.placeholders] tableOwner = "dbo"`, a filter excluding table `flyway_schema_history`, 4 environments, `allow_clean = false` (cleanDisabled = true). No password | ☐ |
| 7.6 | open `liftoff.user.toml` | each environment has `password = "${env.LIFTOFF_UAT_PASSWORD}"`, kept as written | ☐ |
| 7.7 | `flyway.toml` and `sql\` | unchanged (`git status` shows only new files) | ☐ |
| 7.8 | `liftoff -e production import-flyway-history` | `importing Flyway history works on PostgreSQL only for now; on SQL Server, baseline the database…`; exit 2 | ☐ |
| 7.9 | `liftoff -e production migrate` | refused: tables but no history; exit 12 | ☐ |
| 7.10 | `liftoff -e production baseline --version 3 --description "from Flyway"` | `production is now at baseline 3` | ☐ |
| 7.11 | `liftoff -e production info` | V1–V3 `belowbaseline`, a baseline row at 3, the repeatable pending | ☐ |
| 7.12 | `liftoff -e development baseline --version 3` and `liftoff -e test baseline --version 2` | both at their baseline | ☐ |
| 7.13 | `liftoff -e test migrate` | V3 and the repeatable run on fw_test, with `${tableOwner}` replaced by `dbo` | ☐ |
| 7.14 | `uatsql fw_development "ALTER TABLE dbo.orders ADD placed_at datetime2 NULL"`, then `liftoff diff` | **only** `changed dbo.orders`. Flyway's history table is not listed | ☐ |
| 7.15 | `liftoff generate --description "order date"` | `sql\V0004__order_date.sql`: after V3, four-digit from now on | ☐ |
| 7.16 | `liftoff -e production migrate` | V0004 and the repeatable run (the repeatable once, because LiftOff has no record of it) | ☐ |
| 7.17 | `uatsql fw_production "SELECT COUNT(*) FROM dbo.flyway_schema_history"` | 4: Flyway's table is untouched | ☐ |
| 7.18 | Flyway-style arguments, from any folder with a `sql` subfolder: `liftoff info "-url=jdbc:sqlserver://localhost:61433;databaseName=fw_test;encrypt=true;trustServerCertificate=true" -user=sa "-password=$env:LIFTOFF_UAT_PASSWORD" "-locations=filesystem:sql"` | the info table, with no `liftoff.toml` needed | ☐ |
| 7.19 | `liftoff -e test migrate "-cherryPick=4"` (in the project) | the same as `--only 4` | ☐ |
| 7.20 | `liftoff -e test "-table=flyway_schema_history" info` | `-table=flyway_schema_history is Flyway's history table; LiftOff keeps its own…`; exit 2. (Its hint names `import-flyway-history`, which is PostgreSQL only: fine to note as ⚠️) | ☐ |
| 7.21 | `liftoff "-configFiles=flyway.toml" info` | `-configFiles: convert the Flyway config once with liftoff init --from-flyway`; exit 2 | ☐ |

---

## 8. Schema compare

`.\uat\reset.ps1 compare`, then `cd $UatRoot\compare`.

**Start:** the shop at V0003 everywhere.
- cp_dev also has: table `suppliers`, `customers.phone`, `orders.total` widened to decimal(12,2),
  index `orders_placed_idx`, view `big_orders`, procedure `add_supplier` and function
  `customer_order_count`.
- cp_test also has table `old_notes`, with a row.

**Tests:**
- every kind of side: an environment, a URL, `model`, `migrations` and a snapshot;
- choosing single objects;
- the sync script;
- writing the differences as a migration;
- applying them, and the production guard.

| # | do | expect | result |
| --- | --- | --- | --- |
| 8.1 | `liftoff compare --source dev --target test` | `7 difference(s)`: customers and orders changed (orders `(may lose data)`); suppliers, the procedure, the view and the function added; old_notes removed `(may lose data)` | ☐ |
| 8.2 | `liftoff compare --source dev --target test --script -` | T-SQL that makes test like dev, including `DROP TABLE … old_notes` | ☐ |
| 8.3 | `liftoff compare --source dev --target test --object table:dbo.suppliers --object view:dbo.big_orders --script sync.sql` | `sync.sql` holds only those two | ☐ |
| 8.4 | `liftoff compare --source dev --target migrations` | the same as `liftoff diff`: the 6 dev changes, via the scratch database | ☐ |
| 8.5 | `liftoff compare --source dev --target migrations --migration "from compare" --undo` | V0004 and U0004 written | ☐ |
| 8.6 | `liftoff snapshot --of test --out test.json` | a JSON file | ☐ |
| 8.7 | `uatsql cp_test "DROP TABLE dbo.old_notes"`, then `liftoff compare --source snapshot:test.json --target test` | `old_notes` added (the snapshot still has it); this works without the old database | ☐ |
| 8.8 | `liftoff compare --source dev --target (uaturl cp_prod)` | a URL as a side works; the output never prints the password | ☐ |
| 8.9 | `liftoff compare --source dev --target test --apply` | applied to cp_test outside the migration history; comparing again finds nothing | ☐ |
| 8.10 | `liftoff compare --source dev --target prod --apply` | refused without `--confirm-production` | ☐ |
| 8.11 | `liftoff compare --source dev --target prod --apply --confirm-production` | `Applied 6 change(s) to prod. Its migration history was not changed, so it now differs from its scripts.` `liftoff -e prod check --drift` then shows the drift (exit 13) | ☐ |
| 8.12 | `liftoff compare --source model --target dev` | works when `schema-model\` has files. Run `liftoff model` first, otherwise everything shows as removed | ☐ |

---

## 9. Data compare

`.\uat\reset.ps1 data`, then `cd $UatRoot\data`.

**Start:** environments source (dc_source, role dev), target (dc_target, role test) and prod
(dc_prod, role prod). The same five tables everywhere, with planted differences in target and
prod (`uat\sql\data-target-changes.sql`):

| table | only in source | only in target | different | notes |
| --- | --- | --- | --- | --- |
| dbo.customers | 30 | 20 | 25 | values changed, set to NULL, numbers, Unicode |
| dbo.products | 1 | 1 | 3 | an IDENTITY column |
| dbo.order_lines | 2 | 1 | 5 | a two-column primary key |
| dbo.events | 0 | 0 | 3 | of 200,000 rows |
| dbo.audit_log | – | – | – | no key: skipped |

**Tests:**
- the counts, and the speed;
- skipped tables;
- browsing the rows by kind and page;
- the sync script and its switches;
- apply, and the production guard;
- saving the differences and reusing them;
- the side check.

| # | do | expect | result |
| --- | --- | --- | --- |
| 9.1 | `liftoff data-compare --source source --target target` | exactly the counts above; `dbo.audit_log: not compared, no primary key…`. A few seconds in all; events reports `3 of 128 buckets differ` | ☐ |
| 9.2 | `… --table dbo.products` | only products | ☐ |
| 9.3 | `… --rows dbo.customers` (kind different) | the 25 rows, source and target side by side; NULLs shown as NULL; Unicode intact (`Ünïcödé`, `Zoë ✓ 日本`) | ☐ |
| 9.4 | `… --rows dbo.customers --kind only_in_source --limit 10 --offset 20` | rows 21–30 of the 30 (ids 21–30) | ☐ |
| 9.5 | `… --rows dbo.order_lines --kind only_in_target` | `(1001, 1)` | ☐ |
| 9.6 | `… --script sync.sql` | INSERT, UPDATE and DELETE statements. For products it uses `SET IDENTITY_INSERT … ON/OFF`; composite keys are matched on both columns | ☐ |
| 9.7 | `… --script - --no-delete` | no DELETE statements | ☐ |
| 9.8 | `… --save-diff rows.json`, then `Get-Content rows.json` | the keys and side labels only. **No URL and no password** in the file | ☐ |
| 9.9 | `… --from-diff rows.json --rows dbo.events` | the 3 event rows, at once, without comparing again | ☐ |
| 9.10 | `liftoff data-compare --source target --target source --from-diff rows.json --rows dbo.events` | refused: the sides do not match the file; **exit 2** | ☐ |
| 9.11 | `… --apply` | applied in one transaction. Comparing again shows 0 everywhere (audit_log still skipped) | ☐ |
| 9.12 | `liftoff data-compare --source source --target prod --apply` | refused without `--confirm-production` | ☐ |
| 9.13 | the same with `--confirm-production` | applied | ☐ |
| 9.14 | `liftoff data-compare --source (uaturl dc_source) --target (uaturl dc_target) --output-type json` | one JSON object with the tables and counts; no password anywhere in it | ☐ |

---

## 10. Branches, rebaseline, pipelines

`.\uat\reset.ps1 branches`, then `cd $UatRoot\branches`.

**Start:** the shop at V0003 everywhere, on git branch `main`, with one commit.

**Tests:**
- numbering after main;
- `squash`;
- `rebaseline`: `--up-to` and `--archive`;
- the near-V9999 note and `rebaseline --restart`;
- `ci`: print, write, and the model modes.

| # | do | expect | result |
| --- | --- | --- | --- |
| 10.1 | `git switch -c feature`; `liftoff add --description "feature table"`; put `CREATE TABLE dbo.feature (id int)` in it; `git add -A; git commit -m feature` | V0004 on the branch | ☐ |
| 10.2 | `git switch main`; `liftoff add --description "main table"` with `CREATE TABLE dbo.mainline (id int)`; commit | V0004 on main as well | ☐ |
| 10.3 | `git switch feature`; `liftoff renumber --after main --check` | the branch's V0004 is not after main's; **exit 12**; nothing changed | ☐ |
| 10.4 | `liftoff renumber --after main` | the branch's script becomes V0005 (with its U script, if any) | ☐ |
| 10.5 | `git add -A; git commit -m renumbered; git merge main` | no clash: V0004 main table, V0005 feature table | ☐ |
| 10.6 | `liftoff squash --dry-run` | one B script built from all the versioned scripts, on screen | ☐ |
| 10.7 | `git add -A; git commit -m merged`, then `liftoff rebaseline --up-to 3` | `B0003__baseline.sql` replaces V0001–V0003 (checked to build the same schema); V0004 and V0005 stay. The old files are gone; git has them | ☐ |
| 10.8 | `liftoff -e prod info` | V0001–V0003 are covered by the baseline; V0004 and V0005 pending | ☐ |
| 10.9 | `liftoff -e prod migrate` | V0004 and V0005 run; B0003 does not (prod already ran what it covers) | ☐ |
| 10.10 | `liftoff -e scratch clean`, then `liftoff -e scratch migrate` | an empty database starts from B0003, then V0004 and V0005 | ☐ |
| 10.11 | `git add -A; git commit -m rebaselined` | the rebaseline committed (10.13 needs a clean tree) | ☐ |
| 10.12 | near the limit: add `migrations\V9990__late.sql` (`SELECT 1;`), then `liftoff -e test migrate` | runs, with a note at the start: `the scripts have reached version 9990; rebaseline with a restart…` | ☐ |
| 10.13 | commit, then `liftoff rebaseline --restart` | `B0001` with a `-- liftoff:restart` marker; numbering starts again | ☐ |
| 10.14 | `liftoff -e test migrate`, then `liftoff -e test info` | test is checked against B0001 (nothing is rebuilt); info shows `0001 baseline` and the repeatable | ☐ |
| 10.15 | `liftoff ci --stage test --stage prod` | a GitHub Actions workflow on screen: validate, the drift check, deploy to test, then prod | ☐ |
| 10.16 | `liftoff ci --stage test --stage prod --model generate --write` | `.github\workflows\liftoff.yml`. Pull requests that change `schema-model\` get their script written and committed; uses the SQL Server scratch service | ☐ |
| 10.17 | the same again | refused: the file exists; with `--force` it is replaced | ☐ |
| 10.18 | `liftoff ci --stage test --no-checks` | no validate or drift step | ☐ |

**Variant 10b, keeping the old scripts:** `.\uat\reset.ps1 branches`, then `liftoff rebaseline
--archive old`. All versioned scripts should move to `old\`, leaving one B script. Then run
`liftoff rebaseline` on an uncommitted change: it is refused, because deleting needs the
scripts committed to git.

---

## 11. Settings, secrets, connections

Use the greenfield project after § 2 (or `.\uat\reset.ps1 greenfield` and steps 2.1–2.3).

**Tests:**
- `settings` and `project`;
- what is shared and what is private;
- `${env.X}`;
- environments that exist only as variables;
- clear connection errors.

| # | do | expect | result |
| --- | --- | --- | --- |
| 11.1 | `liftoff settings` | everything as written, `${env.LIFTOFF_UAT_PASSWORD}` included; no real password | ☐ |
| 11.2 | in a **new** window without env.ps1, from the repository: `packages\liftoff\build\liftoff.exe -C $HOME\liftoff-uat\greenfield -e test test-connection` | `could not connect to 'test': environment variable LIFTOFF_UAT_PASSWORD is not set`; exit 10 | ☐ |
| 11.3 | `$env:LIFTOFF_UAT_PASSWORD = 'wrong'; liftoff -e test test-connection; . .\uat\env.ps1` | a login failure for sa; exit 10 | ☐ |
| 11.4 | `docker stop liftoff-uat-mssql; liftoff -e test test-connection; docker start liftoff-uat-mssql` | `could not connect … refused` (or a timeout), within seconds; exit 10 | ☐ |
| 11.5 | `$env:LIFTOFF_ENV_CI_URL = (uaturl gf_test); $env:LIFTOFF_ENV_CI_ROLE = 'test'; liftoff -e ci info` | an environment that exists only as variables works | ☐ |
| 11.6 | `Remove-Item env:LIFTOFF_ENV_CI_*` | (clean-up) | ☐ |
| 11.7 | `liftoff settings --save` with `{"environments":[{"name":"qa","url":"sqlserver://localhost:61433;databaseName=gf_test;encrypt=true;trustServerCertificate=true","user":"sa","password":"Liftoff!Uat2026","role":"test","allow_clean":false,"shared":true}]}` on stdin | qa appears in `liftoff.toml`, **without** its password; the password goes to Windows Credential Manager (`cmdkey /list`); `liftoff -e qa test-connection` works | ☐ |
| 11.8 | `liftoff -e qa info "-url=jdbc:sqlserver://nohost;databaseName=x"` | a Flyway-style override for one run; fails to connect to nohost | ☐ |

---

## 12. Desktop app

In a window with env.ps1 loaded:

```powershell
cd apps\desktop; npm start
```

Reset the scenario named in each block first. Open its folder with **Open folder…** from
`$UatRoot`.

### 12a. Start page and new project (`greenfield`)

| # | do | expect | result |
| --- | --- | --- | --- |
| 12.1 | start the app | the start page, with the logo; Recent is empty or lists earlier folders | ☐ |
| 12.2 | **New project…** → SQL Server → folder `$UatRoot\greenfield` → **Create project** | the project opens on Environments | ☐ |
| 12.3 | **Add environment** → name dev, role dev, URL from `greenfield-environments.toml`, user sa, the password → **Test connection** → **Save** | `Connected`; dev is listed. The password is not in `liftoff.toml` | ☐ |
| 12.4 | add test and prod the same way; for one of them type `${env.LIFTOFF_UAT_PASSWORD}` as the password | it is kept as written in the file and works | ☐ |
| 12.5 | **Try the sample** (from the start page, into a new empty folder, SQL Server) | the sample opens with its 5 scripts | ☐ |

### 12b. Changes and scripts (`changes`)

| # | do | expect | result |
| --- | --- | --- | --- |
| 12.6 | make the 3.2 changes in ch_dev, then open **Changes** | 4 objects differ; each shows **Side by side** | ☐ |
| 12.7 | untick one; **Write migration…** with a description and **Also write an undo script** | only the ticked objects are in V0004; U0004 is written; **Review the migration** shows the SQL first | ☐ |
| 12.8 | drop a table in dev, then Changes | it is marked as possibly losing data; writing the migration shows **This migration may lose data** | ☐ |
| 12.9 | **Object history…** on customers | the git commits that changed it, with the change | ☐ |
| 12.10 | **Scripts** → **New script** | a hand-written script with the next number | ☐ |
| 12.11 | **Commit** | the changed files, a message box, **Commit**; then git log has it | ☐ |

### 12c. Environments and checks (`deploy`)

| # | do | expect | result |
| --- | --- | --- | --- |
| 12.12 | Environments → test | each script's state per environment | ☐ |
| 12.13 | add `V0004` and `V0005` files, then **Migrations** (run pending) on test | both run | ☐ |
| 12.14 | **Run this script only** on V0005 for prod | it says V0004 stays behind, then runs V0005 only | ☐ |
| 12.15 | the 4.2 hand change on prod, then **Checks** → **Check for drift** | drift on customers | ☐ |
| 12.16 | **Preview pending changes**, **Dry-run script**, **Save report…** | each works; the report opens | ☐ |

### 12d. Adopt and baseline (`adopt`)

| # | do | expect | result |
| --- | --- | --- | --- |
| 12.17 | create a SQL Server project in `$UatRoot\adopt` with the adopt environments | Environments lists them | ☐ |
| 12.18 | run migrations on prod | **Starting from an existing database?**: the adopt offer, with the captured schema | ☐ |
| 12.19 | adopt it, then run qa | the differences dialog lists customers and products; **Record anyway** records the baseline | ☐ |
| 12.20 | **Baseline…** on another database | sets the baseline at the version you type | ☐ |

### 12e. Flyway import (`flyway`)

| # | do | expect | result |
| --- | --- | --- | --- |
| 12.21 | **Open folder…** `$UatRoot\flyway` | it offers to convert the Flyway project (**Convert settings…**) | ☐ |
| 12.22 | convert with the suggested roles | the same result as 7.4–7.6, including the filter for Flyway's history table | ☐ |
| 12.23 | the history import (**Import**, Flyway history table) on production | a clear message that it is PostgreSQL only and to baseline instead; not a crash | ☐ |

### 12f. Compare, data compare, scripts, pipelines, settings

| # | do | expect | result |
| --- | --- | --- | --- |
| 12.24 | (`compare`) **Compare** → source dev, target test | the 7 differences; **Swap source and target** works | ☐ |
| 12.25 | **Save script…**, **Write migration…**, **Apply** (on test) | each works; Apply on prod asks you to type its name | ☐ |
| 12.26 | **Snapshot the source…**, then compare against the snapshot | works without the database | ☐ |
| 12.27 | (`data`) Compare → **Data** → source, target | the counts from § 9; **Hide tables that are the same**; click a count to page through the rows (**Previous**/**Next**); NULL styled | ☐ |
| 12.28 | untick **Delete rows only in the target**, **Save script…**, then **Apply** | the script has no DELETEs; apply works; prod needs its name typed | ☐ |
| 12.29 | (`branches`) **Scripts** → **Squash or rebaseline…** → up to version 3 | the same result as 10.7 | ☐ |
| 12.30 | **Pipelines** → GitHub Actions → test then prod | a workflow preview and the repository secrets to add; writes `.github\workflows\liftoff.yml` | ☐ |
| 12.31 | **Settings** → **Add filter** (leave out table `audit_*`) → **Save settings** | `liftoff.toml` has the filter; Changes and Compare ignore matching tables | ☐ |
| 12.32 | close and reopen the app | the project is under Recent | ☐ |

---

## 13. VS Code extension

Install it with `.\uat\setup.ps1 -VSCode -NoBuild`. Then, in a window with env.ps1 loaded,
`code $UatRoot\<scenario>`. The LiftOff rocket is in the activity bar.

| # | reset | do | expect | result |
| --- | --- | --- | --- | --- |
| 13.1 | greenfield | open the empty folder | the sidebar offers **Create LiftOff Project** | ☐ |
| 13.2 | greenfield | **New Project** → SQL Server | `liftoff.toml` created; the sidebar shows the project | ☐ |
| 13.3 | greenfield | the gear (**Project Settings**) → add dev, test and prod; a password in one, `${env.LIFTOFF_UAT_PASSWORD}` in another | a settings tab; saving writes `liftoff.toml` without the plain password; **Test Connection** works for both | ☐ |
| 13.4 | changes | the Environments view | every script per environment: applied, pending, failed or edited | ☐ |
| 13.5 | changes | open an applied script and edit it | a warning in the editor that it already ran | ☐ |
| 13.6 | deploy | add V0004 and V0005; environment menu → **Show the SQL That Would Run**, then **Run Pending Migrations** | the SQL in an editor, then both run | ☐ |
| 13.7 | deploy | right-click a pending script → **Run This Script Only** | warns which older scripts stay behind, then runs one | ☐ |
| 13.8 | deploy | **Validate**, **Check for Drift** (after the 4.2 hand change), **Show Log** | results in notifications; the log shows the CLI calls without passwords | ☐ |
| 13.9 | model | change md_dev (5.3); Schema Model view → **Compare Dev with Schema Model** | customers and tags listed | ☐ |
| 13.10 | model | click one (**Show the Difference**), then **Pull into Schema Model**, then **Pull All** | a diff editor; the files are written; Source Control shows them | ☐ |
| 13.11 | model | break a model file, then **Check Schema Model** | the error on the file that caused it, in Problems | ☐ |
| 13.12 | model | **Generate Migration from Schema Model** | the next V script, opened | ☐ |
| 13.13 | compare | **Compare…** → dev → test | the 7 differences; tick a few; **Show the Difference**, **Open the Sync Script**, **Write the Differences as a Migration**, **Apply to the Target** | ☐ |
| 13.14 | compare | **Swap Source and Target**, **Compare Again**, **Save a Snapshot…** | each works | ☐ |
| 13.15 | data | Compare view `…` → **Compare Data…** → source → target | the counts table; click a count to open the rows grid (100 per page, Previous/Next, changed cells marked, NULL styled) | ☐ |
| 13.16 | data | in the grid: open the script, then apply to target; then to prod | apply on prod asks you to type `prod` | ☐ |
| 13.17 | adopt | create the project, environments; run migrations on prod | it offers **Adopt Existing Database…**; afterwards B0001 is listed | ☐ |
| 13.18 | flyway | open the folder | the sidebar offers **Import Flyway Project**; the wizard: environments and roles, what does not carry over, then (on SQL Server) baseline instead of the history copy | ☐ |
| 13.19 | branches | **Rebaseline Project…** | the same result as 10.7 | ☐ |
| 13.20 | branches | **Set Up Pipeline** | writes the workflow, as in 10.16 | ☐ |
| 13.21 | any | settings `liftoff.cliPath`, `liftoff.devEnvironment`, `liftoff.checkModelOnSave`, `liftoff.generateUndo` | each changes the behaviour it names | ☐ |

---

## 14. Fixed while preparing this plan (2026-10-10)

Walking these scenarios on SQL Server found three bugs and two unhelpful messages. They are fixed in the same commit as
this plan; these steps check that they stay fixed.

| # | bug | check | result |
| --- | --- | --- | --- |
| 14.1 | `liftoff baseline` never ran: its own `--version` option (default `1`) was read as the program's `--version`, so it always printed `liftoff 0.1.0` | 6b and 7.10 baseline the database; `liftoff baseline --help` lists `--version <VERSION>` | ☐ |
| 14.2 | converting a Flyway project put `${env.X}` passwords into Windows Credential Manager as literal text, so those environments could not connect ("variable … is not set" while it was set) | 7.6 and 7.10 | ☐ |
| 14.3 | after converting a Flyway project, `generate` and `diff` listed Flyway's own history table, and the migration would have created it on every database | 7.14 | ☐ |
| 14.4 | the conversion's hint suggested `import-flyway-history` on SQL Server, which does not support it | 7.4 | ☐ |
| 14.5 | with no scratch environment, `diff` / `generate` did not say how to make one | 2.6 | ☐ |

Observations to judge during UAT (not bugs yet):

- **The scratch password.** `create-scratch` stores the dev password in Credential Manager for the
  scratch environment, even when dev uses `${env.X}`. If the variable changes later, scratch keeps
  the old password (2.8).
- **The `--skip-destructive` message.** When every change is destructive, it reports
  `2 difference(s)` and then `No differences; nothing written`. Clearer wording would help (3.11).
- **The repeatable after a Flyway baseline.** It runs once more after a Flyway baseline, since
  LiftOff has no record of it. Harmless for `CREATE OR ALTER`, but worth knowing (7.16).

---

## 15. Later: PostgreSQL

The same scenarios run on PostgreSQL with a `pg_` variant of the scripts. Add these, which only
apply there:

- **`CREATE INDEX CONCURRENTLY`** in a script runs outside a transaction and does not hang (the
  sample's V0003).
- **Through PgBouncer in transaction pooling:** `lock = "table"` in `liftoff.toml`, and two
  `migrate` runs at once: one waits, neither fails.
- **`import-flyway-history`:** copies Flyway's rows once; refuses edited scripts unless
  `--accept-edited`; refuses a second time.
- **Other object types:** extensions, enums and domains, sequences, `COMMENT ON`.
- **Schemas other than `public`,** and `filters` on them.
