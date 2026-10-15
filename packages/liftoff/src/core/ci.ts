// The CI workflow generator (S17): a GitHub Actions workflow or an Azure Pipelines file that runs the
// project's migrations, stage by stage. Secrets come from the repository's settings; nothing secret is written into the file.

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
  /** where it runs (default github) */
  platform?: Platform
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
  if (engine === 'mysql') {
    return {
      service:
        '    services:\n      scratch:\n        image: mysql:8.4\n' +
        `        env:\n          MYSQL_ROOT_PASSWORD: '${SCRATCH_PASSWORD}'\n          MYSQL_DATABASE: scratch\n        ports: ['3306:3306']\n` +
        `        options: >-\n          --health-cmd 'mysqladmin ping -h 127.0.0.1 -uroot -p${SCRATCH_PASSWORD}' --health-interval 2s --health-timeout 5s --health-retries 60\n`,
      url: `mysql://root:${SCRATCH_PASSWORD}@localhost:3306/scratch`,
      prepare: '',
    }
  }
  // SQLite: the scratch database is a file in the checkout; nothing to start.
  if (engine === 'sqlite') return { service: '', url: 'sqlite:ci_scratch.db', prepare: '' }
  if (engine === 'oracle') {
    // gvenzl's Oracle Free images (Oracle's free edition), made for CI: APP_USER is the scratch schema.
    return {
      service:
        '    services:\n      scratch:\n        image: gvenzl/oracle-free:23-slim-faststart\n' +
        `        env:\n          ORACLE_PASSWORD: '${SCRATCH_PASSWORD}'\n          APP_USER: scratch\n          APP_USER_PASSWORD: '${SCRATCH_PASSWORD}'\n        ports: ['1521:1521']\n` +
        "        options: >-\n          --health-cmd healthcheck.sh --health-interval 5s --health-timeout 5s --health-retries 60\n",
      url: `oracle://scratch:${SCRATCH_PASSWORD}@localhost:1521/FREEPDB1`,
      prepare: '',
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
/** Every pull request: the scripts it adds must be numbered after everything on the branch it goes into, and pass the rules. */
function orderJob(o: CiOptions): string {
  return (
    "  migration-order:\n    name: 'New migration scripts: order and rules'\n    if: github.event_name == 'pull_request'\n    runs-on: ubuntu-latest\n" +
    '    steps:\n      - uses: actions/checkout@v7\n        with:\n          fetch-depth: 0\n' +
    `      - name: Install LiftOff\n        run: ${yamlStr(o.install)}\n` +
    '      - name: Check the numbering\n        env:\n          BASE: ${{ github.base_ref }}\n        run: liftoff renumber --check --after "origin/$BASE"\n' +
    '      - name: The rules on the new scripts\n        env:\n          BASE: ${{ github.base_ref }}\n        run: liftoff lint --since "origin/$BASE"\n'
  )
}

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
  // To commit back, check out the pull request's own branch (pull requests from forks cannot be written to),
  // with history, so new scripts can be numbered after the base branch. A token of your own
  // (LIFTOFF_PUSH_TOKEN) makes GitHub run the checks again on the commit; its own token does not.
  if (generate) y += '        with:\n          ref: ${{ github.head_ref }}\n          fetch-depth: 0\n          token: ${{ secrets.LIFTOFF_PUSH_TOKEN || github.token }}\n'
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
    '      - name: Number the new scripts after the base branch\n        env:\n          BASE: ${{ github.base_ref }}\n        run: liftoff renumber --after "origin/$BASE"\n' +
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

/** Checks the options for any platform; returns the migrations folder without a trailing slash. */
function checked(cfg: Config, o: CiOptions): string {
  if (!o.stages.length) throw configError('choose at least one environment to deploy to')
  if (!o.branch.trim() || !o.install.trim()) throw configError('a branch and an install command are needed')
  for (const s of o.stages) {
    const env = cfg.env(s)
    if (env.role === 'dev' || env.role === 'scratch') throw configError(`'${s}' is a ${env.role} database; CI deploys to test and production environments`)
  }
  return cfg.project.migrations.replace(/\/+$/, '')
}

export function githubActions(cfg: Config, o: CiOptions): string {
  const migrations = checked(cfg, o)
  const withModel = o.model === 'check' || o.model === 'generate'
  let y =
    `# Written by LiftOff. Add these repository secrets: ${o.stages.map((s) => envVar(s, 'PASSWORD')).join(', ')}\n` +
    `# (and ${o.stages.map((s) => envVar(s, 'URL')).join(', ')} if the connection URL is not in liftoff.toml).\n` +
    '# Pull requests: make "New migration scripts: order and rules" a required check, and turn on\n' +
    '# "Require branches to be up to date before merging", so every script is numbered after what merged first.\n' +
    (o.model === 'generate'
      ? '# Optional secret LIFTOFF_PUSH_TOKEN (a fine-grained token with contents: write): with it, the checks run\n# again on the commit that adds the migration script (GitHub does not start them for its own token).\n'
      : '') +
    'name: Database migrations\n' +
    `on:\n  push:\n    branches: [${yamlStr(o.branch)}]\n    paths: [${yamlStr(`${migrations}/**`)}, 'liftoff.toml']\n` +
    `  pull_request:\n    paths: [${withModel ? "'schema-model/**', " : ''}${yamlStr(`${migrations}/**`)}, 'liftoff.toml']\n` +
    '  workflow_dispatch:\n' +
    // Deployments queue up; pull-request checks run side by side.
    "concurrency:\n  group: liftoff-${{ github.event_name == 'pull_request' && github.ref || 'migrations' }}\n  cancel-in-progress: false\n" +
    'jobs:\n' +
    orderJob(o) +
    (withModel ? modelJob(cfg, o, migrations) : '')
  let previous: string | undefined
  for (const s of o.stages) {
    const job = s.toLowerCase().replace(/[^a-z0-9]/g, '-')
    y += `  ${job}:\n    name: ${yamlStr(`Migrate ${s}`)}\n    runs-on: ubuntu-latest\n`
    y += "    if: github.event_name != 'pull_request'\n"
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

/**
 * Azure Pipelines: the same jobs as stages. Pull requests run the checks (a build validation policy on
 * Azure Repos, the `pr` trigger on GitHub); pushes to the branch deploy, one Azure DevOps environment per stage.
 * The scratch database is a plain `docker run`, so its name is known and both engines wait the same way.
 */
export function azurePipelines(cfg: Config, o: CiOptions): string {
  const migrations = checked(cfg, o)
  const withModel = o.model === 'check' || o.model === 'generate'
  const generate = o.model === 'generate'
  const install = `    - script: ${yamlStr(o.install)}\n      displayName: Install LiftOff\n`
  const base = '      env:\n        BASE: $(System.PullRequest.TargetBranch)\n'
  const paths = `${withModel ? "'schema-model', " : ''}${yamlStr(migrations)}, 'liftoff.toml'`
  let y =
    `# Written by LiftOff. Add these as secret pipeline variables (or in a linked variable group): ${o.stages.map((s) => envVar(s, 'PASSWORD')).join(', ')}\n` +
    `# (and ${o.stages.map((s) => envVar(s, 'URL')).join(', ')} if the connection URL is not in liftoff.toml).\n` +
    '# Each stage deploys to the Azure DevOps environment of the same name: give it approvals there, and an\n' +
    '# "Exclusive lock" check so deployments queue up. On Azure Repos, pull requests run this pipeline through a\n' +
    `# build validation policy on ${o.branch}; make it required, so every script is numbered after what merged first.\n` +
    (generate ? '# Writing the script commits to the pull request: give the project\'s Build Service "Contribute" on the repository.\n' : '') +
    `trigger:\n  branches:\n    include: [${yamlStr(o.branch)}]\n  paths:\n    include: [${yamlStr(migrations)}, 'liftoff.toml']\n` +
    `pr:\n  paths:\n    include: [${paths}]\n` +
    'stages:\n' +
    "- stage: pull_request\n  displayName: 'Pull request checks'\n  condition: eq(variables['Build.Reason'], 'PullRequest')\n  dependsOn: []\n  jobs:\n" +
    "  - job: migration_order\n    displayName: 'New migration scripts: order and rules'\n    pool:\n      vmImage: ubuntu-latest\n" +
    '    steps:\n    - checkout: self\n      fetchDepth: 0\n' + install +
    `    - script: liftoff renumber --check --after "origin/\${BASE#refs/heads/}"\n      displayName: Check the numbering\n${base}` +
    `    - script: liftoff lint --since "origin/\${BASE#refs/heads/}"\n      displayName: The rules on the new scripts\n${base}`
  if (withModel) {
    const engine = cfg.project.engine
    const url = scratchService(engine).url
    y +=
      "  - job: schema_model\n    displayName: 'Schema model'\n    pool:\n      vmImage: ubuntu-latest\n" +
      `    variables:\n      LIFTOFF_ENV_CI_SCRATCH_URL: ${yamlStr(url)}\n      LIFTOFF_ENV_CI_SCRATCH_ROLE: scratch\n` +
      `    steps:\n    - checkout: self\n${generate ? '      fetchDepth: 0\n      persistCredentials: true\n' : ''}` + install +
      (engine === 'sqlite'
        ? ''
        : '    - script: |\n' +
      (engine === 'sqlserver'
        ? `        docker run -d --name scratch -e ACCEPT_EULA=Y -e 'MSSQL_SA_PASSWORD=${SCRATCH_PASSWORD}' -p 1433:1433 mcr.microsoft.com/mssql/server:2022-latest\n` +
          '        for _ in $(seq 1 30); do\n' +
          `          docker exec scratch /opt/mssql-tools18/bin/sqlcmd -C -S localhost -U sa -P '${SCRATCH_PASSWORD}' -Q 'CREATE DATABASE scratch' && exit 0\n`
        : engine === 'mysql'
          ? `        docker run -d --name scratch -e 'MYSQL_ROOT_PASSWORD=${SCRATCH_PASSWORD}' -e MYSQL_DATABASE=scratch -p 3306:3306 mysql:8.4\n` +
            '        for _ in $(seq 1 60); do\n' +
            // Over TCP: while the image initialises, its server listens on the socket only.
            `          docker exec scratch mysqladmin ping -h 127.0.0.1 -uroot '-p${SCRATCH_PASSWORD}' --silent && exit 0\n`
        : engine === 'oracle'
          ? `        docker run -d --name scratch -e 'ORACLE_PASSWORD=${SCRATCH_PASSWORD}' -e APP_USER=scratch -e 'APP_USER_PASSWORD=${SCRATCH_PASSWORD}' -p 1521:1521 gvenzl/oracle-free:23-slim-faststart\n` +
            '        for _ in $(seq 1 60); do\n' +
            '          docker exec scratch healthcheck.sh && exit 0\n'
          : `        docker run -d --name scratch -e 'POSTGRES_PASSWORD=${SCRATCH_PASSWORD}' -e POSTGRES_DB=scratch -p 5432:5432 postgres:16\n` +
            '        for _ in $(seq 1 30); do\n' +
            // Over TCP: while the image initialises, its server listens on the socket only.
            '          docker exec scratch pg_isready -h 127.0.0.1 -U postgres -d scratch && exit 0\n') +
      '          sleep 2\n        done\n        exit 1\n      displayName: Start the scratch database\n') +
      '    - script: liftoff model --check --scratch ci_scratch\n      displayName: The schema model builds\n'
    if (!generate) {
      y += '    - script: liftoff check --model --scratch ci_scratch\n      displayName: Every schema model change has a migration script\n'
    } else {
      // The checkout is the merge commit; write on the pull request's own branch instead.
      y +=
        '    - script: git checkout -B "${SOURCE#refs/heads/}" "origin/${SOURCE#refs/heads/}"\n      displayName: Check out the pull request branch\n' +
        '      env:\n        SOURCE: $(System.PullRequest.SourceBranch)\n' +
        "    - script: liftoff generate --from model --scratch ci_scratch --description 'pull request $(System.PullRequest.PullRequestId)'\n" +
        '      displayName: Write the migration script for the schema model changes\n' +
        `    - script: liftoff renumber --after "origin/\${BASE#refs/heads/}"\n      displayName: Number the new scripts after the base branch\n${base}` +
        '    - script: |\n' +
        `        if [ -n "$(git status --porcelain -- ${migrations})" ]; then\n` +
        "          git config user.name 'liftoff[bot]'\n" +
        "          git config user.email 'liftoff-bot@users.noreply.dev.azure.com'\n" +
        `          git add ${migrations}\n` +
        "          git commit -m 'Migration script for the schema model changes'\n" +
        '          git push origin "HEAD:${SOURCE#refs/heads/}"\n' +
        '        fi\n      displayName: Commit it to the pull request\n' +
        '      env:\n        SOURCE: $(System.PullRequest.SourceBranch)\n'
    }
  }
  let previous: string | undefined
  for (const s of o.stages) {
    const stage = `migrate_${s.replace(/[^A-Za-z0-9_]/g, '_')}`
    const job = s.toLowerCase().replace(/[^a-z0-9]/g, '-')
    const pw = envVar(s, 'PASSWORD')
    // Secret variables reach a script only when mapped in by name.
    const step = (run: string, name: string) => `          - script: ${run}\n            displayName: ${name}\n            env:\n              ${pw}: $(${pw})\n`
    const e = yamlStr(s)
    y +=
      `- stage: ${stage}\n  displayName: ${yamlStr(`Migrate ${s}`)}\n  dependsOn: ${previous ?? '[]'}\n` +
      "  condition: and(succeeded(), ne(variables['Build.Reason'], 'PullRequest'))\n  jobs:\n" +
      `  - deployment: migrate\n    displayName: ${yamlStr(`Migrate ${s}`)}\n    pool:\n      vmImage: ubuntu-latest\n    environment: ${e}\n` +
      '    strategy:\n      runOnce:\n        deploy:\n          steps:\n          - checkout: self\n' +
      `          - script: ${yamlStr(o.install)}\n            displayName: Install LiftOff\n`
    if (o.checks) y += step(`liftoff --environment ${e} validate`, 'Validate') + step(`liftoff --environment ${e} check --drift --report checks-${job}.html`, 'Check for drift')
    y += step(`liftoff --environment ${e} migrate`, 'Migrate')
    if (o.checks) y += `          - publish: checks-${job}.html\n            artifact: checks-${job}\n            displayName: Keep the check report\n            condition: always()\n            continueOnError: true\n`
    previous = stage
  }
  return y
}

export type Platform = 'github' | 'azure'
export const workflow = (cfg: Config, o: CiOptions) => (o.platform === 'azure' ? azurePipelines : githubActions)(cfg, o)
/** Where each platform looks for the file, relative to the project folder. */
export const fileFor = (platform: Platform = 'github') => (platform === 'azure' ? 'azure-pipelines.yml' : '.github/workflows/liftoff.yml')

/** Writes the workflow file (see fileFor) in the project folder. */
export function write(cfg: Config, yaml: string, overwrite: boolean, platform: Platform = 'github'): string {
  const file = path.join(cfg.root, fileFor(platform))
  if (fs.existsSync(file) && !overwrite) throw configError(`${file} already exists`)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, yaml)
  return file
}
