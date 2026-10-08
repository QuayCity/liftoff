// Changes workspace, slice version of S06: compare dev with the migrations, pick changes, write the next migration.
import { FileClock, CheckCircle2, GitCompareArrows, Lock } from 'lucide-react'
import { ObjectHistory } from './ObjectHistory'
import { Tabs } from 'radix-ui'
import { useEffect, useRef, useState } from 'react'
import { api, errorText, inDesktop, type Change, type Generated, type ModelChange, type Project } from '../api'
import { Button, Checkbox, Field, Input } from '../ui/controls'
import { ChangeList, LogConsole, type LogLine } from '../ui/data'
import { Card, CodeBlock, EmptyState, InlineAlert } from '../ui/display'
import { DiffView } from '../ui/diffview'
import { Dialog, useToast } from '../ui/overlays'

export function Changes({ project, onSettings, onEnvironments, onProject }: { project: Project; onSettings: () => void; onEnvironments: () => void; onProject: (p: Project) => void }) {
  const toast = useToast()
  const dev = project.environments.find((e) => e.role === 'dev')
  const scratch = project.environments.find((e) => e.role === 'scratch')
  const [changes, setChanges] = useState<Change[] | null>(null)
  const [notCompared, setNotCompared] = useState<string[]>([])
  const [creatingScratch, setCreatingScratch] = useState(false)
  const [against, setAgainst] = useState<'scripts' | 'model'>('scripts')
  const [comparing, setComparing] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [active, setActive] = useState<string | undefined>()
  const [description, setDescription] = useState('')
  const [touched, setTouched] = useState(false)
  const [draft, setDraft] = useState<Generated | null>(null)
  const [saving, setSaving] = useState(false)
  const [recordOnDev, setRecordOnDev] = useState(true)
  const [withUndo, setWithUndo] = useState(false)
  const [log, setLog] = useState<LogLine[]>([])
  const listening = useRef(false)
  const auto = useRef(!inDesktop && new URLSearchParams(location.search).has('autocompare'))

  useEffect(() => {
    let off: (() => void) | undefined
    api.onLog((e) => {
      if (listening.current) setLog((l) => [...l, { t: new Date().toLocaleTimeString(undefined, { hour12: false }), level: e.level === 'warn' ? 'warn' : 'info', text: e.message }])
    }).then((f) => (off = f))
    return () => off?.()
  }, [])

  // Browser preview only: ?autocompare runs the comparison on load (screenshots, UI tests).
  useEffect(() => {
    if (auto.current) {
      auto.current = false
      document.querySelector<HTMLButtonElement>('[data-compare]')?.click()
    }
  })

  if (!project.license) {
    return (
      <div className="p-8">
        <Card>
          <EmptyState icon={Lock} text="Writing migrations from your changes is part of LiftOff Pro. Running migrations stays free."
            action={<Button variant="primary" onClick={onSettings}>Add a licence</Button>} />
        </Card>
      </div>
    )
  }
  if (!dev) {
    return (
      <div className="p-8">
        <InlineAlert tone="info" title="Connect your dev database" action={<Button size="sm" onClick={onEnvironments}>Go to Environments</Button>}>
          Changes are read from an environment with the Dev role.
        </InlineAlert>
      </div>
    )
  }
  if (against === 'model') {
    return <ModelChanges project={project} devName={dev.name} onAgainst={setAgainst} />
  }
  if (!scratch) {
    return (
      <div className="p-8">
        <InlineAlert tone="info" title="A scratch database is needed"
          action={<Button size="sm" variant="primary" onClick={() => setCreatingScratch(true)}>Create one…</Button>}>
          LiftOff builds a throwaway copy from your migration scripts to see what is new. It can create an empty database for
          this next to {dev.name}, or you can add an existing empty one with the Scratch role in Environments.
        </InlineAlert>
        <CreateScratchDialog open={creatingScratch} onOpenChange={setCreatingScratch} project={project} devName={dev.name} onCreated={onProject} />
      </div>
    )
  }

  const compare = async () => {
    setComparing(true)
    setError(null)
    setLog([])
    listening.current = true
    try {
      const { changes: c, not_compared } = await api.changesDiff(project.root)
      setChanges(c)
      setNotCompared(not_compared)
      // Destructive changes start unticked: they have to be chosen on purpose.
      setSelected(new Set(c.filter((x) => !x.destructive).map((x) => x.id)))
      setActive(c[0]?.id)
    } catch (e) {
      setError(errorText(e))
    } finally {
      listening.current = false
      setComparing(false)
    }
  }

  const chosen = (changes ?? []).filter((c) => selected.has(c.id))
  const descError = touched && !description.trim() ? 'Describe the migration in a few words.' : undefined
  const write = async () => {
    setTouched(true)
    if (!description.trim() || chosen.length === 0) return
    try {
      setDraft(await api.migrationGenerate(project.root, chosen, description.trim(), withUndo))
    } catch (e) {
      setError(errorText(e))
    }
  }
  const save = async () => {
    if (!draft) return
    setSaving(true)
    try {
      await api.migrationSave(project.root, draft.file_name, draft.sql)
      if (draft.undo) await api.migrationSave(project.root, draft.undo.file_name, draft.undo.sql)
      try {
        if (recordOnDev) await api.markApplied(project.root, dev.name, draft.file_name)
        toast({ tone: 'success', title: draft.undo ? `Wrote ${draft.file_name} and its undo script` : `Wrote ${draft.file_name}` })
      } catch (e) {
        // The file is saved either way; only the bookkeeping on dev failed.
        toast({ tone: 'warning', title: `Wrote ${draft.file_name}, but couldn't record it on ${dev.name}: ${errorText(e)}` })
      }
      setDraft(null)
      setDescription('')
      setTouched(false)
      setChanges(null)
    } catch (e) {
      setError(errorText(e))
      setDraft(null)
    } finally {
      setSaving(false)
    }
  }

  const current = changes?.find((c) => c.id === active)

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-3 border-b border-border bg-surface px-6 py-3">
        <AgainstToggle value="scripts" onChange={setAgainst} />
        <GitCompareArrows aria-hidden className="size-4 text-muted" />
        <p className="text-sm">
          Compare <strong>{dev.name}</strong> with what your migration scripts build
          <span className="text-muted"> (rebuilt in {scratch.name})</span>
        </p>
        <span className="flex-1" />
        <Button data-compare variant="primary" loading={comparing} onClick={compare}>{changes ? 'Compare again' : 'Compare'}</Button>
      </div>

      <div className="flex min-h-0 flex-1 flex-col gap-4 p-6">
        {error && <InlineAlert tone="danger" title="Comparison failed">{error}</InlineAlert>}
        {!comparing && changes && notCompared.length > 0 && <NotCompared items={notCompared} />}
        {comparing && <LogConsole lines={log} status="streaming" />}
        {!comparing && changes === null && !error && (
          <Card><EmptyState icon={GitCompareArrows} text={`Compare to see which tables, views, functions and types in ${dev.name} differ from what your migration scripts create.`} /></Card>
        )}
        {!comparing && changes?.length === 0 && (
          <Card><EmptyState icon={CheckCircle2} text={`${dev.name} matches your migration scripts. Nothing to write.`} /></Card>
        )}
        {!comparing && changes && changes.length > 0 && (
          <>
            <div className="grid min-h-0 flex-1 grid-cols-[minmax(260px,1fr)_2fr] gap-4">
              <Card className="overflow-auto">
                <ChangeList changes={changes.map((c) => ({ id: c.id, type: c.object_type, name: c.name, kind: c.kind, destructive: c.destructive }))}
                  selected={selected} onSelectedChange={setSelected} activeId={active} onActivate={(c) => setActive(c.id)} />
              </Card>
              <div className="flex min-h-0 flex-col gap-3 overflow-auto">
                {current && <Preview key={current.id} change={current} devName={dev.name} />}
                {chosen.some((c) => c.destructive) && (
                  <InlineAlert tone="warning" title="This migration may lose data">Dropped tables or columns and type changes cannot be undone by running the script again. Check the SQL before saving.</InlineAlert>
                )}
              </div>
            </div>
            <div className="flex items-end gap-3 border-t border-border pt-4">
              <div className="w-96">
                <Field label="Description" error={descError}>{(a) => <Input {...a} value={description} onChange={(e) => setDescription(e.target.value)} placeholder="add customers" maxLength={120} />}</Field>
              </div>
              <span className="pb-2 text-sm text-muted">{chosen.length} of {changes.length} selected</span>
              <span className="flex-1" />
              <Checkbox checked={withUndo} onChange={setWithUndo} label="Also write an undo script" />
              <Button variant="primary" disabled={chosen.length === 0} onClick={write}>Write migration…</Button>
            </div>
          </>
        )}
      </div>

      <Dialog open={!!draft} onOpenChange={(o) => !o && setDraft(null)} size="lg" title="Review the migration" description={draft?.file_name} submitting={saving}
        footer={<><Button onClick={() => setDraft(null)} disabled={saving}>Back</Button><Button variant="primary" loading={saving} onClick={save}>Save to migrations</Button></>}>
        {draft && (
          <div className="flex flex-col gap-3">
            <div className="max-h-[50vh] overflow-auto"><CodeBlock label="Generated script" code={draft.sql} /></div>
            {draft.undo && (
              <details>
                <summary className="cursor-pointer text-sm text-muted">Undo script: {draft.undo.file_name}</summary>
                <div className="mt-2 max-h-[30vh] overflow-auto"><CodeBlock label="Undo script" code={draft.undo.sql} /></div>
              </details>
            )}
            <Checkbox checked={recordOnDev} onChange={setRecordOnDev}
              label={`Record it as applied on ${dev.name}, which already has these changes`} />
          </div>
        )}
      </Dialog>
    </div>
  )
}

