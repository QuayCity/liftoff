// Flyway's command-line spellings (`flyway -url=… -user=… -locations=filesystem:sql migrate`),
// always accepted next to LiftOff's own flags. Translated before anything else is parsed.

export type Adhoc = {
  url?: string
  user?: string
  password?: string
  schemas?: string[]
  defaultSchema?: string
  locations?: string
  table?: string
  allowClean: boolean
}

export class FlywayArgError extends Error {}

/**
 * LiftOff arguments, plus the connection settings given on the command line. Flyway puts its
 * options before the command; translated command options go after it (global flags work anywhere).
 */
export function translate(args: string[]): { args: string[]; adhoc: Adhoc } {
  const out: string[] = []
  const tail: string[] = []
  const adhoc: Adhoc = { allowClean: false }
  for (const a of args) {
    const flywayStyle = a.startsWith('-') && !a.startsWith('--') && a.length > 2
    if (!flywayStyle) {
      out.push(a)
      continue
    }
    const eq = a.indexOf('=')
    const key = eq > 0 ? a.slice(1, eq) : a.slice(1)
    const value = eq > 0 ? a.slice(eq + 1) : undefined
    const v = () => {
      if (value === undefined) throw new FlywayArgError(`-${key} needs a value, e.g. -${key}=…`)
      return value
    }
    const yes = value === undefined || value.toLowerCase() === 'true'
    if (key === 'url') adhoc.url = v()
    else if (key === 'user') adhoc.user = v()
    else if (key === 'password') adhoc.password = v()
    else if (key === 'schemas') adhoc.schemas = v().split(',').map((s) => s.trim()).filter(Boolean)
    else if (key === 'defaultSchema') adhoc.defaultSchema = v()
    else if (key === 'locations') {
      const l = v()
      const first = l.split(',')[0].trim()
      if (!first.startsWith('filesystem:')) throw new FlywayArgError(`-locations=${l}: LiftOff reads scripts from one folder; use filesystem:<folder>`)
      if (l.includes(',')) throw new FlywayArgError(`-locations=${l}: LiftOff reads scripts from one folder`)
      adhoc.locations = first.slice('filesystem:'.length)
    } else if (key === 'table') adhoc.table = v()
    else if (key === 'cleanDisabled') adhoc.allowClean = value?.toLowerCase() === 'false'
    else if (key === 'environment') out.push('--environment', v())
    else if (key === 'outputType') out.push('--output-type', v().toLowerCase())
    else if (key === 'workingDirectory') out.push('--project-dir', v())
    else if (key === 'target') tail.push('--target', v())
    else if (key === 'cherryPick') for (const p of v().split(',').map((s) => s.trim()).filter(Boolean)) tail.push('--only', p)
    else if (key === 'outOfOrder') {
      if (yes) tail.push('--out-of-order')
    } else if (key === 'baselineVersion') tail.push('--version', v())
    else if (key === 'baselineDescription') tail.push('--description', v())
    else if (key.startsWith('placeholders.')) out.push('--placeholder', `${key.slice('placeholders.'.length)}=${v()}`)
    else if (key === 'drift') tail.push('--drift')
    else if (key === 'changes') tail.push('--changes')
    else if (key === 'dryrun' || key === 'dryRun') tail.push('--dry-run')
    // Logging and prompt switches: LiftOff is already non-interactive and logs to stderr.
    else if (key === 'X' || key === 'q' || key === 'n') continue
    else if (key === 'configFiles') throw new FlywayArgError('-configFiles: convert the Flyway config once with `liftoff init --from-flyway`')
    else throw new FlywayArgError(`-${key} is a Flyway option LiftOff does not support`)
  }
  return { args: [...out, ...tail], adhoc }
}
