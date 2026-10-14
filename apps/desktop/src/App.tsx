import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { api, ask, engineName, errorText, hostProjects, inDesktop, type Project } from './api'
import { Compare } from './screens/Compare'
import { Changes } from './screens/Changes'
import { Environments } from './screens/Environments'
import { Home } from './screens/Home'
import { Settings } from './screens/Settings'
import { Scripts } from './screens/Scripts'
import { Commit } from './screens/Commit'
import { Pipelines } from './screens/Pipelines'
import { Overview } from './screens/Overview'
import { Rules } from './screens/Rules'
import { ObjectHistory } from './screens/ObjectHistory'
import { InlineAlert } from './ui/display'
import { unsaved } from './ui/update'
import { ProjectTabs, Sidebar, StatusBar, TitleBar, workspaces, type Workspace } from './ui/shell'

const params = new URLSearchParams(location.search)

/** The open tabs, saved on every change and opened again on the next start (after an update too). */
const TABS = 'liftoff:open-projects'
function savedTabs(): { roots: string[]; active: string | null } {
  try {
    const v = JSON.parse(localStorage.getItem(TABS) ?? 'null')
    if (Array.isArray(v?.roots)) return { roots: v.roots.filter((r: unknown) => typeof r === 'string'), active: typeof v.active === 'string' ? v.active : null }
  } catch {
    /* unreadable or unavailable: start on the start page */
  }
  return { roots: [], active: null }
}

/**
 * Several projects open at once, one tab each in the title bar. A project in a tab you are not
 * looking at stays mounted (hidden), so its screen, comparisons and unsaved edits are still there.
 */
export function App() {
  const [open, setOpen] = useState<Project[]>([])
  /** The project shown, by folder; null shows the start page. */
  const [active, setActive] = useState<string | null>(null)
  // Until the saved tabs are open again, show nothing rather than the start page for a moment.
  const [restoring, setRestoring] = useState(() => !params.get('open') && (hostProjects ?? savedTabs().roots).length > 0)

  const show = useCallback((p: Project) => {
    setOpen((o) => (o.some((x) => x.root === p.root) ? o : [...o, p]))
    setActive(p.root)
  }, [])
  const update = useCallback((p: Project) => setOpen((o) => o.map((x) => (x.root === p.root ? p : x))), [])
  const onDirty = useCallback((p: Project, d: boolean) => {
    if (d) unsaved.set(p.root, p.name)
    else unsaved.delete(p.root)
  }, [])
  const close = async (root: string) => {
    const p = open.find((x) => x.root === root)
    if (unsaved.has(root) && !(await ask(`Close ${p?.name} without saving your changes?`))) return
    unsaved.delete(root)
    const rest = open.filter((x) => x.root !== root)
    setOpen(rest)
    if (active === root) setActive(rest.at(-1)?.root ?? null)
  }

  useEffect(() => {
    // Browser preview only: ?open=1 jumps straight into the seeded demo project (screenshots, UI tests).
    if (params.get('open')) {
      if (!inDesktop) api.projectOpen('C:/repos/shop-db').then(show)
      return
    }
    // The tabs of last time (in VS Code: the workspace's projects, the first in view). A folder that
    // has gone or no longer opens is left out.
    const saved = hostProjects ? { roots: hostProjects, active: hostProjects[0] ?? null } : savedTabs()
    if (!saved.roots.length) return
    void Promise.allSettled(saved.roots.map((r) => api.projectOpen(r))).then((rs) => {
      const ps = rs.flatMap((r) => (r.status === 'fulfilled' ? [r.value] : []))
      setOpen(ps)
      setActive(ps.some((p) => p.root === saved.active) ? saved.active : null)
      setRestoring(false)
    })
  }, [show])
  useEffect(() => {
    if (restoring) return
    try {
      localStorage.setItem(TABS, JSON.stringify({ roots: open.map((p) => p.root), active }))
    } catch {
      /* not remembered, the app still works */
    }
  }, [open, active, restoring])
  if (restoring) return null

  const tabs = <ProjectTabs projects={open} active={active} onSwitch={setActive} onClose={close} onAdd={() => setActive(null)} />
  return (
    <>
      {active === null && (open.length === 0 ? <Home onOpen={show} /> : (
        <div className="flex h-full flex-col">
          <TitleBar tabs={tabs} buttons={false} />
          <div className="min-h-0 flex-1 overflow-auto"><Home onOpen={show} /></div>
        </div>
      ))}
      {open.map((p) => (
        <div key={p.root} hidden={p.root !== active} className="h-full">
          <ProjectShell project={p} active={p.root === active} tabs={tabs} onProject={update} onDirty={onDirty} />
        </div>
      ))}
    </>
  )
}

