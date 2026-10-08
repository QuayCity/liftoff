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
}

/** A placeholder: point it at wherever the single-file `liftoff` for Linux is published. */
export const DEFAULT_INSTALL = 'curl -fsSL -o liftoff https://github.com/YOUR-ORG/liftoff/releases/latest/download/liftoff-linux-x64 && sudo install -m 755 liftoff /usr/local/bin/liftoff'

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
  let y =
    `# Written by LiftOff. Add these repository secrets: LIFTOFF_LICENSE${o.stages.map((s) => `, ${envVar(s, 'PASSWORD')}`).join('')}\n` +
    `# (and ${o.stages.map((s) => envVar(s, 'URL')).join(', ')} if the connection URL is not in liftoff.toml).\n` +
    'name: Database migrations\n' +
    `on:\n  push:\n    branches: [${yamlStr(o.branch)}]\n    paths: [${yamlStr(`${migrations}/**`)}, 'liftoff.toml']\n  workflow_dispatch:\n` +
    'concurrency:\n  group: liftoff-migrations\n  cancel-in-progress: false\n' +
    'jobs:\n'
  let previous: string | undefined
  for (const s of o.stages) {
    const job = s.toLowerCase().replace(/[^a-z0-9]/g, '-')
    y += `  ${job}:\n    name: ${yamlStr(`Migrate ${s}`)}\n    runs-on: ubuntu-latest\n`
    if (previous) y += `    needs: ${previous}\n`
    // A GitHub environment of the same name holds approvals and its own secrets.
    y += `    environment: ${yamlStr(s)}\n`
    const pw = envVar(s, 'PASSWORD')
    y += `    env:\n      LIFTOFF_LICENSE: \${{ secrets.LIFTOFF_LICENSE }}\n      ${pw}: \${{ secrets.${pw} }}\n`
    y += '    steps:\n      - uses: actions/checkout@v4\n'
    y += `      - name: Install LiftOff\n        run: ${yamlStr(o.install)}\n`
    const e = yamlStr(s)
    if (o.checks) {
      y += `      - name: Validate\n        run: liftoff --environment ${e} validate\n`
      y += `      - name: Check for drift\n        run: liftoff --environment ${e} check --drift --report checks-${job}.html\n`
    }
    y += `      - name: Migrate\n        run: liftoff --environment ${e} migrate\n`
    if (o.checks) {
      y += `      - name: Keep the check report\n        if: always()\n        uses: actions/upload-artifact@v4\n        with:\n          name: checks-${job}\n          path: checks-${job}.html\n          if-no-files-found: ignore\n`
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
