// Line diff for the side-by-side view (kept free of JSX so it can be tested with plain Node).
export type Line = { n: number; text: string }
export type Row = { left?: Line; right?: Line; kind: 'same' | 'changed' | 'removed' | 'added' }

export function lineDiff(before: string, after: string): Row[] {
  const a = before ? before.split('\n') : []
  const b = after ? after.split('\n') : []
  // lcs[i][j] = length of the LCS of a[i..] and b[j..]
  const lcs = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0))
  for (let i = a.length - 1; i >= 0; i--)
    for (let j = b.length - 1; j >= 0; j--)
      lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1])

  const rows: Row[] = []
  let i = 0
  let j = 0
  let removed: Line[] = []
  let added: Line[] = []
  // Pair up a run of removed lines with the run of added lines that follows: shown as "changed".
  const flush = () => {
    for (let k = 0; k < Math.max(removed.length, added.length); k++) {
      const left = removed[k]
      const right = added[k]
      rows.push({ left, right, kind: left && right ? 'changed' : left ? 'removed' : 'added' })
    }
    removed = []
    added = []
  }
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) {
      flush()
      rows.push({ left: { n: i + 1, text: a[i] }, right: { n: j + 1, text: b[j] }, kind: 'same' })
      i++
      j++
    } else if (j < b.length && (i >= a.length || lcs[i][j + 1] >= lcs[i + 1][j])) {
      added.push({ n: j + 1, text: b[j++] })
    } else {
      removed.push({ n: i + 1, text: a[i++] })
    }
  }
  flush()
  return rows
}

