// S14 Commit workspace: changed files, their diff, commit selected files, push and pull.
import { ArrowDown, ArrowUp, GitBranch, GitCommitHorizontal, RefreshCw } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import { api, errorText, isErrorReport, type GitStatus, type Project } from '../api'
import { Button, Checkbox, Field, IconButton, Textarea, cx } from '../ui/controls'
import { Badge, Card, CodeBlock, EmptyState, InlineAlert, Spinner } from '../ui/display'
import { useToast } from '../ui/overlays'

export function Commit({ project }: { project: Project }) {
  const toast = useToast()
  const [status, setStatus] = useState<GitStatus | null>(null)
  const [error, setError] = useState<{ code: string; message: string } | null>(null)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [active, setActive] = useState<string | null>(null)
  const [diff, setDiff] = useState<string | null>(null)
  const [message, setMessage] = useState('')
  const [busy, setBusy] = useState<'commit' | 'push' | 'pull' | null>(null)

  const load = useCallback(async () => {
    try {
      const s = await api.gitStatus(project.root)
      setStatus(s)
      setError(null)
      // Migration scripts and project settings are pre-selected; anything else is the user's call.
      setSelected(new Set(s.files.filter((f) => /^(migrations|schema-model)\/|liftoff\.toml$/.test(f.path)).map((f) => f.path)))
      setActive((a) => (a && s.files.some((f) => f.path === a) ? a : s.files[0]?.path ?? null))
    } catch (e) {
      setStatus(null)
      setError(isErrorReport(e) ? { code: e.code, message: e.message } : { code: '', message: errorText(e) })
    }
  }, [project.root])

  useEffect(() => { load() }, [load])
  useEffect(() => {
    if (!active) return setDiff(null)
    api.gitDiff(project.root, active).then(setDiff, (e) => setDiff(errorText(e)))
  }, [active, project.root])

  const act = async (what: 'commit' | 'push' | 'pull') => {
    setBusy(what)
    setError(null)
    try {
      if (what === 'commit') {
        const sha = await api.gitCommit(project.root, [...selected], message)
        toast({ tone: 'success', title: `Committed ${selected.size} file${selected.size === 1 ? '' : 's'} (${sha})` })
        setMessage('')
      } else if (what === 'push') {
        await api.gitPush(project.root)
        toast({ tone: 'success', title: 'Pushed' })
      } else {
        await api.gitPull(project.root)
        toast({ tone: 'success', title: 'Up to date with the remote' })
      }
    } catch (e) {
      if (isErrorReport(e) && e.code === 'LIFTOFF_GIT_PUSH_REJECTED') {
        toast({ tone: 'danger', title: 'The remote has commits you do not have yet', action: { label: 'Pull changes', onClick: () => act('pull') } })
      } else {
        setError(isErrorReport(e) ? { code: e.code, message: e.message } : { code: '', message: errorText(e) })
      }
    } finally {
      setBusy(null)
      load()
    }
  }

  if (error?.code === 'LIFTOFF_GIT_NOT_A_REPOSITORY') {
    return (
      <div className="p-8">
        <Card><EmptyState icon={GitBranch} text="This project folder is not in a git repository. Create one with your git client, then come back." /></Card>
      </div>
    )
  }

  const files = status?.files ?? []
  return (
    <div className="flex h-full flex-col gap-4 p-6">
      <header className="flex items-center gap-3">
        <h2 className="text-xl">Commit</h2>
        {status?.branch && <span className="inline-flex items-center gap-1 text-sm text-muted"><GitBranch aria-hidden className="size-4" />{status.branch}</span>}
        {status && (status.ahead > 0 || status.behind > 0) && <Badge>{`${status.ahead} to push, ${status.behind} to pull`}</Badge>}
        <span className="flex-1" />
        <IconButton label="Refresh" icon={RefreshCw} onClick={load} />
        <Button icon={ArrowDown} loading={busy === 'pull'} disabled={!!busy} onClick={() => act('pull')}>Pull</Button>
        <Button icon={ArrowUp} loading={busy === 'push'} disabled={!!busy || !status || (status.ahead === 0 && !!status.upstream)} onClick={() => act('push')}>Push</Button>
      </header>
      {error && (
        <InlineAlert tone="danger" title={error.code === 'LIFTOFF_GIT_DIVERGED' ? 'Your branch and the remote have both moved on' : 'Git reported a problem'}>
          {error.code === 'LIFTOFF_GIT_DIVERGED' ? 'Rebase or merge in your git client; LiftOff only pulls when it can fast-forward.' : null}
          <details className="mt-1"><summary className="cursor-pointer text-xs">Show git's message</summary><pre className="mt-1 text-xs whitespace-pre-wrap">{error.message}</pre></details>
        </InlineAlert>
      )}
      {status === null && !error ? (
        <Spinner label="Reading the repository" />
      ) : files.length === 0 ? (
        <Card><EmptyState icon={GitCommitHorizontal} text="Nothing to commit. Everything in this folder is committed." /></Card>
      ) : (
        <div className="grid min-h-0 flex-1 grid-cols-[minmax(260px,1fr)_2fr] gap-4">
          <div className="flex min-h-0 flex-col gap-3">
            <Card className="min-h-0 flex-1 overflow-auto">
              <ul aria-label="Changed files">
                {files.map((f) => (
                  <li key={f.path} className={cx('flex items-center gap-2 px-3 py-1.5 text-sm', f.path === active && 'bg-accent-subtle')}>
                    <Checkbox ariaLabel={`Include ${f.path}`} checked={selected.has(f.path)}
                      onChange={(on) => setSelected((s) => { const n = new Set(s); if (on) n.add(f.path); else n.delete(f.path); return n })} />
                    <button className="min-w-0 flex-1 truncate text-left font-mono hover:underline" title={f.path} onClick={() => setActive(f.path)}>{f.path}</button>
                    <Badge>{f.change}</Badge>
                  </li>
                ))}
              </ul>
            </Card>
            <Field label="Commit message">{(a) => <Textarea {...a} value={message} onChange={(e) => setMessage(e.target.value)} placeholder="Add customers table" />}</Field>
            <Button variant="primary" icon={GitCommitHorizontal} loading={busy === 'commit'} disabled={!!busy || selected.size === 0 || !message.trim()} onClick={() => act('commit')}>
              {`Commit ${selected.size} file${selected.size === 1 ? '' : 's'}`}
            </Button>
          </div>
          <div className="min-h-0 overflow-auto">
            {active && (diff === null ? <Spinner label="Loading the change" /> : <CodeBlock label={`Change to ${active}`} code={diff || '(no textual change)'} />)}
          </div>
        </div>
      )}
    </div>
  )
}
