import { AlertTriangle, CheckCircle2, Info, X, XCircle } from 'lucide-react'
import { AlertDialog, Dialog as RDialog, DropdownMenu, Toast as RToast, Tooltip as RTooltip } from 'radix-ui'
import { createContext, useCallback, useContext, useLayoutEffect, useRef, useState, type ReactElement, type ReactNode } from 'react'
import { Button, Input, cx } from './controls'
import { ask } from '../api'

export function Tooltip({ label, side, children }: { label: string; side?: 'top' | 'right' | 'bottom' | 'left'; children: ReactElement }) {
  return (
    <RTooltip.Root delayDuration={400}>
      <RTooltip.Trigger asChild>{children}</RTooltip.Trigger>
      <RTooltip.Portal>
        <RTooltip.Content side={side} sideOffset={6} className="z-50 rounded-sm bg-fg px-2 py-1 text-xs text-bg shadow-pop">
          {label}
        </RTooltip.Content>
      </RTooltip.Portal>
    </RTooltip.Root>
  )
}

/** Remembers the element focused when `open` turns true and hands focus back to it on close. */
function useReturnFocus(open: boolean) {
  const opener = useRef<HTMLElement | null>(null)
  useLayoutEffect(() => {
    if (open) opener.current = document.activeElement as HTMLElement | null
  }, [open])
  return (e: Event) => {
    if (opener.current?.isConnected) {
      e.preventDefault()
      opener.current.focus()
    }
  }
}

const dialogWidth = { sm: 'w-[420px]', md: 'w-[560px]', lg: 'w-[760px]', xl: 'w-[1080px]' }
const overlay = 'fixed inset-0 z-40 bg-fg/40'
const panel = 'fixed top-1/2 left-1/2 z-50 max-h-[85vh] max-w-[calc(100vw-32px)] -translate-x-1/2 -translate-y-1/2 overflow-auto rounded-lg border border-border bg-surface p-5 shadow-pop'

/** Dirty dialogs ask before closing; submitting dialogs cannot be closed with Esc or the overlay. */
export function Dialog({ open, onOpenChange, title, description, size = 'md', dirty, submitting, footer, children }: {
  open: boolean; onOpenChange: (o: boolean) => void; title: string; description?: string
  size?: keyof typeof dialogWidth; dirty?: boolean; submitting?: boolean; footer: ReactNode; children: ReactNode
}) {
  const returnFocus = useReturnFocus(open)
  const close = async (o: boolean) => {
    if (o) return onOpenChange(true)
    if (submitting) return
    if (dirty && !(await ask('Discard your changes?'))) return // ponytail: the window's (or VS Code's) yes/no; swap for an in-app prompt
    onOpenChange(false)
  }
  return (
    <RDialog.Root open={open} onOpenChange={close}>
      <RDialog.Portal>
        <RDialog.Overlay className={overlay} />
        <RDialog.Content className={cx(panel, dialogWidth[size])} onCloseAutoFocus={returnFocus} {...(!description && { 'aria-describedby': undefined })}>
          <div className="mb-4 flex items-start justify-between gap-4">
            <div>
              <RDialog.Title className="text-lg">{title}</RDialog.Title>
              {description && <RDialog.Description className="mt-1 text-sm text-muted">{description}</RDialog.Description>}
            </div>
            <RDialog.Close asChild disabled={submitting}>
              <button aria-label="Close" className="grid size-7 place-items-center rounded-md hover:bg-surface-sunken"><X aria-hidden className="size-4" /></button>
            </RDialog.Close>
          </div>
          {children}
          <div className="mt-5 flex justify-end gap-2">{footer}</div>
        </RDialog.Content>
      </RDialog.Portal>
    </RDialog.Root>
  )
}

