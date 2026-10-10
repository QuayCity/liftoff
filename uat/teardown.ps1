# Removes everything UAT made: the SQL Server container (with its databases) and the project
# folders under $UatRoot. Passwords LiftOff saved in the Windows Credential Manager while testing
# are listed at the end, to remove by hand if you want.

param([switch]$KeepFolders)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'env.ps1')

if (docker ps -a --filter "name=^$UatContainer$" --format '{{.Names}}') {
  docker rm -f $UatContainer | Out-Null
  Write-Host "Removed $UatContainer"
}
if (-not $KeepFolders -and (Test-Path $UatRoot)) {
  Remove-Item -Recurse -Force $UatRoot
  Write-Host "Removed $UatRoot"
}
cmdkey /list | Select-String -SimpleMatch 'liftoff' | ForEach-Object { "Saved credential: $($_.Line.Trim())" }
