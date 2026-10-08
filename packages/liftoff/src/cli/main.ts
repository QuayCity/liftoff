#!/usr/bin/env node
// The `liftoff` command line: a thin layer over the core. The CI contract (architecture.md): with
// --output-type json, one JSON object per command on stdout; progress on stderr; stable exit
// codes; never prompts.

import * as fs from 'node:fs'
import * as path from 'node:path'
import { parseArgs, type ParseArgsConfig } from 'node:util'
import * as checks from '../core/checks.ts'
import * as ci from '../core/ci.ts'
import { Config, defaultSchema, init, PROJECT_FILE, readSettings, saveSettings, type Environment, type Role, type SettingsChange } from '../core/config.ts'
import { engineOf, isSqlServerUrl, open } from '../core/db.ts'
import * as diff from '../core/diff.ts'
import { asLiftoffError, configError, driftError, LiftoffError, modelAheadError } from '../core/errors.ts'
import * as flyway from '../core/flyway.ts'
import * as model from '../core/model.ts'
import * as runner from '../core/runner.ts'
import { createSample } from '../core/sample.ts'
import { FlywayArgError, translate, type Adhoc } from './flyway-args.ts'

const VERSION = '0.1.0'

type OptionSpec = { type: 'string' | 'boolean'; short?: string; multiple?: boolean; default?: string; help: string; value?: string }
type Values = Record<string, string | boolean | string[] | undefined>

type Ctx = {
  root: string
  /** the environment named on the command line (or "default" with -url) */
  env: string | undefined
  json: boolean
  placeholders: [string, string][]
  adhoc: Adhoc
}

/** What a command returns: the JSON result and the text shown without --output-type json. */
type Answer = [result: unknown, text: string]

type Command = {
  help: string
  aliases?: string[]
  options?: Record<string, OptionSpec>
  positional?: { name: string; help: string }
  run(ctx: Ctx, v: Values, positional: string | undefined): Promise<Answer>
}

const GLOBAL: Record<string, OptionSpec> = {
  'project-dir': { type: 'string', short: 'C', default: '.', help: 'Project folder (holds liftoff.toml)', value: 'DIR' },
  environment: { type: 'string', short: 'e', help: 'Environment from liftoff.toml to work on', value: 'NAME' },
  'output-type': { type: 'string', default: 'text', help: 'text or json', value: 'TYPE' },
  placeholder: { type: 'string', multiple: true, help: 'Value for a ${NAME} placeholder in the scripts, for this run (wins over liftoff.toml); repeatable', value: 'NAME=VALUE' },
  help: { type: 'boolean', short: 'h', help: 'Show help' },
  version: { type: 'boolean', short: 'V', help: 'Show the version' },
}

const log: runner.Log = (level, msg) => process.stderr.write(level === 'warn' ? `warning: ${msg}\n` : `${msg}\n`)

const str = (v: Values, k: string) => v[k] as string | undefined
const flag = (v: Values, k: string) => v[k] === true

const kindOf = (c: { kind: string }) => c.kind.padEnd(8)

function infoTable(infos: runner.MigrationInfo[]): string {
  if (!infos.length) return 'No migrations yet'
  const truncate = (s: string, n: number) => ([...s].length <= n ? s : [...s].slice(0, n - 1).join('') + '…')
  const row = (a: string, b: string, c: string, d: string, e: string) => `${a.padEnd(16)} ${b.padEnd(32)} ${c.padEnd(15)} ${d.padEnd(20)} ${e.padStart(8)}`
  const lines = [row('Version', 'Description', 'State', 'Ran on', 'Took')]
  for (const i of infos) {
    const state = i.state.replaceAll('_', '') + (i.checksum_mismatch ? ' (changed!)' : '')
    lines.push(row(i.version ?? '(repeatable)', truncate(i.description, 32), state, i.installed_on ?? '', i.execution_time_ms === null ? '' : `${i.execution_time_ms} ms`))
  }
  return lines.join('\n').trimEnd()
}

