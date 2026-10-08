// Side-by-side line diff of an object's DDL: what the migrations build (left) vs what dev has (right).
// ponytail: plain LCS over lines, O(n·m); object definitions are small. Swap for Monaco's diff editor
// if people start diffing thousand-line functions.
import { cx } from './controls'
import { lineDiff, type Line, type Row } from './linediff.ts'

const tone = { same: '', changed: '', removed: 'bg-diff-remove', added: 'bg-diff-add' }

function Cell({ line, side, kind }: { line?: Line; side: 'left' | 'right'; kind: Row['kind'] }) {
  const bg = !line ? 'bg-surface-sunken' : kind === 'changed' ? (side === 'left' ? 'bg-diff-remove' : 'bg-diff-add') : tone[kind]
  const mark = !line || kind === 'same' ? ' ' : side === 'left' ? '−' : '+'
  return (
    <>
      <td className={cx('w-10 px-2 text-right align-top text-muted select-none', side === 'right' && 'border-l border-border', bg)}>{line?.n ?? ''}</td>
      <td className={cx('w-4 align-top text-muted select-none', bg)} aria-hidden>{mark}</td>
      <td className={cx('pr-3 align-top whitespace-pre-wrap break-words', bg)}>
        {line && kind !== 'same' && <span className="sr-only">{side === 'left' ? 'removed: ' : 'added: '}</span>}
        {line?.text ?? ''}
      </td>
    </>
  )
}

export function DiffView({ before, after, beforeLabel = 'From the migrations', afterLabel = 'In dev' }: {
  before?: string | null; after?: string | null; beforeLabel?: string; afterLabel?: string
}) {
  const rows = lineDiff(before ?? '', after ?? '')
  return (
    <div className="overflow-auto rounded-md border border-border bg-surface">
      <table className="w-full table-fixed border-collapse font-mono text-xs leading-5">
        <colgroup>
          <col className="w-10" /><col className="w-4" /><col />
          <col className="w-10" /><col className="w-4" /><col />
        </colgroup>
        <caption className="sr-only">{`${beforeLabel} compared with ${afterLabel}`}</caption>
        <thead className="sticky top-0 bg-surface-sunken font-sans">
          <tr>
            <th colSpan={3} scope="col" className="h-7 px-2 text-left font-semibold text-muted">{before ? beforeLabel : `${beforeLabel}: does not exist`}</th>
            <th colSpan={3} scope="col" className="h-7 border-l border-border px-2 text-left font-semibold text-muted">{after ? afterLabel : `${afterLabel}: does not exist`}</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r, k) => (
            <tr key={k}>
              <Cell line={r.left} side="left" kind={r.kind} />
              <Cell line={r.right} side="right" kind={r.kind} />
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
