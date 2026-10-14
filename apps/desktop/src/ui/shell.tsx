import {
  FileClock, FileCode, FileDiff, GitBranch, GitCommitHorizontal, GitCompare, LayoutDashboard, ListChecks,
  PanelLeftClose, PanelLeftOpen, Plus, Search, Server, Settings, Workflow, X, type LucideIcon,
} from 'lucide-react'
import { useState, type ReactNode } from 'react'
import { IconButton, cx } from './controls'
import { Kbd, Spinner } from './display'
import { Tooltip } from './overlays'
import { ThemeToggle } from './theme'
import { UpdateButton } from './update'
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
      </>}
    </header>
  )
}

/** One tab per open project, each with its close button, and + for the start page to open another. */
export function ProjectTabs({ projects, active, onSwitch, onClose, onAdd }: {
  projects: { name: string; root: string }[]; active: string | null
  onSwitch: (root: string) => void; onClose: (root: string) => void; onAdd: () => void
}) {
  return (
    <nav aria-label="Open projects" className="flex min-w-0 items-center gap-1 overflow-x-auto">
      {projects.map((p) => {
        const current = p.root === active
        return (
          <div key={p.root} className={cx('flex h-7 min-w-0 shrink-0 items-center rounded-md', current ? 'bg-accent-subtle' : 'hover:bg-surface-sunken')}>
            <button aria-current={current ? 'page' : undefined} title={p.root} onClick={() => onSwitch(p.root)}
              className={cx('max-w-48 truncate pr-1 pl-2.5 text-sm', current ? 'font-semibold text-fg' : 'text-muted hover:text-fg')}>
              {p.name}
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
  /** Settings is open (it is not a workspace, so `active` is false then). */
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
      {/* With the project it belongs to, not in the title bar, which is shared by every open project. */}
      {entry('Settings', Settings, settings, onSettings)}
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
