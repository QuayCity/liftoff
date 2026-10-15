# Teams, branches and pipelines

## Who has what

| | shared through git | on each computer |
| --- | --- | --- |
| scripts, `schema-model/`, `liftoff.toml` | yes | |
| test and production environments | in `liftoff.toml` | passwords in the keychain or variables |
| dev and scratch databases | | in `liftoff.user.toml`: everyone has their own |

Each developer has their own dev and scratch database, so nobody's half-finished change shows up
in someone else's `diff`. A dev database can be a local container: PostgreSQL, SQL Server, MySQL and
Oracle (Oracle Database Free) all run in Docker. SQLite needs no server at all: each developer's
dev database is a file.

## Branches

Two branches can both add a `V0005`. Merged, they would clash, and a database that ran one would
never run the other. LiftOff's answer: **new scripts always come after everything on the main
branch.**

```sh
liftoff renumber --after origin/main --check     # exit 12 if a new script on this branch is not after main's
liftoff renumber --after origin/main             # renumber this branch's new scripts (and their undo scripts)
```

The usual flow:

1. Branch from main, change dev, `liftoff generate`: `V0005`.
2. Meanwhile someone merges their own `V0005` into main.
3. Before merging yours: update the branch from main, run `liftoff renumber --after origin/main`.
   Yours becomes `V0006`. Commit.

The generated pipeline runs the `--check` on every pull request, so this cannot be forgotten.
With branch protection's "Require branches to be up to date before merging", every script is
numbered after whatever merged first.

`renumber` only renames scripts that are new on the branch. If your dev database had recorded a
script under its old number, `liftoff -e dev validate` will say so.

## Pipelines

```sh
liftoff ci --stage test --stage prod             # print a GitHub Actions workflow
liftoff ci --stage test --stage prod --write     # write .github/workflows/liftoff.yml
```

The workflow:

- **On pull requests**: checks that new scripts are numbered after the base branch, and runs
  [the rules](rules.md) on them (`lint --since`).
- **On pushes to main** (`--branch` for another) that change the scripts or `liftoff.toml`:
  deploys to each stage in order, each one waiting for the one before. Per stage: `validate`,
  `check --drift` (stopping on drift, with the HTML report kept as a build artifact), then
  `migrate`.
- Each stage runs in a GitHub environment of the same name, so you can require an approval
  before production (repository **Settings > Environments**).

| option | what |
| --- | --- |
| `--stage <env>` | an environment to deploy to, in order; repeat it. Not dev or scratch |
| `--platform azure` | write an Azure Pipelines file instead (see [Azure DevOps](#azure-devops)) |
| `--branch <name>` | the branch whose pushes deploy (default `main`) |
| `--no-checks` | leave out `validate` and the drift check |
| `--model check` | pull requests that change `schema-model/` must include the migration script (`check --model`) |
| `--model generate` | pull requests that change `schema-model/` get the script written and committed to them |
| `--install <command>` | how the runner installs `liftoff` (default: download the Linux build from the latest release) |
| `--write`, `--force` | write the file; replace an existing one |

### Secrets

Add a repository (or environment) secret per stage: `LIFTOFF_ENV_TEST_PASSWORD`,
`LIFTOFF_ENV_PROD_PASSWORD`. If the URL is not in `liftoff.toml`, add `LIFTOFF_ENV_<NAME>_URL`
too. The workflow's first lines list exactly which it needs.

The runner must be able to reach the databases. For databases on a private network, use a
self-hosted runner inside it.

With `--model generate`, the workflow needs a scratch database to generate in; it uses a database
service container on the runner. The optional secret `LIFTOFF_PUSH_TOKEN` (a fine-grained token
with contents: write) lets the checks run again on the commit that adds the script.

### Azure DevOps

```sh
liftoff ci --platform azure --stage test --stage prod           # print an Azure Pipelines file
liftoff ci --platform azure --stage test --stage prod --write   # write azure-pipelines.yml
```

The same jobs, as Azure Pipelines stages. Create a pipeline from `azure-pipelines.yml` in the
repository, then:

- **Secrets**: add `LIFTOFF_ENV_<NAME>_PASSWORD` per stage as a secret pipeline variable (or in a
  variable group linked to the pipeline). The file maps each into the steps that need it.
- **Approvals**: each stage deploys to the Azure DevOps environment of the same name
  (**Pipelines > Environments**). Add an approval there for production, and an **Exclusive lock**
  check so deployments queue up instead of running side by side.
- **Pull requests**: on Azure Repos, add the pipeline as a **Build validation** branch policy on
  the deploying branch and make it required (the `pr` trigger in the file covers GitHub
  repositories). The checks stage runs only for pull requests; the deploy stages never do.
- **`--model generate`** commits the script to the pull request's branch, so the project's
  **Build Service** needs **Contribute** on the repository (**Project settings > Repositories >
  Security**).

The scratch database for `--model` is a `docker run` on the Microsoft-hosted Ubuntu agent; a
self-hosted agent needs Docker.

### Other CI systems

The workflow is only a few `liftoff` commands, so the same steps work anywhere:

```sh
liftoff -e test validate
liftoff -e test check --drift --report check-test.html
liftoff -e test migrate
```

with `LIFTOFF_ENV_TEST_PASSWORD` set from the system's secret store. Exit codes are listed in
[Deploying](deploying.md#exit-codes).

## Too many scripts

After a few years, building a database from hundreds of scripts is slow, and most of them only
matter as history.

### `squash`

```sh
liftoff squash --up-to 120
```

writes `B0120__squashed.sql`, the schema as of version 120, built on the scratch database. The
old scripts stay. Empty databases now start from `B0120`; existing ones carry on as before.
`--dry-run` prints it.

### `rebaseline`

```sh
liftoff rebaseline                 # everything
liftoff rebaseline --up-to 120     # up to version 120
liftoff rebaseline --archive old   # move the old scripts to old/ instead of deleting them
```

writes the baseline script, checks on the scratch database that it builds exactly what the old
scripts built, and takes the old scripts out of the migrations folder. Without `--archive` they
are deleted, so they must be committed to git first (git keeps them). Databases that ran them
are not affected: their history covers the baseline.

### Starting the numbering again

Four-digit numbers run out at `V9999`. From `V9990`, `migrate` and the apps say so.

```sh
liftoff rebaseline --restart
```

replaces every script with a new `B0001` holding the whole schema, marked with
`-- liftoff:restart`. New scripts start at `V0002` again. Each existing database, on its next
`migrate`, is checked against `B0001` (as in [Existing databases](existing-databases.md)) and
gets a restart row in its history; rows before it are no longer compared with files.

Known gap: a pull request opened before the restart that adds a `V9995` is not caught by
`renumber --check`. Renumber open branches after a restart.