/** liftoff.toml with Flyway-style overrides. With `-url` and no liftoff.toml, a project is made up on the spot, as the Flyway CLI works without a config file. */
function load(ctx: Ctx): Config {
  const a = ctx.adhoc
  let url: string | undefined
  if (a.url !== undefined) {
    url = flyway.jdbcToUrl(a.url) ?? (a.url.startsWith('postgres') || isSqlServerUrl(a.url) ? a.url : undefined)
    if (url === undefined) throw configError(`-url=${a.url}: LiftOff supports PostgreSQL and SQL Server`)
  }
  let cfg: Config
  if (url !== undefined && !fs.existsSync(path.join(ctx.root, PROJECT_FILE))) {
    cfg = Config.adhoc(ctx.root, a.locations ?? 'sql')
    if (isSqlServerUrl(url)) {
      cfg.project.engine = 'sqlserver'
      cfg.project.schemas = ['dbo']
    }
  } else {
    cfg = Config.load(ctx.root)
  }
  if (a.locations !== undefined) cfg.project.migrations = a.locations
  if (a.schemas !== undefined) cfg.project.schemas = a.schemas
  if (a.defaultSchema !== undefined) cfg.project.schemas = [a.defaultSchema, ...cfg.project.schemas.filter((s) => s !== a.defaultSchema)]
  if (!cfg.project.schemas.length) cfg.project.schemas.push(defaultSchema(cfg.project.engine))
  if (a.table !== undefined) {
    if (a.table.toLowerCase().includes('flyway')) {
      throw configError(`-table=${a.table} is Flyway's history table; LiftOff keeps its own. Import it once with \`liftoff import-flyway-history --table ${a.table}\``)
    }
    cfg.project.history_table = a.table
  }
  if (url !== undefined) {
    const name = ctx.env ?? 'default'
    const old = cfg.environments.get(name)
    const env: Environment = {
      url,
      user: a.user ?? old?.user,
      password: a.password ?? old?.password,
      role: old?.role ?? 'test',
      allow_clean: a.allowClean || !!old?.allow_clean,
      placeholders: { ...old?.placeholders },
    }
    cfg.environments.set(name, env)
  }
  for (const e of cfg.environments.values()) Object.assign(e.placeholders, Object.fromEntries(ctx.placeholders))
  return cfg
}

