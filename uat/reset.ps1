# Puts a UAT scenario back at its start: its databases dropped and made again (with their rows),
# its project folder emptied and filled. Run it before each scenario, and again to start over.
#
#   .\uat\reset.ps1 all
#   .\uat\reset.ps1 greenfield      (or changes, deploy, model, adopt, flyway, compare, data, branches,
#                                    desktop and vscode: the apps' own empty start for § 12 and § 13)
#
# Databases are <prefix>_<name> on the UAT container; folders are under $UatRoot (~\liftoff-uat).

param([Parameter(Mandatory)][ValidateSet('all', 'greenfield', 'changes', 'deploy', 'model', 'adopt', 'flyway', 'compare', 'data', 'branches', 'desktop', 'vscode')][string]$Scenario)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'env.ps1')

docker exec $UatContainer /opt/mssql-tools18/bin/sqlcmd -C -S localhost -U sa -P $UatPassword -Q 'SELECT 1' *> $null
if ($LASTEXITCODE) { throw "SQL Server ($UatContainer) is not running: run .\uat\setup.ps1 first" }

function Reset-Databases([string]$Prefix, [string[]]$Names) {
  # Also drops what a scenario made itself (e.g. create-scratch's <prefix>_dev_scratch).
  $existing = uatsql master "SET NOCOUNT ON; SELECT name FROM sys.databases WHERE name LIKE '${Prefix}[_]%'" | Where-Object { $_.Trim() }
  foreach ($db in $existing) { uatsql master "ALTER DATABASE [$($db.Trim())] SET SINGLE_USER WITH ROLLBACK IMMEDIATE; DROP DATABASE [$($db.Trim())]" | Out-Null }
  foreach ($n in $Names) { uatsql master "CREATE DATABASE [${Prefix}_$n]" | Out-Null }
}

function Reset-Folder([string]$Name) {
  $dir = Join-Path $UatRoot $Name
  if (Test-Path $dir) { Remove-Item -Recurse -Force $dir }
  New-Item -ItemType Directory -Force $dir | Out-Null
  $dir
}

function Invoke-Liftoff([string]$Dir) {
  # liftoff with -C, failing loudly; progress goes to the console, not the pipeline
  liftoff -C $Dir @args 2>&1 | ForEach-Object { "  $_" } | Write-Host
  if ($LASTEXITCODE) { throw "liftoff $args failed in $Dir" }
}

function Save-Git([string]$Dir, [string]$Message) {
  git -C $Dir add -A 2>$null | Out-Null
  git -C $Dir commit -q -m $Message
  if ($LASTEXITCODE) { throw "git commit failed in $Dir (is user.name/user.email set in your git config?)" }
}

# The sample shop project (V0001-V0003, U0003, R__customer_totals), run on dev, test and prod.
function New-ShopProject([string]$Name, [string]$Prefix) {
  Reset-Databases $Prefix 'dev', 'scratch', 'test', 'prod'
  $dir = Reset-Folder $Name
  Invoke-Liftoff $dir init --sample --engine sqlserver
  uatenvs $Prefix 'dev=dev', 'scratch=scratch', 'test=test', 'prod=prod' | Add-Content (Join-Path $dir 'liftoff.toml')
  foreach ($e in 'dev', 'test', 'prod') { Invoke-Liftoff $dir -e $e migrate }
  git -C $dir init -q -b main
  Save-Git $dir 'The shop, as deployed'
  $dir
}

