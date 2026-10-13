// Every failure has a stable error code and exit code: the CLI contract (architecture.md) that
// CI scripts, the desktop app and the VS Code extension rely on.

export type ErrorCode =
  | 'LIFTOFF_CONFIG'
  /** the desktop app: the folder has a Flyway project to convert */
  | 'LIFTOFF_FLYWAY_PROJECT'
  | 'LIFTOFF_CONNECT'
  | 'LIFTOFF_MIGRATION_FAILED'
  | 'LIFTOFF_VALIDATE'
  | 'LIFTOFF_DRIFT'
  | 'LIFTOFF_NOT_BASELINED'
  /** a database's objects differ from the baseline script it is being marked with */
  | 'LIFTOFF_BASELINE_DIFFERS'
  /** a schema-model file does not build */
  | 'LIFTOFF_MODEL_INVALID'
  /** the schema model has changes no migration script makes */
  | 'LIFTOFF_MODEL_AHEAD'
  /** a rule at error severity fired on a script (liftoff lint, liftoff check) */
  | 'LIFTOFF_RULES'
  | 'LIFTOFF_GIT'
  | 'LIFTOFF_GIT_PUSH_REJECTED'
  | 'LIFTOFF_GIT_NOT_A_REPOSITORY'
  | 'LIFTOFF_GIT_NO_UPSTREAM'
  | 'LIFTOFF_GIT_DIVERGED'
  | 'LIFTOFF_GIT_AUTH'
  | 'LIFTOFF_DB'
  | 'LIFTOFF_IO'

/** What the CLI prints for a failure: `{"ok": false, "error": <ErrorReport>}` */
export type ErrorReport = {
  code: ErrorCode
  exit_code: number
  message: string
  problems?: { path: string; message: string }[]
  differences?: { id: string; kind: string; destructive: boolean }[]
}

export class LiftoffError extends Error {
  readonly code: ErrorCode
  readonly exitCode: number

  constructor(code: ErrorCode, exitCode: number, message: string) {
    super(message)
    this.code = code
    this.exitCode = exitCode
  }

  report(): ErrorReport {
    return { code: this.code, exit_code: this.exitCode, message: this.message }
  }
}

export const configError = (msg: string) => new LiftoffError('LIFTOFF_CONFIG', 2, msg)
export const connectError = (env: string, msg: string) => new LiftoffError('LIFTOFF_CONNECT', 10, `could not connect to '${env}': ${msg}`)
export const validateError = (msg: string) => new LiftoffError('LIFTOFF_VALIDATE', 12, msg)
/** A database refused a statement. `detail` is its own wording, e.g. `ERROR: relation "x" does not exist`. */
export class DbError extends LiftoffError {
  readonly detail: string
  /** PostgreSQL SQLSTATE (`23505`) or SQL Server error number (`2714`), when there is one */
  readonly dbCode: string | undefined
  constructor(detail: string, dbCode?: string) {
    super('LIFTOFF_DB', 1, `database error: ${detail}`)
    this.detail = detail
    this.dbCode = dbCode
  }
}

export class MigrationError extends LiftoffError {
  readonly script: string
  readonly dbMessage: string
  constructor(script: string, msg: string) {
    super('LIFTOFF_MIGRATION_FAILED', 11, `migration ${script} failed: ${msg}`)
    this.script = script
    this.dbMessage = msg
  }
}

export const driftError = (env: string) =>
  new LiftoffError('LIFTOFF_DRIFT', 13, `drift found on '${env}': it has changes the migration scripts did not make`)

export const notBaselinedError = (env: string) =>
  new LiftoffError(
    'LIFTOFF_NOT_BASELINED',
    12,
    `'${env}' already has tables but no migration history. Baseline it first (\`liftoff baseline --version …\`), or run the scripts anyway with --allow-non-empty`,
  )

/** Schema-model files that do not build, each with the database's error. */
export class ModelInvalidError extends LiftoffError {
  readonly problems: { path: string; message: string }[]
  constructor(problems: { path: string; message: string }[]) {
    super('LIFTOFF_MODEL_INVALID', 12, `${problems.length} schema-model file(s) do not build:\n${problems.map((p) => `  ${p.path}: ${p.message}`).join('\n')}`)
    this.problems = problems
  }

  report(): ErrorReport {
    return { ...super.report(), problems: this.problems }
  }
}

/** A database with objects but no history differs from the baseline script it would be marked with. */
export class BaselineDiffersError extends LiftoffError {
  readonly differences: { id: string; kind: string; destructive: boolean }[]
  constructor(env: string, script: string, differences: { id: string; kind: string; destructive: boolean }[]) {
    const word = { added: 'missing', removed: 'extra', changed: 'different' } as Record<string, string>
    super(
      'LIFTOFF_BASELINE_DIFFERS',
      12,
      `'${env}' has objects that differ from ${script}:\n${differences.map((d) => `  ${word[d.kind] ?? d.kind}: ${d.id}`).join('\n')}\n` +
        'Make them match, or keep them and record the baseline anyway with --accept-differences (they then show up as drift).',
    )
    this.differences = differences
  }

  report(): ErrorReport {
    return { ...super.report(), differences: this.differences }
  }
}

export const modelAheadError = (names: string[]) =>
  new LiftoffError('LIFTOFF_MODEL_AHEAD', 14, `the schema model has changes no migration script makes: ${names.join(', ')}. Generate the migration (liftoff generate --from model)`)

export type GitErrorKind = 'push_rejected' | 'not_a_repository' | 'no_upstream' | 'diverged' | 'auth' | 'other'

export class GitError extends LiftoffError {
  readonly kind: GitErrorKind
  constructor(kind: GitErrorKind, msg: string) {
    const code: Record<GitErrorKind, ErrorCode> = {
      push_rejected: 'LIFTOFF_GIT_PUSH_REJECTED',
      not_a_repository: 'LIFTOFF_GIT_NOT_A_REPOSITORY',
      no_upstream: 'LIFTOFF_GIT_NO_UPSTREAM',
      diverged: 'LIFTOFF_GIT_DIVERGED',
      auth: 'LIFTOFF_GIT_AUTH',
      other: 'LIFTOFF_GIT',
    }
    super(code[kind], 1, msg)
    this.kind = kind
  }
}

/** Any thrown value as a LiftoffError: file-system and unexpected errors become LIFTOFF_IO. */
export function asLiftoffError(e: unknown): LiftoffError {
  if (e instanceof LiftoffError) return e
  return new LiftoffError('LIFTOFF_IO', 1, e instanceof Error ? e.message : String(e))
}
