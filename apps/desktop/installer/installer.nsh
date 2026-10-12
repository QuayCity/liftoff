; Extra steps for the Windows installer (electron-builder NSIS). The installer is per user, like
; VS Code's user setup, so it needs no administrator rights and changes only the user's PATH.
; `liftoff` (the command-line program) lands in resources\bin; putting that folder on the PATH
; makes `liftoff` work in any new terminal. .NET's SetEnvironmentVariable tells running programs
; the PATH changed.

!macro customInstall
  nsExec::Exec `powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "$$d = '$INSTDIR\resources\bin'; $$p = [Environment]::GetEnvironmentVariable('Path', 'User'); $$parts = @($$p -split ';' | Where-Object { $$_ }); if ($$parts -notcontains $$d) { [Environment]::SetEnvironmentVariable('Path', (($$parts + $$d) -join ';'), 'User') }"`
!macroend

!macro customUnInstall
  nsExec::Exec `powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "$$d = '$INSTDIR\resources\bin'; $$p = [Environment]::GetEnvironmentVariable('Path', 'User'); $$parts = @($$p -split ';' | Where-Object { $$_ -and $$_ -ne $$d }); [Environment]::SetEnvironmentVariable('Path', ($$parts -join ';'), 'User')"`
!macroend
