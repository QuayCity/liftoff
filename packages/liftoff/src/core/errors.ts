// Every failure has a stable error code and exit code: the CLI contract (architecture.md) that
// CI scripts, the desktop app and the VS Code extension rely on.

export type ErrorCode =
  | 'LIFTOFF_CONFIG'
  | 'LIFTOFF_CONNECT'
  | 'LIFTOFF_MIGRATION_FAILED'
  | 'LIFTOFF_VALIDATE'
  | 'LIFTOFF_LICENSE'
  | 'LIFTOFF_DRIFT'
  | 'LIFTOFF_NOT_BASELINED'
  | 'LIFTOFF_GIT'
  | 'LIFTOFF_GIT_PUSH_REJECTED'
  | 'LIFTOFF_GIT_NOT_A_REPOSITORY'
  | 'LIFTOFF_GIT_NO_UPSTREAM'
  | 'LIFTOFF_GIT_DIVERGED'
  | 'LIFTOFF_GIT_AUTH'
  | 'LIFTOFF_DB'
  | 'LIFTOFF_IO'

/** What the CLI prints for a failure: `{"ok": false, "error": <ErrorReport>}` */
export type ErrorReport = { code: ErrorCode; exit_code: number; message: string }

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
export const licenseError = (msg: string) => new LiftoffError('LIFTOFF_LICENSE', 20, msg)
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
