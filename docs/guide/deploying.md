# Deploying

Deploying means running the pending scripts on an environment. Every command here takes
`-e <environment>`.

## See what is there: `info`

```
$ liftoff -e test info
Version          Description                      State           Ran on                   Took
0001             customers                        applied         2026-10-12T09:14:03Z     41 ms
0002             orders                           applied         2026-10-12T09:14:03Z     18 ms
0003             phone                            pending
(repeatable)     customer totals                  applied         2026-10-12T09:14:03Z      9 ms
```

The states are listed in [Concepts](concepts.md#the-history-table).

## Run the pending scripts: `migrate`

```sh
liftoff -e test migrate
```

runs every pending script in version order, then the repeatable scripts that changed, each in its
own transaction (see [Transactions](scripts.md#transactions)). It stops at the first script that
fails. Running it again when nothing is pending does nothing and succeeds.

Before it runs anything, `migrate` validates: if a script that ran was edited since, or a file is
missing, it refuses (exit 12) and says which. See [`validate`](#check-the-history-validate).

Two `migrate` runs on the same database at the same time do not collide: the second waits for
the first.

| option | what |
| --- | --- |
| `--dry-run` | print the SQL that would run, history inserts included; run nothing |
| `--target 5` | stop after version 5 |
| `--only 5` | run only this script: a version, a file name, or a repeatable script's name. Repeat it for more. See [Running one script](#running-one-script) |
| `--out-of-order` | also run scripts older than the latest applied one |
| `--rerun-repeatables` | run every repeatable script, changed or not |
| `--placeholder name=value` | a placeholder value for this run |
| `--allow-non-empty` | run every script on a database that has tables but no history (see below) |
| `--accept-differences`, `--scratch` | for databases checked against a baseline script; see [Existing databases](existing-databases.md) |

### A database with tables but no history

On a database that has objects but has never seen LiftOff, `migrate` refuses:

```
'prod' already has tables but no migration history. Baseline it first …
```

If the project has a baseline script, `migrate` checks the database against it instead; see
[Existing databases](existing-databases.md). `--allow-non-empty` runs every script anyway, for a
database whose existing tables have nothing to do with this project.

## Before a production deploy: `check`

```sh
liftoff -e prod check
```

does four things, without changing the database:

1. **Drift**: rebuilds the scratch database from the scripts prod has run, and compares prod
   with it. Anything different was changed outside the scripts.
2. **Pending changes**: what the pending scripts will change, object by object, with the
   changes that may lose data marked.
3. **The dry-run script**: the exact SQL `migrate` would run.
4. **Rules**: [the rules](rules.md) on the scripts still pending on prod.

```
Drift: none
Pending changes: 2
  added dbo.notes
  changed dbo.customers
-- V0004__notes.sql
BEGIN TRANSACTION;
…
```

`--drift`, `--changes`, `--dry-run` and `--rules` run one part only. `--report check.html` also writes the
result as one self-contained HTML page, to attach to a change request or keep from a pipeline.

`check` exits with **13 when drift is found** and **15 when a rule at error severity fires**, so a
pipeline stops before deploying.

### When there is drift

Someone changed the database outside the scripts. Decide which is right:
- **The change should stay:** make the same change in dev and write a migration
  (`liftoff generate`). Its `CREATE` or `ALTER` may then fail on prod, where the object already
  exists: edit the script to skip what is there (`IF NOT EXISTS`, `IF COL_LENGTH(…) IS NULL`), or
  remove the change from prod first.
- **The change should go:** undo it on the database by hand, or with
  `liftoff compare --source migrations --target prod --script fix.sql` (see [Compare](compare.md)).

## Check the history: `validate`

```sh
liftoff -e test validate
```

compares the history with the files and reports: scripts that failed, scripts edited after they
ran, files of applied scripts that are gone, and scripts older than the latest applied one that
never ran. Exit 12 if it finds any. `migrate` does the same check first.

## Fix the history: `repair`

```sh
liftoff -e test repair
```

- removes the rows of failed runs, so the fixed script can run again;
- accepts edited scripts: stores the current files' checksums;
- forgets applied scripts whose files were deleted.

It changes only the history table, never the schema. Use it when you know why `validate`
complains: you fixed a comment in an applied script, or deleted a script on purpose.

## Step back: `undo`

```sh
liftoff -e test undo
```

runs the undo script (`U…`) of the latest applied migration and marks that migration pending
again. See [Undo scripts](scripts.md#undo-scripts).

## Running one script

A hotfix has to go to production now, but older scripts are not ready:

```sh
liftoff -e prod migrate --only 7
```

runs `V0007` and nothing else, and says which older pending scripts it left behind. Those then
count as out of order: the next plain `migrate` refuses them until you run
`migrate --out-of-order` (or `--only` them too).

## Mark a script as applied: `mark-applied`

```sh
liftoff -e dev mark-applied V0005__phone.sql
```

records the script as run without running it. For a database that already has the script's
changes: the dev database it was written from, or one changed by hand the same way. The desktop app
has **Mark as applied…** next to each pending script, VS Code **Mark as Applied…** on its menu;
both ask first. If the database does not have the changes, the scripts after it may fail there,
and `check` shows what is missing as drift.

## Mark a database as being at a version: `baseline`

```sh
liftoff -e prod baseline --version 3 --description "before LiftOff"
```

writes a baseline row: prod is at version 3, and `V0001`–`V0003` never run there. For a database
that was brought up to date some other way, e.g. by another tool. See
[Existing databases](existing-databases.md).

## Erase a database: `clean`

```sh
liftoff -e test clean
```

drops every object in the project's schemas, the history table included. It is refused unless
the environment has `allow_clean = true` or the role `scratch`, so it cannot erase production by
accident. Useful to rebuild a test database from scratch: `clean`, then `migrate`.

## Exit codes

Every command exits with one of these, so scripts and pipelines can act on them:

| exit | means |
| --- | --- |
| 0 | it worked |
| 1 | a database, file or git error |
| 2 | wrong usage or configuration |
| 10 | could not connect |
| 11 | a migration script failed |
| 12 | refused: validation failed, the database differs from the baseline script, a script is numbered before the base branch, or the schema model does not build |
| 13 | drift found |
| 14 | the schema model has changes no migration makes |
| 15 | a rule at error severity fired on a script (`lint`, `check`; see [Rules](rules.md)) |

With `--output-type json`, every command prints one JSON object on stdout: `{"ok": true, …}`, or
`{"ok": false, "error": {"code": "…", "exit_code": 12, "message": "…"}}`. Progress messages go
to stderr.
