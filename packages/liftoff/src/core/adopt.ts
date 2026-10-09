// Adopting an existing database: a project without scripts starts from what the database already
// has. Its objects are captured into B0001, and the database is recorded at B0001 without running
// anything there. The record step builds B0001 on the scratch database and compares: it must match
// the database exactly, which proves the capture is complete. New work starts at V0002.
//
// The other environments (test, acceptance, …) then go through the smart baseline on their next
// migrate: checked against B0001, missing objects created, differences listed.

import * as fs from 'node:fs'
import type { Config } from './config.ts'
import { capture, save } from './diff.ts'
import { configError } from './errors.ts'
import { scan } from './migration.ts'
import { info, migrate, quiet, type Log } from './runner.ts'

export type Adopted = { environment: string; baseline: string; version: string; objects: number }

export async function adopt(cfg: Config, envName: string | undefined, description = 'existing schema', scratch?: string, log: Log = quiet): Promise<Adopted> {
  const [name] = cfg.pick(envName)
  if (scan(cfg.migrationsDir()).some((s) => s.kind === 'versioned' || s.kind === 'baseline')) {
    throw configError(`this project already has migration scripts; adopting is for a project without any. Migrate '${name}' instead: a database with objects is checked against the baseline script`)
  }
  if ((await info(cfg, name)).some((i) => i.installed_on !== null)) throw configError(`'${name}' already has migration history`)
  log('info', `Capturing the objects of '${name}'`)
  const g = await capture(cfg, name, description, true)
  const file = save(cfg, g.file_name, g.sql)
  try {
    await migrate(cfg, name, { scratch, baselineMustMatch: true }, log)
  } catch (e) {
    // The capture is not kept unless it rebuilds the database exactly.
    fs.rmSync(file, { force: true })
    throw e
  }
  return { environment: name, baseline: file, version: g.version, objects: g.sql.split('\n').filter((l) => /^CREATE /i.test(l)).length }
}
