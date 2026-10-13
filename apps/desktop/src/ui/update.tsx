// Updates of the app itself: the Update button in the title bar and the start page, and the
// choice on the Settings screen. The main process (electron/updates.ts) does the work.

import { Download, ExternalLink, RotateCw } from 'lucide-react'
import { useEffect, useState } from 'react'
import { updates, type UpdateInfo, type UpdateMode } from '../api'
import { Button, Field, Select } from './controls'

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

/** Nothing when there is nothing to do; otherwise Update, the download's progress, or Restart. */
export function UpdateButton() {
  const info = useUpdate()
  const s = info?.status
  if (!s) return null
  if (s.state === 'available') return <Button size="sm" variant="primary" icon={Download} onClick={() => void updates.download()}>Update to {s.version}</Button>
  if (s.state === 'downloading') return <Button size="sm" variant="primary" loading disabled>Downloading {s.percent}%</Button>
  if (s.state === 'ready') return <Button size="sm" variant="primary" icon={RotateCw} onClick={() => void updates.install()}>Restart to update</Button>
  if (s.state === 'manual') return <Button size="sm" icon={ExternalLink} onClick={() => void updates.openPage()}>Download {s.version}</Button>
  return null
}

const MODES: Record<UpdateMode, string> = {
  notify: 'Tell me when there is an update',
  auto: 'Download and install updates automatically',
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
    : s.state === 'downloading' ? `Downloading LiftOff ${s.version}: ${s.percent}%`
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
