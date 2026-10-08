// liftoff.toml (shared, in git) + liftoff.user.toml (per user, git-ignored) + environment variables.
// Precedence, lowest to highest: project file, user file, LIFTOFF_ENV_<NAME>_* variables.

import * as fs from 'node:fs'
import * as path from 'node:path'
import { parse, stringify } from 'smol-toml'
import { configError } from './errors.ts'
import { keychainEnabled, keychainGet, keychainSet } from './keychain.ts'

export const PROJECT_FILE = 'liftoff.toml'
export const USER_FILE = 'liftoff.user.toml'

export type Role = 'dev' | 'scratch' | 'test' | 'prod'
export type Engine = 'postgresql' | 'sqlserver'

/**
 * `advisory` (default): a PostgreSQL session advisory lock.
 * `table`: a lease row next to the history table, for connection poolers (PgBouncer transaction
 * pooling, RDS Proxy) and databases without session advisory locks (Aurora Limitless).
 */
export type LockMode = 'advisory' | 'table'

/** A comparison filter (S16). Filters run in order; the last one that matches decides. */
export type Filter = {
  action: 'include' | 'exclude'
  /** table, view, function, type, sequence, trigger, extension, or any */
  object: string
  /** glob on the name (`audit_*`), or on `schema.name` when it contains a dot */
  pattern: string
}

export type Project = {
  name: string
  engine: string
  migrations: string
  schemas: string[]
  history_table: string
  filters: Filter[]
  lock: LockMode
  /** `${name}` values for every environment; an environment's own placeholders win */
  placeholders: Record<string, string>
}

export type Environment = {
  /** `postgres://host:5432/db`, `host=… dbname=…`, or `sqlserver://host:1433;databaseName=db` */
  url: string
  user?: string
  password?: string
  role: Role
  /** `clean` and scratch rebuilds are refused unless this is true (scratch databases imply it) */
  allow_clean: boolean
  /** `${name}` values for this environment (for secrets use `${env.VAR}` as the value) */
  placeholders: Record<string, string>
}

const ROLES: Role[] = ['dev', 'scratch', 'test', 'prod']

/** `*` any run of characters, `?` one character; case-sensitive like PostgreSQL names. */
export function glob(pattern: string, text: string): boolean {
  const re = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replaceAll('*', '.*').replaceAll('?', '.')
  return new RegExp(`^${re}$`, 'su').test(text)
}

/** Whether an object takes part in comparisons. */
export function compares(project: Project, object: string, schema: string, name: string): boolean {
  let keep = true
  for (const f of project.filters) {
    const target = f.pattern.includes('.') ? `${schema}.${name}` : name
    if ((f.object === 'any' || f.object === object) && glob(f.pattern, target)) keep = f.action === 'include'
  }
  return keep
}

export class Config {
  readonly root: string
  readonly project: Project
  /** sorted by name */
  readonly environments: Map<string, Environment>

