// Pre-deploy checks: drift (C16), the changes report (C15) and the dry run (C10), from one
// scratch rebuild.

import type { Config } from './config.ts'
import type { Change } from './changes.ts'
import { open } from './db.ts'
import { diffSchemas, modelOf, notComparedBetween, rebuildScratch, scratchEnv } from './diff.ts'
import { configError } from './errors.ts'
import { compareVersions, parseVersion } from './migration.ts'
import * as runner from './runner.ts'

export type CheckOptions = { drift?: boolean; changes?: boolean; dryRun?: boolean }

export type CheckReport = {
  environment: string
  /** the latest version applied on the environment (what drift is measured against) */
  applied_up_to: string | null
  /** what the environment has that its applied scripts did not create (changed by hand) */
  drift: Change[] | null
  /** what the pending scripts will change on the environment */
  changes: Change[] | null
  dry_run_sql: string | null
  /** objects that exist but were not compared (row-level security, rules, …) */
  not_compared: string[]
}

export const hasDrift = (r: CheckReport) => !!r.drift?.length

/**
 * ponytail: the expected state is rebuilt by running every script up to the environment's latest
 * applied version; scripts the environment skipped (out of order) and outdated repeatables are not
 * modelled, so they can show up as drift.
 */
export async function check(cfg: Config, envName: string | undefined, scratch: string | undefined, opts: CheckOptions, log: runner.Log = runner.quiet): Promise<CheckReport> {
  const [name, env] = cfg.pick(envName)
  const report: CheckReport = { environment: name, applied_up_to: null, drift: null, changes: null, dry_run_sql: null, not_compared: [] }

  if (opts.drift || opts.changes) {
    const [scratchName, scratchEnvironment] = scratchEnv(cfg, scratch)
    if (scratchName === name) throw configError('the scratch database cannot be the environment being checked')
    const infos = await runner.info(cfg, name)
    const applied = infos
      .filter((i) => i.state === 'applied' || i.state === 'baseline')
      .map((i) => i.version)
      .filter((v): v is string => v !== null)
      .sort((a, b) => compareVersions(parseVersion(a), parseVersion(b)))
      .at(-1)
    report.applied_up_to = applied ?? null
    // "0" builds nothing: an environment without history should match an empty database.
    // Repeatables only when the environment ran some: they may need tables from later versions.
    const ranRepeatables = infos.some((i) => i.kind === 'repeatable' && i.state !== 'pending')
    const s = await rebuildScratch(cfg, scratchName, scratchEnvironment, applied ?? '0', log, !ranRepeatables)
    try {
      const expected = await modelOf(cfg, s)
      if (opts.drift) {
        log('info', `Comparing ${name} with what its applied scripts build`)
        const c = await open(name, env)
        try {
          const actual = await modelOf(cfg, c)
          report.drift = diffSchemas(actual, expected)
          report.not_compared = notComparedBetween(actual, expected, name, 'its scripts')
        } finally {
          await c.close()
        }
        log('info', report.drift.length ? `${report.drift.length} object(s) on ${name} differ from the scripts` : `No drift on ${name}`)
      }
      if (opts.changes) {
        log('info', 'Running the pending scripts on the scratch database')
        await runner.migrate(cfg, scratchName, { outOfOrder: true }, log)
        const after = await modelOf(cfg, s)
        report.changes = diffSchemas(after, expected)
        if (!report.not_compared.length) report.not_compared = notComparedBetween(after, expected, 'after the scripts', 'now')
        log('info', `The pending scripts change ${report.changes.length} object(s)`)
      }
    } finally {
      await s.close()
    }
  }
  if (opts.dryRun) report.dry_run_sql = (await runner.migrate(cfg, name, { dryRun: true }, log)).dry_run_sql
  return report
}

const esc = (s: string) => s.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;')

/** A self-contained HTML record of a check (no scripts, no external files), for audits and reviews. */
export function reportHtml(r: CheckReport, project: string, generatedAt: string): string {
  const section = (title: string, changes: Change[] | null, none: string) => {
    if (!changes) return ''
    let h = `<h2>${esc(title)} (${changes.length})</h2>`
    if (!changes.length) h += `<p class=ok>${esc(none)}</p>`
    for (const c of changes) {
      h +=
        `<details><summary><b>${esc(c.kind)}</b> ${esc(c.name)} ${c.destructive ? '<span class=warn>may lose data</span>' : ''}</summary>` +
        `<div class=cols><div><h3>Before</h3><pre>${esc(c.before ?? '(does not exist)')}</pre></div><div><h3>After</h3><pre>${esc(c.after ?? '(does not exist)')}</pre></div></div>` +
        `<h3>SQL</h3><pre>${esc(c.sql)}</pre></details>`
    }
    return h
  }
  let body = `<h1>Checks for ${esc(r.environment)}</h1><p>Project ${esc(project)} &middot; generated ${esc(generatedAt)} &middot; applied up to ${esc(r.applied_up_to ?? 'nothing')}</p>`
  if (r.not_compared.length) body += `<h2>Not compared</h2><ul>${r.not_compared.map((n) => `<li>${esc(n)}</li>`).join('')}</ul>`
  body += section('Drift', r.drift, 'No drift: the database matches its applied scripts.')
  body += section('Pending changes', r.changes, 'The pending scripts change nothing.')
  if (r.dry_run_sql !== null) body += `<h2>Dry-run script</h2><pre>${esc(r.dry_run_sql)}</pre>`
  return (
    `<!doctype html><html lang=en><head><meta charset=utf-8><title>Checks for ${esc(r.environment)}</title><style>` +
    'body{font:14px system-ui,sans-serif;margin:2rem;max-width:72rem;color:#15181c}' +
    'pre{background:#eef0f3;padding:.75rem;overflow:auto;white-space:pre-wrap}' +
    '.cols{display:grid;grid-template-columns:1fr 1fr;gap:1rem}.ok{color:#17734a}.warn{color:#b42d25;margin-left:.5rem}' +
    `summary{cursor:pointer;padding:.25rem 0}</style></head><body>${body}</body></html>`
  )
}
