import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createPlaywrightBrowserTools } from '../src/browser-tools.js'
import type { PlaywrightMcpConnection } from '../src/playwright-mcp.js'

function connection(tools: Array<Record<string, unknown>>, calls: Array<{ name: string; arguments: unknown }>): PlaywrightMcpConnection {
  return {
    async listTools() { return { tools } as never },
    async callTool(request: { name: string; arguments?: Record<string, unknown> }) {
      calls.push({ name: request.name, arguments: request.arguments })
      return { content: [{ type: 'text', text: 'official result' }] } as never
    },
    async close() {},
  }
}

test('official browser tools resolve the calling Agent session to its hidden CDP target', async () => {
  const calls: Array<{ name: string; arguments: unknown }> = []
  const opens: unknown[] = []
  const catalog = [{
    name: 'browser_snapshot',
    description: 'Capture accessibility snapshot',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  }]
  const open = async (config: unknown, contextGetter?: unknown) => {
    opens.push(config)
    return contextGetter ? connection(catalog, calls) : connection(catalog, calls)
  }
  const service = {
    browserMcpTarget(sessionId: string) {
      assert.equal(sessionId, 'session-a')
      return { slotId: 'slot-a', cdpEndpoint: 'http://127.0.0.1:9333', outputDir: '/tmp/abf-output' }
    },
  }
  const toolSet = await createPlaywrightBrowserTools(service, open)
  try {
    assert.deepEqual(toolSet.definitions.map((tool) => tool.name), ['browser_snapshot'])
    const value = await toolSet.definitions[0].execute({}, {
      agent: { id: 'session-a' },
      signal: new AbortController().signal,
    } as never)
    assert.deepEqual(value, { content: [{ type: 'text', text: 'official result' }] })
    assert.deepEqual(calls, [{ name: 'browser_snapshot', arguments: {} }])
    assert.deepEqual(opens[1], {
      browser: { cdpEndpoint: 'http://127.0.0.1:9333', cdpTimeout: 10_000 },
      capabilities: ['core'],
      outputDir: '/tmp/abf-output',
      sharedBrowserContext: true,
    })
  } finally {
    await toolSet.close()
  }
})

test('official browser tools require a calling Agent identity', async () => {
  const catalog = [{ name: 'browser_snapshot', inputSchema: { type: 'object', properties: {} } }]
  const toolSet = await createPlaywrightBrowserTools({ browserMcpTarget() { throw new Error('must not resolve') } }, async () => connection(catalog, []))
  try {
    await assert.rejects(() => toolSet.definitions[0].execute({}, { signal: new AbortController().signal } as never), /calling Agent/)
  } finally {
    await toolSet.close()
  }
})
