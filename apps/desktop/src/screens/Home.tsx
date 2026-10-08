// S01 start page + S02 new project dialog.
import { FolderOpen, FolderPlus, History } from 'lucide-react'
import { useEffect, useState } from 'react'
import { api, errorText, type Project, type Recent } from '../api'
import { Button, Field, Input, RadioGroup, Select } from '../ui/controls'
import { Card, EmptyState, InlineAlert, Spinner } from '../ui/display'
import { Dialog } from '../ui/overlays'

export function Home({ onOpen }: { onOpen: (p: Project) => void }) {
  const [recent, setRecent] = useState<Recent[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [opening, setOpening] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)

  useEffect(() => { api.recentProjects().then(setRecent, (e) => { setRecent([]); setError(errorText(e)) }) }, [])

  const open = async (path: string) => {
    setOpening(path)
    setError(null)
    try {
      onOpen(await api.projectOpen(path))
    } catch (e) {
      setError(errorText(e))
    } finally {
      setOpening(null)
    }
  }
  const pick = async () => {
    const path = await api.pickFolder()
    if (path) await open(path)
  }
  const forget = async (path: string) => {
    await api.recentForget(path)
    setRecent((r) => r?.filter((x) => x.path !== path) ?? null)
  }

  return (
    <main className="mx-auto flex min-h-full w-full max-w-3xl flex-col gap-8 px-6 py-16">
      <header>
        <h1 className="text-display">LiftOff</h1>
        <p className="mt-1 text-muted">Turn database changes into reviewed migration scripts, then run them everywhere.</p>
      </header>

      <div className="grid grid-cols-2 gap-4">
        <Card className="flex flex-col items-start gap-3 p-5">
          <FolderPlus aria-hidden className="size-6 text-accent" />
          <div>
            <h2 className="text-lg">Start a project</h2>
            <p className="text-sm text-muted">Create the project file and folders in a new or existing repository.</p>
          </div>
          <Button variant="primary" onClick={() => setCreating(true)}>New project…</Button>
        </Card>
        <Card className="flex flex-col items-start gap-3 p-5">
          <FolderOpen aria-hidden className="size-6 text-accent" />
          <div>
            <h2 className="text-lg">Open a project</h2>
            <p className="text-sm text-muted">Pick a folder that already has a liftoff.toml.</p>
          </div>
          <Button onClick={pick} loading={opening !== null && !recent?.some((r) => r.path === opening)}>Open folder…</Button>
        </Card>
      </div>

      {error && <InlineAlert tone="danger" title="Couldn't open the project">{error}</InlineAlert>}

      <section aria-labelledby="recent-h" className="flex flex-col gap-2">
        <h2 id="recent-h" className="text-xs font-semibold tracking-wide text-muted uppercase">Recent</h2>
        <Card className="overflow-hidden">
          {recent === null ? (
            <div className="p-4"><Spinner label="Loading recent projects" /></div>
          ) : recent.length === 0 ? (
            <EmptyState icon={History} text="Projects you open will be listed here." />
          ) : (
            <ul className="divide-y divide-border">
              {recent.map((r) => (
                <li key={r.path} className="flex items-center gap-3 px-4 py-2.5">
                  <div className="min-w-0 flex-1">
                    {r.exists ? (
                      <button className="text-left font-medium hover:underline" onClick={() => open(r.path)}>{r.name}</button>
                    ) : (
                      <span className="font-medium text-muted">{r.name}</span>
                    )}
                    <p className="truncate font-mono text-xs font-normal text-muted" title={r.path}>{r.path}</p>
                  </div>
                  {opening === r.path && <Spinner label="Opening" />}
                  {!r.exists && (
                    <>
                      <span className="text-xs text-warning">Folder not found</span>
                      <Button size="sm" variant="ghost" onClick={() => forget(r.path)}>Remove</Button>
                    </>
                  )}
                </li>
              ))}
            </ul>
          )}
        </Card>
      </section>

      <NewProjectDialog open={creating} onOpenChange={setCreating} onCreated={onOpen} />
    </main>
  )
}

function NewProjectDialog({ open, onOpenChange, onCreated }: { open: boolean; onOpenChange: (o: boolean) => void; onCreated: (p: Project) => void }) {
  const [name, setName] = useState('')
  const [folder, setFolder] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [touched, setTouched] = useState(false)

  const nameError = touched && !name.trim() ? 'Give the project a name.' : undefined
  const folderError = touched && !folder ? 'Choose where the project lives.' : undefined

  const choose = async () => {
    const f = await api.pickFolder()
    if (f) {
      setFolder(f)
      if (!name) setName(f.split(/[\\/]/).pop() ?? '')
    }
  }
  const create = async () => {
    setTouched(true)
    if (!name.trim() || !folder) return
    setBusy(true)
    setError(null)
    try {
      onCreated(await api.projectInit(folder, name.trim()))
      onOpenChange(false)
    } catch (e) {
      setError(errorText(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title="New project"
      description="Creates liftoff.toml, a migrations folder and a schema-model folder."
      dirty={!!(name || folder)}
      submitting={busy}
      footer={<><Button onClick={() => onOpenChange(false)} disabled={busy}>Cancel</Button><Button variant="primary" loading={busy} onClick={create}>Create project</Button></>}
    >
      <form className="flex flex-col gap-4" onSubmit={(e) => { e.preventDefault(); create() }}>
        <Field label="Folder" error={folderError} help="Usually the root of the repository that holds your database code.">
          {(a) => (
            <div className="flex gap-2">
              <Input {...a} mono readOnly value={folder} placeholder="No folder chosen" />
              <Button onClick={choose}>Choose…</Button>
            </div>
          )}
        </Field>
        <Field label="Project name" error={nameError}>{(a) => <Input {...a} value={name} onChange={(e) => setName(e.target.value)} maxLength={80} />}</Field>
        <Field label="Database engine" help="More engines are planned.">
          {(a) => <Select {...a} value="postgresql" disabled><option value="postgresql">PostgreSQL</option></Select>}
        </Field>
        <RadioGroup legend="How changes reach other databases" name="style" value="migrations" onChange={() => {}} options={[
          { value: 'migrations', label: 'Migration scripts', help: 'Ordered SQL files, reviewed in git, run the same way everywhere.' },
          { value: 'state', label: 'Compare and sync', help: 'Not available yet; projects can switch later.', disabled: true },
        ]} />
        {error && <InlineAlert tone="danger" title="Couldn't create the project">{error}</InlineAlert>}
        <button type="submit" hidden />
      </form>
    </Dialog>
  )
}
