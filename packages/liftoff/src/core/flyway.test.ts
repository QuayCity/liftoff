import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { test } from 'node:test'
import { Config, PROJECT_FILE, USER_FILE } from './config.ts'
import { convert, interpolateFlyway, jdbcToUrl } from './flyway.ts'

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'lo-fw-'))

test('JDBC URLs', () => {
  assert.equal(jdbcToUrl('jdbc:postgresql://db:5432/shop?ssl=true'), 'postgres://db:5432/shop?ssl=true')
  assert.equal(jdbcToUrl('jdbc:sqlserver://db;databaseName=x'), 'sqlserver://db;databaseName=x')
  assert.equal(jdbcToUrl('jdbc:mysql://db:3306/x?useSSL=false'), 'mysql://db:3306/x')
  assert.equal(jdbcToUrl('jdbc:oracle:thin:@//db:1521/SHOP'), 'jdbc:oracle:thin:@//db:1521/SHOP')
})

test('environment variables in Flyway settings', () => {
  assert.equal(interpolateFlyway('${env.DB_PW}'), '${env.DB_PW}')
  assert.equal(interpolateFlyway('pre-${DB_USER}-x'), 'pre-${env.DB_USER}-x')
})

test('converts a SQL Server flyway.conf', () => {
  const dir = tmp()
  fs.writeFileSync(path.join(dir, 'flyway.conf'), 'flyway.url=jdbc:sqlserver://db:1433;databaseName=shop;encrypt=true\nflyway.user=app\nflyway.locations=filesystem:sql\n')
  const r = convert(dir, 'shop', false)
  assert.deepEqual(r.schemas, ['dbo'])
  const cfg = Config.load(dir)
  assert.equal(cfg.project.engine, 'sqlserver')
  assert.equal(cfg.env('default').url, 'sqlserver://db:1433;databaseName=shop;encrypt=true')
})

test('converts flyway.conf, then flyway.toml', () => {
  const dir = tmp()
  fs.writeFileSync(
    path.join(dir, 'flyway.conf'),
    '# legacy\nflyway.url=jdbc:postgresql://localhost:5432/shop\nflyway.user=app\nflyway.password=${DB_PW}\n' +
      'flyway.schemas=sales,public\nflyway.locations=filesystem:db/migration,classpath:db/extra\n' +
      'flyway.placeholders.owner=app\nflyway.table=schema_version\nflyway.cleanDisabled=false\n',
  )
  const r = convert(dir, 'shop', false)
  assert.deepEqual([r.migrations, r.schemas, r.flyway_table], ['db/migration', ['sales', 'public'], 'schema_version'])
  assert.deepEqual(r.environments, ['default'])
  assert.ok(!r.not_converted.some((n) => n.includes('placeholders')), JSON.stringify(r.not_converted))
  assert.equal(Config.load(dir).project.placeholders.owner, 'app')
  assert.deepEqual(Config.load(dir).project.filters, [{ action: 'exclude', object: 'table', pattern: 'schema_version' }], 'the Flyway history table is not compared')
  assert.ok(r.not_converted.some((n) => n.includes('classpath:db/extra')))
  const shared = fs.readFileSync(path.join(dir, PROJECT_FILE), 'utf8')
  assert.ok(shared.includes('postgres://localhost:5432/shop') && !shared.includes('DB_PW'), shared)
  assert.ok(fs.readFileSync(path.join(dir, USER_FILE), 'utf8').includes('${env.DB_PW}'), 'the password placeholder goes to the private file')
  assert.throws(() => convert(dir, 'shop', false), /already exists/, 'never overwrites liftoff.toml')

  fs.rmSync(path.join(dir, PROJECT_FILE))
  fs.rmSync(path.join(dir, USER_FILE))
  fs.writeFileSync(
    path.join(dir, 'flyway.toml'),
    '[environments.development]\nurl = "jdbc:postgresql://localhost/shop_dev"\n' +
      '[environments.shadow]\nurl = "jdbc:postgresql://localhost/shop_shadow"\n' +
      '[environments.production]\nurl = "jdbc:postgresql://prod/shop"\nuser = "deploy"\n' +
      '[flyway]\nlocations = ["filesystem:migrations"]\nschemas = ["public"]\n' +
      '[flywayDesktop]\ndevelopmentEnvironment = "development"\nshadowEnvironment = "shadow"\n',
  )
  const r2 = convert(dir, 'shop', false)
  assert.ok(r2.notes.some((n) => n.includes('flyway.conf was also found')), JSON.stringify(r2.notes))
  const cfg = Config.load(dir)
  assert.equal(cfg.project.migrations, 'migrations')
  assert.deepEqual(cfg.project.filters.map((f) => f.pattern), ['flyway_schema_history'])
  assert.deepEqual(['development', 'shadow', 'production'].map((e) => cfg.env(e).role), ['dev', 'scratch', 'prod'])
})

test('a preview writes nothing; the chosen environments and roles are used', () => {
  const dir = tmp()
  fs.mkdirSync(path.join(dir, 'conf'))
  fs.writeFileSync(
    path.join(dir, 'flyway.toml'),
    '[environments.development]\nurl = "jdbc:postgresql://db/dev"\nuser = "app"\npassword = "secret"\n\n' +
      '[environments.qa]\nurl = "jdbc:postgresql://db/qa"\n\n[environments.live]\nurl = "jdbc:postgresql://db/live"\n\n' +
      '[flyway]\nlocations = ["filesystem:sql"]\n',
  )
  fs.writeFileSync(path.join(dir, 'conf/flyway.conf'), 'flyway.url=jdbc:postgresql://other/db\n')

  const preview = convert(dir, 'shop', false, { preview: true })
  assert.equal(preview.preview, true)
  assert.ok(!fs.existsSync(path.join(dir, PROJECT_FILE)), 'nothing written')
  assert.deepEqual(preview.sources.map((f) => path.relative(dir, f)).sort(), [path.join('conf', 'flyway.conf'), 'flyway.toml'])
  assert.deepEqual(preview.planned.map((p) => [p.name, p.role, p.has_password]), [['development', 'dev', true], ['live', 'test', false], ['qa', 'test', false]])
  assert.ok(!JSON.stringify(preview).includes('secret'), 'no password in the preview')

  // The other config file, by choice.
  assert.deepEqual(convert(dir, 'shop', false, { preview: true, source: 'conf/flyway.conf' }).planned.map((p) => p.name), ['default'])
  assert.throws(() => convert(dir, 'shop', false, { preview: true, source: 'nope.conf' }), /not one of the Flyway config files/)
  assert.throws(() => convert(dir, 'shop', false, { preview: true, only: ['staging'] }), /no environment 'staging'/)

  const r = convert(dir, 'shop', false, { only: ['development', 'live'], roles: { live: 'prod' } })
  assert.deepEqual(r.environments, ['development', 'live'])
  const cfg = Config.load(dir)
  assert.deepEqual([...cfg.environments.keys()].sort(), ['development', 'live'])
  assert.equal(cfg.env('live').role, 'prod')
})
