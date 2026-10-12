// S03 connection dialog: add or edit an environment, test before saving.
import { useState } from 'react'
import { api, engineName, engineOfUrl, errorText, urlExample, type EnvView, type Project, type Role, type ServerInfo } from '../api'
import { Button, Checkbox, Field, Input, PasswordInput, RadioGroup, Select } from '../ui/controls'
import { InlineAlert } from '../ui/display'
import { Dialog } from '../ui/overlays'

const roles: { value: Role; label: string }[] = [
  { value: 'dev', label: 'Dev: where you make changes' },
  { value: 'scratch', label: 'Scratch: rebuilt for comparisons, contents are erased' },
  { value: 'test', label: 'Test' },
  { value: 'prod', label: 'Production' },
]

export function ConnectionDialog({ open, onOpenChange, project, editing, defaultRole = 'dev', onSaved }: {
  open: boolean; onOpenChange: (o: boolean) => void; project: Project; editing?: EnvView; defaultRole?: Role; onSaved: (p: Project) => void
}) {
  // Fresh state per opening: the parent remounts this dialog with a new key.
  const [name, setName] = useState(editing?.name ?? '')
  const [role, setRole] = useState<Role>(editing?.role ?? defaultRole)
  const [url, setUrl] = useState(editing?.url ?? '')
  const [user, setUser] = useState(editing?.user ?? '')
  const [password, setPassword] = useState('')
  // Editing keeps the environment where it is; new ones start private.
  const [shared, setShared] = useState<'me' | 'team'>(editing?.shared ? 'team' : 'me')
  const [allowClean, setAllowClean] = useState(editing?.allow_clean ?? false)
  const [eraseOk, setEraseOk] = useState(!!editing && editing.role === 'scratch')
  const [touched, setTouched] = useState(false)
  const [test, setTest] = useState<{ ok: ServerInfo } | { error: string } | 'running' | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const taken = !editing && project.environments.some((e) => e.name === name.trim())
  const nameError = touched && (!name.trim() ? 'Name this environment.' : !/^[A-Za-z0-9_-]+$/.test(name.trim()) ? 'Use letters, digits, - and _ only.' : taken ? 'That name is already used.' : undefined)
  const urlError = touched && !url.trim() ? 'Enter the connection URL.' : undefined
  const eraseError = touched && role === 'scratch' && !eraseOk ? 'Confirm that this database may be erased.' : undefined
  const env = () => ({ url: url.trim(), user: user.trim() || null, password: password || null, role, allow_clean: role === 'scratch' || allowClean })

  const runTest = async () => {
    setTouched(true)
    if (!url.trim()) return
    setTest('running')
    try {
      setTest({ ok: await api.envTestDraft(env(), project.root, editing?.name) })
    } catch (e) {
      setTest({ error: errorText(e) })
    }
  }
  const save = async () => {
    setTouched(true)
    if (nameError || urlError || eraseError || !name.trim() || !url.trim() || taken) return
    setBusy(true)
    setError(null)
    try {
      onSaved(await api.envSave(project.root, name.trim(), env(), shared === 'team'))
      onOpenChange(false)
    } catch (e) {
      setError(errorText(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title={editing ? `Edit ${editing.name}` : 'Add environment'}
      dirty={!!(url || password) && !editing}
      submitting={busy}
      footer={<>
        <Button onClick={runTest} loading={test === 'running'}>Test connection</Button>
        <span className="flex-1" />
        <Button onClick={() => onOpenChange(false)} disabled={busy}>Cancel</Button>
        <Button variant="primary" loading={busy} onClick={save}>Save</Button>
      </>}
    >
      <form className="flex flex-col gap-4" onSubmit={(e) => { e.preventDefault(); save() }}>
        <div className="grid grid-cols-2 gap-4">
          <Field label="Name" error={nameError || undefined}>{(a) => <Input {...a} value={name} disabled={!!editing} onChange={(e) => setName(e.target.value)} placeholder="staging" />}</Field>
          <Field label="Role">{(a) => <Select {...a} value={role} onChange={(e) => setRole(e.target.value as Role)}>{roles.map((r) => <option key={r.value} value={r.value}>{r.label}</option>)}</Select>}</Field>
        </div>
        <Field label="Connection URL" error={urlError || undefined} help={`${engineName(project.engine)}, e.g. ${urlExample(project.engine)}. Use \${env.NAME} to read a value from an environment variable.`}>
          {(a) => <Input {...a} mono value={url} onChange={(e) => setUrl(e.target.value)} placeholder={urlExample(project.engine)} spellCheck={false} />}
        </Field>
        <div className="grid grid-cols-2 gap-4">
          <Field label="User">{(a) => <Input {...a} value={user} onChange={(e) => setUser(e.target.value)} autoComplete="off" />}</Field>
          <Field label="Password" help={editing?.has_password ? 'Leave empty to keep the saved password.' : undefined}>
            {(a) => <PasswordInput {...a} value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="new-password" />}
          </Field>
        </div>
        <RadioGroup legend="Save the connection for" name="shared" value={shared} onChange={setShared} options={[
          { value: 'me', label: 'Just me', help: 'Stored in liftoff.user.toml, which git ignores.' },
          { value: 'team', label: 'Everyone on the project', help: 'URL and user go in liftoff.toml. The password always stays private.' },
        ]} />
        {role === 'scratch' ? (
          <div className="flex flex-col gap-1">
            <Checkbox checked={eraseOk} onChange={setEraseOk} label="This database may be erased and rebuilt at any time" />
            {eraseError && <p role="alert" className="text-xs text-danger">{eraseError}</p>}
          </div>
        ) : (
          <Checkbox checked={allowClean} onChange={setAllowClean} label="Allow commands that erase this database (clean)" />
        )}
        {test && test !== 'running' && ('ok' in test
          ? <InlineAlert tone="success" title="Connected">{test.ok.database} as {test.ok.user}, {engineName(engineOfUrl(url))} {test.ok.version}</InlineAlert>
          : <InlineAlert tone="danger" title="Couldn't connect">{test.error}</InlineAlert>)}
        {error && <InlineAlert tone="danger" title="Not saved">{error}</InlineAlert>}
        <button type="submit" hidden />
      </form>
    </Dialog>
  )
}
