# The UAT environment. Dot-source it in every PowerShell window you test from:
#   . .\uat\env.ps1
# It sets the variables the projects' liftoff.toml files read, a `liftoff` command (the
# single-file program, as it ships) and `uatsql` to change a database by hand.
# Local testing only: the password is not a secret.

$UatRepo      = Split-Path -Parent $PSScriptRoot
$UatContainer = 'liftoff-uat-mssql'
$UatPort      = if ($env:LIFTOFF_UAT_PORT) { [int]$env:LIFTOFF_UAT_PORT } else { 61433 }
$UatRoot      = if ($env:LIFTOFF_UAT_ROOT) { $env:LIFTOFF_UAT_ROOT } else { Join-Path $HOME 'liftoff-uat' }
$UatPassword  = 'Liftoff!Uat2026'

# liftoff.toml says password = "${env.LIFTOFF_UAT_PASSWORD}"; VS Code and the desktop app see the
# variable when they are started from this window (`code .`, `npm start`).
$env:LIFTOFF_UAT_PASSWORD = $UatPassword

$UatExe = Join-Path $UatRepo 'packages\liftoff\build\liftoff.exe'

function liftoff {
  if (Test-Path $UatExe) { & $UatExe @args }
  else { node (Join-Path $UatRepo 'packages\liftoff\src\cli\main.ts') @args }
}

# The URL of a UAT database, for liftoff.toml or `--source`/`--target`.
function uaturl([Parameter(Mandatory)][string]$Database) {
  "sqlserver://localhost:$UatPort;databaseName=$Database;encrypt=true;trustServerCertificate=true;user=sa;password=$UatPassword"
}

# Runs T-SQL in a UAT database:  uatsql uat_dev "ALTER TABLE dbo.customers ADD phone nvarchar(30) NULL"
# Several batches: separate them with a line holding only GO. Exits non-zero on the first error.
function uatsql([Parameter(Mandatory)][string]$Database, [Parameter(Mandatory)][string]$Sql) {
  $Sql | docker exec -i $UatContainer /opt/mssql-tools18/bin/sqlcmd -C -b -f 65001 -S localhost -U sa -P $UatPassword -d $Database -W -h -1
  if ($LASTEXITCODE) { throw "uatsql: the SQL failed in $Database" }
}

# A project's environments as liftoff.toml lines. Pairs of name and role; the database is <prefix>_<name>.
function uatenvs([Parameter(Mandatory)][string]$Prefix, [Parameter(Mandatory)][string[]]$NameRole) {
  foreach ($pair in $NameRole) {
    $name, $role = $pair -split '='
    @"

[environments.$name]
url = "sqlserver://localhost:$UatPort;databaseName=${Prefix}_$name;encrypt=true;trustServerCertificate=true"
user = "sa"
password = "`${env.LIFTOFF_UAT_PASSWORD}"
role = "$role"
"@
  }
}
