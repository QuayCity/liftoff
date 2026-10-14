// Connection URLs from their parts and back, so people fill in a server, a port and a database
// instead of writing a URL. No imports: the desktop window uses it too.

export type ConnectionFields = {
  server: string
  /** SQL Server named instance (`server\instance`); empty for the default instance */
  instance: string
  /** empty: the engine's default port (a named instance finds its own) */
  port: string
  database: string
  /** SQL Server: encrypt the connection */
  encrypt: boolean
  /** SQL Server: accept a certificate that is not trusted, e.g. a local container's self-signed one */
  trustServerCertificate: boolean
  /** SQL Server: how to sign in, by its JDBC name (SqlPassword, ActiveDirectoryDefault, …) */
  authentication: string
  /** SQL Server, Microsoft Entra ID: the directory (tenant) ID */
  tenantId: string
  /** PostgreSQL and MySQL: prefer (the default), require, verify-full or disable */
  sslmode: string
  /** other settings of the URL, kept as written: `;applicationName=x` or `connect_timeout=5` */
  extra: string
}

export const emptyFields = (): ConnectionFields => ({ server: 'localhost', instance: '', port: '', database: '', encrypt: true, trustServerCertificate: false, authentication: 'SqlPassword', tenantId: '', sslmode: '', extra: '' })

export const defaultPort = (engine: string) => (engine === 'sqlserver' ? '1433' : engine === 'mysql' ? '3306' : '5432')

export function buildUrl(engine: string, f: ConnectionFields): string {
  const server = f.server.trim() || 'localhost'
  const port = f.port.trim()
  if (engine === 'sqlserver') {
    const host = `${server}${f.instance.trim() ? `\\${f.instance.trim()}` : ''}${port ? `:${port}` : ''}`
    const auth = f.authentication && f.authentication !== 'SqlPassword' ? `;authentication=${f.authentication}` : ''
    const tenant = auth && f.tenantId.trim() ? `;tenantId=${f.tenantId.trim()}` : ''
    return `sqlserver://${host};databaseName=${f.database.trim()};encrypt=${f.encrypt};trustServerCertificate=${f.trustServerCertificate}${auth}${tenant}${f.extra}`
  }
  const host = server.includes(':') ? `[${server}]` : server
  const query = new URLSearchParams(f.extra)
  if (f.sslmode) query.set('sslmode', f.sslmode)
  const q = query.toString()
  const scheme = engine === 'mysql' ? 'mysql' : 'postgres'
  return `${scheme}://${host}${port ? `:${port}` : ''}/${encodeURIComponent(f.database.trim())}${q ? `?${q}` : ''}`
}

/**
 * The parts of a URL, plus a user written inside it. Undefined when the fields cannot show it
 * as written: `${env.X}` references, a password inside the URL, another engine, `key=value` form.
 */
export function splitUrl(engine: string, url: string): (ConnectionFields & { user?: string }) | undefined {
  const u = url.trim()
  if (!u) return emptyFields()
  if (u.includes('${')) return undefined
  const f = emptyFields()
  if (engine === 'sqlserver') {
    const m = /^(?:jdbc:)?sqlserver:\/\/([^;]*)(.*)$/i.exec(u)
    if (!m) return undefined
    let host = m[1]
    let user: string | undefined
    const colon = host.lastIndexOf(':')
    if (colon > 0) {
      f.port = host.slice(colon + 1)
      host = host.slice(0, colon)
    }
    const [server, instance] = host.split('\\')
    f.server = server
    f.instance = instance ?? ''
    for (const kv of m[2].split(';').filter((p) => p.trim())) {
      const i = kv.indexOf('=')
      const key = (i > 0 ? kv.slice(0, i) : kv).trim().toLowerCase()
      const value = i > 0 ? kv.slice(i + 1).trim() : ''
      if (key === 'databasename' || key === 'database') f.database = value
      else if (key === 'encrypt') f.encrypt = value.toLowerCase() !== 'false'
      else if (key === 'trustservercertificate') f.trustServerCertificate = value.toLowerCase() === 'true'
      else if (key === 'portnumber') f.port = value
      else if (key === 'instancename') f.instance = value
      else if (key === 'authentication') f.authentication = value
      else if (key === 'tenantid') f.tenantId = value
      else if (key === 'user') user = value
      else if (key === 'password') return undefined
      else f.extra += `;${kv.trim()}`
    }
    return { ...f, ...(user !== undefined && { user }) }
  }
  if (!(engine === 'mysql' ? /^mysql:\/\//i : /^postgres(ql)?:\/\//i).test(u)) return undefined
  let parsed: URL
  try {
    parsed = new URL(u)
  } catch {
    return undefined
  }
  if (parsed.password) return undefined
  f.server = decodeURIComponent(parsed.hostname.replace(/^\[|\]$/g, '')) || 'localhost'
  f.port = parsed.port
  f.database = decodeURIComponent(parsed.pathname.replace(/^\//, ''))
  f.sslmode = parsed.searchParams.get('sslmode') ?? ''
  parsed.searchParams.delete('sslmode')
  f.extra = parsed.searchParams.toString()
  return { ...f, ...(parsed.username && { user: decodeURIComponent(parsed.username) }) }
}
