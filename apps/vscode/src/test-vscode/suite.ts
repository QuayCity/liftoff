// Runs inside VS Code (see run.ts). VS Code calls `run`; a thrown error fails the test.

import assert from 'node:assert/strict'
import * as path from 'node:path'
import * as vscode from 'vscode'
import type { Liftoff } from '../extension'
import * as fs from 'node:fs'
import * as os from 'node:os'
import type { CompareResult } from '../compareView'
import type { DataComparePanel } from '../dataCompare'
import type { ConvertReport } from '../flywayImport'
import type { MigrateResult, ModelChange } from '../model'
import type { SettingsPanel } from '../settingsPanel'

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

  // Run This Script Only: V3 alone; V2 is older, stays behind, and can then be picked too.
  fs.writeFileSync(path.join(workspace, 'migrations', 'V2__notes.sql'), 'create table notes (id int);\n')
  fs.writeFileSync(path.join(workspace, 'migrations', 'V3__tags.sql'), 'create table tags (id int);\n')
  let items = await lo.getChildren(envItem)
  const v3 = items.find((i) => i.label === 'V3__tags.sql')!
  assert.equal(v3.contextValue, 'migration.pickable')
  assert.equal(items.find((i) => i.label === 'V1__orders.sql')?.contextValue, 'migration', 'an applied script cannot be picked')
  let picked = await vscode.commands.executeCommand<MigrateResult>('liftoff.runOnly', v3, true)
  assert.deepEqual([picked?.applied.map((a) => a.script), picked?.left_behind], [['V3__tags.sql'], ['V2__notes.sql']])
  items = await lo.getChildren(envItem)
  assert.match(String(items.find((i) => i.label === 'V2__notes.sql')?.description), /skipped/)
  picked = await vscode.commands.executeCommand<MigrateResult>('liftoff.runOnly', items.find((i) => i.label === 'V2__notes.sql'), true)
  assert.deepEqual(picked?.applied.map((a) => a.script), ['V2__notes.sql'])

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
  // Import a Flyway project: the wizard's answers given, so nothing is asked.
  const flywayDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lo-flyway-'))
  fs.writeFileSync(
    path.join(flywayDir, 'flyway.toml'),
    '[environments.development]\nurl = "jdbc:postgresql://db/dev"\n\n[environments.live]\nurl = "jdbc:postgresql://db/live"\n\n[flyway]\nlocations = ["filesystem:sql"]\n',
  )
  const imported = await vscode.commands.executeCommand<ConvertReport>('liftoff.importFlyway', { folder: flywayDir, include: ['live'], roles: { live: 'prod' }, name: 'legacy', history: [] })
  assert.deepEqual(imported?.environments, ['live'])
  const toml = fs.readFileSync(path.join(flywayDir, 'liftoff.toml'), 'utf8')
  assert.match(toml, /name = "legacy"/)
  assert.match(toml, /\[environments\.live\][^[]*role = "prod"/)
  assert.ok(fs.existsSync(path.join(flywayDir, 'flyway.toml')), 'the Flyway file stays')

  // Settings: add an environment (with a password) and remove it again; the sidebar follows.
  const panel = await vscode.commands.executeCommand<SettingsPanel>('liftoff.settings')
  assert.ok(panel, 'the settings open')
  let saved = await panel.save({ environments: [{ name: 'qa', url: 'postgres://localhost/shop_qa', user: 'app', password: 'qa-secret', role: 'test', allow_clean: false, placeholders: {}, shared: false }] })
  assert.ok(saved?.environments.some((e) => e.name === 'qa' && e.has_password && !e.shared))
  assert.ok(lo.project?.environments.some((e) => e.name === 'qa'), 'the sidebar shows the new environment')
  assert.ok(!fs.readFileSync(path.join(workspace, 'liftoff.toml'), 'utf8').includes('qa'), 'a this-computer-only environment stays out of liftoff.toml')
  saved = await panel.save({ remove: ['qa'] })
  assert.ok(saved && !saved.environments.some((e) => e.name === 'qa'))
  panel.panel.dispose()

  // A new project in an empty folder (outside the workspace, so nothing else opens): empty, and the sample.
  const blank = fs.mkdtempSync(path.join(os.tmpdir(), 'lo-new-'))
  assert.equal(await vscode.commands.executeCommand('liftoff.newProject', { folder: blank, engine: 'sqlserver', sample: false, name: 'billing' }), path.join(blank, 'liftoff.toml'))
  assert.match(fs.readFileSync(path.join(blank, 'liftoff.toml'), 'utf8'), /name = "billing"[^]*engine = "sqlserver"/)
  const sampleDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lo-new-'))
  await vscode.commands.executeCommand('liftoff.newProject', { folder: sampleDir, engine: 'sqlserver', sample: true, name: 'try-it' })
  assert.match(fs.readFileSync(path.join(sampleDir, 'liftoff.toml'), 'utf8'), /name = "try-it"/)
  assert.match(fs.readFileSync(path.join(sampleDir, 'migrations', 'V0001__customers.sql'), 'utf8'), /IDENTITY/)

  // Compare: test has notes and tags (picked above); dev does not. Make dev like test.
  const compared = await vscode.commands.executeCommand<CompareResult>('liftoff.compare', { source: 'test', target: 'dev' })
  assert.deepEqual(compared?.changes.map((c) => c.id).sort(), ['table:public.notes', 'table:public.tags'])
  assert.deepEqual([...lo.compare!.checked].sort(), ['table:public.notes', 'table:public.tags'], 'nothing here can lose data, so all start ticked')
  // Show the Difference: the source side is the table's DDL (the diff editor's URIs end in .sql).
  const side = await vscode.workspace.openTextDocument(vscode.Uri.parse(`liftoff-compare:/source/${encodeURIComponent('table:public.notes')}.sql`))
  assert.match(side.getText(), /notes/)
  lo.compare!.checked.delete('table:public.tags')
  const script = await vscode.commands.executeCommand<string>('liftoff.compare.script')
  assert.match(script ?? '', /Makes dev match test/)
  assert.match(script ?? '', /notes/)
  assert.doesNotMatch(script ?? '', /tags/, 'only what is ticked')
  await vscode.commands.executeCommand('liftoff.compare.apply', true)
  assert.deepEqual(lo.compare!.result?.changes.map((c) => c.id), ['table:public.tags'], 'compared again after applying')
  const snap = await vscode.commands.executeCommand<string>('liftoff.snapshot', 'dev', path.join(workspace, 'snapshots', 'dev.json'))
  assert.ok(snap && fs.existsSync(snap))
  const again = await vscode.commands.executeCommand<CompareResult>('liftoff.compare', { source: `snapshot:${snap}`, target: 'dev' })
  assert.equal(again?.changes.length, 0, 'a snapshot matches what it was taken from')

  // Compare Data: orders has a key and the same rows; notes has no key, so its whole rows are
  // compared; tags is only on one side. Pages and the script come from the saved keys.
  const data = await vscode.commands.executeCommand<DataComparePanel>('liftoff.dataCompare', { source: 'test', target: 'dev' })
  assert.deepEqual(
    data?.result?.tables.map((t) => [t.table, t.skipped ? 'skipped' : t.only_in_source + t.only_in_target + t.different, !!t.whole_rows]),
    [['public.notes', 0, true], ['public.orders', 0, false], ['public.tags', 'skipped', false]],
  )
  assert.deepEqual(await data!.rows('public.orders', 'different'), { columns: ['id'], key: ['id'], total: 0, rows: [] })
  assert.match((await data!.script()) ?? '', /Makes the rows of dev match test/)
  data!.panel.dispose()

  // Rebaseline into an archive folder (the workspace is not a git repository, so not deleted).
  const rb = await vscode.commands.executeCommand<{ baseline: string; removed: string[] }>('liftoff.rebaseline', { description: 'start here', archive: 'old' })
  assert.match(path.basename(rb?.baseline ?? ''), /^B\d+__start_here\.sql$/)
  assert.ok(rb && rb.removed.includes('V1__orders.sql') && fs.existsSync(path.join(workspace, 'old', 'V1__orders.sql')))
  assert.deepEqual(fs.readdirSync(path.join(workspace, 'migrations')).filter((f) => f.startsWith('V')), [])

  // A restart: B0001 replaces everything; test, which ran the old scripts, goes through it on its next run.
  const restarted = await vscode.commands.executeCommand<{ baseline: string }>('liftoff.rebaseline', { description: 'fresh', archive: 'old2', restart: true })
  assert.equal(path.basename(restarted?.baseline ?? ''), 'B0001__fresh.sql')
  const afterRestart = await vscode.commands.executeCommand<MigrateResult>('liftoff.migrate', envItem)
  assert.equal(afterRestart?.baseline_check?.restart, true, JSON.stringify(afterRestart))

  fs.writeFileSync(path.join(workspace, '.suite-passed'), '')
  console.log('liftoff suite: all checks passed')
}
