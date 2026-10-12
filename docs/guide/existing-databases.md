# Existing databases

Most projects do not start from nothing. The database is already in production, with years of
tables, views and procedures, and copies of it in test and acceptance that are almost, but not
quite, the same. This page explains how LiftOff takes over such a database. For a walk-through,
see [tutorial 4](../tutorials/04-existing-database-cli.md) (command line),
[5](../tutorials/05-existing-database-desktop.md) (desktop app) or
[6](../tutorials/06-existing-database-vscode.md) (VS Code).

## The idea

1. Pick the database that is **right**: usually production.
2. **Capture** everything it has into one baseline script, `B0001`.
3. **Record** that production is at `B0001`, without running anything there.
4. Every other database is **checked** against `B0001` when it first meets LiftOff.
5. New work starts at `V0002`, the normal way.

`liftoff adopt` does steps 2 and 3. Step 4 happens on each environment's first `migrate`.

## `adopt`

```sh
liftoff -e prod adopt
```

1. Reads every object in the project's schemas on prod (filters apply) and writes
   `migrations/B0001__existing_schema.sql`, in an order that runs.
2. Builds `B0001` on the scratch database and compares the result with prod. It must match
   exactly: that proves the capture is complete. If it does not match, nothing is kept and the
   differences are listed.
3. Creates the history table on prod and records `B0001` as applied there. Nothing else on prod
   changes; its data is not touched.

It needs a scratch environment, and works only in a project without scripts.

`--description` changes the file name; `--scratch` names another scratch environment.

## The other environments

When `liftoff -e test migrate` meets a database with objects and no history, and the project has
a baseline script, it builds the baseline script on the scratch database and compares the two.
There are four outcomes:

| the database | what happens |
| --- | --- |
| has exactly what `B0001` has | `B0001` is recorded; nothing runs |
| lacks some objects (a view, a procedure) | the missing objects are created, then `B0001` is recorded |
| has objects that differ (a column of another length, an extra column), or objects `B0001` does not have | it stops (exit 12), lists the differences and changes nothing |
| is empty | it is built from `B0001`, like any new database |

When it stops on differences, decide per object:
- **The environment is wrong**: fix it by hand, or with `liftoff compare --source migrations
  --target qa --script fix.sql` (review the script first; see [Compare](compare.md)). Then run
  `migrate` again.
- **The difference does not matter (yet)**: `liftoff -e qa migrate --accept-differences` records
  `B0001` anyway. The differences stay, and `liftoff -e qa check` reports them as drift until
  they are fixed.

Then `migrate` carries on with any `V` scripts after `B0001`.

## The dev database

You need a dev database to change. Two good ways:

- **A fresh one, built from `B0001`:** create an empty database, add it as the `dev` environment,
  and run `liftoff -e dev migrate`. You get the schema without production's data; add test data
  with a hand-written script or data compare.
- **A copy you already have** (a restored backup, an existing dev database): add it as `dev` and
  run `liftoff -e dev migrate`, which checks it against `B0001` like any other environment.

## The schema model

Once dev is at `B0001`, fill the schema model from it:

```sh
liftoff model
```

writes one file per object into `schema-model/`. Commit it with `B0001`. See
[The schema model](schema-model.md).

## Doing it by hand

`adopt` is the safe path, but the pieces are available on their own:

| command | does |
| --- | --- |
| `liftoff -e prod capture --as-baseline-script` | writes the baseline script, records nothing, checks nothing |
| `liftoff -e prod capture` | the same as a `V` script |
| `liftoff -e prod baseline --version 1` | records prod as being at version 1, without a script |
| `liftoff -e prod migrate --allow-non-empty` | ignores the existing objects and runs every script |

`baseline` suits a database that already matches your scripts up to some version (for example,
one managed by another tool until now): the scripts up to that version are never run there.

## Production you cannot write to

`adopt` creates the history table on prod. If LiftOff may not write to production, adopt a
restored copy of it instead: `liftoff -e prodcopy adopt`, then run `liftoff -e prod migrate` from
the pipeline that is allowed to. It is checked against `B0001` and recorded.

## Moving from another migration tool

If the database was managed by Flyway, convert the project instead of adopting: the scripts and
their history carry over. See [Moving from Flyway](flyway.md).
