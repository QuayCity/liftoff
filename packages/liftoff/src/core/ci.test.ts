import assert from 'node:assert/strict'
import * as os from 'node:os'
import { test } from 'node:test'
import { DEFAULT_INSTALL, azurePipelines, fileFor, githubActions, workflow } from './ci.ts'
import { Config, type Environment, type Role } from './config.ts'

const env = (role: Role): Environment => ({ url: 'postgres://h/db', role, allow_clean: false, placeholders: {} })

test('stages run in order, with secrets from the repository', () => {
  const cfg = new Config(
    os.tmpdir(),
    { name: 'shop', engine: 'postgresql', migrations: 'migrations', schemas: ['public'], history_table: 'h', filters: [], lock: 'advisory', placeholders: {} },
    new Map([
      ['dev', env('dev')],
      ['staging', env('test')],
      ['prod-eu', env('prod')],
    ]),
  )
  const o = { stages: ['staging', 'prod-eu'], branch: 'main', checks: true, install: DEFAULT_INSTALL }
  const y = githubActions(cfg, o)
  assert.ok(y.includes('  prod-eu:\n') && y.includes('    needs: staging\n'), y)
  assert.ok(y.includes('LIFTOFF_ENV_PROD_EU_PASSWORD: ${{ secrets.LIFTOFF_ENV_PROD_EU_PASSWORD }}'), y)
  assert.ok(y.includes("run: liftoff --environment 'staging' check --drift --report checks-staging.html"), y)
  assert.ok(y.includes("paths: ['migrations/**', 'liftoff.toml']"), y)
  assert.ok(!y.includes('postgres://'), 'no connection details in the file')
  assert.ok(!y.includes('\t'), 'YAML forbids tabs for indentation')
  assert.throws(() => githubActions(cfg, { ...o, stages: ['dev'] }), /dev database/)
})

test('pull requests: the schema model job (generate and check), deployments only on push', () => {
  const cfg = new Config(
    os.tmpdir(),
    { name: 'shop', engine: 'postgresql', migrations: 'db/migrations', schemas: ['public'], history_table: 'h', filters: [], lock: 'advisory', placeholders: {} },
    new Map([['prod', env('prod')]]),
  )
  const base = { stages: ['prod'], branch: 'main', checks: false, install: DEFAULT_INSTALL }
  const gen = githubActions(cfg, { ...base, model: 'generate' })
  assert.ok(gen.includes("  pull_request:\n    paths: ['schema-model/**', 'db/migrations/**', 'liftoff.toml']"), gen)
  assert.ok(gen.includes('    permissions:\n      contents: write\n'), 'generate commits back to the pull request')
  assert.ok(gen.includes('liftoff generate --from model --scratch ci_scratch'), gen)
  assert.ok(gen.includes('git add db/migrations'), gen)
  assert.ok(gen.includes("  prod:\n    name: 'Migrate prod'\n    runs-on: ubuntu-latest\n    if: github.event_name != 'pull_request'"), 'no deployment from a pull request')
  const chk = githubActions(cfg, { ...base, model: 'check' })
  assert.ok(chk.includes('liftoff check --model --scratch ci_scratch') && !chk.includes('contents: write'), chk)
  const ms = githubActions(new Config(os.tmpdir(), { ...cfg.project, engine: 'sqlserver' }, cfg.environments), { ...base, model: 'check' })
  assert.ok(ms.includes('mcr.microsoft.com/mssql/server') && ms.includes("CREATE DATABASE scratch"), ms)
  // Every workflow checks the numbering of new scripts on pull requests; the schema model job is extra.
  const plain = githubActions(cfg, base)
  assert.ok(plain.includes("  pull_request:\n    paths: ['db/migrations/**', 'liftoff.toml']") && !plain.includes('schema-model'), plain)
  assert.ok(plain.includes('fetch-depth: 0') && plain.includes('liftoff renumber --check --after "origin/$BASE"') && plain.includes('liftoff lint --since "origin/$BASE"'), plain)
  assert.ok(plain.includes('BASE: ${{ github.base_ref }}'), 'the branch name goes in as a variable, not into the script')
  // Writing the script: renumber before committing, with the optional token that lets checks run again.
  assert.ok(gen.indexOf('liftoff renumber --after "origin/$BASE"') > gen.indexOf('liftoff generate --from model'), gen)
  assert.ok(gen.indexOf('liftoff renumber --after "origin/$BASE"') < gen.indexOf('git commit'), gen)
  assert.ok(gen.includes('token: ${{ secrets.LIFTOFF_PUSH_TOKEN || github.token }}') && gen.includes('LIFTOFF_PUSH_TOKEN (a fine-grained token'), gen)
})

