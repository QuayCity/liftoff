// Import a Flyway project: a short wizard over `liftoff init --from-flyway`.
//
//   1. which Flyway config file (only when the folder has more than one)
//   2. which environments to bring over
//   3. their roles (guessed from the names; dev, scratch, test or prod)
//   4. the project name
//   5. a summary, including what does not carry over; nothing is written before this
//   then, per database: copy Flyway's history over, so LiftOff knows what already ran there
//
// Esc cancels at any step. Tests pass `answers` to skip the prompts.

import * as path from 'node:path'
import * as vscode from 'vscode'
import { LiftoffError } from './cli'
import type { Liftoff } from './extension'

type Role = 'dev' | 'scratch' | 'test' | 'prod'

/** `liftoff init --from-flyway --preview` (and without --preview) */
export type ConvertReport = {
  source: string
  sources: string[]
  written: string
  environments: string[]
  migrations: string
  schemas: string[]
  flyway_table: string
  not_converted: string[]
  notes: string[]
  planned: { name: string; role: Role; url: string; user: string | null; has_password: boolean; skipped: boolean }[]
}

type HistoryImport = { environment: string; imported: number; skipped: string[]; edited: string[]; attention: string[] }

/** The wizard's choices; any left out are asked for. */
export type ImportAnswers = {
  folder?: string
  source?: string
  include?: string[]
  roles?: Record<string, Role>
  name?: string
  /** environments to copy the Flyway history from (default: ask) */
  history?: string[]
}

const ROLE_HELP: Record<Role, string> = {
  dev: 'Where you make changes by hand; compared with the schema model and the migrations',
  scratch: 'A throwaway database LiftOff rebuilds for comparisons (Flyway calls it the shadow database)',
  test: 'Gets the migrations: test, acceptance, staging',
  prod: 'Gets the migrations, with extra confirmation',
}

const STEPS = 5
const title = (n: number) => `Import Flyway project (${n}/${STEPS})`

export async function importFlyway(lo: Liftoff, answers: ImportAnswers = {}): Promise<ConvertReport | undefined> {
  const folder = answers.folder ?? (await pickFolder(lo))
  if (!folder) return undefined
  const preview = (extra: string[] = []) => lo.runIn<ConvertReport>(folder, ['init', '--from-flyway', '--preview', ...extra])

  let report: ConvertReport
  try {
    report = await preview()
  } catch (e) {
    void vscode.window.showErrorMessage(e instanceof Error ? e.message : String(e))
    return undefined
  }

  // 1. The config file, when there is a choice.
  let source = answers.source
  if (source === undefined && report.sources.length > 1) {
    const pick = await vscode.window.showQuickPick(
      report.sources.map((f) => ({ label: path.relative(folder, f), description: f === report.source ? 'used by default' : undefined })),
      { title: title(1), placeHolder: 'This folder has more than one Flyway config file. Which one should be imported?', ignoreFocusOut: true },
    )
    if (!pick) return undefined
    source = pick.label
  }
  const sourceArgs = source ? ['--flyway-config', source] : []
  if (source) report = await preview(sourceArgs)
  if (!report.planned.length) {
    void vscode.window.showWarningMessage('The Flyway config has no environments LiftOff can use (PostgreSQL or SQL Server). Add them in LiftOff: Project Settings after the import.')
  }

  // 2. Which environments.
  let include = answers.include
  if (include === undefined && report.planned.length) {
    const picks = await vscode.window.showQuickPick(
      report.planned.map((e) => ({ label: e.name, description: e.url, detail: e.has_password ? 'with a password (stored in your keychain, not in git)' : undefined, picked: true })),
      { title: title(2), placeHolder: 'Environments to bring over (all are selected)', canPickMany: true, ignoreFocusOut: true },
    )
    if (!picks) return undefined
    include = picks.map((p) => p.label)
  }
  include ??= report.planned.map((e) => e.name)

  // 3. Roles: guessed from the names, shown so they can be corrected.
  const roles: Record<string, Role> = Object.fromEntries(report.planned.filter((e) => include!.includes(e.name)).map((e) => [e.name, answers.roles?.[e.name] ?? e.role]))
  if (answers.roles === undefined && include.length) {
    for (;;) {
      const done = { label: '$(check) These roles are right', env: undefined as string | undefined }
      const pick = await vscode.window.showQuickPick(
        [done, ...Object.entries(roles).map(([env, role]) => ({ label: env, description: role, detail: ROLE_HELP[role], env }))],
        { title: title(3), placeHolder: 'Roles were guessed from the names. Pick an environment to change its role.', ignoreFocusOut: true },
      )
      if (!pick) return undefined
      if (!pick.env) break
      const role = await vscode.window.showQuickPick(
        (Object.keys(ROLE_HELP) as Role[]).map((r) => ({ label: r, detail: ROLE_HELP[r], picked: r === roles[pick.env!] })),
        { title: `${title(3)}: ${pick.env}`, placeHolder: `The role of ${pick.env}`, ignoreFocusOut: true },
      )
      if (role) roles[pick.env] = role.label as Role
    }
  }

  // 4. The name.
  const name =
    answers.name ??
    (await vscode.window.showInputBox({
      title: title(4),
      prompt: 'Project name',
      value: path.basename(folder),
      ignoreFocusOut: true,
      validateInput: (v) => (v.trim() ? undefined : 'Give the project a name'),
    }))
  if (!name) return undefined

  // 5. The summary; nothing is written before this.
  const args = ['init', '--from-flyway', '--name', name.trim(), ...sourceArgs, ...include.flatMap((e) => ['--include', e]), ...Object.entries(roles).flatMap(([e, r]) => ['--role', `${e}=${r}`])]
  if (answers.name === undefined) {
    const lines = [
      `From ${path.relative(folder, report.source) || report.source}`,
      `Scripts: ${report.migrations}    Schemas: ${report.schemas.join(', ')}`,
      `Environments: ${Object.entries(roles).map(([e, r]) => `${e} (${r})`).join(', ') || 'none'}`,
      ...(report.not_converted.length ? ['', 'Not carried over:', ...report.not_converted.map((n) => `• ${n}`)] : []),
      ...(report.notes.length ? ['', ...report.notes.map((n) => `Note: ${n}`)] : []),
      '',
      'Your Flyway files stay as they are.',
    ]
    const go = await vscode.window.showInformationMessage(`${title(5)}: write liftoff.toml?`, { modal: true, detail: lines.join('\n') }, 'Import')
    if (go !== 'Import') return undefined
  }
  let written: ConvertReport
  try {
    written = await lo.runIn<ConvertReport>(folder, args)
  } catch (e) {
    void vscode.window.showErrorMessage(e instanceof Error ? e.message : String(e))
    return undefined
  }
  for (const n of [...written.not_converted.map((n) => `not converted: ${n}`), ...written.notes.map((n) => `note: ${n}`)]) lo.log.appendLine(n)
  await lo.load()

  // Then the history, per database: what Flyway already ran there.
  await importHistory(lo, folder, written, answers.history)
  void vscode.window.showInformationMessage(`Imported ${name.trim()}. Its settings are in LiftOff: Project Settings.`, 'Open Settings').then((c) => {
    if (c) void vscode.commands.executeCommand('liftoff.settings')
  })
  return written
}

