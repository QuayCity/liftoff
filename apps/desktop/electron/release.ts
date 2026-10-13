// Which release is newer, and which of its files this install updates from. No Electron here,
// so the tests run in plain Node.

export type Asset = { name: string; browser_download_url: string; size: number; digest?: string | null }
export type Release = { tag_name: string; html_url: string; draft?: boolean; prerelease?: boolean; assets: Asset[]; body?: string | null; published_at?: string | null }

/** a > b for x.y.z versions (a leading v is ignored). */
export function newer(a: string, b: string): boolean {
  const parts = (v: string) => v.replace(/^v/, '').split(/[.+-]/).slice(0, 3).map((n) => Number.parseInt(n, 10) || 0)
  const [x, y] = [parts(a), parts(b)]
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] > y[i]
  return false
}

/**
 * The file of a release this install updates from, as the release workflow names it. On Windows
 * the zip when the new version can be unpacked next to this one (`staged`), so the restart only
 * swaps folders; otherwise the setup, which installs while the app is closed.
 */
export function assetFor(release: Release, platform: NodeJS.Platform, o: { appImage: boolean; staged: boolean }): Asset | undefined {
  const v = release.tag_name.replace(/^v/, '')
  const find = (name: string) => release.assets.find((a) => a.name === name)
  if (platform === 'win32') return (o.staged ? find(`LiftOff-${v}-win-x64.zip`) : undefined) ?? find(`LiftOff-Setup-${v}.exe`)
  if (platform === 'linux' && o.appImage) return find(`LiftOff-${v}-x86_64.AppImage`)
  return undefined
}
