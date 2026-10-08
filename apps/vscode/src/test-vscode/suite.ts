// Runs inside VS Code (see run.ts). VS Code calls `run`; a thrown error fails the test.

import assert from 'node:assert/strict'
import * as path from 'node:path'
import * as vscode from 'vscode'
import type { Liftoff } from '../extension'
import * as fs from 'node:fs'
import type { MigrateResult, ModelChange } from '../model'

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
  assert.deepEqual(lo.project?.environments.map((e) => e.name).sort(), ['dev', 'scratch', 'test'])
  const envItem = (await lo.getChildren()).find((i) => i.label === 'test')!
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
  // Schema Model: dev has orders, the files do not. Pull it, then the view is clear.
  const view = lo.schemaModel!
  const changes = await vscode.commands.executeCommand<ModelChange[]>('liftoff.model.compare')
  assert.deepEqual(changes?.map((c) => [c.path, c.kind]), [['public/tables/orders.sql', 'added']])
  const [orderItem] = view.getChildren()
  assert.equal(orderItem.description, 'table · new in dev')
  assert.equal(await vscode.commands.executeCommand('liftoff.model.pull', orderItem), 1)
  const pulled = path.join(workspace, 'schema-model', 'public', 'tables', 'orders.sql')
  assert.match(fs.readFileSync(pulled, 'utf8'), /CREATE TABLE public\.orders/i)
  assert.match(String(view.getChildren()[0].label), /matches dev/)

  // A hand-written file that does not build gets an error in Problems.
  const bad = vscode.Uri.file(path.join(workspace, 'schema-model', 'public', 'views', 'bad.sql'))
  fs.mkdirSync(path.dirname(bad.fsPath), { recursive: true })
  fs.writeFileSync(bad.fsPath, 'CREATE VIEW public.bad AS SELECT nope FROM public.orders;\n')
  assert.equal(await vscode.commands.executeCommand('liftoff.model.check'), false)
  const errors = vscode.languages.getDiagnostics(bad)
  assert.equal(errors[0]?.severity, vscode.DiagnosticSeverity.Error)
  fs.rmSync(bad.fsPath)
  assert.equal(await vscode.commands.executeCommand('liftoff.model.check'), true)
  assert.equal(vscode.languages.getDiagnostics(bad).length, 0)
  fs.writeFileSync(path.join(workspace, '.suite-passed'), '')
  console.log('liftoff suite: all checks passed')
}
