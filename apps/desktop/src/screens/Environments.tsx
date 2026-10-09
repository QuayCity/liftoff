// Environments workspace: S08 (migrations per target) + S12 (manage targets) + S10 (run log, in place).
import { Database, Pencil, Plus, RefreshCw } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { api, errorText, isErrorReport, olderNotRun, pickable, type EnvView, type Generated, type MigrationInfo, type Project, type State } from '../api'
import { Button, Checkbox, Field, IconButton, Input, Select, cx } from '../ui/controls'
import { CommandBar, DataTable, EnvironmentColumn, LogConsole, type Env, type LogLine } from '../ui/data'
import { Badge, Card, CodeBlock, EmptyState, InlineAlert, StatePill, type MigrationState } from '../ui/display'
import { ConfirmDestructive, Dialog, useToast } from '../ui/overlays'
import { Tabs } from 'radix-ui'
import { Checks } from './Checks'
import { ConnectionDialog } from './ConnectionDialog'

type EnvStatus = { info?: MigrationInfo[]; error?: string; loading: boolean }
const roleLabel = { dev: 'Dev', scratch: 'Scratch', test: 'Test', prod: 'Prod' } as const
const pillState = (s: State): MigrationState => (s === 'below_baseline' ? 'ignored' : s)

const tab = 'border-b-2 border-transparent px-3 py-1.5 text-sm text-muted hover:text-fg data-[state=active]:border-accent data-[state=active]:text-fg'

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
  const [baselineFor, setBaselineFor] = useState<string | null>(null)
  const [cleanFor, setCleanFor] = useState<string | null>(null)
  const [captured, setCaptured] = useState<{ env: string; g: Generated } | null>(null)
  // Drift results from the Checks tab, shown on the board until the next check.
  const [drift, setDrift] = useState<Record<string, boolean>>({})
  const [importFor, setImportFor] = useState<string | null>(null)
  const [notBaselined, setNotBaselined] = useState<string | null>(null)
  // A database whose objects differ from the baseline script it would be marked with.
  const [differs, setDiffers] = useState<{ env: string; differences: { id: string; kind: string }[] } | null>(null)
  // A script picked to run on its own, waiting for confirmation.
  const [pick, setPick] = useState<{ env: EnvView; info: MigrationInfo } | null>(null)

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

  /** Runs one operation on an environment with the log streaming in place; errors land in the log. */
  const op = async (name: string, work: () => Promise<string | null>) => {
    // A second click before React re-renders must not start a second run.
    if (runningRef.current) return
    runningRef.current = name
    setRunning(name)
    setSelected(name)
    setLog([])
    setLogStatus('streaming')
    const stamp = () => new Date().toLocaleTimeString(undefined, { hour12: false })
    try {
      const done = await work()
      setLogStatus('done')
      if (done) toast({ tone: 'success', title: done })
    } catch (e) {
      // Validation errors list one problem per line.
      setLog((l) => [...l, ...errorText(e).split('\n').map((text) => ({ t: stamp(), level: 'error' as const, text }))])
      setLogStatus('failed')
    } finally {
      runningRef.current = null
      setRunning(null)
      load(name)
    }
  }

  const run = (name: string, allowNonEmpty = false, acceptDifferences = false) => op(name, async () => {
    try {
      const r = await api.migrate(project.root, name, false, allowNonEmpty, undefined, acceptDifferences)
      const c = r.baseline_check
      const checked = c
        ? `${name} ${c.restart ? 'went through the restart at' : 'is now at'} ${c.script}${c.created.length ? `; created ${c.created.length} missing object${c.created.length > 1 ? 's' : ''}` : ''}${c.accepted.length ? `; kept ${c.accepted.length} difference${c.accepted.length > 1 ? 's' : ''}` : ''}`
        : ''
      const ran = r.applied.filter((a) => a.script !== c?.script).length
      if (checked) return ran ? `${checked}; then ran ${ran} script${ran > 1 ? 's' : ''}` : checked
      return r.applied.length ? `Ran ${r.applied.length} script${r.applied.length > 1 ? 's' : ''} on ${name}` : `${name} was already up to date`
    } catch (e) {
      // A database that has tables but no history: ask instead of failing half-way through the scripts.
      if (isErrorReport(e) && e.code === 'LIFTOFF_NOT_BASELINED') {
        setNotBaselined(name)
        return null
      }
      // Checked against the baseline script, it differs: show what, let the user decide.
      if (isErrorReport(e) && e.code === 'LIFTOFF_BASELINE_DIFFERS') {
        setDiffers({ env: name, differences: e.differences ?? [] })
        return null
      }
      throw e
    }
  })

  /** A project without scripts starts from this database: its objects become B0001. */
  const adoptDb = (name: string) => op(name, async () => {
    const r = await api.adopt(project.root, name)
    onProject(await api.projectOpen(project.root))
    return `Captured ${name} as ${r.baseline.split(/[\\/]/).pop()} and recorded it there`
  })

  /** One script and nothing else (`migrate --only`). */
  const runOnly = (name: string, script: string) => op(name, async () => {
    const r = await api.migrate(project.root, name, false, false, [script])
    const behind = r.left_behind?.length ? `; not run yet, and older: ${r.left_behind.join(', ')}` : ''
    return `Ran ${script} on ${name}${behind}`
  })

  const command = (name: string, id: string) => {
    if (id === 'info') return load(name)
    if (id === 'migrate') return run(name)
    if (id === 'validate') return op(name, async () => {
      const infos = await api.validate(project.root, name)
      return `${infos.length} scripts checked on ${name}: no problems`
    })
    if (id === 'repair') return op(name, async () => {
      const r = await api.repair(project.root, name)
      const n = r.removed_failed.length + r.realigned.length + r.forgotten.length
      return n ? `Repaired ${name}` : `${name} needed no repair`
    })
    if (id === 'undo') return op(name, async () => {
      const r = await api.undo(project.root, name)
      return `Undid version ${r.version ?? ''} on ${name}`
    })
    if (id === 'baseline') return setBaselineFor(name)
    if (id === 'adopt') return adoptDb(name)
    if (id === 'import-flyway') return setImportFor(name)
    if (id === 'capture') return op(name, async () => {
      setCaptured({ env: name, g: await api.capture(project.root, name, 'existing schema', false) })
      return null
    })
    if (id === 'capture-b') return op(name, async () => {
      setCaptured({ env: name, g: await api.capture(project.root, name, 'baseline', true) })
      return null
    })
    if (id === 'clean') return setCleanFor(name)
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
      drift: e.name in drift ? (drift[e.name] ? 'detected' : 'none') : undefined,
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
      {!project.has_scripts && envs.length > 0 && <AdoptPrompt envs={envs} busy={running !== null} onAdopt={adoptDb} />}
      <div className="flex gap-4 overflow-x-auto pb-1">
        {envs.map((e) => (
          <EnvironmentColumn key={e.name} env={column(e)} selected={e.name === selected} busy={running !== null} onOpen={() => setSelected(e.name)} onRun={() => run(e.name)} />
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

          <Tabs.Root defaultValue="migrations" className="flex flex-col gap-4">
            <Tabs.List aria-label={`${sel.name} views`} className="flex border-b border-border">
              <Tabs.Trigger value="migrations" className={tab}>Migrations</Tabs.Trigger>
              <Tabs.Trigger value="checks" className={tab}>Checks</Tabs.Trigger>
            </Tabs.List>
            <Tabs.Content value="migrations" className="flex flex-col gap-4">
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
                  {
                    header: 'Run',
                    cell: (r) => pickable(r) && (
                      <Button size="sm" variant="ghost" aria-label={`Run only ${r.script}`} disabled={!!running} onClick={() => setPick({ env: sel, info: r })}>Run only this</Button>
                    ),
                    className: 'text-right',
                  },
                ]}
              />
            </Card>

            <Card className="p-4">
              <CommandBar
                key={sel.name}
                env={sel.name}
                running={running === sel.name}
                onRun={(c) => command(sel.name, c.id)}
                commands={[
                  { id: 'migrate', label: 'Run pending' },
                  { id: 'info', label: 'Refresh status' },
                  { id: 'validate', label: 'Validate' },
                  { id: 'repair', label: 'Repair history' },
                  { id: 'undo', label: 'Undo latest' },
                  ...(selStatus?.info?.length === 0 || selStatus?.info?.every((i) => !i.installed_on)
                  ? [{ id: 'import-flyway', label: 'Import Flyway history…' }, { id: 'baseline', label: 'Baseline…' }]
                  : []),
                  ...(!project.has_scripts ? [{ id: 'adopt', label: 'Adopt as B0001 (capture this database)' }] : []),
                  ...(sel.role === 'scratch' || sel.allow_clean ? [{ id: 'clean', label: 'Clean…', destructive: true }] : []),
                  { id: 'capture', label: 'Capture as script…' },
                { id: 'capture-b', label: 'Capture as baseline script…' },
                ]}
              />
            </Card>

            {(log.length > 0 || running) && <div className={cx(running && running !== sel.name && 'opacity-70')}><LogConsole lines={log} status={logStatus} /></div>}
            </Tabs.Content>
            <Tabs.Content value="checks">
              <Checks key={sel.name} project={project} env={sel.name} onDrift={(env, d) => setDrift((m) => ({ ...m, [env]: d }))} />
            </Tabs.Content>
          </Tabs.Root>
        </section>
      )}

      <ConnectionDialog key={dialog ? dialog.editing?.name ?? 'new' : 'closed'} open={!!dialog} onOpenChange={(o) => !o && setDialog(null)} project={project} editing={dialog?.editing} onSaved={onProject} />
      <CaptureDialog key={`capture:${captured?.g.file_name ?? ''}`} captured={captured} project={project} onClose={() => setCaptured(null)}
        onDone={(msg, tone) => { setCaptured(null); toast({ tone, title: msg }); if (captured) load(captured.env) }} />
      <Dialog open={!!pick} onOpenChange={(o) => !o && setPick(null)} size="sm" title={`Run only ${pick?.info.script ?? ''} on ${pick?.env.name ?? ''}?`}
        description="Nothing else runs. Other pending scripts stay pending."
        footer={<>
          <Button onClick={() => setPick(null)}>Cancel</Button>
          <Button variant={pick?.env.role === 'prod' ? 'danger' : 'primary'} onClick={() => { const p = pick!; setPick(null); runOnly(p.env.name, p.info.script) }}>Run this script only</Button>
        </>}>
        {pick && (() => {
          const older = olderNotRun(status[pick.env.name]?.info ?? [], pick.info)
          return (
            <div className="flex flex-col gap-3 text-sm">
              {older.length > 0 && (
                <InlineAlert tone="warning" title={`${older.length} older script${older.length > 1 ? 's' : ''} will not run`}>
                  <ul className="list-disc pl-5 font-mono text-xs">{older.map((o) => <li key={o.script}>{o.script}</li>)}</ul>
                  <p className="mt-2">Run pending will then ask to run them out of order. If {pick.info.script} depends on them, it fails.</p>
                </InlineAlert>
              )}
              {pick.env.role === 'prod' && <InlineAlert tone="danger" title={`${pick.env.name} is a production database`}>The script runs there as soon as you confirm.</InlineAlert>}
            </div>
          )
        })()}
      </Dialog>
      <Dialog open={!!notBaselined} onOpenChange={(o) => !o && setNotBaselined(null)} size="sm" title={`${notBaselined ?? ''} already has tables`}
        description={project.has_scripts ? 'It has no migration history, so running every script would try to create what is already there.' : 'This project has no scripts yet. Start from what this database has.'}
        footer={project.has_scripts ? <>
          <Button onClick={() => setNotBaselined(null)}>Cancel</Button>
          <Button variant="danger" onClick={() => { const n = notBaselined!; setNotBaselined(null); run(n, true) }}>Run them anyway</Button>
          <Button variant="primary" onClick={() => { const n = notBaselined!; setNotBaselined(null); setBaselineFor(n) }}>Baseline…</Button>
        </> : <>
          <Button onClick={() => setNotBaselined(null)}>Cancel</Button>
          <Button variant="primary" onClick={() => { const n = notBaselined!; setNotBaselined(null); adoptDb(n) }}>Adopt as B0001</Button>
        </>}>
        {project.has_scripts
          ? <p className="text-sm">Baseline it at the version it already matches, or import its Flyway history if it came from Flyway.</p>
          : <p className="text-sm">Its objects are captured into B0001__existing_schema.sql, checked on the scratch database, and recorded as already there. Other environments are checked against it when they migrate; new scripts start at V0002. Use the database that is right, usually production or a copy of it.</p>}
      </Dialog>
      <Dialog open={!!differs} onOpenChange={(o) => !o && setDiffers(null)} size="md" title={`${differs?.env ?? ''} differs from the baseline`}
        description="It already has objects, so it was compared with what the baseline script builds instead of running it. Nothing was changed."
        footer={<>
          <Button onClick={() => setDiffers(null)}>Cancel</Button>
          <Button variant="danger" onClick={() => { const n = differs!.env; setDiffers(null); run(n, false, true) }}>Record anyway</Button>
        </>}>
        <ul className="list-disc pl-5 text-sm">
          {differs?.differences.map((d) => <li key={d.id}><span className="font-mono">{d.id}</span>: {d.kind === 'added' ? 'missing' : d.kind === 'removed' ? 'not in the baseline' : 'different'}</li>)}
        </ul>
        <p className="mt-3 text-sm text-muted">Make these match and run again, or record the baseline anyway: missing objects are created, the rest is kept as it is and shows up as drift.</p>
      </Dialog>
      <ImportDialog key={`import:${importFor ?? ''}`} env={importFor} onClose={() => setImportFor(null)}
        onConfirm={(name, table, acceptEdited) => {
          setImportFor(null)
          op(name, async () => {
            const r = await api.historyImport(project.root, name, table, acceptEdited)
            return `Imported ${r.imported} history row${r.imported === 1 ? '' : 's'} on ${name}${r.attention.length ? `; ${r.attention.length} need attention (see log)` : ''}`
          })
        }} />
      <BaselineDialog key={`baseline:${baselineFor ?? ''}`} env={baselineFor} onClose={() => setBaselineFor(null)}
        onConfirm={(name, version, description) => {
          setBaselineFor(null)
          op(name, async () => {
            await api.baseline(project.root, name, version, description)
            return `${name} marked as being at version ${version}`
          })
        }} />
      <ConfirmDestructive open={!!cleanFor} onOpenChange={(o) => !o && setCleanFor(null)} title={`Clean ${cleanFor ?? ''}`} envName={cleanFor ?? ''}
        action="Erase everything"
        consequences={[`Drops every table, view and function in: ${project.schemas.join(', ')}.`, 'Deletes the migration history there too.', 'There is no undo.']}
        onConfirm={() => {
          const name = cleanFor!
          setCleanFor(null)
          op(name, async () => {
            await api.clean(project.root, name)
            return `${name} is empty`
          })
        }} />
    </div>
  )
}

