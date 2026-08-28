import assert from 'node:assert/strict'
import { mkdtemp, stat } from 'node:fs/promises'
import { createServer, type IncomingMessage } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Duplex } from 'node:stream'
import { test } from 'node:test'
import { AccessAuth, hasSameOrigin, isTrustedAuthority } from '../src/auth.js'
import { createFleetHttpRoute, createFleetUpgradeRoute } from '../src/http.js'
import type { FleetService } from '../src/service.js'

test('access token is persisted 0600 and authenticates only HttpOnly cookie value', async () => {
  const root = await mkdtemp(join(tmpdir(), 'abf-auth-'))
  const file = join(root, 'access-token')
  const auth = new AccessAuth(file)
  await auth.initialize()
  assert.equal((await stat(file)).mode & 0o777, 0o600)
  const setCookie = auth.cookieHeader()
  assert.match(setCookie, /HttpOnly/)
  assert.match(setCookie, /SameSite=Strict/)
  const cookie = setCookie.split(';', 1)[0]
  assert.equal(auth.authenticate({ headers: { cookie } } as IncomingMessage), true)
  assert.equal(auth.authenticate({ headers: { cookie: 'dsh_agent_browser_fleet=wrong' } } as IncomingMessage), false)
})

test('DSH session mode auto-pairs only a same-origin browser request', async () => {
  const root = await mkdtemp(join(tmpdir(), 'abf-session-auth-'))
  const sessionAuth = new AccessAuth(join(root, 'token'), 'dsh-session')
  await sessionAuth.initialize()
  const browser = { headers: { host: 'localhost:3080', origin: 'http://localhost:3080', 'sec-fetch-site': 'same-origin' } } as IncomingMessage
  const crossSite = { headers: { host: 'localhost:3080', origin: 'http://evil.test', 'sec-fetch-site': 'cross-site' } } as IncomingMessage
  assert.equal(sessionAuth.canBootstrap(browser), true)
  assert.equal(sessionAuth.canBootstrap(crossSite), false)

  const strictAuth = new AccessAuth(join(root, 'strict-token'), 'token')
  await strictAuth.initialize()
  assert.equal(strictAuth.canBootstrap(browser), false)
})

test('authenticated noVNC metadata request succeeds when the system package omits package.json', async () => {
  const root = await mkdtemp(join(tmpdir(), 'abf-novnc-'))
  const auth = new AccessAuth(join(root, 'token'))
  await auth.initialize()
  const route = createFleetHttpRoute({} as FleetService, auth, [], root)
  const server = createServer((req, res) => { void route.handler(req, res) })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  try {
    const address = server.address()
    assert.ok(address && typeof address === 'object')
    const response = await fetch(`http://127.0.0.1:${address.port}/api/agent-browser-fleet/novnc/package.json`, {
      headers: { cookie: auth.cookieHeader().split(';', 1)[0] },
    })
    assert.equal(response.status, 200)
    assert.match(response.headers.get('content-type') ?? '', /application\/json/)
    assert.deepEqual(await response.json(), { name: '@novnc/novnc', version: 'system' })
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
  }
})

test('authority and WebSocket origin checks require trusted same-origin deployment', () => {
  const local = { headers: { host: '127.0.0.1:3080', origin: 'http://127.0.0.1:3080' } } as IncomingMessage
  assert.equal(isTrustedAuthority(local, []), true)
  assert.equal(hasSameOrigin(local, true), true)
  const lan = { headers: { host: '10.0.0.5:3080', origin: 'http://10.0.0.5:3080' } } as IncomingMessage
  assert.equal(isTrustedAuthority(lan, ['10.0.0.5']), true)
  const crossSite = { headers: { host: '10.0.0.5:3080', origin: 'http://evil.test' } } as IncomingMessage
  assert.equal(hasSameOrigin(crossSite, true), false)
  const noOrigin = { headers: { host: '10.0.0.5:3080' } } as IncomingMessage
  assert.equal(hasSameOrigin(noOrigin, true), false)
})

test('noVNC upgrade rejects missing cookie before resolving a VNC target', async () => {
  const root = await mkdtemp(join(tmpdir(), 'abf-upgrade-'))
  const auth = new AccessAuth(join(root, 'token'))
  await auth.initialize()
  let targetResolved = false
  const service = {
    async sessionVncTarget() { targetResolved = true; throw new Error('must not run') },
    async templateVncTarget() { targetResolved = true; throw new Error('must not run') },
  } as unknown as FleetService
  const route = createFleetUpgradeRoute(service, auth, [])
  const socket = new CaptureSocket()
  await route.handler({ url: '/api/agent-browser-fleet/novnc/ws?sessionId=session-1', headers: { host: 'localhost:3080', origin: 'http://localhost:3080' } } as IncomingMessage, socket, Buffer.alloc(0))
  assert.match(socket.output(), /401 Unauthorized/)
  assert.equal(targetResolved, false)
})

class CaptureSocket extends Duplex {
  private readonly chunks: Buffer[] = []
  _read() {}
  _write(chunk: Buffer, _encoding: BufferEncoding, callback: (error?: Error | null) => void) { this.chunks.push(Buffer.from(chunk)); callback() }
  output() { return Buffer.concat(this.chunks).toString('utf8') }
}