type View = Workspace | 'Settings'

function ProjectShell({ project, active, tabs, onProject, onDirty }: {
  project: Project; active: boolean; tabs: ReactNode; onProject: (p: Project) => void; onDirty: (p: Project, dirty: boolean) => void
}) {
  // The last workspace per project comes back on the next open (per computer, best effort).
  const remembered = (() => {
    try {
      return localStorage.getItem(`liftoff:view:${project.root}`) as View | null
    } catch {
      return null
    }
  })()
  const [view, setViewRaw] = useState<View>((params.get('ws') as View) || remembered || 'Environments')
  const viewRef = useRef(view)
  // Settings or Rules with unsaved edits: leaving asks first.
  const [settingsDirty, setSettingsDirty] = useState(false)
  useEffect(() => {
    onDirty(project, settingsDirty)
  }, [onDirty, project, settingsDirty])
  const reloadRef = useRef(() => {})
  const setView = useCallback(async (v: View) => {
    if (settingsDirty && v !== viewRef.current && !(await ask(`Leave ${viewRef.current} without saving your changes?`))) return
    if (v !== viewRef.current) setSettingsDirty(false)
    setViewRaw(v)
    viewRef.current = v
    reloadRef.current()
    try {
      localStorage.setItem(`liftoff:view:${project.root}`, v)
    } catch {
      /* storage unavailable: the app just starts on Environments next time */
    }
  }, [settingsDirty, project.root])

  // liftoff.toml edited elsewhere (an editor, git pull): read the project again when the window
  // gets focus back, on every workspace switch (a script saved in Changes ends "no scripts yet"),
  // and when its tab is chosen again. Not while Settings has unsaved edits, which would be overwritten.
  // Only the project in view listens: hidden ones catch up when their tab is chosen.
  const [reloadError, setReloadError] = useState<string | null>(null)
  useEffect(() => {
    if (!active) return
    const reload = () => {
      if (settingsDirty) return
      api.projectOpen(project.root).then(
        (p) => {
          setReloadError(null)
          if (JSON.stringify(p) !== JSON.stringify(project)) onProject(p)
        },
        (e) => setReloadError(errorText(e)),
      )
    }
    reloadRef.current = reload
    window.addEventListener('focus', reload)
    return () => window.removeEventListener('focus', reload)
  }, [active, project, onProject, settingsDirty])
  const wasActive = useRef(active)
  useEffect(() => {
    if (active && !wasActive.current) reloadRef.current()
    wasActive.current = active
  }, [active])

  // Ctrl/Cmd + 1..9 switches workspace, in the project in view.
  useEffect(() => {
    if (!active) return
    const onKey = (e: KeyboardEvent) => {
      const n = Number(e.key)
      if ((e.ctrlKey || e.metaKey) && n >= 1 && n <= workspaces.length) {
        e.preventDefault()
        setView(workspaces[n - 1])
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [active, setView])

  return (
    <div className="flex h-full flex-col">
      <TitleBar tabs={tabs} />
      <div className="flex min-h-0 flex-1">
      <Sidebar workspace={view === 'Settings' ? 'Environments' : view} active={view !== 'Settings'} onWorkspace={setView} settings={view === 'Settings'} onSettings={() => setView('Settings')} />
      <main className="min-h-0 flex-1 overflow-auto">
        <h1 className="sr-only">{`${view}: ${project.name}`}</h1>
        {reloadError && <div className="p-4 pb-0"><InlineAlert tone="danger" title="Could not read the project files again">{reloadError} The screens show the project as it was; fix the file and come back to this window.</InlineAlert></div>}
        {view === 'Overview' && <Overview projects={[{ name: project.name, path: project.root }]} />}
        {view === 'Environments' && <Environments project={project} onProject={onProject} />}
        {view === 'Changes' && <Changes project={project} onProject={onProject} onEnvironments={() => setView('Environments')} />}
        {view === 'Settings' && <Settings project={project} onProject={onProject} onDirty={setSettingsDirty} />}
        {view === 'Compare' && <Compare project={project} />}
        {view === 'Scripts' && <Scripts project={project} />}
        {view === 'Rules' && <Rules project={project} onDirty={setSettingsDirty} />}
        {view === 'Commit' && <Commit project={project} />}
        {view === 'History' && <ObjectHistory project={project} />}
        {view === 'Pipelines' && <Pipelines project={project} />}
      </main>
      </div>
      <StatusBar path={project.root} engine={`${engineName(project.engine)} · ${project.schemas.join(', ')}`} />
    </div>
  )
}
