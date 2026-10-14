# Installing

LiftOff comes in three parts. The command-line program, `liftoff`, does all the work. The VS Code
extension and the desktop app run it for you, and each comes with its own copy, so install only
the one you want: the desktop app's Windows installer gives you the app and the `liftoff` command.

| | Windows | Linux | macOS |
| --- | --- | --- | --- |
| command-line program | yes | yes | yes (Apple silicon) |
| VS Code extension | yes | yes | yes (Apple silicon) |
| desktop app | yes | yes | no, [see why](#the-desktop-app) |

## What you need

- **A database server you can create databases on**: PostgreSQL or SQL Server (or a SQLite file), including Azure
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

The desktop app is for **Windows and Linux**. Download it from the same Releases page; the Windows
installer includes the `liftoff` program, so that is the only download you need there.

| platform | file | install |
| --- | --- | --- |
| Windows (x64) | `LiftOff-Setup-<version>.exe` | run it and follow the wizard |
| Linux (x64) | `LiftOff-<version>-x86_64.AppImage` | `chmod +x` it and run it |

**Windows.** The wizard installs for your user only, so it needs no administrator rights. You
choose the folder (default `%LOCALAPPDATA%\Programs\LiftOff`), and it adds:
- LiftOff to the Start menu and the desktop;
- the `liftoff` command to your PATH, so it works in any new terminal;
- an uninstaller under **Settings > Apps**, which also takes `liftoff` off the PATH. Your projects
  and saved passwords are not touched.

For a silent install (a script, or software deployment):
`LiftOff-Setup-<version>.exe /S /D=C:\Tools\LiftOff`.

**Not signed yet.** Until the installer is code-signed, Windows SmartScreen says "Windows
protected your PC" the first time: click **More info** > **Run anyway**.

**Linux.** The AppImage runs the app; for `liftoff` in a terminal, install
[the command-line program](#the-command-line-program) as well.

**macOS.** There is no desktop app for macOS. An app that opens on a Mac without warnings has to be
signed and notarised by Apple, which needs a paid Apple Developer membership; an unsigned one is
blocked by Gatekeeper, and since macOS 15 getting past that takes several steps in System
Settings. On a Mac, use [the command-line program](#the-command-line-program) or
[the VS Code extension](#the-vs-code-extension): both do everything the app does. A signed macOS
app may follow if there is demand.

See [The desktop app](desktop-app.md).

### From the source code

For working on the app, with Node.js 24 and git:

```sh
git clone https://github.com/sanderstad/liftoff.git
cd liftoff/apps/desktop
npm install
npm start              # build and run
npm run dist           # build the installer for this platform into release/ (run npm run build:cli in packages/liftoff first)
```

If it says Electron failed to install, run `node node_modules/electron/install.js` in
`apps/desktop` and try again.

## Building the program yourself

With Node.js 24, in `packages/liftoff`:

```sh
npm install
npm run build:cli      # writes build/liftoff (build/liftoff.exe on Windows)
```

Or run it straight from the source: `node packages/liftoff/src/cli/main.ts --help`.

## What it connects to

The `liftoff` program and the VS Code extension only connect to your databases, plus Microsoft's
sign-in service when a SQL Server environment signs in with Microsoft Entra ID. There is no
telemetry and no account. A CI runner only needs to reach the databases.

The desktop app also looks for updates of itself: it asks GitHub for the latest LiftOff release
(`api.github.com`), and downloads the new setup or AppImage from GitHub when you update. Nothing
about you or your projects is sent. **App settings > Updates** chooses: download automatically and let
you choose when to restart (the default), only tell you, or never check, which leaves the
databases as its only connections. See [The desktop app](desktop-app.md#updates).
