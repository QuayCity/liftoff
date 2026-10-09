# LiftOff for VS Code

Your database migrations, next to your code.

- **Environments sidebar.** Every environment in `liftoff.toml`, with each migration script and
  whether it ran there: pending, applied, failed, or edited since it ran. Click a script to open it.
- **Run from the editor.** Run pending migrations, see the exact SQL that would run first, validate,
  check a database for drift, or test its connection, from the environment's menu.
- **Warnings where you type.** A script that was edited after it ran somewhere gets a warning in the
  editor, so the change goes into a new script instead.
- **Run one script on its own.** Right-click a script that has not run: **Run This Script Only**
  runs it and nothing else, and tells you first which older scripts it leaves behind.
- **Schema Model view.** Change your dev database (or a remote one) the way you always do, then
  see here what it has that the `schema-model/` files do not, object by object. Click one for a
  side-by-side diff; pull one, a selection, or all of them into the files, and commit from Source
  Control like any other change.
- **Edit the model by hand.** For a small change, edit the file in `schema-model/` directly.
  **Check Schema Model** builds the folder on the scratch database and puts any error on the file
  that caused it (or turn on `liftoff.checkModelOnSave`).
- **Migrations from the pipeline.** **Set Up Pipeline** writes a GitHub Actions workflow in which
  every pull request that changes the schema model gets its migration script written and
  committed to it, so the script is reviewed with the change (or, if you prefer, the pull request
  fails until someone adds one). Merging deploys, stage by stage. Small team without a pipeline?
  **Generate Migration from Schema Model** does the same step on your machine.
- **Import a Flyway project.** Open a folder with `flyway.toml` or `flyway.conf` and the sidebar
  offers the import: a few steps to choose the environments and their roles, a summary of anything
  that does not carry over, then (on PostgreSQL) copying Flyway's history so LiftOff knows what
  already ran. Your Flyway files stay as they are.
- **Project settings in an editor tab.** **LiftOff: Project Settings** (the gear in the sidebar)
  edits everything: the project, comparison filters, placeholders and every environment, including
  whether it is shared through git or stays on your computer. Passwords go to your operating
  system's keychain, never into `liftoff.toml`; `${env.NAME}` references are kept as written.
- **PostgreSQL and SQL Server.**

The extension comes with the `liftoff` program and runs it for you; nothing is sent anywhere but
your own databases. Point `liftoff.cliPath` at another build if you need to.

Free and open source (MIT).
