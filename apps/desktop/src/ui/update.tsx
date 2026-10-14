// Updates of the app itself: the Update button in the title bar and the start page, and the
// choice in App settings. The main process (electron/updates.ts) does the work.

import { AlertTriangle, Download, ExternalLink, RotateCw, Settings, Sparkles } from 'lucide-react'
import { useEffect, useState } from 'react'
import { updates, type UpdateInfo, type UpdateMode } from '../api'
import { Button, Field, IconButton, Select } from './controls'
import { Dialog, useToast } from './overlays'

/**
 * App settings: LiftOff on this computer, the same in every project (project settings are in each
 * project's sidebar). In the title bar and on the start page, so it is there with no project open.
 */
export function AppSettingsButton() {
  const [open, setOpen] = useState(false)
  return (
    <>
      <IconButton label="App settings" icon={Settings} onClick={() => setOpen(true)} />
      <Dialog open={open} onOpenChange={setOpen} title="App settings" description="For LiftOff on this computer, in every project. Saved as soon as you change it."
        footer={<Button onClick={() => setOpen(false)}>Close</Button>}>
        <UpdateSettings />
      </Dialog>
    </>
  )
}

/** The update state, kept current by the main process. */
export function useUpdate(): UpdateInfo | null {
  const [info, setInfo] = useState<UpdateInfo | null>(null)
  useEffect(() => {
    let live = true
    void updates.info().then((i) => live && setInfo(i))
    const off = updates.onChange(setInfo)
    return () => {
      live = false
      off()
    }
  }, [])
  return info
}

/** Open projects with unsaved edits (Settings, Rules), folder to name; kept by App. Restarting would lose them. */
export const unsaved = new Map<string, string>()

/** Restarts into the downloaded version; asks first when there are unsaved edits. Open projects come back by themselves. */
function restart() {
  if (unsaved.size && !window.confirm(`${[...unsaved.values()].join(', ')} ${unsaved.size === 1 ? 'has' : 'have'} unsaved changes, which the restart would lose. Restart anyway?`)) return
  void updates.install()
}

/** Nothing when there is nothing to do; otherwise Update, the download's progress, Restart, or
 * (on the first start after an update) What's new. */
export function UpdateButton() {
  const info = useUpdate()
  const toast = useToast()
  const s = info?.status
  if (!s) return null
  if (s.state === 'available') return <Button size="sm" variant="primary" icon={Download} onClick={() => void updates.download()}>Update to {s.version}</Button>
  if (s.state === 'downloading') return <Button size="sm" variant="primary" loading disabled>{s.percent < 100 ? `Downloading ${s.percent}%` : 'Preparing the update'}</Button>
  if (s.state === 'ready') return <Button size="sm" variant="primary" icon={RotateCw} onClick={restart}>Restart to update</Button>
  if (s.state === 'manual') return <Button size="sm" icon={ExternalLink} onClick={() => void updates.openPage()}>Download {s.version}</Button>
  // A failed swap: the old version runs again, and says why when asked.
  if (s.state === 'failed') return <Button size="sm" icon={AlertTriangle} onClick={() => toast({ tone: 'danger', title: s.message })}>Update failed</Button>
  if (info.updated) return <Button size="sm" icon={Sparkles} onClick={() => void updates.openNotes()}>What's new in {info.updated}</Button>
  return null
}

const MODES: Record<UpdateMode, string> = {
  auto: 'Download updates automatically; I choose when to restart',
  notify: 'Tell me when there is an update',
  off: 'Never check for updates',
}

/** The Updates card on the Settings screen: for this computer, not the project. */
export function UpdateSettings() {
  const info = useUpdate()
  const [checking, setChecking] = useState(false)
  if (!info) return null
  const s = info.status
  const line =
    s.state === 'latest' ? `LiftOff ${info.current} is the latest version.`
    : s.state === 'available' || s.state === 'manual' ? `LiftOff ${s.version} is available; you have ${info.current}.`
    : s.state === 'downloading' ? (s.percent < 100 ? `Downloading LiftOff ${s.version}: ${s.percent}%` : `Preparing LiftOff ${s.version}`)
    : s.state === 'ready' ? `LiftOff ${s.version} is downloaded. Restart to use it.`
    : s.state === 'failed' ? s.message
    : `This is LiftOff ${info.current}.`
  const check = async () => {
    setChecking(true)
    try {
      await updates.check()
    } finally {
      setChecking(false)
    }
  }
  return (
    <div className="flex flex-col gap-3">
      <div className="grid grid-cols-[minmax(0,24rem)_auto] items-end gap-2">
        <Field label="Updates" help={info.mode === 'off' ? 'LiftOff contacts nothing but your databases.' : 'Asks GitHub for the latest LiftOff release; nothing about you or your projects is sent.'}>
          {(a) => (
            <Select {...a} value={info.mode} onChange={(e) => void updates.setMode(e.target.value as UpdateMode)}>
              {(Object.keys(MODES) as UpdateMode[]).map((m) => <option key={m} value={m}>{MODES[m]}</option>)}
            </Select>
          )}
        </Field>
        <Button loading={checking} onClick={() => void check()}>Check now</Button>
      </div>
      <p role="status" className={s.state === 'failed' ? 'text-sm text-danger' : 'text-sm text-muted'}>{line}</p>
      <div><UpdateButton /></div>
    </div>
  )
}
