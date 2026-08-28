export const FLEET_STATE_VERSION = 2 as const

export type SlotStatus = 'CREATING' | 'READY' | 'NEEDS_LOGIN' | 'BROKEN'
export type TemplateState = 'NEEDS_LOGIN' | 'READY' | 'BROKEN'
export type CloneMode = 'reflink' | 'copy'

export interface BrowserPorts {
  cdp: number
  vnc: number
  novnc: number
  whistle: number
  display: number
}

export interface TemplateRuntime {
  running: boolean
  ports?: BrowserPorts
  startedAt?: string
  error?: string
}

export interface BrowserIdentity {
  id: string
  name: string
  maxSlots: number
  templateState: TemplateState
  templateInstanceName: string
  templateRuntime: TemplateRuntime
  snapshotAt?: string
  createdAt: string
  updatedAt: string
  error?: string
}

/** Internal reusable profile capacity. Never expose it as an Agent lease. */
export interface BrowserSlot {
  id: string
  identityId: string
  ordinal: number
  instanceName: string
  status: SlotStatus
  cloneMode?: CloneMode
  runtime: {
    running: boolean
    ports?: BrowserPorts
    startedAt?: string
    loopbackVerified?: boolean
  }
  createdAt: string
  updatedAt: string
  error?: string
}

export interface SessionBrowser {
  sessionId: string
  identityId: string
  slotId: string
  createdAt: string
  updatedAt: string
}

export interface AuditEvent {
  id: string
  at: string
  type: string
  actor: 'agent' | 'user' | 'system'
  identityId?: string
  slotId?: string
  summary: string
  details?: Record<string, string | number | boolean | null>
}

export interface FleetState {
  version: typeof FLEET_STATE_VERSION
  identities: BrowserIdentity[]
  slots: BrowserSlot[]
  sessionBrowsers: SessionBrowser[]
  timeline: AuditEvent[]
}

export function emptyFleetState(): FleetState {
  return { version: FLEET_STATE_VERSION, identities: [], slots: [], sessionBrowsers: [], timeline: [] }
}

export class FleetError extends Error {
  constructor(readonly code: string, message: string, readonly status = 400) { super(message) }
}
export class NotFoundError extends FleetError {
  constructor(message: string) { super('not_found', message, 404) }
}
export class ConflictError extends FleetError {
  constructor(code: string, message: string) { super(code, message, 409) }
}
export class ForbiddenError extends FleetError {
  constructor(code: string, message: string) { super(code, message, 403) }
}
export class CapacityError extends FleetError {
  constructor(message: string) { super('capacity_exhausted', message, 409) }
}

export function requireId(value: unknown, label = 'id'): string {
  if (typeof value !== 'string' || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(value)) {
    throw new FleetError('invalid_id', label + ' must match [a-z0-9][a-z0-9-]{0,63}')
  }
  return value
}

export function requireSessionId(value: unknown): string {
  if (typeof value !== 'string' || value.length < 1 || value.length > 200 || /[\x00-\x1f]/.test(value)) {
    throw new FleetError('invalid_session_id', 'sessionId must be a printable string of at most 200 characters')
  }
  return value
}

export function requireName(value: unknown): string {
  if (typeof value !== 'string') throw new FleetError('invalid_name', 'name must be a string')
  const name = value.trim()
  if (name.length < 1 || name.length > 80) throw new FleetError('invalid_name', 'name must contain 1-80 characters')
  return name
}

export function requireMaxSlots(value: unknown): number {
  const max = value === undefined ? 2 : value
  if (!Number.isSafeInteger(max) || (max as number) < 1 || (max as number) > 32) {
    throw new FleetError('invalid_max_slots', 'maxSlots must be an integer from 1 to 32')
  }
  return max as number
}

export function assertSlotTransition(from: SlotStatus, to: SlotStatus): void {
  if (from === to) return
  const allowed: Record<SlotStatus, readonly SlotStatus[]> = {
    CREATING: ['READY', 'BROKEN'],
    READY: ['NEEDS_LOGIN', 'BROKEN'],
    NEEDS_LOGIN: ['READY', 'BROKEN'],
    BROKEN: ['CREATING', 'READY'],
  }
  if (!allowed[from].includes(to)) throw new ConflictError('invalid_transition', 'slot cannot transition from ' + from + ' to ' + to)
}
