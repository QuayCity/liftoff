# Project files and connections

A project's settings live in two TOML files in the project folder. Environment variables can add
to them or override them.

| source | for | in git |
| --- | --- | --- |
| `liftoff.toml` | the project and the environments the whole team shares | yes |
| `liftoff.user.toml` | your own environments (your dev and scratch databases) and your passwords if there is no keychain | no |
| environment variables | CI pipelines, and secrets | – |

When the same setting is in more than one place, the variables win over `liftoff.user.toml`, and
that file wins over `liftoff.toml`.

`liftoff settings` prints everything as it is written in the files (never a password).
`liftoff project` prints the project and its environments without any connection details. In the
apps, the settings screen edits both files for you.

## A complete example

```toml
[project]
name = "shop"
engine = "sqlserver"                 # or "postgresql"
migrations = "migrations"            # the scripts folder, inside the project folder
schemas = ["dbo", "sales"]           # the schemas LiftOff manages; the first holds the history table
history_table = "liftoff_schema_history"
lock = "advisory"                    # PostgreSQL only; "table" behind connection poolers

[project.placeholders]
owner = "app_owner"                  # ${owner} in a script, for every environment

[[project.filters]]
action = "exclude"
object = "table"
pattern = "audit_*"

[environments.test]
url = "sqlserver://db-test.example.com;databaseName=shop;encrypt=true;trustServerCertificate=false"
user = "liftoff"
password = "${env.SHOP_TEST_PASSWORD}"
role = "test"

[environments.test.placeholders]
owner = "test_owner"                 # wins over the project's value on test

[environments.prod]
url = "sqlserver://db-prod.example.com;databaseName=shop;encrypt=true"
user = "liftoff"
role = "prod"
```

And `liftoff.user.toml`, on one developer's computer:

```toml
[environments.dev]
url = "sqlserver://localhost:1433;databaseName=shop_dev;encrypt=true;trustServerCertificate=true"
user = "sa"
role = "dev"

[environments.scratch]
url = "sqlserver://localhost:1433;databaseName=shop_dev_scratch;encrypt=true;trustServerCertificate=true"
user = "sa"
role = "scratch"
allow_clean = true
```

## `[project]`

