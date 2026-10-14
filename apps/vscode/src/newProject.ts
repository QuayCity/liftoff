// LiftOff: New Project, over `liftoff init` (or `init --sample`): where, which engine, empty or the
// sample, and a name. Then the settings open with a new environment to fill in.
// Tests pass `answers` to skip the prompts.

import * as fs from 'node:fs'
import * as path from 'node:path'
import * as vscode from 'vscode'
import type { Liftoff } from './extension'

export type NewProjectAnswers = {
  folder?: string
  engine?: 'postgresql' | 'sqlserver' | 'mysql'
  sample?: boolean
  name?: string
}

const title = (n: number) => `New LiftOff project (${n}/3)`

export async function newProject(lo: Liftoff, answers: NewProjectAnswers = {}): Promise<string | undefined> {
  const folder = answers.folder ?? (await pickFolder())
  if (!folder) return undefined
  if (fs.existsSync(path.join(folder, 'liftoff.toml'))) {
    void vscode.window.showInformationMessage(`${folder} already has a LiftOff project.`)
    return undefined
  }

  const engine =
    answers.engine ??
    (
      await vscode.window.showQuickPick(
        [
          { label: 'PostgreSQL', engine: 'postgresql' as const },
          { label: 'SQL Server', engine: 'sqlserver' as const },
          { label: 'MySQL', engine: 'mysql' as const },
        ],
        { title: title(1), placeHolder: 'Which database engine?', ignoreFocusOut: true },
      )
    )?.engine
  if (!engine) return undefined

  // The sample only goes into an empty folder (the CLI refuses otherwise).
  const empty = fs.readdirSync(folder).filter((f) => !f.startsWith('.')).length === 0
  let sample = answers.sample ?? false
  if (answers.sample === undefined && empty) {
    const pick = await vscode.window.showQuickPick(
      [
        { label: 'Empty project', detail: 'liftoff.toml, a migrations folder and a schema-model folder', sample: false },
        { label: 'Sample shop project', detail: 'A few tables, a view and their migration scripts, to try things out', sample: true },
      ],
      { title: title(2), placeHolder: 'Start from', ignoreFocusOut: true },
    )
    if (!pick) return undefined
    sample = pick.sample
  }

  const name =
    answers.name ??
    (await vscode.window.showInputBox({
      title: title(3),
      prompt: 'Project name',
      value: path.basename(folder),
      ignoreFocusOut: true,
      validateInput: (v) => (v.trim() ? undefined : 'Give the project a name'),
    }))
  if (!name) return undefined

  try {
    await lo.runIn(folder, sample ? ['init', '--sample', '--engine', engine] : ['init', '--name', name.trim(), '--engine', engine])
    // The sample has its own name; use the one given.
    if (sample) await lo.runIn(folder, ['settings', '--save'], undefined, JSON.stringify({ project: { name: name.trim() } }))
  } catch (e) {
    void vscode.window.showErrorMessage(e instanceof Error ? e.message : String(e))
    return undefined
  }

  const file = path.join(folder, 'liftoff.toml')
  const inWorkspace = vscode.workspace.workspaceFolders?.some((w) => folder === w.uri.fsPath || folder.startsWith(w.uri.fsPath + path.sep))
  if (!inWorkspace) {
    // A new window on the folder; the extension starts there and finds the project.
    if (answers.folder === undefined) await vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(folder))
    return file
  }
  await lo.load()
  if (answers.folder === undefined) {
    // Next: where the databases are.
    void vscode.commands.executeCommand('liftoff.settings', '+')
  }
  return file
}

async function pickFolder(): Promise<string | undefined> {
  const folders = vscode.workspace.workspaceFolders ?? []
  if (folders.length === 1) return folders[0].uri.fsPath
  if (folders.length > 1) {
    const pick = await vscode.window.showQuickPick(
      folders.map((f) => ({ label: f.name, description: f.uri.fsPath, dir: f.uri.fsPath })),
      { title: 'New LiftOff project', placeHolder: 'In which folder?' },
    )
    return pick?.dir
  }
  const chosen = await vscode.window.showOpenDialog({ canSelectFolders: true, canSelectFiles: false, openLabel: 'Create the project here', title: 'Folder for the new LiftOff project' })
  return chosen?.[0]?.fsPath
}