const COMMANDS: Record<string, Command> = {
  init: {
    help: 'Create liftoff.toml, migrations/ and schema-model/ in the project folder',
    options: {
      name: { type: 'string', help: 'Project name (default: the folder name)' },
      engine: { type: 'string', default: 'postgresql', help: 'postgresql or sqlserver' },
      'from-flyway': { type: 'boolean', help: "Convert the folder's flyway.toml or flyway.conf instead of starting empty (the originals stay)" },
      'flyway-config': { type: 'string', help: 'With --from-flyway: which Flyway config file, when the folder has more than one', value: 'FILE' },
      include: { type: 'string', multiple: true, help: 'With --from-flyway: only this environment (repeatable; default: all)', value: 'NAME' },
      role: { type: 'string', multiple: true, help: 'With --from-flyway: the role for an environment, e.g. live=prod (repeatable)', value: 'NAME=ROLE' },
      preview: { type: 'boolean', help: 'With --from-flyway: show what would be converted, and write nothing' },
      sample: { type: 'boolean', help: 'Start from a small sample shop project (an empty folder only)' },
    },
    async run(ctx, v) {
      const name = str(v, 'name') ?? path.basename(fs.realpathSync(ctx.root)) ?? 'project'
      if (flag(v, 'from-flyway')) {
        const roles: Record<string, Role> = {}
        for (const r of (v.role as string[] | undefined) ?? []) {
          const [env, role] = r.split('=')
          if (!env || !['dev', 'scratch', 'test', 'prod'].includes(role)) throw new UsageError(`--role ${r}: use NAME=ROLE, with a role of dev, scratch, test or prod`)
          roles[env] = role as Role
        }
        const r = flyway.convert(ctx.root, name, undefined, {
          source: str(v, 'flyway-config'),
          only: v.include as string[] | undefined,
          roles,
          preview: flag(v, 'preview'),
        })
        const envs = r.planned.map((e) => `    ${e.name.padEnd(16)} ${e.role.padEnd(8)} ${e.url}${e.skipped ? '   (left out)' : ''}`)
        if (r.preview) {
          const text = [
            `Would convert ${r.source} (nothing written):`,
            `  migrations: ${r.migrations}   schemas: ${r.schemas.join(', ')}   Flyway history table: ${r.flyway_table}`,
            '  environments:',
            ...envs,
            ...r.notes.map((n) => `  note: ${n}`),
            ...r.not_converted.map((n) => `  not converted: ${n}`),
          ]
          return [r, text.join('\n')]
        }
        const text = [
          `Converted ${r.source} into ${r.written}`,
          `  environments: ${r.environments.length ? r.environments.join(', ') : 'none'}`,
          `  migrations: ${r.migrations}   schemas: ${r.schemas.join(', ')}`,
          ...r.notes.map((n) => `  note: ${n}`),
          ...r.not_converted.map((n) => `  not converted: ${n}`),
          `Next, per database: liftoff -e <environment> import-flyway-history --table ${r.flyway_table}`,
        ]
        return [r, text.join('\n')]
      }
      if (flag(v, 'sample')) {
        createSample(ctx.root, str(v, 'engine')!)
        return [{ project: 'shop-sample', path: ctx.root }, `Created the sample project in ${ctx.root}; add an environment, then run its scripts`]
      }
      if (flyway.detect(ctx.root).length) process.stderr.write('note: this folder has a Flyway config; `liftoff init --from-flyway` converts it\n')
      init(ctx.root, name, str(v, 'engine')!)
      return [{ project: name, path: ctx.root }, `Created ${PROJECT_FILE} in ${ctx.root}`]
    },
  },
  'import-flyway-history': {
    help: "Copy an environment's Flyway history into LiftOff's history table, once",
    options: {
      table: { type: 'string', default: flyway.DEFAULT_TABLE, help: "Flyway's history table" },
      'accept-edited': { type: 'boolean', help: "Import even if applied scripts changed since they ran (stores the current files' checksums)" },
    },
    async run(ctx, v) {
      const r = await flyway.importHistory(load(ctx), ctx.env, str(v, 'table')!, flag(v, 'accept-edited'), log)
      const text = [
        `Imported ${r.imported} row(s) on ${r.environment}`,
        ...r.skipped.map((s) => `  skipped: ${s}`),
        ...r.edited.map((s) => `  accepted edit: ${s}`),
        ...r.attention.map((s) => `  needs attention: ${s}`),
      ]
      return [r, text.join('\n')]
    },
  },
  settings: {
    help: 'Show every project setting and environment as written in the files (passwords left out). With --save, apply changes read as JSON from stdin',
    options: {
      save: { type: 'boolean', help: 'Read {"project": {...}, "environments": [...], "remove": [...]} from stdin and save it; passwords go to the keychain or liftoff.user.toml' },
    },
    async run(ctx, v) {
      if (!flag(v, 'save')) {
        const s = readSettings(ctx.root)
        const text = [
          `${s.project.name} (${s.project.engine}, scripts in ${s.project.migrations}, schemas ${s.project.schemas.join(', ')})`,
          ...s.environments.map((e) => `${e.name.padEnd(16)} ${e.role.padEnd(8)} ${e.url}${e.shared ? '' : '   (this computer only)'}`),
        ]
        return [s, text.join('\n')]
      }
      // Passwords come in on stdin, never as arguments (other programs can read a process's arguments).
      let change: SettingsChange
      try {
        change = JSON.parse(fs.readFileSync(0, 'utf8')) as SettingsChange
      } catch (e) {
        throw new UsageError(`settings --save reads JSON from stdin: ${e instanceof Error ? e.message : String(e)}`)
      }
      const s = saveSettings(ctx.root, change)
      return [s, `Saved the settings of ${s.project.name}`]
    },
  },
  project: {
    help: 'Show the project and its environments: name, role and engine (no connection details)',
    async run(ctx) {
      const cfg = load(ctx)
      const list = [...cfg.environments].map(([name, e]) => ({ allow_clean: e.allow_clean, engine: engineOf(e.url), name, role: e.role }))
      const p = cfg.project
      const text = list.map((e) => `${e.name.padEnd(16)} ${e.role.padEnd(8)} ${e.engine}`).join('\n')
      return [{ engine: p.engine, environments: list, migrations: p.migrations, name: p.name, schemas: p.schemas }, `${p.name} (${p.engine}, scripts in ${p.migrations})\n${text}`]
    },
  },
  'test-connection': {
    help: 'Check that an environment is reachable',
    aliases: ['testConnection'],
    async run(ctx) {
      const [name, env] = load(ctx).pick(ctx.env)
      const c = await open(name, env)
      try {
        const s = await c.serverInfo()
        return [s, `Connected to ${name}: ${s.database} as ${s.user} (${c.engine} ${s.version})`]
      } finally {
        await c.close()
      }
    },
  },
  info: {
    help: 'List every migration and its state on the environment',
    async run(ctx) {
      const infos = await runner.info(load(ctx), ctx.env)
      return [infos, infoTable(infos)]
    },
  },
  migrate: {
    help: 'Run pending migrations',
    options: {
      'out-of-order': { type: 'boolean', help: 'Also run scripts older than the latest applied version' },
      target: { type: 'string', help: 'Stop after this version' },
      'dry-run': { type: 'boolean', help: 'Print the SQL that would run instead of running it' },
      'allow-non-empty': { type: 'boolean', help: 'Run every script on a database that has tables but no history (normally refused)' },
      'rerun-repeatables': { type: 'boolean', help: 'Also re-run repeatable scripts that have not changed' },
    },
    async run(ctx, v) {
      const cfg = load(ctx)
      const r = await runner.migrate(
        cfg,
        ctx.env,
        { outOfOrder: flag(v, 'out-of-order'), target: str(v, 'target'), dryRun: flag(v, 'dry-run'), allowNonEmpty: flag(v, 'allow-non-empty'), rerunRepeatables: flag(v, 'rerun-repeatables') },
        log,
      )
      return [r, r.dry_run_sql ?? `Applied ${r.applied.length} migration(s) to ${r.environment} in ${r.execution_time_ms} ms`]
    },
  },
  undo: {
    help: 'Undo the latest applied migration with its U script',
    async run(ctx) {
      const cfg = load(ctx)
      return [await runner.undo(cfg, ctx.env, log), '']
    },
  },
  check: {
    help: 'Pre-deploy checks: drift, what the pending scripts change, and the dry-run script. With no flags, runs all three. Exits 13 when drift is found.',
    options: {
      drift: { type: 'boolean', help: 'Compare the environment with what its applied scripts build' },
      changes: { type: 'boolean', help: 'What the pending scripts will change' },
      'dry-run': { type: 'boolean', help: 'The SQL that would run' },
      scratch: { type: 'string', help: 'Scratch environment rebuilt for the comparison (default: the first with role "scratch")' },
      report: { type: 'string', help: 'Also write a self-contained HTML report to this file', value: 'FILE' },
      model: { type: 'boolean', help: 'Instead: fail (exit 14) when the schema model has changes no migration script makes; for pull requests' },
    },
    async run(ctx, v) {
      const cfg = load(ctx)
      if (flag(v, 'model')) {
        const cmp = await model.versusMigrations(cfg, str(v, 'scratch'), log)
        const text = cmp.changes.map((c) => `  ${kindOf(c)} ${c.name}${c.destructive ? '  (may lose data)' : ''}`).join('\n')
        if (!cmp.changes.length) return [cmp, 'The migration scripts cover the schema model']
        const err = modelAheadError(cmp.changes.map((c) => c.name))
        process.stdout.write(ctx.json ? `${JSON.stringify({ ok: false, result: cmp, error: err.report() })}\n` : `Not covered by a migration script:\n${text}\n`)
        throw new Reported(err)
      }
      const all = !(flag(v, 'drift') || flag(v, 'changes') || flag(v, 'dry-run'))
      const r = await checks.check(cfg, ctx.env, str(v, 'scratch'), { drift: all || flag(v, 'drift'), changes: all || flag(v, 'changes'), dryRun: all || flag(v, 'dry-run') }, log)
      const report = str(v, 'report')
      if (report) {
        fs.writeFileSync(report, checks.reportHtml(r, cfg.project.name, new Date().toISOString()))
        log('info', `Report written to ${report}`)
      }
      const text: string[] = []
      for (const [title, list] of [['Drift', r.drift], ['Pending changes', r.changes]] as const) {
        if (!list) continue
        text.push(`${title}: ${list.length || 'none'}`)
        text.push(...list.map((c) => `  ${kindOf(c)} ${c.name}${c.destructive ? '  (may lose data)' : ''}`))
      }
      if (r.dry_run_sql !== null) text.push(`Dry run:\n${r.dry_run_sql}`)
      if (checks.hasDrift(r)) {
        // The report is the useful part: print it, then fail with the drift exit code.
        process.stdout.write(ctx.json ? `${JSON.stringify({ ok: false, result: r, error: driftError(r.environment).report() })}\n` : `${text.join('\n')}\n`)
        throw new Reported(driftError(r.environment))
      }
      return [r, text.join('\n')]
    },
  },
  validate: {
    help: 'Check applied scripts against the files: failures, edits, missing files, out-of-order scripts',
    async run(ctx) {
      const infos = await runner.validateEnv(load(ctx), ctx.env)
      return [infos, `${infos.length} script(s) checked; no problems`]
    },
  },
  baseline: {
    help: 'Mark an existing database as already at a version, so older scripts never run there',
    options: {
      version: { type: 'string', default: '1', help: 'The version the database is at' },
      description: { type: 'string', default: 'baseline', help: 'A note for the history table' },
    },
    async run(ctx, v) {
      await runner.baseline(load(ctx), ctx.env, str(v, 'version')!, str(v, 'description')!, log)
      return [{ baseline: str(v, 'version') }, '']
    },
  },
  repair: {
    help: 'Remove failed runs, accept edited scripts, forget scripts whose files were deleted',
    async run(ctx) {
      return [await runner.repair(load(ctx), ctx.env, log), '']
    },
  },
  clean: {
    help: "Erase every object in the project's schemas (only where allow_clean = true, or a scratch database)",
    async run(ctx) {
      return [{ cleaned: await runner.clean(load(ctx), ctx.env, log) }, '']
    },
  },
  'mark-applied': {
    help: 'Record a pending script as applied without running it (the dev database it was written from)',
    positional: { name: 'SCRIPT', help: 'File name in the migrations folder, e.g. V20261008.1104__add_customers.sql' },
    async run(ctx, _v, script) {
      if (!script) throw configError('name the script to record, e.g. liftoff mark-applied V20261008.1104__add_customers.sql')
      await runner.markApplied(load(ctx), ctx.env, script, log)
      return [{ recorded: script }, '']
    },
  },
  add: {
    help: 'Create the next migration file to write by hand',
    options: {
      description: { type: 'string', help: 'What the script does (required)' },
      repeatable: { type: 'boolean', help: 'A repeatable script (R__), run again whenever it changes' },
      'from-file': { type: 'string', help: 'Read the SQL from this file instead of starting empty', value: 'FILE' },
    },
    async run(ctx, v) {
      const description = str(v, 'description')
      if (description === undefined) throw configError('--description is required')
      const from = str(v, 'from-file')
      const written = diff.add(load(ctx), flag(v, 'repeatable'), description, from ? fs.readFileSync(from, 'utf8') : '')
      return [{ written }, `Created ${written}`]
    },
  },
  capture: {
    help: 'Write the whole schema of an existing database as the next migration',
    options: {
      description: { type: 'string', default: 'existing schema', help: 'Description in the file name' },
      'dry-run': { type: 'boolean', help: 'Print the script instead of writing it' },
      'as-baseline-script': { type: 'boolean', help: 'Write a baseline script (B…) that empty databases start from, instead of a V script' },
    },
    async run(ctx, v) {
      const cfg = load(ctx)
      const g = await diff.capture(cfg, ctx.env, str(v, 'description')!, flag(v, 'as-baseline-script'))
      if (flag(v, 'dry-run')) return [g, g.sql]
      const written = diff.save(cfg, g.file_name, g.sql)
      return [
        { written, version: g.version },
        `Wrote ${written}\nThe database it came from already has this schema: run \`liftoff baseline --version ${g.version}\` on it so the script never runs there.`,
      ]
    },
  },
  squash: {
    help: 'Squash the versioned scripts into one baseline script (B…) that empty databases start from',
    options: {
      'up-to': { type: 'string', help: 'Last version to include (default: all of them)' },
      description: { type: 'string', default: 'squashed', help: 'Description in the file name' },
      scratch: { type: 'string', help: 'Scratch environment to build in (default: the first with role "scratch")' },
      'dry-run': { type: 'boolean', help: 'Print the script instead of writing it' },
    },
    async run(ctx, v) {
      const cfg = load(ctx)
      const { generated: g, path: written } = await diff.squash(cfg, str(v, 'up-to'), str(v, 'description')!, str(v, 'scratch'), flag(v, 'dry-run'), log)
      if (!written) return [g, g.sql]
      return [{ written, version: g.version }, `Wrote ${written} and checked it builds the same schema.\nDatabases with history are not affected; empty ones now start from it.`]
    },
  },
  model: {
    help: 'Bring the schema-model folder up to date with dev: one file per object. With --check, build the folder on the scratch database instead',
    options: {
      source: { type: 'string', help: 'Dev environment (default: the first with role "dev")' },
      status: { type: 'boolean', help: 'List what differs instead of writing' },
      path: { type: 'string', multiple: true, help: 'Only this object file, e.g. public/tables/orders.sql (repeatable)', value: 'FILE' },
      check: { type: 'boolean', help: 'Check the schema model builds (on the scratch database); exits 12 naming each file that does not' },
      scratch: { type: 'string', help: 'Scratch environment for --check (default: the first with role "scratch")' },
    },
    async run(ctx, v) {
      const cfg = load(ctx)
      if (flag(v, 'check')) {
        const n = await model.check(cfg, str(v, 'scratch'), log)
        return [{ files: n }, `The schema model builds: ${n} object file(s)`]
      }
      const changes = model.pick(await model.status(cfg, str(v, 'source')), v.path as string[] | undefined)
      const list = changes.map((c) => `${kindOf(c)} ${c.path}`).join('\n')
      if (flag(v, 'status')) return [changes, list || 'The schema model is up to date']
      const n = model.save(cfg, changes)
      return [{ written: n }, n === 0 ? 'The schema model is up to date' : `${list}\nUpdated ${n} file(s) in ${model.FOLDER}`]
    },
  },
  ci: {
    help: 'Write a CI workflow that runs the migrations',
    options: {
      stage: { type: 'string', multiple: true, help: 'Environments to deploy to, in order (repeat the flag; required)' },
      branch: { type: 'string', default: 'main', help: 'The branch whose pushes deploy' },
      'no-checks': { type: 'boolean', help: 'Leave out validate and the drift check' },
      model: { type: 'string', default: 'off', help: 'Pull requests and the schema model: off, check (fail when a model change has no migration script) or generate (write it and commit it to the pull request)' },
      install: { type: 'string', default: ci.DEFAULT_INSTALL, help: 'Command that installs liftoff on the runner' },
      write: { type: 'boolean', help: 'Write .github/workflows/liftoff.yml (otherwise print it)' },
      force: { type: 'boolean', help: 'Replace an existing workflow file' },
    },
    async run(ctx, v) {
      const cfg = load(ctx)
      const stages = (v.stage as string[] | undefined) ?? []
      if (!stages.length) throw configError('--stage is required: name the environments to deploy to, in order')
      const m = str(v, 'model')
      if (m !== 'off' && m !== 'check' && m !== 'generate') throw new UsageError(`--model must be off, check or generate, not '${m}'`)
      const yaml = ci.githubActions(cfg, { stages, branch: str(v, 'branch')!, checks: !flag(v, 'no-checks'), install: str(v, 'install')!, model: m })
      if (flag(v, 'write')) {
        const written = ci.write(cfg, yaml, flag(v, 'force'))
        return [{ written }, `Wrote ${written}`]
      }
      return [{ yaml }, yaml]
    },
  },
  'create-scratch': {
    help: 'Create an empty scratch database next to the dev database and save it as an environment',
    options: {
      from: { type: 'string', help: 'Dev environment (default: the first with role "dev")' },
      name: { type: 'string', default: 'scratch', help: 'Name for the new environment' },
    },
    async run(ctx, v) {
      const r = await diff.createScratch(load(ctx), str(v, 'from'), str(v, 'name')!)
      return [r, `Created database ${r.database} and saved it as environment '${r.environment}' (role scratch, private)`]
    },
  },
  diff: {
    help: 'Compare the dev database (or the schema model) with what the migrations build',
    options: {
      from: { type: 'string', default: 'dev', help: 'dev (the dev database) or model (the schema-model folder; no dev database needed)' },
      source: { type: 'string', help: 'Dev environment (default: the first with role "dev")' },
      scratch: { type: 'string', help: 'Scratch environment rebuilt for the comparison (default: the first with role "scratch")' },
    },
    async run(ctx, v) {
      const cfg = load(ctx)
      const cmp = await compareFrom(cfg, v)
      const text = cmp.changes.map((c) => `${kindOf(c)} ${c.name}${c.destructive ? '  (may lose data)' : ''}`).join('\n')
      return [cmp, text || 'No differences']
    },
  },
  generate: {
    help: 'Write the next migration from the differences',
    options: {
      description: { type: 'string', help: 'What the migration does (required)' },
      from: { type: 'string', default: 'dev', help: 'dev (the dev database) or model (the schema-model folder; no dev database needed)' },
      source: { type: 'string', help: 'Dev environment (default: the first with role "dev")' },
      scratch: { type: 'string', help: 'Scratch environment (default: the first with role "scratch")' },
      'skip-destructive': { type: 'boolean', help: 'Leave out changes that may lose data (dropped tables or columns, type changes)' },
      'dry-run': { type: 'boolean', help: 'Print the script instead of writing it' },
      'record-on-dev': { type: 'boolean', help: 'Also record the new script as applied on the dev database (it already has the change)' },
      undo: { type: 'boolean', help: 'Also write the matching undo script (U…)' },
    },
    async run(ctx, v) {
      const cfg = load(ctx)
      const description = str(v, 'description')
      if (description === undefined) throw configError('--description is required')
      let changes = (await compareFrom(cfg, v)).changes
      if (flag(v, 'skip-destructive')) changes = changes.filter((c) => !c.destructive)
      else if (changes.some((c) => c.destructive)) log('warn', 'the script includes changes that may lose data; review it before running, or use --skip-destructive')
      if (!changes.length) return [{ written: null }, 'No differences; nothing written']
      const g = diff.generate(cfg, changes, description, flag(v, 'undo'))
      if (flag(v, 'dry-run')) return [g, g.sql]
      const written = diff.save(cfg, g.file_name, g.sql)
      if (g.undo) diff.save(cfg, g.undo.file_name, g.undo.sql)
      if (flag(v, 'record-on-dev') && str(v, 'from') === 'model') throw configError('--record-on-dev is for --from dev')
      if (flag(v, 'record-on-dev')) {
        const [dev] = cfg.pickRole(str(v, 'source'), 'dev')
        await runner.markApplied(cfg, dev, g.file_name, log)
      }
      return [{ written, version: g.version, changes: changes.length }, `Wrote ${written}`]
    },
  },
}

