// Compare: the schema of any two sides (an environment, a database URL, the schema model, what the
// migrations build, a snapshot file), and what to do with the differences: save a script, write the
// next migration, or apply them to the target.
import { ArrowLeftRight, Camera, CheckCircle2, GitCompareArrows } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { api, errorText, type Change, type CompareResult, type Generated, type Project } from '../api'
import { Button, Checkbox, Field, IconButton, Input, Select } from '../ui/controls'
import { ChangeList, LogConsole, type LogLine } from '../ui/data'
import { Card, CodeBlock, EmptyState, InlineAlert } from '../ui/display'
import { DiffView } from '../ui/diffview'
import { ConfirmDestructive, Dialog, useToast } from '../ui/overlays'
import { NotCompared } from './Changes'
import { DataCompare } from './DataCompare'

/** One side as picked on screen. */
type Pick = { kind: 'env'; name: string } | { kind: 'model' } | { kind: 'migrations' } | { kind: 'snapshot'; file: string } | { kind: 'url'; url: string }

/** The side as the core reads it (see packages/liftoff/src/core/compare.ts, parseSide). */
const sideText = (p: Pick): string =>
  p.kind === 'env' ? p.name : p.kind === 'snapshot' ? `snapshot:${p.file}` : p.kind === 'url' ? p.url.trim() : p.kind
const complete = (p: Pick) => (p.kind === 'snapshot' ? !!p.file : p.kind === 'url' ? !!p.url.trim() : true)
const isDatabase = (p: Pick) => p.kind === 'env' || p.kind === 'url'

