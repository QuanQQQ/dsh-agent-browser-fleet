import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { CdpClient } from '../src/cdp.js'
import { DevboxChromeRuntime, type RuntimeCommandResult } from '../src/runtime.js'

class ReadyCdp { async isReady() { return true }; async closeBrowser() {} }

test('runtime adapter strips unsafe overrides and verifies all listeners are loopback', async () => {
  const calls: Array<{ file: string; args: readonly string[]; env: NodeJS.ProcessEnv }> = []
  const runner = async (file: string, args: readonly string[], options: { env: NodeJS.ProcessEnv }): Promise<RuntimeCommandResult> => {
    calls.push({ file, args, env: options.env })
    if (args.at(-1) === 'env') return { code: 0, stdout: "export CHROME_CDP_PORT='9223'\n", stderr: '' }
    if (file === 'ss') return { code: 0, stdout: 'LISTEN 0 128 127.0.0.1:9223 0.0.0.0:*\nLISTEN 0 128 127.0.0.1:5901 0.0.0.0:*\nLISTEN 0 128 127.0.0.1:6081 0.0.0.0:*\n', stderr: '' }
    return { code: 0, stdout: 'started', stderr: '' }
  }
  const runtime = new DevboxChromeRuntime(new ReadyCdp() as unknown as CdpClient, runner as never, {
    ...process.env,
    CHROME_PROXY: 'http://evil:8899',
    CHROME_NOVNC_BIND: '0.0.0.0',
    CHROME_EXTRA_ARGS: '--remote-debugging-address=0.0.0.0',
  })
  const result = await runtime.start('abf-s-safe', '/tmp/abf-profile')
  assert.equal(result.loopbackVerified, true)
  const start = calls.find((call) => call.args.includes('start'))!
  assert.equal(start.env.DEVBOX_CHROME_CONFIG, '/dev/null')
  assert.equal(start.env.CHROME_NOVNC_BIND, '127.0.0.1')
  assert.equal(start.env.WHISTLE_BIND, '127.0.0.1')
  assert.equal(start.env.CHROME_USER_DATA_DIR, '/tmp/abf-profile')
  assert.match(start.env.PATH ?? '', /dsh-agent-browser-fleet\/runtime-bin/)
  assert.equal(start.env.CHROME_PROXY, undefined)
  assert.equal(start.env.CHROME_EXTRA_ARGS, undefined)
})

test('runtime adapter refuses a non-loopback listener and stops the instance', async () => {
  let stopped = false
  const runner = async (file: string, args: readonly string[]): Promise<RuntimeCommandResult> => {
    if (args.at(-1) === 'env') return { code: 0, stdout: "export CHROME_CDP_PORT='9223'\n", stderr: '' }
    if (file === 'ss') return { code: 0, stdout: 'LISTEN 0 128 0.0.0.0:5901 0.0.0.0:*\n', stderr: '' }
    if (args.includes('stop')) stopped = true
    return { code: 0, stdout: '', stderr: '' }
  }
  const runtime = new DevboxChromeRuntime(new ReadyCdp() as unknown as CdpClient, runner as never)
  await assert.rejects(() => runtime.start('abf-s-unsafe', '/tmp/abf-profile'), /outside loopback/)
  assert.equal(stopped, true)
})

test('runtime adapter refuses loopback verification when a required listener is missing', async () => {
  let stopped = false
  const runner = async (file: string, args: readonly string[]): Promise<RuntimeCommandResult> => {
    if (args.at(-1) === 'env') return { code: 0, stdout: "export CHROME_CDP_PORT='9223'\n", stderr: '' }
    if (file === 'ss') return { code: 0, stdout: 'LISTEN 0 128 127.0.0.1:9223 0.0.0.0:*\nLISTEN 0 128 127.0.0.1:5901 0.0.0.0:*\n', stderr: '' }
    if (args.includes('stop')) stopped = true
    return { code: 0, stdout: '', stderr: '' }
  }
  const runtime = new DevboxChromeRuntime(new ReadyCdp() as unknown as CdpClient, runner as never)
  await assert.rejects(() => runtime.start('abf-s-missing-novnc', '/tmp/abf-profile'), /required loopback-only listeners/)
  assert.equal(stopped, true)
})

test('runtime adapter serializes stack startup while preserving independent instances', async () => {
  let activeStarts = 0
  let maxActiveStarts = 0
  const runner = async (file: string, args: readonly string[]): Promise<RuntimeCommandResult> => {
    const instance = args[1]
    const slot = instance === 'abf-s-parallel-a' ? 31 : 32
    if (args.at(-1) === 'env') return { code: 0, stdout: `export CHROME_CDP_PORT='${9222 + slot}'\n`, stderr: '' }
    if (args.includes('start')) {
      activeStarts++
      maxActiveStarts = Math.max(maxActiveStarts, activeStarts)
      await new Promise((resolve) => setTimeout(resolve, 30))
      activeStarts--
      return { code: 0, stdout: 'started', stderr: '' }
    }
    if (file === 'ss') return { code: 0, stdout: [
      'LISTEN 0 128 127.0.0.1:9253 0.0.0.0:*',
      'LISTEN 0 128 127.0.0.1:5931 0.0.0.0:*',
      'LISTEN 0 128 127.0.0.1:6111 0.0.0.0:*',
      'LISTEN 0 128 127.0.0.1:9254 0.0.0.0:*',
      'LISTEN 0 128 127.0.0.1:5932 0.0.0.0:*',
      'LISTEN 0 128 127.0.0.1:6112 0.0.0.0:*',
    ].join('\n') + '\n', stderr: '' }
    return { code: 0, stdout: '', stderr: '' }
  }
  const runtime = new DevboxChromeRuntime(new ReadyCdp() as unknown as CdpClient, runner as never)
  const [a, b] = await Promise.all([
    runtime.start('abf-s-parallel-a', '/tmp/abf-profile-a'),
    runtime.start('abf-s-parallel-b', '/tmp/abf-profile-b'),
  ])
  assert.equal(a.ports.cdp, 9253)
  assert.equal(b.ports.cdp, 9254)
  assert.equal(maxActiveStarts, 1)
})

test('cleanStop refuses to certify an already crashed browser as cleanly closed', async () => {
  let closeAttempted = false
  let stackStopped = false
  const cdp = {
    async isReady() { return false },
    async closeBrowser() { closeAttempted = true },
  }
  const runner = async (_file: string, args: readonly string[]): Promise<RuntimeCommandResult> => {
    if (args.at(-1) === 'env') return { code: 0, stdout: "export CHROME_CDP_PORT='9223'\n", stderr: '' }
    if (args.includes('stop')) stackStopped = true
    return { code: 0, stdout: '', stderr: '' }
  }
  const runtime = new DevboxChromeRuntime(cdp as unknown as CdpClient, runner as never)
  await assert.rejects(() => runtime.cleanStop('abf-t-crashed', '/tmp/abf-profile'), /cannot prove a clean Chromium shutdown/)
  assert.equal(closeAttempted, false)
  assert.equal(stackStopped, false)
})