/** The report was already printed on stdout; only the message (stderr) and the exit code are left. */
class Reported extends Error {
  readonly error: LiftoffError
  constructor(error: LiftoffError) {
    super(error.message)
    this.error = error
  }
}

/** The changes from the dev database or from the schema model (--from), against the migrations. */
function compareFrom(cfg: Config, v: Values): Promise<diff.Comparison> {
  const from = str(v, 'from') ?? 'dev'
  if (from === 'model') return model.versusMigrations(cfg, str(v, 'scratch'), log)
  if (from !== 'dev') throw new UsageError(`--from must be dev or model, not '${from}'`)
  return diff.devVsMigrations(cfg, str(v, 'source'), str(v, 'scratch'), log)
}

class UsageError extends Error {}

function commandNamed(name: string): [string, Command] | undefined {
  if (COMMANDS[name]) return [name, COMMANDS[name]]
  return Object.entries(COMMANDS).find(([, c]) => c.aliases?.includes(name))
}

function optionLines(opts: Record<string, OptionSpec>): string[] {
  return Object.entries(opts).map(([name, o]) => {
    const head = `${o.short ? `-${o.short}, ` : '    '}--${name}${o.type === 'string' ? ` <${o.value ?? name.toUpperCase()}>` : ''}`
    return `  ${head.padEnd(34)} ${o.help}${o.default !== undefined ? ` [default: ${o.default}]` : ''}`
  })
}

