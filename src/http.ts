import { readFile, stat } from 'node:fs/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { extname, resolve, sep } from 'node:path'
import type { Duplex } from 'node:stream'
import { AccessAuth, hasSameOrigin, isTrustedAuthority } from './auth.js'
import { FleetError } from './domain.js'
import type { FleetService } from './service.js'
import { handleVncUpgrade } from './vncgw.mjs'

export const API_PREFIX = '/api/agent-browser-fleet'
export const VNC_UPGRADE_PATH = API_PREFIX + '/novnc/ws'
const MAX_BODY_BYTES = 64 * 1024

export interface HttpRoute {
  kind: 'prefix'
  path: string
  handler(req: IncomingMessage, res: ServerResponse): Promise<void>
}
export interface UpgradeRoute {
  path: string
  handler(req: IncomingMessage, socket: Duplex, head: Buffer): Promise<void>
}

export function createFleetHttpRoute(
  service: FleetService,
  auth: AccessAuth,
  trustedHosts: readonly string[],
  novncRoot: string,
): HttpRoute {
  return {
    kind: 'prefix',
    path: API_PREFIX,
    async handler(req, res) {
      try {
        if (!isTrustedAuthority(req, trustedHosts)) return sendError(res, 403, 'untrusted_authority', 'request authority is not trusted')
        const url = new URL(req.url ?? '/', 'http://dsh.internal')
        const relative = url.pathname.slice(API_PREFIX.length)
        const method = req.method ?? 'GET'

        if (relative === '/auth/status' && method === 'GET') {
          const authenticated = auth.authenticate(req)
          if (!authenticated && auth.canBootstrap(req)) {
            return sendJson(res, 200, { ok: true, authenticated: true, mode: auth.mode }, { 'set-cookie': auth.cookieHeader() })
          }
          return sendJson(res, 200, { ok: true, authenticated, mode: auth.mode })
        }
        if (relative === '/auth/login' && method === 'POST') {
          if (!hasSameOrigin(req, false)) return sendError(res, 403, 'bad_origin', 'login must be same-origin')
          const body = await readJson(req)
          if (!auth.login(body.token)) return sendError(res, 401, 'invalid_token', 'access token is invalid')
          return sendJson(res, 200, { ok: true }, { 'set-cookie': auth.cookieHeader() })
        }
        if (!auth.authenticate(req)) return sendError(res, 401, 'unauthorized', 'Agent Browser Fleet login required')

        if (method === 'GET' && relative.startsWith('/novnc/')) {
          return serveNovnc(res, novncRoot, relative.slice('/novnc/'.length))
        }
        if (method === 'GET' && relative === '/state') {
          const sessionId = url.searchParams.get('sessionId')
          if (!sessionId) throw new BodyError(400, 'missing_session_id', 'sessionId query parameter is required')
          return sendJson(res, 200, { ok: true, state: publicState(service, sessionId) })
        }
        if (method === 'GET' && relative === '/doctor') return sendJson(res, 200, { ok: true, doctor: await service.doctor() })

        if (method === 'GET' && relative === '/screenshots/current.png') {
          const sessionId = url.searchParams.get('sessionId')
          if (!sessionId) throw new BodyError(400, 'missing_session_id', 'sessionId query parameter is required')
          return servePng(res, service.screenshotPathForSession(sessionId))
        }

        if (method !== 'POST') return sendError(res, 404, 'not_found', 'endpoint not found')
        if (!hasSameOrigin(req, false)) return sendError(res, 403, 'bad_origin', 'mutation must be same-origin')
        const body = await readJson(req)

        if (relative === '/identities') {
          const identity = await service.createIdentity({ name: body.name, maxSlots: body.maxSlots })
          return sendJson(res, 201, { ok: true, identity })
        }
        const templateStart = /^\/identities\/([a-z0-9-]+)\/template\/start$/.exec(relative)
        if (templateStart) {
          const identity = await service.startTemplateLogin(templateStart[1])
          return sendJson(res, 200, { ok: true, identity })
        }
        const templateSnapshot = /^\/identities\/([a-z0-9-]+)\/template\/snapshot$/.exec(relative)
        if (templateSnapshot) {
          const identity = await service.snapshotTemplate(templateSnapshot[1])
          return sendJson(res, 200, { ok: true, identity })
        }
        return sendError(res, 404, 'not_found', 'endpoint not found')
      } catch (error) {
        if (error instanceof BodyError) return sendError(res, error.status, error.code, error.message)
        if (error instanceof FleetError) return sendError(res, error.status, error.code, error.message)
        console.error('agent-browser-fleet: HTTP request failed', error)
        return sendError(res, 500, 'internal_error', 'Agent Browser Fleet request failed')
      }
    },
  }
}

export function createFleetUpgradeRoute(service: FleetService, auth: AccessAuth, trustedHosts: readonly string[]): UpgradeRoute {
  return {
    path: VNC_UPGRADE_PATH,
    async handler(req, socket, head) {
      if (!isTrustedAuthority(req, trustedHosts) || !hasSameOrigin(req, true) || !auth.authenticate(req)) {
        rejectUpgrade(socket, 401, 'Unauthorized')
        return
      }
      try {
        const url = new URL(req.url ?? '/', 'http://dsh.internal')
        const sessionId = url.searchParams.get('sessionId')
        const identityId = url.searchParams.get('identityId')
        if ((sessionId ? 1 : 0) + (identityId ? 1 : 0) !== 1) throw new Error('exactly one sessionId or identityId is required')
        const target = sessionId ? await service.sessionVncTarget(sessionId) : await service.templateVncTarget(identityId)
        handleVncUpgrade(req, socket, head, {
          vncHost: '127.0.0.1',
          vncPort: target.vncPort,
          password: target.password,
          log: (message: string) => console.info('agent-browser-fleet: ' + message),
        })
      } catch (error) {
        console.warn('agent-browser-fleet: VNC upgrade rejected', error)
        rejectUpgrade(socket, 400, 'Bad Request')
      }
    },
  }
}

