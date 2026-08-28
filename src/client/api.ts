export const API = '/api/agent-browser-fleet'

export interface Identity {
  id: string
  name: string
  maxSlots: number
  templateState: 'NEEDS_LOGIN' | 'READY' | 'BROKEN'
  templateRuntime: { running: boolean; startedAt?: string; error?: string }
  snapshotAt?: string
  error?: string
  preparedProfiles: number
  activeSessions: number
}

export interface SessionBrowser {
  sessionId: string
  identityId: string
  running: boolean
  profileState: 'CREATING' | 'READY' | 'NEEDS_LOGIN' | 'BROKEN'
}

export interface AuditEvent {
  id: string
  at: string
  actor: 'agent' | 'user' | 'system'
  identityId?: string
  summary: string
}

export interface FleetState { identities: Identity[]; sessionBrowser?: SessionBrowser; timeline: AuditEvent[] }

export class AuthRequiredError extends Error {}

export async function authStatus(): Promise<boolean> {
  const response = await fetch(API + '/auth/status', { credentials: 'same-origin', cache: 'no-store' })
  if (!response.ok) throw new Error('Access status failed (' + response.status + ')')
  return Boolean((await response.json() as { authenticated?: unknown }).authenticated)
}

export async function login(token: string): Promise<void> {
  await request('/auth/login', { method: 'POST', body: JSON.stringify({ token }) }, false)
}

export async function loadState(sessionId: string): Promise<FleetState> {
  const value = await request('/state?sessionId=' + encodeURIComponent(sessionId)) as { state: FleetState }
  return value.state
}

export async function post(path: string, body: Record<string, unknown> = {}): Promise<unknown> {
  return request(path, { method: 'POST', body: JSON.stringify(body) })
}

async function request(path: string, init: RequestInit = {}, requireAuth = true): Promise<unknown> {
  const response = await fetch(API + path, {
    ...init,
    credentials: 'same-origin',
    cache: 'no-store',
    headers: { ...(init.body ? { 'content-type': 'application/json' } : {}), ...(init.headers ?? {}) },
  })
  const value = await response.json().catch(() => ({})) as { error?: { message?: unknown } }
  if (response.status === 401 && requireAuth) throw new AuthRequiredError('Agent Browser Fleet login required')
  if (!response.ok) throw new Error(typeof value.error?.message === 'string' ? value.error.message : 'Request failed (' + response.status + ')')
  return value
}
