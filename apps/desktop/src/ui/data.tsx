import { AlertTriangle, ChevronDown, ChevronRight, Minus, Pencil, Play, Plus, type LucideIcon } from 'lucide-react'
import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import { Button, Checkbox, Select, cx } from './controls'
import { Badge, CodeBlock, InlineAlert, Spinner } from './display'

/* ---------- DataTable ---------- */

export type Column<T> = { header: string; cell: (row: T) => ReactNode; className?: string }

export function DataTable<T>({ caption, columns, rows, rowKey, selectedKey, onSelect, loading, empty, compact }: {
  caption: string; columns: Column<T>[]; rows: T[]; rowKey: (r: T) => string
  selectedKey?: string; onSelect?: (r: T) => void; loading?: boolean; empty?: ReactNode; compact?: boolean
}) {
  const h = compact ? 'h-7' : 'h-8'
  return (
    <table className="w-full border-collapse text-sm">
      <caption className="sr-only">{caption}</caption>
      <thead className="sticky top-0 bg-surface-sunken">
        <tr>{columns.map((c) => <th key={c.header} scope="col" className={cx('h-8 px-3 text-left text-xs font-semibold text-muted', c.className)}>{c.header}</th>)}</tr>
      </thead>
      <tbody>
        {loading
          ? [0, 1, 2].map((i) => (
              <tr key={i} aria-hidden className={h}>
                {columns.map((c) => <td key={c.header} className="px-3"><div className="h-3 animate-pulse rounded-sm bg-surface-sunken" /></td>)}
              </tr>
            ))
          : rows.length === 0
            ? <tr><td colSpan={columns.length}>{empty}</td></tr>
            : rows.map((r) => {
                const key = rowKey(r)
                const selected = key === selectedKey
                return (
                  <tr
                    key={key}
                    aria-selected={onSelect ? selected : undefined}
                    tabIndex={onSelect ? 0 : undefined}
                    onClick={onSelect && (() => onSelect(r))}
                    onKeyDown={onSelect && ((e) => e.key === 'Enter' && onSelect(r))}
                    className={cx(h, 'border-b border-border', onSelect && 'cursor-default hover:bg-surface-sunken', selected && 'bg-accent-subtle hover:bg-accent-subtle')}
                  >
                    {columns.map((c) => <td key={c.header} className={cx('px-3', c.className)}>{c.cell(r)}</td>)}
                  </tr>
                )
              })}
      </tbody>
    </table>
  )
}

/* ---------- ChangeList: tree of object changes with tri-state group checkboxes ---------- */

export type ObjectChange = { id: string; type: string; name: string; kind: 'added' | 'changed' | 'removed'; destructive?: boolean }
const kindIcon: Record<ObjectChange['kind'], [LucideIcon, string, string]> = {
  added: [Plus, 'text-success', 'Added'],
  changed: [Pencil, 'text-warning', 'Changed'],
  removed: [Minus, 'text-danger', 'Removed'],
}
type Node = { group: string; change?: ObjectChange }