  constructor(root: string, project: Project, environments: Map<string, Environment>) {
    this.root = root
    this.project = project
    this.environments = new Map([...environments].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
  }

  static load(root: string): Config {
    const projectPath = path.join(root, PROJECT_FILE)
    if (!fs.existsSync(projectPath)) throw configError(`no ${PROJECT_FILE} in ${root}; run \`liftoff init\` first`)
    const table = readTable(projectPath)
    const userPath = path.join(root, USER_FILE)
    if (fs.existsSync(userPath)) merge(table, readTable(userPath))
    if (typeof table.project !== 'object' || table.project === null) throw configError(`${PROJECT_FILE}: missing [project]`)
    const project = toProject(table.project as Record<string, unknown>)
    const environments = new Map<string, Environment>()
    for (const [name, raw] of Object.entries((table.environments ?? {}) as Record<string, Record<string, unknown>>)) {
      const env = toEnvironment(name, raw)
      applyEnvVars(name, env, (k) => process.env[k])
      // Unset variables stay as `${env.X}` here and fail only when this environment connects,
      // so one missing variable does not stop the whole project from loading.
      for (const key of ['url', 'user', 'password'] as const) {
        const v = env[key]
        if (v !== undefined) env[key] = tryInterpolate(v)
      }
      env.password ??= keychainGet(root, name)
      environments.set(name, env)
    }
    return new Config(root, project, environments)
  }

  /** A project without liftoff.toml, for one-off CLI runs with `-url` (Flyway style). */
  static adhoc(root: string, migrations: string): Config {
    return new Config(root, defaultProject('adhoc', migrations), new Map())
  }

  env(name: string): Environment {
    const e = this.environments.get(name)
    if (!e) throw configError(`no environment '${name}'; configured: ${this.envNames()}`)
    return e
  }

  /** The named environment, or the only one when there is exactly one. */
  pick(name: string | undefined): [string, Environment] {
    if (name !== undefined) return [name, this.env(name)]
    if (this.environments.size === 1) return [...this.environments][0]
    throw configError(`pick an environment with --environment; configured: ${this.envNames()}`)
  }

  /** The first environment with the role, unless one is named. */
  pickRole(name: string | undefined, role: Role): [string, Environment] {
    if (name !== undefined) return [name, this.env(name)]
    const found = [...this.environments].find(([, e]) => e.role === role)
    if (!found) throw configError(`no environment with role '${role}'; add one or name it explicitly`)
    return found
  }

  migrationsDir(): string {
    return path.join(this.root, this.project.migrations)
  }

  historySchema(): string {
    return this.project.schemas[0]
  }

  /** Placeholder values for one environment: built-ins, then the project's, then the environment's. */
  placeholders(envName: string): Map<string, string> {
    const schema = this.historySchema()
    const table = this.project.history_table
    const m = new Map<string, string>([
      ['liftoff:environment', envName],
      ['liftoff:schema', schema],
      ['liftoff:table', table],
      // Flyway's built-in names, so imported scripts run unchanged.
      ['flyway:environment', envName],
      ['flyway:defaultSchema', schema],
      ['flyway:table', table],
    ])
    const own = this.environments.get(envName)?.placeholders ?? {}
    for (const [k, v] of [...Object.entries(this.project.placeholders), ...Object.entries(own)]) m.set(k, tryInterpolate(v))
    return m
  }

  /** Whether the project uses placeholders at all (then a missing value is an error). */
  usesPlaceholders(): boolean {
    return Object.keys(this.project.placeholders).length > 0 || [...this.environments.values()].some((e) => Object.keys(e.placeholders).length > 0)
  }

  private envNames(): string {
    return this.environments.size ? [...this.environments.keys()].join(', ') : '(none)'
  }
}

function defaultProject(name: string, migrations = 'migrations'): Project {
  return { name, engine: 'postgresql', migrations, schemas: ['public'], history_table: 'liftoff_schema_history', filters: [], lock: 'advisory', placeholders: {} }
}

const str = (v: unknown, what: string): string => {
  if (typeof v !== 'string') throw configError(`${PROJECT_FILE}: ${what} must be text`)
  return v
}

function toProject(t: Record<string, unknown>): Project {
  const p = defaultProject(str(t.name, 'project.name'))
  if (t.engine !== undefined) p.engine = str(t.engine, 'project.engine')
  if (t.migrations !== undefined) p.migrations = str(t.migrations, 'project.migrations')
  if (t.schemas !== undefined) p.schemas = (t.schemas as unknown[]).map((s) => str(s, 'project.schemas'))
  if (t.history_table !== undefined) p.history_table = str(t.history_table, 'project.history_table')
  if (t.lock !== undefined) {
    if (t.lock !== 'advisory' && t.lock !== 'table') throw configError(`${PROJECT_FILE}: lock must be "advisory" or "table"`)
    p.lock = t.lock
  }
  if (Array.isArray(t.filters)) {
    p.filters = t.filters.map((f: Record<string, unknown>) => {
      if (f.action !== 'include' && f.action !== 'exclude') throw configError(`${PROJECT_FILE}: a filter's action must be "include" or "exclude"`)
      return { action: f.action, object: f.object === undefined ? 'any' : str(f.object, 'filter object'), pattern: str(f.pattern, 'filter pattern') }
    })
  }
  if (t.placeholders !== undefined) p.placeholders = stringMap(t.placeholders, 'project.placeholders')
  return p
}

function toEnvironment(name: string, t: Record<string, unknown>): Environment {
  const role = t.role === undefined ? 'dev' : t.role
  if (!ROLES.includes(role as Role)) throw configError(`${PROJECT_FILE}: environments.${name}.role must be dev, scratch, test or prod`)
  return {
    url: str(t.url, `environments.${name}.url`),
    user: t.user === undefined ? undefined : str(t.user, `environments.${name}.user`),
    password: t.password === undefined ? undefined : str(t.password, `environments.${name}.password`),
    role: role as Role,
    allow_clean: t.allow_clean === true,
    placeholders: t.placeholders === undefined ? {} : stringMap(t.placeholders, `environments.${name}.placeholders`),
  }
}

function stringMap(v: unknown, what: string): Record<string, string> {
  return Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, x]) => [k, str(x, `${what}.${k}`)]))
}

