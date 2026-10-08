// S17 Pipelines: a GitHub Actions workflow that runs the migrations, stage by stage.
import { Rocket } from 'lucide-react'
import { useEffect, useState } from 'react'
import { api, errorText, type Project } from '../api'
import { Button, Checkbox, Field, Input, Switch } from '../ui/controls'
import { Card, CodeBlock, EmptyState, InlineAlert } from '../ui/display'
import { useToast } from '../ui/overlays'

const DEFAULT_INSTALL = 'cargo install --locked --git https://github.com/YOUR-ORG/liftoff liftoff-cli'
const secret = (env: string, field: string) => `LIFTOFF_ENV_${env.toUpperCase().replaceAll('-', '_')}_${field}`

export function Pipelines({ project }: { project: Project }) {
  const toast = useToast()
  const targets = project.environments.filter((e) => e.role === 'test' || e.role === 'prod')
  const [stages, setStages] = useState<string[]>(targets.map((e) => e.name))
  const [branch, setBranch] = useState('main')
  const [checks, setChecks] = useState(true)
  const [install, setInstall] = useState(DEFAULT_INSTALL)
  const [yaml, setYaml] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [writing, setWriting] = useState(false)

  useEffect(() => {
    if (!stages.length) return
    api.ciWorkflow(project.root, { stages, branch, checks, install }).then(
      (y) => { setYaml(y); setError(null) },
      (e) => { setYaml(null); setError(errorText(e)) },
    )
  }, [project.root, stages, branch, checks, install])

  if (targets.length === 0) {
    return (
      <div className="p-8">
        <Card><EmptyState icon={Rocket} text="Add a test or production environment first; the workflow deploys to those, in order." /></Card>
      </div>
    )
  }

  const write = async (overwrite: boolean) => {
    if (!yaml) return
    setWriting(true)
    try {
      const path = await api.ciWrite(project.root, yaml, overwrite)
      toast({ tone: 'success', title: `Wrote ${path}` })
    } catch (e) {
      const msg = errorText(e)
      if (msg.includes('already exists') && window.confirm(`${msg}. Replace it?`)) return write(true)
      setError(msg)
    } finally {
      setWriting(false)
    }
  }

  return (
    <div className="grid h-full grid-cols-[minmax(300px,1fr)_2fr] gap-6 p-6">
      <section aria-labelledby="ci-h" className="flex flex-col gap-4">
        <h2 id="ci-h" className="text-xl">GitHub Actions</h2>
        <fieldset className="flex flex-col gap-2">
          <legend className="mb-1 text-sm font-medium">Deploy to, in this order</legend>
          {targets.map((e) => (
            <Checkbox key={e.name} label={`${e.name} (${e.role})`} checked={stages.includes(e.name)}
              onChange={(on) => setStages((s) => (on ? targets.map((t) => t.name).filter((n) => s.includes(n) || n === e.name) : s.filter((n) => n !== e.name)))} />
          ))}
        </fieldset>
        <Field label="Branch that deploys">{(a) => <Input {...a} mono value={branch} onChange={(e) => setBranch(e.target.value)} />}</Field>
        <Switch checked={checks} onChange={setChecks} label="Validate and check for drift before migrating" />
        <Field label="Install command" help="Runs on the CI machine before the steps.">
          {(a) => <Input {...a} mono value={install} onChange={(e) => setInstall(e.target.value)} />}
        </Field>
        {install === DEFAULT_INSTALL && <InlineAlert tone="warning" title="Replace the install command">Point it at where you publish LiftOff before you use this workflow.</InlineAlert>}
        <div>
          <h3 className="text-sm font-medium">Repository secrets to add</h3>
          <ul className="mt-1 list-disc pl-5 font-mono text-xs">
            <li>LIFTOFF_LICENSE</li>
            {stages.map((s) => <li key={s}>{secret(s, 'PASSWORD')}</li>)}
          </ul>
          <p className="mt-1 text-xs font-normal text-muted">A GitHub environment with the same name as each stage can require approval before it runs.</p>
        </div>
        <div><Button variant="primary" disabled={!yaml} loading={writing} onClick={() => write(false)}>Write .github/workflows/liftoff.yml</Button></div>
      </section>
      <section aria-label="Workflow preview" className="min-h-0 overflow-auto">
        {stages.length === 0 && <InlineAlert tone="info" title="Choose at least one environment">The workflow needs somewhere to deploy.</InlineAlert>}
        {error && <InlineAlert tone="danger" title="Can't write this workflow">{error}</InlineAlert>}
        {yaml && stages.length > 0 && <CodeBlock label="Workflow file" code={yaml} />}
      </section>
    </div>
  )
}
