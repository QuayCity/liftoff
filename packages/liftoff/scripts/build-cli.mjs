// Builds the `liftoff` command line as one file that runs without Node installed:
//   1. esbuild bundles the CLI, the core and the database drivers into build/liftoff.cjs
//   2. Node's single-executable support turns that into build/liftoff(.exe), for this platform
// The keychain module is native and not included: the single file reads passwords from
// environment variables or liftoff.user.toml, which is what CI runners use anyway.
//
//   node scripts/build-cli.mjs            -> build/liftoff(.exe)
//   node scripts/build-cli.mjs --js-only  -> just build/liftoff.cjs (run with `node build/liftoff.cjs`)

import { execFileSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { build } from 'esbuild'

const root = path.resolve(import.meta.dirname, '..')
const out = path.join(root, 'build')
fs.mkdirSync(out, { recursive: true })

await build({
  entryPoints: [path.join(root, 'src/cli/main.ts')],
  outfile: path.join(out, 'liftoff.cjs'),
  bundle: true,
  platform: 'node',
  target: 'node24',
  format: 'cjs',
  external: ['@napi-rs/keyring', 'pg-native'],
  logLevel: 'error',
})
if (process.argv.includes('--js-only')) process.exit(0)

const exe = path.join(out, process.platform === 'win32' ? 'liftoff.exe' : 'liftoff')
const blob = path.join(out, 'sea-prep.blob')
const seaConfig = path.join(out, 'sea-config.json')
fs.writeFileSync(seaConfig, JSON.stringify({ main: path.join(out, 'liftoff.cjs'), output: blob, disableExperimentalSEAWarning: true, useCodeCache: true }))
execFileSync(process.execPath, ['--experimental-sea-config', seaConfig], { stdio: 'inherit' })
fs.copyFileSync(process.execPath, exe)
const postject = path.join(root, 'node_modules', 'postject', 'dist', 'cli.js')
const args = [postject, exe, 'NODE_SEA_BLOB', blob, '--sentinel-fuse', 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2']
if (process.platform === 'darwin') args.push('--macho-segment-name', 'NODE_SEA')
execFileSync(process.execPath, args, { stdio: 'inherit' })
fs.rmSync(blob)
fs.rmSync(seaConfig)
console.log(`Built ${exe} (${(fs.statSync(exe).size / 1e6).toFixed(0)} MB)`)
