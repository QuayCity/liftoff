import { useCallback, useEffect, useRef, useState } from 'react'
import { api, engineName, errorText, inDesktop, type Project } from './api'
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
import { Sidebar, StatusBar, TitleBar, workspaces, type Workspace } from './ui/shell'

const params = new URLSearchParams(location.search)

export function App() {
  const [project, setProject] = useState<Project | null>(null)

  // Browser preview only: ?open=1 jumps straight into the seeded demo project (screenshots, UI tests).
  useEffect(() => {
    if (!inDesktop && params.get('open')) api.projectOpen('C:/repos/shop-db').then(setProject)
  }, [])

  return project ? <ProjectShell project={project} onProject={setProject} onClose={() => setProject(null)} /> : <Home onOpen={setProject} />
}

type View = Workspace | 'Settings'

function ProjectShell({ project, onProject, onClose }: { project: Project; onProject: (p: Project) => void; onClose: () => void }) {
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
  const reloadRef = useRef(() => {})
  const setView = useCallback((v: View) => {
    if (settingsDirty && v !== viewRef.current && !window.confirm(`Leave ${viewRef.current} without saving your changes?`)) return
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
  // gets focus back, and on every workspace switch (a script saved in Changes ends "no scripts yet").
  // Not while Settings has unsaved edits, which would be overwritten.
  const [reloadError, setReloadError] = useState<string | null>(null)
  useEffect(() => {
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
  }, [project, onProject, settingsDirty])

  // Ctrl/Cmd + 1..5 switches workspace.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const n = Number(e.key)
      if ((e.ctrlKey || e.metaKey) && n >= 1 && n <= workspaces.length) {
        e.preventDefault()
        setView(workspaces[n - 1])
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [setView])

  return (
    <div className="flex h-full flex-col">
      <TitleBar project={project.name} onSettings={() => setView('Settings')} onClose={onClose} />
      <div className="flex min-h-0 flex-1">
      <Sidebar workspace={view === 'Settings' ? 'Environments' : view} active={view !== 'Settings'} onWorkspace={setView} />
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
