// S03 connection dialog: add or edit an environment, test before saving.
import { useState } from 'react'
import { api, engineName, engineOfUrl, errorText, urlExample, type EnvView, type Project, type Role, type ServerInfo } from '../api'
import { Button, Checkbox, Field, Input, PasswordInput, RadioGroup, Select } from '../ui/controls'
import { InlineAlert } from '../ui/display'
import { Dialog } from '../ui/overlays'
import { buildUrl, defaultPort, emptyFields, splitUrl, type ConnectionFields } from '../../../../packages/liftoff/src/core/connection.ts'

const roles: { value: Role; label: string }[] = [
  { value: 'dev', label: 'Dev: where you make changes' },
  { value: 'scratch', label: 'Scratch: rebuilt for comparisons, contents are erased' },
  { value: 'test', label: 'Test' },
  { value: 'prod', label: 'Production' },
]

/** SQL Server sign-in methods (JDBC names) and what each asks for. */
const signInFor: Record<string, { label: string; help: string; user?: string; userHelp?: string; userRequired?: boolean; password?: string; tenant?: 'optional' | 'required' }> = {
  SqlPassword: { label: 'SQL Server login', help: 'A login with a user name and password on the server.', user: 'User', password: 'Password' },
  ActiveDirectoryDefault: {
    label: 'Microsoft Entra ID: the account you are signed in with',
    help: 'Uses az login or the Azure sign-in in Visual Studio Code (MFA happens there), AZURE_* environment variables, or the managed identity of an Azure machine. Nothing to type here; works in pipelines.',
  },
  ActiveDirectoryInteractive: {
    label: 'Microsoft Entra ID: sign in with a browser (MFA)',
    help: 'Opens a browser to sign in, with multi-factor authentication, the first time a command connects. For people, not pipelines.',
    user: 'Account', userHelp: 'Optional, e.g. you@company.com: picked in the browser for you.', tenant: 'optional',
  },
  ActiveDirectoryServicePrincipal: {
    label: 'Microsoft Entra ID: service principal',
    help: 'An app registration with a client secret, usually for pipelines.',
    user: 'Application (client) ID', userRequired: true, password: 'Client secret', tenant: 'required',
  },
  ActiveDirectoryManagedIdentity: {
    label: 'Microsoft Entra ID: managed identity',
    help: 'The identity of the Azure machine or runner LiftOff runs on.',
    user: 'Client ID', userHelp: 'Only for a user-assigned identity; empty for the system-assigned one.',
  },
}

