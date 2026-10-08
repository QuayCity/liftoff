// Settings: project (S15), comparison filters (S16).
import { Plus, Trash2 } from 'lucide-react'
import { useEffect, useState } from 'react'
import { api, errorText, type Filter, type LockMode, type Project } from '../api'
import { Button, Field, IconButton, Input, Select } from '../ui/controls'
import { Card, InlineAlert } from '../ui/display'
import { useToast } from '../ui/overlays'

const objectTypes = ['any', 'table', 'view', 'function', 'type', 'sequence', 'trigger', 'extension'] as const

type Form = { name: string; migrations: string; schemas: string; filters: Filter[]; lock: LockMode }
const formOf = (p: Project): Form => ({ name: p.name, migrations: p.migrations, schemas: p.schemas.join(', '), filters: p.filters, lock: p.lock })

export function Settings({ project, onProject, onDirty }: { project: Project; onProject: (p: Project) => void; onDirty: (dirty: boolean) => void }) {
  const toast = useToast()
  const [form, setForm] = useState<Form>(() => formOf(project))
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)
  const dirty = JSON.stringify(form) !== JSON.stringify(formOf(project))
  useEffect(() => onDirty(dirty), [dirty, onDirty])

  const schemas = form.schemas.split(',').map((s) => s.trim()).filter(Boolean)
  const errors = {
    name: !form.name.trim() ? 'Give the project a name.' : undefined,
    migrations: !form.migrations.trim() ? 'Where the migration scripts live, relative to the project folder.' : form.migrations.includes('..') ? 'Must be inside the project folder.' : undefined,
    schemas: schemas.length === 0 ? 'At least one schema.' : undefined,
  }
  const valid = !errors.name && !errors.migrations && !errors.schemas && form.filters.every((f) => f.pattern.trim())

  const save = async () => {
    setSaving(true)
    setSaveError(null)
    try {
      const p = await api.projectSave(project.root, {
        name: form.name.trim(), engine: project.engine, migrations: form.migrations.trim(), schemas,
        history_table: project.history_table, filters: form.filters.map((f) => ({ ...f, pattern: f.pattern.trim() })), lock: form.lock,
      })
      onProject(p)
      setForm(formOf(p))
      toast({ tone: 'success', title: 'Settings saved to liftoff.toml' })
    } catch (e) {
      setSaveError(errorText(e))
    } finally {
      setSaving(false)
    }
  }
  const setFilter = (i: number, patch: Partial<Filter>) => setForm((f) => ({ ...f, filters: f.filters.map((x, j) => (j === i ? { ...x, ...patch } : x)) }))

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-6 p-8">
      <h2 className="text-xl">Settings</h2>

      <section aria-labelledby="proj-h" className="flex flex-col gap-2">
        <h3 id="proj-h" className="text-lg">Project</h3>
        <Card className="flex flex-col gap-4 p-4">
          <p className="truncate font-mono text-xs font-normal text-muted" title={project.root}>{project.root}/liftoff.toml</p>
          <div className="grid grid-cols-2 gap-4">
            <Field label="Name" error={errors.name}>{(a) => <Input {...a} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />}</Field>
            <Field label="Migrations folder" error={errors.migrations}>{(a) => <Input {...a} mono value={form.migrations} onChange={(e) => setForm({ ...form, migrations: e.target.value })} />}</Field>
            <Field label="Schemas" error={errors.schemas} help="Comma separated. The first one holds the history table.">
              {(a) => <Input {...a} mono value={form.schemas} onChange={(e) => setForm({ ...form, schemas: e.target.value })} />}
            </Field>
            <Field label="History table" help="Fixed once databases have history.">{(a) => <Input {...a} mono readOnly value={project.history_table} />}</Field>
            <Field label="Run lock" help="Through PgBouncer in transaction mode, RDS Proxy or Aurora Limitless, use the lock table. Every machine that runs migrations must use the same setting.">
              {(a) => (
                <Select {...a} value={form.lock} onChange={(e) => setForm({ ...form, lock: e.target.value as LockMode })}>
                  <option value="advisory">Advisory lock (direct connections)</option>
                  <option value="table">Lock table (connection poolers)</option>
                </Select>
              )}
            </Field>
          </div>
        </Card>
      </section>

      <section aria-labelledby="filters-h" className="flex flex-col gap-2">
        <h3 id="filters-h" className="text-lg">Comparison filters</h3>
        <p className="text-sm text-muted">Objects matched here are left out of comparisons, drift checks and the schema model. Rules run top to bottom; the last one that matches decides.</p>
        <Card className="flex flex-col gap-2 p-4">
          {form.filters.length === 0 && <p className="text-sm text-muted">No filters: everything in the schemas above is compared.</p>}
          {form.filters.map((f, i) => (
            <div key={i} role="group" aria-label={`Filter ${i + 1}`} className="grid grid-cols-[8rem_9rem_1fr_auto] items-end gap-2">
              <Field label="Action">{(a) => (
                <Select {...a} value={f.action} onChange={(e) => setFilter(i, { action: e.target.value as Filter['action'] })}>
                  <option value="exclude">Leave out</option><option value="include">Include</option>
                </Select>
              )}</Field>
              <Field label="Object">{(a) => (
                <Select {...a} value={f.object} onChange={(e) => setFilter(i, { object: e.target.value })}>
                  {objectTypes.map((t) => <option key={t} value={t}>{t === 'any' ? 'any object' : t}</option>)}
                </Select>
              )}</Field>
              <Field label="Name pattern" error={f.pattern.trim() ? undefined : 'Enter a pattern'}>
                {(a) => <Input {...a} mono value={f.pattern} placeholder="audit_*  or  staging.*" onChange={(e) => setFilter(i, { pattern: e.target.value })} />}
              </Field>
              <IconButton label={`Remove filter ${i + 1}`} icon={Trash2} onClick={() => setForm((x) => ({ ...x, filters: x.filters.filter((_, j) => j !== i) }))} />
            </div>
          ))}
          <div>
            <Button size="sm" icon={Plus} onClick={() => setForm((x) => ({ ...x, filters: [...x.filters, { action: 'exclude', object: 'any', pattern: '' }] }))}>Add filter</Button>
          </div>
          <p className="text-xs font-normal text-muted">Patterns: * matches anything, ? one character. With a dot they match schema.name, otherwise just the name.</p>
        </Card>
      </section>

      {saveError && <InlineAlert tone="danger" title="Not saved">{saveError}</InlineAlert>}
      <div className="flex items-center gap-2">
        <Button variant="primary" disabled={!dirty || !valid} loading={saving} onClick={save}>Save settings</Button>
        <Button disabled={!dirty || saving} onClick={() => setForm(formOf(project))}>Discard changes</Button>
        {dirty && <span className="text-sm text-warning">Unsaved changes</span>}
      </div>

    </div>
  )
}