export function ChangeList({ changes, selected, onSelectedChange, activeId, onActivate }: {
  changes: ObjectChange[]; selected: Set<string>; onSelectedChange: (s: Set<string>) => void
  activeId?: string; onActivate: (c: ObjectChange) => void
}) {
  const groups = useMemo(() => {
    const m = new Map<string, ObjectChange[]>()
    for (const c of changes) m.set(c.type, [...(m.get(c.type) ?? []), c])
    return m
  }, [changes])
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())
  const nodes: Node[] = [...groups].flatMap(([group, items]) =>
    [{ group }, ...(collapsed.has(group) ? [] : items.map((change) => ({ group, change })))])
  const [focus, setFocus] = useState(0)
  const refs = useRef<(HTMLDivElement | null)[]>([])

  const toggle = (ids: string[], on: boolean) => {
    const next = new Set(selected)
    ids.forEach((id) => (on ? next.add(id) : next.delete(id)))
    onSelectedChange(next)
  }
  const groupState = (items: ObjectChange[]) => {
    const n = items.filter((c) => selected.has(c.id)).length
    return n === 0 ? false : n === items.length ? true : 'indeterminate' as const
  }
  const setCollapse = (g: string, c: boolean) => setCollapsed((s) => { const n = new Set(s); if (c) n.add(g); else n.delete(g); return n })
  const move = (i: number) => { const j = Math.max(0, Math.min(nodes.length - 1, i)); setFocus(j); refs.current[j]?.focus() }

  const onKey = (e: KeyboardEvent, i: number, n: Node) => {
    const items = groups.get(n.group)!
    const keys: Record<string, () => void> = {
      ArrowDown: () => move(i + 1),
      ArrowUp: () => move(i - 1),
      Home: () => move(0),
      End: () => move(nodes.length - 1),
      ArrowRight: () => !n.change && setCollapse(n.group, false),
      ArrowLeft: () => (n.change ? move(nodes.findIndex((x) => !x.change && x.group === n.group)) : setCollapse(n.group, true)),
      ' ': () => (n.change ? toggle([n.change.id], !selected.has(n.change.id)) : toggle(items.map((c) => c.id), groupState(items) !== true)),
      Enter: () => (n.change ? onActivate(n.change) : setCollapse(n.group, !collapsed.has(n.group))),
    }
    if (keys[e.key]) { e.preventDefault(); keys[e.key]() }
  }

  return (
    <div role="tree" aria-label="Changes" aria-multiselectable className="text-sm">
      {nodes.map((n, i) => {
        const items = groups.get(n.group)!
        const common = {
          ref: (el: HTMLDivElement | null) => { refs.current[i] = el },
          role: 'treeitem',
          tabIndex: i === focus ? 0 : -1,
          onKeyDown: (e: KeyboardEvent) => onKey(e, i, n),
          onFocus: () => setFocus(i),
        }
        if (!n.change) {
          const open = !collapsed.has(n.group)
          const Chevron = open ? ChevronDown : ChevronRight
          const gs = groupState(items)
          return (
            <div key={n.group} {...common} aria-label={`${n.group}, ${items.length} change${items.length === 1 ? '' : 's'}`} aria-expanded={open} aria-checked={gs === 'indeterminate' ? 'mixed' : gs}
              className="flex h-8 items-center gap-2 bg-surface-sunken px-2 font-semibold">
              <button tabIndex={-1} aria-hidden onClick={() => setCollapse(n.group, open)} className="text-muted"><Chevron className="size-4" /></button>
              <Checkbox tabIndex={-1} ariaLabel={`Include all ${n.group}`} checked={gs} onChange={(on) => toggle(items.map((c) => c.id), on)} />
              {n.group}<span className="font-normal text-muted">{items.length}</span>
            </div>
          )
        }
        const c = n.change
        const [Icon, tone, word] = kindIcon[c.kind]
        return (
          <div key={c.id} {...common} aria-label={`${word} ${c.name}${c.destructive ? ', may lose data' : ''}`} aria-selected={c.id === activeId} aria-checked={selected.has(c.id)}
            onClick={() => onActivate(c)}
            className={cx('flex h-8 cursor-default items-center gap-2 pr-2 pl-8 hover:bg-surface-sunken', c.id === activeId && 'bg-accent-subtle hover:bg-accent-subtle')}>
            <Checkbox tabIndex={-1} ariaLabel={`Include ${c.name}`} checked={selected.has(c.id)} onChange={(on) => toggle([c.id], on)} />
            <Icon aria-label={word} className={cx('size-3.5 shrink-0', tone)} />
            <span className="truncate font-mono">{c.name}</span>
            {c.destructive && (
              <span className="ml-auto inline-flex items-center gap-1 rounded-sm bg-danger-subtle px-1.5 text-xs leading-5 text-danger">
                <AlertTriangle aria-hidden className="size-3" />data loss
              </span>
            )}
          </div>
        )
      })}
    </div>
  )
}

/* ---------- CommandBar ---------- */

export type Command = { id: string; label: string; paid?: boolean; destructive?: boolean }

export function CommandBar({ commands, licensed, env, running, onRun, onCancel }: {
  commands: Command[]; licensed: boolean; env: string; running?: boolean
  onRun: (c: Command) => void; onCancel?: () => void
}) {
  const [id, setId] = useState(commands[0].id)
  const cmd = commands.find((c) => c.id === id)!
  const locked = cmd.paid && !licensed
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-2">
        <div className="w-48">
          <Select aria-label="Command" value={id} onChange={(e) => setId(e.target.value)} disabled={running}>
            {commands.map((c) => <option key={c.id} value={c.id}>{c.label}{c.paid ? ' (Pro)' : ''}</option>)}
          </Select>
        </div>
        <Button variant={cmd.destructive ? 'danger' : 'primary'} icon={Play} loading={running} disabled={locked} onClick={() => onRun(cmd)}>
          {cmd.label}
        </Button>
        {running && onCancel && <Button variant="ghost" onClick={onCancel}>Cancel</Button>}
        {cmd.paid && <Badge tone="accent">Pro</Badge>}
      </div>
      {locked && <InlineAlert tone="info" title="Part of LiftOff Pro">Add a licence in Settings, or set LIFTOFF_LICENSE, to unlock this command.</InlineAlert>}
      <details className="text-sm">
        <summary className="cursor-pointer text-muted select-none">Show CLI</summary>
        <div className="mt-2"><CodeBlock label="Equivalent command" code={`liftoff ${cmd.id} --environment=${env}`} /></div>
      </details>
    </div>
  )
}