export function ConnectionDialog({ open, onOpenChange, project, editing, defaultRole = 'dev', onSaved }: {
  open: boolean; onOpenChange: (o: boolean) => void; project: Project; editing?: EnvView; defaultRole?: Role; onSaved: (p: Project) => void
}) {
  // Fresh state per opening: the parent remounts this dialog with a new key.
  const [name, setName] = useState(editing?.name ?? '')
  const [role, setRole] = useState<Role>(editing?.role ?? defaultRole)
  const engine = project.engine
  const sqlserver = engine === 'sqlserver'
  // The server details when the URL can be shown that way; else the URL as written.
  const [initial] = useState(() => splitUrl(engine, editing?.url ?? ''))
  const [mode, setMode] = useState<'fields' | 'url'>(initial ? 'fields' : 'url')
  const [fields, setFields] = useState<ConnectionFields>(initial ?? emptyFields())
  // Untouched details keep the URL exactly as written (it may hold settings the fields leave out).
  const [fieldsTouched, setFieldsTouched] = useState(!editing)
  const [switchError, setSwitchError] = useState<string | null>(null)
  const [url, setUrlRaw] = useState(editing?.url ?? '')
  const [user, setUser] = useState(editing?.user ?? initial?.user ?? '')
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
  const setUrl = (v: string) => {
    setUrlRaw(v)
    setSwitchError(null)
  }
  const set = (p: Partial<ConnectionFields>) => {
    setFields({ ...fields, ...p })
    setFieldsTouched(true)
  }
  const effectiveUrl = mode === 'url' ? url.trim() : fieldsTouched || !editing ? buildUrl(engine, fields) : editing.url
  const urlError = touched && mode === 'url' && !url.trim() ? 'Enter the connection URL.' : undefined
  const serverError = touched && mode === 'fields' && !fields.server.trim() ? 'Enter the server name.' : undefined
  const portError = mode === 'fields' && fields.port.trim() && !/^\d{1,5}$/.test(fields.port.trim()) ? 'A port is a number, e.g. ' + defaultPort(engine) + '.' : undefined
  const databaseError = touched && mode === 'fields' && !fields.database.trim() ? 'Enter the database name.' : undefined
  const eraseError = touched && role === 'scratch' && !eraseOk ? 'Confirm that this database may be erased.' : undefined
  // How the user and password boxes read for the sign-in method (SQL Server, server details only).
  const signIn = sqlserver && mode === 'fields' ? signInFor[fields.authentication] ?? signInFor.SqlPassword : signInFor.SqlPassword
  const tenantError = touched && signIn.tenant === 'required' && !fields.tenantId.trim() ? 'Enter the directory (tenant) ID.' : undefined
  const userError = touched && signIn.userRequired && !user.trim() ? `Enter the ${signIn.user!.toLowerCase()}.` : undefined
  const env = () => ({ url: effectiveUrl, user: signIn.user ? user.trim() || null : null, password: signIn.password ? password || null : null, role, allow_clean: role === 'scratch' || allowClean })
  const connectionInvalid = mode === 'url' ? !url.trim() : !fields.server.trim() || !fields.database.trim() || !!portError || (signIn.tenant === 'required' && !fields.tenantId.trim()) || (signIn.userRequired && !user.trim())

  const toUrl = () => {
    setUrlRaw(effectiveUrl)
    setMode('url')
  }
  const toFields = () => {
    const s = splitUrl(engine, url)
    if (!s) {
      setSwitchError(`This URL can't be shown as server details: it uses \${env.…}, holds a password, or is not a ${engineName(engine)} URL. Keep it as a URL.`)
      return
    }
    setFields(s)
    setFieldsTouched(true)
    if (s.user && !user.trim()) setUser(s.user)
    setMode('fields')
  }

  const runTest = async () => {
    setTouched(true)
    if (connectionInvalid) return
    setTest('running')
    try {
      setTest({ ok: await api.envTestDraft(env(), project.root, editing?.name) })
    } catch (e) {
      setTest({ error: errorText(e) })
    }
  }
  const save = async () => {
    setTouched(true)
    if (nameError || urlError || eraseError || !name.trim() || connectionInvalid || taken) return
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
      dirty={!editing && !!(url || password || fields.database)}
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
        {mode === 'fields' ? (
          <div className="flex flex-col gap-4">
            <div className="grid grid-cols-[2fr_1fr] gap-4">
              <Field label="Server" error={serverError || undefined} help={sqlserver ? 'Host name or address, e.g. localhost or db01.corp.local' : 'Host name or address'}>
                {(a) => <Input {...a} value={fields.server} onChange={(e) => set({ server: e.target.value })} placeholder="localhost" spellCheck={false} />}
              </Field>
              <Field label="Port" error={portError} help={sqlserver ? 'Empty: 1433, or the named instance\'s own port' : 'Empty: 5432'}>
                {(a) => <Input {...a} inputMode="numeric" value={fields.port} onChange={(e) => set({ port: e.target.value })} placeholder={defaultPort(engine)} />}
              </Field>
            </div>
            {sqlserver && (
              <Field label="Instance" help="Only for a named instance, e.g. SQLEXPRESS. Empty for the default instance.">
                {(a) => <Input {...a} value={fields.instance} onChange={(e) => set({ instance: e.target.value })} spellCheck={false} />}
              </Field>
            )}
            <Field label="Database" error={databaseError || undefined}>
              {(a) => <Input {...a} value={fields.database} onChange={(e) => set({ database: e.target.value })} placeholder="shop" spellCheck={false} />}
            </Field>
            {sqlserver ? (
              <div className="flex flex-col gap-2">
                <Checkbox checked={fields.encrypt} onChange={(v) => set({ encrypt: v })} label="Encrypt the connection" />
                <Checkbox checked={fields.trustServerCertificate} onChange={(v) => set({ trustServerCertificate: v })}
                  label="Trust the server certificate (for a self-signed certificate, e.g. a local container or a developer machine)" />
              </div>
            ) : (
              <Field label="SSL">
                {(a) => (
                  <Select {...a} value={fields.sslmode} onChange={(e) => set({ sslmode: e.target.value })}>
                    <option value="">When the server offers it (default)</option>
                    <option value="require">Always, and verify the certificate</option>
                    <option value="disable">Off</option>
                  </Select>
                )}
              </Field>
            )}
            <p className="text-xs text-muted">Connection URL: <code className="font-mono break-all">{effectiveUrl}</code></p>
            <div><Button size="sm" variant="ghost" onClick={toUrl}>Enter a URL instead</Button></div>
          </div>
        ) : (
          <div className="flex flex-col gap-2">
            <Field label="Connection URL" error={urlError || undefined} help={`${engineName(engine)}, e.g. ${urlExample(engine)}. Use \${env.NAME} to read a value from an environment variable.`}>
              {(a) => <Input {...a} mono value={url} onChange={(e) => setUrl(e.target.value)} placeholder={urlExample(engine)} spellCheck={false} />}
            </Field>
            {switchError && <p role="alert" className="text-xs text-danger">{switchError}</p>}
            <div><Button size="sm" variant="ghost" onClick={toFields}>Enter server details instead</Button></div>
          </div>
        )}
        {sqlserver && mode === 'fields' && (
          <Field label="Sign in with" help={signIn.help}>
            {(a) => (
              <Select {...a} value={fields.authentication in signInFor ? fields.authentication : 'SqlPassword'} onChange={(e) => set({ authentication: e.target.value })}>
                {Object.entries(signInFor).map(([value, m]) => <option key={value} value={value}>{m.label}</option>)}
              </Select>
            )}
          </Field>
        )}
        {signIn.tenant && (
          <Field label="Directory (tenant) ID" error={tenantError || undefined} help={signIn.tenant === 'optional' ? 'Optional: for an account in more than one directory.' : 'The Microsoft Entra directory the app registration belongs to.'}>
            {(a) => <Input {...a} value={fields.tenantId} onChange={(e) => set({ tenantId: e.target.value })} spellCheck={false} placeholder="00000000-0000-0000-0000-000000000000" />}
          </Field>
        )}
        {(signIn.user || signIn.password) && (
          <div className="grid grid-cols-2 gap-4">
            {signIn.user && <Field label={signIn.user} help={signIn.userHelp} error={userError || undefined}>{(a) => <Input {...a} value={user} onChange={(e) => setUser(e.target.value)} autoComplete="off" />}</Field>}
            {signIn.password && (
              <Field label={signIn.password} help={editing?.has_password ? `Leave empty to keep the saved ${signIn.password.toLowerCase()}.` : undefined}>
                {(a) => <PasswordInput {...a} value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="new-password" />}
              </Field>
            )}
          </div>
        )}
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
          ? <InlineAlert tone="success" title="Connected">{test.ok.database} as {test.ok.user}, {engineName(engineOfUrl(effectiveUrl))} {test.ok.version}</InlineAlert>
          : <InlineAlert tone="danger" title="Couldn't connect">{test.error}</InlineAlert>)}
        {error && <InlineAlert tone="danger" title="Not saved">{error}</InlineAlert>}
        <button type="submit" hidden />
      </form>
    </Dialog>
  )
}
