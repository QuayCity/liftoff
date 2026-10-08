import { ChevronDown, GitBranch, Search, Settings } from 'lucide-react'
import { Tabs } from 'radix-ui'
import type { ReactNode } from 'react'
import { IconButton, cx } from './controls'
import { Kbd, Spinner } from './display'
import { Menu } from './overlays'

export const workspaces = ['Changes', 'Environments', 'Scripts', 'Commit', 'Pipelines'] as const
export type Workspace = (typeof workspaces)[number]

/** Title bar. Empty areas are the window drag region once Tauri's custom title bar is on. */
export function TitleBar({ project, workspace, tabsActive = true, onWorkspace, onPalette, onSettings, onClose }: {
  project: string; workspace: Workspace; tabsActive?: boolean; onWorkspace: (w: Workspace) => void
  onPalette?: () => void; onSettings: () => void; onClose?: () => void
}) {
  return (
    <header data-tauri-drag-region className="flex h-10 shrink-0 items-center gap-3 border-b border-border bg-surface px-2">
      <Menu
        trigger={<button className="inline-flex h-7 items-center gap-1 rounded-md px-2 text-sm font-semibold hover:bg-surface-sunken">{project}<ChevronDown aria-hidden className="size-3.5 text-muted" /></button>}
        items={[{ label: 'Close project', onSelect: () => onClose?.() }]}
      />
      <Tabs.Root value={tabsActive ? workspace : ''} onValueChange={(v) => onWorkspace(v as Workspace)}>
        <Tabs.List aria-label="Workspaces" className="flex h-10 items-stretch">
          {workspaces.map((w) => (
            <Tabs.Trigger
              key={w}
              value={w}
              className="border-b-2 border-transparent px-3 text-sm text-muted hover:text-fg data-[state=active]:border-accent data-[state=active]:text-fg"
            >
              {w}
            </Tabs.Trigger>
          ))}
        </Tabs.List>
      </Tabs.Root>
      <div data-tauri-drag-region className="flex-1 self-stretch" />
      {onPalette && (
        <button onClick={onPalette} className="inline-flex h-7 items-center gap-2 rounded-md border border-border px-2 text-sm text-muted hover:bg-surface-sunken">
          <Search aria-hidden className="size-3.5" />Commands<Kbd>Ctrl K</Kbd>
        </button>
      )}
      <IconButton label="Settings" icon={Settings} onClick={onSettings} />
    </header>
  )
}

export function StatusBar({ path, branch, ahead, engine, licence, task }: {
  path: string; branch?: string; ahead?: number; engine: string
  licence: { text: string; warn?: boolean }; task?: string
}) {
  const sep = <span aria-hidden className="text-border">|</span>
  return (
    <footer className="flex h-[26px] shrink-0 items-center gap-3 border-t border-border bg-surface px-3 text-xs font-normal text-muted">
      <span className="truncate">{path}</span>{sep}
      {branch && <><span className="inline-flex items-center gap-1"><GitBranch aria-hidden className="size-3" />{branch}{ahead ? ` ↑${ahead}` : ''}</span>{sep}</>}
      <span>{engine}</span>
      <span className="flex-1" />
      {task && <Spinner label={task} />}
      <span className={cx(licence.warn && 'font-medium text-warning')}>{licence.text}</span>
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
