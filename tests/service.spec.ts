import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import type { CdpClient } from '../src/cdp.js'
import { CapacityError, type BrowserPorts } from '../src/domain.js'
import { ProfileCloner } from '../src/profile-cloner.js'
import type { DevboxChromeRuntime, RuntimeStatus } from '../src/runtime.js'
import { FleetService } from '../src/service.js'
import { FleetStore } from '../src/store.js'

class FakeRuntime {
  readonly running = new Map<string, boolean>()
  readonly cleanStops: string[] = []
  failCleanStop = false
  private readonly ports = new Map<string, BrowserPorts>()
  async doctor() { return { ok: true, output: 'ok' } }
  async start(instance: string): Promise<RuntimeStatus> { this.running.set(instance, true); return { running: true, ports: this.port(instance), loopbackVerified: true } }
  async status(instance: string): Promise<RuntimeStatus> { return { running: this.running.get(instance) ?? false, ports: this.port(instance), loopbackVerified: true } }
  async cleanStop(instance: string): Promise<BrowserPorts> {
    this.cleanStops.push(instance)
    if (this.failCleanStop) throw new Error('clean close failed')
    this.running.set(instance, false)
    return this.port(instance)
  }
  async forceStop(instance: string) { this.running.set(instance, false) }
  async vncPassword() { return 'secret12' }
  private port(instance: string): BrowserPorts {
    let value = this.ports.get(instance)
    if (!value) {
      const offset = this.ports.size + 1
      value = { cdp: 9222 + offset, vnc: 5900 + offset, novnc: 6080 + offset, whistle: 8899 + offset, display: 99 + offset }
      this.ports.set(instance, value)
    }
    return value
  }
}

class FakeCdp {
  async captureToFile(_port: number, file: string) { await writeFile(file, 'png') }
}

async function fixture(maxSlots = 2) {
  const root = await mkdtemp(join(tmpdir(), 'abf-service-'))
  const store = new FleetStore(join(root, 'state.json'))
  const runtime = new FakeRuntime()
  const cdp = new FakeCdp()
  let sequence = 0
  const service = new FleetService({
    root,
    store,
    runtime: runtime as unknown as DevboxChromeRuntime,
    cloner: new ProfileCloner(),
    cdp: cdp as unknown as CdpClient,
    uuid: () => (++sequence).toString(16).padStart(16, '0') + 'abcdef0123456789',
    screenshotIntervalMs: 20,
  })
  await service.initialize()
  const identity = await service.createIdentity({ name: 'Work account', maxSlots })
  const snapshot = join(root, 'identities', identity.id, 'template-snapshot')
  await mkdir(snapshot, { recursive: true })
  await writeFile(join(snapshot, 'Local State'), '{"account":"work"}')
  await writeFile(join(snapshot, 'Cookies'), 'auth-token')
  await store.mutate((draft) => {
    const current = draft.identities.find((candidate) => candidate.id === identity.id)!
    current.templateState = 'READY'
    current.snapshotAt = new Date().toISOString()
  })
  return { root, store, runtime, cdp, service, identity }
}

test('two sessions get independent Session Browsers and capacity never preempts', async () => {
  const { service, identity } = await fixture(2)
  const browserA = await service.useIdentity('session-a', identity.id)
  const sameBrowser = await service.useIdentity('session-a', identity.id)
  const browserB = await service.useIdentity('session-b', identity.id)
  assert.equal(sameBrowser.slotId, browserA.slotId)
  assert.notEqual(browserA.slotId, browserB.slotId)
  assert.equal(browserA.sessionId, 'session-a')
  assert.equal(browserB.sessionId, 'session-b')
  const slots = service.state().slots
  assert.equal(slots.find((slot) => slot.id === browserA.slotId)?.status, 'READY')
  assert.notEqual(slots.find((slot) => slot.id === browserA.slotId)?.instanceName, slots.find((slot) => slot.id === browserB.slotId)?.instanceName)
  await assert.rejects(() => service.useIdentity('session-c', identity.id), CapacityError)
  assert.equal(service.sessionBrowser('session-a')?.slotId, browserA.slotId)
})

