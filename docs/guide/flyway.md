# Moving from Flyway

A Flyway project carries over: its settings are converted once, the scripts keep their names and
checksums, and the databases keep what they ran. Flyway's files and history table are left as
they are, so you can go back. For a walk-through, see [tutorial 7](../tutorials/07-from-flyway.md).

## 1. Convert the settings

In the folder with `flyway.toml` (or `flyway.conf`):

```sh
liftoff init --from-flyway --preview    # show what would be converted; write nothing
liftoff init --from-flyway              # write liftoff.toml and liftoff.user.toml
```

What carries over:

| Flyway | LiftOff |
| --- | --- |
| the locations (`filesystem:sql`) | `migrations = "sql"` |
| the schemas | `schemas` |
| environments | environments, each with a role guessed from its name: starting with `dev` → dev, holding `shadow` or `scratch` → scratch, holding `prod` → prod, anything else → test |
| URL and user | `url` and `user` (JDBC URLs are understood) |
| password | the keychain; a `${env.X}` reference is kept as written in `liftoff.user.toml` |
| placeholders | `[project.placeholders]` |
| `cleanDisabled` | `allow_clean` |
| `authentication=ActiveDirectory…` in the URL | kept: the same Microsoft Entra ID sign-in |

Settings with no LiftOff equivalent are listed as **not converted**, each with the reason.
A filter is added so Flyway's own history table, `flyway_schema_history`, is never compared or
captured.

| option | what |
| --- | --- |
| `--role live=prod` | set an environment's role yourself (repeatable) |
| `--include production` | convert only this environment (repeatable) |
| `--flyway-config <file>` | which config file, when the folder has several |

Review `liftoff.toml`, then commit it. `flyway.toml` and the scripts are not touched.

## 2. The history

Each database has Flyway's history in `flyway_schema_history`. LiftOff keeps its own in
`liftoff_schema_history`, so it needs to know where each database is.

### PostgreSQL: copy the history

```sh
liftoff -e production import-flyway-history
```

copies Flyway's rows once. It refuses if an applied script's file changed since it ran (Flyway's
checksum no longer matches); `--accept-edited` imports anyway and stores the current files'
checksums. `--table` names another Flyway history table. Run it once per environment.

### SQL Server, MySQL, Oracle and SQLite: mark each database

Copying the history is PostgreSQL only for now. On SQL Server, MySQL, Oracle and SQLite, tell LiftOff the version each
database is at:

```sh
liftoff -e production baseline --version 3 --description "from Flyway"
liftoff -e test baseline --version 2
```

`flyway info` shows each database's current version. Scripts up to that version never run there.
Repeatable scripts run once more on the first `migrate`, since LiftOff has no record of them;
that is harmless when they are written to run again (`CREATE OR ALTER`).

## 3. Carry on

```sh
liftoff -e test info
liftoff -e test migrate
```

New scripts are numbered after the existing ones: after `V3__…` comes `V0004__…`. A project that
used timestamps (`V20261012.1405__…`) keeps getting timestamps.

## Flyway-style arguments

To ease the move, LiftOff accepts Flyway's command-line style for the common settings:

```sh
liftoff info -url=jdbc:postgresql://localhost:5432/shop -user=app -password=… -locations=filesystem:sql
liftoff -e test migrate -cherryPick=4      # the same as --only 4
```

| Flyway-style | means |
| --- | --- |
| `-url=…`, `-user=…`, `-password=…` | the connection for this run. Without a `liftoff.toml`, the folder is a project for this run only |
| `-schemas=a,b`, `-defaultSchema=a`, `-table=…` | the schemas and history table |
| `-locations=filesystem:sql` | the scripts folder (one folder) |
| `-environment=test`, `-workingDirectory=…`, `-outputType=json` | `-e`, `-C`, `--output-type` |
| `-target=5`, `-cherryPick=4,5`, `-outOfOrder` | `--target`, `--only`, `--out-of-order` |
| `-baselineVersion=3`, `-baselineDescription=…` | `baseline --version`, `--description` |
| `-placeholders.owner=x` | `--placeholder owner=x` |
| `-cleanDisabled=false` | allows `clean` |
| `-drift`, `-changes`, `-dryRun` | the parts of `check` |
| `-X`, `-q`, `-n` | accepted and ignored |

Other options are refused, naming the option. `-configFiles` is refused with a pointer to
`liftoff init --from-flyway`, and `-table=flyway_schema_history` because LiftOff keeps its own
history table.

In PowerShell, quote any argument with a colon: `"-locations=filesystem:sql"`.

## What is different

- The history table is LiftOff's own; Flyway's stays and is no longer updated.
- New scripts get four-digit versions (`V0004`).
- Undo scripts (`U…`) run with `liftoff undo`.
- Writing scripts from the dev database, the schema model, compare, data compare and the
  pipeline generator are part of LiftOff.
