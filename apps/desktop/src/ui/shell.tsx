import {
  FileClock, FileCode, FileDiff, GitBranch, GitCommitHorizontal, GitCompare, LayoutDashboard, ListChecks,
  PanelLeftClose, PanelLeftOpen, Plus, Search, Server, Settings, Workflow, X, type LucideIcon,
} from 'lucide-react'
import { useState, type ReactNode } from 'react'
import { IconButton, cx } from './controls'
import { Kbd, Spinner } from './display'
import { Tooltip } from './overlays'
import { ThemeToggle } from './theme'
import { AppSettingsButton, UpdateButton } from './update'
import { AboutButton } from './about'

export const workspaces = ['Overview', 'Changes', 'Environments', 'Compare', 'Scripts', 'Rules', 'Commit', 'History', 'Pipelines'] as const
export type Workspace = (typeof workspaces)[number]

const icons: Record<Workspace, LucideIcon> = {
  Overview: LayoutDashboard, Changes: FileDiff, Environments: Server, Compare: GitCompare,
  Scripts: FileCode, Rules: ListChecks, Commit: GitCommitHorizontal, History: FileClock, Pipelines: Workflow,
}

/**
 * Title bar: the open projects on the left, the app's own buttons on the right. Over the start page
 * (buttons false) it holds only the projects, as the start page has its own buttons. Empty areas are the window drag region once Tauri's
 * custom title bar is on.
 */
export function TitleBar({ tabs, onPalette, buttons = true }: { tabs: ReactNode; onPalette?: () => void; buttons?: boolean }) {
  return (
    <header className="flex h-10 shrink-0 items-center gap-3 border-b border-border bg-surface px-2">
      {tabs}
      <div className="flex-1 self-stretch" />
      {buttons && <>
      {onPalette && (
        <button onClick={onPalette} className="inline-flex h-7 items-center gap-2 rounded-md border border-border px-2 text-sm text-muted hover:bg-surface-sunken">
          <Search aria-hidden className="size-3.5" />Commands<Kbd>Ctrl K</Kbd>
        </button>
      )}
      <UpdateButton />
      <AboutButton />
      <ThemeToggle />
      <AppSettingsButton />
      </>}
    </header>
  )
}

/**
 * One tab per open project, with its engine and close button, and + for the start page to open
 * another. With `onMove`, a tab is dragged to another place, or moved with Alt+Left / Alt+Right.
 */
