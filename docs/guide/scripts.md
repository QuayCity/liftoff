# Migration scripts

Migration scripts are plain SQL files in the `migrations/` folder (or the folder named by
`migrations` in `liftoff.toml`). Sub-folders are read too, so you can group them by release.

## Names

```
V0004__add_phone.sql
│ │    │ └─ description: words separated by _, shown as "add phone"
│ │    └─── two underscores
│ └──────── version
└────────── kind
```

| kind | name | runs |
| --- | --- | --- |
| versioned | `V0004__add_phone.sql` | once per database, in version order |
| undo | `U0004__add_phone.sql` | only by `liftoff undo`, to reverse `V0004` |
| repeatable | `R__customer_totals.sql` (no version) | after the versioned scripts, whenever its content changed since it last ran |
| baseline | `B0001__existing_schema.sql` | only on an empty database, instead of every script up to its version |

Files whose names do not follow this pattern are ignored, so a `README.md` or a `seed.sql` can
sit in the folder.

Rules:
- A version is numbers separated by `.` or `_`: `0004`, `1.2`, `2026_10_12`. `1.10` comes after
  `1.9`; `0004` and `4` are the same version.
- Two versioned scripts (or two undo, or two baseline scripts) may not share a version.
- The description is at most 200 characters; the file must be UTF-8.

## Numbering

LiftOff numbers new scripts with four digits: `V0001`, `V0002`, and so on. `generate`, `add`,
`capture` and the apps pick the next number for you:

- after `V0009` comes `V0010`; a baseline script counts too, so after `B0150` comes `V0151`;
- a dotted version goes up in its last part: after `V1.9` comes `V1.10`;
- a project that already uses timestamps (`V20261012.1405`, common in Flyway projects) keeps
  getting timestamps.

From `V9990` on, `migrate` and the apps suggest `liftoff rebaseline --restart`, which replaces
everything with a new `B0001` so the numbering can start again (see
[Teams, branches and pipelines](teams-and-pipelines.md#starting-the-numbering-again)).

Two people on two branches can both write a `V0005`. `liftoff renumber` sorts that out; see
[Teams, branches and pipelines](teams-and-pipelines.md#branches).

## Never edit a script that has run

Each database's history table holds a checksum of every script that ran there. Edit the file
afterwards, and `validate`, `migrate` and `info` notice:

```
V0002__orders.sql changed after it was applied (checksum mismatch)
```

and `migrate` refuses to run until it is sorted out. Put the change in a new script instead.

If the edit was harmless (a comment, formatting) and you want to keep it, `liftoff -e test repair`
accepts the edited file on test. Do that on every environment that ran it.

The checksum ignores line endings and a UTF-8 byte-order mark, so a Windows and a Linux checkout
of the same file match. It is the same checksum Flyway stores.

## Transactions

### SQL Server

A script runs as **one transaction**: if any batch fails, everything the script did is rolled
back, nothing is recorded, and the script stays pending. Fix it and run `migrate` again.

Batches are separated by a line with only `GO`, as in SSMS and sqlcmd. `GO 5` runs the batch five
times. Objects that must be first in their batch (`CREATE PROCEDURE`, `CREATE VIEW`,
`CREATE TRIGGER`, `CREATE FUNCTION`) need a `GO` before them; generated scripts have them.

A script holding a statement that cannot run in a transaction (`CREATE DATABASE`,
`ALTER DATABASE`, `BACKUP`, `RESTORE`, `RECONFIGURE`, full-text catalog changes) runs without one.
Keep such statements in a script of their own.

### PostgreSQL

A script runs as **one transaction**, so a failure leaves nothing behind.

A script holding `CONCURRENTLY`, `VACUUM`, `CREATE DATABASE`, `DROP DATABASE`, `ALTER SYSTEM` or a
tablespace change runs **without** a transaction, one statement at a time, because PostgreSQL
refuses those inside one. If such a script fails halfway, the statements before the failure stay
done and the script is recorded as failed. Make each statement safe to run twice
(`CREATE INDEX CONCURRENTLY IF NOT EXISTS …`), fix the script, and run `liftoff -e test repair`
then `migrate`. Keep such statements in a script of their own.

Waiting for the migration lock never holds a transaction open, so `CREATE INDEX CONCURRENTLY` does
not hang behind LiftOff itself.

## Repeatable scripts

`R__name.sql` holds something you would rather redefine in full each time: a view, a function,
a procedure, grants. It runs after the versioned scripts, in name order, whenever its content
changed since it last ran. Write it so it can run again:

```sql
-- SQL Server
CREATE OR ALTER VIEW dbo.customer_totals AS
SELECT c.id, COUNT(o.id) AS orders FROM dbo.customers c LEFT JOIN dbo.orders o ON o.customer_id = c.id GROUP BY c.id;
```

```sql
-- PostgreSQL
CREATE OR REPLACE VIEW customer_totals AS
SELECT c.id, count(o.id) AS orders FROM customers c LEFT JOIN orders o ON o.customer_id = c.id GROUP BY c.id;
```

`migrate --rerun-repeatables` runs them all again even if they did not change.

## Undo scripts

`U0004__add_phone.sql` reverses `V0004__add_phone.sql`. `generate --undo` writes one with the
migration. `liftoff -e test undo` runs the undo script of the latest applied migration and marks
that migration pending again. Run it again to undo the one before, as long as it has an undo
script.

An undo script cannot bring back data: undoing `ADD COLUMN` drops the column and what was in it.
Use undo on dev and test environments to step back while working; on production, a new
migration that fixes the problem is usually safer.

## Baseline scripts

`B0003__baseline.sql` holds the whole schema as of version 3. On an **empty** database,
`migrate` runs the latest baseline script instead of every script up to its version, then
continues with `V0004`. A database that already ran `V0001`–`V0003` skips it.

Baseline scripts are written for you:

| command | writes |
| --- | --- |
| `liftoff -e prod adopt` | `B0001` from an existing database |
| `liftoff capture --as-baseline-script` | a baseline script from a database, without recording anything |
| `liftoff squash` | a baseline script from the versioned scripts; the old scripts stay |
| `liftoff rebaseline` | the same, checked to build the same schema, and the old scripts taken out |
| `liftoff rebaseline --restart` | `B0001` holding everything; numbering starts again |

A baseline script with the line `-- liftoff:restart` restarts the numbering: see
[Teams, branches and pipelines](teams-and-pipelines.md#starting-the-numbering-again).

## Writing a script by hand

```sh
liftoff add --description "seed statuses"            # migrations/V0005__seed_statuses.sql, empty
liftoff add --description "seed" --from-file seed.sql
liftoff add --description "grants" --repeatable      # migrations/R__grants.sql
```

Data changes (filling a new column, seeding a lookup table) are hand-written scripts, or lines
added to a generated one before it runs anywhere.

## Placeholders

`${name}` in a script is replaced when it runs; see
[Placeholders](configuration.md#placeholders).

## Where the script header comes from

Generated scripts start with a comment saying LiftOff wrote them and from what. It is an
ordinary comment: edit or remove it before the script runs anywhere.
