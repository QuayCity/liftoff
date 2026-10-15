# Concepts

The ideas behind LiftOff, in the order you meet them. Every other page assumes these.

## The project

A **project** is a folder, usually a git repository or a folder inside one. It holds:

| file or folder | what | in git? |
| --- | --- | --- |
| `liftoff.toml` | the project settings and the shared environments | yes |
| `liftoff.user.toml` | your own environments and settings, for this computer only | no (`liftoff init` adds it to `.gitignore`) |
| `migrations/` | the migration scripts: the truth about what every database should look like | yes |
| `schema-model/` | optional: one file per database object, so git shows each table's history | yes |

`liftoff init` creates all of these. Every command works on the project in the current folder;
`-C <folder>` points at another one.

## Migration scripts

A **migration** is a plain SQL file that changes a schema from one version to the next:

```
migrations/
  V0001__customers.sql         versioned: runs once, in order
  V0002__orders.sql
  U0002__orders.sql            undo: reverses V0002
  R__customer_totals.sql       repeatable: runs again whenever the file changes
  B0001__existing_schema.sql   baseline: where empty databases start
```

Every database is built by running the scripts in order. Once a script has run somewhere, it is
never edited again: the next change is a new script. That way every database goes through the
same steps and ends up the same. [Migration scripts](scripts.md) has the details.

You rarely write them yourself. You change the **dev database** with whatever tool you like
(pgAdmin, psql, SSMS, MySQL Workbench, SQL Developer, DB Browser for SQLite, an ORM), and `liftoff generate` writes the script by
comparing dev with what the existing scripts build. You review it like any other code.

## Environments and roles

An **environment** is one database that the project knows by name: `dev`, `test`, `prod`, or any
name you choose. Each has a connection URL, a user and a password, and a **role**:

| role | what LiftOff does with it |
| --- | --- |
| `dev` | the database you change by hand. `diff`, `generate` and `model` read it. |
| `scratch` | an empty database that LiftOff erases and rebuilds from the scripts whenever it needs to know what they build. Never put data you want to keep in it. |
| `test` | a database the scripts are deployed to. Anything that is not dev, scratch or production. |
| `prod` | the same as test, plus extra care: applying a compare to it needs `--confirm-production` on the command line, or typing its name in the apps. |

Most commands take `-e <environment>` to say which database to work on.

## The scratch database

To write a migration, LiftOff has to know two things: what dev looks like, and what the
existing scripts build. The second it finds out by running the scripts on an empty database, the
**scratch** database, and reading the result. It does the same for drift checks, for comparing
with `migrations`, for checking a baseline script, and for checking that the schema model builds.

Any empty database you are allowed to erase will do. It can live on the same server as dev:
`liftoff create-scratch` makes one next to the dev database and saves it as an environment. On
SQLite it is a file next to the dev file; on Oracle, where a schema is a user, it is a user of its
own that a DBA creates.

## The history table

Every database the scripts run on gets a table, `liftoff_schema_history` (in `public` on
PostgreSQL and `dbo` on SQL Server, unless you choose another schema; on MySQL in the database the
URL names, on Oracle in the signed-in user's schema, on SQLite in the file), with one row per
script that ran:
its version, file name, checksum, who ran it, when, how long it took and whether it worked.

That table is how LiftOff knows what is **pending** on each database. It is also how it notices
a script that was **edited after it ran**: the checksum no longer matches the file.

`liftoff -e test info` lists every script and its state on test:

| state | means |
| --- | --- |
| pending | not run here yet; the next `migrate` runs it |
| applied | ran and worked. `applied (changed!)`: the file was edited after it ran |
| failed | ran and failed, part-way: a script that ran outside a transaction (on PostgreSQL one with `CONCURRENTLY`; on MySQL and Oracle any script with DDL) can leave this. `repair` clears it |
| outdated | a repeatable script whose file changed since it ran; the next `migrate` runs it again |
| ignored | older than the latest applied script; `migrate --out-of-order` runs it |
| missing | ran here, but the file is gone |
| future | ran here, and is newer than any file you have (another branch ran it) |
| baseline | a baseline row: the database was marked as being at this version |
| belowbaseline | covered by a baseline: never runs here |
| excluded | not for this environment ([`-- liftoff:for`](scripts.md#scripts-for-some-environments-only)): never runs here |

## The activity table

Next to the history table is `liftoff_schema_history_activity` (the history table's name plus
`_activity`), with one row per **run** rather than per script: every `migrate`, `undo`, `repair`,
`baseline`, `mark-applied` and `clean` that changed something, and every one that failed or was
refused. A row says:

- when it ran, how long it took, and whether it worked (the database's error when it did not);
- who ran it: the database user, and the user and computer it ran from;
- the pipeline run's page when it ran in GitHub Actions, Azure DevOps, GitLab or Jenkins (read
  from the variables those set), and the git commit of the project;
- the scripts it ran, and how it was asked to run (`--only 5`, `--topic JIRA-142`);
- its **deployment id**, which `migrate` also prints and returns in its JSON (`deployment_id`).

A `migrate` with nothing to do and a dry run leave no row. The history table is not changed by
any of this, so it stays as it was. LiftOff's own tables are never part of a comparison, drift
or a baseline check. `clean` erases the activity table with everything else, and writes the
clean as its first row again.

[`liftoff activity`](deploying.md#what-ran-where-activity) and the desktop app's
[Overview](desktop-app.md#overview) read it.

## Baselines

A **baseline** says "this database already has everything up to here". There are two kinds.

- **A baseline script** (`B0001__….sql`) holds the whole schema at one point. Empty databases are
  built from it instead of from the scripts before it. Databases that already ran those scripts
  skip it. `adopt`, `squash` and `rebaseline` write one.
- **A baseline row**, from `liftoff -e prod baseline --version 3`: a history row that says prod
  is already at version 3 without any script. For databases that were brought up to date some
  other way.

## Existing databases

A database that was never under a migration tool has objects but no history table. LiftOff does
not run scripts on it until you say how it relates to them, because running `CREATE TABLE
customers` on a database that already has `customers` would fail halfway.

`liftoff -e prod adopt` captures everything prod has into `B0001`, checks on the scratch database
that `B0001` rebuilds exactly that, and records prod as being at `B0001`. Every other environment
that already has objects is checked against `B0001` on its next `migrate`. See
[Existing databases](existing-databases.md).

## Drift

**Drift** is a difference between a database and what its applied scripts build: a column added
by hand on production, an index someone dropped. `liftoff -e prod check` finds it before a
deploy, so a script is never run on a database that is not what you think it is.

## The schema model

The **schema model** is the `schema-model/` folder: one `CREATE` statement per object, in a file
per object (`tables/dbo.customers.sql`). It is optional. With it, git shows the history of each
table, view and function, and pull requests show the change to the object itself instead of only
the migration script. LiftOff can write migrations from the model as well as from dev. See
[The schema model](schema-model.md).

## Compare

**Compare** shows how two schemas differ, of any two sides: two environments, the schema model,
what the migrations build, a saved snapshot or any database by URL. It then writes a script that
makes one like the other. **Data compare** does the same for the rows of two databases. See
[Compare](compare.md).

## Three ways in

Everything is in the `liftoff` command-line program. The **desktop app** and the **VS Code
extension** run that same program, so a project made in one opens in the others, and what you can
do in an app you can also script in a pipeline. Every command answers in JSON with
`--output-type json`.
