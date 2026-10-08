# LiftOff for VS Code

Your database migrations, next to your code.

- **Environments sidebar.** Every environment in `liftoff.toml`, with each migration script and
  whether it ran there: pending, applied, failed, or edited since it ran. Click a script to open it.
- **Run from the editor.** Run pending migrations, see the exact SQL that would run first, validate,
  check a database for drift, or test its connection, from the environment's menu.
- **Warnings where you type.** A script that was edited after it ran somewhere gets a warning in the
  editor, so the change goes into a new script instead.
- **PostgreSQL and SQL Server.**

The extension comes with the `liftoff` program and runs it for you; nothing is sent anywhere but
your own databases. Point `liftoff.cliPath` at another build if you need to.

Comparing databases, generating migrations and drift checks are part of LiftOff Pro.
