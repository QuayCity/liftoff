// The last step of a Windows update, as VS Code does it: the new version is already unpacked
// next to the app (<app>-update), so once the app has closed this only swaps two folders and
// starts it again, a matter of seconds. Run by PowerShell, hidden, after the app quits.
//
// Nothing is left half done: if the app's folder cannot be moved (a file in it is in use, such as
// liftoff.exe running in a terminal), the old version stays and starts again, and <result> says
// why, which the app shows on that start.

export const SWAP_SCRIPT = String.raw`
param([int]$AppPid, [string]$App, [string]$Staged, [string]$Version, [string]$Exe, [string]$Result)
$ErrorActionPreference = 'Stop'
$Old = "$App-old"
$Name = Split-Path -Leaf $App
$Start = Join-Path $App $Exe
function Done([bool]$ok, [string]$message) {
  # WriteAllText: UTF-8 without the byte-order mark Windows PowerShell's Set-Content adds.
  [IO.File]::WriteAllText($Result, (@{ ok = $ok; version = $Version; message = $message } | ConvertTo-Json))
}

# The app and its helper processes (GPU, renderers) all run its exe.
Wait-Process -Id $AppPid -Timeout 60 -ErrorAction SilentlyContinue
for ($i = 0; $i -lt 150; $i++) {
  if (-not (Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.Path -eq $Start })) { break }
  Start-Sleep -Milliseconds 200
}

if (Test-Path -LiteralPath $Old) { Remove-Item -LiteralPath $Old -Recurse -Force -ErrorAction SilentlyContinue }
$moved = $false
for ($i = 0; $i -lt 20 -and -not $moved; $i++) {
  try { Rename-Item -LiteralPath $App -NewName (Split-Path -Leaf $Old); $moved = $true } catch { Start-Sleep -Milliseconds 500 }
}
if (-not $moved) {
  Done $false "LiftOff $Version is downloaded but could not be installed: a file in $App is in use (liftoff running in a terminal, or a window open on that folder?). Close it and restart LiftOff to try again."
  Start-Process -FilePath $Start
  exit 1
}
try {
  Rename-Item -LiteralPath $Staged -NewName $Name
} catch {
  Rename-Item -LiteralPath $Old -NewName $Name
  Done $false "LiftOff $Version could not be put in place: $($_.Exception.Message)"
  Start-Process -FilePath $Start
  exit 1
}

# What the setup added and the zip does not have: the uninstaller, and its elevate helper.
Get-ChildItem -LiteralPath $Old -Filter 'Uninstall *.exe' | Copy-Item -Destination $App
$elevate = Join-Path $Old 'resources\elevate.exe'
if (Test-Path -LiteralPath $elevate) { Copy-Item -LiteralPath $elevate -Destination (Join-Path $App 'resources') }

# Start the new version first; the bookkeeping below does not need it to wait.
Done $true ''
Start-Process -FilePath $Start

# Windows' list of installed apps shows the new version.
Get-ChildItem 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall' -ErrorAction SilentlyContinue | ForEach-Object {
  $p = Get-ItemProperty -LiteralPath $_.PSPath
  if ($p.UninstallString -and $p.UninstallString.Contains("$App\")) {
    Set-ItemProperty -LiteralPath $_.PSPath -Name DisplayVersion -Value $Version
    Set-ItemProperty -LiteralPath $_.PSPath -Name DisplayName -Value "LiftOff $Version"
  }
}

Remove-Item -LiteralPath $Old -Recurse -Force -ErrorAction SilentlyContinue
`