$scenarios = [ordered]@{
  greenfield = {
    Reset-Databases 'gf' 'dev', 'test', 'prod'
    $dir = Reset-Folder 'greenfield'
    # Kept outside the project folder: `liftoff init` wants it empty of liftoff.toml only, but this keeps it clean.
    uatenvs 'gf' 'dev=dev', 'test=test', 'prod=prod' | Set-Content (Join-Path $UatRoot 'greenfield-environments.toml')
    "Empty folder $dir; databases gf_dev, gf_test, gf_prod (empty). Environments to paste: $UatRoot\greenfield-environments.toml"
  }

  changes = {
    $dir = New-ShopProject 'changes' 'ch'
    "Shop project in $dir, at V0003 on ch_dev, ch_test, ch_prod; ch_scratch empty; committed to git"
  }

  deploy = {
    $dir = New-ShopProject 'deploy' 'dp'
    # test may be erased with `clean`; prod may not
    $toml = Join-Path $dir 'liftoff.toml'
    (Get-Content -Raw $toml) -replace '(\[environments\.test\][^\[]*?role = "test")', "`$1`nallow_clean = true" | Set-Content -NoNewline $toml
    Save-Git $dir 'test may be cleaned'
    "Shop project in $dir, at V0003 on dp_dev, dp_test, dp_prod; test has allow_clean = true"
  }

  model = {
    $dir = New-ShopProject 'model' 'md'
    Invoke-Liftoff $dir model
    Save-Git $dir 'Schema model from dev'
    "Shop project in $dir with schema-model/ filled from md_dev and committed"
  }

  adopt = {
    Reset-Databases 'lg' 'prod', 'test', 'stage', 'qa', 'new', 'scratch'
    $schema = Get-Content -Raw (Join-Path $PSScriptRoot 'sql\legacy-schema.sql')
    foreach ($db in 'lg_prod', 'lg_test', 'lg_stage', 'lg_qa') { uatsql $db $schema | Out-Null }
    uatsql lg_prod (Get-Content -Raw (Join-Path $PSScriptRoot 'sql\legacy-rows.sql')) | Out-Null
    # stage lacks the view and the procedure; qa has a column of another type and one extra column
    uatsql lg_stage "DROP VIEW dbo.order_summary`nGO`nDROP PROCEDURE dbo.orders_for_customer" | Out-Null
    uatsql lg_qa "ALTER TABLE dbo.products ALTER COLUMN name nvarchar(50) NOT NULL; ALTER TABLE dbo.customers ADD loyalty_points int NULL" | Out-Null
    $dir = Reset-Folder 'adopt'
    uatenvs 'lg' 'prod=prod', 'scratch=scratch', 'test=test', 'stage=test', 'qa=test', 'new=test' | Set-Content (Join-Path $UatRoot 'adopt-environments.toml')
    "Empty folder $dir. lg_prod: the legacy schema with rows, no history. lg_test: the same schema. lg_stage: no view or procedure. lg_qa: products.name nvarchar(50), customers.loyalty_points. lg_new, lg_scratch: empty. Environments to paste: $UatRoot\adopt-environments.toml"
  }

  flyway = {
    Reset-Databases 'fw' 'development', 'shadow', 'test', 'production'
    $dir = Reset-Folder 'flyway'
    Copy-Item -Recurse (Join-Path $PSScriptRoot 'flyway-project\*') $dir
    $toml = Join-Path $dir 'flyway.toml'
    (Get-Content -Raw $toml).Replace('localhost:61433', "localhost:$UatPort") | Set-Content -NoNewline $toml
    # What a team on the other tool would have: dev and production at V3 with the repeatable, test at V2.
    $sql = Join-Path $dir 'sql'
    $placeholder = { param($t) $t.Replace('${tableOwner}', 'dbo') }
    foreach ($db in 'fw_development', 'fw_production', 'fw_test') {
      $files = 'V1__create_customers.sql', 'V2__create_orders.sql'
      if ($db -ne 'fw_test') { $files += 'V3__orders_index.sql', 'R__customer_totals.sql' }
      foreach ($f in $files) { uatsql $db (& $placeholder (Get-Content -Raw (Join-Path $sql $f))) | Out-Null }
      $rows = if ($db -eq 'fw_test') { 2 } else { 4 }
      uatsql $db ((Get-Content -Raw (Join-Path $PSScriptRoot 'sql\flyway-history.sql')) + "`nGO`nDELETE FROM dbo.flyway_schema_history WHERE installed_rank > $rows") | Out-Null
    }
    git -C $dir init -q -b main
    Save-Git $dir 'The project as the other tool left it'
    "Flyway project in $dir (flyway.toml, sql\V1-V3, R__). fw_development and fw_production at V3 with history, fw_test at V2, fw_shadow empty."
  }

  compare = {
    $dir = New-ShopProject 'compare' 'cp'
    uatsql cp_dev (Get-Content -Raw (Join-Path $PSScriptRoot 'sql\compare-dev-changes.sql')) | Out-Null
    uatsql cp_test "CREATE TABLE dbo.old_notes (id int PRIMARY KEY, note nvarchar(200) NULL); INSERT dbo.old_notes VALUES (1, N'kept for years')" | Out-Null
    "Shop project in $dir at V0003 everywhere. cp_dev also has: suppliers, customers.phone, a wider orders.total, an index, a view, a procedure, a function. cp_test also has old_notes (with a row)."
  }

  data = {
    Reset-Databases 'dc' 'source', 'target', 'prod'
    $dir = Reset-Folder 'data'
    $rows = Get-Content -Raw (Join-Path $PSScriptRoot 'sql\data-rows.sql')
    foreach ($db in 'dc_source', 'dc_target', 'dc_prod') { uatsql $db $rows | Out-Null }
    uatsql dc_target (Get-Content -Raw (Join-Path $PSScriptRoot 'sql\data-target-changes.sql')) | Out-Null
    uatsql dc_prod (Get-Content -Raw (Join-Path $PSScriptRoot 'sql\data-target-changes.sql')) | Out-Null
    Invoke-Liftoff $dir init --name data --engine sqlserver
    uatenvs 'dc' 'source=dev', 'target=test', 'prod=prod' | Add-Content (Join-Path $dir 'liftoff.toml')
    "Project in $dir with environments source (dc_source), target (dc_target) and prod (dc_prod); target and prod differ from source in known rows (see uat\sql\data-target-changes.sql)"
  }

  branches = {
    $dir = New-ShopProject 'branches' 'br'
    "Shop project in $dir at V0003, git branch main with one commit"
  }
}

# The apps' own start (§ 12 desktop, § 13 VS Code): empty databases and an empty git repository.
function New-AppStart([string]$Name, [string]$Prefix, [string[]]$Databases) {
  Reset-Databases $Prefix $Databases
  $dir = Reset-Folder $Name
  git -C $dir init -q -b main
  "Empty git repository $dir; empty databases $(($Databases | ForEach-Object { "${Prefix}_$_" }) -join ', ')"
}
# The desktop app makes its scratch database itself; VS Code cannot, so it gets one.
$scenarios.desktop = { New-AppStart 'desktop' 'dk' 'dev', 'test', 'prod' }
$scenarios.vscode = { New-AppStart 'vscode' 'vs' 'dev', 'scratch', 'test', 'prod' }

$todo = if ($Scenario -eq 'all') { $scenarios.Keys } else { @($Scenario) }
New-Item -ItemType Directory -Force $UatRoot | Out-Null
foreach ($s in $todo) {
  Write-Host "== $s" -ForegroundColor Cyan
  $summary = & $scenarios[$s]
  Write-Host ($summary | Select-Object -Last 1) -ForegroundColor Green
}
