// The CLI as a CI pipeline sees it: the real program, exit codes, one JSON object per command on
// stdout, logs on stderr, no prompts (ported from crates/cli/tests/cli.rs). Runs the TypeScript
// CLI, or any other `liftoff` program given in LIFTOFF_CLI (e.g. to compare with an older build).

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { test } from 'node:test'
import { translate } from '../src/cli/flyway-args.ts'
import { pgSchemaReset, sql } from './helpers.ts'
import { Config, init, saveEnvironment } from '../src/core/config.ts'
import { keychainDelete } from '../src/core/keychain.ts'

const base = process.env.LIFTOFF_TEST_PG
const main = path.join(import.meta.dirname, '../src/cli/main.ts')

function liftoff(dir: string, args: string[], o: { keychain?: boolean } = {}) {
  const env: NodeJS.ProcessEnv = { ...process.env, LIFTOFF_NO_KEYRING: '1' }
  if (o.keychain) delete env.LIFTOFF_NO_KEYRING
  const [cmd, pre] = process.env.LIFTOFF_CLI ? [process.env.LIFTOFF_CLI, []] : [process.execPath, [main]]
  const r = spawnSync(cmd, [...pre, ...args], { cwd: dir, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  return { code: r.status ?? -1, stdout: r.stdout, stderr: r.stderr }
}

/** In JSON mode stdout is exactly one JSON object. */
function json(r: { stdout: string; stderr: string }) {
  const lines = r.stdout.split('\n').filter((l) => l.trim())
  assert.equal(lines.length, 1, `one JSON object on stdout, got:\n${r.stdout}\nstderr:\n${r.stderr}`)
  return JSON.parse(lines[0])
}

test('Flyway-style arguments', () => {
  const a = (s: string) => s.split(' ')
  const t = translate(a('-url=jdbc:postgresql://db/shop -user=app -password=pw -schemas=sales,public -locations=filesystem:sql -target=5 -outOfOrder=true -outputType=JSON migrate'))
  assert.deepEqual(t.args, a('--output-type json migrate --target 5 --out-of-order'))
  assert.equal(t.adhoc.url, 'jdbc:postgresql://db/shop')
  assert.deepEqual(t.adhoc.schemas, ['sales', 'public'])
  assert.equal(t.adhoc.locations, 'sql')
  assert.deepEqual(translate(a('-placeholders.app_user=svc migrate')).args, a('--placeholder app_user=svc migrate'))
  assert.deepEqual(translate(a('--environment staging check -drift -dryrun')).args, a('--environment staging check --drift --dry-run'))
  assert.deepEqual(translate(a('-e dev info')).args, a('-e dev info'), 'a short LiftOff flag (-e, -C) is not a Flyway option')
  assert.throws(() => translate(a('-callbacks=db/callbacks migrate')), /does not support/)
  assert.throws(() => translate(a('-configFiles=a.conf migrate')), /--from-flyway/)
  assert.throws(() => translate(a('-locations=classpath:db migrate')))
})

test('BUG-011: a password the desktop app saved in the keychain works from the CLI', { skip: (!base || !process.env.LIFTOFF_TEST_KEYCHAIN) && 'set LIFTOFF_TEST_PG and LIFTOFF_TEST_KEYCHAIN=1' }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lo-kc-'))
  init(dir, 'kc', 'postgresql')
  const u = new URL(`${base}/shop_test`)
  const password = decodeURIComponent(u.password)
  u.password = ''
  assert.equal(saveEnvironment(dir, 'test', { url: u.toString(), password, role: 'test', allow_clean: false, placeholders: {} }, true, true), 'keychain')
  try {
    const r = liftoff(dir, ['-e', 'test', 'test-connection'], { keychain: true })
    assert.equal(r.code, 0, r.stderr)
  } finally {
    keychainDelete(dir, 'test')
  }
})

test('BUG-011: no password at all says where to put one', { skip: !base && 'set LIFTOFF_TEST_PG' }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lo-nopw-'))
  init(dir, 'nopw', 'postgresql')
  const u = new URL(`${base}/shop_test`)
  u.password = ''
  fs.appendFileSync(path.join(dir, 'liftoff.toml'), `\n[environments.test]\nurl = "${u}"\nrole = "test"\n`)
  const started = Date.now()
  const r = liftoff(dir, ['-e', 'test', 'test-connection'])
  assert.ok(Date.now() - started < 15_000, 'BUG-012: a failed connection does not keep the process alive')
  assert.equal(r.code, 10, r.stderr)
  assert.match(r.stderr, /no password for 'test'.*LIFTOFF_ENV_TEST_PASSWORD/s)
})