async function pickFolder(lo: Liftoff): Promise<string | undefined> {
  if (lo.projectDir) {
    void vscode.window.showInformationMessage(`This workspace already has a LiftOff project (${lo.projectDir}).`)
    return undefined
  }
  if (lo.flywayDirs.length === 1) return lo.flywayDirs[0]
  if (lo.flywayDirs.length > 1) {
    const pick = await vscode.window.showQuickPick(lo.flywayDirs.map((d) => ({ label: path.basename(d), description: d, dir: d })), { title: 'Import Flyway project', placeHolder: 'Which Flyway project?' })
    return pick?.dir
  }
  const chosen = await vscode.window.showOpenDialog({ canSelectFolders: true, canSelectFiles: false, openLabel: 'Import this Flyway project', title: 'The folder with flyway.toml or flyway.conf' })
  return chosen?.[0]?.fsPath
}

async function importHistory(lo: Liftoff, folder: string, report: ConvertReport, chosen?: string[]): Promise<void> {
  const envs = report.planned.filter((e) => report.environments.includes(e.name))
  if (!envs.length) return
  if (envs[0].url.startsWith('sqlserver:')) {
    void vscode.window.showInformationMessage(
      "Copying Flyway's history works on PostgreSQL only for now. On SQL Server, mark each database at Flyway's latest version with \"liftoff baseline\".",
    )
    return
  }
  let names = chosen
  if (names === undefined) {
    const picks = await vscode.window.showQuickPick(
      envs.map((e) => ({ label: e.name, description: e.role, detail: e.url, picked: e.role !== 'scratch' && e.role !== 'dev' })),
      {
        title: 'Copy the Flyway history',
        placeHolder: `Copy ${report.flyway_table} into LiftOff's history on these databases now? (Each one is connected to; you can do it later with "liftoff import-flyway-history".)`,
        canPickMany: true,
        ignoreFocusOut: true,
      },
    )
    names = picks?.map((p) => p.label) ?? []
  }
  for (const env of names) {
    const run = (accept: boolean) =>
      vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `Copying the Flyway history on ${env}` }, () =>
        lo.runIn<HistoryImport>(folder, ['import-flyway-history', '--table', report.flyway_table, ...(accept ? ['--accept-edited'] : [])], env),
      )
    try {
      let r: HistoryImport
      try {
        r = await run(false)
      } catch (e) {
        // Scripts edited since they ran: the user decides whether the files as they are now count.
        if (!(e instanceof LiftoffError) || !e.message.includes('changed after they ran')) throw e
        const ok = await vscode.window.showWarningMessage(
          `${env}: ${e.message}`,
          { modal: true, detail: 'Import anyway and accept the scripts as they are now? Their new checksums are stored.' },
          'Import Anyway',
        )
        if (!ok) continue
        r = await run(true)
      }
      const extra = r.attention.length ? ` ${r.attention.length} row(s) need attention; see the LiftOff log.` : ''
      r.attention.forEach((a) => lo.log.appendLine(`${env}: needs attention: ${a}`))
      void vscode.window.showInformationMessage(`${env}: copied ${r.imported} history row(s) from Flyway.${extra}`)
    } catch (e) {
      const text = e instanceof Error ? e.message : String(e)
      lo.log.appendLine(`${env}: history not copied: ${text}`)
      void vscode.window.showErrorMessage(`${env}: the Flyway history was not copied: ${text}`, 'Open Settings').then((c) => {
        if (c) void vscode.commands.executeCommand('liftoff.settings', env)
      })
    }
  }
}
