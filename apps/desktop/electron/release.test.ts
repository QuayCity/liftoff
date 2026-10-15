import assert from 'node:assert/strict'
import { test } from 'node:test'
import { assetFor, newer, type Release } from './release.ts'

test('newer compares x.y.z, with or without a v', () => {
  assert.equal(newer('v0.2.0', '0.1.0'), true)
  assert.equal(newer('0.10.0', '0.9.9'), true, 'numbers, not text')
  assert.equal(newer('v0.1.0', '0.1.0'), false)
  assert.equal(newer('0.1.0', '0.1.1'), false)
  assert.equal(newer('1.0.0', '0.99.99'), true)
})

test('the file an install updates from: the zip or the setup on Windows, the AppImage on Linux', () => {
  const file = (name: string) => ({ name, browser_download_url: `https://example.test/${name}`, size: 1 })
  const release: Release = {
    tag_name: 'v0.2.0', html_url: 'https://github.com/QuayCity/liftoff/releases/tag/v0.2.0',
    assets: [file('liftoff-win-x64.exe'), file('LiftOff-Setup-0.2.0.exe'), file('LiftOff-0.2.0-win-x64.zip'), file('LiftOff-0.2.0-x86_64.AppImage'), file('liftoff-vscode-win32-x64.vsix')],
  }
  assert.equal(assetFor(release, 'win32', { appImage: false, staged: true })?.name, 'LiftOff-0.2.0-win-x64.zip', 'unpacked beside the app, swapped at the restart')
  assert.equal(assetFor(release, 'win32', { appImage: false, staged: false })?.name, 'LiftOff-Setup-0.2.0.exe', 'no room beside the app: the setup')
  const noZip = { ...release, assets: release.assets.filter((a) => !a.name.endsWith('.zip')) }
  assert.equal(assetFor(noZip, 'win32', { appImage: false, staged: true })?.name, 'LiftOff-Setup-0.2.0.exe', 'a release without the zip: the setup')
  assert.equal(assetFor(release, 'linux', { appImage: true, staged: false })?.name, 'LiftOff-0.2.0-x86_64.AppImage')
  assert.equal(assetFor(release, 'linux', { appImage: false, staged: false }), undefined, 'not started from an AppImage: nothing to replace')
  assert.equal(assetFor(release, 'darwin', { appImage: false, staged: false }), undefined)
})
