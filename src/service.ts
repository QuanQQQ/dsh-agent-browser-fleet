import { randomUUID } from 'node:crypto'
import { mkdir, rename, rm, stat, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { CdpClient } from './cdp.js'
import {
  CapacityError,
  ConflictError,
  FleetError,
  NotFoundError,
  assertSlotTransition,
  requireId,
  requireMaxSlots,
  requireName,
  requireSessionId,
  type AuditEvent,
  type BrowserIdentity,
  type BrowserSlot,
  type FleetState,
  type SessionBrowser,
} from './domain.js'
import { ProfileCloner } from './profile-cloner.js'
import { DevboxChromeRuntime } from './runtime.js'
import { FleetStore } from './store.js'

export interface FleetServiceOptions {
  root: string
  store: FleetStore
  runtime: DevboxChromeRuntime
  cloner: ProfileCloner
  cdp: CdpClient
  now?: () => Date
  uuid?: () => string
  screenshotIntervalMs?: number
}

export interface VncTarget {
  instanceName: string
  vncPort: number
  password: string
}

export class FleetService {
  private readonly root: string
  private readonly store: FleetStore
  private readonly runtime: DevboxChromeRuntime
  private readonly cloner: ProfileCloner
  private readonly cdp: CdpClient
  private readonly now: () => Date
  private readonly uuid: () => string
  private readonly screenshotIntervalMs: number
  private readonly identityTails = new Map<string, Promise<void>>()
  private allocationTail: Promise<void> = Promise.resolve()
  private readonly activeCaptures = new Map<string, Set<AbortController>>()

  constructor(options: FleetServiceOptions) {
    this.root = options.root
    this.store = options.store
    this.runtime = options.runtime
    this.cloner = options.cloner
    this.cdp = options.cdp
    this.now = options.now ?? (() => new Date())
    this.uuid = options.uuid ?? randomUUID
    this.screenshotIntervalMs = options.screenshotIntervalMs ?? 15_000
  }

  async initialize(): Promise<void> {
    await mkdir(this.identitiesRoot(), { recursive: true, mode: 0o700 })
    await mkdir(this.screenshotsRoot(), { recursive: true, mode: 0o700 })
    await mkdir(this.mcpOutputRoot(), { recursive: true, mode: 0o700 })
    await this.store.initialize()
    await this.reconcileRuntimeState()
  }

  state(): FleetState { return this.store.snapshot() }

  async doctor(signal?: AbortSignal): Promise<{ ok: boolean; output: string }> {
    return this.runtime.doctor(signal)
  }

  startScreenshotLoop(): () => void {
    const timer = setInterval(() => { void this.captureScreenshots() }, this.screenshotIntervalMs)
    timer.unref()
    return () => clearInterval(timer)
  }

  async createIdentity(input: { name: unknown; maxSlots?: unknown }): Promise<BrowserIdentity> {
    const name = requireName(input.name)
    const maxSlots = requireMaxSlots(input.maxSlots)
    const existing = this.store.snapshot().identities.find((identity) => identity.name.toLocaleLowerCase() === name.toLocaleLowerCase())
    if (existing) throw new ConflictError('duplicate_identity', 'an Identity with this name already exists')
    const id = this.makeId('identity')
    const now = this.timestamp()
    const identity: BrowserIdentity = {
      id,
      name,
      maxSlots,
      templateState: 'NEEDS_LOGIN',
      templateInstanceName: 'abf-t-' + shortId(id),
      templateRuntime: { running: false },
      createdAt: now,
      updatedAt: now,
    }
    await mkdir(this.templateProfilePath(id), { recursive: true, mode: 0o700 })
    await this.store.mutate((draft) => {
      if (draft.identities.some((candidate) => candidate.name.toLocaleLowerCase() === name.toLocaleLowerCase())) {
        throw new ConflictError('duplicate_identity', 'an Identity with this name already exists')
      }
      draft.identities.push(identity)
      this.pushAudit(draft, { type: 'identity.created', actor: 'user', identityId: id, summary: 'Identity created' })
    })
    return structuredClone(identity)
  }

  async startTemplateLogin(identityIdValue: unknown, signal?: AbortSignal): Promise<BrowserIdentity> {
    const identityId = requireId(identityIdValue, 'identityId')
    return this.withIdentityLock(identityId, async () => {
      const identity = this.requireIdentity(identityId)
      if (identity.templateRuntime.running) return identity
      try {
        const status = await this.runtime.start(identity.templateInstanceName, this.templateProfilePath(identity.id), 'about:blank', signal)
        return await this.store.mutate((draft) => {
          const current = requireIdentityFrom(draft, identityId)
          current.templateRuntime = { running: true, ports: status.ports, startedAt: this.timestamp() }
          current.updatedAt = this.timestamp()
          delete current.error
          this.pushAudit(draft, {
            type: 'template.login_started', actor: 'user', identityId,
            summary: 'Identity template login started outside any Session Browser',
          })
          return structuredClone(current)
        })
      } catch (error) {
        await this.markIdentityError(identityId, error)
        throw error
      }
    })
  }

  async snapshotTemplate(identityIdValue: unknown, signal?: AbortSignal): Promise<BrowserIdentity> {
    const identityId = requireId(identityIdValue, 'identityId')
    return this.withIdentityLock(identityId, async () => {
      const identity = this.requireIdentity(identityId)
      if (!identity.templateRuntime.running) {
        throw new ConflictError('template_not_running', 'Template browser must be running to prove a clean shutdown before snapshot')
      }
      const profile = this.templateProfilePath(identityId)
      try {
        await this.runtime.cleanStop(identity.templateInstanceName, profile, signal)
        await this.store.mutate((draft) => {
          const current = requireIdentityFrom(draft, identityId)
          current.templateRuntime = { running: false, ports: current.templateRuntime.ports }
          current.updatedAt = this.timestamp()
        })
        await stat(join(profile, 'Local State'))
        const next = this.templateSnapshotPath(identityId) + '.next'
        const previous = this.templateSnapshotPath(identityId) + '.previous'
        await rm(next, { recursive: true, force: true })
        await rm(previous, { recursive: true, force: true })
        await this.cloner.copy(profile, next, signal)
        await stat(join(next, 'Local State'))
        await this.cloner.makeReadOnly(next)
        const currentSnapshot = this.templateSnapshotPath(identityId)
        const hadCurrent = await pathExists(currentSnapshot)
        if (hadCurrent) await rename(currentSnapshot, previous)
        try { await rename(next, currentSnapshot) } catch (error) {
          if (hadCurrent) await rename(previous, currentSnapshot).catch(() => undefined)
          throw error
        }
        await rm(previous, { recursive: true, force: true })
        return await this.store.mutate((draft) => {
          const current = requireIdentityFrom(draft, identityId)
          current.templateState = 'READY'
          current.snapshotAt = this.timestamp()
          current.templateRuntime = { running: false, ports: current.templateRuntime.ports }
          current.updatedAt = this.timestamp()
          delete current.error
          this.pushAudit(draft, {
            type: 'template.snapshot_created', actor: 'user', identityId,
            summary: 'Template snapshot created after clean Chromium shutdown',
          })
          return structuredClone(current)
        })
      } catch (error) {
        await this.markIdentityError(identityId, error)
        throw error
      }
    })
  }

  sessionBrowser(sessionIdValue: unknown): SessionBrowser | undefined {
    const sessionId = requireSessionId(sessionIdValue)
    return this.store.snapshot().sessionBrowsers.find((browser) => browser.sessionId === sessionId)
  }

  async useIdentity(sessionIdValue: unknown, identityIdValue: unknown, signal?: AbortSignal): Promise<SessionBrowser> {
    const sessionId = requireSessionId(sessionIdValue)
    const identityId = requireId(identityIdValue, 'identityId')
    return this.withAllocationLock(async () => {
      const existing = this.sessionBrowser(sessionId)
      if (existing?.identityId === identityId) {
        await this.ensureSlotRuntime(this.requireSlot(existing.slotId), signal)
        return this.sessionBrowser(sessionId)!
      }
      if (existing) await this.stopBinding(existing, signal)
      const identity = this.requireIdentity(identityId)
      if (identity.templateState !== 'READY') throw new ConflictError('template_not_ready', 'Identity template must be logged in and snapshotted first')
      const allocated = new Set(this.store.snapshot().sessionBrowsers.map((browser) => browser.slotId))
      let slot = this.store.snapshot().slots.find((candidate) => candidate.identityId === identityId && candidate.status === 'READY' && !allocated.has(candidate.id))
      if (!slot) {
        const count = this.store.snapshot().slots.filter((candidate) => candidate.identityId === identityId).length
        if (count >= identity.maxSlots) throw new CapacityError('Identity has no available browser capacity and has reached maxSlots')
        slot = await this.createSlot(identity, count + 1, signal)
      }
      const now = this.timestamp()
      const binding: SessionBrowser = { sessionId, identityId, slotId: slot.id, createdAt: now, updatedAt: now }
      await this.store.mutate((draft) => {
        draft.sessionBrowsers.push(binding)
        this.pushAudit(draft, {
          type: 'session_browser.bound', actor: 'agent', identityId, slotId: slot!.id,
          summary: 'Identity bound to DSH Session Browser', details: { sessionId },
        })
      })
      try {
        await this.ensureSlotRuntime(slot, signal)
      } catch (error) {
        await this.store.mutate((draft) => {
          draft.sessionBrowsers = draft.sessionBrowsers.filter((browser) => browser.sessionId !== sessionId)
        })
        throw error
      }
      return this.sessionBrowser(sessionId)!
    })
  }

  async stopSessionBrowser(sessionIdValue: unknown, signal?: AbortSignal): Promise<SessionBrowser | undefined> {
    const sessionId = requireSessionId(sessionIdValue)
    return this.withAllocationLock(async () => {
      const binding = this.sessionBrowser(sessionId)
      if (!binding) return undefined
      await this.stopBinding(binding, signal)
      return binding
    })
  }

  browserMcpTarget(sessionIdValue: unknown): { slotId: string; cdpEndpoint: string; outputDir: string } {
    const sessionId = requireSessionId(sessionIdValue)
    const binding = this.sessionBrowser(sessionId)
    if (!binding) throw new ConflictError('identity_not_selected', 'Select an Identity with agent_browser_use_identity before using browser tools')
    const slot = this.requireSlot(binding.slotId)
    if (!slot.runtime.running || !slot.runtime.ports) throw new ConflictError('runtime_not_running', 'Session Browser runtime is not running')
    return {
      slotId: slot.id,
      cdpEndpoint: 'http://127.0.0.1:' + slot.runtime.ports.cdp,
      outputDir: join(this.mcpOutputRoot(), slot.id),
    }
  }

  async templateVncTarget(identityIdValue: unknown): Promise<VncTarget> {
    const identity = this.requireIdentity(requireId(identityIdValue, 'identityId'))
    if (!identity.templateRuntime.running || !identity.templateRuntime.ports) throw new ConflictError('runtime_not_running', 'template browser is not running')
    return {
      instanceName: identity.templateInstanceName,
      vncPort: identity.templateRuntime.ports.vnc,
      password: await this.runtime.vncPassword(identity.templateInstanceName),
    }
  }

  async sessionVncTarget(sessionIdValue: unknown): Promise<VncTarget> {
    const binding = this.sessionBrowser(sessionIdValue)
    if (!binding) throw new NotFoundError('Session Browser not found')
    const slot = this.requireSlot(binding.slotId)
    if (!slot.runtime.running || !slot.runtime.ports) throw new ConflictError('runtime_not_running', 'Session Browser runtime is not running')
    return { instanceName: slot.instanceName, vncPort: slot.runtime.ports.vnc, password: await this.runtime.vncPassword(slot.instanceName) }
  }

  screenshotPathForSession(sessionIdValue: unknown): string {
    const binding = this.sessionBrowser(sessionIdValue)
    if (!binding) throw new NotFoundError('Session Browser not found')
    return this.screenshotPath(binding.slotId)
  }

  private async createSlot(identity: BrowserIdentity, ordinal: number, signal?: AbortSignal): Promise<BrowserSlot> {
    const id = this.makeId('slot')
    const now = this.timestamp()
    const slot: BrowserSlot = {
      id,
      identityId: identity.id,
      ordinal,
      instanceName: 'abf-s-' + shortId(id),
      status: 'CREATING',
      runtime: { running: false },
      createdAt: now,
      updatedAt: now,
    }
    await this.store.mutate((draft) => {
      draft.slots.push(slot)
      this.pushAudit(draft, { type: 'slot.creating', actor: 'system', identityId: identity.id, slotId: id, summary: 'Creating reusable browser profile from Template Snapshot' })
    })
    try {
      const result = await this.cloner.copy(this.templateSnapshotPath(identity.id), this.slotProfilePath(identity.id, id), signal)
      await this.cloner.makeOwnerWritable(this.slotProfilePath(identity.id, id))
      return await this.store.mutate((draft) => {
        const current = requireSlotFrom(draft, id)
        assertSlotTransition(current.status, 'READY')
        current.status = 'READY'
        current.cloneMode = result.mode
        current.updatedAt = this.timestamp()
        this.pushAudit(draft, {
          type: 'slot.created', actor: 'system', identityId: identity.id, slotId: id,
          summary: 'Reusable browser profile created', details: { cloneMode: result.mode },
        })
        return structuredClone(current)
      })
    } catch (error) {
      await this.markSlotBroken(id, error)
      throw error
    }
  }

  private async ensureSlotRuntime(slot: BrowserSlot, signal?: AbortSignal): Promise<BrowserSlot> {
    if (slot.status !== 'READY') throw new ConflictError('browser_profile_not_ready', 'Session Browser profile is not ready')
    if (slot.runtime.running) return slot
    try {
      const status = await this.runtime.start(slot.instanceName, this.slotProfilePath(slot.identityId, slot.id), 'about:blank', signal)
      return await this.store.mutate((draft) => {
        const current = requireSlotFrom(draft, slot.id)
        current.runtime = { running: true, ports: status.ports, startedAt: this.timestamp(), loopbackVerified: status.loopbackVerified }
        current.updatedAt = this.timestamp()
        delete current.error
        return structuredClone(current)
      })
    } catch (error) {
      await this.markSlotBroken(slot.id, error)
      throw error
    }
  }

  private async stopBinding(binding: SessionBrowser, signal?: AbortSignal): Promise<void> {
    const slot = this.requireSlot(binding.slotId)
    this.abortCaptures(slot.id)
    try {
      if (slot.runtime.running) await this.runtime.cleanStop(slot.instanceName, this.slotProfilePath(slot.identityId, slot.id), signal)
      await unlink(this.screenshotPath(slot.id)).catch(() => undefined)
      await this.store.mutate((draft) => {
        draft.sessionBrowsers = draft.sessionBrowsers.filter((browser) => browser.sessionId !== binding.sessionId)
        const current = requireSlotFrom(draft, slot.id)
        current.runtime = { running: false, ports: current.runtime.ports, loopbackVerified: current.runtime.loopbackVerified }
        current.updatedAt = this.timestamp()
        this.pushAudit(draft, {
          type: 'session_browser.stopped', actor: 'system', identityId: current.identityId, slotId: current.id,
          summary: 'Session Browser stopped with its reusable profile preserved', details: { sessionId: binding.sessionId },
        })
      })
    } catch (error) {
      await this.markSlotBroken(slot.id, error)
      throw error
    }
  }

  private async captureScreenshots(): Promise<void> {
    const state = this.store.snapshot()
    const byId = new Map(state.slots.map((slot) => [slot.id, slot]))
    const candidates = state.sessionBrowsers.map((browser) => byId.get(browser.slotId)).filter((slot): slot is BrowserSlot => Boolean(slot?.runtime.running && slot.runtime.ports))
    await Promise.all(candidates.map(async (slot) => {
      const controller = this.registerCapture(slot.id)
      try { await this.cdp.captureToFile(slot.runtime.ports!.cdp, this.screenshotPath(slot.id), controller.signal) }
      catch { /* low-frequency observation is best effort */ }
      finally { this.unregisterCapture(slot.id, controller) }
    }))
  }

  private async reconcileRuntimeState(): Promise<void> {
    const snapshot = this.store.snapshot()
    for (const identity of snapshot.identities) {
      try {
        const status = await this.runtime.status(identity.templateInstanceName)
        await this.store.mutate((draft) => {
          const current = requireIdentityFrom(draft, identity.id)
          current.templateRuntime = { running: status.running, ports: status.ports, startedAt: status.running ? current.templateRuntime.startedAt : undefined }
        })
      } catch { /* doctor/UI will expose unavailable runtime */ }
    }
    for (const slot of snapshot.slots) {
      try {
        const status = await this.runtime.status(slot.instanceName)
        await this.store.mutate((draft) => {
          const current = requireSlotFrom(draft, slot.id)
          current.runtime = { ...current.runtime, running: status.running, ports: status.ports, loopbackVerified: status.loopbackVerified }
        })
      } catch { /* retain persisted state for explicit repair */ }
    }
    const reconciled = this.store.snapshot()
    const bound = new Set(reconciled.sessionBrowsers.map((browser) => browser.slotId))
    for (const slot of reconciled.slots) {
      if (bound.has(slot.id) && slot.status === 'READY' && !slot.runtime.running) {
        await this.ensureSlotRuntime(slot).catch(() => undefined)
      } else if (!bound.has(slot.id) && slot.runtime.running) {
        try {
          await this.runtime.cleanStop(slot.instanceName, this.slotProfilePath(slot.identityId, slot.id))
          await this.store.mutate((draft) => { requireSlotFrom(draft, slot.id).runtime.running = false })
        } catch (error) {
          await this.markSlotBroken(slot.id, error)
        }
      }
    }
  }

  private requireIdentity(id: string): BrowserIdentity {
    const identity = this.store.snapshot().identities.find((candidate) => candidate.id === id)
    if (!identity) throw new NotFoundError('Identity not found: ' + id)
    return identity
  }

  private requireSlot(id: string): BrowserSlot {
    const slot = this.store.snapshot().slots.find((candidate) => candidate.id === id)
    if (!slot) throw new NotFoundError('Slot not found: ' + id)
    return slot
  }

  private async markIdentityError(id: string, error: unknown): Promise<void> {
    await this.store.mutate((draft) => {
      const identity = requireIdentityFrom(draft, id)
      identity.templateState = 'BROKEN'
      identity.templateRuntime.running = false
      identity.error = errorMessage(error)
      identity.updatedAt = this.timestamp()
      this.pushAudit(draft, { type: 'identity.broken', actor: 'system', identityId: id, summary: 'Identity operation failed', details: { error: identity.error.slice(0, 300) } })
    })
  }

  private async markSlotBroken(id: string, error: unknown): Promise<void> {
    await this.store.mutate((draft) => {
      const slot = requireSlotFrom(draft, id)
      assertSlotTransition(slot.status, 'BROKEN')
      slot.status = 'BROKEN'
      slot.runtime.running = false
      slot.error = errorMessage(error)
      slot.updatedAt = this.timestamp()
      draft.sessionBrowsers = draft.sessionBrowsers.filter((browser) => browser.slotId !== id)
      this.pushAudit(draft, { type: 'slot.broken', actor: 'system', identityId: slot.identityId, slotId: id, summary: 'Browser profile operation failed', details: { error: slot.error.slice(0, 300) } })
    })
  }

  private registerCapture(slotId: string): AbortController {
    const controller = new AbortController()
    let set = this.activeCaptures.get(slotId)
    if (!set) { set = new Set(); this.activeCaptures.set(slotId, set) }
    set.add(controller)
    return controller
  }

  private unregisterCapture(slotId: string, controller: AbortController): void {
    const set = this.activeCaptures.get(slotId)
    set?.delete(controller)
    if (set?.size === 0) this.activeCaptures.delete(slotId)
  }

  private abortCaptures(slotId: string): void {
    for (const controller of this.activeCaptures.get(slotId) ?? []) controller.abort(new Error('Session Browser stopped'))
    this.activeCaptures.delete(slotId)
  }

  private identityPath(id: string): string { return join(this.identitiesRoot(), id) }
  private identitiesRoot(): string { return join(this.root, 'identities') }
  private templateProfilePath(id: string): string { return join(this.identityPath(id), 'template-profile') }
  private templateSnapshotPath(id: string): string { return join(this.identityPath(id), 'template-snapshot') }
  private slotProfilePath(identityId: string, slotId: string): string { return join(this.identityPath(identityId), 'slots', slotId, 'profile') }
  private screenshotsRoot(): string { return join(this.root, 'screenshots') }
  private screenshotPath(slotId: string): string { return join(this.screenshotsRoot(), slotId + '.png') }
  private mcpOutputRoot(): string { return join(this.root, 'mcp-output') }
  private timestamp(): string { return this.now().toISOString() }
  private makeId(prefix: string): string { return prefix + '-' + this.uuid().replace(/[^a-zA-Z0-9]/g, '').toLowerCase().slice(0, 16) }

  private auditEvent(event: Omit<AuditEvent, 'id' | 'at'>): AuditEvent {
    return { id: this.makeId('event'), at: this.timestamp(), ...event }
  }
  private pushAudit(state: FleetState, event: Omit<AuditEvent, 'id' | 'at'>): void { state.timeline.push(this.auditEvent(event)) }

  private withIdentityLock<T>(id: string, operation: () => Promise<T>): Promise<T> { return this.withKeyLock(this.identityTails, id, operation) }

  private async withAllocationLock<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.allocationTail
    let release!: () => void
    this.allocationTail = new Promise<void>((resolve) => { release = resolve })
    await previous
    try { return await operation() } finally { release() }
  }

  private async withKeyLock<T>(tails: Map<string, Promise<void>>, key: string, operation: () => Promise<T>): Promise<T> {
    const previous = tails.get(key) ?? Promise.resolve()
    let release!: () => void
    const current = new Promise<void>((resolve) => { release = resolve })
    tails.set(key, current)
    await previous
    try { return await operation() }
    finally {
      release()
      if (tails.get(key) === current) tails.delete(key)
    }
  }
}

function requireIdentityFrom(state: FleetState, id: string): BrowserIdentity {
  const identity = state.identities.find((candidate) => candidate.id === id)
  if (!identity) throw new NotFoundError('Identity not found: ' + id)
  return identity
}

function requireSlotFrom(state: FleetState, id: string): BrowserSlot {
  const slot = state.slots.find((candidate) => candidate.id === id)
  if (!slot) throw new NotFoundError('Slot not found: ' + id)
  return slot
}

function errorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error) }
function shortId(value: string): string { return value.replace(/[^a-z0-9]/g, '').slice(-16) }
async function pathExists(path: string): Promise<boolean> { try { await stat(path); return true } catch { return false } }
