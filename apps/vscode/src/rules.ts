// The rules on the migration scripts (liftoff lint) as Problems: all scripts when the project
// loads and on demand, one script when it is saved.

import * as path from 'node:path'
import * as vscode from 'vscode'
import { LiftoffError } from './cli'
import type { Liftoff } from './extension'

export type Finding = { rule: string; severity: 'info' | 'warn' | 'error'; script: string; line: number; message: string; allowed?: string }
export type LintReport = { scripts: string[]; findings: Finding[]; errors: number; warnings: number }

const SEVERITY = { error: vscode.DiagnosticSeverity.Error, warn: vscode.DiagnosticSeverity.Warning, info: vscode.DiagnosticSeverity.Information }

export class Rules {
  readonly diagnostics = vscode.languages.createDiagnosticCollection('liftoff-rules')
  constructor(private readonly lo: Liftoff) {}

  private dir(): string | undefined {
    const { projectDir, project } = this.lo
    return projectDir && project ? path.join(projectDir, project.migrations) : undefined
  }

  /** Runs lint (on `script` only, or every script) and shows the findings; errors are a result, not a failure. */
  async lint(script?: string): Promise<LintReport | undefined> {
    const dir = this.dir()
    if (!dir) return undefined
    let r: LintReport
    try {
      r = await this.lo.run<LintReport>(['lint', ...(script ? ['--script', script] : [])])
    } catch (e) {
      if (e instanceof LiftoffError && e.report.code === 'LIFTOFF_RULES' && e.result) r = e.result as LintReport
      else {
        // A bad [rules] table or allow comment: say so in the log, keep the old findings.
        this.lo.log.appendLine(`rules: ${e instanceof Error ? e.message : String(e)}`)
        return undefined
      }
    }
    if (!script) this.diagnostics.clear()
    for (const name of r.scripts) {
      const list = r.findings
        .filter((f) => f.script === name && f.allowed === undefined)
        .map((f) => {
          const d = new vscode.Diagnostic(new vscode.Range(f.line - 1, 0, f.line - 1, Number.MAX_SAFE_INTEGER), f.message, SEVERITY[f.severity])
          d.source = 'liftoff'
          d.code = f.rule
          return d
        })
      this.diagnostics.set(vscode.Uri.file(path.join(dir, name)), list)
    }
    return r
  }

  /** On save: a script in the migrations folder is linted again; liftoff.toml changes every finding. */
  onSave(file: string): void {
    const dir = this.dir()
    if (!dir) return
    if (['liftoff.toml', 'liftoff.user.toml'].includes(path.basename(file))) void this.lint()
    else if (/^[VR].*\.sql$/.test(path.basename(file)) && path.relative(dir, file).split(path.sep)[0] !== '..') void this.lint(path.basename(file))
  }
}

/** The palette command: lint everything, say how it went, open Problems when there is something. */
export async function checkRules(lo: Liftoff, rules: Rules): Promise<LintReport | undefined> {
  const r = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'Checking the rules' }, () => rules.lint())
  if (!r) {
    void vscode.window.showErrorMessage('LiftOff could not check the rules; see the log', 'Show Log').then((c) => c && lo.log.show())
    return undefined
  }
  const open = r.findings.filter((f) => f.allowed === undefined)
  if (!open.length) {
    void vscode.window.showInformationMessage(`The rules pass on ${r.scripts.length} script${r.scripts.length === 1 ? '' : 's'}`)
    return r
  }
  void vscode.commands.executeCommand('workbench.actions.view.problems')
  const say = `${r.errors} rule error${r.errors === 1 ? '' : 's'}, ${r.warnings} warning${r.warnings === 1 ? '' : 's'} in the scripts`
  void (r.errors ? vscode.window.showErrorMessage(say) : vscode.window.showWarningMessage(say))
  return r
}
