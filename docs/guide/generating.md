# Writing migrations from your changes

The everyday loop:

1. Change the dev database with whatever tool you like.
2. `liftoff diff` shows what changed.
3. `liftoff generate --description "…"` writes the next migration script.
4. Review the script, commit it, deploy it.

Both commands need a dev environment (role `dev`) and a scratch environment (role `scratch`).
`liftoff create-scratch` makes the scratch database if you have none.

## What `diff` compares

`diff` rebuilds the scratch database from the migration scripts, then compares dev with it. So
it shows what dev has that the scripts do not build, whatever has or has not been deployed
anywhere:

```
$ liftoff diff
Rebuilding scratch database…
3 difference(s)
  changed dbo.customers
  added dbo.notes
  removed dbo.old_orders  (may lose data)
```

`added` is in dev and not in the scripts; `removed` is in the scripts and no longer in dev;
`changed` is in both, but different.

Options:
- `--source <env>` / `--scratch <env>`: other environments than the first with role dev or
  scratch;
- `--from model`: compare the schema-model folder instead of the dev database (no dev database
  needed; see [The schema model](schema-model.md)).

## `generate`

```sh
liftoff generate --description "phone and notes"
```

writes `migrations/V0005__phone_and_notes.sql` with every difference, in an order that runs:
schemas and types first, tables before the foreign keys that point at them, functions before the
views and procedures that use them.

| option | what |
| --- | --- |
| `--dry-run` | print the script; write nothing |
| `--undo` | also write `U0005__phone_and_notes.sql`, which reverses it |
| `--record-on-dev` | also record the script as applied on dev, which already has the change. With `--from model`, only when dev does have it (checked; see below) |
| `--skip-destructive` | leave out changes that may lose data |
| `--from model` | from the schema-model folder instead of the dev database |
| `--source`, `--scratch` | other dev and scratch environments |

### Recording the script on dev

Dev already has the change: you made it there by hand. If the history on dev does not know that,
the next `liftoff -e dev migrate` would try to run the script on dev and fail (the table exists
already). So either:
- generate with `--record-on-dev`, or
- run `liftoff -e dev mark-applied V0005__phone_and_notes.sql` afterwards.

The apps do it for you: **Record it as applied on dev** is ticked in the desktop app's Changes.

**Written from the schema model, or from Compare**, the script may or may not be in dev already:
dev has it when the model was pulled from dev, not when you edited the model file. So LiftOff
checks. It builds the scripts, the new one included, on the scratch database and compares dev
with that:
- dev has every object the script changes, as the script makes it: the script is recorded on dev;
- dev is exactly what all the scripts build: every script still pending on dev is recorded (this
  also mends scripts written before, which dev still listed as pending);
- otherwise nothing is recorded, and the log says which objects dev does not have yet.

`generate --from model --record-on-dev` does this check, and so do VS Code's **Generate Migration
from Schema Model**, `compare --migration` and the desktop app's Compare.

## Changes that may lose data

Dropping a table or a column, or changing a column's type (narrowing `nvarchar(100)` to
`nvarchar(50)`, `bigint` to `int`), may lose data. LiftOff marks those:

```
warning: the script includes changes that may lose data
  removed dbo.notes  (may lose data)
  changed dbo.customers  (may lose data)
```

Read those lines carefully. If a drop is not what you meant (you renamed something), write that
part by hand: LiftOff sees a rename as a drop plus an add, and would lose the data. For example,
on SQL Server `EXEC sp_rename 'dbo.customers.mail', 'email', 'COLUMN';`, on the other engines
`ALTER TABLE customers RENAME COLUMN mail TO email;`.

`--skip-destructive` writes the script without those changes.

## What is compared

**SQL Server:** tables (columns, identity, computed columns, defaults), primary keys, unique,
check and foreign keys, indexes, views, procedures, functions, triggers, sequences and alias
types.

**PostgreSQL:** extensions, tables (columns, identity, serial, defaults, partitioning), primary
keys, unique, check, exclusion and foreign keys, indexes, views and materialized views, functions
and procedures, triggers, enums, domains, sequences, grants and comments.

**MySQL:** tables (columns, keys and indexes, foreign keys, checks, table options such as the
engine, character set and comment), views, procedures, functions and triggers. Everything is
compared without the database name and the definer, so dev, test and prod may be databases of
different names under different users.

**Oracle:** tables (columns, identity and virtual columns, defaults), primary keys, unique, check
and foreign keys, indexes (also on expressions), views, sequences, synonyms, procedures,
functions, packages and their bodies, object types and triggers. Constraint names Oracle made up
(`SYS_C…`) differ per database, so those are matched by what they say.

**SQLite:** tables (columns, constraints, `WITHOUT ROWID` and `STRICT`), their indexes, views and
triggers. SQLite's `ALTER TABLE` only adds, drops and renames columns, so a script that changes a
table in another way rebuilds it: a new table, the rows of the columns both have copied, the old
table dropped and the new one renamed, with foreign keys off and in one transaction. A change that
only adds or drops columns uses `ADD COLUMN` or `DROP COLUMN`.

Renames are not detected: a renamed object shows as one removed and one added.

Some objects are not compared yet. When the databases have any, `diff` and `compare` say so
(`not compared: synonyms (2)`), so nothing is left out silently:
- SQL Server: synonyms, table types, CLR objects, encrypted modules, columnstore, XML and spatial
  indexes, indexes on views, permissions, extended properties, column collations other than the
  database's;
- PostgreSQL: row-level security policies, rules, composite and range types, aggregates,
  operators, foreign tables, column-level privileges;
- MySQL: events, and routines the login may not read;
- Oracle: materialized views, database links, temporary tables, grants, comments;
- SQLite: virtual tables (full-text search and the like).

Write those in hand-written scripts (`liftoff add`).

Only the schemas listed in `schemas` in `liftoff.toml` are compared (on MySQL, Oracle and SQLite:
the database, schema or file the connection uses), and [filters](configuration.md#filters) leave
out more.

## Writing scripts by hand

Data changes, renames, and the objects above are written by hand:

```sh
liftoff add --description "backfill phone"
```

creates the next `V…` file, empty, for you to fill. See [Migration scripts](scripts.md).

## Capturing a whole database

`liftoff -e prod capture` writes everything a database has as the next migration;
`--as-baseline-script` as a baseline script; `--dry-run` prints it. Useful to look at, or as the
start of [an existing database](existing-databases.md).
