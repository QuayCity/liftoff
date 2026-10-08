import { Database, FilePlus2, Plus, RefreshCw, Trash2 } from 'lucide-react'
import { useState } from 'react'
import { Button, Checkbox, Field, IconButton, Input, PasswordInput, RadioGroup, Select, Switch, Textarea } from '../ui/controls'
import { ChangeList, CommandBar, DataTable, EnvironmentColumn, LogConsole, type Env, type ObjectChange } from '../ui/data'
import { Badge, Card, CodeBlock, EmptyState, InlineAlert, Kbd, Spinner, StatePill, type MigrationState } from '../ui/display'
import { ConfirmDestructive, Dialog, OverlayProvider, useToast } from '../ui/overlays'
import { Section, StatusBar, TitleBar, type Workspace } from '../ui/shell'

// Static sample data. Our own wording and examples, nothing from the original.
const changes: ObjectChange[] = [
  { id: '1', type: 'Tables', name: 'sales.order', kind: 'changed' },
  { id: '2', type: 'Tables', name: 'sales.order_line', kind: 'added' },
  { id: '3', type: 'Tables', name: 'sales.legacy_cart', kind: 'removed', destructive: true },
  { id: '4', type: 'Views', name: 'sales.daily_totals', kind: 'changed' },
  { id: '5', type: 'Functions', name: 'sales.calc_tax(numeric)', kind: 'added' },
]
type Row = { version: string; description: string; state: MigrationState; on: string; ms: string }
const rows: Row[] = [
  { version: '20261001.0912', description: 'create orders', state: 'applied', on: '2026-10-01 09:14', ms: '84 ms' },
  { version: '20261003.1530', description: 'add order lines', state: 'applied', on: '2026-10-03 15:41', ms: '212 ms' },
  { version: '20261007.1102', description: 'tax function', state: 'failed', on: '2026-10-07 11:05', ms: '9 ms' },
  { version: '20261008.0840', description: 'daily totals view', state: 'pending', on: '', ms: '' },
]
const envs: Env[] = [
  { name: 'local', role: 'Dev', status: 'ok', pending: 0, lastRun: { when: '2 min ago', at: '2026-10-08 10:58' }, drift: 'none' },
  { name: 'staging', role: 'Test', status: 'ok', pending: 2, lastRun: { when: 'yesterday', at: '2026-10-07 11:05', failed: true } },
  { name: 'production', role: 'Prod', status: 'unreachable', pending: 3 },
]
const states: MigrationState[] = ['pending', 'applied', 'failed', 'outdated', 'ignored', 'missing', 'baseline', 'undone', 'future']

