// The CI workflow generator (S17): a GitHub Actions workflow that runs the project's migrations,
// stage by stage. Secrets come from the repository's settings; nothing secret is written into the file.

import * as fs from 'node:fs'
import * as path from 'node:path'
import type { Config } from './config.ts'
import { configError } from './errors.ts'

export type CiOptions = {
  /** environments to deploy to, in order; each waits for the one before */
  stages: string[]
  /** the branch whose pushes deploy */
  branch: string
  /** run validate and a drift check (with an HTML report) before migrating */
  checks: boolean
  /** shell command that installs the liftoff CLI on the runner */
  install: string
  /**
   * The schema model in pull requests:
   *   off      nothing
   *   check    fail the pull request when a model change has no migration script
   *   generate write that migration script and commit it to the pull request
   */
  model?: 'off' | 'check' | 'generate'
}

/** A throwaway database for the pull-request job, per engine: the service, and the scratch URL into it. */
const SCRATCH_PASSWORD = 'Scratch-only-1'
function scratchService(engine: string): { service: string; url: string; prepare: string } {
  if (engine === 'sqlserver') {
    return {
      service:
        '    services:\n      scratch:\n        image: mcr.microsoft.com/mssql/server:2022-latest\n' +
        `        env:\n          ACCEPT_EULA: 'Y'\n          MSSQL_SA_PASSWORD: '${SCRATCH_PASSWORD}'\n        ports: ['1433:1433']\n`,
      url: `sqlserver://localhost:1433;databaseName=scratch;encrypt=true;trustServerCertificate=true;user=sa;password=${SCRATCH_PASSWORD}`,
      // SQL Server has no "create this database on start"; wait until it answers, then create it.
      prepare:
        '      - name: Create the scratch database\n        run: |\n' +
        '          for _ in $(seq 1 30); do\n' +
        `            docker exec \${{ job.services.scratch.id }} /opt/mssql-tools18/bin/sqlcmd -C -S localhost -U sa -P '${SCRATCH_PASSWORD}' -Q 'CREATE DATABASE scratch' && exit 0\n` +
        '            sleep 2\n          done\n          exit 1\n',
    }
  }
  return {
    service:
      '    services:\n      scratch:\n        image: postgres:16\n' +
      `        env:\n          POSTGRES_PASSWORD: '${SCRATCH_PASSWORD}'\n          POSTGRES_DB: scratch\n        ports: ['5432:5432']\n` +
      "        options: >-\n          --health-cmd 'pg_isready -U postgres' --health-interval 2s --health-timeout 5s --health-retries 30\n",
    url: `postgres://postgres:${SCRATCH_PASSWORD}@localhost:5432/scratch`,
    prepare: '',
  }
}

/** The pull-request job: the schema model must build, and its changes need a migration script. */
function modelJob(cfg: Config, o: CiOptions, migrations: string): string {
  const generate = o.model === 'generate'
  const sc = scratchService(cfg.project.engine)
  let y = "  schema-model:\n    name: 'Schema model'\n    if: github.event_name == 'pull_request'\n    runs-on: ubuntu-latest\n"
  if (generate) y += '    permissions:\n      contents: write\n'
  y += sc.service
  y +=
    '    env:\n' +
    `      LIFTOFF_ENV_CI_SCRATCH_URL: ${yamlStr(sc.url)}\n      LIFTOFF_ENV_CI_SCRATCH_ROLE: scratch\n`
  y += '    steps:\n      - uses: actions/checkout@v7\n'
  // To commit back, check out the pull request's own branch (pull requests from forks cannot be written to).
  if (generate) y += '        with:\n          ref: ${{ github.head_ref }}\n'
  y += `      - name: Install LiftOff\n        run: ${yamlStr(o.install)}\n`
  y += sc.prepare
  y += '      - name: The schema model builds\n        run: liftoff model --check --scratch ci_scratch\n'
  if (!generate) {
    y += '      - name: Every schema model change has a migration script\n        run: liftoff check --model --scratch ci_scratch\n'
    return y
  }
  y +=
    '      - name: Write the migration script for the schema model changes\n' +
    "        run: liftoff generate --from model --scratch ci_scratch --description 'pull request ${{ github.event.number }}'\n" +
    '      - name: Commit it to the pull request\n        run: |\n' +
    `          if [ -n "$(git status --porcelain -- ${migrations})" ]; then\n` +
    "            git config user.name 'liftoff[bot]'\n" +
    "            git config user.email 'liftoff-bot@users.noreply.github.com'\n" +
    `            git add ${migrations}\n` +
    "            git commit -m 'Migration script for the schema model changes'\n" +
    '            git push\n' +
    '          fi\n'
  return y
}