/* ---------- LogConsole ---------- */

export type LogLine = { t: string; level: 'info' | 'warn' | 'error'; text: string }
const levelTone = { info: 'text-muted', warn: 'text-warning', error: 'text-danger' }

export function LogConsole({ lines, status }: { lines: LogLine[]; status: 'streaming' | 'done' | 'failed' }) {
  const box = useRef<HTMLDivElement>(null)
  const [pinned, setPinned] = useState(true)
  const firstError = lines.findIndex((l) => l.level === 'error')
  useEffect(() => { if (pinned) box.current?.scrollTo({ top: box.current.scrollHeight }) }, [lines, pinned])
  return (
    <div className="flex flex-col gap-2">
      {status === 'failed' && firstError >= 0 && (
        <InlineAlert tone="danger" title="Run failed">
          <a href={`#log-${firstError}`} className="underline">{lines[firstError].text}</a>
        </InlineAlert>
      )}
      <div className="relative">
        <div
          ref={box}
          role="log"
          aria-live="polite"
          aria-relevant="additions"
          tabIndex={0}
          onScroll={(e) => { const el = e.currentTarget; setPinned(el.scrollHeight - el.scrollTop - el.clientHeight < 24) }}
          className="h-48 overflow-auto rounded-md border border-border bg-surface-sunken p-2 font-mono text-xs"
        >
          {lines.map((l, i) => (
            <div key={i} id={`log-${i}`} className="flex gap-3 leading-5">
              <span className="text-muted tabular-nums">{l.t}</span>
              <span className={cx('w-10 shrink-0 uppercase', levelTone[l.level])}>{l.level}</span>
              <span className="whitespace-pre-wrap">{l.text}</span>
            </div>
          ))}
          {status === 'streaming' && <Spinner label="Running" />}
        </div>
        {!pinned && (
          <Button size="sm" className="absolute right-3 bottom-3 shadow-pop" onClick={() => setPinned(true)}>Jump to latest</Button>
        )}
      </div>
    </div>
  )
}

/* ---------- EnvironmentColumn ---------- */

export type Env = {
  name: string; role: 'Dev' | 'Scratch' | 'Test' | 'Prod'
  status: 'ok' | 'unreachable' | 'checking'; pending: number
  lastRun?: { when: string; at: string; failed?: boolean }; drift?: 'none' | 'detected'
}

export function EnvironmentColumn({ env, selected, busy, onOpen, onRun }: { env: Env; selected?: boolean; busy?: boolean; onOpen: () => void; onRun: () => void }) {
  const dot = { ok: 'bg-success', unreachable: 'bg-danger', checking: 'bg-border-input' }[env.status]
  const statusWord = { ok: 'Connected', unreachable: 'Unreachable', checking: 'Checking…' }[env.status]
  return (
    <section
      aria-label={`${env.name} environment`}
      className={cx('flex w-60 shrink-0 flex-col gap-3 rounded-lg border bg-surface p-4 shadow-card', selected ? 'border-accent' : 'border-border')}
    >
      <header className="flex items-center justify-between">
        <button onClick={onOpen} className="text-lg hover:underline">{env.name}</button>
        <Badge>{env.role}</Badge>
      </header>
      <p className="flex items-center gap-2 text-sm text-muted"><span aria-hidden className={cx('size-2 rounded-pill', dot)} />{statusWord}</p>
      {env.status === 'unreachable' ? (
        <InlineAlert tone="danger" title="Can't connect">Open it and use Edit to check the host and credentials.</InlineAlert>
      ) : (
        <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm">
          <dt className="text-muted">Pending</dt>
          <dd className={env.pending ? 'font-semibold text-warning' : ''}>{env.pending ? `${env.pending} script${env.pending === 1 ? '' : 's'}` : 'Up to date'}</dd>
          <dt className="text-muted">Last run</dt>
          <dd title={env.lastRun?.at} className={env.lastRun?.failed ? 'text-danger' : ''}>
            {env.lastRun ? `${env.lastRun.when}${env.lastRun.failed ? ', failed' : ''}` : 'Never'}
          </dd>
          <dt className="text-muted">Drift</dt>
          <dd className={env.drift === 'detected' ? 'text-danger' : ''}>{env.drift === 'detected' ? 'Detected' : env.drift === 'none' ? 'None' : 'Not checked'}</dd>
        </dl>
      )}
      <Button variant="primary" icon={Play} disabled={!env.pending || env.status !== 'ok' || busy} onClick={onRun}>Run pending</Button>
    </section>
  )
}
