// Scripts workspace: the migrations folder, plus S09 "new script".
import { FileCode2, Plus, RefreshCw } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import { api, errorText, type Project, type ScriptView } from '../api'
import { Button, Field, IconButton, Input, RadioGroup, Textarea } from '../ui/controls'
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
    </div>
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
