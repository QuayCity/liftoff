import { useEffect, useState } from 'react'
import { api, inTauri, type Project } from './api'
import { Changes } from './screens/Changes'
import { Environments } from './screens/Environments'
import { Home } from './screens/Home'
import { Settings } from './screens/Settings'
import { Later } from './screens/Later'
import { Scripts } from './screens/Scripts'
import { Commit } from './screens/Commit'
import { StatusBar, TitleBar, workspaces, type Workspace } from './ui/shell'

const params = new URLSearchParams(location.search)

export function App() {
  const [project, setProject] = useState<Project | null>(null)

  // Browser preview only: ?open=1 jumps straight into the seeded demo project (screenshots, UI tests).
  useEffect(() => {
    if (!inTauri && params.get('open')) api.projectOpen('C:/repos/shop-db').then(setProject)
  }, [])

  return project ? <ProjectShell project={project} onProject={setProject} onClose={() => setProject(null)} /> : <Home onOpen={setProject} />
}

type View = Workspace | 'Settings'

function ProjectShell({ project, onProject, onClose }: { project: Project; onProject: (p: Project) => void; onClose: () => void }) {
  const [view, setView] = useState<View>((params.get('ws') as View) || 'Environments')

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
  }, [])

  const lic = project.license
  const licence = lic
    ? { text: lic.grace_days_left != null ? `Pro, ${lic.grace_days_left} days of grace left` : `Pro until ${lic.license.expires}`, warn: lic.grace_days_left != null }
    : { text: project.license_error ? 'Licence problem' : 'Free', warn: !!project.license_error }

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
        {view === 'Environments' && <Environments project={project} onProject={onProject} onSettings={() => setView('Settings')} />}
        {view === 'Changes' && <Changes project={project} onProject={onProject} onSettings={() => setView('Settings')} onEnvironments={() => setView('Environments')} />}
        {view === 'Settings' && <Settings project={project} onProject={onProject} />}
        {view === 'Scripts' && <Scripts project={project} />}
        {view === 'Commit' && <Commit project={project} />}
        {view === 'Pipelines' && <Later what={view} />}
      </main>
      <StatusBar path={project.root} engine={`PostgreSQL · ${project.schemas.join(', ')}`} licence={licence} />
    </div>
  )
}
