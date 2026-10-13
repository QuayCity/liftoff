<img src="../assets/logo/logo-256.png" alt="" width="96" align="right">

# LiftOff documentation

LiftOff keeps a database's schema in plain SQL scripts in git, writes those scripts from the
changes you make in a dev database, and runs them on every environment. It works with PostgreSQL
and SQL Server, from the command line, a desktop app or VS Code.

## Start here

New to LiftOff? Read [the concepts](guide/concepts.md) (ten minutes), then follow the tutorial
that fits your situation.

| your situation | command line | desktop app (Windows, Linux) | VS Code |
| --- | --- | --- | --- |
| **A new database**: nothing exists yet | [tutorial 1](tutorials/01-new-project-cli.md) | [tutorial 2](tutorials/02-new-project-desktop.md) | [tutorial 3](tutorials/03-new-project-vscode.md) |
| **An existing database**: it has tables, but no migration scripts | [tutorial 4](tutorials/04-existing-database-cli.md) | [tutorial 5](tutorials/05-existing-database-desktop.md) | [tutorial 6](tutorials/06-existing-database-vscode.md) |
| **A Flyway project** | [tutorial 7](tutorials/07-from-flyway.md) | | |

## User guide

| page | what it covers |
| --- | --- |
| [Concepts](guide/concepts.md) | projects, environments and roles, the scratch database, scripts, the history table, the schema model, drift |
| [Installing](guide/installing.md) | the `liftoff` program, the VS Code extension, the desktop app, what each needs |
| [Project files and connections](guide/configuration.md) | `liftoff.toml`, `liftoff.user.toml`, connection URLs, passwords, Microsoft Entra ID, environment variables, placeholders, filters |
| [Migration scripts](guide/scripts.md) | naming, numbering, transactions, `GO` batches, repeatable, undo and baseline scripts |
| [Writing migrations from your changes](guide/generating.md) | `diff` and `generate`, data-loss warnings, hand-written scripts |
| [Rules on your scripts](guide/rules.md) | `lint`: dropped tables, deletes without `WHERE`, grants, naming; severities, custom rules, allowing a finding |
| [Deploying](guide/deploying.md) | `info`, `migrate`, `check`, drift, `validate`, `repair`, `undo`, running one script, `clean` |
| [Existing databases](guide/existing-databases.md) | `adopt`, the baseline check on other environments, `baseline`, `capture` |
| [The schema model](guide/schema-model.md) | one file per object, pulling changes, generating from the model, the pull-request check |
| [Compare](guide/compare.md) | schema compare between any two sides; data compare, keyed tables and heaps |
| [Teams, branches and pipelines](guide/teams-and-pipelines.md) | numbering across branches, `renumber`, `liftoff ci`, `squash`, `rebaseline` |
| [Moving from Flyway](guide/flyway.md) | converting the settings, keeping the scripts, the history |
| [The desktop app](guide/desktop-app.md) | every screen |
| [The VS Code extension](guide/vscode.md) | views, commands and settings |
| [Command reference](guide/cli-reference.md) | every command and option |
| [Troubleshooting](guide/troubleshooting.md) | exit codes, common errors and what to do |

## Showing LiftOff to others

Three 30-minute demo walkthroughs, with what to do, see and say:
[on the command line](demo/cli.md), [in the desktop app](demo/desktop-app.md) and
[in VS Code](demo/vscode.md).

More:
- [Trying LiftOff by hand](TESTING.md), for contributors;
- [Data compare benchmark](data-compare-benchmark.md): how fast data compare is, by table size.
