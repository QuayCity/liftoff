# The schema model

The schema model is the `schema-model/` folder: one file per database object, each holding that
object's `CREATE` statement.

```
schema-model/
  dbo/
    tables/
      customers.sql
      orders.sql
    views/
      customer_totals.sql
    procedures/
      add_customer.sql
    functions/
    triggers/
    sequences/
    types/
```

On PostgreSQL there are also `extensions/`, `domains/` and `materialized-views/`.

It is optional. Migration scripts say how to get from one version to the next; the model says
what each object looks like now. With both in git:
- `git log schema-model/dbo/tables/customers.sql` is the history of one table;
- a pull request shows the change to the table itself next to the migration script;
- you can make small changes by editing a file, instead of changing a database.

## Fill it and keep it up to date: `model`

```sh
liftoff model            # write dev into schema-model/
liftoff model --status   # list what differs; write nothing
liftoff model --path dbo/tables/customers.sql     # only this file (repeatable)
```

`model` compares the dev database with the folder and writes the files that differ: new objects
get a file, changed objects get their file rewritten, dropped objects lose theirs. Commit the
result like any other change.

`--source <env>` reads another environment than the first with role `dev`.

## Two ways to work

### Change dev, then pull into the model

1. Change the dev database.
2. `liftoff model` (or **Pull into Schema Model** in VS Code, **Save to model** in the desktop
   app).
3. `liftoff generate --description "…"` writes the migration, as usual.
4. Commit the model files and the script together.

### Change the model, then generate

1. Edit a file in `schema-model/`: add a column to `customers.sql`.
2. `liftoff model --check` builds the whole folder on the scratch database and reports any file
   that does not build (exit 12), naming it.
3. `liftoff diff --from model` shows the change; `liftoff generate --from model --description "…"`
   writes the migration. No dev database needed.
4. Commit the model file and the script together.

## Is every model change in a script? `check --model`

```sh
liftoff check --model
```

compares the model with what the migrations build, and fails (exit 14) when the model has a
change no script makes. Run it on pull requests so nobody changes the model and forgets the
script. `liftoff ci --model check` adds it to the generated workflow; `--model generate` goes
further and writes the missing script in the pull request for you. See
[Teams, branches and pipelines](teams-and-pipelines.md#pipelines).

## Comparing with the model

`model` is also a side for [Compare](compare.md):

```sh
liftoff compare --source model --target test
```

shows how test differs from the model.

## Notes

- The files are compared as text with what LiftOff would write for the object, so formatting your
  own way shows as a change on the next `model --status`. Let `model` write the files, or accept
  its formatting after an edit.
- Filters and `schemas` in `liftoff.toml` apply: objects left out of comparisons get no file.
- Data is not part of the model.