test('stopping a Session Browser preserves its independent profile for reuse', async () => {
  const { root, service, identity, runtime } = await fixture(1)
  const browser = await service.useIdentity('session-a', identity.id)
  const slot = service.state().slots.find((candidate) => candidate.id === browser.slotId)!
  const profile = join(root, 'identities', identity.id, 'slots', slot.id, 'profile')
  await writeFile(join(profile, 'slot-only.txt'), 'changed')
  const stopped = await service.stopSessionBrowser('session-a')
  assert.equal(stopped?.slotId, slot.id)
  assert.equal(service.sessionBrowser('session-a'), undefined)
  assert.equal(service.state().slots.find((candidate) => candidate.id === slot.id)?.runtime.running, false)
  assert.equal(await readFile(join(profile, 'slot-only.txt'), 'utf8'), 'changed')
  assert.deepEqual(runtime.cleanStops, [slot.instanceName])
})

test('template snapshot requires clean stop and includes Local State in read-only snapshot', async () => {
  const root = await mkdtemp(join(tmpdir(), 'abf-snapshot-'))
  const store = new FleetStore(join(root, 'state.json'))
  const runtime = new FakeRuntime()
  const cdp = new FakeCdp()
  let sequence = 0
  const service = new FleetService({ root, store, runtime: runtime as unknown as DevboxChromeRuntime, cloner: new ProfileCloner(), cdp: cdp as unknown as CdpClient, uuid: () => String(++sequence).padStart(16, '0') + 'abcdef' })
  await service.initialize()
  const identity = await service.createIdentity({ name: 'Template', maxSlots: 2 })
  await service.startTemplateLogin(identity.id)
  const profile = join(root, 'identities', identity.id, 'template-profile')
  await writeFile(join(profile, 'Local State'), '{"os_crypt":"key"}')
  await writeFile(join(profile, 'Cookies'), 'logged-in')
  const snapshotted = await service.snapshotTemplate(identity.id)
  const snapshot = join(root, 'identities', identity.id, 'template-snapshot')
  assert.equal(snapshotted.templateState, 'READY')
  assert.equal(snapshotted.templateRuntime.running, false)
  assert.equal(await readFile(join(snapshot, 'Local State'), 'utf8'), '{"os_crypt":"key"}')
  assert.equal((await stat(join(snapshot, 'Local State'))).mode & 0o222, 0)
  assert.deepEqual(runtime.cleanStops, [identity.templateInstanceName])
})

test('failed clean close refuses snapshot and marks Identity broken', async () => {
  const root = await mkdtemp(join(tmpdir(), 'abf-bad-snapshot-'))
  const store = new FleetStore(join(root, 'state.json'))
  const runtime = new FakeRuntime()
  runtime.failCleanStop = true
  const cdp = new FakeCdp()
  const service = new FleetService({ root, store, runtime: runtime as unknown as DevboxChromeRuntime, cloner: new ProfileCloner(), cdp: cdp as unknown as CdpClient })
  await service.initialize()
  const identity = await service.createIdentity({ name: 'Unsafe', maxSlots: 1 })
  await service.startTemplateLogin(identity.id)
  const profile = join(root, 'identities', identity.id, 'template-profile')
  await writeFile(join(profile, 'Local State'), '{}')
  await assert.rejects(() => service.snapshotTemplate(identity.id), /clean close failed/)
  assert.equal(service.state().identities[0].templateState, 'BROKEN')
  await assert.rejects(() => stat(join(root, 'identities', identity.id, 'template-snapshot')))
})

test('snapshot refuses a template that is not currently running', async () => {
  const root = await mkdtemp(join(tmpdir(), 'abf-stopped-template-'))
  const store = new FleetStore(join(root, 'state.json'))
  const runtime = new FakeRuntime()
  const cdp = new FakeCdp()
  const service = new FleetService({ root, store, runtime: runtime as unknown as DevboxChromeRuntime, cloner: new ProfileCloner(), cdp: cdp as unknown as CdpClient })
  await service.initialize()
  const identity = await service.createIdentity({ name: 'Never started', maxSlots: 1 })
  const profile = join(root, 'identities', identity.id, 'template-profile')
  await writeFile(join(profile, 'Local State'), '{}')
  await assert.rejects(() => service.snapshotTemplate(identity.id), /must be running/)
  assert.deepEqual(runtime.cleanStops, [])
  await assert.rejects(() => stat(join(root, 'identities', identity.id, 'template-snapshot')))
})
