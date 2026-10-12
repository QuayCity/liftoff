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
| `--record-on-dev` | also record the script as applied on dev, which already has the change |
| `--skip-destructive` | leave out changes that may lose data |
| `--from model` | from the schema-model folder instead of the dev database |
| `--source`, `--scratch` | other dev and scratch environments |

### Recording the script on dev

Dev already has the change: you made it there by hand. If the history on dev does not know that,
the next `liftoff -e dev migrate` would try to run the script on dev and fail (the table exists
already). So either:
- generate with `--record-on-dev`, or
- run `liftoff -e dev mark-applied V0005__phone_and_notes.sql` afterwards.

The apps tick **Record it as applied on dev** for you.

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
on SQL Server `EXEC sp_rename 'dbo.customers.mail', 'email', 'COLUMN';`, on PostgreSQL
`ALTER TABLE customers RENAME COLUMN mail TO email;`.

`--skip-destructive` writes the script without those changes.

## What is compared

**SQL Server:** tables (columns, identity, computed columns, defaults), primary keys, unique,
check and foreign keys, indexes, views, procedures, functions, triggers, sequences and alias
types.

**PostgreSQL:** extensions, tables (columns, identity, serial, defaults, partitioning), primary
keys, unique, check, exclusion and foreign keys, indexes, views and materialized views, functions
and procedures, triggers, enums, domains, sequences, grants and comments.

Renames are not detected: a renamed object shows as one removed and one added.

Some objects are not compared yet. When the databases have any, `diff` and `compare` say so
(`not compared: synonyms (2)`), so nothing is left out silently:
- SQL Server: synonyms, table types, CLR objects, encrypted modules, columnstore, XML and spatial
  indexes, indexes on views, permissions, extended properties, column collations other than the
  database's;
- PostgreSQL: row-level security policies, rules, composite and range types, aggregates,
  operators, foreign tables, column-level privileges.

Write those in hand-written scripts (`liftoff add`).

Only the schemas listed in `schemas` in `liftoff.toml` are compared, and
[filters](configuration.md#filters) leave out more.

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