/** Review a captured schema script; save it and, by default, baseline the source database at its version. */
function CaptureDialog({ captured, project, onClose, onDone }: {
  captured: { env: string; g: Generated } | null; project: Project; onClose: () => void
  onDone: (msg: string, tone: 'success' | 'warning') => void
}) {
  const isB = captured?.g.file_name.startsWith('B') ?? false
  const [baselineIt, setBaselineIt] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  if (!captured) return null
  const { env, g } = captured
  const save = async () => {
    setSaving(true)
    setError(null)
    try {
      await api.migrationSave(project.root, g.file_name, g.sql)
    } catch (e) {
      setError(errorText(e))
      setSaving(false)
      return
    }
    try {
      if (baselineIt && !isB) await api.baseline(project.root, env, g.version, 'existing schema')
      onDone(`Wrote ${g.file_name}${baselineIt && !isB ? ` and baselined ${env}` : ''}`, 'success')
    } catch (e) {
      onDone(`Wrote ${g.file_name}, but couldn't baseline ${env}: ${errorText(e)}`, 'warning')
    }
  }
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()} size="lg" title={`Schema of ${env} as a script`} description={g.file_name} submitting={saving}
      footer={<><Button onClick={onClose} disabled={saving}>Cancel</Button><Button variant="primary" loading={saving} onClick={save}>Save to migrations</Button></>}>
      <div className="flex flex-col gap-3">
        <div className="max-h-[50vh] overflow-auto"><CodeBlock label="Captured schema" code={g.sql} /></div>
        {isB
          ? <p className="text-sm text-muted">Empty databases will be built from this script; the versioned scripts up to {g.version} are skipped there. Databases with history are not affected.</p>
          : <Checkbox checked={baselineIt} onChange={setBaselineIt} label={`Baseline ${env} at ${g.version}, so this script never runs there`} />}
        {error && <InlineAlert tone="danger" title="Not saved">{error}</InlineAlert>}
      </div>
    </Dialog>
  )
}

