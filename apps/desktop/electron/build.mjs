// Bundles the main process (with the core from packages/liftoff) and the preload script into
// dist-electron/. The database drivers are pure JavaScript and go into the bundle; the keychain
// module is native and stays an ordinary dependency.

import { build } from 'esbuild'

const common = { bundle: true, platform: 'node', target: 'node24', sourcemap: true, logLevel: 'warning' }

await build({
  ...common,
  entryPoints: ['electron/main.ts'],
  outfile: 'dist-electron/main.mjs',
  format: 'esm',
  external: ['electron', '@napi-rs/keyring', 'pg-native'],
  // The bundled CommonJS packages (pg, tedious) still call require for Node's own modules.
  banner: { js: "import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);" },
})

await build({ ...common, entryPoints: ['electron/preload.ts'], outfile: 'dist-electron/preload.cjs', format: 'cjs', external: ['electron'] })
