import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { FleetService } from '../src/service.js'
import { createFleetTools } from '../src/tools.js'

test('Fleet exposes Identity orchestration plus official Playwright tools, without the custom broker', async () => {
  const selections: Array<{ sessionId: string; identityId: string }> = []
  const fakeService = {
    state() {
      return {
        identities: [{ id: 'identity-a', name: 'Work', maxSlots: 2, templateState: 'READY' }],
        slots: [],
        sessionBrowsers: [],
        timeline: [],
      }
    },
    sessionBrowser() { return undefined },
    async useIdentity(sessionId: string, identityId: string) {
      selections.push({ sessionId, identityId })
      return { sessionId, identityId, slotId: 'slot-a', createdAt: '', updatedAt: '' }
    },
    browserMcpTarget() { throw new Error('not used by catalog test') },
  } as unknown as FleetService
  const toolSet = await createFleetTools(fakeService)
  try {
    const names = new Set(toolSet.definitions.map((tool) => tool.name))
    assert.ok(names.has('agent_browser_identities'))
    assert.ok(names.has('agent_browser_use_identity'))
    assert.ok(names.has('browser_snapshot'))
    assert.ok(names.has('browser_click'))
    assert.equal(names.has('agent_browser_fleet_lease'), false)
    assert.equal(names.has('agent_browser_fleet_act'), false)
    assert.equal(names.has('agent_browser_fleet_release'), false)
    const use = toolSet.definitions.find((tool) => tool.name === 'agent_browser_use_identity')!
    await use.execute({ identity_id: 'identity-a' }, { agent: { id: 'session-a' }, signal: new AbortController().signal } as never)
    assert.deepEqual(selections, [{ sessionId: 'session-a', identityId: 'identity-a' }])
  } finally {
    await toolSet.close()
  }
})
