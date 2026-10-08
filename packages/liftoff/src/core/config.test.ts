import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { test } from 'node:test'
import { applyEnvVars, compares, Config, glob, init, interpolate, PROJECT_FILE, saveEnvironment, USER_FILE, type Environment, type Project } from './config.ts'
import { keychainDelete } from './keychain.ts'

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'lo-cfg-'))

test('globs and filters', () => {
  assert.ok(glob('audit_*', 'audit_log') && glob('a?c', 'abc') && glob('*', '') && !glob('audit_*', 'orders'))
  const p: Project = { name: 'x', engine: 'postgresql', migrations: 'm', schemas: ['public'], history_table: 'h', filters: [], lock: 'advisory', placeholders: {} }
  assert.ok(compares(p, 'table', 'public', 'audit_log'))
  p.filters = [
    { action: 'exclude', object: 'any', pattern: 'audit_*' },
    { action: 'include', object: 'table', pattern: 'public.audit_keep' },
  ]
  assert.ok(!compares(p, 'table', 'public', 'audit_log'))
  assert.ok(!compares(p, 'view', 'public', 'audit_keep'), 'include is for tables only')
  assert.ok(compares(p, 'table', 'public', 'audit_keep'), 'the last matching rule wins')
  assert.ok(compares(p, 'table', 'public', 'orders'))
})

test('interpolation and environment-variable overrides', () => {
  const get = (k: string) => (k === 'PW' ? 's3cret' : undefined)
  assert.equal(interpolate('a${env.PW}b', get), 'as3cretb')
  assert.throws(() => interpolate('${env.MISSING}', () => undefined), /MISSING is not set/)
  const env: Environment = { url: 'x', role: 'dev', allow_clean: false, placeholders: {} }
  applyEnvVars('my-db', env, (k) => (k === 'LIFTOFF_ENV_MY_DB_URL' ? 'y' : undefined))
  assert.equal(env.url, 'y')
})

test('init, load, and the password stays out of the shared file', () => {
  const dir = tmp()
  init(dir, 'shop', 'postgresql')
  assert.throws(() => init(dir, 'shop', 'postgresql'), /already exists/)
  const env: Environment = { url: 'postgres://h/db', user: 'u', password: 'pw', role: 'test', allow_clean: false, placeholders: {} }
  assert.equal(saveEnvironment(dir, 'staging', env, true, false), 'user_file')
  assert.ok(!fs.readFileSync(path.join(dir, PROJECT_FILE), 'utf8').includes('pw'), 'password leaked into the shared file')
  const cfg = Config.load(dir)
  assert.equal(cfg.env('staging').password, 'pw')
  assert.equal(cfg.pick(undefined)[0], 'staging')
  assert.ok(fs.readFileSync(path.join(dir, '.gitignore'), 'utf8').includes(USER_FILE))
  assert.equal(cfg.project.schemas[0], 'public')
})

test('SQL Server projects start in dbo; unknown engines are refused', () => {
  const dir = tmp()
  init(dir, 'shop', 'sqlserver')
  assert.deepEqual(Config.load(dir).project.schemas, ['dbo'])
  assert.throws(() => init(tmp(), 'x', 'oracle'), /not supported/)
})

test('reads a liftoff.toml written by the Rust version', () => {
  const dir = tmp()
  fs.writeFileSync(
    path.join(dir, PROJECT_FILE),
    `[project]\nname = "shop"\nengine = "postgresql"\nmigrations = "migrations"\nschemas = ["public"]\nhistory_table = "liftoff_schema_history"\nlock = "table"\n\n[[project.filters]]\naction = "exclude"\nobject = "any"\npattern = "audit_*"\n\n[project.placeholders]\nowner = "app"\n\n[environments.dev]\nurl = "postgres://localhost/shop"\nrole = "dev"\nallow_clean = false\n`,
  )
  const cfg = Config.load(dir)
  assert.equal(cfg.project.lock, 'table')
  assert.deepEqual(cfg.project.filters, [{ action: 'exclude', object: 'any', pattern: 'audit_*' }])
  assert.equal(cfg.placeholders('dev').get('owner'), 'app')
  assert.equal(cfg.placeholders('dev').get('flyway:defaultSchema'), 'public')
})

test('keychain round trip', { skip: !process.env.LIFTOFF_TEST_KEYCHAIN && 'writes to the real OS keychain; set LIFTOFF_TEST_KEYCHAIN=1' }, () => {
  const dir = tmp()
  init(dir, 'kc', 'postgresql')
  const env: Environment = { url: 'postgres://h/db', password: 'kc-secret', role: 'dev', allow_clean: false, placeholders: {} }
  assert.equal(saveEnvironment(dir, 'dev', env, false, true), 'keychain')
  assert.ok(!fs.readFileSync(path.join(dir, USER_FILE), 'utf8').includes('kc-secret'), 'password must not touch disk')
  assert.equal(Config.load(dir).env('dev').password, 'kc-secret')
  keychainDelete(dir, 'dev')
})
