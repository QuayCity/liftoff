# The desktop app

The desktop app does what the command line does, with screens instead of commands. It runs the
same program, so a project made here works on the command line and in VS Code, and the other way
round. It is for Windows and Linux; on a Mac, use the command line or
[VS Code](vscode.md) ([why](installing.md#the-desktop-app)). [Installing](installing.md#the-desktop-app)
says how to get it.

## The start page

| button | does |
| --- | --- |
| **New project…** | pick an empty folder, a project name and the database engine (PostgreSQL or SQL Server); writes `liftoff.toml`, `migrations/` and `schema-model/` |
| **Open folder…** | open a folder with a `liftoff.toml`. A folder with a Flyway project offers **Convert settings…** instead (see [Moving from Flyway](flyway.md)) |
| **Create sample…** | a small sample shop project to look around in |
| **Recent** | projects opened before; **Remove** takes one off the list (the folder stays) |
| **Overview of all projects** | the [Overview](#overview) of every recent project at once, each with an **Open** button. It connects to all their databases, so it only reads them when you ask |

The project's name is in the title bar, with a button to close it. The sidebar on the left has the
workspaces: **Overview**, **Changes**, **Environments**, **Compare**, **Scripts**, **Rules**,
**Commit**, **History** and **Pipelines** (Ctrl+1 to Ctrl+9). It shows only icons (hover one for
its name); the button at its foot widens it to show the names too, and the app remembers your
choice. The gear in the title bar opens **Settings**.

**About LiftOff.** The ⓘ button, top right on the start page and in the title bar, shows this
version, the newest LiftOff release, and what is new in it (its release notes), with **Check
now** and **Open on GitHub**. The notes come from the same look-up as the updates; with update
checks off, nothing is fetched until you click **Check now**.

**Light or dark.** The sun / moon / screen button, top right on the start page and in the title
bar, switches between light, dark and the same as the system, one click at a time. The choice is
remembered on this computer for every project.

Files changed outside the app (`liftoff.toml` edited in a text editor, scripts added from git)
are read again whenever the window gets focus. If a file cannot be read, a red banner names the
problem and the screens keep the last good state.

## Overview

Where every environment stands, read from its databases. Scratch databases are left out.

- **A card per environment**: the version it is at, how many scripts wait (or **Up to date**, or
  how many failed), and its last run: when and by whom. One that cannot be reached says why.
- **Where each script is**: the latest 12 scripts (or all of them) against every environment, with
  their state on each. What has reached test but not production, at a glance.
- **Activity**: the runs on every environment, newest first, from each database's
  [activity table](concepts.md#the-activity-table): what ran, whether it worked, the database
  user, and whether it came from a pipeline or a computer. Pick an environment or **Failures
  only** to narrow it. Click a run for everything about it: the deployment id (with a copy
  button), the computer, the pipeline run's page, the commit, the scripts, and the error.

**Read again** reads every database once more.

## Environments

Each environment has a card along the top: its role, whether it connects, how many scripts are
pending, when it last ran, and drift. Click a card to show that environment below. **Add
environment** opens the connection dialog.

The cards are in the project's order: dev, test, prod, and the scratch database last, unless
you change it. **Drag a card** to another place, or press Alt+Left / Alt+Right on its name; the
order is written as `order` in `liftoff.toml` (or `liftoff.user.toml` for an environment that
is only yours). A new environment goes after the others, and a scratch database stays last.

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

The selected environment shows its scripts and their state on that database, with their topics;
a script that is not for this environment ([`-- liftoff:for`](scripts.md#scripts-for-some-environments-only))
is listed as **Not here**. Two tabs:

**Migrations**: the scripts, with **Run only this** and **Mark as applied…** (record it without
running it, for a database that already has its changes; it asks first) on each pending one, and
the commands:

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
**Check the rules** ([the rules](rules.md) on the scripts still pending there; allowed findings
show with their reason), and **Save report…** for the HTML report.

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

Unticked differences stay listed for next time.

## Scripts

Every script in the migrations folder. **New script** writes the next one from a description and
SQL. **Squash or rebaseline…** replaces scripts up to a version with a baseline script (see
[Teams, branches and pipelines](teams-and-pipelines.md#too-many-scripts)). From `V9990` on, a note
suggests a restart.

## Rules

The policies every migration script is checked against ([Rules on your scripts](rules.md)): each
built-in rule with what it checks and its severity here (**Off**, **Info**, **Warning**, **Error
(stops)**), marked **changed** when it is not the default, and the project's own rules (a name, a
regular expression, a message and a severity). **Save rules** writes them to `liftoff.toml`;
leaving with unsaved changes asks first. **Check every script** shows the findings, with the
allowed ones and their reasons.

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

## History

The history of every object in the schema model, straight from git: pick an object (the filter
narrows the list), then one of the commits that changed its file to see what that commit changed.
Renames are followed. Objects not committed yet say so.

## Pipelines

Writes a GitHub Actions workflow or, with **Runs on: Azure DevOps**, an Azure Pipelines file: pick
the environments to deploy to, in order, and the branch that deploys. It shows the **Workflow
preview** and the secrets to add, then writes `.github/workflows/liftoff.yml` or
`azure-pipelines.yml`. See [Teams, branches and pipelines](teams-and-pipelines.md#pipelines).

## Settings

The gear. **Project**: name, migrations folder, schemas, the history table (fixed once databases
have history) and the run lock. **Comparison filters**: **Add filter**, with Leave out or Include,
the object type and a pattern. **Save settings** writes `liftoff.toml`; leaving with unsaved
changes asks first. **This app**: settings for LiftOff on this computer, in every project; see
[Updates](#updates).

## Updates

When there is a newer LiftOff, it downloads in the background, its SHA-256 checksum is checked
against the one GitHub publishes, and a **Restart to update** button appears at the top, on the
start page and in the title bar. Click it when it suits you: the new version installs and starts,
and your projects and settings stay. The first start of the new version shows **What's new in
x.y.z**, which opens its release notes; it goes away once opened.

**Settings > This app > Updates** chooses how:

| choice | what happens |
| --- | --- |
| **Download updates automatically; I choose when to restart** (the default) | checks at start and every six hours, downloads a new version, and shows **Restart to update** |
| **Tell me when there is an update** | shows **Update to x.y.z** instead; clicking it downloads, with the progress on the button, then **Restart to update** |
| **Never check for updates** | no checks: the app connects to nothing but your databases |

**Check now** checks straight away and says what it found.

- Windows, as VS Code does it: the new version is unpacked next to LiftOff's folder while you
  work (`LiftOff-update`) and started once in the background, so Windows checks the new program
  then and not at the restart. **Restart to update** then only swaps the two folders: the new
  version is up a few seconds later. The `liftoff` program on your PATH is updated with it.
  If a file in LiftOff's folder is in use (`liftoff` running in a terminal, or a window open on
  that folder), nothing is replaced: the old version starts again and **Update failed** says
  why; close it and restart to try again. Where LiftOff cannot write next to its own folder,
  the new setup runs silently instead, which takes about a minute.
- Linux: an AppImage replaces itself and restarts. Started some other way, the button says
  **Download x.y.z** and opens the release page.
- What is contacted: `api.github.com` for the latest release, and GitHub's download servers for
  the file. Nothing about you or your projects is sent. While the LiftOff repository is private,
  GitHub does not answer, and the app simply finds no update.

## Without databases

`npm run dev` in `apps/desktop` runs the screens in a browser on made-up data, to look around or
to work on the app.
