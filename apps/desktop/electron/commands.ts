// The desktop app's commands: each maps to one core function and returns the same JSON shape as
// `liftoff --output-type json`. The screens call them through src/api.ts.

import * as fs from 'node:fs'
import * as path from 'node:path'
import * as checks from '../../../packages/liftoff/src/core/checks.ts'
import * as ci from '../../../packages/liftoff/src/core/ci.ts'
import { Config, init, interpolate, PROJECT_FILE, readSettings, redactUrl, saveProject, saveSettings, type Environment, type Project, type Role } from '../../../packages/liftoff/src/core/config.ts'
import { open } from '../../../packages/liftoff/src/core/db.ts'
import * as diff from '../../../packages/liftoff/src/core/diff.ts'
import { LiftoffError } from '../../../packages/liftoff/src/core/errors.ts'
import * as flyway from '../../../packages/liftoff/src/core/flyway.ts'
import * as git from '../../../packages/liftoff/src/core/git.ts'
import { scan } from '../../../packages/liftoff/src/core/migration.ts'
import * as model from '../../../packages/liftoff/src/core/model.ts'
import * as runner from '../../../packages/liftoff/src/core/runner.ts'
import { createSample } from '../../../packages/liftoff/src/core/sample.ts'

/** What a command gets besides its arguments. */
export type Host = {
  /** where recent.json lives */
  configDir: string
  /** sends a progress line to the window */
  log: runner.Log
}

type Args = Record<string, unknown>


/**
 * A project as the screens see it: no passwords. Environments are shown as written in the files
 * (`${env.X}` kept), so editing one and saving it back keeps what was there.
 */
function view(cfg: Config) {
  const written = new Map(readSettings(cfg.root).environments.map((e) => [e.name, e]))
  return {
    root: cfg.root,
    name: cfg.project.name,
    engine: cfg.project.engine,
    schemas: cfg.project.schemas,
    migrations: cfg.project.migrations,
    history_table: cfg.project.history_table,
    filters: cfg.project.filters,
    lock: cfg.project.lock,
    environments: [...cfg.environments].map(([name, e]) => {
      const w = written.get(name)
      // Not in the files: the environment comes from LIFTOFF_ENV_<NAME>_* variables only.
      if (!w) return { name, role: e.role, url: redactUrl(e.url), user: e.user ?? null, has_password: e.password !== undefined || redactUrl(e.url) !== e.url, allow_clean: e.allow_clean, shared: false }
      return { name, role: w.role, url: w.url, user: w.user, has_password: w.has_password, allow_clean: w.allow_clean, shared: w.shared }
    }),
  }
}

const load = (p: unknown) => Config.load(String(p))
const s = (a: Args, k: string) => a[k] as string
const b = (a: Args, k: string) => a[k] === true

/* ---------- recent projects: one JSON file in the app's config folder ---------- */

type Recent = { name: string; path: string; exists: boolean }

const recentFile = (h: Host) => path.join(h.configDir, 'recent.json')

function readRecent(h: Host): Recent[] {
  try {
    return JSON.parse(fs.readFileSync(recentFile(h), 'utf8')) as Recent[]
  } catch {
    return []
  }
}

function writeRecent(h: Host, list: Recent[]): void {
  fs.mkdirSync(h.configDir, { recursive: true })
  fs.writeFileSync(recentFile(h), JSON.stringify(list, null, 2))
}

function remember(h: Host, name: string, root: string): void {
  writeRecent(h, [{ name, path: root, exists: true }, ...readRecent(h).filter((r) => r.path !== root)].slice(0, 10))
}

/** The environment as typed in the connection dialog. */
function envFromInput(e: Record<string, unknown>): Environment {
  const blank = (v: unknown) => (typeof v === 'string' && v.trim() ? v : undefined)
  return { url: String(e.url).trim(), user: blank(e.user), password: blank(e.password), role: e.role as Role, allow_clean: e.allow_clean === true, placeholders: {} }
}

/**
 * What the dialog's Test connects to. Editing a saved environment: an unchanged URL is the saved
 * one (with its password and variables), and an empty password field means the saved password.
 */
