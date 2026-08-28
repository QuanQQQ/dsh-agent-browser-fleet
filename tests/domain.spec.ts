import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { assertSlotTransition } from '../src/domain.js'
import { FleetStore } from '../src/store.js'

test('internal Slot state machine has no lease or control states', () => {
  assert.doesNotThrow(() => assertSlotTransition('CREATING', 'READY'))
  assert.doesNotThrow(() => assertSlotTransition('READY', 'NEEDS_LOGIN'))
  assert.doesNotThrow(() => assertSlotTransition('NEEDS_LOGIN', 'READY'))
  assert.throws(() => assertSlotTransition('CREATING', 'NEEDS_LOGIN'), /cannot transition/)
  assert.throws(() => assertSlotTransition('BROKEN', 'NEEDS_LOGIN'), /cannot transition/)
})

test('FleetStore migrates an Agent lease to one v2 Session Browser and persists immediately', async () => {
  const root = await mkdtemp(join(tmpdir(), 'abf-store-v1-'))
  const file = join(root, 'state.json')
  const now = new Date().toISOString()
  await writeFile(file, JSON.stringify({
    version: 1,
    identities: [{ id: 'identity-a', name: 'Work', maxSlots: 2, templateState: 'READY', templateInstanceName: 'template-a', templateRuntime: { running: false }, createdAt: now, updatedAt: now }],
    slots: [
      { id: 'slot-a', identityId: 'identity-a', ordinal: 1, instanceName: 'slot-a', status: 'LEASED', controlMode: 'AGENT', lease: { id: 'lease-a', owner: { conversationId: 'session-a' }, acquiredAt: now }, runtime: { running: true }, createdAt: now, updatedAt: now },
      { id: 'slot-b', identityId: 'identity-a', ordinal: 2, instanceName: 'slot-b', status: 'LEASED', controlMode: 'PRIVATE', lease: { id: 'lease-b', owner: { conversationId: 'session-b' }, acquiredAt: now }, runtime: { running: true }, createdAt: now, updatedAt: now },
    ],
    timeline: [],
  }))
  const store = new FleetStore(file)
  await store.initialize()
  const state = store.snapshot()
  assert.equal(state.version, 2)
  assert.deepEqual(state.sessionBrowsers, [{ sessionId: 'session-a', identityId: 'identity-a', slotId: 'slot-a', createdAt: now, updatedAt: now }])
  assert.deepEqual(state.slots.map((slot) => slot.status), ['READY', 'READY'])
  assert.equal('lease' in state.slots[0], false)
  assert.equal('controlMode' in state.slots[0], false)
  const disk = JSON.parse(await readFile(file, 'utf8')) as { version: number; sessionBrowsers: unknown[] }
  assert.equal(disk.version, 2)
  assert.equal(disk.sessionBrowsers.length, 1)
})

test('FleetStore serializes concurrent mutations and persists atomically', async () => {
  const root = await mkdtemp(join(tmpdir(), 'abf-store-'))
  const file = join(root, 'state.json')
  const store = new FleetStore(file)
  await store.initialize()
  await Promise.all(Array.from({ length: 25 }, (_, index) => store.mutate(async (draft) => {
    await new Promise((resolve) => setTimeout(resolve, index % 3))
    draft.timeline.push({ id: 'e' + index, at: new Date(index).toISOString(), type: 'test', actor: 'system', summary: String(index) })
  })))
  assert.equal(store.snapshot().timeline.length, 25)
  const disk = JSON.parse(await readFile(file, 'utf8')) as { timeline: unknown[] }
  assert.equal(disk.timeline.length, 25)
})
