# LiftOff

Database migrations for teams that work the way teams actually work: change your dev database
(or the schema-model files), pull the change into git from VS Code, and let the pipeline write the
migration script into the pull request and deploy it, stage by stage.

Free and open source (MIT). PostgreSQL and SQL Server.

## What it does

- **Versioned migrations.** `V1__orders.sql`, `U1__orders.sql` (undo), `R__views.sql` (repeatable),
  `B5__baseline.sql`. A history table per database, locking so two runs never collide, checks that
  scripts were not edited after they ran. A hotfix? `migrate --only 5` runs one script and nothing
  else.
- **Schema model.** One file per database object in `schema-model/`, so git shows the history of
  every table and view. Pull changes into it from a dev database, or edit it by hand.
- **Migrations written for you.** `liftoff generate` compares the dev database (or the schema
  model) with what your migrations build and writes the next script, with an undo script if you
  want one.
- **Checks before a deploy.** Drift (someone changed production by hand), what the pending scripts
  change, the exact SQL that will run, as text, JSON or an HTML report.
- **Pipelines.** `liftoff ci` writes a GitHub Actions workflow: pull requests get their migration
  script written (or required), merges deploy through your environments with approvals.
- **Three ways in.** The `liftoff` command line (one file, no runtime to install), a desktop app,
  and a VS Code extension.
- **Coming from Flyway?** LiftOff reads Flyway-style script names and checksums, accepts Flyway's
  `-key=value` options, converts `flyway.toml` / `flyway.conf`, and imports an existing
  `flyway_schema_history` table once.
- **Offline.** The CLI never calls the internet; your CI runners do not need to reach anything but
  your databases.

## Quick start

```sh
liftoff init --name shop --engine postgresql      # writes liftoff.toml and migrations/
# add an environment to liftoff.toml:
#   [environments.test]
#   url = "postgres://app@db-test:5432/shop"
#   role = "test"
liftoff -e test info
liftoff -e test migrate
```

`liftoff --help` lists every command; `liftoff <command> --help` explains one. Every command
takes `--output-type json` for scripts and pipelines. To try it without a project:
`liftoff init --sample`.

## The repository

| folder | what |
| --- | --- |
| `packages/liftoff` | the core (runner, comparison, schema model, CI) and the CLI, in TypeScript on Node 24 |
| `apps/desktop` | the desktop app: Electron + React |
| `apps/vscode` | the VS Code extension; runs the CLI and reads its JSON |
| `e2e` | Playwright tests for the desktop app |

[CONTRIBUTING.md](CONTRIBUTING.md) explains how to build it and run the tests.

## Not affiliated

LiftOff is an independent project, written from scratch. It is not affiliated with or endorsed by
Redgate Software. Flyway is a trademark of Red Gate Software Ltd; it is named here only to say
which projects LiftOff can read.

## Licence

[MIT](LICENSE).