export function ProjectTabs({ projects, active, onSwitch, onClose, onAdd, onMove }: {
  projects: { name: string; root: string; engine: string }[]; active: string | null
  onSwitch: (root: string) => void; onClose: (root: string) => void; onAdd: () => void
  /** Puts the tab of `root` at `to` (an index in `projects`). */
  onMove?: (root: string, to: number) => void
}) {
  const [dragging, setDragging] = useState<string | null>(null)
  const [over, setOver] = useState<string | null>(null)
  const end = () => {
    setDragging(null)
    setOver(null)
  }
  return (
    <nav aria-label="Open projects" className="flex min-w-0 items-center gap-1 overflow-x-auto">
      {projects.map((p, i) => {
        const current = p.root === active
        const sqlserver = p.engine === 'sqlserver'
        return (
          <div key={p.root} draggable={!!onMove}
            onDragStart={(e) => {
              e.dataTransfer.effectAllowed = 'move'
              e.dataTransfer.setData('text/plain', p.root)
              setDragging(p.root)
            }}
            onDragOver={(e) => {
              if (!dragging) return
              e.preventDefault()
              setOver(p.root)
            }}
            onDrop={(e) => {
              e.preventDefault()
              if (dragging && dragging !== p.root) onMove?.(dragging, i)
              end()
            }}
            onDragEnd={end}
            className={cx('flex h-7 min-w-0 shrink-0 items-center rounded-md', current ? 'bg-accent-subtle' : 'hover:bg-surface-sunken',
              dragging === p.root && 'opacity-50', over === p.root && dragging !== p.root && 'ring-2 ring-accent')}>
            <button aria-current={current ? 'page' : undefined} title={`${p.root} · ${sqlserver ? 'SQL Server' : 'PostgreSQL'}${onMove ? '\nDrag, or Alt+Left / Alt+Right, to change the order' : ''}`}
              onClick={() => onSwitch(p.root)}
              onKeyDown={(e) => {
                if (!onMove || !e.altKey || (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight')) return
                e.preventDefault()
                onMove(p.root, i + (e.key === 'ArrowLeft' ? -1 : 1))
              }}
              aria-keyshortcuts={onMove ? 'Alt+ArrowLeft Alt+ArrowRight' : undefined}
              className={cx('flex max-w-56 min-w-0 items-center gap-1.5 pr-1 pl-1.5 text-sm', current ? 'font-semibold text-fg' : 'text-muted hover:text-fg')}>
              {/* The engine at a glance; the name stays the button's name (the title says the engine in full). */}
              <span aria-hidden data-engine={p.engine}
                className={cx('shrink-0 rounded-sm px-1 font-mono text-[10px] leading-4 font-semibold', sqlserver ? 'bg-warning-subtle text-warning' : 'bg-accent-subtle text-accent', current && 'bg-surface')}>
                {sqlserver ? 'MS' : 'PG'}
              </span>
              <span className="truncate">{p.name}</span>
            </button>
            <IconButton size="sm" label={`Close ${p.name}`} icon={X} onClick={() => onClose(p.root)} className="size-6 text-muted" />
          </div>
        )
      })}
      <IconButton size="sm" label="Open another project" icon={Plus} onClick={onAdd} className={cx(active === null && 'bg-accent-subtle')} />
    </nav>
  )
}

/** Workspace sidebar: icons only (with tooltips) or icons and names; the choice is remembered per computer. */
export function Sidebar({ workspace, active = true, onWorkspace, settings = false, onSettings }: {
  workspace: Workspace; active?: boolean; onWorkspace: (w: Workspace) => void
  /** Project settings is open (it is not a workspace, so `active` is false then). */
  settings?: boolean; onSettings: () => void
}) {
  const [wide, setWide] = useState(() => {
    try {
      return localStorage.getItem('liftoff:sidebar') === 'wide'
    } catch {
      return false
    }
  })
  const toggle = () => {
    setWide(!wide)
    try {
      localStorage.setItem('liftoff:sidebar', wide ? 'narrow' : 'wide')
    } catch {
      /* storage unavailable: starts narrow next time */
    }
  }
  const item = 'flex h-9 items-center gap-3 rounded-md px-2.5 text-sm hover:bg-surface-sunken hover:text-fg'
  const entry = (name: string, Icon: LucideIcon, current: boolean, onClick: () => void) => {
    const button = (
      <button
        key={name}
        aria-label={wide ? undefined : name}
        aria-current={current ? 'page' : undefined}
        onClick={onClick}
        className={cx(item, current ? 'bg-accent-subtle font-medium text-fg' : 'text-muted')}
      >
        <Icon aria-hidden className={cx('size-4 shrink-0', current && 'text-accent')} />
        {wide && <span className="truncate">{name}</span>}
      </button>
    )
    return wide ? button : <Tooltip key={name} label={name} side="right">{button}</Tooltip>
  }
  return (
    <aside className={cx('flex shrink-0 flex-col border-r border-border bg-surface p-1.5', wide ? 'w-48' : 'w-12')}>
      {/* Navigation, not tabs: each workspace is its own view, so there are no tab panels to point at. */}
      <nav aria-label="Workspaces" className="flex flex-col gap-0.5">
        {workspaces.map((w) => entry(w, icons[w], active && w === workspace, () => onWorkspace(w)))}
      </nav>
      <div className="flex-1" />
      {/* With the project it belongs to; App settings, for every project, is in the title bar. */}
      {entry('Project settings', Settings, settings, onSettings)}
      <button aria-label={wide ? 'Collapse sidebar' : 'Expand sidebar'} aria-expanded={wide} onClick={toggle} className={cx(item, 'text-muted')}>
        {wide ? <PanelLeftClose aria-hidden className="size-4 shrink-0" /> : <PanelLeftOpen aria-hidden className="size-4 shrink-0" />}
        {wide && <span>Collapse</span>}
      </button>
    </aside>
  )
}

export function StatusBar({ path, branch, ahead, engine, task }: {
  path: string; branch?: string; ahead?: number; engine: string
  task?: string
}) {
  const sep = <span aria-hidden className="text-border">|</span>
  return (
    <footer className="flex h-[26px] shrink-0 items-center gap-3 border-t border-border bg-surface px-3 text-xs font-normal text-muted">
      <span className="truncate">{path}</span>{sep}
      {branch && <><span className="inline-flex items-center gap-1"><GitBranch aria-hidden className="size-3" />{branch}{ahead ? ` ↑${ahead}` : ''}</span>{sep}</>}
      <span>{engine}</span>
      <span className="flex-1" />
      {task && <Spinner label={task} />}
    </footer>
  )
}

export function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-3">
      <h2 className="text-xs font-semibold tracking-wide text-muted uppercase">{title}</h2>
      {children}
    </section>
  )
}
