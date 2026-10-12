<img src="../assets/logo/logo-256.png" alt="" width="96" align="right">

# Trying LiftOff by hand

The full acceptance test plan, with scripts that set up SQL Server and every scenario, is
[uat/UAT.md](../uat/UAT.md). This page is the short version. How fast data compare is, by table
size and amount of change: [data-compare-benchmark.md](data-compare-benchmark.md).

How to set LiftOff up on a fresh machine and try every part yourself: the CLI, the desktop app
and the VS Code extension. The automated tests are in [CONTRIBUTING.md](../CONTRIBUTING.md).

## 1. Set up the machine

Install:

- **Node 24** (`node --version` says v24 or later)
- **Git**, plus the GitHub CLI (`gh auth login`) while the repository is private
- **Docker**: Docker Desktop or Rancher Desktop, and keep it running
- **VS Code**

Then:

```sh
gh repo clone sanderstad/liftoff LiftOff-public
cd LiftOff-public
docker compose up -d                      # PostgreSQL :55432, PgBouncer :56432, SQL Server :51433

cd packages/liftoff && npm install && cd ../..
cd apps/desktop && npm install && cd ../..
cd apps/vscode && npm install && cd ../..
cd e2e && npm install && npx playwright install chromium && cd ..
```

If the desktop app later says Electron failed to install, run `node node_modules/electron/install.js`
in `apps/desktop`.

**Check it works:** `docker ps` lists `liftoff-pg`, `liftoff-bouncer` and `liftoff-mssql`, and
`node packages/liftoff/src/cli/main.ts --help` shows the rocket and the command list.

## 2. Databases to try things on

The tests use the `shop_*` databases, so make your own:

```sh
for d in try_dev try_scratch try_test try_prod; do
  docker exec liftoff-pg dropdb -U postgres --force --if-exists $d
  docker exec liftoff-pg createdb -U postgres $d
done
```

Run the same loop again to start over. Their URLs are
`postgres://postgres:liftoff@localhost:55432/try_dev`, and so on. For SQL Server, connect to
`localhost,51433` as `sa` with the password `Liftoff!2026`.

## 3. The CLI

Node runs the TypeScript directly. Make an alias so the steps below stay short (PowerShell:
`function liftoff { node C:\path\to\LiftOff-public\packages\liftoff\src\cli\main.ts @args }`):

```sh
alias liftoff="node $PWD/packages/liftoff/src/cli/main.ts"
```

To try the single-file program that ships instead: `npm run build:cli` in `packages/liftoff`,
then use `packages/liftoff/build/liftoff.exe`.

### A new project (greenfield)

In an empty folder outside the repository:

```sh
liftoff init --sample
```

Add the environments to the end of `liftoff.toml`:

```toml
[environments.dev]
url = "postgres://postgres:liftoff@localhost:55432/try_dev"
role = "dev"

[environments.scratch]
url = "postgres://postgres:liftoff@localhost:55432/try_scratch"
role = "scratch"

[environments.test]
url = "postgres://postgres:liftoff@localhost:55432/try_test"
role = "test"

[environments.prod]
url = "postgres://postgres:liftoff@localhost:55432/try_prod"
role = "prod"
```

| try | command | what you should see |
| --- | --- | --- |
| connection | `liftoff -e test test-connection` | Connected to test: try_test |
| state | `liftoff -e test info` | V0001–V0003 and a repeatable script, all pending |
| deploy | `liftoff -e test migrate` | Applied 4 migration(s) |
| cherry-pick one script | on an empty database: `liftoff -e prod migrate --only 1`, then `liftoff -e prod info` | Only V0001 ran; the rest is still pending |
| a change made in dev | `liftoff -e dev migrate`, then add a table in try_dev, then `liftoff diff` | `added public.<table>` |
| write the migration | `liftoff generate --description "my change"` | `migrations/V0004__my_change.sql` |
| schema compare | `liftoff compare --source test --target prod` | What test has and prod does not (orders and the view), listed as added |
| data compare | put different rows in try_test and try_prod, then `liftoff data-compare --source test --target prod` | Counts per table; `--help` shows how to see the rows or write a sync script; with `--save-diff rows.json`, later `--from-diff rows.json --rows public.orders` pages without comparing again |
| pre-deploy check | `liftoff -e prod check` | What would run, and any drift |
| squash old scripts | `liftoff rebaseline` | One B script replaces them (commit the scripts to git first) |
| near V9999 | `liftoff rebaseline --restart` | B0001 with a restart marker; new scripts start at V0001 again |

### An existing database (adopt)

1. Put tables in a database with no history:
   `docker exec liftoff-pg psql -U postgres -d try_prod -c "create table legacy(id int primary key)"`