/** Where a new project's history table goes: `public` on PostgreSQL, `dbo` on SQL Server. */
export function defaultSchema(engine: string): string {
  if (engine === 'postgresql') return 'public'
  if (engine === 'sqlserver') return 'dbo'
  throw configError(`engine '${engine}' is not supported; use postgresql or sqlserver`)
}

/** Creates liftoff.toml, migrations/ and schema-model/, and git-ignores the user file. */
export function init(root: string, name: string, engine: string): void {
  initWith(root, name, engine, 'migrations', [defaultSchema(engine)])
}

/** `init` with a given migrations folder and schemas (used when converting a Flyway project). */
export function initWith(root: string, name: string, engine: string, migrations: string, schemas: string[]): void {
  defaultSchema(engine)
  const file = path.join(root, PROJECT_FILE)
  if (fs.existsSync(file)) throw configError(`${file} already exists`)
  fs.mkdirSync(path.join(root, migrations), { recursive: true })
  fs.mkdirSync(path.join(root, 'schema-model'), { recursive: true })
  writeTable(file, { project: { name, engine, migrations, schemas, history_table: 'liftoff_schema_history' } })
  const gitignore = path.join(root, '.gitignore')
  const existing = fs.existsSync(gitignore) ? fs.readFileSync(gitignore, 'utf8') : ''
  if (!existing.split(/\r?\n/).some((l) => l.trim() === USER_FILE)) {
    fs.writeFileSync(gitignore, `${existing}${existing && !existing.endsWith('\n') ? '\n' : ''}${USER_FILE}\n`)
  }
}

/** The [project] section as written to liftoff.toml: defaults and empty values left out. */
function projectTable(p: Project): Record<string, unknown> {
  const t: Record<string, unknown> = { name: p.name, engine: p.engine, migrations: p.migrations, schemas: p.schemas, history_table: p.history_table }
  if (p.filters.length) t.filters = p.filters
  if (p.lock !== 'advisory') t.lock = p.lock
  if (Object.keys(p.placeholders).length) t.placeholders = p.placeholders
  return t
}

/** Writes the [project] section (S15), keeping the environments and anything else in the file. */
export function saveProject(root: string, project: Project): void {
  if (!project.name.trim() || !project.migrations.trim() || !project.schemas.length) {
    throw configError('a project needs a name, a migrations folder and at least one schema')
  }
  if (project.migrations.includes('..') || path.isAbsolute(project.migrations)) throw configError('the migrations folder must be inside the project folder')
  const file = path.join(root, PROJECT_FILE)
  const table = readTable(file)
  table.project = projectTable(project)
  writeTable(file, table)
}

/** Where a saved password went. */
export type PasswordStore = 'none' | 'keychain' | 'user_file'

/**
 * Writes one environment into the project file (shared) or the user file (private). A password
 * goes to the OS keychain when there is one, else to the git-ignored user file; never to the
 * shared project file.
 */
