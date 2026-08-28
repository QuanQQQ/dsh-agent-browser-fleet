import { createConnection } from '@playwright/mcp'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'

type McpConfig = NonNullable<Parameters<typeof createConnection>[0]>
type ContextGetter = NonNullable<Parameters<typeof createConnection>[1]>

export interface PlaywrightMcpConnection {
  listTools(): ReturnType<Client['listTools']>
  callTool(...args: Parameters<Client['callTool']>): ReturnType<Client['callTool']>
  close(): Promise<void>
}

export async function openPlaywrightMcp(config: McpConfig = {}, contextGetter?: ContextGetter): Promise<PlaywrightMcpConnection> {
  const server = await createConnection({ ...config, capabilities: config.capabilities ?? ['core'] }, contextGetter)
  const client = new Client({ name: 'dsh-agent-browser-fleet', version: '0.1.0' })
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)])
  return {
    listTools: () => client.listTools(),
    callTool: (...args) => client.callTool(...args),
    async close() {
      await Promise.allSettled([client.close(), server.close()])
    },
  }
}
