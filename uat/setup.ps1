# Sets the machine up for UAT once: a SQL Server container of its own (the automated tests'
# liftoff-mssql is left alone), the single-file liftoff program, and optionally the VS Code
# extension and the desktop app. Then: .\uat\reset.ps1 all
#
#   .\uat\setup.ps1                 container + CLI
#   .\uat\setup.ps1 -VSCode         also package and install the extension
#   .\uat\setup.ps1 -Desktop        also install the desktop app's packages
#   .\uat\setup.ps1 -NoBuild        do not rebuild the CLI
#
# Another port: $env:LIFTOFF_UAT_PORT = 61500 before running (and in every window, before env.ps1).

param([switch]$VSCode, [switch]$Desktop, [switch]$NoBuild)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'env.ps1')

function Need($cmd, $hint) { if (-not (Get-Command $cmd -ErrorAction SilentlyContinue)) { throw "$cmd not found: $hint" } }
Need docker 'install Docker Desktop or Rancher Desktop and start it'
Need node 'install Node 24'
Need git 'install Git'
$major = [int]((node --version) -replace '^v(\d+).*', '$1')
if ($major -lt 24) { throw "Node 24 or later is needed (this is $(node --version))" }
docker info *> $null
if ($LASTEXITCODE) { throw 'Docker is not running: start Docker Desktop or Rancher Desktop' }

# 1. SQL Server
$state = docker ps -a --filter "name=^$UatContainer$" --format '{{.State}}'
if (-not $state) {
  Write-Host "Starting $UatContainer on port $UatPort"
  docker run -d --name $UatContainer --restart unless-stopped -e ACCEPT_EULA=Y -e MSSQL_PID=Developer `
    -e "MSSQL_SA_PASSWORD=$UatPassword" -p "${UatPort}:1433" mcr.microsoft.com/mssql/server:2022-latest | Out-Null
  if ($LASTEXITCODE) {
    throw @"
Could not start SQL Server on port $UatPort. If Windows reserved the port, it is listed by
  netsh interface ipv4 show excludedportrange protocol=tcp
Pick a free one: `$env:LIFTOFF_UAT_PORT = <port>, remove the container (.\uat\teardown.ps1) and run this again.
"@
  }
} elseif ($state -ne 'running') {
  docker start $UatContainer | Out-Null
}
Write-Host -NoNewline 'Waiting for SQL Server'
for ($i = 0; ; $i++) {
  docker exec $UatContainer /opt/mssql-tools18/bin/sqlcmd -C -S localhost -U sa -P $UatPassword -Q 'SELECT 1' *> $null
  if (-not $LASTEXITCODE) { break }
  if ($i -ge 60) { Write-Host; throw "SQL Server did not start; see: docker logs $UatContainer" }
  Write-Host -NoNewline '.'
  Start-Sleep -Seconds 2
}
Write-Host ' ready'
$published = docker port $UatContainer 1433
if ($published -notmatch ":$UatPort$") { Write-Warning "$UatContainer listens on $published, not $UatPort; set `$env:LIFTOFF_UAT_PORT to match" }

# 2. The CLI, as it ships
Push-Location (Join-Path $UatRepo 'packages\liftoff')
try {
  if (-not (Test-Path node_modules)) { npm install; if ($LASTEXITCODE) { throw 'npm install failed' } }
  if (-not $NoBuild) { npm run build:cli; if ($LASTEXITCODE) { throw 'npm run build:cli failed' } }
} finally { Pop-Location }
Write-Host "liftoff: $(liftoff --version)"

# 3. VS Code
if ($VSCode) {
  Push-Location (Join-Path $UatRepo 'apps\vscode')
  try {
    if (-not (Test-Path node_modules)) { npm install; if ($LASTEXITCODE) { throw 'npm install failed' } }
    npm run package -- --allow-missing-repository
    if ($LASTEXITCODE) { throw 'packaging the extension failed' }
    $vsix = Get-ChildItem liftoff-*.vsix | Sort-Object LastWriteTime | Select-Object -Last 1
    $code = Join-Path $env:LOCALAPPDATA 'Programs\Microsoft VS Code\bin\code.cmd'
    if (-not (Test-Path $code)) { $code = 'code' }
    & $code --install-extension $vsix.FullName --force
    Write-Host "Installed $($vsix.Name); reload open VS Code windows (Developer: Reload Window)"
  } finally { Pop-Location }
}

# 4. Desktop
if ($Desktop) {
  Push-Location (Join-Path $UatRepo 'apps\desktop')
  try {
    if (-not (Test-Path node_modules)) { npm install; if ($LASTEXITCODE) { throw 'npm install failed' } }
    if (-not (Test-Path node_modules\electron\dist)) { node node_modules/electron/install.js }
  } finally { Pop-Location }
  Write-Host 'Desktop app: in a window with env.ps1 loaded, cd apps\desktop; npm start'
}

Write-Host "`nNext: .\uat\reset.ps1 all   (projects go to $UatRoot)"