function Page() {
  const toast = useToast()
  const [workspace, setWorkspace] = useState<Workspace>('Changes')
  const [theme, setTheme] = useState<'system' | 'light' | 'dark'>('system')
  const [selected, setSelected] = useState(new Set(['1', '2', '4']))
  const [active, setActive] = useState('1')
  const [dialog, setDialog] = useState(false)
  const [confirm, setConfirm] = useState(false)
  const [style, setStyle] = useState<'migrations' | 'state'>('migrations')
  const [undo, setUndo] = useState(true)
  const [check, setCheck] = useState(true)

  const applyTheme = (t: typeof theme) => {
    setTheme(t)
    if (t === 'system') delete document.documentElement.dataset.theme
    else document.documentElement.dataset.theme = t
  }

  return (
    <div className="flex h-full flex-col">
      <TitleBar project="shop-db" workspace={workspace} onWorkspace={setWorkspace} onPalette={() => toast({ tone: 'info', title: 'Command palette: not built yet' })} onSettings={() => {}} />
      <main className="flex-1 overflow-auto">
        <div className="mx-auto flex max-w-5xl flex-col gap-10 p-8">
          <div className="flex items-center justify-between">
            <h1 className="text-display">Design system</h1>
            <Select aria-label="Theme" value={theme} onChange={(e) => applyTheme(e.target.value as typeof theme)} className="w-36">
              <option value="system">System theme</option><option value="light">Light</option><option value="dark">Dark</option>
            </Select>
          </div>

          <Section title="Type">
            <div className="flex flex-col gap-1">
              <p className="text-display">Display 28</p><p className="text-xl">Heading 20</p><p className="text-lg">Subheading 16</p>
              <p className="text-base">Body 14: the default for tables, forms and panels.</p>
              <p className="text-sm">Small 13: buttons, labels, secondary text.</p>
              <p className="text-xs text-muted">Caption 12: hints, timestamps, column headers.</p>
              <p className="font-mono text-sm">Mono 13: ALTER TABLE sales.order ADD COLUMN paid_at timestamptz;</p>
            </div>
          </Section>

          <Section title="Buttons">
            <div className="flex flex-wrap items-center gap-2">
              <Button variant="primary" icon={FilePlus2}>Write migration</Button>
              <Button>Secondary</Button>
              <Button variant="ghost">Ghost</Button>
              <Button variant="danger" icon={Trash2}>Clean</Button>
              <Button variant="primary" loading>Running</Button>
              <Button disabled>Disabled</Button>
              <Button size="sm">Small</Button>
              <Button size="lg" variant="primary">Large</Button>
              <IconButton label="Refresh comparison" icon={RefreshCw} />
              <IconButton label="Add environment" icon={Plus} variant="secondary" />
            </div>
          </Section>

          <Section title="Form controls">
            <div className="grid grid-cols-2 gap-4">
              <Field label="Host" help="Name or IP of the database server.">{(a) => <Input {...a} placeholder="localhost" />}</Field>
              <Field label="Port" error="Port must be between 1 and 65535.">{(a) => <Input {...a} mono defaultValue="99999" />}</Field>
              <Field label="Password">{(a) => <PasswordInput {...a} defaultValue="hunter2" />}</Field>
              <Field label="Engine">{(a) => <Select {...a}><option>PostgreSQL</option><option disabled>SQL Server (soon)</option></Select>}</Field>
              <Field label="Version">{(a) => <Input {...a} mono readOnly value="20261008.1104" />}</Field>
              <Field label="Notes">{(a) => <Textarea {...a} placeholder="Optional" />}</Field>
              <RadioGroup legend="How changes reach other databases" name="style" value={style} onChange={setStyle} options={[
                { value: 'migrations', label: 'Migration scripts', help: 'Ordered, reviewable SQL files.' },
                { value: 'state', label: 'Compare and sync', help: 'Generate a script at deploy time.' },
              ]} />
              <div className="flex flex-col gap-3">
                <Checkbox checked={check} onChange={setCheck} label="Remember this connection" />
                <Checkbox checked="indeterminate" onChange={() => {}} label="Partially selected group" />
                <Checkbox checked={false} onChange={() => {}} disabled label="Disabled" />
                <Switch checked={undo} onChange={setUndo} label="Also write an undo script" />
              </div>
            </div>
          </Section>

          <Section title="Migration states">
            <div className="flex flex-wrap gap-2">{states.map((s) => <StatePill key={s} state={s} />)}</div>
            <div className="flex items-center gap-3"><Badge>Test</Badge><Badge tone="accent">Pro</Badge><Kbd>Ctrl K</Kbd><Spinner label="Comparing…" /></div>
          </Section>

          <Section title="Alerts and toasts">
            <InlineAlert tone="info" title="Scratch DB needed">We build it from your scripts to see what changed.</InlineAlert>
            <InlineAlert tone="success" title="Migration written">V20261008.1104__daily_totals.sql</InlineAlert>
            <InlineAlert tone="warning" title="2 scripts not yet run on local">Run them first so the comparison is accurate.</InlineAlert>
            <InlineAlert tone="danger" title="Checksum mismatch" action={<Button size="sm">Repair</Button>}>A script changed after it ran on staging.</InlineAlert>
            <div className="flex gap-2">
              <Button onClick={() => toast({ tone: 'success', title: 'Pushed 2 commits to origin/main' })}>Success toast</Button>
              <Button onClick={() => toast({ tone: 'danger', title: 'Push rejected: the remote has newer commits', action: { label: 'Pull changes', onClick: () => {} } })}>Error toast</Button>
            </div>
          </Section>

          <Section title="Dialogs">
            <div className="flex gap-2">
              <Button onClick={() => setDialog(true)}>Open dialog</Button>
              <Button variant="danger" onClick={() => setConfirm(true)}>Clean staging…</Button>
            </div>
            <Dialog open={dialog} onOpenChange={setDialog} title="Add environment" description="Saved to your user settings, not shared through git."
              footer={<><Button onClick={() => setDialog(false)}>Cancel</Button><Button variant="primary">Test and save</Button></>}>
              <div className="flex flex-col gap-3">
                <Field label="Name">{(a) => <Input {...a} defaultValue="staging" />}</Field>
                <Field label="Connection URL">{(a) => <Input {...a} mono placeholder="postgres://host:5432/db" />}</Field>
              </div>
            </Dialog>
            <ConfirmDestructive open={confirm} onOpenChange={setConfirm} title="Clean staging" envName="staging" action="Drop everything"
              consequences={['Drops every table, view and function in the managed schemas.', 'Deletes the migration history on staging.', 'Cannot be undone.']}
              onConfirm={() => setConfirm(false)} />
          </Section>

          <Section title="Change list (Changes workspace)">
            <Card className="w-[480px] overflow-hidden">
              <ChangeList changes={changes} selected={selected} onSelectedChange={setSelected} activeId={active} onActivate={(c) => setActive(c.id)} />
            </Card>
          </Section>

          <Section title="Environments board">
            <div className="flex gap-4 overflow-x-auto pb-2">{envs.map((e, i) => <EnvironmentColumn key={e.name} env={e} selected={i === 1} onOpen={() => {}} onRun={() => {}} />)}</div>
          </Section>

          <Section title="Migrations table + command bar">
            <Card className="overflow-hidden">
              <DataTable caption="Migrations on staging" rows={rows} rowKey={(r) => r.version} selectedKey="20261007.1102" onSelect={() => {}} columns={[
                { header: 'Version', cell: (r) => <span className="font-mono">{r.version}</span> },
                { header: 'Description', cell: (r) => r.description },
                { header: 'State', cell: (r) => <StatePill state={r.state} /> },
                { header: 'Ran on', cell: (r) => r.on || '—', className: 'text-muted' },
                { header: 'Took', cell: (r) => r.ms || '—', className: 'text-right tabular-nums' },
              ]} />
            </Card>
            <Card className="overflow-hidden">
              <DataTable caption="Empty" rows={[] as Row[]} rowKey={(r) => r.version} columns={[{ header: 'Version', cell: (r) => r.version }]}
                empty={<EmptyState icon={Database} text="No scripts yet. Write one from your changes, or add one by hand." action={<Button variant="primary" icon={Plus}>New script</Button>} />} />
            </Card>
            <Card className="p-4">
              <CommandBar env="staging" licensed={false} onRun={() => {}} commands={[
                { id: 'migrate', label: 'Run' }, { id: 'info', label: 'Info' }, { id: 'validate', label: 'Validate' },
                { id: 'undo', label: 'Undo', paid: true }, { id: 'clean', label: 'Clean', destructive: true },
              ]} />
            </Card>
          </Section>

          <Section title="Run log">
            <LogConsole status="failed" lines={[
              { t: '11:05:01', level: 'info', text: 'Connected to staging (PostgreSQL 16.4)' },
              { t: '11:05:01', level: 'info', text: 'Lock acquired' },
              { t: '11:05:02', level: 'warn', text: 'Script 20261007.1102 runs outside a transaction (CREATE INDEX CONCURRENTLY)' },
              { t: '11:05:02', level: 'error', text: 'ERROR: function sales.calc_tax(numeric) already exists (line 3)' },
              { t: '11:05:02', level: 'info', text: 'Rolled back 20261007.1102; lock released' },
            ]} />
            <CodeBlock label="CLI" code="liftoff migrate --environment=staging --outputType=json" />
          </Section>
        </div>
      </main>
      <StatusBar path="~/repos/shop-db" branch="main" ahead={2} engine="PostgreSQL 16" licence={{ text: 'Pro, 12 days of grace left', warn: true }} task="Comparing local" />
    </div>
  )
}

export function DesignPage() {
  return <OverlayProvider><Page /></OverlayProvider>
}