const tab = 'border-b-2 border-transparent px-3 py-1.5 text-sm text-muted hover:text-fg data-[state=active]:border-accent data-[state=active]:text-fg'

/** One change: side by side (what the migrations build vs dev), the SQL it adds, and its undo. */
function Preview({ change, devName }: { change: Change; devName: string }) {
  const undo = change.undo_steps.map((s) => s.sql).join('\n')
  return (
    <Tabs.Root defaultValue="diff" className="flex min-h-0 flex-col gap-3">
      <Tabs.List aria-label={`Views of ${change.name}`} className="flex border-b border-border">
        <Tabs.Trigger value="diff" className={tab}>Side by side</Tabs.Trigger>
        <Tabs.Trigger value="sql" className={tab}>SQL</Tabs.Trigger>
        <Tabs.Trigger value="undo" className={tab}>Undo</Tabs.Trigger>
      </Tabs.List>
      <Tabs.Content value="diff"><DiffView before={change.before} after={change.after} afterLabel={`In ${devName}`} /></Tabs.Content>
      <Tabs.Content value="sql"><CodeBlock label={`SQL for ${change.name}`} code={change.sql} /></Tabs.Content>
      <Tabs.Content value="undo">
        {undo ? <CodeBlock label={`Undo SQL for ${change.name}`} code={undo} /> : <p className="text-sm text-muted">No undo steps for this change.</p>}
      </Tabs.Content>
    </Tabs.Root>
  )
}

