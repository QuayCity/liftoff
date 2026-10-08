// Settings, slice version: project facts + licence activation (S15 and S19 in full later).
import { useState } from 'react'
import { api, errorText, type Project } from '../api'
import { Button, Field, Textarea } from '../ui/controls'
import { Card, InlineAlert } from '../ui/display'

export function Settings({ project, onProject }: { project: Project; onProject: (p: Project) => void }) {
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const lic = project.license

  const activate = async () => {
    setBusy(true)
    setError(null)
    try {
      await api.licenseActivate(text.trim())
      onProject(await api.projectOpen(project.root))
      setText('')
    } catch (e) {
      setError(errorText(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="mx-auto flex max-w-2xl flex-col gap-6 p-8">
      <h1 className="text-xl">Settings</h1>

      <section aria-labelledby="proj-h" className="flex flex-col gap-2">
        <h2 id="proj-h" className="text-lg">Project</h2>
        <Card className="p-4">
          <dl className="grid grid-cols-[8rem_1fr] gap-y-1 text-sm">
            <dt className="text-muted">Folder</dt><dd className="truncate font-mono" title={project.root}>{project.root}</dd>
            <dt className="text-muted">Engine</dt><dd>PostgreSQL</dd>
            <dt className="text-muted">Schemas</dt><dd className="font-mono">{project.schemas.join(', ')}</dd>
          </dl>
          <p className="mt-3 text-xs font-normal text-muted">Edit liftoff.toml to change these until the settings editor is built.</p>
        </Card>
      </section>

      <section aria-labelledby="lic-h" className="flex flex-col gap-2">
        <h2 id="lic-h" className="text-lg">Licence</h2>
        <Card className="flex flex-col gap-4 p-4">
          {lic ? (
            <InlineAlert tone={lic.grace_days_left != null ? 'warning' : 'success'} title={`${lic.license.org}: ${lic.license.seats} seat${lic.license.seats === 1 ? '' : 's'}`}>
              {lic.grace_days_left != null
                ? `Expired on ${lic.license.expires}. Paid features keep working for ${lic.grace_days_left} more days.`
                : `Valid until ${lic.license.expires}.`}
            </InlineAlert>
          ) : project.license_error ? (
            <InlineAlert tone="danger" title="Licence problem">{project.license_error}</InlineAlert>
          ) : (
            <p className="text-sm text-muted">No licence. Running migrations is free; writing them from your changes needs Pro.</p>
          )}
          <Field label={lic ? 'Replace licence' : 'Paste your licence'} error={error ?? undefined} help="Checked on this computer only. LiftOff never sends it anywhere.">
            {(a) => <Textarea {...a} value={text} onChange={(e) => setText(e.target.value)} className="font-mono text-xs" placeholder="LIFTOFF-1.…" spellCheck={false} />}
          </Field>
          <div><Button variant="primary" disabled={!text.trim()} loading={busy} onClick={activate}>Activate</Button></div>
          <p className="text-xs font-normal text-muted">In CI, set the same text as the LIFTOFF_LICENSE secret instead.</p>
        </Card>
      </section>
    </div>
  )
}
