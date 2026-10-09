import { useCallback, useEffect, useState } from 'react'
import { api, engineName, inDesktop, type Project } from './api'
import { Compare } from './screens/Compare'
import { Changes } from './screens/Changes'
import { Environments } from './screens/Environments'
import { Home } from './screens/Home'
import { Settings } from './screens/Settings'
import { Scripts } from './screens/Scripts'
import { Commit } from './screens/Commit'
import { Pipelines } from './screens/Pipelines'
import { StatusBar, TitleBar, workspaces, type Workspace } from './ui/shell'

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
  const [settingsDirty, setSettingsDirty] = useState(false)
  const setView = useCallback((v: View) => {
    if (settingsDirty && v !== 'Settings' && !window.confirm('Leave Settings without saving your changes?')) return
    setViewRaw(v)
    try {
      localStorage.setItem(`liftoff:view:${project.root}`, v)
    } catch {
      /* storage unavailable: the app just starts on Environments next time */
    }
  }, [settingsDirty, project.root])

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
      <TitleBar
        project={project.name}
        workspace={view === 'Settings' ? 'Environments' : view}
        tabsActive={view !== 'Settings'}
        onWorkspace={setView}
        onSettings={() => setView('Settings')}
        onClose={onClose}
      />
      <main className="min-h-0 flex-1 overflow-auto">
        <h1 className="sr-only">{`${view}: ${project.name}`}</h1>
        {view === 'Environments' && <Environments project={project} onProject={onProject} />}
        {view === 'Changes' && <Changes project={project} onProject={onProject} onEnvironments={() => setView('Environments')} />}
        {view === 'Settings' && <Settings project={project} onProject={onProject} onDirty={setSettingsDirty} />}
        {view === 'Compare' && <Compare project={project} />}
        {view === 'Scripts' && <Scripts project={project} />}
        {view === 'Commit' && <Commit project={project} />}
        {view === 'Pipelines' && <Pipelines project={project} />}
      </main>
      <StatusBar path={project.root} engine={`${engineName(project.engine)} · ${project.schemas.join(', ')}`} />
    </div>
  )
}
