// `liftoff ui-host`: the screens' commands (commands.ts) over standard input and output, for the
// VS Code panel, which shows the desktop app's screens. One JSON object per line each way:
//   in   {"id": 1, "name": "project_open", "args": {...}}
//   out  {"id": 1, "ok": true, "value": ...}  or  {"id": 1, "ok": false, "error": {code, message, ...}}
//   out  {"log": {"level": "info", "message": "..."}}  progress, as the desktop app's log
// Requests run side by side, as the screens send them; the answers carry the id they answer.

import * as os from 'node:os'
import * as path from 'node:path'
import * as readline from 'node:readline'
import { asLiftoffError } from '../core/errors.ts'
import { commands, type Host } from './commands.ts'

/** Where the desktop app keeps recent.json, so the panel and the app list the same recent projects. */
export function desktopConfigDir(): string {
  const appData =
    process.platform === 'win32' ? (process.env.APPDATA ?? path.join(os.homedir(), 'AppData', 'Roaming'))
    : process.platform === 'darwin' ? path.join(os.homedir(), 'Library', 'Application Support')
    : (process.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), '.config'))
  return path.join(appData, 'app.liftoff.desktop')
}

export async function serve(input: NodeJS.ReadableStream, write: (line: string) => void, configDir = desktopConfigDir()): Promise<void> {
  const send = (o: unknown) => write(`${JSON.stringify(o)}\n`)
  const host: Host = { configDir, log: (level, message) => send({ log: { level, message } }) }
  const pending = new Set<Promise<void>>()
  const handle = async (id: unknown, name: string, args: Record<string, unknown>) => {
    const command = commands[name]
    if (!command) return send({ id, ok: false, error: { code: 'LIFTOFF_CONFIG', exit_code: 2, message: `unknown command ${name}` } })
    try {
      send({ id, ok: true, value: (await command(args, host)) ?? null })
    } catch (e) {
      send({ id, ok: false, error: asLiftoffError(e).report() })
    }
  }
  for await (const line of readline.createInterface({ input, crlfDelay: Infinity })) {
    let req: { id?: unknown; name?: unknown; args?: unknown }
    try {
      req = JSON.parse(line)
    } catch {
      continue // not a request: ignored, the panel only sends JSON
    }
    if (typeof req?.name !== 'string') continue
    const p = handle(req.id, req.name, (req.args ?? {}) as Record<string, unknown>)
    pending.add(p)
    void p.finally(() => pending.delete(p))
  }
  await Promise.all(pending)
}