function help(name?: string): string {
  if (name && COMMANDS[name]) {
    const c = COMMANDS[name]
    return [
      c.help,
      '',
      `Usage: liftoff ${name} [OPTIONS]${c.positional ? ` <${c.positional.name}>` : ''}`,
      ...(c.positional ? ['', 'Arguments:', `  <${c.positional.name}>  ${c.positional.help}`] : []),
      '',
      'Options:',
      ...optionLines({ ...c.options, ...GLOBAL }),
    ].join('\n')
  }
  return [
    'Database migrations: write them from your changes, run them everywhere.',
    '',
    'Usage: liftoff [OPTIONS] <COMMAND>',
    '',
    'Commands:',
    ...Object.entries(COMMANDS).map(([n, c]) => `  ${n.padEnd(22)} ${c.help.split('. ')[0]}`),
    '',
    'Options:',
    ...optionLines(GLOBAL),
    '',
    'Flyway-style options (-url=…, -user=…, -locations=filesystem:…, -schemas=…) are accepted too.',
  ].join('\n')
}

/** The command's name: the first argument that is neither an option nor an option's value. */
function findCommand(args: string[], options: Record<string, OptionSpec>): string | undefined {
  const takesValue = new Set(Object.entries(options).filter(([, o]) => o.type === 'string').flatMap(([n, o]) => [`--${n}`, ...(o.short ? [`-${o.short}`] : [])]))
  for (let i = 0; i < args.length; i++) {
    const a = args[i]
    if (a === '--') return args[i + 1]
    if (!a.startsWith('-')) return a
    if (takesValue.has(a)) i++
  }
  return undefined
}