export function publicState(service: FleetService, sessionId: string) {
  const state = service.state()
  const binding = service.sessionBrowser(sessionId)
  const slot = binding ? state.slots.find((candidate) => candidate.id === binding.slotId) : undefined
  return {
    identities: state.identities.map((identity) => ({
      id: identity.id,
      name: identity.name,
      maxSlots: identity.maxSlots,
      templateState: identity.templateState,
      templateRuntime: {
        running: identity.templateRuntime.running,
        startedAt: identity.templateRuntime.startedAt,
        error: identity.templateRuntime.error,
      },
      snapshotAt: identity.snapshotAt,
      error: identity.error,
      preparedProfiles: state.slots.filter((candidate) => candidate.identityId === identity.id && candidate.status === 'READY').length,
      activeSessions: state.sessionBrowsers.filter((browser) => browser.identityId === identity.id).length,
    })),
    sessionBrowser: binding ? {
      sessionId: binding.sessionId,
      identityId: binding.identityId,
      running: slot?.runtime.running === true,
      profileState: slot?.status ?? 'BROKEN',
    } : undefined,
    timeline: state.timeline
      .filter((event) => !/(?:^|[._])(lease|leased|release|control|private|takeover|broker)(?:$|[._])/.test(event.type.toLowerCase()))
      .map((event) => ({
        id: event.id,
        at: event.at,
        actor: event.actor,
        identityId: event.identityId,
        summary: event.summary,
      })),
  }
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const type = req.headers['content-type']?.split(';', 1)[0]?.trim().toLowerCase()
  if (type !== 'application/json') throw new BodyError(415, 'unsupported_media_type', 'content type must be application/json')
  const chunks: Buffer[] = []
  let bytes = 0
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    bytes += buffer.length
    if (bytes > MAX_BODY_BYTES) throw new BodyError(413, 'body_too_large', 'JSON body is too large')
    chunks.push(buffer)
  }
  let value: unknown
  try { value = JSON.parse(Buffer.concat(chunks).toString('utf8')) } catch { throw new BodyError(400, 'invalid_json', 'body is not valid JSON') }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new BodyError(400, 'invalid_body', 'JSON body must be an object')
  return value as Record<string, unknown>
}

async function servePng(res: ServerResponse, file: string): Promise<void> {
  try {
    const body = await readFile(file)
    res.writeHead(200, { ...securityHeaders(), 'content-type': 'image/png', 'cache-control': 'no-store', 'content-length': body.length })
    res.end(body)
  } catch { sendError(res, 404, 'not_found', 'screenshot is unavailable') }
}

async function serveNovnc(res: ServerResponse, root: string, rawRelative: string): Promise<void> {
  let relative: string
  try { relative = decodeURIComponent(rawRelative || 'vnc.html') } catch { return sendError(res, 400, 'bad_path', 'invalid noVNC path') }
  if (!relative || relative === '/') relative = 'vnc.html'
  const base = resolve(root)
  const file = resolve(base, relative)
  if (file !== base && !file.startsWith(base + sep)) return sendError(res, 403, 'forbidden', 'invalid noVNC path')
  try {
    if (!(await stat(file)).isFile()) return sendError(res, 404, 'not_found', 'noVNC asset not found')
    const body = await readFile(file)
    res.writeHead(200, {
      ...novncHeaders(),
      'content-type': mime(extname(file)),
      'cache-control': 'no-store',
      'content-length': body.length,
    })
    res.end(body)
  } catch {
    if (relative === 'package.json') return sendJson(res, 200, { name: '@novnc/novnc', version: 'system' })
    sendError(res, 404, 'not_found', 'noVNC asset not found')
  }
}

function sendJson(res: ServerResponse, status: number, value: unknown, extra: Record<string, string> = {}): void {
  if (res.writableEnded) return
  const body = JSON.stringify(value)
  res.writeHead(status, { ...securityHeaders(), ...extra, 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'content-length': Buffer.byteLength(body) })
  res.end(body)
}
function sendError(res: ServerResponse, status: number, code: string, message: string): void { sendJson(res, status, { ok: false, error: { code, message } }) }

function securityHeaders(): Record<string, string> {
  return {
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
    'x-frame-options': 'SAMEORIGIN',
    'content-security-policy': "default-src 'none'; frame-ancestors 'self'",
  }
}
function novncHeaders(): Record<string, string> {
  return {
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
    'x-frame-options': 'SAMEORIGIN',
    'content-security-policy': "default-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline' 'unsafe-eval'; connect-src 'self'; frame-ancestors 'self'",
  }
}
function mime(extension: string): string {
  const types: Record<string, string> = {
    '.html': 'text/html; charset=utf-8', '.js': 'application/javascript; charset=utf-8', '.mjs': 'application/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.woff': 'font/woff', '.woff2': 'font/woff2',
  }
  return types[extension.toLowerCase()] ?? 'application/octet-stream'
}
function rejectUpgrade(socket: Duplex, status: number, text: string): void {
  if (socket.destroyed) return
  socket.write('HTTP/1.1 ' + status + ' ' + text + '\r\nConnection: close\r\nContent-Length: 0\r\n\r\n')
  socket.destroy()
}
class BodyError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) { super(message) }
}
