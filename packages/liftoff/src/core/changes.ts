// What a schema diff produces, for either engine: changes made of steps. Steps run phase by phase
// across all selected changes, so dependencies line up (a foreign key after the table it points
// at, a view after the function it calls).

export type ChangeKind = 'added' | 'changed' | 'removed'

export const P_DROP = 0 // views (cascade), triggers, constraints, indexes
export const P_TYPES = 1 // extensions, enum types, domains, sequences
export const P_TABLES = 2 // parents before partitions (order)
export const P_KEYS = 3 // pk, unique, check, exclusion, indexes
export const P_FKS = 4
export const P_FUNCS = 5
export const P_VIEWS = 6 // views and materialized views, in creation order
export const P_TRIGGERS = 7 // (SQL Server: procedures, then triggers)
export const P_GRANTS = 8 // grants and comments, once every object exists
export const P_DROP_TABLES = 9
export const P_DROP_OTHER = 10 // functions, types, domains, sequences, extensions
export const PHASES = 11

export type Step = {
  phase: number
  /** order inside a phase (views: creation order in dev) */
  order: number
  sql: string
}

export type Change = {
  id: string
  object_type: string
  name: string
  kind: ChangeKind
  destructive: boolean
  /** all steps joined, for display */
  sql: string
  steps: Step[]
  /** the reverse steps, for an undo script */
  undo_steps: Step[]
  /** the object as the migrations build it (null when added) */
  before: string | null
  /** the object as dev has it (null when removed) */
  after: string | null
}

export const step = (phase: number, sql: string, order = 0): Step => ({ phase, order, sql })

export const joined = (steps: Step[]) => steps.map((s) => s.sql).join('\n')

export const byPhase = (a: Step, b: Step) => a.phase - b.phase || a.order - b.order

export function change(prefix: string, objectType: string, name: string, kind: ChangeKind, destructive: boolean, steps: Step[], before: string | null, after: string | null): Change {
  steps.sort(byPhase)
  return { id: `${prefix}:${name}`, object_type: objectType, name, kind, destructive, sql: joined(steps), steps, undo_steps: [], before, after }
}

/** The forward changes, each with the backward change's steps as its undo. */
export function withUndo(forward: Change[], backward: Change[]): Change[] {
  for (const c of forward) {
    const b = backward.find((b) => b.id === c.id)
    if (b) c.undo_steps = b.steps
  }
  return forward
}

/* Maps keyed by (schema, name): one string key that sorts like the pair. */

const SEP = '\u0001'
export const key = (...parts: string[]) => parts.join(SEP)
export const unkey = (k: string) => k.split(SEP) as [string, string, ...string[]]

/** A map's entries sorted by key, the way the Rust BTreeMap iterated them. */
export function sorted<V>(m: Map<string, V>): [string, V][] {
  return [...m].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
}