/** Objects the comparison does not look at yet: shown, never silently skipped. */
export function NotCompared({ items }: { items: string[] }) {
  return (
    <InlineAlert tone="warning" title="Some objects were not compared">
      Write changes to these by hand:
      <ul className="mt-1 list-disc pl-5">{items.map((i) => <li key={i}>{i}</li>)}</ul>
    </InlineAlert>
  )
}

function CreateScratchDialog({ open, onOpenChange, project, devName, onCreated }: {
  open: boolean; onOpenChange: (o: boolean) => void; project: Project; devName: string; onCreated: (p: Project) => void
}) {
  const [eraseOk, setEraseOk] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const create = async () => {
    setBusy(true)
    setError(null)
    try {
      onCreated(await api.scratchCreate(project.root))
      onOpenChange(false)
    } catch (e) {
      setError(errorText(e))
    } finally {
      setBusy(false)
    }
  }
  return (
    <Dialog open={open} onOpenChange={onOpenChange} size="sm" title="Create a scratch database" submitting={busy}
      description={`A new, empty database on ${devName}'s server, named after its database with _scratch at the end. Saved as a private environment.`}
      footer={<><Button onClick={() => onOpenChange(false)} disabled={busy}>Cancel</Button><Button variant="primary" disabled={!eraseOk} loading={busy} onClick={create}>Create</Button></>}>
      <div className="flex flex-col gap-3">
        <Checkbox checked={eraseOk} onChange={setEraseOk} label="I understand LiftOff erases and rebuilds it on every comparison" />
        {error && <InlineAlert tone="danger" title="Not created">{error}</InlineAlert>}
      </div>
    </Dialog>
  )
}

