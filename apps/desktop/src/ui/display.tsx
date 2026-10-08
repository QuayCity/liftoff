import { AlertTriangle, ArrowDownToLine, CheckCircle2, CircleDashed, CircleSlash, Clock, Copy, FileQuestion, Info, Loader2, RotateCcw, Undo2, XCircle, type LucideIcon } from 'lucide-react'
import type { ReactNode } from 'react'
import { IconButton, cx } from './controls'
import { toneText } from './overlays'

export type MigrationState = 'pending' | 'applied' | 'failed' | 'outdated' | 'ignored' | 'missing' | 'baseline' | 'undone' | 'future'

// Colour is never the only cue: every state has its own icon and word.
const pill: Record<MigrationState, [string, LucideIcon, string]> = {
  pending: ['Pending', Clock, 'bg-warning-subtle text-warning'],
  applied: ['Applied', CheckCircle2, 'bg-success-subtle text-success'],
  failed: ['Failed', XCircle, 'bg-danger-subtle text-danger'],
  outdated: ['Outdated', RotateCcw, 'bg-surface-sunken text-muted'],
  ignored: ['Ignored', CircleSlash, 'bg-surface-sunken text-muted'],
  missing: ['Missing', FileQuestion, 'bg-surface-sunken text-muted'],
  baseline: ['Baseline', ArrowDownToLine, 'bg-accent-subtle text-accent'],
  undone: ['Undone', Undo2, 'bg-accent-subtle text-accent'],
  future: ['Future', CircleDashed, 'bg-accent-subtle text-accent'],
}

export function StatePill({ state }: { state: MigrationState }) {
  const [label, Icon, tone] = pill[state]
  return (
    <span className={cx('inline-flex items-center gap-1 rounded-pill px-2 py-0.5 text-xs', tone)}>
      <Icon aria-hidden className="size-3.5" />{label}
    </span>
  )
}

export function Badge({ children, tone = 'neutral' }: { children: ReactNode; tone?: 'neutral' | 'accent' }) {
  return (
    <span className={cx('inline-flex items-center rounded-sm px-1.5 text-xs leading-5', tone === 'accent' ? 'bg-accent-subtle text-accent' : 'bg-surface-sunken text-muted')}>
      {children}
    </span>
  )
}

type Tone = 'info' | 'success' | 'warning' | 'danger'
const alertIcon = { info: Info, success: CheckCircle2, warning: AlertTriangle, danger: XCircle }
const alertBg = { info: 'bg-accent-subtle', success: 'bg-success-subtle', warning: 'bg-warning-subtle', danger: 'bg-danger-subtle' }

export function InlineAlert({ tone, title, children, action }: { tone: Tone; title: string; children?: ReactNode; action?: ReactNode }) {
  const Icon = alertIcon[tone]
  return (
    <div role={tone === 'danger' || tone === 'warning' ? 'alert' : 'status'} className={cx('flex items-start gap-3 rounded-md p-3', alertBg[tone])}>
      <Icon aria-hidden className={cx('mt-0.5 size-4 shrink-0', toneText[tone])} />
      <div className="flex-1 text-sm">
        <p className={cx('font-semibold', toneText[tone])}>{title}</p>
        {children && <div className="mt-0.5 text-fg">{children}</div>}
      </div>
      {action}
    </div>
  )
}

export function EmptyState({ icon: Icon, text, action }: { icon: LucideIcon; text: string; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-center gap-3 px-6 py-12 text-center">
      <Icon aria-hidden className="size-8 text-muted" />
      <p className="max-w-80 text-sm text-muted">{text}</p>
      {action}
    </div>
  )
}

export function Card({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cx('rounded-lg border border-border bg-surface shadow-card', className)}>{children}</div>
}

export function Kbd({ children }: { children: ReactNode }) {
  return <kbd className="rounded-sm border border-border bg-surface-sunken px-1 font-mono text-xs text-muted">{children}</kbd>
}

export function Spinner({ label }: { label?: string }) {
  return (
    <span className="inline-flex items-center gap-1.5 text-sm text-muted">
      <Loader2 aria-hidden className="size-4 animate-spin" />
      {label}
    </span>
  )
}

export function CodeBlock({ code, label }: { code: string; label: string }) {
  return (
    <div className="relative rounded-md border border-border bg-surface-sunken">
      <pre aria-label={label} className="overflow-x-auto p-3 pr-11 font-mono text-sm"><code>{code}</code></pre>
      <div className="absolute top-1.5 right-1.5">
        <IconButton size="sm" label="Copy" icon={Copy} onClick={() => navigator.clipboard.writeText(code)} />
      </div>
    </div>
  )
}

