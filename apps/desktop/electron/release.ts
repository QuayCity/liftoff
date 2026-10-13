// Which release is newer, and which of its files this install updates from. No Electron here,
// so the tests run in plain Node.

export type Asset = { name: string; browser_download_url: string; size: number; digest?: string | null }
export type Release = { tag_name: string; html_url: string; draft?: boolean; prerelease?: boolean; assets: Asset[] }

/** a > b for x.y.z versions (a leading v is ignored). */
export function newer(a: string, b: string): boolean {
  const parts = (v: string) => v.replace(/^v/, '').split(/[.+-]/).slice(0, 3).map((n) => Number.parseInt(n, 10) || 0)
  const [x, y] = [parts(a), parts(b)]
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] > y[i]
  return false
}

/** The file of a release this install updates from, as the release workflow names it. */
export function assetFor(release: Release, platform: NodeJS.Platform, appImage: boolean): Asset | undefined {
  const v = release.tag_name.replace(/^v/, '')
  const name = platform === 'win32' ? `LiftOff-Setup-${v}.exe` : platform === 'linux' && appImage ? `LiftOff-${v}-x86_64.AppImage` : undefined
  return release.assets.find((a) => a.name === name)
}
