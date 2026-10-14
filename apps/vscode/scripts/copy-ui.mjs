// Copies the desktop app's built screens (apps/desktop/dist, from `npm run build` there) into
// media/ui, where the LiftOff panel (src/uiPanel.ts) loads them from.

import * as fs from 'node:fs'
import * as path from 'node:path'

const here = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'))
const from = path.join(here, '..', '..', 'desktop', 'dist')
const to = path.join(here, '..', 'media', 'ui')
if (!fs.existsSync(path.join(from, 'index.html'))) {
  console.error(`No built screens in ${from}: run npm run build in apps/desktop first.`)
  process.exit(1)
}
fs.rmSync(to, { recursive: true, force: true })
fs.cpSync(from, to, { recursive: true })
console.log(`Copied the screens to ${to}`)
