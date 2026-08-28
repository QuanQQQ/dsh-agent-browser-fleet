import { homedir } from 'node:os'
import { join } from 'node:path'
import type { PromptSection } from '@deepseek-ai/dsh-system-prompt'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import { AccessAuth } from './auth.js'
import { CdpClient } from './cdp.js'
import { createFleetHttpRoute, createFleetUpgradeRoute, type HttpRoute, type UpgradeRoute } from './http.js'
import { ProfileCloner } from './profile-cloner.js'
import { DevboxChromeRuntime } from './runtime.js'
import { FleetService } from './service.js'
import { FleetStore } from './store.js'
import { createFleetTools } from './tools.js'

export const name = 'agent-browser-fleet'
export const inject = ['webServer', 'webRuntime', 'tools', 'systemPrompt', 'sessions']

export const AGENT_BROWSER_FLEET_GUIDANCE: PromptSection = {
  name: 'agent-browser-fleet:session-browser-guidance',
  order: 119,
  text: 'For reusable authenticated browser work, call agent_browser_identities and agent_browser_use_identity, then use the official browser_* Playwright MCP tools. Each DSH session has one current Session Browser. User and Agent have Shared Control, so concurrent actions have no ordering guarantee. Do not request or expose raw CDP endpoints.',
}

export interface HostContext {
  webServer: {
    register(route: HttpRoute): () => void
    registerUpgrade(route: UpgradeRoute): () => void
  }
  webRuntime: { trustedHosts: readonly string[] }
  tools: { register(definition: ToolDefinition): () => void }
  sessions: { list(): Array<{ id: string }> }
  on(name: 'session/disposed', callback: (session: { id: string }) => void): () => void
  systemPrompt: { section(section: PromptSection): () => void }
  effect(callback: () => void | (() => void), label?: string): unknown
}

export async function apply(ctx: HostContext): Promise<void> {
  const dshHome = process.env.DSH_HOME ?? join(homedir(), '.dsh')
  const root = process.env.AGENT_BROWSER_FLEET_HOME ?? join(dshHome, 'agent-browser-fleet')
  const cdp = new CdpClient()
  const runtime = new DevboxChromeRuntime(cdp)
  const store = new FleetStore(join(root, 'state.json'))
  const service = new FleetService({ root, store, runtime, cloner: new ProfileCloner(), cdp })
  const auth = new AccessAuth(join(root, 'access-token'))
  await auth.initialize()
  await service.initialize()

  const trustedHosts = [...ctx.webRuntime.trustedHosts]
  const novncRoot = process.env.AGENT_BROWSER_FLEET_NOVNC_ROOT ?? '/usr/share/novnc'
  const httpRoute = createFleetHttpRoute(service, auth, trustedHosts, novncRoot)
  const upgradeRoute = createFleetUpgradeRoute(service, auth, trustedHosts)

  const liveSessionIds = new Set(ctx.sessions.list().map((session) => String(session.id)))
  for (const browser of service.state().sessionBrowsers) {
    if (!liveSessionIds.has(browser.sessionId)) await service.stopSessionBrowser(browser.sessionId)
  }

  const toolSet = await createFleetTools(service)
  ctx.effect(() => {
    const disposePrompt = ctx.systemPrompt.section(AGENT_BROWSER_FLEET_GUIDANCE)
    const disposeTools = toolSet.definitions.map((tool) => ctx.tools.register(tool))
    const disposeSession = ctx.on('session/disposed', (session) => {
      const sessionId = String(session.id)
      void (async () => {
        try { await toolSet.closeSession(sessionId) }
        finally { await service.stopSessionBrowser(sessionId) }
      })().catch(() => undefined)
    })
    return () => {
      disposeSession()
      for (const dispose of disposeTools.reverse()) dispose()
      disposePrompt()
      void toolSet.close().catch(() => undefined)
    }
  }, 'agent-browser-fleet: Identity and Playwright MCP tools')
  ctx.effect(() => {
    const disposeHttp = ctx.webServer.register(httpRoute)
    const disposeUpgrade = ctx.webServer.registerUpgrade(upgradeRoute)
    return () => { disposeUpgrade(); disposeHttp() }
  }, 'agent-browser-fleet: authenticated HTTP and noVNC gateway')
  ctx.effect(() => service.startScreenshotLoop(), 'agent-browser-fleet: low-frequency screenshots')
}

export default { name, inject, apply }

export * from './auth.js'
export * from './browser-tools.js'
export * from './cdp.js'
export * from './domain.js'
export * from './http.js'
export * from './playwright-mcp.js'
export * from './profile-cloner.js'
export * from './runtime.js'
export * from './service.js'
export * from './store.js'
export * from './tools.js'
