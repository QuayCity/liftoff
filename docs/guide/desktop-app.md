# The desktop app

The desktop app does what the command line does, with screens instead of commands. It runs the
same program, so a project made here works on the command line and in VS Code, and the other way
round. [Installing](installing.md#the-desktop-app) says how to start it.

## The start page

| button | does |
| --- | --- |
| **New project…** | pick an empty folder, a project name and the database engine (PostgreSQL or SQL Server); writes `liftoff.toml`, `migrations/` and `schema-model/` |
| **Open folder…** | open a folder with a `liftoff.toml`. A folder with a Flyway project offers **Convert settings…** instead (see [Moving from Flyway](flyway.md)) |
| **Create sample…** | a small sample shop project to look around in |
| **Recent** | projects opened before; **Remove** takes one off the list (the folder stays) |

The project's name is in the title bar, with a button to close it. Along the top are the
workspaces: **Environments**, **Changes**, **Scripts**, **Compare**, **Commit** and **Pipelines**;
the gear opens **Settings**.

**Light or dark.** The sun / moon / screen button, top right on the start page and in the title
bar, switches between light, dark and the same as the system, one click at a time. The choice is
remembered on this computer for every project.

Files changed outside the app (`liftoff.toml` edited in a text editor, scripts added from git)
are read again whenever the window gets focus. If a file cannot be read, a red banner names the
problem and the screens keep the last good state.

## Environments

The list on the left has every environment with its role. **Add environment** opens the
connection dialog.

### The connection dialog

| field | what |
| --- | --- |
| Name | letters, digits, `-` and `_` |
| Role | Dev, Scratch, Test or Production |
| Server, Port, Instance, Database | where the database is. An empty port is the engine's default (1433 or 5432); a SQL Server named instance needs no port |
| Encrypt the connection, Trust the server certificate | SQL Server. Trust only a server you know, such as a local container with a self-signed certificate |
| SSL | PostgreSQL: prefer, require or disable |
| Sign in with | SQL Server: a SQL Server login, or one of the Microsoft Entra ID methods (see [Connections](configuration.md#sql-server-with-microsoft-entra-id-azure-sql)) |
| User, Password | the password may be typed, or be `${env.NAME}` to read a variable |
| Save the connection for | **Everyone on the project** (URL and user in `liftoff.toml`, shared through git) or **Just me** (in `liftoff.user.toml`). The password always stays private |
| Allow commands that erase this database | lets **Clean…** erase it (`allow_clean`); scratch databases always may be |

Below the fields is the connection URL they make. **Enter a URL instead** lets you type one;
**Enter server details instead** goes back to the fields.

**Test connection** connects and shows the server version, user and database. **Save** writes the
environment. A typed password goes to the operating system's keychain, never into a project
file; `${env.NAME}` is kept as written.

### An environment

The selected environment shows its scripts and their state on that database. Two tabs:

**Migrations**: the scripts, with **Run only this** on each pending one, and the commands:

| command | does |
| --- | --- |
| **Run pending** | `migrate`. Runs without asking, also on production: the Checks tab is the review |
| **Refresh status** | reads the history again |
| **Validate** | checks the history against the files |
| **Repair history** | `repair` |
| **Undo latest** | runs the undo script of the latest migration |
| **Baseline…** | for a database without history: mark it as being at a version |
| **Import Flyway history…** | for a database with Flyway history (PostgreSQL) |
| **Adopt as B0001** | for a project without scripts: capture this database as the baseline (see [Existing databases](existing-databases.md)) |
| **Clean…** | erase the database; only for scratch databases and environments with `allow_clean` |
| **Capture as script…**, **Capture as baseline script…** | write the whole database as a script |

When a database has tables and the project has no scripts, the app offers **Adopt as B0001** at
the top. When a database differs from the baseline script, a dialog lists the differing objects
with **Cancel** and **Record anyway**.

**Checks**: before a deploy. **Check for drift**, **Preview pending changes**, **Dry-run script**,
and **Save report…** for the HTML report.

## Changes

Compares the dev database with the **Migration scripts** (what they build) or with the
**Schema model**; the toggle at the top picks which. The first time, it needs a scratch database
and offers **Create one…**.

Each difference is listed with a tick box; click one to see it **side by side**. Changes that may
lose data are marked.

- Against the migration scripts: **Write migration…** writes the ticked differences as the next
  script. **Review the migration** shows the script (and the undo script, with **Also write an
  undo script**), then **Save to migrations**. **Record it as applied on dev** is ticked, since
  dev already has the change.
- Against the schema model: **Save to model** writes the ticked objects into `schema-model/`.
- **Object history…** shows the commits that changed an object's model file, each with its change.

Unticked differences stay listed for next time.

## Scripts

Every script in the migrations folder. **New script** writes the next one from a description and
SQL. **Squash or rebaseline…** replaces scripts up to a version with a baseline script (see
[Teams, branches and pipelines](teams-and-pipelines.md#too-many-scripts)). From `V9990` on, a note
suggests a restart.

## Compare

**Schema**: pick a source and a target: an environment, **What the migrations build**, **The schema model**, **A
snapshot file…** or **A database URL…**. Then tick differences, click one to see it side by side,
and:
- **Save script…**: a script that makes the target like the source;
- **Write migration…**: the ticked differences as the next migration;
- **Apply**: run them on the target now (outside its history). A production target asks you to
  type its name first.

**Swap source and target** turns it round; **Snapshot the source…** saves a snapshot file.

**Data**: pick two environments. Each table shows its counts: only in source, only in target,
different. Tables without a key say **no key, whole rows**. **Hide tables that are the same**
keeps the list short. Click a count to page through the rows, source and target side by side
with the changed cells marked. Tick or untick **Insert rows only in the source**, **Update rows that differ** and **Delete rows
only in the target**, then
**Save script…** or **Apply**. See [Compare](compare.md#data-compare).

## Commit

The changed files in the project, a message box, **Commit**, and **Pull** / **Push** for the
project's git repository.

## Pipelines

Writes a GitHub Actions workflow: pick the environments to deploy to, in order, and the branch
that deploys. It shows the **Workflow preview** and the **Repository secrets to add**, then
**Write .github/workflows/liftoff.yml**. See
[Teams, branches and pipelines](teams-and-pipelines.md#pipelines).

## Settings

The gear. **Project**: name, migrations folder, schemas, the history table (fixed once databases
have history) and the run lock. **Comparison filters**: **Add filter**, with Leave out or Include,
the object type and a pattern. **Save settings** writes `liftoff.toml`; leaving with unsaved
changes asks first.

## Without databases

`npm run dev` in `apps/desktop` runs the screens in a browser on made-up data, to look around or
to work on the app.