test('BUG-013: an unreachable server says why', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lo-down-'))
  init(dir, 'down', 'postgresql')
  fs.appendFileSync(path.join(dir, 'liftoff.toml'), '\n[environments.down]\nurl = "postgres://postgres:x@localhost:1/none"\nrole = "test"\n')
  const r = liftoff(dir, ['-e', 'down', 'test-connection'])
  assert.equal(r.code, 10, r.stderr)
  assert.match(r.stderr, /could not connect to 'down': .*(refused|ECONNREFUSED)/i)
})

test('schema model as the source: pull, check, gate and generate from the command line', { skip: !base && 'set LIFTOFF_TEST_PG' }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lo-model-'))
  init(dir, 'm', 'postgresql')
  fs.appendFileSync(path.join(dir, 'liftoff.toml'), `\n[environments.dev]\nurl = "${base}/shop_dev"\nrole = "dev"\n`)
  const dev = new Config(dir, { name: 'm', engine: 'postgresql', migrations: 'migrations', schemas: ['public'], history_table: 'liftoff_schema_history', filters: [], lock: 'advisory', placeholders: {} }, new Map([['dev', { url: `${base}/shop_dev`, role: 'dev', allow_clean: false, placeholders: {} }]]))
  await sql(dev, 'dev', `${pgSchemaReset} create table customers (id int primary key); create table orders (id int primary key, customer_id int references customers (id));`)
  // The pipeline's throwaway database exists only as variables.
  process.env.LIFTOFF_ENV_CI_SCRATCH_URL = `${base}/shop_scratch`
  process.env.LIFTOFF_ENV_CI_SCRATCH_ROLE = 'scratch'
  try {
    const run = (args: string[]) => liftoff(dir, [...args, '--output-type', 'json'])

    // Pull one object, then the rest.
    let r = run(['model', '--path', 'public/tables/customers.sql'])
    assert.equal(r.code, 0, r.stderr)
    assert.deepEqual(fs.readdirSync(path.join(dir, 'schema-model/public/tables')), ['customers.sql'])
    assert.equal(run(['model']).code, 0)
    assert.equal(run(['model', '--check']).code, 0)

    // The gate fails while no migration covers the model, and says what is missing.
    r = run(['check', '--model'])
    assert.equal(r.code, 14, r.stderr)
    const gate = json(r)
    assert.equal(gate.error.code, 'LIFTOFF_MODEL_AHEAD')
    assert.deepEqual(gate.result.changes.map((c: { id: string }) => c.id).sort(), ['table:public.customers', 'table:public.orders'])

    // Generate from the model (no dev database involved), then the gate passes.
    r = run(['generate', '--from', 'model', '--description', 'from model'])
    assert.equal(r.code, 0, r.stderr)
    assert.match(json(r).result.written, /__from_model\.sql$/)
    assert.equal(run(['check', '--model']).code, 0)

    // A broken file: exit 12, the file named in the JSON.
    fs.mkdirSync(path.join(dir, 'schema-model/public/views'), { recursive: true })
    fs.writeFileSync(path.join(dir, 'schema-model/public/views/bad.sql'), 'CREATE VIEW public.bad AS SELECT nope FROM public.orders;\n')
    r = run(['model', '--check'])
    assert.equal(r.code, 12, r.stderr)
    assert.deepEqual(json(r).error.problems.map((p: { path: string }) => p.path), ['public/views/bad.sql'])
  } finally {
    delete process.env.LIFTOFF_ENV_CI_SCRATCH_URL
    delete process.env.LIFTOFF_ENV_CI_SCRATCH_ROLE
  }
})

