# Changes

Every release has a section here, `## <version>`, written before it is tagged: the release
workflow publishes that section as the release notes (the desktop app shows them under About and
What's new) and refuses a tag without one. Keep each list item on one line, and use only
headings, list items and bold: the app shows nothing else.

## 0.4.2

### New
- **All of LiftOff inside VS Code.** Open LiftOff (the rocket on the status bar, or the command palette) shows every screen of the desktop app in an editor tab: Overview, Changes, Environments, Compare, Scripts, Rules, Commit, History, Pipelines and Project settings. You no longer need to leave your editor.
- **The workspace's projects open by themselves** in VS Code, one tab each, and the panel follows VS Code's light or dark theme and uses its own file pickers and questions.
- **Each project tab shows its database**: PG for PostgreSQL, MS for SQL Server.
- **Drag project tabs into the order you like**, or move the tab in focus with Alt+Left and Alt+Right. The desktop app remembers the order.

## 0.4.1

### New
- **Project settings and App settings are apart.** The gear at the foot of the sidebar opens Project settings: only this project's own settings, kept in its liftoff.toml. The new gear in the title bar and on the start page opens App settings, for LiftOff itself on this computer, such as how it updates; it is there with no project open too.

### Also new since 0.3.0 (from 0.4.0)
- **Several projects open at once**, one tab each in the title bar: + opens another, × closes one. Each project keeps its own screen, comparisons and unsaved edits while you work in another.
- **The open projects come back** when LiftOff starts again, after an update too, each on the screen it was on.
- **Restart to update asks first** when Settings or Rules has unsaved changes, as the restart would lose them.
- **Azure DevOps pipelines**: liftoff ci --platform azure writes azure-pipelines.yml, and the Pipelines screen has Runs on: GitHub Actions or Azure DevOps.
- **A new colour scheme, Sky**: cool greys and the sky blue from the logo, in light and dark.
- **The theme button opens a menu** with Same as the system, Light and Dark, instead of cycling through them one click at a time.

## 0.4.0

- **Several projects open at once**, one tab each in the title bar: + opens another, × closes one. Each project keeps its own screen, comparisons and unsaved edits while you work in another.
- **The open projects come back** when LiftOff starts again, after an update too, each on the screen it was on.
- **Restart to update asks first** when Settings or Rules has unsaved changes, as the restart would lose them.
- **Settings** moved from the title bar to the foot of the sidebar.
- **Azure DevOps pipelines**: liftoff ci --platform azure writes azure-pipelines.yml, and the Pipelines screen has Runs on: GitHub Actions or Azure DevOps.
- **A new colour scheme, Sky**: cool greys and the sky blue from the logo, in light and dark.
- **The theme button opens a menu** with Same as the system, Light and Dark.