2. In a new empty folder, run `liftoff init`, then add `prod` (try_prod) and `scratch`
   (try_scratch) environments as above.
3. `liftoff -e prod adopt` writes `migrations/B0001__existing_schema.sql` and records prod as
   being at it.
4. Add a `test` environment with a database that already has `legacy`, but with a different
   column. `liftoff -e test migrate` stops with LIFTOFF_BASELINE_DIFFERS and lists the
   differences. With `--accept-differences` it carries on anyway.

### Branches and numbering

In a git repository with the project: make a branch from main and add a script there. Add a
script with the same number on main. Back on the branch, `liftoff renumber --after main --check`
reports the clash, and `liftoff renumber --after main` renumbers the branch's script.

## 4. The desktop app

```sh
cd apps/desktop
npm start                # builds, then opens the app
```

The start page shows the logo. Open the project folder from section 3, or click **New project…**.
Then go through the screens: Environments (run pending scripts, adopt), Scripts (the rebaseline
dialog), Changes, Compare (Schema and Data), Commit, Pipelines.

**Without databases:** `npm run dev`, then open the address it prints in a browser. The app runs
on made-up data. Add these to the address to see the special cases:

| address ends with | shows |
| --- | --- |
| `?noscripts` | production has tables and the project has no scripts: the adopt offer |
| `?differs` | staging differs from the baseline script: the differences dialog |
| `?nearlimit` | the scripts are near V9999: the rebaseline note |

## 5. The VS Code extension

Package it with its own copy of the CLI, then install it:

```sh
cd packages/liftoff && npm run build:cli && cd ../..
cd apps/vscode && npm run package          # writes liftoff-<version>.vsix
code --install-extension liftoff-0.1.0.vsix --force
```

On Windows, if `code --install-extension` does nothing, use the full path:
`"%LOCALAPPDATA%\Programs\Microsoft VS Code\bin\code.cmd" --install-extension liftoff-0.1.0.vsix --force`.
Then reload VS Code (**Developer: Reload Window**).

Open the project folder from section 3. The LiftOff rocket appears in the activity bar on the
left. Try:

- **Environments:** every script's state per environment; **Run Pending Migrations** from an
  environment's menu; right-click a pending script and choose **Run This Script Only**.
- **Schema Model:** change try_dev, see the objects that differ, pull them into `schema-model/`.
- **Compare:** pick two sides and compare.
- **Compare Data…** (in the Compare view's `…` menu): pick two databases with different rows; click
  a count to page through those rows, then open the sync script or apply it.
- **Settings:** the gear opens the project settings in an editor tab.
- **Import a Flyway project:** open a folder with `flyway.toml` and follow the steps.
- **New project:** open an empty folder; the sidebar offers to create one.
- **Adopt:** run a migrate on try_prod while it has tables and the project has no scripts; it
  offers to adopt the database.
- **Rebaseline Project…** from the command palette.

## 6. The automated tests

See the table in [CONTRIBUTING.md](../CONTRIBUTING.md). The short version, from the repository
root with the variables from that file set:

```sh
cd packages/liftoff && npm test && npm run test:db
cd ../../apps/vscode && npm test && npm run test:vscode
cd ../desktop && npm run build && npm run build:electron
cd ../../e2e && npx playwright test
```

## 7. The logo

Everything is in [`assets/logo/`](../assets/logo):

| file | for |
| --- | --- |
| `logo.svg` | the logo in colour, at any size |
| `logo-mono.svg` | one colour, follows the text colour (`currentColor`) |
| `logo-16.png` … `logo-1024.png` | the colour logo as PNG, transparent background |
| `logo-mono-dark-512.png`, `logo-mono-light-512.png` | one colour, for light and for dark backgrounds |
| `logo-wordmark.png`, `logo-wordmark-on-dark.png` | the logo with the name, for light and for dark backgrounds |
| `social-preview.png` | 1280×640, for GitHub (Settings → Social preview) and link previews |

Where the apps use it: the desktop start page and favicon (`apps/desktop/src/assets/logo.svg`), the
desktop window icon (`apps/desktop/electron/icon.png`), the VS Code extension icon
(`apps/vscode/media/icon.png`) and its sidebar icon (`apps/vscode/media/liftoff.svg`, the
one-colour version), and the rocket at the top of `liftoff --help`.

To change it: edit `assets/logo/logo.svg` (and `logo-mono.svg`), copy them over the two app
copies above, then run `node assets/logo/render.mjs` to render all the PNGs again. It uses the
Playwright from `e2e/` and needs the network for the wordmark's font.
