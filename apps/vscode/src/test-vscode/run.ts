// Starts a real VS Code with the extension and runs suite.ts inside it, on a throwaway project
// whose `test` environment is the Postgres from LIFTOFF_TEST_PG (database shop_test, erased first).
//   LIFTOFF_TEST_PG=postgres://postgres:liftoff@localhost:55432 npm run test:vscode
// The first run downloads VS Code into .vscode-test/.

import { runTests } from '@vscode/test-electron'
import { execFileSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

async function main(): Promise<void> {
  const pg = process.env.LIFTOFF_TEST_PG
  if (!pg) {
    console.log('skipped: set LIFTOFF_TEST_PG')
    return
  }
  const extensionDir = path.resolve(__dirname, '../..')
  const repo = path.resolve(extensionDir, '../..')
  const cli = process.env.LIFTOFF_CLI ?? path.join(repo, 'packages', 'liftoff', 'build', process.platform === 'win32' ? 'liftoff.exe' : 'liftoff')

  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'lo-vscode-'))
  execFileSync(cli, ['-C', workspace, 'init', '--name', 'shop'])
  fs.appendFileSync(path.join(workspace, 'liftoff.toml'), `\n[environments.test]\nurl = "${pg}/shop_test"\nrole = "test"\nallow_clean = true\n`)
  fs.writeFileSync(path.join(workspace, 'migrations', 'V1__orders.sql'), 'create table orders (id bigint primary key);\n')
  fs.mkdirSync(path.join(workspace, '.vscode'))
  fs.writeFileSync(path.join(workspace, '.vscode', 'settings.json'), JSON.stringify({ 'liftoff.cliPath': cli }))
  execFileSync(cli, ['-C', workspace, '-e', 'test', 'clean'])

  await runTests({
    extensionDevelopmentPath: extensionDir,
    extensionTestsPath: path.join(__dirname, 'suite.js'),
    launchArgs: [workspace, '--disable-extensions', '--skip-welcome', '--skip-release-notes'],
    extensionTestsEnv: { LIFTOFF_WORKSPACE: workspace },
  })
  fs.rmSync(workspace, { recursive: true, force: true })
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
