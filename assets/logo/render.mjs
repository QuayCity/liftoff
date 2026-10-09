// Renders the PNGs in this folder (and the app icons) from logo.svg and logo-mono.svg.
// Uses the Playwright from e2e/ (cd e2e && npm install && npx playwright install chromium), then:
//   node assets/logo/render.mjs
// The wordmark uses the Righteous font from Google Fonts, so this needs the network.

import { mkdirSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const repo = join(here, '..', '..')
const { chromium } = createRequire(join(repo, 'e2e', 'package.json'))('playwright')

const logo = readFileSync(join(here, 'logo.svg'), 'utf8')
const mono = readFileSync(join(here, 'logo-mono.svg'), 'utf8').replace(/ width="24" height="24"/, '')
const navy = '#1B1F3B'
const cream = '#F4EBD9'
const font = '<link href="https://fonts.googleapis.com/css2?family=Righteous&display=swap" rel="stylesheet">'
const wordmark = (color, background = 'transparent') =>
  `${font}<div id="art" style="display:inline-flex;align-items:center;gap:56px;padding:48px 72px;background:${background}">
     <div style="width:320px;height:320px">${logo}</div>
     <span style="font:200px/1 Righteous,sans-serif;color:${color};letter-spacing:2px">LiftOff</span></div>`

// [file, html, width, height]: width and height for a fixed-size square, or null to fit the content.
const square = (svg, size, color = navy) => [`<div id="art" style="width:${size}px;height:${size}px;color:${color}">${svg}</div>`, size, size]
const jobs = [
  ...[16, 32, 64, 128, 256, 512, 1024].map((s) => [join(here, `logo-${s}.png`), ...square(logo, s)]),
  [join(here, 'logo-mono-dark-512.png'), ...square(mono, 512, navy)],
  [join(here, 'logo-mono-light-512.png'), ...square(mono, 512, '#FFFFFF')],
  [join(here, 'logo-wordmark.png'), wordmark(navy), null, null],
  [join(here, 'logo-wordmark-on-dark.png'), wordmark(cream), null, null],
  [
    join(here, 'social-preview.png'),
    `${font}<div id="art" style="width:1280px;height:640px;background:${navy};display:flex;flex-direction:column;align-items:center;justify-content:center;gap:28px">
       <div style="display:flex;align-items:center;gap:40px"><div style="width:240px;height:240px">${logo}</div>
       <span style="font:150px/1 Righteous,sans-serif;color:${cream}">LiftOff</span></div>
       <div style="font:36px/1.3 sans-serif;color:${cream};opacity:.85">Database migrations: write them from your changes, run them everywhere.</div></div>`,
    null,
    null,
  ],
  [join(repo, 'apps', 'vscode', 'media', 'icon.png'), ...square(logo, 128)],
  [join(repo, 'apps', 'desktop', 'electron', 'icon.png'), ...square(logo, 256)],
]

const browser = await chromium.launch()
for (const [file, html, width, height] of jobs) {
  const page = await browser.newPage({ viewport: { width: width ?? 1600, height: height ?? 800 } })
  await page.setContent(`<style>html,body{margin:0;background:transparent}svg{display:block;width:100%;height:100%}</style>${html}`)
  await page.evaluate(() => document.fonts.ready)
  mkdirSync(dirname(file), { recursive: true })
  await page.locator('#art').screenshot({ path: file, omitBackground: true })
  await page.close()
  console.log('wrote', file.slice(repo.length + 1))
}
await browser.close()
