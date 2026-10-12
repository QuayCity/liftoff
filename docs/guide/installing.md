# Installing

LiftOff comes in three parts. The command-line program, `liftoff`, does all the work. The VS Code
extension and the desktop app run it for you.

## What you need

- **A database server you can create databases on**: PostgreSQL or SQL Server, including Azure
  SQL. The automated tests run against PostgreSQL 16 and SQL Server 2022.
- **One extra empty database for the scratch environment** (see [Concepts](concepts.md#the-scratch-database)).
  LiftOff can create it for you if your login is allowed to create databases.
- **git** is recommended. LiftOff works without it, but the migrations are meant to live in a
  repository. `renumber`, `rebaseline` (without `--archive`) and the desktop app's Commit screen
  need it.

You do not need Java, .NET, Node.js or any database driver: the program carries what it needs.

## The command-line program

Download the file for your platform from the project's
[Releases](https://github.com/sanderstad/liftoff/releases) page:

| platform | file |
| --- | --- |
| Windows (x64) | `liftoff-win-x64.exe` |
| Linux (x64) | `liftoff-linux-x64` |
| macOS (Apple silicon) | `liftoff-macos-arm64` |

Rename it to `liftoff` (`liftoff.exe` on Windows) and put it in a folder on your `PATH`.

```sh
# Linux and macOS
curl -fsSL -o liftoff https://github.com/sanderstad/liftoff/releases/latest/download/liftoff-linux-x64
sudo install -m 755 liftoff /usr/local/bin/liftoff
```

```powershell
# Windows, PowerShell
New-Item -ItemType Directory -Force "$env:LOCALAPPDATA\Programs\liftoff" | Out-Null
Invoke-WebRequest https://github.com/sanderstad/liftoff/releases/latest/download/liftoff-win-x64.exe `
  -OutFile "$env:LOCALAPPDATA\Programs\liftoff\liftoff.exe"
# then add that folder to your PATH (Settings > System > About > Advanced system settings > Environment Variables)
```

Check it:

```sh
liftoff --version     # liftoff 0.1.0
liftoff --help        # the rocket and every command
```

On macOS, a downloaded program may be blocked the first time. Allow it under **System Settings >
Privacy & Security**, or run `xattr -d com.apple.quarantine liftoff`.

## The VS Code extension

Download `liftoff-vscode-<platform>.vsix` from the same Releases page (`win32-x64`, `linux-x64` or
`darwin-arm64`). It includes the `liftoff` program, so you do not need to install that separately.

In VS Code: **Extensions** view > the `…` menu > **Install from VSIX…**, and pick the file. Or from
a terminal:

```sh
code --install-extension liftoff-vscode-win32-x64.vsix
```

On Windows, if that command opens a VS Code window and does nothing else, use the full path:
`"%LOCALAPPDATA%\Programs\Microsoft VS Code\bin\code.cmd" --install-extension …`.

The LiftOff rocket appears in the activity bar on the left. See [The VS Code extension](vscode.md).

## The desktop app

The desktop app is not packaged as an installer yet. To run it from the source code, you need
Node.js 24 and git:

```sh
git clone https://github.com/sanderstad/liftoff.git
cd liftoff/apps/desktop
npm install
npm start
```

If it says Electron failed to install, run `node node_modules/electron/install.js` in
`apps/desktop` and try again. See [The desktop app](desktop-app.md).

## Building the program yourself

With Node.js 24, in `packages/liftoff`:

```sh
npm install
npm run build:cli      # writes build/liftoff (build/liftoff.exe on Windows)
```

Or run it straight from the source: `node packages/liftoff/src/cli/main.ts --help`.

## What it connects to

The program only connects to your databases, plus Microsoft's sign-in service when a SQL Server
environment signs in with Microsoft Entra ID. There is no telemetry, no update check and no
account. A CI runner only needs to reach the databases.
