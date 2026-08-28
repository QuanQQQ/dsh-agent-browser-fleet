import { randomBytes, timingSafeEqual } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import type { IncomingMessage } from 'node:http'
import { dirname } from 'node:path'

export const ACCESS_COOKIE = 'dsh_agent_browser_fleet'
export type AccessMode = 'dsh-session' | 'token'

export class AccessAuth {
  private token = ''

  constructor(
    private readonly tokenFile: string,
    readonly mode: AccessMode = accessMode(process.env.AGENT_BROWSER_FLEET_AUTH_MODE),
  ) {}

  async initialize(): Promise<void> {
    await mkdir(dirname(this.tokenFile), { recursive: true, mode: 0o700 })
    try {
      this.token = validateToken((await readFile(this.tokenFile, 'utf8')).trim())
      return
    } catch (error) {
      if (!isMissing(error)) throw error
    }
    const generated = randomBytes(32).toString('base64url')
    try { await writeFile(this.tokenFile, generated + '\n', { mode: 0o600, flag: 'wx' }) }
    catch (error) { if (!isExists(error)) throw error }
    this.token = validateToken((await readFile(this.tokenFile, 'utf8')).trim())
  }

  canBootstrap(req: IncomingMessage): boolean {
    if (this.mode !== 'dsh-session' || !hasSameOrigin(req, false)) return false
    const fetchSite = singleHeader(req.headers['sec-fetch-site'])
    if (fetchSite) return fetchSite === 'same-origin'
    const referer = singleHeader(req.headers.referer)
    if (!referer || !req.headers.host) return false
    try { return new URL(referer).host === req.headers.host } catch { return false }
  }

  login(candidate: unknown): boolean {
    return typeof candidate === 'string' && safeEqual(candidate, this.token)
  }

  authenticate(req: IncomingMessage): boolean {
    const cookies = parseCookies(req.headers.cookie)
    return safeEqual(cookies[ACCESS_COOKIE] ?? '', this.token)
  }

  cookieHeader(): string {
    return ACCESS_COOKIE + '=' + encodeURIComponent(this.token) + '; Path=/; HttpOnly; SameSite=Strict; Max-Age=86400'
  }
}

export function isTrustedAuthority(req: IncomingMessage, trustedHosts: readonly string[]): boolean {
  const host = req.headers.host
  if (!host) return false
  let parsed: URL
  try { parsed = new URL('http://' + host) } catch { return false }
  if (isLoopback(parsed.hostname)) return true
  return trustedHosts.some((entry) => authorityMatches(host, parsed.hostname, entry))
}

export function hasSameOrigin(req: IncomingMessage, required: boolean): boolean {
  const origin = req.headers.origin
  if (!origin) return !required
  try { return new URL(origin).host === req.headers.host } catch { return false }
}

function authorityMatches(host: string, hostname: string, entry: string): boolean {
  const normalized = entry.trim().toLowerCase()
  return normalized === host.toLowerCase() || normalized === hostname.toLowerCase()
}

function isLoopback(hostname: string): boolean {
  const value = hostname.replace(/^\[|\]$/g, '').toLowerCase()
  return value === 'localhost' || value === '::1' || /^127(?:\.\d{1,3}){3}$/.test(value)
}

function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = Object.create(null)
  for (const part of (header ?? '').split(';')) {
    const at = part.indexOf('=')
    if (at < 1) continue
    const key = part.slice(0, at).trim()
    try { out[key] = decodeURIComponent(part.slice(at + 1).trim()) } catch { /* ignore malformed cookie */ }
  }
  return out
}

export function accessMode(value: string | undefined): AccessMode {
  if (!value || value === 'dsh-session') return 'dsh-session'
  if (value === 'token') return 'token'
  throw new Error('AGENT_BROWSER_FLEET_AUTH_MODE must be dsh-session or token')
}

function singleHeader(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value
}

function safeEqual(left: string, right: string): boolean {
  const a = Buffer.from(left)
  const b = Buffer.from(right)
  return a.length === b.length && timingSafeEqual(a, b)
}

function validateToken(value: string): string {
  if (!/^[A-Za-z0-9_-]{40,80}$/.test(value)) throw new Error('Agent Browser Fleet access token file is invalid')
  return value
}

function isMissing(error: unknown): boolean { return errorCode(error) === 'ENOENT' }
function isExists(error: unknown): boolean { return errorCode(error) === 'EEXIST' }
function errorCode(error: unknown): unknown { return typeof error === 'object' && error !== null && 'code' in error ? (error as { code?: unknown }).code : undefined }
