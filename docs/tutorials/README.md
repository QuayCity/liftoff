# Tutorials

Step-by-step walk-throughs, each from an empty folder to a change deployed to production. Pick the
situation you are in and the tool you like; the three tools share one project format, so you can
switch later.

| | command line | desktop app | VS Code |
| --- | --- | --- | --- |
| **A new database.** Nothing exists yet. You change a dev database; LiftOff writes the migrations and deploys them. | [1](01-new-project-cli.md) | [2](02-new-project-desktop.md) | [3](03-new-project-vscode.md) |
| **An existing database.** It has years of tables and procedures, no migration scripts, and copies that have drifted. You capture it as a baseline, bring every environment under LiftOff, and carry on. | [4](04-existing-database-cli.md) | [5](05-existing-database-desktop.md) | [6](06-existing-database-vscode.md) |
| **A Flyway project.** You convert the settings and keep the scripts and history. | [7](07-from-flyway.md) | | |

Each takes 15 to 30 minutes and uses SQL Server, with notes for PostgreSQL. All you need is a
server you may create databases on; each tutorial shows how to start one in Docker.

Tutorial 1 and 4 explain the most: if you use an app, skim the command-line version of your
situation first. [The concepts](../guide/concepts.md) explain the words used throughout.

The [`files/`](files) folder has the SQL that builds the "existing" database of tutorials 4–6.