async function main(argv: string[]): Promise<number> {
  let json = argv.includes('json') // good enough to format a usage error before parsing
  try {
    const { args, adhoc } = translate(argv)
    const name = findCommand(args, GLOBAL)
    const found = name ? commandNamed(name) : undefined
    if (name && !found) throw new UsageError(`unknown command '${name}'; run liftoff --help`)
    const spec = { ...GLOBAL, ...found?.[1].options } as ParseArgsConfig['options']
    const { values, positionals } = parseArgs({ args, options: spec, allowPositionals: true, strict: true })
    const v = values as Values
    json = v['output-type'] === 'json'
    if (v.version) {
      process.stdout.write(`liftoff ${VERSION}\n`)
      return 0
    }
    if (v.help || !found) {
      process.stdout.write(`${help(found?.[0])}\n`)
      return found || v.help ? 0 : 2
    }
    const outputType = v['output-type']
    if (outputType !== 'text' && outputType !== 'json') throw new UsageError(`--output-type must be text or json, not '${outputType}'`)
    const [, command] = found
    const extra = positionals.slice(1)
    if (extra.length > (command.positional ? 1 : 0)) throw new UsageError(`unexpected argument '${extra.at(-1)}'`)
    const placeholders = ((v.placeholder as string[] | undefined) ?? []).map((p): [string, string] => {
      const i = p.indexOf('=')
      if (i <= 0) throw new UsageError(`${p}: use NAME=VALUE`)
      return [p.slice(0, i), p.slice(i + 1)]
    })
    const ctx: Ctx = {
      root: path.resolve(str(v, 'project-dir')!),
      env: str(v, 'environment') ?? (adhoc.url !== undefined ? 'default' : undefined),
      json,
      placeholders,
      adhoc,
    }
    const [result, text] = await command.run(ctx, v, extra[0])
    if (json) process.stdout.write(`${JSON.stringify({ ok: true, result })}\n`)
    else if (text) process.stdout.write(`${text}\n`)
    return 0
  } catch (e) {
    if (e instanceof Reported) {
      process.stderr.write(`error: ${e.error.message}\n`)
      return e.error.exitCode
    }
    // Usage mistakes: exit 2, like any command line.
    if (e instanceof UsageError || e instanceof FlywayArgError || (e as { code?: string }).code?.startsWith('ERR_PARSE_ARGS')) {
      process.stderr.write(`error: ${(e as Error).message}\n`)
      return 2
    }
    const err: LiftoffError = asLiftoffError(e)
    if (json) process.stdout.write(`${JSON.stringify({ ok: false, error: err.report() })}\n`)
    else process.stderr.write(`error: ${err.message}\n`)
    return err.exitCode
  }
}

void main(process.argv.slice(2)).then((code) => {
  process.exitCode = code
})
