// Passwords in the operating system's keychain: Windows Credential Manager, macOS Keychain or the
// Secret Service on Linux. One entry per project folder and environment.
//
// The keychain module is optional: where it cannot load (a CI runner without a keychain) or is
// switched off with LIFTOFF_NO_KEYRING, passwords come from the user file or environment variables.

import { createHash } from 'node:crypto'
import * as fs from 'node:fs'
import { createRequire } from 'node:module'
import * as os from 'node:os'
import * as path from 'node:path'

const SERVICE = 'liftoff'

type Entry = { getPassword(): string | null | undefined; setPassword(p: string): void; deletePassword(): boolean }
type KeyringModule = { Entry: new (service: string, account: string) => Entry }

let loaded: KeyringModule | null | undefined

function keyring(): KeyringModule | null {
  if (process.env.LIFTOFF_NO_KEYRING !== undefined) return null
  if (loaded === undefined) {
    try {
      loaded = createRequire(import.meta.url)('@napi-rs/keyring') as KeyringModule
    } catch {
      loaded = fromSingleFile()
    }
  }
  return loaded
}

/**
 * The single-file CLI carries the keychain's native module as an embedded asset (see
 * scripts/build-cli.mjs). Native code loads from a file, so it is written once to the user's own
 * cache folder and checked byte for byte against the embedded copy before every load.
 */
function fromSingleFile(): KeyringModule | null {
  try {
    const sea = process.getBuiltinModule('node:sea')
    if (!sea?.isSea()) return null
    const bytes = Buffer.from(sea.getRawAsset('keyring.node') as ArrayBuffer)
    const base = process.platform === 'win32' ? process.env.LOCALAPPDATA : process.env.XDG_CACHE_HOME
    const dir = path.join(base ?? path.join(os.homedir(), '.cache'), 'liftoff')
    const file = path.join(dir, `keyring-${createHash('sha256').update(bytes).digest('hex').slice(0, 16)}.node`)
    if (!fs.existsSync(file) || !bytes.equals(fs.readFileSync(file))) {
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
      fs.writeFileSync(file, bytes, { mode: 0o600 })
    }
    const m = { exports: {} as KeyringModule }
    process.dlopen(m, file)
    return m.exports
  } catch {
    return null
  }
}

function account(root: string, env: string): string {
  let dir = root
  try {
    dir = fs.realpathSync.native(root)
  } catch {
    // keep the path as given
  }
  return `${dir}#${env}`
}

export function keychainGet(root: string, env: string): string | undefined {
  try {
    return keyring()?.Entry && (new (keyring()!.Entry)(SERVICE, account(root, env)).getPassword() ?? undefined)
  } catch {
    return undefined
  }
}

/** True when the keychain now holds the password. */
export function keychainSet(root: string, env: string, password: string): boolean {
  const k = keyring()
  if (!k) return false
  try {
    new k.Entry(SERVICE, account(root, env)).setPassword(password)
    return true
  } catch {
    return false
  }
}

export function keychainDelete(root: string, env: string): void {
  try {
    const k = keyring()
    if (k) new k.Entry(SERVICE, account(root, env)).deletePassword()
  } catch {
    // nothing stored
  }
}

export const keychainEnabled = () => keyring() !== null
