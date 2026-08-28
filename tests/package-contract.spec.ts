import assert from 'node:assert/strict'
import { readFile, stat } from 'node:fs/promises'
import { test } from 'node:test'

test('package is an installable Agent Browser Fleet dsh.bundle', async () => {
  const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')) as Record<string, any>
  assert.equal(pkg.name, 'dsh-agent-browser-fleet')
  assert.equal(pkg.main, 'lib/host.mjs')
  assert.equal(pkg.bin['dsh-agent-browser-fleet-chromium'], 'runtime-bin/chromium')
  assert.equal(pkg.dsh.bundle.patch, './cordis.patch.yml')
  assert.equal(pkg.dsh.client.platform, 'web')
  assert.ok(pkg.dsh.client.inject.includes('@deepseek-ai/dsh-client-ui-sidebar'))
  assert.ok(pkg.files.includes('runtime-bin'))
  const shimUrl = new URL('../runtime-bin/chromium', import.meta.url)
  const shim = await readFile(shimUrl, 'utf8')
  assert.match(shim, /--no-first-run/)
  assert.notEqual((await stat(shimUrl)).mode & 0o111, 0)
  const patch = await readFile(new URL('../cordis.patch.yml', import.meta.url), 'utf8')
  assert.match(patch, /id: agent-browser-fleet/)
  assert.match(patch, /name: 'dsh-agent-browser-fleet'/)
})
