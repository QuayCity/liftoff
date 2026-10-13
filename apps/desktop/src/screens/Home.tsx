// S01 start page + S02 new project dialog.
import { ArrowLeft, FlaskConical, FolderOpen, FolderPlus, History, LayoutDashboard } from 'lucide-react'
import { useEffect, useState } from 'react'
import { api, type Engine, errorText, isErrorReport, type ConvertReport, type Project, type Recent } from '../api'
import { Button, Field, Input, RadioGroup, Select } from '../ui/controls'
import { Card, EmptyState, InlineAlert, Spinner } from '../ui/display'
import logo from '../assets/logo.svg'
import { Dialog } from '../ui/overlays'
import { ThemeToggle } from '../ui/theme'
import { UpdateButton } from '../ui/update'
import { AboutButton } from '../ui/about'
import { Overview } from './Overview'

function ConvertSummary({ r }: { r: ConvertReport }) {
  return (
    <div className="flex flex-col gap-3 text-sm">
      <dl className="grid grid-cols-[9rem_1fr] gap-y-1">
        <dt className="text-muted">From</dt><dd className="truncate font-mono" title={r.source}>{r.source}</dd>
        <dt className="text-muted">Environments</dt><dd>{r.environments.length ? r.environments.join(', ') : 'none'}</dd>
        <dt className="text-muted">Scripts folder</dt><dd className="font-mono">{r.migrations}</dd>
        <dt className="text-muted">Schemas</dt><dd className="font-mono">{r.schemas.join(', ')}</dd>
      </dl>
      {r.notes.map((n) => <InlineAlert key={n} tone="info" title="Note">{n}</InlineAlert>)}
      {r.not_converted.length > 0 && (
        <InlineAlert tone="warning" title={`${r.not_converted.length} setting${r.not_converted.length === 1 ? '' : 's'} not carried over`}>
          <ul className="mt-1 list-disc space-y-0.5 pl-5">{r.not_converted.map((n) => <li key={n}>{n}</li>)}</ul>
        </InlineAlert>
      )}
      <p className="text-muted">Next: on each environment, use Import Flyway history so scripts that already ran are not run again.</p>
    </div>
  )
}

export function Home({ onOpen }: { onOpen: (p: Project) => void }) {
  const [recent, setRecent] = useState<Recent[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [opening, setOpening] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)
  // A folder with flyway.toml / flyway.conf but no liftoff.toml: offer the conversion.
  const [flywayFolder, setFlywayFolder] = useState<string | null>(null)
  const [converting, setConverting] = useState(false)
  const [converted, setConverted] = useState<{ report: ConvertReport; project: Project } | null>(null)
  // Every recent project's environments side by side; connects to all their databases, so on request.
  const [all, setAll] = useState(false)

  useEffect(() => { api.recentProjects().then(setRecent, (e) => { setRecent([]); setError(errorText(e)) }) }, [])

  const open = async (path: string) => {
    setOpening(path)
    setError(null)
    setFlywayFolder(null)
    try {
      onOpen(await api.projectOpen(path))
    } catch (e) {
      if (isErrorReport(e) && e.code === 'LIFTOFF_FLYWAY_PROJECT') setFlywayFolder(path)
      else setError(errorText(e))
    } finally {
      setOpening(null)
    }
  }
  const trySample = async () => {
    const folder = await api.pickFolder()
    if (!folder) return
    setOpening('sample')
    setError(null)
    try {
      onOpen(await api.sampleCreate(folder))
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

  const existing = recent?.filter((r) => r.exists) ?? []
  if (all) {
    return (
      <main className="flex min-h-full flex-col gap-2 py-4">
        <div className="flex items-center gap-3 px-4">
          <Button icon={ArrowLeft} variant="ghost" onClick={() => setAll(false)}>Back</Button>
          <h1 className="text-xl">All projects</h1>
          <span className="flex-1" /><ThemeToggle />
        </div>
        {error && <div className="px-4"><InlineAlert tone="danger" title="Couldn't open the project">{error}</InlineAlert></div>}
        <Overview projects={existing.map((r) => ({ name: r.name, path: r.path }))} onOpen={open} />
      </main>
    )
  }

  return (
    <main className="mx-auto flex min-h-full w-full max-w-3xl flex-col gap-8 px-6 py-16">
      <header className="flex items-center gap-5">
        <img src={logo} alt="" className="size-20" />
        <div>
          <h1 className="text-display">LiftOff</h1>
          <p className="mt-1 text-muted">Turn database changes into reviewed migration scripts, then run them everywhere.</p>
        </div>
        <div className="ml-auto flex items-center gap-2 self-start"><UpdateButton /><AboutButton /><ThemeToggle /></div>
      </header>

      <div className="grid grid-cols-3 gap-4">
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
          <Button onClick={pick} loading={opening !== null && opening !== 'sample' && !recent?.some((r) => r.path === opening)}>Open folder…</Button>
        </Card>
        <Card className="flex flex-col items-start gap-3 p-5">
          <FlaskConical aria-hidden className="size-6 text-accent" />
          <div>
            <h2 className="text-lg">Try the sample</h2>
            <p className="text-sm text-muted">A small shop database in five scripts, to look around before using your own.</p>
          </div>
          <Button onClick={trySample} loading={opening === 'sample'}>Create sample…</Button>
        </Card>
      </div>

      {error && <InlineAlert tone="danger" title="Couldn't open the project">{error}</InlineAlert>}
      {flywayFolder && (
        <InlineAlert tone="info" title="This folder has a Flyway project"
          action={<Button size="sm" variant="primary" loading={converting} onClick={async () => {
            setConverting(true)
            try {
              setConverted(await api.convertFlyway(flywayFolder))
              setFlywayFolder(null)
            } catch (e) {
              setError(errorText(e))
            } finally {
              setConverting(false)
            }
          }}>Convert settings…</Button>}>
          LiftOff can read its settings and write a liftoff.toml next to them. The Flyway files stay as they are.
        </InlineAlert>
      )}

      <section aria-labelledby="recent-h" className="flex flex-col gap-2">
        <div className="flex items-center">
          <h2 id="recent-h" className="flex-1 text-xs font-semibold tracking-wide text-muted uppercase">Recent</h2>
          {existing.length > 0 && <Button size="sm" variant="ghost" icon={LayoutDashboard} onClick={() => setAll(true)}>Overview of all projects</Button>}
        </div>
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

      <Dialog open={!!converted} onOpenChange={(o) => !o && setConverted(null)} size="lg" title="Flyway settings converted"
        description={converted?.report.written}
        footer={<Button variant="primary" onClick={() => converted && onOpen(converted.project)}>Open project</Button>}>
        {converted && <ConvertSummary r={converted.report} />}
      </Dialog>
      <NewProjectDialog open={creating} onOpenChange={setCreating} onCreated={onOpen} />
    </main>
  )
}

function NewProjectDialog({ open, onOpenChange, onCreated }: { open: boolean; onOpenChange: (o: boolean) => void; onCreated: (p: Project) => void }) {
  const [name, setName] = useState('')
  const [engine, setEngine] = useState<Engine>('postgresql')
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
      onCreated(await api.projectInit(folder, name.trim(), engine))
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
        <Field label="Database engine" help={engine === 'sqlserver' ? 'Uses the dbo schema. Importing Flyway history is not available for SQL Server yet; baseline instead.' : undefined}>
          {(a) => (
            <Select {...a} value={engine} onChange={(e) => setEngine(e.target.value as Engine)}>
              <option value="postgresql">PostgreSQL</option>
              <option value="sqlserver">SQL Server</option>
            </Select>
          )}
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
