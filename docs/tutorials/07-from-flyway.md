# Tutorial 7: moving a Flyway project

You have a Flyway project: a `flyway.toml`, a `sql/` folder with `V1__…`, `V2__…` scripts, and
databases that ran them. This tutorial carries it over to LiftOff. Your scripts keep their names
and checksums, your databases keep what they ran, and the Flyway files stay as they are.

It takes about 15 minutes. The command line is shown; the desktop app (**Open folder…** →
**Convert settings…**) and VS Code (**Import Flyway Project**) walk through the same steps.

## Before you start

- **`liftoff` is installed.**
- **The Flyway project is committed to git**, so you can see exactly what LiftOff adds.
- You know **each database's current Flyway version**: `flyway info` shows it.

The example project has environments `development`, `shadow`, `test` and `production`, scripts
`V1`–`V3` and a repeatable `R__customer_totals.sql`, and a `${tableOwner}` placeholder.
Production and development are at V3; test is at V2.

## Step 1: preview the conversion

In the project folder:

```sh
liftoff init --from-flyway --preview
```

```
Would convert …/flyway.toml (nothing written):
  migrations: sql   schemas: dbo   Flyway history table: flyway_schema_history
  environments:
    development      dev      sqlserver://db1:1433;databaseName=shop_dev;encrypt=true
    production       prod     sqlserver://db1:1433;databaseName=shop;encrypt=true
    shadow           scratch  sqlserver://db1:1433;databaseName=shop_shadow;encrypt=true
    test             test     sqlserver://db1:1433;databaseName=shop_test;encrypt=true
  note: flyway_schema_history is left out of comparisons (a filter in liftoff.toml), so no migration creates or drops it
  not converted: baselineOnMigrate = true: use `liftoff baseline` once per database instead
  not converted: validateOnMigrate = true: a per-run option in LiftOff; pass it on the command line
```

Check the roles. LiftOff guesses them from the names; a name it does not recognise becomes
`test`. Correct one with `--role live=prod` (repeatable). The **not converted** lines say what has
no LiftOff equivalent and why. Passwords are never shown.

## Step 2: convert

```sh
liftoff init --from-flyway
```

```
Converted …/flyway.toml into …/liftoff.toml
  environments: development, production, shadow, test
  migrations: sql   schemas: dbo
  note: flyway_schema_history is left out of comparisons (a filter in liftoff.toml), so no migration creates or drops it
  not converted: baselineOnMigrate = true: use `liftoff baseline` once per database instead
  not converted: validateOnMigrate = true: a per-run option in LiftOff; pass it on the command line
Next, per database that already ran the scripts: liftoff -e <environment> baseline --version <the latest version it ran>
```

On PostgreSQL the last line points at `import-flyway-history` instead.

What you get:

- `liftoff.toml`: `migrations = "sql"`, the schemas, `[project.placeholders] tableOwner = "dbo"`,
  the four environments with their URL, user and role, `allow_clean` from `cleanDisabled`, and a
  filter that leaves Flyway's history table out of every comparison.
- `liftoff.user.toml` (git-ignored): passwords written as `${env.X}` in Flyway's config are kept
  as references; typed passwords go to your operating system's keychain.
- `flyway.toml` and `sql/` are unchanged: `git status` shows only new files.

Review `liftoff.toml` and commit it.

## Step 3: tell LiftOff where each database is

LiftOff keeps its own history table, `liftoff_schema_history`, next to Flyway's.

**On PostgreSQL**, copy Flyway's history once per database:

```sh
liftoff -e production import-flyway-history
liftoff -e development import-flyway-history
liftoff -e test import-flyway-history
```

It refuses if a script was edited after it ran; `--accept-edited` imports anyway with the current
checksums.

**On SQL Server**, copying the history is not supported yet. Mark each database at its Flyway
version instead:

```sh
liftoff -e production baseline --version 3 --description "from Flyway"
liftoff -e development baseline --version 3 --description "from Flyway"
liftoff -e test baseline --version 2 --description "from Flyway"
```

```
production is now at baseline 3
```

```sh
liftoff -e production info
```

shows V1–V3 as `belowbaseline` (never run again there) and the repeatable script pending.

## Step 4: carry on

```sh
liftoff -e test migrate
```

runs V3 and the repeatable on test, with `${tableOwner}` replaced as before. On production and
development, the first `migrate` runs only the repeatable script, once, since LiftOff has no
record of it yet; that is harmless when it is written to run again (`CREATE OR ALTER`).

From now on, the everyday loop of [tutorial 1](01-new-project-cli.md) applies. Change
development, then:

```sh
liftoff diff
liftoff generate --description "order date"
```

```
Wrote …\sql\V0004__order_date.sql
```

The new script comes after `V3`, with four digits from now on. Flyway's history table is never
listed in `diff`, and never touched.

## Step 5: the pipeline and the team

- Replace the Flyway steps in your pipeline with `liftoff -e <env> migrate` (and
  `liftoff -e <env> check --drift` before it), or let `liftoff ci` write a GitHub Actions
  workflow. Passwords come from `LIFTOFF_ENV_<NAME>_PASSWORD` secrets.
- Teammates pull the commit, set their password variables (or type them once in an app), and
  carry on. Their own dev database goes in `liftoff.user.toml`.
- Flyway-style arguments still work for the common options during the move:
  `liftoff info -url=… -user=… "-locations=filesystem:sql"`.

## What you did

| step | command |
| --- | --- |
| look before converting | `liftoff init --from-flyway --preview` |
| convert the settings | `liftoff init --from-flyway` |
| the history, PostgreSQL | `liftoff -e <env> import-flyway-history` |
| the history, SQL Server | `liftoff -e <env> baseline --version <n>` |
| carry on | `liftoff diff`, `generate`, `migrate` |

More detail: [Moving from Flyway](../guide/flyway.md).
