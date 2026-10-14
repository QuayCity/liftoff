// Shared set-up for the tests against real databases. Each needs a variable, or is skipped:
//   LIFTOFF_TEST_PG        postgres://postgres:liftoff@localhost:55432 (databases shop_dev, shop_scratch, shop_test)
//   LIFTOFF_TEST_PGBOUNCER postgres://postgres:liftoff@localhost:56432 (PgBouncer, transaction pooling)
//   LIFTOFF_TEST_MSSQL     sqlserver://localhost:51433;encrypt=true;trustServerCertificate=true;user=sa;password=…
//   LIFTOFF_TEST_ORACLE    oracle://system:liftoff@localhost:51621/FREEPDB1 (a user that may create users)

import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { Config, init, saveEnvironment, type Environment, type Role } from '../src/core/config.ts'
import { open } from '../src/core/db.ts'

export function project(engine: 'postgresql' | 'sqlserver' | 'oracle', envs: [name: string, url: string, role: Role, extra?: Partial<Environment>][]) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lo-it-'))
  init(dir, 'shop', engine)
  for (const [name, url, role, extra] of envs) {
    saveEnvironment(dir, name, { url, role, allow_clean: false, placeholders: {}, ...extra }, true, false)
  }
  const write = (file: string, sql: string) => fs.writeFileSync(path.join(dir, 'migrations', file), sql)
  const remove = (file: string) => fs.rmSync(path.join(dir, 'migrations', file))
  return { dir, cfg: () => Config.load(dir), write, remove }
}

/** Runs SQL on an environment directly, outside LiftOff's bookkeeping. */
export async function sql(cfg: Config, env: string, text: string): Promise<void> {
  const c = await open(env, cfg.env(env))
  try {
    await c.batch(text)
  } finally {
    await c.close()
  }
}

/** Whether a statement succeeds (SQL Server checks are written as `IF … THROW`). */
export async function succeeds(cfg: Config, env: string, text: string): Promise<boolean> {
  return sql(cfg, env, text).then(
    () => true,
    () => false,
  )
}

export const pgSchemaReset = 'DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public;'