export function Compare({ project }: { project: Project }) {
  const toast = useToast()
  const envs = project.environments
  const hasScratch = envs.some((e) => e.role === 'scratch')
  const first = envs.find((e) => e.role === 'dev') ?? envs[0]
  const second = envs.find((e) => e.role === 'test') ?? envs.find((e) => e !== first)
  const [source, setSource] = useState<Pick>(first ? { kind: 'env', name: first.name } : { kind: 'model' })
  const [target, setTarget] = useState<Pick>(second ? { kind: 'env', name: second.name } : hasScratch ? { kind: 'migrations' } : { kind: 'url', url: '' })
  const [result, setResult] = useState<CompareResult | null>(null)
  const [comparing, setComparing] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [active, setActive] = useState<string | undefined>()
  const [log, setLog] = useState<LogLine[]>([])
  const listening = useRef(false)
  // Actions on the selection
  const [review, setReview] = useState<{ script: string } | null>(null)
  const [confirmProd, setConfirmProd] = useState(false)
  const [applying, setApplying] = useState(false)
  const [migration, setMigration] = useState<{ description: string; undo: boolean; draft: Generated | null } | null>(null)
  const [mode, setMode] = useState<'schema' | 'data'>('schema')

  useEffect(() => {
    let off: (() => void) | undefined
    api.onLog((e) => {
      if (listening.current) setLog((l) => [...l, { t: new Date().toLocaleTimeString(undefined, { hour12: false }), level: e.level === 'warn' ? 'warn' : 'info', text: e.message }])
    }).then((f) => (off = f))
    return () => off?.()
  }, [])

  const run = async () => {
    setComparing(true)
    setError(null)
    setResult(null)
    setLog([])
    listening.current = true
    try {
      const r = await api.compareRun(project.root, sideText(source), sideText(target))
      setResult(r)
      setSelected(new Set(r.changes.filter((c) => !c.destructive).map((c) => c.id)))
      setActive(r.changes[0]?.id)
    } catch (e) {
      setError(errorText(e))
    } finally {
      listening.current = false
      setComparing(false)
    }
  }

  const swap = () => {
    setSource(target)
    setTarget(source)
    setResult(null)
  }

  const chosen: Change[] = (result?.changes ?? []).filter((c) => selected.has(c.id))
  const current = result?.changes.find((c) => c.id === active)
  const targetEnv = target.kind === 'env' ? envs.find((e) => e.name === target.name) : undefined

  const script = () => api.compareScript(result!.source, result!.target, chosen)

  const saveScript = async () => {
    try {
      const file = await api.saveScript(`sync-${result!.target.replace(/[^A-Za-z0-9_-]+/g, '-')}.sql`, await script())
      if (file) toast({ tone: 'success', title: `Saved ${file}` })
    } catch (e) {
      toast({ tone: 'danger', title: errorText(e) })
    }
  }

  const apply = async () => {
    setApplying(true)
    try {
      const r = await api.compareApply(project.root, sideText(target), review!.script)
      setReview(null)
      setConfirmProd(false)
      toast({ tone: 'success', title: `Applied ${chosen.length} change${chosen.length === 1 ? '' : 's'} to ${r.target}` })
      await run()
    } catch (e) {
      toast({ tone: 'danger', title: `Not applied: ${errorText(e)}` })
    } finally {
      setApplying(false)
    }
  }

  const writeMigration = async () => {
    if (!migration) return
    try {
      if (!migration.draft) {
        setMigration({ ...migration, draft: await api.migrationGenerate(project.root, chosen, migration.description, migration.undo) })
        return
      }
      const file = await api.migrationSave(project.root, migration.draft.file_name, migration.draft.sql)
      if (migration.draft.undo) await api.migrationSave(project.root, migration.draft.undo.file_name, migration.draft.undo.sql)
      setMigration(null)
      toast({ tone: 'success', title: `Wrote ${file}` })
    } catch (e) {
      toast({ tone: 'danger', title: errorText(e) })
    }
  }

  const saveSnapshot = async () => {
    const name = `${sideText(source).replace(/[^A-Za-z0-9_-]+/g, '-')}-${new Date().toISOString().slice(0, 10)}.json`
    const file = await api.pickSnapshotTarget(name)
    if (!file) return
    try {
      const r = await api.snapshotSave(project.root, sideText(source), file)
      toast({ tone: 'success', title: `Saved a snapshot of ${r.objects} objects to ${r.file}` })
    } catch (e) {
      toast({ tone: 'danger', title: errorText(e) })
    }
  }

  const modeSwitch = (
    <div role="radiogroup" aria-label="What to compare" className="flex self-end rounded-md border border-border p-0.5">
      {(['schema', 'data'] as const).map((m) => (
        <button key={m} role="radio" aria-checked={mode === m} onClick={() => switchMode(m)}
          className={`rounded px-3 py-1 text-sm ${mode === m ? 'bg-accent text-on-accent' : 'text-muted hover:text-fg'}`}>
          {m === 'schema' ? 'Schema' : 'Data'}
        </button>
      ))}
    </div>
  )
  /** Data compare needs two databases: a side that is not one goes back to an environment. */
  function switchMode(m: 'schema' | 'data') {
    setMode(m)
    if (m === 'data') {
      if (!isDatabase(source) && first) setSource({ kind: 'env', name: first.name })
      if (!isDatabase(target) && second) setTarget({ kind: 'env', name: second.name })
    }
  }
  const pickers = (
    <>
      {modeSwitch}
      <SidePicker label="Source" help="What it should look like" value={source} onChange={(p) => { setSource(p); setResult(null) }} project={project} hasScratch={hasScratch} databasesOnly={mode === 'data'} />
      <IconButton label="Swap source and target" icon={ArrowLeftRight} onClick={swap} />
      <SidePicker label="Target" help="What would change" value={target} onChange={(p) => { setTarget(p); setResult(null) }} project={project} hasScratch={hasScratch} databasesOnly={mode === 'data'} />
    </>
  )
  if (mode === 'data') return <DataCompare project={project} source={sideText(source)} target={sideText(target)} header={pickers} />

  return (
    <div className="flex h-full flex-col">
      <div className="flex flex-wrap items-end gap-3 border-b border-border bg-surface px-6 py-4">
        {pickers}
        <span className="flex-1" />
        <Button icon={Camera} disabled={source.kind === 'snapshot' || !complete(source)} onClick={saveSnapshot}>Snapshot the source…</Button>
        <Button data-compare variant="primary" loading={comparing} disabled={!complete(source) || !complete(target)} onClick={run}>{result ? 'Compare again' : 'Compare'}</Button>
      </div>

      <div className="flex min-h-0 flex-1 flex-col gap-4 p-6">
        {error && <InlineAlert tone="danger" title="Comparison failed">{error}</InlineAlert>}
        {comparing && <LogConsole lines={log} status="streaming" />}
        {!comparing && !result && !error && (
          <Card><EmptyState icon={GitCompareArrows} text="Pick two sides: environments, a database URL, the schema model, what the migrations build, or a snapshot. Compare shows every table, view, function and type that differs, and what would make the target match the source." /></Card>
        )}
        {!comparing && result && result.not_compared.length > 0 && <NotCompared items={result.not_compared} />}
        {!comparing && result?.changes.length === 0 && (
          <Card><EmptyState icon={CheckCircle2} text={`${result.target} matches ${result.source}.`} /></Card>
        )}
        {!comparing && result && result.changes.length > 0 && (
          <>
            <p className="text-sm text-muted">{result.changes.length} difference{result.changes.length === 1 ? '' : 's'}: what would make <strong className="text-fg">{result.target}</strong> match <strong className="text-fg">{result.source}</strong> ({result.engine}). Changes that may lose data start unselected.</p>
            <div className="grid min-h-0 flex-1 grid-cols-[minmax(260px,1fr)_2fr] gap-4">
              <Card className="overflow-auto">
                <ChangeList changes={result.changes.map((c) => ({ id: c.id, type: c.object_type, name: c.name, kind: c.kind, destructive: c.destructive }))}
                  selected={selected} onSelectedChange={setSelected} activeId={active} onActivate={(c) => setActive(c.id)} />
              </Card>
              <div className="flex min-h-0 flex-col gap-3 overflow-auto">
                {current && <DiffView key={current.id} before={current.before} after={current.after} beforeLabel={`In ${result.target}`} afterLabel={`In ${result.source}`} />}
                {current && <CodeBlock label={`SQL for ${current.name}`} code={current.sql} />}
              </div>
            </div>
            <div className="flex flex-wrap items-center gap-3 border-t border-border pt-4">
              <span className="text-sm text-muted">{chosen.length} of {result.changes.length} selected</span>
              {chosen.some((c) => c.destructive) && <span className="text-sm text-warning">Includes changes that may lose data</span>}
              <span className="flex-1" />
              <Button disabled={!chosen.length} onClick={saveScript}>Save script…</Button>
              <Button disabled={!chosen.length} onClick={() => setMigration({ description: '', undo: false, draft: null })}>Write migration…</Button>
              <Button variant="primary" disabled={!chosen.length || !isDatabase(target)} onClick={async () => setReview({ script: await script() })}>
                {isDatabase(target) ? `Apply to ${result.target}…` : 'Apply (the target is not a database)'}
              </Button>
            </div>
          </>
        )}
      </div>

      <Dialog open={!!review && !confirmProd} onOpenChange={(o) => !o && setReview(null)} size="lg" title={`Apply ${chosen.length} change${chosen.length === 1 ? '' : 's'} to ${result?.target ?? ''}?`}
        description="The script runs in one transaction when it can; if any statement fails, nothing changes."
        submitting={applying}
        footer={<>
          <Button onClick={() => setReview(null)} disabled={applying}>Cancel</Button>
          <Button variant={targetEnv?.role === 'prod' ? 'danger' : 'primary'} loading={applying} onClick={() => (targetEnv?.role === 'prod' ? setConfirmProd(true) : apply())}>Apply</Button>
        </>}>
        {review && (
          <div className="flex flex-col gap-3">
            {targetEnv && (
              <InlineAlert tone="warning" title="Outside the migrations">
                {targetEnv.name}'s migration history is not changed, so afterwards it differs from its scripts (drift). To keep environments in step, write a migration instead.
              </InlineAlert>
            )}
            {chosen.some((c) => c.destructive) && <InlineAlert tone="danger" title="May lose data">Some of these changes drop tables or columns, or change types.</InlineAlert>}
            <div className="max-h-[45vh] overflow-auto"><CodeBlock label="Script" code={review.script} /></div>
          </div>
        )}
      </Dialog>
      <ConfirmDestructive open={confirmProd} onOpenChange={(o) => { if (!o) setConfirmProd(false) }} title={`Apply to production (${targetEnv?.name ?? ''})`} envName={targetEnv?.name ?? ''}
        consequences={[`${chosen.length} change${chosen.length === 1 ? '' : 's'} run on ${targetEnv?.name ?? ''} now.`, 'Its migration history is not changed.']} action="Apply to production" running={applying} onConfirm={apply} />

      <Dialog open={!!migration} onOpenChange={(o) => !o && setMigration(null)} size={migration?.draft ? 'lg' : 'md'} title={migration?.draft ? 'Review the migration' : 'Write the differences as a migration'}
        description={migration?.draft?.file_name}
        footer={<>
          <Button onClick={() => (migration?.draft ? setMigration({ ...migration, draft: null }) : setMigration(null))}>{migration?.draft ? 'Back' : 'Cancel'}</Button>
          <Button variant="primary" disabled={!migration?.description.trim()} onClick={writeMigration}>{migration?.draft ? 'Save to migrations' : 'Write'}</Button>
        </>}>
        {migration && !migration.draft && (
          <div className="flex flex-col gap-3">
            <Field label="Description" help="Goes into the file name, e.g. V4__sync_with_prod.sql">
              {(a) => <Input {...a} autoFocus value={migration.description} maxLength={120} placeholder="sync with prod" onChange={(e) => setMigration({ ...migration, description: e.target.value })} />}
            </Field>
            <Checkbox checked={migration.undo} onChange={(v) => setMigration({ ...migration, undo: v })} label="Also write an undo script" />
          </div>
        )}
        {migration?.draft && <div className="max-h-[50vh] overflow-auto"><CodeBlock label="Generated script" code={migration.draft.sql} /></div>}
      </Dialog>
    </div>
  )
}

