import { defineConfig } from '@playwright/test'

// Two projects:
//   ui  - the built frontend in browser-preview mode (seeded fake data layer, same API signatures)
//   app - the real Tauri window over WebView2's debugging port, with the Rust core and Postgres
//         (see app/real-app.spec.ts; needs LIFTOFF_TEST_PG and a built liftoff-desktop)
export default defineConfig({
  timeout: 30_000,
  expect: { timeout: 10_000 },
  reporter: [['list']],
  projects: [
    {
      name: 'ui',
      testDir: './ui',
      use: { baseURL: 'http://localhost:4319', viewport: { width: 1280, height: 800 } },
    },
    {
      name: 'app',
      testDir: './app',
      timeout: 180_000,
      workers: 1,
    },
  ],
  webServer: {
    command: 'cd ../apps/desktop && npm run build && npx vite preview --port 4319 --strictPort',
    url: 'http://localhost:4319',
    reuseExistingServer: true,
    timeout: 120_000,
  },
})
