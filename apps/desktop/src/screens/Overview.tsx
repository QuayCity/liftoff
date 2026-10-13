// Overview: where every environment stands and what ran there, read from each database's history
// and activity tables. One project (its workspace), or every recent project side by side (Home).
import { Activity as ActivityIcon, CheckCircle2, Copy, RefreshCw, XCircle } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import { api, errorText, type Activity, type EnvironmentOverview, type State } from '../api'
import { Button, Checkbox, IconButton, Select, cx } from '../ui/controls'
import { DataTable } from '../ui/data'
import { Badge, Card, EmptyState, InlineAlert, Spinner, StatePill, type MigrationState } from '../ui/display'

type Loaded = { name: string; path: string; envs?: EnvironmentOverview[]; error?: string }
type Run = Activity & { environment: string; project: string }

const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' })
function relative(iso: string) {
  const mins = Math.round((Date.parse(iso) - Date.now()) / 60000)
  if (Math.abs(mins) < 60) return rtf.format(mins, 'minute')
  if (Math.abs(mins) < 60 * 24) return rtf.format(Math.round(mins / 60), 'hour')
  return rtf.format(Math.round(mins / 1440), 'day')
}
const local = (iso: string) => new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })
const pillState = (s: State): MigrationState => (s === 'below_baseline' ? 'ignored' : s)
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`

export function Overview({ projects, onOpen }: { projects: { name: string; path: string }[]; onOpen?: (path: string) => void }) {
  const [loaded, setLoaded] = useState<Loaded[] | null>(null)
  const [env, setEnv] = useState('')
  const [failuresOnly, setFailuresOnly] = useState(false)
  const [selected, setSelected] = useState<string | null>(null)
  const multi = projects.length > 1
  const key = projects.map((p) => p.path).join('|')

  const load = useCallback(() => {
    setLoaded(null)
    Promise.all(projects.map((p) => api.overview(p.path).then((envs): Loaded => ({ ...p, envs }), (e): Loaded => ({ ...p, error: errorText(e) })))).then(setLoaded)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key])
  useEffect(load, [load])

  const runs: Run[] = (loaded ?? [])
    .flatMap((p) => (p.envs ?? []).flatMap((e) => e.activity.map((a) => ({ ...a, environment: e.name, project: p.name }))))
    .filter((r) => (!env || `${r.project}/${r.environment}` === env) && (!failuresOnly || !r.success))
    .sort((a, b) => b.started_on.localeCompare(a.started_on))
  const chosen = runs.find((r) => r.id === selected)
  const single = !multi && loaded?.[0]?.envs

  return (
    <div className="flex flex-col gap-6 p-4">
      <div className="flex items-center gap-3">
        <p className="text-sm text-muted">
          {multi ? 'Every environment of your recent projects, read from their databases.' : 'Every environment of this project, read from its database: the version it is at, what is waiting, and what ran there.'}
        </p>
        <span className="flex-1" />
        <Button icon={RefreshCw} onClick={load} loading={loaded === null}>Read again</Button>
      </div>

      {loaded === null && <Spinner label="Reading the environments" />}
      {loaded?.map((p) => (
        <section key={p.path} aria-label={`${p.name} environments`} className="flex flex-col gap-2">
          {multi && (
            <div className="flex items-baseline gap-2">
              <h2 className="text-lg">{p.name}</h2>
              <span className="truncate font-mono text-xs text-muted">{p.path}</span>
              {onOpen && <Button size="sm" variant="ghost" onClick={() => onOpen(p.path)}>Open</Button>}
            </div>
          )}
          {p.error ? (
            <InlineAlert tone="warning" title={`Can't read ${p.name}`}>{p.error}</InlineAlert>
          ) : p.envs?.length === 0 ? (
            <EmptyState icon={ActivityIcon} text="No environments yet, besides scratch ones. Add one in Environments." />
          ) : (
            <div className="grid grid-cols-[repeat(auto-fill,minmax(14rem,1fr))] gap-3">{p.envs?.map((e) => <EnvCard key={e.name} e={e} heading={multi ? 'h3' : 'h2'} />)}</div>
          )}
        </section>
      ))}

      {single && single.some((e) => e.migrations.length) && <Matrix envs={single} />}

      {loaded && (
        <section aria-labelledby="runs-h" className="flex flex-col gap-2">
          <div className="flex items-center gap-3">
            <h2 id="runs-h" className="text-lg">Activity</h2>
            <span className="flex-1" />
            <div className="w-56"><Select aria-label="Environment" value={env} onChange={(e) => setEnv(e.target.value)}>
              <option value="">All environments</option>
              {loaded.flatMap((p) => (p.envs ?? []).map((e) => <option key={`${p.name}/${e.name}`} value={`${p.name}/${e.name}`}>{multi ? `${p.name} / ${e.name}` : e.name}</option>))}
            </Select></div>
            <span className="whitespace-nowrap"><Checkbox checked={failuresOnly} onChange={setFailuresOnly} label="Failures only" /></span>
          </div>
          <Card className="overflow-hidden">
            <DataTable
              caption="Runs, newest first"
              rows={runs}
              rowKey={(r) => r.id}
              selectedKey={selected ?? undefined}
              onSelect={(r) => setSelected(r.id === selected ? null : r.id)}
              empty={<EmptyState icon={ActivityIcon} text={failuresOnly ? 'No failed runs.' : 'No runs recorded yet. Every migrate, undo, repair and clean is listed here, with who ran it and from where.'} />}
              columns={[
                { header: 'When', cell: (r) => <span title={local(r.started_on)}>{relative(r.started_on)}</span> },
                ...(multi ? [{ header: 'Project', cell: (r: Run) => r.project }] : []),
                { header: 'Environment', cell: (r) => r.environment },
                { header: 'What', cell: (r) => <span>{r.operation}{r.scripts.length > 0 && <span className="text-muted"> · {plural(r.scripts.length, 'script')}</span>}</span> },
                {
                  header: 'Result',
                  cell: (r) => r.success
                    ? <span className="inline-flex items-center gap-1 text-success"><CheckCircle2 aria-hidden className="size-3.5" />Done</span>
                    : <span className="inline-flex items-center gap-1 text-danger"><XCircle aria-hidden className="size-3.5" />Failed</span>,
                },
                { header: 'Who', cell: (r) => <span title={`${r.os_user}@${r.host}`}>{r.installed_by}</span> },
                { header: 'From', cell: (r) => <span className="text-muted">{r.pipeline ? 'pipeline' : r.host}</span> },
              ]}
            />
          </Card>
          {chosen && <RunDetails r={chosen} />}
        </section>
      )}
    </div>
  )
}