/** A placeholder: point it at wherever the single-file `liftoff` for Linux is published. */
export const DEFAULT_INSTALL = 'curl -fsSL -o liftoff https://github.com/sanderstad/liftoff/releases/latest/download/liftoff-linux-x64 && sudo install -m 755 liftoff /usr/local/bin/liftoff'

/** `LIFTOFF_ENV_<NAME>_…` as the CLI reads it. */
export const envVar = (env: string, field: string) => `LIFTOFF_ENV_${env.toUpperCase().replaceAll('-', '_')}_${field}`

const yamlStr = (s: string) => `'${s.replaceAll("'", "''")}'`

export function githubActions(cfg: Config, o: CiOptions): string {
  if (!o.stages.length) throw configError('choose at least one environment to deploy to')
  if (!o.branch.trim() || !o.install.trim()) throw configError('a branch and an install command are needed')
  for (const s of o.stages) {
    const env = cfg.env(s)
    if (env.role === 'dev' || env.role === 'scratch') throw configError(`'${s}' is a ${env.role} database; CI deploys to test and production environments`)
  }
  const migrations = cfg.project.migrations.replace(/\/+$/, '')
  const withModel = o.model === 'check' || o.model === 'generate'
  let y =
    `# Written by LiftOff. Add these repository secrets: ${o.stages.map((s) => envVar(s, 'PASSWORD')).join(', ')}\n` +
    `# (and ${o.stages.map((s) => envVar(s, 'URL')).join(', ')} if the connection URL is not in liftoff.toml).\n` +
    'name: Database migrations\n' +
    `on:\n  push:\n    branches: [${yamlStr(o.branch)}]\n    paths: [${yamlStr(`${migrations}/**`)}, 'liftoff.toml']\n` +
    (withModel ? `  pull_request:\n    paths: ['schema-model/**', ${yamlStr(`${migrations}/**`)}, 'liftoff.toml']\n` : '') +
    '  workflow_dispatch:\n' +
    // Deployments queue up; pull-request checks run side by side.
    "concurrency:\n  group: liftoff-${{ github.event_name == 'pull_request' && github.ref || 'migrations' }}\n  cancel-in-progress: false\n" +
    'jobs:\n' +
    (withModel ? modelJob(cfg, o, migrations) : '')
  let previous: string | undefined
  for (const s of o.stages) {
    const job = s.toLowerCase().replace(/[^a-z0-9]/g, '-')
    y += `  ${job}:\n    name: ${yamlStr(`Migrate ${s}`)}\n    runs-on: ubuntu-latest\n`
    if (withModel) y += "    if: github.event_name != 'pull_request'\n"
    if (previous) y += `    needs: ${previous}\n`
    // A GitHub environment of the same name holds approvals and its own secrets.
    y += `    environment: ${yamlStr(s)}\n`
    const pw = envVar(s, 'PASSWORD')
    y += `    env:\n      ${pw}: \${{ secrets.${pw} }}\n`
    y += '    steps:\n      - uses: actions/checkout@v7\n'
    y += `      - name: Install LiftOff\n        run: ${yamlStr(o.install)}\n`
    const e = yamlStr(s)
    if (o.checks) {
      y += `      - name: Validate\n        run: liftoff --environment ${e} validate\n`
      y += `      - name: Check for drift\n        run: liftoff --environment ${e} check --drift --report checks-${job}.html\n`
    }
    y += `      - name: Migrate\n        run: liftoff --environment ${e} migrate\n`
    if (o.checks) {
      y += `      - name: Keep the check report\n        if: always()\n        uses: actions/upload-artifact@v7\n        with:\n          name: checks-${job}\n          path: checks-${job}.html\n          if-no-files-found: ignore\n`
    }
    previous = job
  }
  return y
}

/** Writes .github/workflows/liftoff.yml in the project folder. */
export function write(cfg: Config, yaml: string, overwrite: boolean): string {
  const file = path.join(cfg.root, '.github', 'workflows', 'liftoff.yml')
  if (fs.existsSync(file) && !overwrite) throw configError(`${file} already exists`)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, yaml)
  return file
}
