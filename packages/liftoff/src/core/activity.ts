// What has happened where: every environment's state and its latest runs, read from the history
// and activity tables (runner.ts writes them). The desktop app's Overview and `liftoff activity`.

import type { Config, Role } from './config.ts'
import { activityTable, withConn, type Activity } from './db.ts'
import { compareVersions, parseVersion, scan } from './migration.ts'
import { compute, type MigrationInfo } from './runner.ts'

export type EnvironmentOverview = {
  name: string
  role: Role
  /** why it could not be read; the rest is empty then */
  error: string | null
  /** the newest applied versioned or baseline script's version */
  version: string | null
  pending: number
  failed: number
  /** the latest runs, newest first */
  activity: Activity[]
  /** every script's state there */
  migrations: MigrationInfo[]
}

/** Every environment but the scratch ones, read side by side (one that cannot be reached says why). */
export async function overview(cfg: Config, limit = 25, only?: string): Promise<EnvironmentOverview[]> {
  const scripts = scan(cfg.migrationsDir())
  const [schema, table] = [cfg.historySchema(), cfg.project.history_table]
  const envs = only !== undefined ? [cfg.pick(only)] : [...cfg.environments].filter(([, e]) => e.role !== 'scratch')
  return Promise.all(
    envs.map(async ([name, env]): Promise<EnvironmentOverview> => {
      try {
        return await withConn(name, env, async (c) => {
          const migrations = compute(scripts, await c.readHistory(schema, table), { name, role: env.role })
          const version = migrations
            .filter((i) => (i.kind === 'versioned' || i.kind === 'baseline') && i.state === 'applied' && i.version !== null)
            .map((i) => i.version!)
            .sort((a, b) => compareVersions(parseVersion(a), parseVersion(b)))
            .at(-1)
          return {
            name,
            role: env.role,
            error: null,
            version: version ?? null,
            pending: migrations.filter((i) => i.state === 'pending').length,
            failed: migrations.filter((i) => i.state === 'failed').length,
            activity: await c.readActivity(schema, activityTable(table), limit),
            migrations,
          }
        })
      } catch (e) {
        return { name, role: env.role, error: e instanceof Error ? e.message : String(e), version: null, pending: 0, failed: 0, activity: [], migrations: [] }
      }
    }),
  )
}

export type Run = Activity & { environment: string }

/** The runs of all the environments in `overview`, newest first. */
export function runs(o: EnvironmentOverview[], limit = Infinity): Run[] {
  return o
    .flatMap((e) => e.activity.map((a) => ({ ...a, environment: e.name })))
    .sort((a, b) => b.started_on.localeCompare(a.started_on))
    .slice(0, limit)
}