| key | default | what |
| --- | --- | --- |
| `name` | the folder's name | the project's name, shown in the apps |
| `engine` | `postgresql` | `postgresql`, `sqlserver` or `oracle`. Set by `liftoff init --engine`; it cannot change later |
| `migrations` | `migrations` | the folder with the scripts, relative to the project folder. Sub-folders are read too |
| `schemas` | `["public"]` or `["dbo"]` | the schemas LiftOff compares, captures and cleans. The history table goes in the first one. Oracle: `[]`, as LiftOff manages the schema of the user each environment signs in as |
| `history_table` | `liftoff_schema_history` | the history table's name. Do not change it once databases have history |
| `lock` | `advisory` | PostgreSQL: how two `migrate` runs at once keep out of each other's way. `advisory` uses a session advisory lock; `table` uses a lease row instead, for PgBouncer in transaction pooling, RDS Proxy and Aurora Limitless. SQL Server always uses an application lock, Oracle a row lock held by a second connection |
| `placeholders` | none | `${name}` values for every environment (see [Placeholders](#placeholders)) |
| `filters` | none | objects to leave out of comparisons (see [Filters](#filters)) |

## `[environments.<name>]`

Names use letters, digits, `-` and `_`.

| key | default | what |
| --- | --- | --- |
| `url` | required | the connection URL (see below) |
| `user` | none | the login. It can also be written inside a PostgreSQL URL |
| `password` | none | better left out: see [Passwords](#passwords) |
| `role` | `dev` | `dev`, `scratch`, `test` or `prod` (see [Concepts](concepts.md#environments-and-roles)) |
| `allow_clean` | `false` | whether `liftoff clean` may erase this database. Scratch databases may always be erased |
| `placeholders` | none | `${name}` values for this environment; they win over the project's |
| `order` | none | where it is listed: lower first. Without one, after those with one: dev, test, prod, then scratch databases. The desktop app and the VS Code settings tab set it when you add an environment, and the desktop app when you drag one |

`url`, `user` and `password` may hold `${env.NAME}`, which is replaced by the environment variable
`NAME` when LiftOff connects. If the variable is not set, only that environment fails, with a
message naming the variable.

## Connection URLs

You do not have to write URLs by hand: the desktop app's connection dialog asks for the server,
port, database and options and writes the URL itself. On the command line, and in the files, these
are the forms.

### PostgreSQL

```
postgres://db.example.com:5432/shop
postgres://app_user@db.example.com/shop?sslmode=require
host=db.example.com port=5432 dbname=shop user=app_user sslmode=require
```

| setting | what |
| --- | --- |
| port | 5432 when left out |
| `sslmode` | `prefer` (the default: encrypted when the server supports it), `require`, or `disable` |

Do not write the password in the URL; use `password` or a variable.

### SQL Server

```
sqlserver://db.example.com;databaseName=shop;encrypt=true
sqlserver://db.example.com:1433;databaseName=shop;encrypt=true;trustServerCertificate=false
sqlserver://db.example.com\SQLEXPRESS;databaseName=shop;encrypt=true
jdbc:sqlserver://db.example.com:1433;databaseName=shop;encrypt=true     (the JDBC form works too)
```

| setting | what |
| --- | --- |
| `host:port` | 1433 when left out. With a named instance (`host\INSTANCE`) leave the port out: the SQL Server Browser service finds it |
| `databaseName` | the database |
| `encrypt` | `true` to encrypt the connection. Azure SQL needs it |
| `trustServerCertificate` | `true` accepts a certificate this computer does not trust, such as a local container's self-signed one. Leave it `false` for real servers |
| `authentication` | how to sign in: see below. `SqlPassword` (a SQL login) when left out |
| `tenantId` | the Microsoft Entra directory (tenant) ID, for some sign-in methods |

### SQL Server with Microsoft Entra ID (Azure SQL)

Add `authentication=` to the URL, or pick it under **Sign in with** in the desktop app:

| `authentication=` | signs in as | `user` | `password` |
| --- | --- | --- | --- |
| `SqlPassword` | a SQL login | the login | its password |
| `ActiveDirectoryDefault` | the account this computer is signed in with: `az login`, VS Code's Azure sign-in, the `AZURE_*` variables, or the managed identity of the machine | optional: a managed identity's client ID | – |
| `ActiveDirectoryInteractive` | you, in a browser, with MFA. One sign-in per command | optional: your account, to fill it in | – |
| `ActiveDirectoryServicePrincipal` | an app registration. Needs `tenantId=` | the application (client) ID | the client secret |
| `ActiveDirectoryManagedIdentity` | the managed identity of the Azure machine LiftOff runs on | optional: a user-assigned identity's client ID | – |

```
sqlserver://myserver.database.windows.net;databaseName=shop;encrypt=true;authentication=ActiveDirectoryDefault
sqlserver://myserver.database.windows.net;databaseName=shop;encrypt=true;authentication=ActiveDirectoryServicePrincipal;tenantId=00000000-0000-0000-0000-000000000000
```

The account must be a user in the database:
`CREATE USER [you@example.com] FROM EXTERNAL PROVIDER;` and a role that may change the schema.

### Oracle

```
oracle://db.example.com:1521/SHOPPDB
oracle://db.example.com/SHOPPDB?ssl=true        (TLS; port 2484 when left out)
jdbc:oracle:thin:@//db.example.com:1521/SHOPPDB  (the JDBC forms work too, also @host:1521:SID)
```

| setting | what |
| --- | --- |
| port | 1521 when left out |
| the service | the database service to connect to, e.g. `FREEPDB1` or `ORCLPDB1` |
| `ssl` | `true` connects with TLS and checks the server's certificate |
| the user | LiftOff manages this user's schema: its tables, views, sequences, synonyms, PL/SQL and triggers. Dev, test and prod are usually different users (`SHOP_DEV`, `SHOP_TEST`, …) |

The driver needs no Oracle client: nothing to install besides LiftOff. Scripts are read as SQL*Plus
reads them: a SQL statement ends at `;`, and a PL/SQL block (`CREATE PROCEDURE`, `CREATE PACKAGE`,
`BEGIN … END;`, …) at a line with only `/`. A PL/SQL unit that does not compile fails the script,
with Oracle's errors, instead of being left invalid. Oracle commits DDL at once, so a script with
DDL cannot be rolled back: if it fails part-way, what ran stays, the history records the failure,
and `liftoff repair` clears it. Scripts with only data changes run in one transaction. LiftOff
cannot create a scratch schema on Oracle (`create-scratch`): ask for a user of its own for it.
Data compare leaves LOB columns (CLOB, BLOB) out, and an empty text is NULL in Oracle.

`ActiveDirectoryPassword` (a user name and password for an Entra account) is not supported:
Microsoft is retiring it, and it cannot do MFA. Entra ID sign-in is the only time LiftOff
connects to anything besides your databases: Microsoft's sign-in service.

## Passwords

A password never goes into `liftoff.toml`. You have three choices:

1. **The operating system's keychain** (Windows Credential Manager, macOS Keychain, the Secret
   Service on Linux). The apps' connection dialog and `liftoff settings --save` put a typed
   password there, one entry per project folder and environment, and LiftOff reads it back from
   there. `liftoff create-scratch` does the same for the scratch database.
2. **An environment variable**: `password = "${env.SHOP_TEST_PASSWORD}"`. The file only holds the
   variable's name, so it is safe in git. Good for shared environments: everyone, and the
   pipeline, sets the variable their own way.
3. **`liftoff.user.toml`**, which git ignores. Used when there is no keychain (a CI runner, a
   server without a desktop). `LIFTOFF_NO_KEYRING=1` switches the keychain off.

## Environment variables

### Overriding an environment

For an environment named `test`:

| variable | replaces |
| --- | --- |
| `LIFTOFF_ENV_TEST_URL` | its `url` |
| `LIFTOFF_ENV_TEST_USER` | its `user` |
| `LIFTOFF_ENV_TEST_PASSWORD` | its `password` |

The name is upper case, with `-` as `_`: environment `pre-prod` is `LIFTOFF_ENV_PRE_PROD_…`.
This is how the generated CI workflow passes passwords: as repository secrets named
`LIFTOFF_ENV_<NAME>_PASSWORD`.

### An environment that exists only as variables

If `LIFTOFF_ENV_<NAME>_URL` is set and no environment has that name, LiftOff adds one. Add
`LIFTOFF_ENV_<NAME>_ROLE` (default `test`), `_USER` and `_PASSWORD` as needed. Useful for a
pipeline's throwaway database:

```sh
export LIFTOFF_ENV_CI_SCRATCH_URL="postgres://localhost:5432/scratch"
export LIFTOFF_ENV_CI_SCRATCH_ROLE=scratch
liftoff diff --scratch ci_scratch
```

### Other variables

| variable | what |
| --- | --- |
| `LIFTOFF_NO_KEYRING` | set to anything: never use the keychain |

## Placeholders

A script can hold `${name}`, replaced by a value when it runs:

```sql
GRANT SELECT ON dbo.orders TO ${reader};
```

Values come from, lowest to highest: `[project.placeholders]`, `[environments.<name>.placeholders]`,
and `--placeholder name=value` on the command line. A value may be `${env.NAME}` for a secret.

Built in, always available:

| placeholder | value |
| --- | --- |
| `${liftoff:environment}` | the environment's name |
| `${liftoff:schema}` | the first schema in `schemas` |
| `${liftoff:table}` | the history table's name |

`${flyway:environment}`, `${flyway:defaultSchema}` and `${flyway:table}` work too, so scripts
brought from Flyway run unchanged.

Once a project has any placeholders, a `${name}` with no value is an error that names it, and
nothing runs. A project without placeholders runs its scripts untouched, so `${` in a string is
left alone.

## Rules

`[rules]` sets how strict `liftoff lint` and `liftoff check` are with your scripts: a severity
per rule, naming patterns and your own rules. See [Rules on your scripts](rules.md#settings-rules-in-liftofftoml).

## Filters

Filters leave objects out of comparisons: `diff`, `generate`, `check`, `compare`, `model` and
`adopt`. Useful for tables another tool owns, or a staging schema.

```toml
[[project.filters]]
action = "exclude"          # or "include"
object = "table"            # table, view, function (procedures too), type, sequence, trigger, extension, or any
pattern = "audit_*"         # * any characters, ? one character; with a dot, it matches schema.name
```

Filters run in order, and the last one that matches an object decides. To keep only some tables,
exclude everything, then include what you want:

```toml
[[project.filters]]
action = "exclude"
object = "any"
pattern = "*"

[[project.filters]]
action = "include"
object = "any"
pattern = "sales.*"
```

When a Flyway project is converted, a filter for `flyway_schema_history` is added, so Flyway's
history table is never compared.