test('the CI contract', { skip: !base && 'set LIFTOFF_TEST_PG' }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lo-cli-'))
  const pgEnv = (db: string): Config => new Config(dir, { name: 'x', engine: 'postgresql', migrations: 'm', schemas: ['public'], history_table: 'h', filters: [], lock: 'advisory', placeholders: {} }, new Map([[db, { url: `${base}/${db}`, role: 'test', allow_clean: false, placeholders: {} }]]))
  await sql(pgEnv('shop_test'), 'shop_test', pgSchemaReset)
  await sql(pgEnv('shop_scratch'), 'shop_scratch', pgSchemaReset)

  assert.equal(liftoff(dir, ['init', '--name', 'ci']).code, 0)
  fs.appendFileSync(path.join(dir, 'liftoff.toml'), `\n[environments.test]\nurl = "${base}/shop_test"\nrole = "test"\n\n[environments.scratch]\nurl = "${base}/shop_scratch"\nrole = "scratch"\n`)
  fs.writeFileSync(path.join(dir, 'migrations/V1__orders.sql'), 'create table orders (id int primary key, note text);\n')

  // F11-H1: the pipeline, all JSON.
  let r = liftoff(dir, ['-e', 'test', 'test-connection', '--output-type', 'json'])
  assert.deepEqual([r.code, json(r).ok], [0, true], r.stderr)
  r = liftoff(dir, ['-e', 'test', 'validate', '--output-type', 'json'])
  assert.equal(r.code, 0, r.stderr)
  r = liftoff(dir, ['-e', 'test', 'migrate', '--output-type', 'json'])
  assert.equal(r.code, 0, r.stderr)
  assert.equal(json(r).result.applied.length, 1)
  assert.ok(r.stderr.includes('Running V1__orders.sql'), `logs go to stderr: ${r.stderr}`)
  r = liftoff(dir, ['-e', 'test', 'info', '--output-type', 'json'])
  assert.equal(json(r).result[0].state, 'applied')

  // F04-N2: an applied script edited afterwards blocks migrate with exit 12 and names the file.
  fs.writeFileSync(path.join(dir, 'migrations/V1__orders.sql'), 'create table orders (id int primary key, note text, x int);\n')
  r = liftoff(dir, ['-e', 'test', 'migrate'])
  assert.equal(r.code, 12, r.stderr)
  assert.ok(r.stderr.includes('V1__orders.sql changed after it was applied'), r.stderr)
  fs.writeFileSync(path.join(dir, 'migrations/V1__orders.sql'), 'create table orders (id int primary key, note text);\n')

  // F09-N1: clean is refused on a test database.
  assert.equal(liftoff(dir, ['-e', 'test', 'clean']).code, 2)

  // F11-N1 / F12-N1: unsupported Flyway options are errors, and so is writing to Flyway's table.
  assert.equal(liftoff(dir, ['-placeholders.owner=x', '-e', 'test', 'migrate']).code, 0, 'Flyway placeholders are accepted')
  r = liftoff(dir, ['-callbacks=db/callbacks', '-e', 'test', 'migrate'])
  assert.ok(r.code === 2 && r.stderr.includes('-callbacks'), r.stderr)
  r = liftoff(dir, ['-table=flyway_schema_history', '-e', 'test', 'info'])
  assert.ok(r.code === 2 && r.stderr.includes('import-flyway-history'), r.stderr)

  // F12-E2: a Flyway-style call without a project file.
  const bare = path.join(dir, 'bare')
  fs.mkdirSync(path.join(bare, 'sql'), { recursive: true })
  const url = `-url=jdbc:${base!.replace('postgres://', 'postgresql://')}/shop_test`
  r = liftoff(bare, [url, '-locations=filesystem:sql', '-outputType=json', 'info'])
  assert.equal(r.code, 0, `${r.stdout}\n${r.stderr}`)
  assert.ok(json(r).result.some((i: { script: string }) => i.script === 'V1__orders.sql'), r.stdout)

  // F08-E1: a change by hand is drift: exit 13, with the report on stdout.
  await sql(pgEnv('shop_test'), 'shop_test', 'alter table orders add column hotfix int')
  const report = path.join(dir, 'checks.html')
  r = liftoff(dir, ['-e', 'test', 'check', '--drift', '--output-type', 'json', '--report', report])
  assert.equal(r.code, 13, `${r.stdout}\n${r.stderr}`)
  const html = fs.readFileSync(report, 'utf8')
  assert.ok(html.includes('Drift (1)') && html.includes('hotfix'), html)
  const v = json(r)
  assert.equal(v.error.code, 'LIFTOFF_DRIFT')
  assert.equal(v.result.drift[0].id, 'table:public.orders')

  // F07-N2: a database with tables but no history is not migrated blindly.
  await sql(pgEnv('shop_test'), 'shop_test', `${pgSchemaReset} create table legacy (id int);`)
  r = liftoff(dir, ['-e', 'test', 'migrate', '--output-type', 'json'])
  assert.deepEqual([r.code, json(r).error.code], [12, 'LIFTOFF_NOT_BASELINED'], r.stderr)
  assert.equal(liftoff(dir, ['-e', 'test', 'migrate', '--allow-non-empty']).code, 0)
})
