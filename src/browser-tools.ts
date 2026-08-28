import type { JsonValue, ToolDefinition, ToolRunContext } from '@deepseek-ai/dsh-tools'
import { FleetError } from './domain.js'
import { openPlaywrightMcp, type PlaywrightMcpConnection } from './playwright-mcp.js'

export interface BrowserMcpTarget {
  slotId: string
  cdpEndpoint: string
  outputDir: string
}

export interface SessionBrowserResolver {
  browserMcpTarget(sessionId: string): BrowserMcpTarget
}

export type PlaywrightMcpOpener = (
  config?: Parameters<typeof openPlaywrightMcp>[0],
  contextGetter?: Parameters<typeof openPlaywrightMcp>[1],
) => Promise<PlaywrightMcpConnection>

export interface PlaywrightBrowserToolSet {
  definitions: ToolDefinition[]
  closeSession(sessionId: string): Promise<void>
  close(): Promise<void>
}

const OUTPUT_SCHEMA: ToolDefinition['output']['schema'] = {
  type: 'object',
  properties: {
    content: { type: 'array', items: {} },
    structuredContent: {},
  },
  required: ['content'],
  additionalProperties: false,
}

export async function createPlaywrightBrowserTools(
  resolver: SessionBrowserResolver,
  open: PlaywrightMcpOpener = openPlaywrightMcp,
): Promise<PlaywrightBrowserToolSet> {
  const catalogConnection = await open({}, async () => { throw new Error('Playwright MCP catalog access does not have a Browser Context') })
  let catalog: Awaited<ReturnType<PlaywrightMcpConnection['listTools']>>
  try {
    catalog = await catalogConnection.listTools()
  } finally {
    await catalogConnection.close()
  }

  const router = new SessionMcpRouter(resolver, open)
  const names = new Set<string>()
  const definitions = catalog.tools.map((tool): ToolDefinition => {
    if (names.has(tool.name)) throw new Error('Playwright MCP listed duplicate tool: ' + tool.name)
    names.add(tool.name)
    return {
      name: tool.name,
      description: tool.description ?? '',
      parameters: tool.inputSchema,
      output: {
        schema: OUTPUT_SCHEMA,
        render: (_args, value) => [{ type: 'text', text: extractText(value) }],
      },
      timeoutMs: 120_000,
      async execute(args, exec) {
        if (tool.execution?.taskSupport === 'required') throw new Error('Playwright MCP tool requires unsupported task-based execution: ' + tool.name)
        const sessionId = sessionIdFrom(exec)
        const result = await router.call(sessionId, tool.name, asArguments(args), exec.signal)
        const normalized = normalizeResult(result)
        if (result.isError === true) throw new Error(extractText(normalized))
        return normalized
      },
    }
  })

  return { definitions, closeSession: (sessionId) => router.closeSession(sessionId), close: () => router.close() }
}

class SessionMcpRouter {
  private readonly connections = new Map<string, { fingerprint: string; connection: Promise<PlaywrightMcpConnection> }>()

  constructor(private readonly resolver: SessionBrowserResolver, private readonly open: PlaywrightMcpOpener) {}

  async call(sessionId: string, name: string, args: Record<string, unknown>, signal: AbortSignal): Promise<Record<string, unknown>> {
    const connection = await this.connection(sessionId)
    return await connection.callTool({ name, arguments: args }, undefined, { signal, timeout: 120_000 }) as Record<string, unknown>
  }

  async closeSession(sessionId: string): Promise<void> {
    const entry = this.connections.get(sessionId)
    if (!entry) return
    this.connections.delete(sessionId)
    await (await entry.connection).close()
  }

  async close(): Promise<void> {
    const pending = [...this.connections.values()].map(async (entry) => (await entry.connection).close())
    this.connections.clear()
    await Promise.allSettled(pending)
  }

  private async connection(sessionId: string): Promise<PlaywrightMcpConnection> {
    const target = this.resolver.browserMcpTarget(sessionId)
    const fingerprint = target.slotId + '\0' + target.cdpEndpoint
    const current = this.connections.get(sessionId)
    if (current?.fingerprint === fingerprint) return current.connection
    const connection = this.open({
      browser: { cdpEndpoint: target.cdpEndpoint, cdpTimeout: 10_000 },
      capabilities: ['core'],
      outputDir: target.outputDir,
      sharedBrowserContext: true,
    })
    this.connections.set(sessionId, { fingerprint, connection })
    if (current) void current.connection.then((value) => value.close()).catch(() => undefined)
    try {
      return await connection
    } catch (error) {
      const active = this.connections.get(sessionId)
      if (active?.connection === connection) this.connections.delete(sessionId)
      throw error
    }
  }
}

function sessionIdFrom(exec: ToolRunContext): string {
  if (!exec.agent) throw new FleetError('agent_required', 'Playwright browser tools require a calling Agent', 403)
  return String(exec.agent.id)
}

function asArguments(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

function normalizeResult(result: Record<string, unknown>): { content: JsonValue[]; structuredContent?: JsonValue } {
  const content = Array.isArray(result.content) ? result.content.filter(isJsonValue) : [{ type: 'text', text: '(browser tool returned no content)' }]
  return {
    content,
    ...(result.structuredContent !== undefined && isJsonValue(result.structuredContent) ? { structuredContent: result.structuredContent } : {}),
  }
}

function extractText(value: JsonValue): string {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return '(browser tool returned no text content)'
  const content = value.content
  if (!Array.isArray(content)) return '(browser tool returned no text content)'
  const parts: string[] = []
  for (const block of content) {
    if (typeof block !== 'object' || block === null || Array.isArray(block)) continue
    if (block.type === 'text' && typeof block.text === 'string') parts.push(block.text)
    else if (block.type === 'image') parts.push('[image: ' + (typeof block.mimeType === 'string' ? block.mimeType : 'unknown') + ', use the saved screenshot path from the preceding text]')
  }
  return parts.join('\n') || '(browser tool returned no text content)'
}

function isJsonValue(value: unknown): value is JsonValue {
  if (value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return true
  if (Array.isArray(value)) return value.every(isJsonValue)
  if (typeof value !== 'object') return false
  return Object.values(value as Record<string, unknown>).every(isJsonValue)
}