test('Azure Pipelines: checks on pull requests, stages in order with mapped secrets, the scratch database by docker run', () => {
  const cfg = new Config(
    os.tmpdir(),
    { name: 'shop', engine: 'postgresql', migrations: 'db/migrations/', schemas: ['public'], history_table: 'h', filters: [], lock: 'advisory', placeholders: {} },
    new Map([
      ['staging', env('test')],
      ['prod-eu', env('prod')],
    ]),
  )
  const o = { stages: ['staging', 'prod-eu'], branch: 'main', checks: true, install: DEFAULT_INSTALL, platform: 'azure' as const }
  const y = workflow(cfg, o)
  assert.equal(y, azurePipelines(cfg, o))
  assert.equal(fileFor('azure'), 'azure-pipelines.yml')
  assert.ok(y.includes("trigger:\n  branches:\n    include: ['main']\n  paths:\n    include: ['db/migrations', 'liftoff.toml']"), y)
  assert.ok(y.includes("- stage: pull_request\n  displayName: 'Pull request checks'\n  condition: eq(variables['Build.Reason'], 'PullRequest')"), y)
  assert.ok(y.includes('liftoff renumber --check --after "origin/${BASE#refs/heads/}"') && y.includes('BASE: $(System.PullRequest.TargetBranch)'), y)
  // Deploy stages: the first does not wait for the skipped pull-request stage; the next waits for the first.
  assert.ok(y.includes('- stage: migrate_staging\n  displayName: \'Migrate staging\'\n  dependsOn: []\n'), y)
  assert.ok(y.includes('- stage: migrate_prod_eu\n  displayName: \'Migrate prod-eu\'\n  dependsOn: migrate_staging\n'), y)
  assert.ok(y.includes("    environment: 'prod-eu'\n"), y)
  assert.ok(y.includes('              LIFTOFF_ENV_PROD_EU_PASSWORD: $(LIFTOFF_ENV_PROD_EU_PASSWORD)\n'), 'secrets mapped into each step')
  assert.ok(y.includes('          - publish: checks-prod-eu.html\n'), y)
  assert.ok(!y.includes('postgres://h') && !y.includes('\t') && !y.includes('${{'), y)

  const gen = azurePipelines(cfg, { ...o, model: 'generate' })
  assert.ok(gen.includes("pr:\n  paths:\n    include: ['schema-model', 'db/migrations', 'liftoff.toml']"), gen)
  assert.ok(gen.includes('persistCredentials: true') && gen.includes('git push origin "HEAD:${SOURCE#refs/heads/}"'), gen)
  assert.ok(gen.includes('docker run -d --name scratch') && gen.includes('pg_isready -h 127.0.0.1'), gen)
  assert.ok(gen.indexOf('git checkout -B') < gen.indexOf('liftoff generate --from model') && gen.indexOf('liftoff renumber --after') < gen.indexOf('git commit'), gen)
  const ms = azurePipelines(new Config(os.tmpdir(), { ...cfg.project, engine: 'sqlserver' }, cfg.environments), { ...o, model: 'check' })
  assert.ok(ms.includes('mcr.microsoft.com/mssql/server') && ms.includes('docker exec scratch /opt/mssql-tools18/bin/sqlcmd') && ms.includes('liftoff check --model --scratch ci_scratch'), ms)
  assert.ok(!ms.includes('persistCredentials'), 'check mode writes nothing back')
})
