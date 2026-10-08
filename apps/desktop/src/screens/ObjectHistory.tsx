// S20: the history of one object in the schema model: the commits that changed its file, and what
// each one changed. Straight from git, following renames.
import { FileClock, Search } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { api, errorText, type ObjectCommit, type Project } from '../api'
import { Button, cx, Input } from '../ui/controls'
import { DiffView } from '../ui/diffview'
import { EmptyState, InlineAlert, Spinner } from '../ui/display'
import { Dialog } from '../ui/overlays'

const dateOf = (iso: string) => iso.slice(0, 16).replace('T', ' ')

export function ObjectHistory({ open, onOpenChange, project }: { open: boolean; onOpenChange: (o: boolean) => void; project: Project }) {
  const [files, setFiles] = useState<string[] | null>(null)
  const [filter, setFilter] = useState('')
  const [file, setFile] = useState<string | undefined>()
  const [commits, setCommits] = useState<ObjectCommit[] | null>(null)
  const [at, setAt] = useState(0)
  const [versions, setVersions] = useState<{ before: string; after: string } | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!open) return
    setError(null)
    api.modelFiles(project.root).then(
      (f) => {
        setFiles(f)
        setFile((cur) => cur ?? f[0])
      },
      (e) => setError(errorText(e)),
    )
  }, [open, project.root])

  useEffect(() => {
    if (!file) return
    setCommits(null)
    setVersions(null)
    setAt(0)
    api.objectHistory(project.root, file).then(setCommits, (e) => {
      setCommits([])
      setError(errorText(e))
    })
  }, [file, project.root])

  // What the chosen commit changed: the file in that commit against the one before it.
  useEffect(() => {
    const c = commits?.[at]
    if (!c) return
    setVersions(null)
    const older = commits![at + 1]
    Promise.all([c.deleted ? '' : api.objectAt(project.root, c.sha, c.path), older ? api.objectAt(project.root, older.sha, older.path) : '']).then(
      ([after, before]) => setVersions({ before, after }),
      (e) => setError(errorText(e)),
    )
  }, [commits, at, project.root])

  const shown = useMemo(() => (files ?? []).filter((f) => f.toLowerCase().includes(filter.trim().toLowerCase())), [files, filter])
  const commit = commits?.[at]

  return (
    <Dialog open={open} onOpenChange={onOpenChange} size="xl" title="Object history" description="Every commit that changed an object's file in the schema model, and what it changed."
      footer={<Button onClick={() => onOpenChange(false)}>Close</Button>}>
      {error && <div className="mb-3"><InlineAlert tone="danger" title="Couldn't read the history">{error}</InlineAlert></div>}
      {files?.length === 0 ? (
        <EmptyState icon={FileClock} text="The schema model is empty. Compare dev with it and save, then commit the files to start their history." />
      ) : (
        <div className="grid h-[60vh] grid-cols-[14rem_16rem_1fr] gap-3">
          <section aria-label="Objects" className="flex min-h-0 flex-col gap-2">
            <label className="relative">
              <span className="sr-only">Filter objects</span>
              <Search aria-hidden className="pointer-events-none absolute top-2 left-2 size-4 text-muted" />
              <Input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Filter" className="w-full pl-8" />
            </label>
            {files === null ? <Spinner label="Loading objects" /> : (
              <ul className="min-h-0 flex-1 overflow-auto rounded-md border border-border">
                {shown.map((f) => (
                  <li key={f}>
                    <button aria-current={f === file} onClick={() => setFile(f)} title={f}
                      className={cx('block w-full truncate px-2 py-1.5 text-left font-mono text-xs hover:bg-surface-sunken', f === file && 'bg-accent-subtle')}>
                      {f.replace(/\.sql$/, '')}
                    </button>
                  </li>
                ))}
                {shown.length === 0 && <li className="p-2 text-sm text-muted">No object matches.</li>}
              </ul>
            )}
          </section>
          <section aria-label="Commits" className="min-h-0 overflow-auto rounded-md border border-border">
            {commits === null ? <div className="p-2"><Spinner label="Loading commits" /></div> : commits.length === 0 ? (
              <p className="p-3 text-sm text-muted">Not committed yet: this object has no history in git.</p>
            ) : (
              <ol>
                {commits.map((c, i) => (
                  <li key={c.sha}>
                    <button aria-current={i === at} onClick={() => setAt(i)}
                      className={cx('flex w-full flex-col items-start gap-0.5 border-b border-border px-2 py-1.5 text-left hover:bg-surface-sunken', i === at && 'bg-accent-subtle')}>
                      <span className="line-clamp-2 text-sm">{c.message}</span>
                      <span className="font-mono text-xs font-normal text-muted">{c.short} · {c.author} · {dateOf(c.date)}{c.deleted ? ' · deleted' : ''}</span>
                    </button>
                  </li>
                ))}
              </ol>
            )}
          </section>
          <section aria-label="What the commit changed" className="min-h-0 overflow-auto">
            {commit && !versions && <Spinner label="Loading the change" />}
            {commit && versions && (
              <DiffView before={versions.before} after={versions.after} beforeLabel={at + 1 < (commits?.length ?? 0) ? 'Before' : 'Before (did not exist)'} afterLabel={`After ${commit.short}`} />
            )}
          </section>
        </div>
      )}
    </Dialog>
  )
}