function draftToTest(root: string, name: string | undefined, typed: Environment): Environment {
  const env = { ...typed }
  if (name) {
    const cfg = Config.load(root)
    const saved = cfg.environments.get(name)
    const written = readSettings(root).environments.find((e) => e.name === name)
    if (saved && written && env.url === written.url) env.url = saved.url
    if (saved) env.password ??= saved.password
  }
  env.url = interpolate(env.url)
  if (env.user !== undefined) env.user = interpolate(env.user)
  return env
}

async function serverInfo(name: string, env: Environment) {
  const c = await open(name, env)
  try {
    return await c.serverInfo()
  } finally {
    await c.close()
  }
}

/** A thrown error the UI offers to convert the folder for. */
const flywayProject = () => new LiftoffError('LIFTOFF_FLYWAY_PROJECT', 2, 'This folder has a Flyway project. Convert its settings to open it in LiftOff.')

export const commands: Record<string, (a: Args, h: Host) => unknown> = {
  recent_projects: (_a, h) => readRecent(h).map((r) => ({ ...r, exists: fs.existsSync(path.join(r.path, PROJECT_FILE)) })),
  /** S01: the sample project, in a new liftoff-sample folder inside the chosen one. */
  sample_create: (a, h) => commands.project_open({ path: createSample(path.join(s(a, 'folder'), 'liftoff-sample')) }, h),
  recent_forget: (a, h) => writeRecent(h, readRecent(h).filter((r) => r.path !== a.path)),

  /* F01: projects and environments */
  project_init: (a, h) => {
    init(s(a, 'path'), s(a, 'name'), s(a, 'engine'))
    return commands.project_open(a, h)
  },
  project_open: (a, h) => {
    const root = s(a, 'path')
    if (!fs.existsSync(path.join(root, PROJECT_FILE)) && flyway.detect(root).length) {
      // The UI offers the conversion for this code.
      throw flywayProject()
    }
    const cfg = load(root)
    remember(h, cfg.project.name, cfg.root)
    return view(cfg)
  },
  project_convert_flyway: (a, h) => {
    const root = s(a, 'path')
    const report = flyway.convert(root, path.basename(root) || 'project')
    return { report, project: commands.project_open(a, h) }
  },
  history_import: (a, h) => flyway.importHistory(load(a.path), s(a, 'env'), s(a, 'table'), b(a, 'acceptEdited'), h.log),
  env_save: (a) => {
    const root = s(a, 'path')
    const env = envFromInput(a.env as Record<string, unknown>)
    // As in the VS Code settings: an unchanged URL keeps what is written (variables, a password in
    // it); no password typed keeps the stored one; the environment's placeholders stay.
    saveSettings(root, { environments: [{ name: s(a, 'name'), url: env.url, user: env.user ?? null, password: env.password, role: env.role, allow_clean: env.allow_clean, shared: b(a, 'shared') }] })
    return view(load(root))
  },
  env_test: (a) => {
    const cfg = load(a.path)
    return serverInfo(s(a, 'name'), cfg.env(s(a, 'name')))
  },
  /** Tests the connection dialog's values before anything is saved. */
  env_test_draft: (a) => {
    const name = a.name === undefined ? undefined : s(a, 'name')
    return serverInfo(name ?? 'new environment', a.path === undefined ? envFromInput(a.env as Record<string, unknown>) : draftToTest(s(a, 'path'), name, envFromInput(a.env as Record<string, unknown>)))
  },

  /* F04: run */
  migrations_info: (a) => runner.info(load(a.path), s(a, 'env')),
  migrate: (a, h) => runner.migrate(load(a.path), s(a, 'env'), { outOfOrder: b(a, 'outOfOrder'), allowNonEmpty: b(a, 'allowNonEmpty') }, h.log),
  validate: (a) => runner.validateEnv(load(a.path), s(a, 'env')),
  baseline: (a, h) => runner.baseline(load(a.path), s(a, 'env'), s(a, 'version'), s(a, 'description'), h.log),
  repair: (a, h) => runner.repair(load(a.path), s(a, 'env'), h.log),
  clean: (a, h) => runner.clean(load(a.path), s(a, 'env'), h.log),
  mark_applied: (a, h) => runner.markApplied(load(a.path), s(a, 'env'), s(a, 'script'), h.log),

  /* F03: changes */
  changes_diff: (a, h) => {
    const cfg = load(a.path)
    return diff.devVsMigrations(cfg, undefined, undefined, h.log)
  },
  migration_generate: (a) => {
    const cfg = load(a.path)
    return diff.generate(cfg, a.changes as diff.Comparison['changes'], s(a, 'description'), b(a, 'withUndo'))
  },
  undo: (a, h) => {
    const cfg = load(a.path)
    return runner.undo(cfg, s(a, 'env'), h.log)
  },
  check: (a, h) => {
    const cfg = load(a.path)
    return checks.check(cfg, s(a, 'env'), undefined, { drift: b(a, 'drift'), changes: b(a, 'changes'), dryRun: b(a, 'dryRun') }, h.log)
  },
  migration_save: (a) => diff.save(load(a.path), s(a, 'fileName'), s(a, 'sql')),

  /* S09: scripts */
  scripts_list: (a) =>
    scan(load(a.path).migrationsDir()).map((x) => ({ kind: x.kind, version: x.version?.text ?? null, description: x.description, file_name: x.fileName, sql: x.sql })),
  script_add: (a) => diff.add(load(a.path), b(a, 'repeatable'), s(a, 'description'), s(a, 'sql')),
  capture: (a) => {
    const cfg = load(a.path)
    return diff.capture(cfg, s(a, 'env'), s(a, 'description'), b(a, 'asBaseline'))
  },
  /** Writes the B script and checks it builds the same schema; returns its file name. */
  squash: async (a, h) => {
    const cfg = load(a.path)
    return (await diff.squash(cfg, s(a, 'upTo'), s(a, 'description'), undefined, false, h.log)).generated.file_name
  },
  /** Writes the HTML report of a check to the file the user picked. */
  report_save: (a) => fs.writeFileSync(s(a, 'file'), checks.reportHtml(a.report as checks.CheckReport, load(a.path).project.name, new Date().toISOString())),
  scratch_create: async (a) => {
    await diff.createScratch(load(a.path), undefined, 'scratch')
    return view(load(a.path))
  },

  /* S14: git */
  git_status: (a) => git.status(s(a, 'path')),
  git_diff: (a) => git.diff(s(a, 'path'), s(a, 'file')),
  git_commit: (a) => git.commit(s(a, 'path'), a.files as string[], s(a, 'message')),
  git_push: (a) => git.push(s(a, 'path')),
  git_pull: (a) => git.pull(s(a, 'path')),

  /* S05 schema model, S15/S16 settings, S17 CI */
  model_status: (a) => {
    const cfg = load(a.path)
    return model.status(cfg, undefined)
  },
  model_save: (a) => {
    const cfg = load(a.path)
    return model.save(cfg, a.changes as model.ModelChange[])
  },
  model_files: (a) => {
    const cfg = load(a.path)
    return model.listFiles(cfg)
  },
  /** S20: the commits that changed one schema-model file (path relative to schema-model/). */
  object_history: (a) => git.history(s(a, 'path'), `${model.FOLDER}/${s(a, 'file')}`),
  /** The file at a commit (its path as that commit has it, relative to the repository). */
  object_at: (a) => git.showAt(s(a, 'path'), s(a, 'sha'), s(a, 'file')),
  project_save: (a) => {
    const root = s(a, 'path')
    // Placeholders are edited in liftoff.toml, not on this screen; keep them.
    const project = { ...(a.project as Project), placeholders: load(root).project.placeholders }
    saveProject(root, project)
    return view(load(root))
  },
  ci_workflow: (a) => ci.githubActions(load(a.path), a.options as ci.CiOptions),
  ci_write: (a) => ci.write(load(a.path), s(a, 'yaml'), b(a, 'overwrite')),

}
