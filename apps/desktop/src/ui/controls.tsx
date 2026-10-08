import { Check, Eye, EyeOff, Loader2, Minus, type LucideIcon } from 'lucide-react'
import { Checkbox as RCheckbox, Switch as RSwitch } from 'radix-ui'
import { useId, useState, type ButtonHTMLAttributes, type InputHTMLAttributes, type ReactNode, type SelectHTMLAttributes, type TextareaHTMLAttributes } from 'react'
import { Tooltip } from './overlays'

export const cx = (...c: (string | false | null | undefined)[]) => c.filter(Boolean).join(' ')

const variants = {
  primary: 'bg-accent text-on-accent hover:brightness-110 active:brightness-95',
  secondary: 'bg-surface text-fg border border-border hover:bg-surface-sunken',
  ghost: 'text-fg hover:bg-surface-sunken',
  danger: 'bg-danger text-on-danger hover:brightness-110 active:brightness-95',
}
const sizes = { sm: 'h-7 px-2.5 text-sm', md: 'h-8 px-3 text-sm', lg: 'h-10 px-4 text-base' }

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: keyof typeof variants
  size?: keyof typeof sizes
  loading?: boolean
  icon?: LucideIcon
}

export function Button({ variant = 'secondary', size = 'md', loading, icon: Icon, className, children, onClick, ...p }: ButtonProps) {
  return (
    <button
      type="button"
      {...p}
      // Loading keeps the button focusable and labelled; it just ignores clicks.
      onClick={loading ? undefined : onClick}
      aria-busy={loading || undefined}
      className={cx(
        'inline-flex shrink-0 items-center justify-center gap-1.5 rounded-md font-medium whitespace-nowrap transition-colors duration-100',
        'disabled:cursor-not-allowed disabled:opacity-50',
        variants[variant], sizes[size], loading && 'cursor-progress', className,
      )}
    >
      {loading ? <Loader2 aria-hidden className="size-4 animate-spin" /> : Icon && <Icon aria-hidden className="size-4" />}
      {children}
    </button>
  )
}

type IconButtonProps = Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'aria-label'> & {
  label: string
  icon: LucideIcon
  variant?: 'ghost' | 'secondary'
  size?: 'sm' | 'md'
}

export function IconButton({ label, icon: Icon, variant = 'ghost', size = 'md', className, ...p }: IconButtonProps) {
  return (
    <Tooltip label={label}>
      <button
        type="button"
        {...p}
        aria-label={label}
        className={cx(
          'inline-grid shrink-0 place-items-center rounded-md text-fg transition-colors duration-100 disabled:opacity-50',
          variant === 'ghost' ? 'hover:bg-surface-sunken' : 'border border-border bg-surface hover:bg-surface-sunken',
          size === 'sm' ? 'size-7' : 'size-8', className,
        )}
      >
        <Icon aria-hidden className="size-4" />
      </button>
    </Tooltip>
  )
}

type A11y = { id: string; 'aria-invalid'?: true; 'aria-describedby'?: string }

export function Field({ label, help, error, children }: { label: string; help?: string; error?: string; children: (a11y: A11y) => ReactNode }) {
  const id = useId()
  const describedBy = [help && `${id}-help`, error && `${id}-err`].filter(Boolean).join(' ') || undefined
  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={id} className="text-sm font-medium">{label}</label>
      {children({ id, 'aria-invalid': error ? true : undefined, 'aria-describedby': describedBy })}
      {help && <p id={`${id}-help`} className="text-xs font-normal text-muted">{help}</p>}
      {error && <p id={`${id}-err`} role="alert" className="text-xs text-danger">{error}</p>}
    </div>
  )
}

const control = cx(
  'w-full rounded-sm border border-border-input bg-surface px-2.5 text-base text-fg',
  'placeholder:text-muted aria-[invalid=true]:border-danger read-only:bg-surface-sunken disabled:opacity-50',
)

export function Input({ mono, className, ...p }: InputHTMLAttributes<HTMLInputElement> & { mono?: boolean }) {
  return <input {...p} className={cx(control, 'h-8', mono && 'font-mono text-sm', className)} />
}

