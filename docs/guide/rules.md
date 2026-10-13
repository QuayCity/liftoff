# Rules on your scripts

`liftoff lint` reads the SQL of your versioned and repeatable scripts and reports what a reviewer
should look at: a dropped table, a `DELETE` without a `WHERE`, a new column that will fail on a
table with rows, a grant to everyone. It needs no database, so it runs on every pull request, in
`liftoff check` before a deploy, in the desktop app and in VS Code.

```
$ liftoff lint
V0007__orders.sql:3            warn    table-without-primary-key  table order_notes has no primary key
V0008__cleanup.sql:2           error   delete-without-where       deletes every row of sessions
V0009__drop_legacy.sql:2       allowed drop-table                 drops table legacy_orders  (replaced by orders in V0005)
9 script(s): 1 error(s), 1 warning(s)
error: 1 rule error(s) in the scripts; fix them or allow them with a reason (-- liftoff:allow <rule>: <why>)
```

Each finding has a **severity**:

| severity | means |
| --- | --- |
| `error` | `lint` and `check` exit with 15, so a pipeline stops |
| `warn` | reported, worth a look |
| `info` | a note for the reviewer, such as a permission change |
| `off` | the rule does not run |

Undo (`U`) scripts are not checked: dropping things is what they do. Baseline (`B`) scripts are
not checked either; they describe a database that already exists.

## Which scripts

| command | checks |
| --- | --- |
| `liftoff lint` | every versioned and repeatable script |
| `liftoff lint --since origin/main` | only the scripts the branch adds (not on `origin/main` yet); for pull requests |
| `liftoff lint --script V0008__cleanup.sql` | that script (repeat the option for more) |
| `liftoff check --rules -e prod` | the scripts still pending on `prod` |
| `liftoff lint --report rules.html` | also writes a self-contained HTML report |

`liftoff check` with no options runs the rules too, next to drift, the pending changes and the
dry run; its HTML report (`--report`) has a Rules section.

## The rules

`liftoff lint --list` prints them with the severity each runs at in your project.

| rule | default | reports |
| --- | --- | --- |
| `drop-table` | warn | `DROP TABLE` |
| `drop-column` | warn | `ALTER TABLE … DROP COLUMN` (and PostgreSQL's `DROP` without `COLUMN`) |
| `truncate` | warn | `TRUNCATE` |
| `delete-without-where` | error | a `DELETE` with no `WHERE`: every row goes |
| `update-without-where` | error | an `UPDATE` with no `WHERE`: every row changes |
| `not-null-without-default` | warn | adding a `NOT NULL` column with no default to an existing table: fails when the table has rows (a table created in the same script is fine) |
| `table-without-primary-key` | warn | `CREATE TABLE` with no primary key, in the statement or later in the script; temporary tables are left alone |
| `select-star` | warn | `SELECT *` (a view's columns then change when the table does); `EXISTS (SELECT * …)` is fine |
| `permissions` | info | `GRANT`, `REVOKE` and `DENY` |
| `grant-to-public` | warn | `GRANT … TO PUBLIC` |
| `grant-option` | warn | `WITH GRANT OPTION` |
| `users-and-roles` | warn | creating, changing or dropping users, logins and roles (also `sp_addrolemember` and the like) |
| `use-database` | warn | SQL Server `USE`: the rest of the script runs in another database |
| `sensitive-columns` | info | column names that suggest personal or financial data: ssn, passport, iban, bank account, card number, cvv, tax id, national id, date of birth |
| `table-names` | off | new table names that do not match a pattern you set |
| `column-names` | off | new column names that do not match a pattern you set |
| `undo-script` | off | a versioned script without an undo (`U`) script of the same version |

What is read: the SQL with comments and strings left out, so `-- DROP TABLE x` and
`'DELETE FROM x'` do not count, and neither does a quoted name such as `"delete"`. The body of a
PostgreSQL function (between `$$`) is text to LiftOff, so it is not checked; a SQL Server
procedure body is. Statements are found by `;`, `GO` lines and the next statement's first word,
so T-SQL without semicolons works. LiftOff does not fully parse SQL: an unusual layout can hide
something or report something that is fine. Allow it (below) and tell us.

## Settings: `[rules]` in liftoff.toml

```toml
[rules]
drop-table = "error"          # a dropped table stops the pipeline
select-star = "off"
permissions = "warn"

[rules.table-names]
severity = "error"
pattern = '^[a-z][a-z0-9_]*$'  # regular expression; single quotes keep the backslashes as they are

[rules.column-names]
pattern = '^[a-z][a-z0-9_]*$'  # severity defaults to warn

[[rules.custom]]
id = "no-cascade"
pattern = 'ON\s+DELETE\s+CASCADE'
message = "no cascading deletes: delete the children in the script"
severity = "warn"             # default warn
```

A custom rule is a regular expression (case does not matter) matched against the SQL without
comments and strings; each match is a finding on its line. The `[rules]` table can also go in
`liftoff.user.toml`, to try a setting before sharing it.

## Allowing a finding

Sometimes the finding is the point: the table really goes. Say so in the script, with the reason,
and the finding no longer counts:

```sql
-- liftoff:allow drop-table: replaced by orders in V0005
DROP TABLE legacy_orders;
```

The comment covers the whole script; name several rules with commas
(`-- liftoff:allow drop-table, truncate: …`). The finding still shows, as `allowed` with the
reason, so the reviewer sees it. A rule name that does not exist is an error, so a typo does not
quietly allow nothing.

Add the comment before the script runs anywhere: changing an applied script changes its checksum
(see [validate](deploying.md#check-the-history-validate)).

## In pull requests

The workflow `liftoff ci` writes runs `liftoff lint --since origin/<base branch>` in the job
**New migration scripts: order and rules**. Make that job a required check and a script with a
rule error cannot be merged. See [Teams, branches and pipelines](teams-and-pipelines.md).

## In the desktop app and VS Code

- Desktop app: the **Rules** workspace lists every rule with what it checks and the severity it
  runs at in this project, and the project's own rules. Change a severity, give a naming rule its
  pattern, add, edit or remove an own rule, then **Save rules**: it writes `[rules]` in
  liftoff.toml (only what differs from the defaults), after checking the patterns. **Check every
  script** runs the rules on all of them. An environment's **Checks** tab has **Check the rules**
  too: the findings for the scripts still pending on that environment.
- VS Code: findings show in **Problems** and as squiggles in the script, and update when you save
  a script or liftoff.toml. **LiftOff: Check the Rules on the Scripts** (also the checklist button
  on the Environments view) checks every script.
