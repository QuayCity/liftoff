# Contributing to LiftOff

Thanks for helping. Bug reports, fixes, new database engines, docs: all welcome.

## Before you start

- **Open an issue first** for anything bigger than a small fix, so we can agree on the approach
  before you spend time on it.
- **Write it yourself.** LiftOff is a clean-room project. Do not copy code, text, icons or
  screenshots from Flyway, Redgate products or any other tool whose licence does not allow it, and
  do not decompile them. Reading public documentation to understand behaviour is fine.
- By sending a pull request you agree it is published under the [MIT licence](LICENSE).

## Setting up

You need Node 24 and Docker.

```sh
docker compose up -d                     # PostgreSQL, PgBouncer and SQL Server for the tests
cd packages/liftoff && npm install
cd ../../apps/desktop && npm install
cd ../vscode && npm install
cd ../../e2e && npm install && npx playwright install chromium
```

Node 24 runs the TypeScript directly; there is no build step for the core or the CLI:

```sh
node packages/liftoff/src/cli/main.ts --help
```

## Running the tests

Point the tests at the databases from `docker compose`:

```sh
export LIFTOFF_TEST_PG=postgres://postgres:liftoff@localhost:55432
export LIFTOFF_TEST_PGBOUNCER=postgres://postgres:liftoff@localhost:56432
export LIFTOFF_TEST_MSSQL='sqlserver://localhost:51433;encrypt=true;trustServerCertificate=true;user=sa;password=Liftoff!2026'
```

The SQLite tests need nothing: they use files in a temporary folder.

| what | where | command |
| --- | --- | --- |
| core unit tests | `packages/liftoff` | `npm test` |
| against real databases, and the CLI contract | `packages/liftoff` | `npm run test:db` |
| the single-file CLI | `packages/liftoff` | `npm run build:cli`, then `LIFTOFF_CLI=build/liftoff.exe node --test test/cli.test.ts` |
| VS Code extension | `apps/vscode` | `npm test`, and `npm run test:vscode` (a real VS Code; first `npm run build` in apps/desktop and `npm run copy-ui` here, for the LiftOff panel) |
| desktop app | `e2e` | `npx playwright test` (build the app first: `npm run build && npm run build:electron` in `apps/desktop`) |

Tests that need a database skip themselves when its variable is not set. Set
`LIFTOFF_TEST_KEYCHAIN=1` to also test the operating system's keychain.

## Pull requests

- One change per pull request, with a test that fails without it.
- `npm run typecheck` (in `packages/liftoff`) and the tests above pass.
- Match the code around it. Comments explain why, not what.
- Text users see is plain and short: say what happened and what to do next.
