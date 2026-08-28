import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { emptyFleetState, FLEET_STATE_VERSION, requireSessionId, type AuditEvent, type BrowserSlot, type FleetState, type SessionBrowser, type SlotStatus } from './domain.js'

const MAX_TIMELINE_EVENTS = 500
const SLOT_STATUSES = new Set<SlotStatus>(['CREATING', 'READY', 'NEEDS_LOGIN', 'BROKEN'])

export class FleetStore {
  private state: FleetState = emptyFleetState()
  private mutationTail: Promise<void> = Promise.resolve()

  constructor(private readonly file: string) {}

  async initialize(): Promise<void> {
    await mkdir(dirname(this.file), { recursive: true })
    try {
      const decoded = decodeStoredState(JSON.parse(await readFile(this.file, 'utf8')))
      this.state = decoded.state
      if (decoded.migrated) await this.persist(this.state)
    } catch (error) {
      if (!isMissing(error)) throw error
      await this.persist(this.state)
    }
  }

  snapshot(): FleetState { return structuredClone(this.state) }

  async mutate<T>(fn: (draft: FleetState) => T | Promise<T>): Promise<T> {
    const previous = this.mutationTail
    let release!: () => void
    this.mutationTail = new Promise<void>((resolve) => { release = resolve })
    await previous
    try {
      const draft = structuredClone(this.state)
      const result = await fn(draft)
      draft.version = FLEET_STATE_VERSION
      draft.timeline = draft.timeline.slice(-MAX_TIMELINE_EVENTS)
      validateV2(draft)
      await this.persist(draft)
      this.state = draft
      return result
    } finally {
      release()
    }
  }

  async audit(event: AuditEvent): Promise<void> {
    await this.mutate((draft) => { draft.timeline.push(event) })
  }

  private async persist(state: FleetState): Promise<void> {
    const temp = this.file + '.tmp.' + process.pid + '.' + Date.now()
    await writeFile(temp, JSON.stringify(state, null, 2) + '\n', { mode: 0o600 })
    await rename(temp, this.file)
  }
}

function decodeStoredState(value: unknown): { state: FleetState; migrated: boolean } {
  const input = record(value, 'state')
  if (input.version === FLEET_STATE_VERSION) return { state: validateV2(input), migrated: false }
  if (input.version === 1) return { state: validateV2(migrateV1(input)), migrated: true }
  throw new Error('agent-browser-fleet: unsupported state version ' + String(input.version))
}

function migrateV1(input: Record<string, unknown>): FleetState {
  const identities = array(input.identities, 'identities')
  const legacySlots = array(input.slots, 'slots').map((value, index) => record(value, 'slots[' + index + ']'))
  const timeline = array(input.timeline, 'timeline')
  const slots = legacySlots.map((legacy): BrowserSlot => {
    const { controlMode: _controlMode, lease: _lease, status, ...rest } = legacy
    const nextStatus: SlotStatus = status === 'CREATING' ? 'CREATING' : status === 'NEEDS_LOGIN' ? 'NEEDS_LOGIN' : status === 'BROKEN' ? 'BROKEN' : 'READY'
    return { ...structuredClone(rest), status: nextStatus } as unknown as BrowserSlot
  })

  const sessionBrowsers: SessionBrowser[] = []
  const claimedSessions = new Set<string>()
  const claimedSlots = new Set<string>()
  const candidates = legacySlots
    .filter((slot) => slot.status === 'LEASED' && slot.controlMode === 'AGENT')
    .sort((left, right) => timestamp(right.updatedAt) - timestamp(left.updatedAt))
  for (const slot of candidates) {
    const lease = typeof slot.lease === 'object' && slot.lease !== null ? slot.lease as Record<string, unknown> : undefined
    const owner = lease && typeof lease.owner === 'object' && lease.owner !== null ? lease.owner as Record<string, unknown> : undefined
    const sessionId = owner?.conversationId
    const slotId = slot.id
    const identityId = slot.identityId
    if (typeof sessionId !== 'string' || typeof slotId !== 'string' || typeof identityId !== 'string') continue
    if (claimedSessions.has(sessionId) || claimedSlots.has(slotId)) continue
    const at = typeof lease?.acquiredAt === 'string' ? lease.acquiredAt : typeof slot.updatedAt === 'string' ? slot.updatedAt : new Date(0).toISOString()
    sessionBrowsers.push({ sessionId, identityId, slotId, createdAt: at, updatedAt: typeof slot.updatedAt === 'string' ? slot.updatedAt : at })
    claimedSessions.add(sessionId)
    claimedSlots.add(slotId)
  }

  return {
    version: FLEET_STATE_VERSION,
    identities: structuredClone(identities) as FleetState['identities'],
    slots,
    sessionBrowsers,
    timeline: structuredClone(timeline) as FleetState['timeline'],
  }
}

function validateV2(value: unknown): FleetState {
  const input = record(value, 'state')
  if (input.version !== FLEET_STATE_VERSION) throw new Error('agent-browser-fleet: unsupported state version ' + String(input.version))
  const state = structuredClone(input) as unknown as FleetState
  if (!Array.isArray(state.identities) || !Array.isArray(state.slots) || !Array.isArray(state.sessionBrowsers) || !Array.isArray(state.timeline)) {
    throw new Error('agent-browser-fleet: state collections are invalid')
  }
  const identityIds = uniqueIds(state.identities, 'Identity')
  const slotIds = uniqueIds(state.slots, 'Slot')
  for (const slot of state.slots) {
    if (!SLOT_STATUSES.has(slot.status)) throw new Error('agent-browser-fleet: invalid Slot status ' + String(slot.status))
    if (!identityIds.has(slot.identityId)) throw new Error('agent-browser-fleet: Slot references missing Identity ' + slot.identityId)
  }
  const sessions = new Set<string>()
  const allocatedSlots = new Set<string>()
  const slotsById = new Map(state.slots.map((slot) => [slot.id, slot]))
  for (const browser of state.sessionBrowsers) {
    requireSessionId(browser.sessionId)
    if (sessions.has(browser.sessionId)) throw new Error('agent-browser-fleet: duplicate Session Browser for ' + browser.sessionId)
    if (allocatedSlots.has(browser.slotId)) throw new Error('agent-browser-fleet: Slot allocated to more than one session: ' + browser.slotId)
    const slot = slotsById.get(browser.slotId)
    if (!slot) throw new Error('agent-browser-fleet: Session Browser references missing Slot ' + browser.slotId)
    if (slot.identityId !== browser.identityId) throw new Error('agent-browser-fleet: Session Browser Identity does not match Slot')
    sessions.add(browser.sessionId)
    allocatedSlots.add(browser.slotId)
  }
  return state
}

function uniqueIds(values: Array<{ id: string }>, label: string): Set<string> {
  const ids = new Set<string>()
  for (const value of values) {
    if (typeof value?.id !== 'string' || !value.id) throw new Error('agent-browser-fleet: ' + label + ' id is invalid')
    if (ids.has(value.id)) throw new Error('agent-browser-fleet: duplicate ' + label + ' id ' + value.id)
    ids.add(value.id)
  }
  return ids
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('agent-browser-fleet: ' + label + ' must be an object')
  return value as Record<string, unknown>
}

function array(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) throw new Error('agent-browser-fleet: ' + label + ' must be an array')
  return value
}

function timestamp(value: unknown): number {
  if (typeof value !== 'string') return 0
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? parsed : 0
}

function isMissing(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && (error as { code?: unknown }).code === 'ENOENT'
}
