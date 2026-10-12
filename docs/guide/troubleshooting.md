# Troubleshooting

Every error names what went wrong and, where there is one, the command that fixes it. This page
collects the common ones. Add `--output-type json` to any command to get the error's code and
exit code in a form a script can read.

## Exit codes

| exit | means |
| --- | --- |
| 0 | it worked |
| 1 | a database, file or git error |
| 2 | wrong usage or configuration |
| 10 | could not connect |
| 11 | a migration script failed |
| 12 | refused: validation failed, the database differs from the baseline script, a script is numbered before the base branch, or the schema model does not build |
| 13 | drift found |
| 14 | the schema model has changes no migration makes |

## Project and settings

**`no liftoff.toml in …; run liftoff init first`** (exit 2)
You are not in the project folder. `cd` into it, or add `-C <folder>`.

**`pick an environment with --environment; configured: …`**
The command works on one database; add `-e <name>`.

**`no environment with role 'scratch'; add one or name it explicitly`**
`diff`, `generate`, `check`, `adopt` and others need a scratch database. `liftoff create-scratch`
makes one next to the dev database. See [Concepts](concepts.md#the-scratch-database).

**`two scripts share version 0005: …`**
Two files have the same number, usually after a merge. Renumber one of them by renaming it (if it
has not run anywhere), or with `liftoff renumber --after origin/main` on its branch.

**`… uses placeholders with no value: owner`** (exit 2)
Give `owner` a value for this environment in `liftoff.toml`, or `--placeholder owner=…`. See
[Placeholders](configuration.md#placeholders).

## Connecting

**`could not connect to 'test': environment variable SHOP_TEST_PASSWORD is not set`** (exit 10)
The environment's password (or URL, or user) is `${env.SHOP_TEST_PASSWORD}`. Set the variable in
the shell you run LiftOff from. Apps started from the Start menu or Dock do not see variables set
in a terminal: start them from that terminal, or set the variable for your user account.

**`Login failed for user …`** / **`password authentication failed`** (exit 10)
The user or password is wrong. To change a password saved in the keychain, edit the environment in
the desktop app or the VS Code settings tab and type it again.

**`connect ECONNREFUSED`, or a timeout** (exit 10)
Nothing answers at that server and port. Check the server is running, the port (SQL Server 1433,
PostgreSQL 5432 by default), and the firewall. A SQL Server named instance (`server\INSTANCE`)
needs the SQL Server Browser service running, or give the instance's port instead.

**`self-signed certificate` / `unable to verify the first certificate`** (SQL Server)
The server's certificate is not trusted by this computer. For a real server, install its CA
certificate. For a server you know, such as a local container, add `trustServerCertificate=true`
to the URL (in the apps: **Trust the server certificate**).

**Windows: SQL Server in a container stopped answering after a restart**
Windows can reserve a range of ports at boot, and a container's port may fall in it. List the
ranges with `netsh interface ipv4 show excludedportrange protocol=tcp` and map the container to a
port outside them.

### Microsoft Entra ID

**`ActiveDirectoryDefault`: no account is available**
Sign in first: `az login`, or the Azure sign-in in VS Code, or set the `AZURE_CLIENT_ID`,
`AZURE_TENANT_ID` and `AZURE_CLIENT_SECRET` variables.

**`Login failed for user '<token-identified principal>'`**
You signed in, but the account is not a user in that database:
`CREATE USER [you@example.com] FROM EXTERNAL PROVIDER;`, then give it a role.

**`authentication=ActiveDirectoryPassword is not supported`**
Use `ActiveDirectoryInteractive` (a browser, with MFA) or `ActiveDirectoryDefault` instead. See
[Connections](configuration.md#sql-server-with-microsoft-entra-id-azure-sql).

**`ActiveDirectoryServicePrincipal needs tenantId=… in the URL`**
Add `;tenantId=<directory id>` to the URL; the user is the application (client) ID and the password
the client secret.

## Deploying

**`'prod' already has tables but no migration history. Baseline it first …`** (exit 12)
The database existed before LiftOff. See [Existing databases](existing-databases.md): usually
`liftoff -e prod adopt` in a project without scripts.

**`'qa' has objects that differ from B0001__….sql`** (exit 12)
The database is not quite what the baseline script builds. Fix the listed objects, or record it
anyway with `migrate --accept-differences` (the differences show up as drift). See
[Existing databases](existing-databases.md#the-other-environments).

**`V0002__orders.sql changed after it was applied (checksum mismatch)`** (exit 12)
Someone edited a script that already ran. Undo the edit (`git checkout -- migrations/V0002__orders.sql`)
and put the change in a new script. If the edit is harmless and should stay:
`liftoff -e <env> repair` on every environment that ran it.

**`V0005__a.sql is older than the latest applied version; use --out-of-order to run it`** (exit 12)
A script with a lower number arrived after a higher one ran (a merge, or `--only`). Run it with
`migrate --out-of-order`, or renumber it if it has not run anywhere.

**`V0004__broken.sql failed; rolled back`** (exit 11)
The script has an error; the message has the database's error number and line. The transaction
was rolled back, so nothing is recorded: fix the script and run `migrate` again. A PostgreSQL
script that ran outside a transaction may be recorded as failed; then run `liftoff -e <env>
repair` before `migrate`. See [Transactions](scripts.md#transactions).

**`drift found on 'prod'`** (exit 13, from `check`)
The database was changed outside the scripts. See [When there is drift](deploying.md#when-there-is-drift).

**`clean is turned off for 'prod'`** (exit 2)
Good. `clean` only erases scratch databases and environments with `allow_clean = true`.

## Writing migrations

**`generate` wrote a drop and an add where I renamed something**
LiftOff does not detect renames. Write the rename by hand (`sp_rename` on SQL Server, `ALTER …
RENAME` on PostgreSQL) in the script, in place of the drop and the add.

**`diff` lists objects I do not manage** (another tool's tables, a staging schema)
Leave them out with [filters](configuration.md#filters), or remove the schema from `schemas`.

**`not compared: …` in the output**
The databases have objects LiftOff does not compare yet. Handle those with hand-written scripts.
See [What is compared](generating.md#what-is-compared).

**`liftoff -e dev migrate` fails because dev already has the table**
The script was written from dev, so dev has the change but its history does not. Record it:
`liftoff -e dev mark-applied V0005__….sql`, or generate with `--record-on-dev` next time.

## Command line

**PowerShell splits an argument at the colon**
Quote Flyway-style arguments with a colon, and anything with `;` or `$`:
`"-locations=filesystem:sql"`, `"sqlserver://host;databaseName=x"`.

**Reporting a problem**
Include the command, its output with `--output-type json`, and `liftoff --version`. Never include
passwords: LiftOff's own output never prints them.
