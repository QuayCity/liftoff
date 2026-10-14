import {
  ChevronDown, FileClock, FileCode, FileDiff, GitBranch, GitCommitHorizontal, GitCompare, LayoutDashboard, ListChecks,
  PanelLeftClose, PanelLeftOpen, Search, Server, Settings, Workflow, type LucideIcon,
} from 'lucide-react'
import { useState, type ReactNode } from 'react'
import { IconButton, cx } from './controls'
import { Kbd, Spinner } from './display'
import { Menu, Tooltip } from './overlays'
import { ThemeToggle } from './theme'
import { UpdateButton } from './update'
import { AboutButton } from './about'

export const workspaces = ['Overview', 'Changes', 'Environments', 'Compare', 'Scripts', 'Rules', 'Commit', 'History', 'Pipelines'] as const
export type Workspace = (typeof workspaces)[number]

const icons: Record<Workspace, LucideIcon> = {
  Overview: LayoutDashboard, Changes: FileDiff, Environments: Server, Compare: GitCompare,
  Scripts: FileCode, Rules: ListChecks, Commit: GitCommitHorizontal, History: FileClock, Pipelines: Workflow,
}

/** Title bar. Empty areas are the window drag region once Tauri's custom title bar is on. */
export function TitleBar({ project, onPalette, onSettings, onClose }: {
  project: string; onPalette?: () => void; onSettings: () => void; onClose?: () => void
}) {
  return (
    <header className="flex h-10 shrink-0 items-center gap-3 border-b border-border bg-surface px-2">
      <Menu
        trigger={<button className="inline-flex h-7 items-center gap-1 rounded-md px-2 text-sm font-semibold hover:bg-surface-sunken">{project}<ChevronDown aria-hidden className="size-3.5 text-muted" /></button>}
        items={[{ label: 'Close project', onSelect: () => onClose?.() }]}
      />
      <div className="flex-1 self-stretch" />
      {onPalette && (
        <button onClick={onPalette} className="inline-flex h-7 items-center gap-2 rounded-md border border-border px-2 text-sm text-muted hover:bg-surface-sunken">
          <Search aria-hidden className="size-3.5" />Commands<Kbd>Ctrl K</Kbd>
        </button>
      )}
      <UpdateButton />
      <AboutButton />
      <ThemeToggle />
      <IconButton label="Settings" icon={Settings} onClick={onSettings} />
    </header>
  )
}

/** Workspace sidebar: icons only (with tooltips) or icons and names; the choice is remembered per computer. */
export function Sidebar({ workspace, active = true, onWorkspace }: {
  workspace: Workspace; active?: boolean; onWorkspace: (w: Workspace) => void
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
  return (
    <aside className={cx('flex shrink-0 flex-col border-r border-border bg-surface p-1.5', wide ? 'w-48' : 'w-12')}>
      {/* Navigation, not tabs: each workspace is its own view, so there are no tab panels to point at. */}
      <nav aria-label="Workspaces" className="flex flex-col gap-0.5">
        {workspaces.map((w) => {
          const current = active && w === workspace
          const Icon = icons[w]
          const button = (
            <button
              key={w}
              aria-label={wide ? undefined : w}
              aria-current={current ? 'page' : undefined}
              onClick={() => onWorkspace(w)}
              className={cx(item, current ? 'bg-surface-sunken font-medium text-fg' : 'text-muted')}
            >
              <Icon aria-hidden className={cx('size-4 shrink-0', current && 'text-accent')} />
              {wide && <span className="truncate">{w}</span>}
            </button>
          )
          return wide ? button : <Tooltip key={w} label={w} side="right">{button}</Tooltip>
        })}
      </nav>
      <div className="flex-1" />
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
