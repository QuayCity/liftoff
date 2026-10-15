# Compare

Compare shows how two things differ, then writes the script that makes one like the other.
**Schema compare** works on the structure (tables, views, procedures, …); **data compare** on the
rows.

## Schema compare

```sh
liftoff compare --source dev --target test
```

```
test -> dev (SQL Server): 4 difference(s)
  added    table:dbo.suppliers
  changed  table:dbo.customers
  changed  table:dbo.orders  (may lose data)
  removed  table:dbo.old_notes  (may lose data)
```

The **source** is what it should look like; the **target** is what would be changed. `added`
means the source has it and the target does not.

### Sides

A side can be any of these:

| side | is |
| --- | --- |
| `test` | an environment from the project |
| `sqlserver://…` or `postgres://…` | any database by URL (the output never prints a password) |
| `migrations` | what the migration scripts build, on the scratch database |
| `model` | the schema-model folder, built on the scratch database |
| `snapshot:prod.json` | a schema saved earlier with `liftoff snapshot` |

Some useful pairs:

| `--source` | `--target` | answers |
| --- | --- | --- |
| `dev` | `migrations` | what dev has that no script makes (the same as `liftoff diff`) |
| `migrations` | `prod` | how prod differs from its scripts: drift, and pending changes |
| `test` | `prod` | how two environments differ |
| `model` | `dev` | what dev has that the model does not, the other way round |
| `snapshot:before.json` | `prod` | what changed on prod since the snapshot |

### What to do with the differences

| option | does |
| --- | --- |
| `--object table:dbo.suppliers` | only this difference (repeatable). The ids are as listed |
| `--script sync.sql` | write a script that makes the target like the source (`-` prints it) |
| `--migration "add suppliers"` | write the differences as the next migration script; `--undo` adds the undo script |
| `--apply` | run the differences on the target now |
| `--confirm-production` | needed with `--apply` when the target's role is `prod` |

`--apply` changes the target **outside its migration history**: the history does not know, so
the database now differs from its scripts and `check` reports drift. Use it to fix a test
database, or with `--migration` for the scripts. For production, prefer writing a migration.

### Snapshots

```sh
liftoff snapshot --of prod --out prod-2026-10-12.json
```

saves prod's schema to a file (default `snapshots/<side>-<date>.json`). Compare with it later,
without a connection to the original: before and after a release, or a database you can no
longer reach. `--of` takes any side, including `model` and `migrations`.

## Data compare

```sh
liftoff data-compare --source test --target acceptance
```

```
acceptance -> test (SQL Server), 2.4 s
  dbo.customers: 30 only in the source, 20 only in the target, 25 different (10000 / 9990 rows)
  dbo.events: 0 only in the source, 0 only in the target, 3 different (200000 / 200000 rows)
  dbo.page_views: 13 only in the source, 8 only in the target, 0 different (50000 / 49995 rows); no key, whole rows compared
  dbo.products: same (40 / 40 rows)
```

It compares every table the two databases share (in the project's schemas, filters applied), or
only `--table dbo.customers` (repeatable). Sides are environments or URLs.

### How rows are matched

- **By key.** A table's primary key, or else its smallest unique index on columns that cannot be
  NULL. A row with the same key on both sides is either the same or *different*.
- **Tables without a key (heaps)** are compared as whole rows, duplicates included: a table with
  three copies of a row on one side and one on the other differs by two copies. A changed row
  shows as one *only in source* and one *only in target*, since there is no key to pair them.

Only the columns both sides have are compared. A table that exists on one side only, or whose key
columns differ between the sides, is listed as not compared with the reason; compare the
schemas first.

Per engine:
- **Oracle**: CLOB, BLOB, LONG and XML columns are not compared, and an empty text is NULL in
  Oracle, so the two cannot differ. A table whose identity column is `GENERATED ALWAYS` cannot
  take its rows with their ids: Oracle refuses it.
- **SQLite**: values are shown as SQLite literals (`'text'`, `42`, `X'00ff'`). SQLite keeps a
  type per value, so the integer `42` and the text `'42'` are different values.
- **MySQL and SQLite** tables go by their name alone (`customers`), the others by
  `schema.table`.

### Fast on big tables

LiftOff does not read whole tables. Each side hashes its rows in the database, in groups; only
groups whose hashes differ are looked at more closely, and only the differing rows are read in
full. A 1,000,000-row table with a few differences compares in seconds; the time grows with the
size of the table, and the script and apply steps with the number of differences. See the
[benchmark](../data-compare-benchmark.md) for numbers.

### Looking at the rows

```sh
liftoff data-compare --source test --target acceptance --rows dbo.customers
liftoff data-compare … --rows dbo.customers --kind only_in_source --offset 50 --limit 50
```

`--kind` is `different` (the default), `only_in_source` or `only_in_target`. Rows of a heap are
labelled `row 1`, `row 2`, … since there is no key to show.

### The sync script

```sh
liftoff data-compare --source test --target acceptance --script sync.sql
```

writes the `INSERT`, `UPDATE` and `DELETE` statements that make the target's rows match the
source's (`-` prints them).

- `--no-insert`, `--no-update`, `--no-delete` leave out rows only in the source, rows that
  differ, or rows only in the target.
- SQL Server identity columns are inserted with `SET IDENTITY_INSERT … ON`, PostgreSQL ones with
  `OVERRIDING SYSTEM VALUE`.
- Rows of a heap are deleted by their content, one copy at a time, with the row's values in a
  comment above the statement.

`--apply` runs the same statements on the target, in one transaction; with a production target it
needs `--confirm-production`.

### Comparing once, looking many times

On big tables, save the result and work from it without comparing again:

```sh
liftoff data-compare --source test --target acceptance --save-diff diff.json
liftoff data-compare --source test --target acceptance --from-diff diff.json --rows dbo.events
liftoff data-compare --source test --target acceptance --from-diff diff.json --script sync.sql
```

The file holds the side labels and the keys of the differing rows, never URLs or passwords. The
same `--source` and `--target` must be given; they are checked against the file. The rows
themselves are read again when shown, so they are current.

## In the apps

The desktop app's **Compare** screen and VS Code's **Compare** view do all of this with clicks:
pick the sides, tick the differences, see each one side by side, then save the script, write a
migration, or apply. Applying to a production target asks you to type its name first. See
[The desktop app](desktop-app.md) and [The VS Code extension](vscode.md).
