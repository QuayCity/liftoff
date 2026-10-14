// Light, dark, or whatever the operating system uses. The choice is remembered on this computer
// and applies to every project. tokens.css does the colours: `data-theme` on <html> forces one,
// and without it `prefers-color-scheme` decides.

import { Check, Monitor, Moon, Sun } from 'lucide-react'
import { DropdownMenu } from 'radix-ui'
import { useState } from 'react'
import { setNativeTheme } from '../api'
import { IconButton } from './controls'

export type Theme = 'system' | 'light' | 'dark'

const KEY = 'liftoff:theme'
const NAME: Record<Theme, string> = { system: 'Same as the system', light: 'Light', dark: 'Dark' }
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

/** A menu with the three choices; the button shows the current one. */
export function ThemeToggle() {
  const [theme, setTheme] = useState(savedTheme)
  const choose = (t: Theme) => {
    setTheme(t)
    applyTheme(t)
    try {
      localStorage.setItem(KEY, t)
    } catch {
      /* not remembered, but still applied */
    }
  }
  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild>
        <IconButton label={`Theme: ${NAME[theme].toLowerCase()}`} icon={ICON[theme]} />
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content sideOffset={4} align="end" className="z-50 min-w-48 rounded-md border border-border bg-surface p-1 shadow-pop">
          <DropdownMenu.Label className="px-2 py-1 text-xs text-muted">Theme</DropdownMenu.Label>
          <DropdownMenu.RadioGroup value={theme} onValueChange={(v) => choose(v as Theme)}>
            {(['system', 'light', 'dark'] as const).map((t) => {
              const Icon = ICON[t]
              return (
                <DropdownMenu.RadioItem key={t} value={t} className="flex cursor-default items-center gap-2 rounded-sm px-2 py-1.5 text-sm outline-none data-highlighted:bg-accent-subtle">
                  <Icon aria-hidden className="size-4 text-muted" />
                  <span className="flex-1">{NAME[t]}</span>
                  <DropdownMenu.ItemIndicator><Check aria-hidden className="size-4 text-accent" /></DropdownMenu.ItemIndicator>
                </DropdownMenu.RadioItem>
              )
            })}
          </DropdownMenu.RadioGroup>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  )
}
