// S13 checks for one environment: drift, what the pending scripts change, the dry-run script (Pro).
import { FileSearch, GitCompareArrows, ShieldAlert } from 'lucide-react'
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { api, errorText, type Change, type CheckReport, type Project } from '../api'
import { Button, cx } from '../ui/controls'
import { LogConsole, type LogLine } from '../ui/data'
import { Badge, CodeBlock, InlineAlert } from '../ui/display'
import { DiffView } from '../ui/diffview'
import { NotCompared } from './Changes'

type Which = 'drift' | 'changes' | 'dryRun'

export function Checks({ project, env, onDrift, onSettings }: {
  project: Project; env: string; onDrift: (env: string, drifted: boolean) => void; onSettings?: () => void
}) {
  const [running, setRunning] = useState<Which | null>(null)
  const [report, setReport] = useState<{ which: Which; r: CheckReport } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [log, setLog] = useState<LogLine[]>([])
  const listening = useRef(false)

  useEffect(() => {
    let off: (() => void) | undefined
    api.onLog((e) => {
      if (listening.current) setLog((l) => [...l, { t: new Date().toLocaleTimeString(undefined, { hour12: false }), level: e.level === 'warn' ? 'warn' : 'info', text: e.message }])
    }).then((f) => (off = f))
    return () => off?.()
  }, [])

  if (!project.license) {
    return (
      <InlineAlert tone="info" title="Checks are part of LiftOff Pro" action={onSettings && <Button size="sm" onClick={onSettings}>Add a licence</Button>}>
        Drift detection, change previews and dry runs need a licence. Running migrations stays free.
      </InlineAlert>
    )
  }

  const run = async (which: Which) => {
    setRunning(which)
    setError(null)
    setLog([])
    listening.current = true
    try {
      const r = await api.check(project.root, env, { drift: which === 'drift', changes: which === 'changes', dryRun: which === 'dryRun' })
      setReport({ which, r })
      if (r.drift) onDrift(env, r.drift.length > 0)
    } catch (e) {
      setError(errorText(e))
    } finally {
      listening.current = false
      setRunning(null)
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap gap-2">
        <Button icon={ShieldAlert} loading={running === 'drift'} disabled={!!running} onClick={() => run('drift')}>Check for drift</Button>
        <Button icon={GitCompareArrows} loading={running === 'changes'} disabled={!!running} onClick={() => run('changes')}>Preview pending changes</Button>
        <Button icon={FileSearch} loading={running === 'dryRun'} disabled={!!running} onClick={() => run('dryRun')}>Dry-run script</Button>
      </div>
      <p className="text-xs font-normal text-muted">
        Drift and previews rebuild the scratch database from your scripts; nothing is changed on {env}.
      </p>
      {running && <LogConsole lines={log} status="streaming" />}
      {error && <InlineAlert tone="danger" title="Check failed">{error}</InlineAlert>}
      {!running && report && report.r.not_compared.length > 0 && <NotCompared items={report.r.not_compared} />}
      {!running && report?.which === 'drift' && report.r.drift && (
        <ChangeReport
          changes={report.r.drift}
          none={<InlineAlert tone="success" title="No drift">{env} matches what its applied scripts build{report.r.applied_up_to ? ` (up to ${report.r.applied_up_to})` : ''}.</InlineAlert>}
          some={<InlineAlert tone="warning" title={`${report.r.drift.length} object${report.r.drift.length === 1 ? '' : 's'} changed outside the scripts`}>Someone changed {env} by hand. Turn the change into a script, or undo it, before deploying.</InlineAlert>}
          beforeLabel="From the applied scripts" afterLabel={`In ${env}`}
        />
      )}
      {!running && report?.which === 'changes' && report.r.changes && (
        <ChangeReport
          changes={report.r.changes}
          none={<InlineAlert tone="success" title="Nothing pending">The pending scripts change nothing on {env}.</InlineAlert>}
          some={<InlineAlert tone="info" title={`The pending scripts change ${report.r.changes.length} object${report.r.changes.length === 1 ? '' : 's'}`}>Review each one before you run them.</InlineAlert>}
          beforeLabel={`${env} now`} afterLabel="After the pending scripts"
        />
      )}
      {!running && report?.which === 'dryRun' && report.r.dry_run_sql && <CodeBlock label={`Dry-run script for ${env}`} code={report.r.dry_run_sql} />}
    </div>
  )
}

function ChangeReport({ changes, none, some, beforeLabel, afterLabel }: {
  changes: Change[]; none: ReactNode; some: ReactNode; beforeLabel: string; afterLabel: string
}) {
  const [active, setActive] = useState(changes[0]?.id)
  if (changes.length === 0) return <>{none}</>
  const current = changes.find((c) => c.id === active) ?? changes[0]
  return (
    <div className="flex flex-col gap-3">
      {some}
      <div className="grid grid-cols-[minmax(220px,1fr)_3fr] gap-4">
        <ul aria-label="Changed objects" className="flex flex-col gap-0.5">
          {changes.map((c) => (
            <li key={c.id}>
              <button onClick={() => setActive(c.id)} aria-current={c.id === current.id}
                className={cx('flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-sm hover:bg-surface-sunken', c.id === current.id && 'bg-accent-subtle hover:bg-accent-subtle')}>
                <span className="truncate font-mono">{c.name}</span>
                <span className="flex-1" />
                <Badge>{c.kind}</Badge>
              </button>
            </li>
          ))}
        </ul>
        <DiffView before={current.before} after={current.after} beforeLabel={beforeLabel} afterLabel={afterLabel} />
      </div>
    </div>
  )
}