function ImportDialog({ env, onClose, onConfirm }: { env: string | null; onClose: () => void; onConfirm: (env: string, table: string, acceptEdited: boolean) => void }) {
  const [table, setTable] = useState('flyway_schema_history')
  const [acceptEdited, setAcceptEdited] = useState(false)
  return (
    <Dialog open={!!env} onOpenChange={(o) => !o && onClose()} size="sm" title={`Import Flyway history on ${env ?? ''}`}
      description="Copies what Flyway already ran into LiftOff's history, once, so those scripts are not run again. Flyway's table is left as it is."
      footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" disabled={!table.trim()} onClick={() => onConfirm(env!, table.trim(), acceptEdited)}>Import</Button></>}>
      <div className="flex flex-col gap-3">
        <Field label="Flyway history table">{(a) => <Input {...a} mono value={table} onChange={(e) => setTable(e.target.value)} />}</Field>
        <Checkbox checked={acceptEdited} onChange={setAcceptEdited} label="Import even if scripts changed after they ran" />
        <p className="text-xs font-normal text-muted">Without this, the import stops and lists every script whose file no longer matches what ran.</p>
      </div>
    </Dialog>
  )
}

function BaselineDialog({ env, onClose, onConfirm }: { env: string | null; onClose: () => void; onConfirm: (env: string, version: string, description: string) => void }) {
  const [version, setVersion] = useState('1')
  const [description, setDescription] = useState('existing schema')
  const valid = /^\d+([._]\d+)*$/.test(version)
  return (
    <Dialog open={!!env} onOpenChange={(o) => !o && onClose()} size="sm" title={`Baseline ${env ?? ''}`}
      description="For a database that already has your schema: scripts up to this version will never run on it."
      footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" disabled={!valid} onClick={() => onConfirm(env!, version, description)}>Set baseline</Button></>}>
      <div className="flex flex-col gap-3">
        <Field label="Version" error={valid ? undefined : 'Numbers separated by . or _'} help="The last script whose changes this database already has.">
          {(a) => <Input {...a} mono value={version} onChange={(e) => setVersion(e.target.value)} />}
        </Field>
        <Field label="Description">{(a) => <Input {...a} value={description} onChange={(e) => setDescription(e.target.value)} />}</Field>
      </div>
    </Dialog>
  )
}

/** A project without scripts: start from a database that already has the objects. */
function AdoptPrompt({ envs, busy, onAdopt }: { envs: EnvView[]; busy: boolean; onAdopt: (name: string) => void }) {
  // The database that is right is usually production; else the first one.
  const [env, setEnv] = useState((envs.find((e) => e.role === 'prod') ?? envs[0]).name)
  return (
    <InlineAlert tone="info" title="Starting from an existing database?"
      action={
        <div className="flex items-center gap-2">
          <Select aria-label="Database to adopt" value={env} onChange={(e) => setEnv(e.target.value)}>
            {envs.map((e) => <option key={e.name} value={e.name}>{e.name} ({e.role})</option>)}
          </Select>
          <Button size="sm" variant="primary" disabled={busy} onClick={() => onAdopt(env)}>Adopt as B0001</Button>
        </div>
      }>
      This project has no scripts yet. Capture the database that is right (usually production) as B0001: the other
      environments are checked against it when they run, and new scripts start at V0002. A new, empty database? Just write V0001.
    </InlineAlert>
  )
}
