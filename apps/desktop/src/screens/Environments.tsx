// Environments workspace: S08 (migrations per target) + S12 (manage targets) + S10 (run log, in place).
import { Database, Pencil, Plus, RefreshCw } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { api, errorText, type EnvView, type MigrationInfo, type Project, type State } from '../api'
import { Button, IconButton, cx } from '../ui/controls'
import { CommandBar, DataTable, EnvironmentColumn, LogConsole, type Env, type LogLine } from '../ui/data'
import { Badge, Card, EmptyState, InlineAlert, StatePill, type MigrationState } from '../ui/display'
import { useToast } from '../ui/overlays'
import { ConnectionDialog } from './ConnectionDialog'

type EnvStatus = { info?: MigrationInfo[]; error?: string; loading: boolean }
const roleLabel = { dev: 'Dev', scratch: 'Scratch', test: 'Test', prod: 'Prod' } as const
const pillState = (s: State): MigrationState => (s === 'below_baseline' ? 'ignored' : s)

const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' })
function relative(iso: string) {
  const mins = Math.round((Date.parse(iso) - Date.now()) / 60000)
  if (Math.abs(mins) < 60) return rtf.format(mins, 'minute')
  if (Math.abs(mins) < 60 * 24) return rtf.format(Math.round(mins / 60), 'hour')
  return rtf.format(Math.round(mins / 1440), 'day')
}
const local = (iso: string | null) => (iso ? new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : '—')

