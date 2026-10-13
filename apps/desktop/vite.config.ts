import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig, type Plugin } from 'vite'

/** The built page only talks to itself: no remote scripts, styles, fonts or connections. */
const CSP = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:; connect-src 'self'"

const csp: Plugin = {
  name: 'liftoff-csp',
  apply: 'build',
  transformIndexHtml: (html) => html.replace('<head>', `<head>\n    <meta http-equiv="Content-Security-Policy" content="${CSP}" />`),
}

export default defineConfig({
  // Relative asset paths: the desktop app loads dist/index.html from disk.
  base: './',
  // One ~510 kB bundle read from disk, not downloaded: splitting it would gain nothing.
  build: { chunkSizeWarningLimit: 1024 },
  plugins: [react(), tailwindcss(), csp],
})
