// Changes workspace, slice version of S06: compare dev with the migrations, pick changes, write the next migration.
import { CheckCircle2, GitCompareArrows, Lock } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { api, errorText, inTauri, type Change, type Generated, type Project } from '../api'
import { Button, Checkbox, Field, Input } from '../ui/controls'
import { ChangeList, LogConsole, type LogLine } from '../ui/data'
import { Card, CodeBlock, EmptyState, InlineAlert } from '../ui/display'
import { Dialog, useToast } from '../ui/overlays'

export function Changes({ project, onSettings, onEnvironments }: { project: Project; onSettings: () => void; onEnvironments: () => void }) {
  const toast = useToast()
  const dev = project.environments.find((e) => e.role === 'dev')
  const scratch = project.environments.find((e) => e.role === 'scratch')
  const [changes, setChanges] = useState<Change[] | null>(null)
  const [comparing, setComparing] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [active, setActive] = useState<string | undefined>()
  const [description, setDescription] = useState('')
  const [touched, setTouched] = useState(false)
  const [draft, setDraft] = useState<Generated | null>(null)
  const [saving, setSaving] = useState(false)
  const [recordOnDev, setRecordOnDev] = useState(true)
  const [log, setLog] = useState<LogLine[]>([])
  const listening = useRef(false)
  const auto = useRef(!inTauri && new URLSearchParams(location.search).has('autocompare'))

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
  if (!dev || !scratch) {
    return (
      <div className="p-8">
        <InlineAlert tone="info" title={!dev ? 'Connect your dev database' : 'Add a scratch database'}
          action={<Button size="sm" onClick={onEnvironments}>Go to Environments</Button>}>
          {!dev
            ? 'Changes are read from an environment with the Dev role.'
            : 'LiftOff builds a throwaway copy from your migration scripts to see what is new. Add an empty database with the Scratch role; its contents will be erased.'}
        </InlineAlert>
      </div>
    )
  }

  const compare = async () => {
    setComparing(true)
    setError(null)
    setLog([])
    listening.current = true
    try {
      const c = await api.changesDiff(project.root)
      setChanges(c)
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
      setDraft(await api.migrationGenerate(project.root, chosen, description.trim()))
    } catch (e) {
      setError(errorText(e))
    }
  }
  const save = async () => {
    if (!draft) return
    setSaving(true)
    try {
      await api.migrationSave(project.root, draft.file_name, draft.sql)
      try {
        if (recordOnDev) await api.markApplied(project.root, dev.name, draft.file_name)
        toast({ tone: 'success', title: `Wrote ${draft.file_name}` })
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
        {comparing && <LogConsole lines={log} status="streaming" />}
        {!comparing && changes === null && !error && (
          <Card><EmptyState icon={GitCompareArrows} text={`Compare to see which tables in ${dev.name} differ from what your migration scripts create.`} /></Card>
        )}
        {!comparing && changes?.length === 0 && (
          <Card><EmptyState icon={CheckCircle2} text={`${dev.name} matches your migration scripts. Nothing to write.`} /></Card>
        )}
        {!comparing && changes && changes.length > 0 && (
          <>
            <div className="grid min-h-0 flex-1 grid-cols-[minmax(280px,2fr)_3fr] gap-4">
              <Card className="overflow-auto">
                <ChangeList changes={changes.map((c) => ({ id: c.id, type: c.object_type, name: c.name, kind: c.kind, destructive: c.destructive }))}
                  selected={selected} onSelectedChange={setSelected} activeId={active} onActivate={(c) => setActive(c.id)} />
              </Card>
              <div className="flex min-h-0 flex-col gap-3 overflow-auto">
                {current && <CodeBlock label={`SQL for ${current.name}`} code={current.sql} />}
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
            <Checkbox checked={recordOnDev} onChange={setRecordOnDev}
              label={`Record it as applied on ${dev.name}, which already has these changes`} />
          </div>
        )}
      </Dialog>
    </div>
  )
}
