// Runs the liftoff program and reads its answer. Every command is run with
// `--output-type json`, so the CLI prints exactly one line on stdout:
//   {"ok": true,  "result": ...}
//   {"ok": false, "error": {"code": "LIFTOFF_...", "exit_code": 12, "message": "..."}}
// Progress lines go to stderr; they are passed to `onLog` as they arrive.
//
// This file does not use the VS Code API, so it can be tested with plain Node.

import { spawn } from 'node:child_process'
import * as fs from 'node:fs'
import * as path from 'node:path'

export type CliErrorReport = { code: string; exit_code: number; message: string; problems?: { path: string; message: string }[] }

/** A failed command, with the CLI's own error code (e.g. LIFTOFF_DRIFT, LIFTOFF_LICENSE). */
export class LiftoffError extends Error {
  constructor(
    readonly report: CliErrorReport,
    /** Some failures still carry a result: `check` returns its report when it finds drift. */
    readonly result?: unknown,
  ) {
    super(report.message)
  }
}

type Answer = { ok: boolean; result?: unknown; error?: CliErrorReport }

/** The last line of stdout that is a JSON answer. */
export function parseAnswer(stdout: string): Answer | undefined {
  const lines = stdout.split(/\r?\n/).filter((l) => l.trim().startsWith('{'))
  for (const line of lines.reverse()) {
    try {
      const value = JSON.parse(line)
      if (typeof value === 'object' && value !== null && 'ok' in value) return value as Answer
    } catch {
      // not the answer line
    }
  }
  return undefined
}

export type RunOptions = {
  /** the folder that holds liftoff.toml */
  projectDir: string
  /** environment from liftoff.toml */
  environment?: string
  /** called with each progress line */
  onLog?: (line: string) => void
}

export function runCli<T>(binary: string, args: string[], opts: RunOptions): Promise<T> {
  const fullArgs = ['--output-type', 'json', '-C', opts.projectDir]
  if (opts.environment) fullArgs.push('--environment', opts.environment)
  fullArgs.push(...args)

  return new Promise((resolve, reject) => {
    const child = spawn(binary, fullArgs, { cwd: opts.projectDir, windowsHide: true })
    let stdout = ''
    let pending = '' // a stderr line that has not ended yet

    child.stdout.setEncoding('utf8').on('data', (chunk: string) => (stdout += chunk))
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => {
      const lines = (pending + chunk).split(/\r?\n/)
      pending = lines.pop() ?? ''
      for (const line of lines) if (line) opts.onLog?.(line)
    })
    child.on('error', (e) =>
      reject(new LiftoffError({ code: 'LIFTOFF_NOT_STARTED', exit_code: -1, message: `Could not start ${binary}: ${e.message}` })),
    )
    child.on('close', (exitCode) => {
      if (pending) opts.onLog?.(pending)
      const answer = parseAnswer(stdout)
      if (answer?.ok) return resolve(answer.result as T)
      if (answer?.error) return reject(new LiftoffError(answer.error, answer.result))
      const message = stdout.trim() || `liftoff stopped with exit code ${exitCode}`
      reject(new LiftoffError({ code: 'LIFTOFF_UNEXPECTED', exit_code: exitCode ?? -1, message }))
    })
  })
}

/**
 * Which liftoff program to run: the path from the settings, else the one shipped inside the
 * extension (bin/), else `liftoff` from the PATH.
 */
export function findBinary(extensionDir: string, configured: string): string {
  if (configured.trim()) return configured.trim()
  const shipped = path.join(extensionDir, 'bin', process.platform === 'win32' ? 'liftoff.exe' : 'liftoff')
  return fs.existsSync(shipped) ? shipped : 'liftoff'
}
