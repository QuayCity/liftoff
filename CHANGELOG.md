# Changes

Every release has a section here, `## <version>`, written before it is tagged: the release
workflow publishes that section as the release notes (the desktop app shows them under About and
What's new) and refuses a tag without one. Keep each list item on one line, and use only
headings, list items and bold: the app shows nothing else.

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