/** Where one side comes from: an environment, the model, the migrations, a snapshot file, a URL. */
function SidePicker({ label, help, value, onChange, project, hasScratch, databasesOnly }: {
  label: string; help: string; value: Pick; onChange: (p: Pick) => void; project: Project; hasScratch: boolean
  /** data compare: only environments and URLs */
  databasesOnly?: boolean
}) {
  const key = value.kind === 'env' ? `env:${value.name}` : value.kind
  const choose = async (k: string) => {
    if (k.startsWith('env:')) return onChange({ kind: 'env', name: k.slice(4) })
    if (k === 'model' || k === 'migrations') return onChange({ kind: k })
    if (k === 'url') return onChange({ kind: 'url', url: '' })
    const file = await api.pickSnapshot()
    if (file) onChange({ kind: 'snapshot', file })
  }
  return (
    <div className="flex min-w-56 flex-col gap-1">
      <Field label={label} help={help}>
        {(a) => (
          <Select {...a} value={key} onChange={(e) => void choose(e.target.value)}>
            <optgroup label="Environments">
              {project.environments.map((e) => <option key={e.name} value={`env:${e.name}`}>{e.name} ({e.role})</option>)}
            </optgroup>
            {!databasesOnly && (
              <optgroup label="This project">
                <option value="model" disabled={!hasScratch}>The schema model{hasScratch ? '' : ' (needs a scratch database)'}</option>
                <option value="migrations" disabled={!hasScratch}>What the migrations build{hasScratch ? '' : ' (needs a scratch database)'}</option>
              </optgroup>
            )}
            <optgroup label="Elsewhere">
              {!databasesOnly && <option value="snapshot">{value.kind === 'snapshot' ? `Snapshot: ${value.file.split(/[\\/]/).pop()}` : 'A snapshot file…'}</option>}
              <option value="url">A database URL…</option>
            </optgroup>
          </Select>
        )}
      </Field>
      {value.kind === 'url' && (
        <Input mono aria-label={`${label} database URL`} placeholder="postgres://user@host:5432/db" value={value.url} onChange={(e) => onChange({ kind: 'url', url: e.target.value })} />
      )}
      {value.kind === 'snapshot' && <Button size="sm" variant="ghost" onClick={() => void choose('snapshot')}>Choose another snapshot…</Button>}
    </div>
  )
}
