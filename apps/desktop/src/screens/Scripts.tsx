// Scripts workspace: the migrations folder, plus S09 "new script".
import { FileCode2, Layers, Plus, RefreshCw } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import { api, errorText, type Project, type ScriptView } from '../api'
import { Button, Checkbox, Field, IconButton, Input, RadioGroup, Select, Textarea } from '../ui/controls'
import { DataTable } from '../ui/data'
import { Badge, Card, CodeBlock, EmptyState, InlineAlert } from '../ui/display'
import { Dialog, useToast } from '../ui/overlays'

const kindLabel = { versioned: 'Versioned', repeatable: 'Repeatable', undo: 'Undo', baseline: 'Baseline' } as const

export function Scripts({ project }: { project: Project }) {
  const toast = useToast()
  const [scripts, setScripts] = useState<ScriptView[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [active, setActive] = useState<string | undefined>()
  const [adding, setAdding] = useState(false)
  const [squashing, setSquashing] = useState(false)

  const load = useCallback(async (select?: string) => {
    setError(null)
    try {
      const list = await api.scriptsList(project.root)
      setScripts(list)
      setActive((a) => select ?? a ?? list[list.length - 1]?.file_name)
    } catch (e) {
      setScripts([])
      setError(errorText(e))
    }
  }, [project.root])

  useEffect(() => { load() }, [load])

  const current = scripts?.find((s) => s.file_name === active)

  return (
    <div className="flex h-full flex-col gap-4 p-6">
      <header className="flex items-center gap-3">
        <h1 className="text-xl">Scripts</h1>
        <span className="font-mono text-xs font-normal text-muted">{project.root}/migrations</span>
        <span className="flex-1" />
        <IconButton label="Reload from disk" icon={RefreshCw} onClick={() => load()} />
        <Button icon={Layers} onClick={() => setSquashing(true)} disabled={!scripts?.some((s) => s.kind === 'versioned')}>Squash or rebaseline…</Button>
        <Button variant="primary" icon={Plus} onClick={() => setAdding(true)}>New script</Button>
      </header>
      {error && <InlineAlert tone="danger" title="Couldn't read the migrations folder">{error}</InlineAlert>}
      <div className="grid min-h-0 flex-1 grid-cols-[minmax(320px,2fr)_3fr] gap-4">
        <Card className="overflow-auto">
          <DataTable
            caption="Migration scripts"
            loading={scripts === null}
            rows={scripts ?? []}
            rowKey={(s) => s.file_name}
            selectedKey={active}
            onSelect={(s) => setActive(s.file_name)}
            empty={<EmptyState icon={FileCode2} text="No scripts yet. Write one from your changes, or start one by hand." action={<Button variant="primary" icon={Plus} onClick={() => setAdding(true)}>New script</Button>} />}
            columns={[
              { header: 'Version', cell: (s) => <span className="font-mono">{s.version ?? '—'}</span> },
              { header: 'Description', cell: (s) => <span className="block max-w-64 truncate" title={s.description}>{s.description}</span> },
              { header: 'Type', cell: (s) => <Badge>{kindLabel[s.kind]}</Badge> },
            ]}
          />
        </Card>
        <div className="min-h-0 overflow-auto">
          {current ? (
            <div className="flex flex-col gap-2">
              <p className="font-mono text-sm">{current.file_name}</p>
              <CodeBlock label={current.file_name} code={current.sql} />
              <p className="text-xs font-normal text-muted">Edit scripts in your editor. A script that already ran somewhere must not change; write a new one instead.</p>
            </div>
          ) : scripts?.length ? (
            <EmptyState icon={FileCode2} text="Select a script to read it." />
          ) : null}
        </div>
      </div>
      <NewScriptDialog key={adding ? 'open' : 'closed'} open={adding} onOpenChange={setAdding} project={project}
        onCreated={(path) => {
          const name = path.split(/[\\/]/).pop()!
          toast({ tone: 'success', title: `Created ${name}` })
          load(name)
        }} />
      {project.notes.map((n) => (
        <div key={n} className="px-6 pt-4">
          <InlineAlert tone="warning" title="Time for a rebaseline" action={<Button size="sm" onClick={() => setSquashing(true)}>Rebaseline…</Button>}>{n}</InlineAlert>
        </div>
      ))}
      <SquashDialog key={squashing ? 'squash-open' : 'squash-closed'} open={squashing} onOpenChange={setSquashing} project={project} startWithRestart={project.notes.length > 0}
        versions={(scripts ?? []).filter((s) => s.kind === 'versioned' && s.version).map((s) => s.version!)}
        onDone={(message) => {
          toast({ tone: 'success', title: message })
          load()
        }} />
    </div>
  )
}

function SquashDialog({ open, onOpenChange, project, versions, onDone, startWithRestart }: {
  open: boolean; onOpenChange: (o: boolean) => void; project: Project; versions: string[]; onDone: (message: string) => void; startWithRestart: boolean
}) {
  const [upTo, setUpTo] = useState(versions[versions.length - 1] ?? '')
  // Opened before the scripts were loaded: take the newest version once they are.
  useEffect(() => {
    if (!upTo && versions.length) setUpTo(versions[versions.length - 1])
  }, [upTo, versions])
  const [description, setDescription] = useState('baseline')
  // keep: squash only; remove/archive: rebaseline (the old scripts leave the migrations folder)
  const [old, setOld] = useState<'keep' | 'remove' | 'archive'>('remove')
  const [archive, setArchive] = useState('migrations-archive')
  // Start the numbering again at B0001 (near V9999, or for a fresh start).
  const [restart, setRestart] = useState(startWithRestart)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const valid = /^[\p{L}\p{N} _-]{1,120}$/u.test(description.trim())
  const restarting = restart && old !== 'keep'
  // A restart needs no version (it replaces every script); otherwise one must be chosen (the list may still be loading).
  const ready = valid && (restarting || !!upTo) && (old !== 'archive' || !!archive.trim())

  const run = async () => {
    if (!ready) return
    setBusy(true)
    setError(null)
    try {
      if (old === 'keep') {
        onDone(`Wrote ${await api.squash(project.root, upTo, description.trim())}`)
      } else {
        const r = await api.rebaseline(project.root, upTo, description.trim(), old === 'archive' ? archive.trim() : undefined, restart)
        const name = r.baseline.split(/[\\/]/).pop()
        onDone(`Wrote ${name}; ${r.removed.length} old script${r.removed.length === 1 ? '' : 's'} ${r.archived_to ? `moved to ${r.archived_to}` : 'deleted (git still has them)'}`)
      }
      onOpenChange(false)
    } catch (e) {
      setError(errorText(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange} title="Squash or rebaseline" size="md" submitting={busy}
      description="Writes one baseline script with the schema the versioned scripts build. New, empty databases start from it; databases that already ran the scripts are not changed."
      footer={<><Button onClick={() => onOpenChange(false)} disabled={busy}>Cancel</Button><Button variant="primary" loading={busy} onClick={run} disabled={!ready}>{old === 'keep' ? 'Squash' : 'Rebaseline'}</Button></>}>
      <form className="flex flex-col gap-4" onSubmit={(e) => { e.preventDefault(); run() }}>
        <Field label="Up to version" help={restart && old !== 'keep' ? 'A restart replaces every script.' : 'Scripts after it stay as they are.'}>
          {(a) => <Select {...a} value={upTo} disabled={restart && old !== 'keep'} onChange={(e) => setUpTo(e.target.value)}>{versions.map((v) => <option key={v} value={v}>{v}</option>)}</Select>}
        </Field>
        <Field label="Description" error={valid ? undefined : 'Up to 120 letters, digits, spaces, - or _.'}>
          {(a) => <Input {...a} value={description} onChange={(e) => setDescription(e.target.value)} maxLength={120} />}
        </Field>
        <RadioGroup legend="The scripts it replaces" name="old" value={old} onChange={setOld} options={[
          { value: 'remove', label: 'Remove them (rebaseline)', help: 'Fewer files. They stay in git history; they must be committed first.' },
          { value: 'archive', label: 'Move them to a folder (rebaseline)', help: 'Out of the migrations folder, still in the project.' },
          { value: 'keep', label: 'Keep them (squash only)', help: 'Only empty databases use the baseline script.' },
        ]} />
        {old !== 'keep' && (
          <Checkbox checked={restart} onChange={setRestart} label="Start the numbering again: the baseline is B0001, the next script V0002" />
        )}
        {old !== 'keep' && restart && (
          <p className="text-xs font-normal text-muted">Databases that ran the old scripts are checked against B0001 on their next run: missing objects are created, anything different stops it for you to decide.</p>
        )}
        {old === 'archive' && (
          <Field label="Folder" help="Relative to the project folder, outside the migrations folder.">
            {(a) => <Input {...a} mono value={archive} onChange={(e) => setArchive(e.target.value)} />}
          </Field>
        )}
        <p className="text-xs font-normal text-muted">Built in the scratch database, then checked by building it a second time from the new script. Nothing is kept, and nothing is removed, if the two differ.</p>
        {error && <InlineAlert tone="danger" title="Not squashed">{error}</InlineAlert>}
        <button type="submit" hidden />
      </form>
    </Dialog>
  )
}

function NewScriptDialog({ open, onOpenChange, project, onCreated }: { open: boolean; onOpenChange: (o: boolean) => void; project: Project; onCreated: (path: string) => void }) {
  const [type, setType] = useState<'versioned' | 'repeatable'>('versioned')
  const [description, setDescription] = useState('')
  const [sql, setSql] = useState('')
  const [touched, setTouched] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const descError = touched && !/^[\p{L}\p{N} _-]{1,120}$/u.test(description.trim()) ? 'Up to 120 letters, digits, spaces, - or _.' : undefined

  const create = async () => {
    setTouched(true)
    if (!/^[\p{L}\p{N} _-]{1,120}$/u.test(description.trim())) return
    setBusy(true)
    setError(null)
    try {
      onCreated(await api.scriptAdd(project.root, type === 'repeatable', description.trim(), sql))
      onOpenChange(false)
    } catch (e) {
      setError(errorText(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange} title="New script" size="lg" dirty={!!(description || sql)} submitting={busy}
      description="The file name and next version are filled in for you."
      footer={<><Button onClick={() => onOpenChange(false)} disabled={busy}>Cancel</Button><Button variant="primary" loading={busy} onClick={create}>Create script</Button></>}>
      <form className="flex flex-col gap-4" onSubmit={(e) => { e.preventDefault(); create() }}>
        <RadioGroup legend="Type" name="type" value={type} onChange={setType} options={[
          { value: 'versioned', label: 'Versioned', help: 'Runs once, in version order. Use for tables, columns and data fixes.' },
          { value: 'repeatable', label: 'Repeatable', help: 'Runs again whenever the file changes. Use for views and functions.' },
        ]} />
        <Field label="Description" error={descError}>{(a) => <Input {...a} value={description} onChange={(e) => setDescription(e.target.value)} placeholder="backfill order totals" maxLength={120} />}</Field>
        <Field label="SQL" help="Optional. Leave empty to write it in your editor.">
          {(a) => <Textarea {...a} value={sql} onChange={(e) => setSql(e.target.value)} className="min-h-40 font-mono text-sm" spellCheck={false} />}
        </Field>
        {error && <InlineAlert tone="danger" title="Not created">{error}</InlineAlert>}
        <button type="submit" hidden />
      </form>
    </Dialog>
  )
}
