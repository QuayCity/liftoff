// About LiftOff: the ⓘ button on the start page and in the title bar. This version, the newest
// release and what changed in it, from the release lookup the updater already makes.

import { ExternalLink, Info } from 'lucide-react'
import { useState } from 'react'
import { inVsCode, updates, type LatestRelease } from '../api'
import { Button, IconButton } from './controls'
import { Dialog } from './overlays'
import { UpdateButton, useUpdate } from './update'

/** None in VS Code: the extension's own page there has the version, and VS Code updates it. */
export function AboutButton() {
  return inVsCode ? null : <About />
}

function About() {
  const [open, setOpen] = useState(false)
  const info = useUpdate()
  const [checking, setChecking] = useState(false)
  const check = async () => {
    setChecking(true)
    try {
      await updates.check()
    } finally {
      setChecking(false)
    }
  }
  const show = (o: boolean) => {
    setOpen(o)
    // Opening it asks GitHub once, unless the person switched update checks off.
    if (o && info && info.mode !== 'off' && !info.latest && info.status.state === 'idle') void check()
  }
  const s = info?.status
  const latest = info?.latest
  const newest =
    checking || s?.state === 'checking' ? 'Checking…'
    : latest ? (latest.version === info?.current ? `${latest.version}, the one you have` : latest.version)
    : info?.mode === 'off' ? 'Not checked: update checks are off (App settings)'
    : s?.state === 'failed' ? 'Could not check'
    : 'Not checked yet'
  return (
    <>
      <IconButton label="About LiftOff" icon={Info} onClick={() => show(true)} />
      <Dialog open={open} onOpenChange={show} title="About LiftOff" description="Database migrations for PostgreSQL and SQL Server. Open source (MIT)."
        footer={<>
          <Button loading={checking} onClick={() => void check()}>Check now</Button>
          {latest && <Button icon={ExternalLink} onClick={() => void updates.openPage()}>Open on GitHub</Button>}
        </>}>
        <div className="flex flex-col gap-4">
          <dl className="grid grid-cols-[10rem_1fr] gap-x-4 gap-y-2 text-sm">
            <dt className="text-muted">This version</dt>
            <dd>{info?.current ?? '…'}</dd>
            <dt className="text-muted">Newest version</dt>
            <dd>{newest}</dd>
          </dl>
          {s?.state === 'failed' && <p role="alert" className="text-sm text-danger">{s.message}</p>}
          <div><UpdateButton /></div>
          {latest && <Notes latest={latest} />}
        </div>
      </Dialog>
    </>
  )
}

/** The release notes as text: headings and list items get their shape; nothing from the web is run. */
function Notes({ latest }: { latest: LatestRelease }) {
  const lines = latest.notes.split(/\r?\n/)
  const when = latest.published ? ` (${latest.published.slice(0, 10)})` : ''
  return (
    <section aria-label={`What's new in ${latest.version}`} className="flex flex-col gap-2">
      <h3 className="text-base">What's new in {latest.version}{when}</h3>
      <div className="max-h-[40vh] overflow-auto rounded-md border border-border bg-surface-sunken p-3 text-sm">
        {lines.every((l) => !l.trim()) && <p className="text-muted">No notes for this release.</p>}
        {lines.map((l, i) => {
          const text = l.replace(/\*\*(.+?)\*\*/g, '$1').trim()
          if (!text) return <div key={i} className="h-2" />
          if (/^#{1,6}\s/.test(text)) return <p key={i} className="mt-1 font-semibold">{text.replace(/^#+\s*/, '')}</p>
          if (/^[*-]\s/.test(text)) return <p key={i} className="pl-4 -indent-3">• {text.slice(2)}</p>
          return <p key={i}>{text}</p>
        })}
      </div>
    </section>
  )
}