function EnvCard({ e, heading: H }: { e: EnvironmentOverview; heading: 'h2' | 'h3' }) {
  const last = e.activity[0]
  return (
    <section aria-label={`${e.name} overview`}>
    <Card className="flex h-full flex-col gap-1.5 p-3">
      <H className="flex items-center gap-2 text-base font-medium">{e.name}<Badge>{e.role}</Badge></H>
      {e.error ? (
        <>
          <p className="text-sm text-danger">Can't be read</p>
          <p className="line-clamp-3 text-xs text-muted" title={e.error}>{e.error}</p>
        </>
      ) : (
        <>
          <p className="font-mono text-lg">{e.version ?? 'empty'}</p>
          <p className={cx('text-sm', e.failed ? 'text-danger' : e.pending ? 'text-warning' : 'text-success')}>
            {e.failed ? `${e.failed} failed` : e.pending ? `${plural(e.pending, 'script')} waiting` : 'Up to date'}
          </p>
          <p className="text-xs text-muted">
            {last ? <>Last run {relative(last.started_on)} by {last.installed_by}{last.success ? '' : ' (failed)'}</> : 'No runs recorded yet'}
          </p>
        </>
      )}
    </Card>
    </section>
  )
}

/** Each script's state on each environment: what is where, and what still has to go. */
function Matrix({ envs }: { envs: EnvironmentOverview[] }) {
  const [all, setAll] = useState(false)
  const readable = envs.filter((e) => !e.error)
  const scripts = [...new Set(readable.flatMap((e) => e.migrations.filter((i) => i.kind !== 'undo').map((i) => i.script)))]
  const shown = all ? scripts : scripts.slice(-12)
  const state = (e: EnvironmentOverview, script: string) => e.migrations.find((i) => i.script === script)?.state
  return (
    <section aria-labelledby="matrix-h" className="flex flex-col gap-2">
      <div className="flex items-center gap-3">
        <h2 id="matrix-h" className="text-lg">Where each script is</h2>
        <span className="flex-1" />
        {scripts.length > 12 && <Button size="sm" variant="ghost" onClick={() => setAll(!all)}>{all ? 'The latest 12' : `All ${scripts.length} scripts`}</Button>}
      </div>
      <Card className="overflow-x-auto">
        <DataTable
          caption="Scripts by environment"
          compact
          rows={shown}
          rowKey={(s) => s}
          columns={[
            { header: 'Script', cell: (s) => <span className="font-mono text-xs">{s}</span> },
            ...readable.map((e) => ({ header: e.name, cell: (s: string) => { const st = state(e, s); return st ? <StatePill state={pillState(st)} /> : <span className="text-muted">—</span> } })),
          ]}
        />
      </Card>
    </section>
  )
}

function RunDetails({ r }: { r: Run }) {
  const copy = (text: string) => void navigator.clipboard?.writeText(text)
  return (
    <Card className="flex flex-col gap-2 p-4 text-sm">
      <h3 className="font-medium">{r.operation} on {r.environment}, {local(r.started_on)}</h3>
      <dl className="grid grid-cols-[9rem_1fr] gap-y-1">
        <dt className="text-muted">Deployment id</dt>
        <dd className="flex items-center gap-1 font-mono text-xs">{r.id}<IconButton size="sm" label="Copy the deployment id" icon={Copy} onClick={() => copy(r.id)} /></dd>
        <dt className="text-muted">Database user</dt><dd>{r.installed_by}</dd>
        <dt className="text-muted">Computer</dt><dd>{r.os_user}@{r.host}</dd>
        {r.pipeline && <><dt className="text-muted">Pipeline run</dt><dd className="truncate font-mono text-xs" title={r.pipeline}>{r.pipeline}</dd></>}
        {r.git_commit && <><dt className="text-muted">Commit</dt><dd className="font-mono text-xs">{r.git_commit.slice(0, 12)}</dd></>}
        <dt className="text-muted">Took</dt><dd>{r.execution_time} ms</dd>
      </dl>
      {r.scripts.length > 0 && (
        <div>
          <p className="text-muted">Scripts</p>
          <ul className="list-disc pl-5 font-mono text-xs">{r.scripts.map((s) => <li key={s}>{s}</li>)}</ul>
        </div>
      )}
      {r.detail && <InlineAlert tone={r.success ? 'info' : 'danger'} title={r.success ? 'Details' : 'What went wrong'}><span className="font-mono text-xs whitespace-pre-wrap">{r.detail}</span></InlineAlert>}
    </Card>
  )
}
