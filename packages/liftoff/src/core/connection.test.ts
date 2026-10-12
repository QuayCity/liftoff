import assert from 'node:assert/strict'
import { test } from 'node:test'
import { buildUrl, emptyFields, splitUrl } from './connection.ts'
import { describeConnectError, parseUrl as msParse, signIn } from './sqlserver.ts'
import { parseUrl as pgParse } from './postgres.ts'

test('SQL Server: fields to a URL the driver reads, and back', () => {
  const f = { ...emptyFields(), server: 'db1', instance: 'SQL2022', port: '', database: 'shop', trustServerCertificate: true }
  const url = buildUrl('sqlserver', f)
  assert.equal(url, 'sqlserver://db1\\SQL2022;databaseName=shop;encrypt=true;trustServerCertificate=true')
  assert.deepEqual(msParse(url), { server: 'db1', port: undefined, instance: 'SQL2022', props: new Map([['databasename', 'shop'], ['encrypt', 'true'], ['trustservercertificate', 'true']]) })
  assert.deepEqual(splitUrl('sqlserver', url), f)

  const withPort = buildUrl('sqlserver', { ...emptyFields(), port: '61433', database: 'uat_dev', encrypt: false })
  assert.equal(withPort, 'sqlserver://localhost:61433;databaseName=uat_dev;encrypt=false;trustServerCertificate=false')
  assert.equal(msParse(withPort).port, 61433)
})

test('SQL Server: other settings and a user inside the URL are kept', () => {
  const s = splitUrl('sqlserver', 'jdbc:sqlserver://db:1500;databaseName=x;applicationName=ci;user=deploy')!
  assert.deepEqual([s.server, s.port, s.database, s.extra, s.user, s.encrypt], ['db', '1500', 'x', ';applicationName=ci', 'deploy', true])
  assert.equal(buildUrl('sqlserver', s), 'sqlserver://db:1500;databaseName=x;encrypt=true;trustServerCertificate=false;applicationName=ci')
})

test('PostgreSQL: fields to a URL and back, a user inside the URL comes out', () => {
  const url = buildUrl('postgresql', { ...emptyFields(), server: 'pg.internal', port: '6432', database: 'shop db', sslmode: 'require' })
  assert.equal(url, 'postgres://pg.internal:6432/shop%20db?sslmode=require')
  assert.deepEqual([pgParse(url).host, pgParse(url).port, pgParse(url).database, pgParse(url).sslmode], ['pg.internal', 6432, 'shop db', 'require'])
  const s = splitUrl('postgresql', 'postgres://me@localhost:5432/shop?connect_timeout=5')!
  assert.deepEqual([s.user, s.server, s.port, s.database, s.sslmode, s.extra], ['me', 'localhost', '5432', 'shop', '', 'connect_timeout=5'])
  assert.equal(buildUrl('postgresql', s), 'postgres://localhost:5432/shop?connect_timeout=5')
})

test('URLs the fields cannot show stay URLs', () => {
  for (const [engine, url] of [
    ['sqlserver', 'sqlserver://${env.DB_HOST};databaseName=x'],
    ['sqlserver', 'sqlserver://db;databaseName=x;password=secret'],
    ['sqlserver', 'postgres://db/x'],
    ['postgresql', 'postgres://me:secret@db/x'],
    ['postgresql', 'host=db dbname=x'],
  ]) assert.equal(splitUrl(engine, url), undefined, url)
  assert.deepEqual(splitUrl('sqlserver', ''), emptyFields())
})

test('an untrusted SQL Server certificate says what to do, not which Node.js flag to use', () => {
  const m = describeConnectError('Failed to connect to localhost:61433 - self-signed certificate; if the root CA is installed locally, try running Node.js with --use-system-ca')
  assert.equal(m.includes('--use-system-ca'), false)
  assert.match(m, /^Failed to connect to localhost:61433 - self-signed certificate\. .*trustServerCertificate=true/)
  assert.equal(describeConnectError('Login failed for user \'sa\'.'), 'Login failed for user \'sa\'.')
})

test('SQL Server sign-in methods, by their JDBC names', () => {
  const sign = (url: string, user?: string, password?: string) => signIn(msParse(url).props, user, password)!
  assert.deepEqual(sign('sqlserver://db;databaseName=x', 'sa', 'pw'), { type: 'default', options: { userName: 'sa', password: 'pw' } })
  assert.deepEqual(sign('sqlserver://db;authentication=ActiveDirectoryDefault'), { type: 'azure-active-directory-default', options: { clientId: undefined } })
  assert.deepEqual(sign('sqlserver://db;authentication=activedirectorymanagedidentity', 'mi-client'), { type: 'azure-active-directory-msi-vm', options: { clientId: 'mi-client' } })
  assert.deepEqual(sign('sqlserver://db;authentication=ActiveDirectoryServicePrincipal;tenantId=t1', 'app-id', 'secret'), {
    type: 'azure-active-directory-service-principal-secret', options: { clientId: 'app-id', clientSecret: 'secret', tenantId: 't1' },
  })
  assert.throws(() => sign('sqlserver://db;authentication=ActiveDirectoryServicePrincipal', 'app-id', 'secret'), /needs tenantId/)
  const a = sign('sqlserver://db;authentication=ActiveDirectoryInteractive', 'me@corp.com')
  const b = sign('sqlserver://db2;authentication=ActiveDirectoryInteractive', 'me@corp.com')
  assert.equal(a.type, 'token-credential')
  assert.equal((a.options as { credential: unknown }).credential, (b.options as { credential: unknown }).credential, 'one browser sign-in per account')
  assert.throws(() => sign('sqlserver://db;authentication=ActiveDirectoryPassword', 'u', 'p'), /not supported; use one of SqlPassword, ActiveDirectoryDefault/)
})

test('the connection fields carry the sign-in method and tenant', () => {
  const url = buildUrl('sqlserver', { ...emptyFields(), server: 'x.database.windows.net', database: 'shop', authentication: 'ActiveDirectoryServicePrincipal', tenantId: 't1' })
  assert.equal(url, 'sqlserver://x.database.windows.net;databaseName=shop;encrypt=true;trustServerCertificate=false;authentication=ActiveDirectoryServicePrincipal;tenantId=t1')
  const back = splitUrl('sqlserver', url)!
  assert.deepEqual([back.authentication, back.tenantId, back.extra], ['ActiveDirectoryServicePrincipal', 't1', ''])
  assert.equal(splitUrl('sqlserver', 'sqlserver://db;databaseName=x')!.authentication, 'SqlPassword')
})
