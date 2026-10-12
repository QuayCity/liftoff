# The VS Code extension

The extension puts LiftOff next to your code. It runs the `liftoff` program that comes with it
(or the one in `liftoff.cliPath`), so everything it does you can also do on the command line.
[Installing](installing.md#the-vs-code-extension) says how to install it.

Open a folder with a `liftoff.toml` and click the LiftOff rocket in the activity bar. A folder
without one offers **Create LiftOff Project**; a folder with a Flyway project offers **Import
Flyway Project**.

## The Environments view

Every environment in `liftoff.toml` and `liftoff.user.toml`, and under each one every migration
script with its state there: pending, applied, failed, or edited since it ran. Click a script to
open it. The view reloads when either file is saved.

An environment's menu (right-click, or the icons on hover):

| command | does |
| --- | --- |
| **Run Pending Migrations** | `migrate`. On a database with tables and no scripts in the project, it offers **Adopt Existing Database…**; on one that differs from the baseline script, it lists the differences and offers to record anyway |
| **Show the SQL That Would Run** | the dry-run script, in an editor |
| **Validate** | checks the history against the files |
| **Check for Drift** | compares the database with what its scripts build |
| **Test Connection** | connects and shows the server, user and database |
| **Edit Environment** | opens the settings tab at that environment |

A pending script's menu has **Run This Script Only**, which tells you first which older pending
scripts it leaves behind.

A script that already ran somewhere gets a warning in the editor while you type in it, so the
change goes into a new script instead.

## The Schema Model view

**Compare with Dev** lists the objects where the dev database and `schema-model/` differ. Click
one (**Show the Difference**) for a side-by-side diff. **Pull into Schema Model** writes the
selected objects into the files; **Pull All into Schema Model** writes them all. Then commit from
Source Control like any other change.

**Generate Migration from Schema Model** writes the next migration script from the model, and
opens it. **Check Schema Model** builds the folder on the scratch database and puts any error on
the file that caused it, in the Problems panel.

## The Compare view

**Compare…** asks for a source and a target: an environment, the schema model, what the
migrations build, a snapshot file, or a database URL. The differences are listed with tick boxes.

| command | does |
| --- | --- |
| **Show the Difference** | the object on both sides, in the diff editor |
| **Open the Sync Script** | the script that makes the target like the source (ticked differences only) |
| **Write the Differences as a Migration** | the next migration script |
| **Apply to the Target** | runs it on the target now; a production target asks you to type its name |
| **Swap Source and Target**, **Compare Again** | |
| **Save a Snapshot…** | saves a side's schema to a file, to compare with later |

**Compare Data…** (in the view's `…` menu) compares the rows of two databases. The tables are
listed with their counts; click one to page through the rows in a grid, 100 at a time, with the
changed cells marked. Then open the INSERT / UPDATE / DELETE script or apply it.

## Project settings

**LiftOff: Project Settings** (the gear in the sidebar) opens a settings tab: the project,
comparison filters, placeholders, and every environment, including whether it is shared through
git (`liftoff.toml`) or stays on your computer (`liftoff.user.toml`). Typed passwords go to the
keychain; `${env.NAME}` is kept as written.

## Other commands

From the command palette (**Ctrl+Shift+P**), all starting with **LiftOff:**:

| command | does |
| --- | --- |
| **New Project** | create `liftoff.toml`, `migrations/` and `schema-model/`, empty or with the sample |
| **Import Flyway Project** | convert `flyway.toml`: the environments and their roles, what does not carry over, then (PostgreSQL) copying the history |
| **Adopt Existing Database…** | capture a database as `B0001` (see [Existing databases](existing-databases.md)) |
| **Rebaseline Project…** | replace the scripts up to a version with a baseline script |
| **Set Up Pipeline** | write the GitHub Actions workflow |
| **Show Log** | the `liftoff` commands the extension ran and their output (no passwords) |
| **Refresh** | read everything again |

## Settings

| setting | default | what |
| --- | --- | --- |
| `liftoff.cliPath` | empty | the `liftoff` program to run. Empty: the one that comes with the extension, or `liftoff` on the PATH |
| `liftoff.devEnvironment` | empty | the environment you change by hand. Empty: the first with role `dev` |
| `liftoff.checkModelOnSave` | off | check that the schema model builds each time a file in `schema-model/` is saved |
| `liftoff.generateUndo` | off | also write the undo script when generating from the schema model |

## Environment variables

VS Code passes its own environment to the program. If a project's passwords are `${env.NAME}`
references, start VS Code from a terminal where those variables are set (`code .`), or set them
for your user account.