export function PasswordInput(p: Omit<InputHTMLAttributes<HTMLInputElement>, 'type'>) {
  const [shown, setShown] = useState(false)
  return (
    <div className="relative">
      <input {...p} type={shown ? 'text' : 'password'} className={cx(control, 'h-8 pr-9', p.className)} />
      <button
        type="button"
        aria-label="Show password"
        aria-pressed={shown}
        onClick={() => setShown(!shown)}
        className="absolute inset-y-0 right-0 grid w-8 place-items-center text-muted hover:text-fg"
      >
        {shown ? <EyeOff aria-hidden className="size-4" /> : <Eye aria-hidden className="size-4" />}
      </button>
    </div>
  )
}

export function Select({ className, ...p }: SelectHTMLAttributes<HTMLSelectElement>) {
  return <select {...p} className={cx(control, 'h-8 pr-8', className)} />
}

export function Textarea({ className, ...p }: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea {...p} className={cx(control, 'min-h-20 py-1.5', className)} />
}

type CheckState = boolean | 'indeterminate'

export function Checkbox({ checked, onChange, label, disabled, id, tabIndex, ariaLabel }: {
  checked: CheckState; onChange: (v: boolean) => void; label?: ReactNode; disabled?: boolean; id?: string; tabIndex?: number
  /** name for a checkbox without a visible label */
  ariaLabel?: string
}) {
  const box = (
    <RCheckbox.Root
      id={id}
      tabIndex={tabIndex}
      aria-label={ariaLabel}
      checked={checked}
      disabled={disabled}
      onCheckedChange={(v) => onChange(v === true)}
      className={cx(
        'grid size-4 shrink-0 place-items-center rounded-sm border border-border-input bg-surface text-on-accent',
        'data-[state=checked]:border-accent data-[state=checked]:bg-accent',
        'data-[state=indeterminate]:border-accent data-[state=indeterminate]:bg-accent disabled:opacity-50',
      )}
    >
      <RCheckbox.Indicator>
        {checked === 'indeterminate' ? <Minus aria-hidden className="size-3" strokeWidth={3} /> : <Check aria-hidden className="size-3" strokeWidth={3} />}
      </RCheckbox.Indicator>
    </RCheckbox.Root>
  )
  if (!label) return box
  return <label className="inline-flex cursor-pointer items-center gap-2 text-sm">{box}{label}</label>
}

export function Switch({ checked, onChange, label }: { checked: boolean; onChange: (v: boolean) => void; label: string }) {
  return (
    <label className="inline-flex cursor-pointer items-center gap-2 text-sm">
      <RSwitch.Root
        checked={checked}
        onCheckedChange={onChange}
        className="relative h-[18px] w-8 shrink-0 rounded-pill bg-border-input transition-colors duration-100 data-[state=checked]:bg-accent"
      >
        <RSwitch.Thumb className="block size-3.5 translate-x-0.5 rounded-pill bg-surface transition-transform duration-100 data-[state=checked]:translate-x-4" />
      </RSwitch.Root>
      {label}
    </label>
  )
}

export function RadioGroup<T extends string>({ name, value, onChange, options, legend }: {
  name: string; value: T; onChange: (v: T) => void; legend: string
  options: { value: T; label: string; help?: string; disabled?: boolean }[]
}) {
  return (
    <fieldset className="flex flex-col gap-2">
      <legend className="mb-1 text-sm font-medium">{legend}</legend>
      {options.map((o) => (
        <label key={o.value} className={cx('flex items-start gap-2 text-sm', o.disabled ? 'cursor-not-allowed opacity-50' : 'cursor-pointer')}>
          <input type="radio" name={name} value={o.value} checked={value === o.value} disabled={o.disabled} onChange={() => onChange(o.value)} className="mt-0.5 size-4 accent-accent" />
          <span>
            {o.label}
            {o.help && <span className="block text-xs font-normal text-muted">{o.help}</span>}
          </span>
        </label>
      ))}
    </fieldset>
  )
}
