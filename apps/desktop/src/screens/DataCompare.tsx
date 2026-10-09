// Data compare: the rows of the tables two databases share. A summary per table, the differing rows
// page by page (changed cells marked), then a sync script or apply, for the chosen tables and kinds.
import { CheckCircle2, ChevronLeft, ChevronRight, Database } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { api, errorText, type DataComparison, type DataKind, type Project, type RowPage, type SyncWhat, type TableResult } from '../api'
import { Button, Checkbox, cx } from '../ui/controls'
import { LogConsole, type LogLine } from '../ui/data'
import { Card, EmptyState, InlineAlert } from '../ui/display'
import { ConfirmDestructive, Dialog, useToast } from '../ui/overlays'

const PAGE = 50
const kinds: { kind: DataKind; label: string; count: (t: TableResult) => number }[] = [
  { kind: 'different', label: 'Different', count: (t) => t.different },
  { kind: 'only_in_source', label: 'Only in the source', count: (t) => t.only_in_source },
  { kind: 'only_in_target', label: 'Only in the target', count: (t) => t.only_in_target },
]
const differs = (t: TableResult) => !t.skipped && t.only_in_source + t.only_in_target + t.different > 0
const n = (x: number) => x.toLocaleString()

export function DataCompare({ project, source, target, header }: {
  project: Project
  /** the sides as the core reads them: an environment name or a URL */
  source: string
  target: string
  /** the side pickers, from the Compare screen */
  header: React.ReactNode
}) {
  const toast = useToast()
  const [result, setResult] = useState<DataComparison | null>(null)
  const [running, setRunning] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [log, setLog] = useState<LogLine[]>([])
  const listening = useRef(false)
  const [hideSame, setHideSame] = useState(true)
  const [chosen, setChosen] = useState<Set<string>>(new Set())
  const [active, setActive] = useState<string | undefined>()
  const [what, setWhat] = useState<SyncWhat>({ insert: true, update: true, delete: true })
  const [confirm, setConfirm] = useState(false)
  const [confirmProd, setConfirmProd] = useState(false)
  const [applying, setApplying] = useState(false)
  const targetEnv = project.environments.find((e) => e.name === target)

  useEffect(() => {
    let off: (() => void) | undefined
    api.onLog((e) => {
      if (listening.current) setLog((l) => [...l, { t: new Date().toLocaleTimeString(undefined, { hour12: false }), level: e.level === 'warn' ? 'warn' : 'info', text: e.message }])
    }).then((f) => (off = f))
    return () => {
      off?.()
      void api.dataClose()
    }
  }, [])

  // A new pair of sides makes the old result stale.
  useEffect(() => setResult(null), [source, target])

  const run = async () => {
    setRunning(true)
    setError(null)
    setResult(null)
    setLog([])
    listening.current = true
    try {
      const r = await api.dataOpen(project.root, source, target)
      setResult(r)
      setChosen(new Set(r.tables.filter(differs).map((t) => t.table)))
      setActive(r.tables.find(differs)?.table)
    } catch (e) {
      setError(errorText(e))
    } finally {
      listening.current = false
      setRunning(false)
    }
  }

  const selected = (result?.tables ?? []).filter((t) => chosen.has(t.table) && differs(t))
  const statements = selected.reduce((s, t) => s + (what.insert ? t.only_in_source : 0) + (what.update ? t.different : 0) + (what.delete ? t.only_in_target : 0), 0)

  const saveScript = async () => {
    try {
      const file = await api.dataScript(result!.id, `sync-rows-${result!.target.replace(/[^A-Za-z0-9_-]+/g, '-')}.sql`, selected.map((t) => t.table), what)
      if (file) toast({ tone: 'success', title: `Saved ${file}` })
    } catch (e) {
      toast({ tone: 'danger', title: errorText(e) })
    }
  }

  const apply = async () => {
    setApplying(true)
    try {
      const r = await api.dataApply(result!.id, selected.map((t) => t.table), what)
      setConfirm(false)
      setConfirmProd(false)
      toast({ tone: 'success', title: `Applied ${n(r.statements)} statement${r.statements === 1 ? '' : 's'} to ${result!.target}` })
      await run()
    } catch (e) {
      toast({ tone: 'danger', title: `Nothing changed: ${errorText(e)}` })
    } finally {
      setApplying(false)
    }
  }

  const shown = (result?.tables ?? []).filter((t) => !hideSame || differs(t) || t.skipped)
  const current = result?.tables.find((t) => t.table === active)

  return (
    <div className="flex h-full flex-col">
      <div className="flex flex-wrap items-end gap-3 border-b border-border bg-surface px-6 py-4">
        {header}
        <span className="flex-1" />
        <Button data-compare-data variant="primary" loading={running} onClick={run}>{result ? 'Compare again' : 'Compare data'}</Button>
      </div>

      <div className="flex min-h-0 flex-1 flex-col gap-4 p-6">
        {error && <InlineAlert tone="danger" title="Comparison failed">{error}</InlineAlert>}
        {running && <LogConsole lines={log} status="streaming" />}
        {!running && !result && !error && (
          <Card><EmptyState icon={Database} text="Compare the rows of every table both databases have. Big tables are compared where they are, by hash, so only the rows that differ are read." /></Card>
        )}
        {!running && result && !result.tables.some(differs) && !result.tables.some((t) => t.skipped) && (
          <Card><EmptyState icon={CheckCircle2} text={`Every table in ${result.target} has the same rows as in ${result.source}.`} /></Card>
        )}
        {!running && result && result.tables.length > 0 && (
          <>
            <div className="flex items-center gap-4 text-sm text-muted">
              <span>{result.tables.length} tables, {result.tables.filter(differs).length} with differences, compared in {(result.ms / 1000).toFixed(1)} s ({result.engine})</span>
              <span className="flex-1" />
              <Checkbox checked={hideSame} onChange={setHideSame} label="Hide tables that are the same" />
            </div>
            <div className="grid min-h-0 flex-1 grid-cols-[minmax(280px,1fr)_3fr] gap-4">
              <Card className="overflow-auto">
                <ul aria-label="Tables" className="divide-y divide-border text-sm">
                  {shown.map((t) => (
                    <li key={t.table} className={cx('flex items-start gap-2 px-3 py-2', t.table === active && 'bg-surface-sunken')}>
                      {differs(t)
                        ? <Checkbox ariaLabel={`Sync ${t.table}`} checked={chosen.has(t.table)} onChange={(v) => setChosen((c) => { const x = new Set(c); if (v) x.add(t.table); else x.delete(t.table); return x })} />
                        : <span className="w-4" />}
                      <button className="flex min-w-0 flex-1 flex-col items-start text-left" onClick={() => setActive(t.table)} aria-current={t.table === active ? 'true' : undefined}>
                        <span className="truncate font-mono">{t.table}</span>
                        <span className="text-xs text-muted">
                          {t.skipped ? `Not compared: ${t.skipped}` : differs(t) ? `${n(t.different)} different · ${n(t.only_in_source)} only in source · ${n(t.only_in_target)} only in target` : `Same (${n(t.source_rows)} rows)`}
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              </Card>
              <div className="min-h-0 overflow-auto">
                {current && differs(current) ? <Rows key={current.table} id={result.id} table={current} sourceName={result.source} targetName={result.target} /> : current && (
                  <Card><EmptyState icon={CheckCircle2} text={current.skipped ? `${current.table} was not compared: ${current.skipped}.` : `${current.table} has the same ${n(current.source_rows)} rows on both sides.`} /></Card>
                )}
              </div>
            </div>
            <div className="flex flex-wrap items-center gap-4 border-t border-border pt-4">
              <span className="text-sm text-muted">{selected.length} table{selected.length === 1 ? '' : 's'}, {n(statements)} statement{statements === 1 ? '' : 's'}</span>
              <Checkbox checked={what.insert} onChange={(v) => setWhat({ ...what, insert: v })} label="Insert rows only in the source" />
              <Checkbox checked={what.update} onChange={(v) => setWhat({ ...what, update: v })} label="Update rows that differ" />
              <Checkbox checked={what.delete} onChange={(v) => setWhat({ ...what, delete: v })} label="Delete rows only in the target" />
              <span className="flex-1" />
              <Button disabled={!statements} onClick={saveScript}>Save script…</Button>
              <Button variant="primary" disabled={!statements} onClick={() => setConfirm(true)}>Apply to {result.target}…</Button>
            </div>
          </>
        )}
      </div>

      <Dialog open={confirm && !confirmProd} onOpenChange={(o) => !o && setConfirm(false)} size="md" title={`Change ${n(statements)} row${statements === 1 ? '' : 's'} in ${result?.target ?? ''}?`}
        description="One transaction: if any statement fails, nothing changes." submitting={applying}
        footer={<>
          <Button onClick={() => setConfirm(false)} disabled={applying}>Cancel</Button>
          <Button variant={targetEnv?.role === 'prod' ? 'danger' : 'primary'} loading={applying} onClick={() => (targetEnv?.role === 'prod' ? setConfirmProd(true) : apply())}>Apply</Button>
        </>}>
        <ul className="list-disc pl-5 text-sm">
          {selected.map((t) => (
            <li key={t.table}><span className="font-mono">{t.table}</span>: {[what.insert && `${n(t.only_in_source)} inserted`, what.update && `${n(t.different)} updated`, what.delete && `${n(t.only_in_target)} deleted`].filter(Boolean).join(', ')}</li>
          ))}
        </ul>
      </Dialog>
      <ConfirmDestructive open={confirmProd} onOpenChange={(o) => { if (!o) setConfirmProd(false) }} title={`Change rows in production (${targetEnv?.name ?? ''})`} envName={targetEnv?.name ?? ''}
        consequences={[`${n(statements)} rows are inserted, updated or deleted in ${targetEnv?.name ?? ''} now.`]} action="Apply to production" running={applying} onConfirm={apply} />
    </div>
  )
}

/** One table's differing rows, page by page; for rows that differ, both sides with changed cells marked. */
function Rows({ id, table, sourceName, targetName }: { id: string; table: TableResult; sourceName: string; targetName: string }) {
  const first = kinds.find((k) => k.count(table) > 0)?.kind ?? 'different'
  const [kind, setKind] = useState<DataKind>(first)
  const [offset, setOffset] = useState(0)
  const [page, setPage] = useState<RowPage | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let live = true
    setPage(null)
    setError(null)
    api.dataPage(id, table.table, kind, offset, PAGE).then((p) => live && setPage(p), (e) => live && setError(errorText(e)))
    return () => { live = false }
  }, [id, table.table, kind, offset])

  const total = kinds.find((k) => k.kind === kind)!.count(table)
  return (
    <Card className="flex flex-col">
      <div role="tablist" aria-label={`Differences in ${table.table}`} className="flex gap-1 border-b border-border px-3 pt-2">
        {kinds.map((k) => (
          <button key={k.kind} role="tab" aria-selected={kind === k.kind} disabled={k.count(table) === 0} onClick={() => { setKind(k.kind); setOffset(0) }}
            className={cx('border-b-2 px-3 py-1.5 text-sm', kind === k.kind ? 'border-accent text-fg' : 'border-transparent text-muted hover:text-fg', 'disabled:opacity-50')}>
            {k.label} ({n(k.count(table))})
          </button>
        ))}
      </div>
      {error && <div className="p-3"><InlineAlert tone="danger" title="Could not read the rows">{error}</InlineAlert></div>}
      {page && (
        <div className="overflow-auto">
          <table className="w-full border-collapse font-mono text-xs">
            <caption className="sr-only">{`${kinds.find((k) => k.kind === kind)!.label} in ${table.table}, rows ${offset + 1} to ${offset + page.rows.length} of ${total}`}</caption>
            <thead className="sticky top-0 bg-surface-sunken">
              <tr>
                <th scope="col" className="px-2 py-1 text-left font-sans font-semibold text-muted">Side</th>
                {page.columns.map((c) => <th key={c} scope="col" className="px-2 py-1 text-left font-sans font-semibold text-muted">{c}{page.key.includes(c) ? ' (key)' : ''}</th>)}
              </tr>
            </thead>
            <tbody>
              {page.rows.map((r) => {
                const sides = ([['source', r.source, sourceName], ['target', r.target, targetName]] as const).filter(([, v]) => v)
                return sides.map(([side, values, name], i) => (
                  <tr key={`${r.key.join('|')}-${side}`} className={cx(i === sides.length - 1 && 'border-b border-border')}>
                    <th scope="row" className="whitespace-nowrap px-2 py-1 text-left font-sans font-normal text-muted">{name}</th>
                    {values!.map((v, j) => {
                      const changed = kind === 'different' && r.source && r.target && r.source[j] !== r.target[j]
                      return (
                        <td key={j} className={cx('max-w-64 truncate px-2 py-1', changed && 'bg-warning-subtle font-semibold')} title={v ?? 'NULL'}>
                          {v === null ? <span className="text-muted">NULL</span> : v === '' ? <span className="text-muted">(empty)</span> : v}
                          {changed && <span className="sr-only"> (changed)</span>}
                        </td>
                      )
                    })}
                  </tr>
                ))
              })}
            </tbody>
          </table>
        </div>
      )}
      <div className="flex items-center gap-2 border-t border-border px-3 py-2 text-sm text-muted">
        <span>{total ? `${n(offset + 1)}–${n(Math.min(offset + PAGE, total))} of ${n(total)}` : 'None'}</span>
        <span className="flex-1" />
        <Button size="sm" icon={ChevronLeft} disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - PAGE))}>Previous</Button>
        <Button size="sm" icon={ChevronRight} disabled={offset + PAGE >= total} onClick={() => setOffset(offset + PAGE)}>Next</Button>
      </div>
    </Card>
  )
}