function AgainstToggle({ value, onChange }: { value: 'scripts' | 'model'; onChange: (v: 'scripts' | 'model') => void }) {
  const opt = (v: 'scripts' | 'model', label: string) => (
    <button aria-pressed={value === v} onClick={() => onChange(v)}
      className={value === v ? 'rounded-sm bg-surface px-2 py-1 text-sm shadow-card' : 'rounded-sm px-2 py-1 text-sm text-muted hover:text-fg'}>
      {label}
    </button>
  )
  return (
    <div role="group" aria-label="Compare dev with" className="flex rounded-md bg-surface-sunken p-0.5">
      {opt('scripts', 'Migration scripts')}
      {opt('model', 'Schema model')}
    </div>
  )
}

/** Dev against the schema-model folder: one file per object, saved for git history (S05). */
function ModelChanges({ project, devName, onAgainst }: { project: Project; devName: string; onAgainst: (v: 'scripts' | 'model') => void }) {
  const toast = useToast()
  const [changes, setChanges] = useState<ModelChange[] | null>(null)
  const [busy, setBusy] = useState<'compare' | 'save' | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [active, setActive] = useState<string | undefined>()
  const [history, setHistory] = useState(false)

  const compare = async () => {
    setBusy('compare')
    setError(null)
    try {
      const c = await api.modelStatus(project.root)
      setChanges(c)
      setSelected(new Set(c.map((x) => x.path)))
      setActive(c[0]?.path)
    } catch (e) {
      setError(errorText(e))
    } finally {
      setBusy(null)
    }
  }
  const save = async () => {
    const chosen = (changes ?? []).filter((c) => selected.has(c.path))
    setBusy('save')
    try {
      const n = await api.modelSave(project.root, chosen)
      toast({ tone: 'success', title: `Saved ${n} file${n === 1 ? '' : 's'} to ${project.root}/schema-model` })
      await compare()
    } catch (e) {
      setError(errorText(e))
    } finally {
      setBusy(null)
    }
  }
  const current = changes?.find((c) => c.path === active)
  const label = (t: string) => t.charAt(0).toUpperCase() + t.slice(1).replaceAll('-', ' ')

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-3 border-b border-border bg-surface px-6 py-3">
        <AgainstToggle value="model" onChange={onAgainst} />
        <p className="text-sm">Compare <strong>{devName}</strong> with the schema-model folder</p>
        <span className="flex-1" />
        <Button icon={FileClock} onClick={() => setHistory(true)}>Object history…</Button>
        <Button variant="primary" loading={busy === 'compare'} disabled={!!busy} onClick={compare}>{changes ? 'Compare again' : 'Compare'}</Button>
      </div>
      <ObjectHistory open={history} onOpenChange={setHistory} project={project} />
      <div className="flex min-h-0 flex-1 flex-col gap-4 p-6">
        {error && <InlineAlert tone="danger" title="Comparison failed">{error}</InlineAlert>}
        {changes === null && !error && <Card><EmptyState icon={GitCompareArrows} text="The schema model keeps one file per object in git, so every table, view and function has its own history. Compare to see what dev has that the files do not." /></Card>}
        {changes?.length === 0 && <Card><EmptyState icon={CheckCircle2} text={`The schema model matches ${devName}.`} /></Card>}
        {changes && changes.length > 0 && (
          <>
            <div className="grid min-h-0 flex-1 grid-cols-[minmax(260px,1fr)_2fr] gap-4">
              <Card className="overflow-auto">
                <ChangeList changes={changes.map((c) => ({ id: c.path, type: label(c.object_type), name: c.path.split('/').slice(-1)[0].replace(/\.sql$/, ''), kind: c.kind }))}
                  selected={selected} onSelectedChange={setSelected} activeId={active} onActivate={(c) => setActive(c.id)} />
              </Card>
              <div className="min-h-0 overflow-auto">
                {current && <DiffView before={current.before} after={current.after} beforeLabel="In the model" afterLabel={`In ${devName}`} />}
              </div>
            </div>
            <div className="flex items-center gap-3 border-t border-border pt-4">
              <span className="text-sm text-muted">{selected.size} of {changes.length} selected</span>
              <span className="flex-1" />
              <Button variant="primary" disabled={selected.size === 0 || !!busy} loading={busy === 'save'} onClick={save}>Save to model</Button>
            </div>
          </>
        )}
      </div>
    </div>
  )
}