export function saveEnvironment(root: string, name: string, env: Environment, shared: boolean, useKeychain = keychainEnabled()): PasswordStore {
  if (!/^[A-Za-z0-9_-]+$/.test(name)) throw configError('environment names use letters, digits, - and _ only')
  let password = env.password
  let store: PasswordStore = 'none'
  if (password !== undefined) {
    if (useKeychain && keychainSet(root, name, password)) {
      password = undefined
      store = 'keychain'
      removeUserPassword(root, name)
    } else {
      store = 'user_file'
    }
  }
  const t: Record<string, unknown> = { url: env.url }
  if (env.user !== undefined) t.user = env.user
  if (password !== undefined && !shared) t.password = password
  t.role = env.role
  t.allow_clean = env.allow_clean
  if (Object.keys(env.placeholders).length) t.placeholders = env.placeholders

  const file = path.join(root, shared ? PROJECT_FILE : USER_FILE)
  const table = fs.existsSync(file) ? readTable(file) : {}
  const envs = (table.environments ??= {})
  if (typeof envs !== 'object' || Array.isArray(envs)) throw configError('`environments` must be a table')
  ;(envs as Record<string, unknown>)[name] = t
  writeTable(file, table)

  if (shared && password !== undefined) {
    // The secret goes next door, into the git-ignored user file.
    const userFile = path.join(root, USER_FILE)
    const user = fs.existsSync(userFile) ? readTable(userFile) : {}
    merge(user, { environments: { [name]: { password } } })
    writeTable(userFile, user)
  }
  return store
}

/** Drops a plain-text password left in the user file once the keychain holds it. */
function removeUserPassword(root: string, name: string): void {
  const file = path.join(root, USER_FILE)
  if (!fs.existsSync(file)) return
  const table = readTable(file)
  const env = (table.environments as Record<string, Record<string, unknown>> | undefined)?.[name]
  if (env && 'password' in env) {
    delete env.password
    writeTable(file, table)
  }
}

export function readTable(file: string): Record<string, unknown> {
  try {
    return parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>
  } catch (e) {
    if (e instanceof Error && 'code' in e && e.code === 'ENOENT') throw e
    throw configError(`${file}: ${e instanceof Error ? e.message : e}`)
  }
}

function writeTable(file: string, table: Record<string, unknown>): void {
  fs.writeFileSync(file, stringify(table) + '\n')
}

function merge(base: Record<string, unknown>, over: Record<string, unknown>): void {
  for (const [k, v] of Object.entries(over)) {
    const b = base[k]
    if (isTable(b) && isTable(v)) merge(b, v)
    else base[k] = v
  }
}

const isTable = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v) && !(v instanceof Date)

export function applyEnvVars(name: string, env: Environment, get: (k: string) => string | undefined): void {
  const prefix = `LIFTOFF_ENV_${name.toUpperCase().replaceAll('-', '_')}_`
  const url = get(`${prefix}URL`)
  const user = get(`${prefix}USER`)
  const password = get(`${prefix}PASSWORD`)
  if (url !== undefined) env.url = url
  if (user !== undefined) env.user = user
  if (password !== undefined) env.password = password
}

/** `${env.NAME}` resolves from environment variables; a missing one is an error. */
export function interpolate(s: string, get: (k: string) => string | undefined = (k) => process.env[k]): string {
  let out = ''
  let rest = s
  for (;;) {
    const start = rest.indexOf('${env.')
    if (start < 0) return out + rest
    out += rest.slice(0, start)
    const after = rest.slice(start + 6)
    const end = after.indexOf('}')
    if (end < 0) throw configError(`unclosed \${env.…} in '${s}'`)
    const key = after.slice(0, end)
    const v = get(key)
    if (v === undefined) throw configError(`environment variable ${key} is not set`)
    out += v
    rest = after.slice(end + 1)
  }
}

/** `interpolate`, leaving the text as it is when a variable is missing. */
function tryInterpolate(s: string): string {
  try {
    return interpolate(s)
  } catch {
    return s
  }
}
