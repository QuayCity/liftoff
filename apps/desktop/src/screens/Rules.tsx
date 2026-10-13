// Rules: what every migration script is checked against ([rules] in liftoff.toml), their
// severities, the project's own rules, and checking every script now.
import { ListChecks, Plus, Trash2 } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import { api, engineName, errorText, type CustomRule, type LintReport, type Project, type RulesView, type Severity } from '../api'
import { Button, Field, IconButton, Input, Select, cx } from '../ui/controls'
import { Badge, Card, InlineAlert, Spinner } from '../ui/display'
import { useToast } from '../ui/overlays'
import { RuleFindings } from './Checks'

const severities: Severity[] = ['off', 'info', 'warn', 'error']
const severityText: Record<Severity, string> = { off: 'Off', info: 'Info', warn: 'Warning', error: 'Error (stops)' }

type Form = { builtin: Record<string, { severity: Severity; pattern: string }>; custom: CustomRule[] }
const formOf = (v: RulesView): Form => ({
  builtin: Object.fromEntries(v.builtin.map((r) => [r.id, { severity: r.severity, pattern: r.pattern ?? '' }])),
  custom: v.custom,
})

export function Rules({ project, onDirty }: { project: Project; onDirty: (dirty: boolean) => void }) {
  const toast = useToast()
  const [view, setView] = useState<RulesView | null>(null)
  const [form, setForm] = useState<Form | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [report, setReport] = useState<LintReport | null>(null)
  const [checking, setChecking] = useState(false)
  const [checkError, setCheckError] = useState<string | null>(null)

  const show = useCallback((v: RulesView) => {
    setView(v)
    setForm(formOf(v))
  }, [])
  useEffect(() => {
    api.rulesGet(project.root).then(show, (e) => setLoadError(errorText(e)))
  }, [project.root, show])
  const dirty = !!view && !!form && JSON.stringify(form) !== JSON.stringify(formOf(view))
  useEffect(() => onDirty(dirty), [dirty, onDirty])

  const check = async () => {
    setChecking(true)
    setCheckError(null)
    try {
      setReport(await api.lint(project.root))
    } catch (e) {
      setCheckError(errorText(e))
    } finally {
      setChecking(false)
    }
  }

  if (loadError) return <div className="p-8"><InlineAlert tone="danger" title="Can't read the rules">{loadError} Fix [rules] in liftoff.toml and come back to this window.</InlineAlert></div>
  if (!view || !form) return <div className="p-8"><Spinner label="Reading the rules" /></div>

  const patternError = (id: string) => {
    const r = view.builtin.find((b) => b.id === id)!
    const f = form.builtin[id]
    return r.needs_pattern && f.severity !== 'off' && !f.pattern.trim() ? 'This rule needs a pattern to check against.' : undefined
  }
  const customError = (c: CustomRule, i: number) =>
    !/^[a-z0-9][a-z0-9-]*$/.test(c.id) ? 'Lower-case letters, digits and -.'
      : form.builtin[c.id] || form.custom.findIndex((x) => x.id === c.id) !== i ? 'Already used by another rule.'
        : undefined
  const valid = view.builtin.every((r) => !patternError(r.id)) && form.custom.every((c, i) => !customError(c, i) && c.pattern.trim() && c.message.trim())

  const save = async () => {
    setSaving(true)
    setSaveError(null)
    try {
      const settings = Object.fromEntries(Object.entries(form.builtin).map(([id, f]) => [id, { severity: f.severity, ...(f.pattern.trim() && { pattern: f.pattern.trim() }) }]))
      show(await api.rulesSave(project.root, { settings, custom: form.custom.map((c) => ({ ...c, pattern: c.pattern.trim(), message: c.message.trim() })) }))
      toast({ tone: 'success', title: 'Rules saved to liftoff.toml' })
    } catch (e) {
      setSaveError(errorText(e))
    } finally {
      setSaving(false)
    }
  }
  const setBuiltin = (id: string, patch: Partial<Form['builtin'][string]>) => setForm({ ...form, builtin: { ...form.builtin, [id]: { ...form.builtin[id], ...patch } } })
  const setCustom = (i: number, patch: Partial<CustomRule>) => setForm({ ...form, custom: form.custom.map((c, j) => (j === i ? { ...c, ...patch } : c)) })

  return (
    <div className="mx-auto flex max-w-4xl flex-col gap-6 p-8">
      <div className="flex items-start gap-4">
        <div className="flex-1">
          <h2 className="text-xl">Rules</h2>
          <p className="mt-1 text-sm text-muted">
            The policies every migration script is checked against: here, with <span className="font-mono">liftoff lint</span>, in the
            pull-request check, and before a deploy (Environments, Checks). A rule at <strong>Error</strong> stops the check and the
            deploy; warnings and notes are reported. A script can allow one finding with a reason:{' '}
            <span className="font-mono">-- liftoff:allow drop-column: moved to archive</span>.
          </p>
        </div>
        <Button variant="primary" icon={ListChecks} loading={checking} onClick={check}>Check every script</Button>
      </div>

      {checkError && <InlineAlert tone="danger" title="Couldn't check the scripts">{checkError}</InlineAlert>}
      {report && <Card className="p-4"><RuleFindings report={report} /></Card>}

      <section aria-labelledby="builtin-h" className="flex flex-col gap-2">
        <h3 id="builtin-h" className="text-lg">Built-in rules</h3>
        <Card className="overflow-hidden">
          <table className="w-full text-sm">
            <caption className="sr-only">Built-in rules and their severity</caption>
            <thead className="bg-surface-sunken text-left text-xs text-muted">
              <tr><th scope="col" className="h-8 px-3 font-semibold">Rule</th><th scope="col" className="w-64 px-3 font-semibold">Severity</th></tr>
            </thead>
            <tbody>
              {view.builtin.map((r) => {
                const f = form.builtin[r.id]
                const other = r.engine !== null && r.engine !== project.engine
                return (
                  <tr key={r.id} className={cx('border-t border-border align-top', other && 'text-muted')}>
                    <td className="px-3 py-2">
                      <div className="flex items-center gap-2">
                        <span className="font-mono text-xs">{r.id}</span>
                        {r.engine && <Badge>{engineName(r.engine)} only</Badge>}
                        {f.severity !== r.default && <Badge tone="accent">changed</Badge>}
                      </div>
                      <p className="text-muted">{r.help}</p>
                      {r.needs_pattern && f.severity !== 'off' && (
                        <div className="mt-1 max-w-sm">
                          <Field label="Pattern (regular expression)" error={patternError(r.id)}>
                            {(a) => <Input {...a} mono value={f.pattern} placeholder="^[a-z][a-z0-9_]*$" onChange={(e) => setBuiltin(r.id, { pattern: e.target.value })} />}
                          </Field>
                        </div>
                      )}
                    </td>
                    <td className="px-3 py-2">
                      <Select aria-label={`Severity of ${r.id}`} value={f.severity} onChange={(e) => setBuiltin(r.id, { severity: e.target.value as Severity })}>
                        {severities.map((s) => <option key={s} value={s}>{severityText[s]}{s === r.default ? ' · default' : ''}</option>)}
                      </Select>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </Card>
      </section>

      <section aria-labelledby="custom-h" className="flex flex-col gap-2">
        <h3 id="custom-h" className="text-lg">This project's own rules</h3>
        <p className="text-sm text-muted">A regular expression run on each script's SQL (comments and strings left out, case ignored); every match is a finding with your message.</p>
        <Card className="flex flex-col gap-3 p-4">
          {form.custom.length === 0 && <p className="text-sm text-muted">None yet.</p>}
          {form.custom.map((c, i) => (
            <div key={i} role="group" aria-label={`Own rule ${i + 1}`} className="grid grid-cols-[10rem_1fr_9rem_auto] items-start gap-2">
              <Field label="Name" error={customError(c, i)}>{(a) => <Input {...a} mono value={c.id} onChange={(e) => setCustom(i, { id: e.target.value })} />}</Field>
              <Field label="Pattern" error={c.pattern.trim() ? undefined : 'Enter a regular expression.'}>{(a) => <Input {...a} mono value={c.pattern} placeholder="\bCASCADE\b" onChange={(e) => setCustom(i, { pattern: e.target.value })} />}</Field>
              <Field label="Severity">{(a) => (
                <Select {...a} value={c.severity} onChange={(e) => setCustom(i, { severity: e.target.value as Severity })}>
                  {severities.map((s) => <option key={s} value={s}>{severityText[s]}</option>)}
                </Select>
              )}</Field>
              <div className="pt-6"><IconButton label={`Remove own rule ${i + 1}`} icon={Trash2} onClick={() => setForm({ ...form, custom: form.custom.filter((_, j) => j !== i) })} /></div>
              <div className="col-span-3">
                <Field label="Message" error={c.message.trim() ? undefined : 'Say what is wrong and what to do instead.'}>{(a) => <Input {...a} value={c.message} onChange={(e) => setCustom(i, { message: e.target.value })} />}</Field>
              </div>
            </div>
          ))}
          <div><Button size="sm" icon={Plus} onClick={() => setForm({ ...form, custom: [...form.custom, { id: '', pattern: '', message: '', severity: 'warn' }] })}>Add a rule</Button></div>
        </Card>
      </section>

      {saveError && <InlineAlert tone="danger" title="Not saved">{saveError}</InlineAlert>}
      <div className="sticky bottom-0 flex items-center gap-2 border-t border-border bg-bg py-3">
        <Button variant="primary" disabled={!dirty || !valid} loading={saving} onClick={save}>Save rules</Button>
        <Button disabled={!dirty || saving} onClick={() => setForm(formOf(view))}>Discard changes</Button>
        {dirty && <span className="text-sm text-warning">Unsaved changes</span>}
      </div>
    </div>
  )
}
