// Runs inside VS Code (see run.ts). VS Code calls `run`; a thrown error fails the test.

import assert from 'node:assert/strict'
import * as path from 'node:path'
import * as vscode from 'vscode'
import type { Liftoff } from '../extension'
import type { MigrateResult } from '../model'

async function until<T>(what: string, check: () => T | undefined | Promise<T | undefined>, ms = 15000): Promise<T> {
  const end = Date.now() + ms
  for (;;) {
    const v = await check()
    if (v) return v
    if (Date.now() > end) throw new Error(`timed out waiting for: ${what}`)
    await new Promise((r) => setTimeout(r, 200))
  }
}

export async function run(): Promise<void> {
  const workspace = process.env.LIFTOFF_WORKSPACE!
  const ext = vscode.extensions.getExtension<Liftoff>('liftoff.liftoff')
  assert.ok(ext, 'extension is installed')
  const lo = await ext.activate()

  // The sidebar lists the environment from liftoff.toml, then its migrations.
  assert.deepEqual(lo.project?.environments.map((e) => e.name), ['test'])
  const [envItem] = await lo.getChildren()
  assert.equal(envItem.label, 'test')
  assert.match(String(envItem.description), /test · PostgreSQL/)
  const before = await lo.getChildren(envItem)
  assert.deepEqual(before.map((i) => [i.label, i.description]), [['V1__orders.sql', 'pending']])
  assert.equal(before[0].command?.command, 'vscode.open', 'clicking a script opens it')

  // Run Pending Migrations on that environment.
  const result = await vscode.commands.executeCommand<MigrateResult>('liftoff.migrate', envItem)
  assert.deepEqual(result?.applied.map((a) => a.script), ['V1__orders.sql'])
  const after = await lo.getChildren(envItem)
  assert.match(String(after[0].description), /^applied · /)

  // Editing a script that already ran puts a warning on it once it is saved.
  const file = vscode.Uri.file(path.join(workspace, 'migrations', 'V1__orders.sql'))
  const doc = await vscode.workspace.openTextDocument(file)
  const edit = new vscode.WorkspaceEdit()
  edit.insert(file, new vscode.Position(1, 0), '-- edited later\n')
  await vscode.workspace.applyEdit(edit)
  await doc.save()
  const warnings = await until('a warning on the edited script', () => {
    const d = vscode.languages.getDiagnostics(file)
    return d.length ? d : undefined
  })
  assert.equal(warnings[0].severity, vscode.DiagnosticSeverity.Warning)
  assert.match(warnings[0].message, /Changed after it ran on test/)
  assert.equal(warnings[0].source, 'LiftOff')
  console.log('liftoff suite: all checks passed')
}
