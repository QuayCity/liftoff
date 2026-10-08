// Passwords in the operating system's keychain: Windows Credential Manager, macOS Keychain or the
// Secret Service on Linux. One entry per project folder and environment.
//
// The keychain module is optional: where it is missing (the single-file CI build) or switched
// off with LIFTOFF_NO_KEYRING, passwords come from the user file or environment variables.

import * as fs from 'node:fs'
import { createRequire } from 'node:module'

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
      loaded = null
    }
  }
  return loaded
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