export function Environments({ project, onProject }: { project: Project; onProject: (p: Project) => void }) {
  const toast = useToast()
  const envs = project.environments
  const [status, setStatus] = useState<Record<string, EnvStatus>>({})
  const [selected, setSelected] = useState<string | null>(envs.find((e) => e.role === 'test')?.name ?? envs[0]?.name ?? null)
  const [dialog, setDialog] = useState<{ editing?: EnvView } | null>(null)
  const [running, setRunning] = useState<string | null>(null)
  const [log, setLog] = useState<LogLine[]>([])
  const [logStatus, setLogStatus] = useState<'streaming' | 'done' | 'failed'>('done')
  const runningRef = useRef<string | null>(null)

  const load = useCallback(async (name: string) => {
    setStatus((s) => ({ ...s, [name]: { ...s[name], loading: true } }))
    try {
      const info = await api.migrationsInfo(project.root, name)
      setStatus((s) => ({ ...s, [name]: { info, loading: false } }))
    } catch (e) {
      setStatus((s) => ({ ...s, [name]: { error: errorText(e), loading: false } }))
    }
  }, [project.root])

  useEffect(() => { envs.forEach((e) => load(e.name)) }, [envs, load])

  useEffect(() => {
    let off: (() => void) | undefined
    api.onLog((e) => {
      if (!runningRef.current) return
      const t = new Date().toLocaleTimeString(undefined, { hour12: false })
      setLog((l) => [...l, { t, level: e.level === 'warn' ? 'warn' : 'info', text: e.message }])
    }).then((f) => (off = f))
    return () => off?.()
  }, [])

  const run = async (name: string) => {
    runningRef.current = name
    setRunning(name)
    setSelected(name)
    setLog([])
    setLogStatus('streaming')
    try {
      const r = await api.migrate(project.root, name, false)
      setLogStatus('done')
      toast({ tone: 'success', title: r.applied.length ? `Ran ${r.applied.length} script${r.applied.length > 1 ? 's' : ''} on ${name}` : `${name} was already up to date` })
    } catch (e) {
      const t = new Date().toLocaleTimeString(undefined, { hour12: false })
      setLog((l) => [...l, { t, level: 'error', text: errorText(e) }])
      setLogStatus('failed')
    } finally {
      runningRef.current = null
      setRunning(null)
      load(name)
    }
  }

  const column = (e: EnvView): Env => {
    const st = status[e.name]
    const info = st?.info ?? []
    const last = info.filter((i) => i.installed_on).map((i) => i.installed_on!).sort().pop()
    const lastFailed = info.some((i) => i.state === 'failed')
    return {
      name: e.name,
      role: roleLabel[e.role],
      status: !st || st.loading ? 'checking' : st.error ? 'unreachable' : 'ok',
      pending: info.filter((i) => i.state === 'pending' || i.state === 'outdated').length,
      lastRun: last ? { when: relative(last), at: local(last), failed: lastFailed } : undefined,
    }
  }

  if (envs.length === 0) {
    return (
      <div className="p-8">
        <Card>
          <EmptyState icon={Database} text="No databases connected yet. Add your dev database first, then the places you deploy to."
            action={<Button variant="primary" icon={Plus} onClick={() => setDialog({})}>Add environment</Button>} />
        </Card>
        <ConnectionDialog key={dialog ? dialog.editing?.name ?? 'new' : 'closed'} open={!!dialog} onOpenChange={(o) => !o && setDialog(null)} project={project} onSaved={onProject} />
      </div>
    )
  }

  const sel = envs.find((e) => e.name === selected)
  const selStatus = sel ? status[sel.name] : undefined

  return (
    <div className="flex flex-col gap-6 p-6">
      <div className="flex gap-4 overflow-x-auto pb-1">
        {envs.map((e) => (
          <EnvironmentColumn key={e.name} env={column(e)} selected={e.name === selected} onOpen={() => setSelected(e.name)} onRun={() => run(e.name)} />
        ))}
        <button
          onClick={() => setDialog({})}
          className="flex w-40 shrink-0 flex-col items-center justify-center gap-2 rounded-lg border border-dashed border-border-input text-sm text-muted hover:bg-surface hover:text-fg"
        >
          <Plus aria-hidden className="size-5" />Add environment
        </button>
      </div>

      {sel && (
        <section aria-label={`${sel.name} details`} className="flex flex-col gap-4">
          <header className="flex items-center gap-3">
            <h2 className="text-xl">{sel.name}</h2>
            <Badge>{roleLabel[sel.role]}</Badge>
            <span className="truncate font-mono text-xs font-normal text-muted" title={sel.url}>{sel.url}</span>
            <span className="flex-1" />
            <IconButton label="Refresh" icon={RefreshCw} onClick={() => load(sel.name)} disabled={selStatus?.loading} />
            <IconButton label={`Edit ${sel.name}`} icon={Pencil} onClick={() => setDialog({ editing: sel })} />
          </header>

          {selStatus?.error && (
            <InlineAlert tone="danger" title={`Can't read ${sel.name}`} action={<Button size="sm" onClick={() => setDialog({ editing: sel })}>Edit connection</Button>}>
              {selStatus.error}
            </InlineAlert>
          )}

          <Card className="max-h-96 overflow-auto">
            <DataTable
              caption={`Migrations on ${sel.name}`}
              loading={!selStatus || (selStatus.loading && !selStatus.info)}
              rows={selStatus?.info ?? []}
              rowKey={(r) => r.script + (r.version ?? '')}
              empty={<EmptyState icon={Database} text="No migration scripts yet. Write one from your changes in the Changes tab." />}
              columns={[
                { header: 'Version', cell: (r) => <span className="font-mono">{r.version ?? 'repeatable'}</span> },
                { header: 'Description', cell: (r) => <span className="block max-w-80 truncate" title={r.description}>{r.description}</span> },
                { header: 'State', cell: (r) => <span className="inline-flex items-center gap-2"><StatePill state={pillState(r.state)} />{r.checksum_mismatch && <span className="text-xs text-danger">changed after it ran</span>}</span> },
                { header: 'Ran on', cell: (r) => local(r.installed_on), className: 'text-muted whitespace-nowrap' },
                { header: 'Took', cell: (r) => (r.execution_time_ms != null ? `${r.execution_time_ms} ms` : '—'), className: 'text-right tabular-nums' },
              ]}
            />
          </Card>

          <Card className="p-4">
            <CommandBar
              key={sel.name}
              env={sel.name}
              licensed={!!project.license}
              running={running === sel.name}
              onRun={(c) => (c.id === 'info' ? load(sel.name) : run(sel.name))}
              commands={[{ id: 'migrate', label: 'Run pending' }, { id: 'info', label: 'Refresh status' }]}
            />
          </Card>

          {(log.length > 0 || running) && <div className={cx(running && running !== sel.name && 'opacity-70')}><LogConsole lines={log} status={logStatus} /></div>}
        </section>
      )}

      <ConnectionDialog key={dialog ? dialog.editing?.name ?? 'new' : 'closed'} open={!!dialog} onOpenChange={(o) => !o && setDialog(null)} project={project} editing={dialog?.editing} onSaved={onProject} />
    </div>
  )
}
