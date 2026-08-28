import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'

test('client registers a session-scoped Better Sidebar tab instead of a global overlay', async () => {
  const entry = await readFile(new URL('../src/client/index.tsx', import.meta.url), 'utf8')
  const components = await readFile(new URL('../src/client/components.tsx', import.meta.url), 'utf8')
  assert.ok(entry.includes('betterSidebar.registerTab'))
  assert.ok(entry.includes('single: true'))
  assert.ok(entry.includes('scope.sessionId'))
  assert.doesNotMatch(entry, /shell\.overlay|sidebar\.footer\.action/)
  assert.ok(components.includes('loadState(sessionId)'))
  assert.ok(components.includes("novncUrl('sessionId', sessionId)"))
  assert.ok(components.includes('Shared control'))
  assert.doesNotMatch(components, /Lease browser|Take over|Private login|Return to AI|Release Slot|controlMode|state\.slots/)
  assert.ok(components.includes('visible'))
  assert.ok(components.includes('abf-browser-stage'))
  assert.ok(components.includes('abf-manage-drawer'))
  assert.ok(!components.includes('abf-console-column'))
  assert.ok(!components.includes('abf-timeline-column'))
})

test('package declares Better Sidebar as an optional peer', async () => {
  const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')) as Record<string, any>
  assert.match(pkg.peerDependencies['dsh-better-sidebar'], /0\.16\.1/)
  assert.equal(pkg.peerDependenciesMeta['dsh-better-sidebar'].optional, true)
})
