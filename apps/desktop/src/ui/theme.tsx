// Light, dark, or whatever the operating system uses. The choice is remembered on this computer
// and applies to every project. tokens.css does the colours: `data-theme` on <html> forces one,
// and without it `prefers-color-scheme` decides.

import { Monitor, Moon, Sun } from 'lucide-react'
import { useState } from 'react'
import { setNativeTheme } from '../api'
import { IconButton } from './controls'

export type Theme = 'system' | 'light' | 'dark'

const KEY = 'liftoff:theme'
const NEXT: Record<Theme, Theme> = { system: 'light', light: 'dark', dark: 'system' }
const NAME: Record<Theme, string> = { system: 'same as the system', light: 'light', dark: 'dark' }
const ICON = { system: Monitor, light: Sun, dark: Moon }

export function savedTheme(): Theme {
  try {
    const t = localStorage.getItem(KEY)
    if (t === 'light' || t === 'dark' || t === 'system') return t
  } catch {
    /* storage unavailable: follow the system */
  }
  return 'system'
}

export function applyTheme(t: Theme): void {
  if (t === 'system') delete document.documentElement.dataset.theme
  else document.documentElement.dataset.theme = t
  // The window frame and scroll bars follow too (in the desktop app).
  setNativeTheme(t)
}

/** One click goes to the next: system, light, dark. */
export function ThemeToggle() {
  const [theme, setTheme] = useState(savedTheme)
  const next = NEXT[theme]
  const choose = () => {
    setTheme(next)
    applyTheme(next)
    try {
      localStorage.setItem(KEY, next)
    } catch {
      /* not remembered, but still applied */
    }
  }
  return <IconButton label={`Theme: ${NAME[theme]}. Click for ${NAME[next]}`} icon={ICON[theme]} onClick={choose} />
}