/** Our destructive pattern: type the environment name to arm the button. Focus starts in the input. */
export function ConfirmDestructive({ open, onOpenChange, title, envName, consequences, action, running, onConfirm }: {
  open: boolean; onOpenChange: (o: boolean) => void; title: string; envName: string
  consequences: string[]; action: string; running?: boolean; onConfirm: () => void
}) {
  const [typed, setTyped] = useState('')
  const returnFocus = useReturnFocus(open)
  return (
    <AlertDialog.Root open={open} onOpenChange={(o) => { if (!running) { setTyped(''); onOpenChange(o) } }}>
      <AlertDialog.Portal>
        <AlertDialog.Overlay className={overlay} />
        <AlertDialog.Content className={cx(panel, dialogWidth.sm)} onCloseAutoFocus={returnFocus}>
          <AlertDialog.Title className="flex items-center gap-2 text-lg text-danger">
            <AlertTriangle aria-hidden className="size-5" />{title}
          </AlertDialog.Title>
          <AlertDialog.Description asChild>
            <ul className="mt-3 list-disc space-y-1 pl-5 text-sm">{consequences.map((c) => <li key={c}>{c}</li>)}</ul>
          </AlertDialog.Description>
          <label className="mt-4 block text-sm">
            Type <code className="rounded-sm bg-surface-sunken px-1 font-mono">{envName}</code> to confirm
            <Input autoFocus mono className="mt-1" value={typed} onChange={(e) => setTyped(e.target.value)} spellCheck={false} />
          </label>
          <div className="mt-5 flex justify-end gap-2">
            <AlertDialog.Cancel asChild><Button disabled={running}>Cancel</Button></AlertDialog.Cancel>
            <Button variant="danger" disabled={typed !== envName} loading={running} onClick={onConfirm}>{action}</Button>
          </div>
        </AlertDialog.Content>
      </AlertDialog.Portal>
    </AlertDialog.Root>
  )
}

export function Menu({ trigger, items }: { trigger: ReactElement; items: { label: string; onSelect: () => void; danger?: boolean }[] }) {
  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild>{trigger}</DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content sideOffset={4} align="start" className="z-50 min-w-44 rounded-md border border-border bg-surface p-1 shadow-pop">
          {items.map((i) => (
            <DropdownMenu.Item
              key={i.label}
              onSelect={i.onSelect}
              className={cx('cursor-default rounded-sm px-2 py-1.5 text-sm outline-none data-highlighted:bg-accent-subtle', i.danger && 'text-danger')}
            >
              {i.label}
            </DropdownMenu.Item>
          ))}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  )
}

type Tone = 'info' | 'success' | 'warning' | 'danger'
type ToastMsg = { id: number; tone: Tone; title: string; action?: { label: string; onClick: () => void } }
const toneIcon = { info: Info, success: CheckCircle2, warning: AlertTriangle, danger: XCircle }
export const toneText = { info: 'text-accent', success: 'text-success', warning: 'text-warning', danger: 'text-danger' }
const toneBorder = { info: 'border-l-accent', success: 'border-l-success', warning: 'border-l-warning', danger: 'border-l-danger' }

const ToastCtx = createContext<(t: Omit<ToastMsg, 'id'>) => void>(() => {})
export const useToast = () => useContext(ToastCtx)

/** Wraps the app: tooltip + toast providers. Info/success auto-dismiss; warnings and errors stay. */
export function OverlayProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<ToastMsg[]>([])
  const push = useCallback((t: Omit<ToastMsg, 'id'>) => setToasts((all) => [...all, { ...t, id: Date.now() + Math.random() }]), [])
  return (
    <RTooltip.Provider>
      <RToast.Provider swipeDirection="right">
        <ToastCtx.Provider value={push}>{children}</ToastCtx.Provider>
        {toasts.map((t) => {
          const Icon = toneIcon[t.tone]
          const sticky = t.tone === 'warning' || t.tone === 'danger'
          return (
            <RToast.Root
              key={t.id}
              type={t.tone === 'danger' ? 'foreground' : 'background'}
              duration={sticky ? Infinity : 5000}
              onOpenChange={(o) => !o && setToasts((all) => all.filter((x) => x.id !== t.id))}
              className={cx('flex items-start gap-3 rounded-md border border-l-4 border-border bg-surface p-3 shadow-pop', toneBorder[t.tone])}
            >
              <Icon aria-hidden className={cx('mt-0.5 size-4 shrink-0', toneText[t.tone])} />
              <RToast.Title className="flex-1 text-sm">{t.title}</RToast.Title>
              {t.action && (
                <RToast.Action altText={t.action.label} asChild>
                  <Button size="sm" onClick={t.action.onClick}>{t.action.label}</Button>
                </RToast.Action>
              )}
              <RToast.Close aria-label="Dismiss" className="grid size-6 place-items-center rounded-sm hover:bg-surface-sunken">
                <X aria-hidden className="size-3.5" />
              </RToast.Close>
            </RToast.Root>
          )
        })}
        {/* Above the action bars at the bottom of the screens (Save, Apply, Write migration) */}
        <RToast.Viewport className="fixed right-4 bottom-24 z-50 flex w-96 flex-col gap-2 outline-none" />
      </RToast.Provider>
    </RTooltip.Provider>
  )
}
