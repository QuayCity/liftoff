import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { test } from 'node:test'
import { applyEnvVars, compares, Config, glob, init, interpolate, orderEnvironments, PROJECT_FILE, readSettings, redactUrl, saveEnvironment, saveSettings, USER_FILE, type Environment, type Project } from './config.ts'
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

test('a ${env.X} password is kept as written, in the user file, never in the keychain', () => {
  const dir = tmp()
  init(dir, 'shop', 'sqlserver')
  const env: Environment = { url: 'sqlserver://h;databaseName=db', user: 'sa', password: '${env.LO_TEST_PW}', role: 'prod', allow_clean: false, placeholders: {} }
  assert.equal(saveEnvironment(dir, 'live', env, true, true), 'user_file')
  assert.ok(fs.readFileSync(path.join(dir, USER_FILE), 'utf8').includes('password = "${env.LO_TEST_PW}"'))
  process.env.LO_TEST_PW = 'from-the-variable'
  try {
    assert.equal(Config.load(dir).env('live').password, 'from-the-variable')
  } finally {
    delete process.env.LO_TEST_PW
  }
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

test('BUG-009: a placeholder whose environment variable is not set is an error, not literal text', () => {
  const dir = tmp()
  init(dir, 'shop', 'postgresql')
  fs.appendFileSync(path.join(dir, PROJECT_FILE), '\n[project.placeholders]\nsecret = "${env.LIFTOFF_TEST_UNSET_VARIABLE}"\n\n[environments.test]\nurl = "postgres://h/db"\nrole = "test"\n')
  const cfg = Config.load(dir)
  assert.throws(() => cfg.placeholders('test'), /placeholder 'secret': environment variable LIFTOFF_TEST_UNSET_VARIABLE is not set/)
})

test('redactUrl takes passwords out of both URL styles', () => {
  assert.equal(redactUrl('postgres://app:s3cret@db:5432/shop'), 'postgres://app@db:5432/shop')
  assert.equal(redactUrl('sqlserver://db:1433;databaseName=shop;user=sa;Password=x;encrypt=true'), 'sqlserver://db:1433;databaseName=shop;user=sa;encrypt=true')
  assert.equal(redactUrl('postgres://db/shop'), 'postgres://db/shop')
})

test('settings: read as written, saved without losing variables, passwords or the file they live in', () => {
  const dir = tmp()
  init(dir, 'shop', 'postgresql')
  fs.appendFileSync(
    path.join(dir, PROJECT_FILE),
    '\n[environments.test]\nurl = "postgres://app:inline@${env.LO_DB_HOST}/shop"\nrole = "test"\n\n[environments.prod]\nurl = "postgres://db/prod"\nrole = "prod"\n',
  )
  fs.writeFileSync(path.join(dir, USER_FILE), '[environments.prod]\npassword = "in-user-file"\n\n[environments.mine]\nurl = "postgres://localhost/mine"\nrole = "dev"\n')
  process.env.LO_DB_HOST = 'expanded-host'
  try {
    const s = readSettings(dir)
    const byName = Object.fromEntries(s.environments.map((e) => [e.name, e]))
    // As written: the variable kept, the password out, where each lives.
    assert.equal(byName.test.url, 'postgres://app@${env.LO_DB_HOST}/shop')
    assert.deepEqual([byName.test.has_password, byName.prod.has_password, byName.mine.has_password], [true, true, false])
    assert.deepEqual([byName.test.shared, byName.prod.shared, byName.mine.shared], [true, true, false])
    assert.ok(!JSON.stringify(s).includes('inline') && !JSON.stringify(s).includes('in-user-file'), 'no password in what editors get')

    // Saving them back unchanged keeps everything.
    saveSettings(dir, { environments: s.environments.map((e) => ({ ...e })) }, false)
    const project = fs.readFileSync(path.join(dir, PROJECT_FILE), 'utf8')
    assert.ok(project.includes('postgres://app:inline@${env.LO_DB_HOST}/shop'), project)
    assert.ok(!project.includes('in-user-file') && !project.includes('mine'), project)
    const cfg = Config.load(dir)
    assert.equal(cfg.env('prod').password, 'in-user-file')
    assert.equal(cfg.env('test').url, 'postgres://app:inline@expanded-host/shop')

    // Project fields change; the engine does not.
    saveSettings(dir, { project: { name: 'shop2', schemas: ['public', 'sales'], lock: 'table', engine: 'sqlserver' } as never }, false)
    assert.deepEqual([Config.load(dir).project.name, Config.load(dir).project.schemas, Config.load(dir).project.lock, Config.load(dir).project.engine], ['shop2', ['public', 'sales'], 'table', 'postgresql'])

    // Make 'mine' shared and 'prod' private; remove 'test'; add one with a password.
    saveSettings(
      dir,
      {
        environments: [
          { name: 'mine', url: 'postgres://localhost/mine', role: 'dev', allow_clean: true, shared: true },
          { name: 'prod', url: 'postgres://db/prod', role: 'prod', allow_clean: false, shared: false },
          { name: 'staging', url: 'postgres://db/staging', user: 'app', password: 'pw', role: 'test', allow_clean: false },
        ],
        remove: ['test'],
      },
      false,
    )
    const after = readSettings(dir)
    assert.deepEqual(after.environments.map((e) => [e.name, e.shared, e.has_password]), [['mine', true, false], ['prod', false, true], ['staging', true, true]])
    const shared = fs.readFileSync(path.join(dir, PROJECT_FILE), 'utf8')
    assert.ok(!shared.includes('[environments.prod]') && !shared.includes('[environments.test]') && !shared.includes('pw'), shared)
    assert.equal(Config.load(dir).env('staging').password, 'pw')
    assert.equal(Config.load(dir).env('prod').password, 'in-user-file')

    // A bad entry writes nothing.
    const before = fs.readFileSync(path.join(dir, PROJECT_FILE), 'utf8')
    assert.throws(() => saveSettings(dir, { remove: ['mine'], environments: [{ name: 'bad name', url: 'x', role: 'test', allow_clean: false }] }, false), /letters, digits/)
    assert.equal(fs.readFileSync(path.join(dir, PROJECT_FILE), 'utf8'), before)
    assert.throws(() => saveSettings(dir, { remove: ['nope'] }, false), /no environment 'nope'/)
  } finally {
    delete process.env.LO_DB_HOST
  }
})

test('environment order: by order, then dev, test, prod, scratch last; new ones go after; drag and drop renumbers', () => {
  const dir = tmp()
  init(dir, 'shop', 'postgresql')
  const env = (role: Environment['role']): Environment => ({ url: 'postgres://h/db', role, allow_clean: false, placeholders: {} })
  // Written by hand without any order: the default, scratch last, not alphabetical.
  fs.appendFileSync(path.join(dir, PROJECT_FILE), '\n[environments.prod]\nurl = "postgres://h/p"\nrole = "prod"\n\n[environments.test]\nurl = "postgres://h/t"\nrole = "test"\n')
  fs.writeFileSync(path.join(dir, USER_FILE), '[environments.scratch]\nurl = "postgres://h/s"\nrole = "scratch"\n\n[environments.dev]\nurl = "postgres://h/d"\nrole = "dev"\n')
  assert.deepEqual([...Config.load(dir).environments.keys()], ['dev', 'test', 'prod', 'scratch'])

  // A new one: the others get their place first (nothing moves), the new one comes after them, scratch stays last.
  saveEnvironment(dir, 'acceptance', env('test'), true, false)
  assert.deepEqual([...Config.load(dir).environments.keys()], ['dev', 'test', 'prod', 'acceptance', 'scratch'])
  assert.deepEqual(readSettings(dir).environments.map((e) => [e.name, e.order]), [['dev', 1], ['test', 2], ['prod', 3], ['acceptance', 4], ['scratch', null]])
  assert.match(fs.readFileSync(path.join(dir, USER_FILE), 'utf8'), /\[environments\.dev\][^[]*order = 1/, 'dev is private: its order is in the user file')

  // Editing keeps the place; a second scratch database gets none either.
  saveEnvironment(dir, 'test', env('test'), true, false)
  saveEnvironment(dir, 'scratch2', env('scratch'), false, false)
  assert.deepEqual([...Config.load(dir).environments.keys()], ['dev', 'test', 'prod', 'acceptance', 'scratch', 'scratch2'])

  // Drag and drop: the new order is written, in each one's own file.
  orderEnvironments(dir, ['dev', 'acceptance', 'test', 'prod'])
  assert.deepEqual([...Config.load(dir).environments.keys()], ['dev', 'acceptance', 'test', 'prod', 'scratch', 'scratch2'])
  assert.throws(() => orderEnvironments(dir, ['nope']), /no environment 'nope'/)
  fs.appendFileSync(path.join(dir, PROJECT_FILE), '\n[environments.bad]\nurl = "postgres://h/b"\norder = 1.5\n')
  assert.throws(() => Config.load(dir), /environments\.bad\.order must be a whole number/)
})
