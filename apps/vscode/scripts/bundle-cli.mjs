// Copies the liftoff program into bin/, so the extension works without a separate install.
// Uses the single-file build (npm run build:cli in packages/liftoff), or LIFTOFF_CLI when set.
// One .vsix per platform: build this on (or cross-compile for) each target, then
// `vsce package --target win32-x64` (linux-x64, darwin-arm64, ...).

import { copyFileSync, existsSync, mkdirSync, chmodSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const repo = resolve(here, '../../..')
const exe = process.platform === 'win32' ? 'liftoff.exe' : 'liftoff'
const source = process.env.LIFTOFF_CLI ?? join(repo, 'packages', 'liftoff', 'build', exe)

if (!existsSync(source)) {
  console.error(`No liftoff program at ${source}. Build it with: npm run build:cli (in packages/liftoff)`)
  process.exit(1)
}
mkdirSync(join(here, '..', 'bin'), { recursive: true })
const target = join(here, '..', 'bin', exe)
copyFileSync(source, target)
chmodSync(target, 0o755)
console.log(`Copied ${source} -> ${target}`)
