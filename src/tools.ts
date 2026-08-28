import { defineTool, type ToolDefinition, type ToolRunContext } from '@deepseek-ai/dsh-tools'
import { createPlaywrightBrowserTools } from './browser-tools.js'
import { FleetError } from './domain.js'
import type { FleetService } from './service.js'

export interface FleetToolSet {
  definitions: ToolDefinition[]
  closeSession(sessionId: string): Promise<void>
  close(): Promise<void>
}

export async function createFleetTools(service: FleetService): Promise<FleetToolSet> {
  const browserTools = await createPlaywrightBrowserTools(service)
  return {
    definitions: [createIdentitiesTool(service), createUseIdentityTool(service), ...browserTools.definitions],
    closeSession: (sessionId) => browserTools.closeSession(sessionId),
    close: () => browserTools.close(),
  }
}

function createIdentitiesTool(service: FleetService): ToolDefinition {
  return defineTool({
    name: 'agent_browser_identities',
    description: 'List reusable Browser Identities and show which Identity is bound to this DSH Session Browser. Call agent_browser_use_identity before official browser_* tools when no Identity is selected.',
    parameters: {},
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: {
          current_identity_id: { type: 'string', required: true },
          session_browser_running: { type: 'boolean', required: true },
          identities: {
            type: 'array', required: true,
            items: {
              type: 'object', additionalProperties: false,
              properties: {
                id: { type: 'string', required: true },
                name: { type: 'string', required: true },
                template_state: { type: 'string', required: true },
                prepared_profiles: { type: 'integer', required: true },
                available_capacity: { type: 'integer', required: true },
                max_profiles: { type: 'integer', required: true },
              },
            },
          },
        },
      },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    async execute(_args, exec) {
      const sessionId = sessionIdFrom(exec)
      const state = service.state()
      const current = service.sessionBrowser(sessionId)
      const running = current ? state.slots.find((slot) => slot.id === current.slotId)?.runtime.running === true : false
      return {
        current_identity_id: current?.identityId ?? '',
        session_browser_running: running,
        identities: state.identities.map((identity) => {
          const allocated = state.sessionBrowsers.filter((browser) => browser.identityId === identity.id).length
          return {
            id: identity.id,
            name: identity.name,
            template_state: identity.templateState,
            prepared_profiles: state.slots.filter((slot) => slot.identityId === identity.id && slot.status === 'READY').length,
            available_capacity: Math.max(0, identity.maxSlots - allocated),
            max_profiles: identity.maxSlots,
          }
        }),
      }
    },
  })
}

function createUseIdentityTool(service: FleetService): ToolDefinition {
  return defineTool({
    name: 'agent_browser_use_identity',
    description: 'Bind one reusable Browser Identity to this DSH Session Browser. The session has exactly one current browser; selecting another Identity cleanly switches it. User and Agent have Shared Control.',
    parameters: {
      identity_id: { type: 'string', required: true, description: 'Identity id returned by agent_browser_identities.' },
    },
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: {
          identity_id: { type: 'string', required: true },
          session_browser_ready: { type: 'boolean', required: true },
          shared_control: { type: 'boolean', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    timeoutMs: 180_000,
    async execute(args, exec) {
      const sessionId = sessionIdFrom(exec)
      const browser = await service.useIdentity(sessionId, args.identity_id, exec.signal)
      return { identity_id: browser.identityId, session_browser_ready: true, shared_control: true }
    },
  })
}

function sessionIdFrom(exec: ToolRunContext): string {
  if (!exec.agent) throw new FleetError('agent_required', 'Agent Browser Fleet tools require a calling Agent', 403)
  return String(exec.agent.id)
}
