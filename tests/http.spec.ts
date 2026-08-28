import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'
import { publicState } from '../src/http.js'
import type { FleetService } from '../src/service.js'

test('public session state redacts internal allocation, instance, port, and audit details', () => {
  const now = '2026-08-27T00:00:00.000Z'
  const binding = { sessionId: 'session-a', identityId: 'identity-a', slotId: 'slot-secret', createdAt: now, updatedAt: now }
  const state = {
    version: 2,
    identities: [{
      id: 'identity-a', name: 'Work', maxSlots: 2, templateState: 'READY', templateInstanceName: 'template-secret',
      templateRuntime: { running: true, ports: { cdp: 9222, vnc: 5901, novnc: 6080, whistle: 8899, display: 100 }, startedAt: now },
      snapshotAt: now, createdAt: now, updatedAt: now,
    }],
    slots: [{
      id: 'slot-secret', identityId: 'identity-a', ordinal: 1, instanceName: 'instance-secret', status: 'READY',
      runtime: { running: true, ports: { cdp: 9333, vnc: 5902, novnc: 6081, whistle: 8900, display: 101 }, loopbackVerified: true },
      createdAt: now, updatedAt: now,
    }],
    sessionBrowsers: [binding],
    timeline: [
      { id: 'event-a', at: now, type: 'session.browser.ready', actor: 'system', identityId: 'identity-a', slotId: 'slot-secret', summary: 'Browser ready', details: { cdpPort: 9333 } },
      { id: 'event-legacy', at: now, type: 'template.private_login_started', actor: 'user', identityId: 'identity-a', summary: 'Legacy exclusive mode event' },
    ],
  }
  const service = { state: () => state, sessionBrowser: (sessionId: string) => sessionId === 'session-a' ? binding : undefined } as unknown as FleetService

  const value = publicState(service, 'session-a')
  assert.deepEqual(value.identities[0].templateRuntime, { running: true, startedAt: now, error: undefined })
  assert.deepEqual(value.sessionBrowser, { sessionId: 'session-a', identityId: 'identity-a', running: true, profileState: 'READY' })
  assert.deepEqual(value.timeline, [{ id: 'event-a', at: now, actor: 'system', identityId: 'identity-a', summary: 'Browser ready' }])
  const json = JSON.stringify(value)
  assert.doesNotMatch(json, /slot-secret|instance-secret|template-secret|9222|9333|cdpPort/)
})

test('HTTP routes contain no public lease, release, control, or Slot target interface', async () => {
  const source = await readFile(new URL('../src/http.ts', import.meta.url), 'utf8')
  assert.doesNotMatch(source, /\/lease|\/release|\/control|searchParams\.get\('slotId'\)|slotVncTarget/)
  assert.match(source, /sessionVncTarget/)
})
