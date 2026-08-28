import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import type {} from 'dsh-better-sidebar/client/service'
import { FleetSidebarTab } from './components.js'
import { AGENT_BROWSER_FLEET_CSS } from './styles.js'

export const name = 'agent-browser-fleet-client'
export const inject = ['betterSidebar']

export function apply(ctx: ClientContext): void {
  ctx.effect(() => {
    const style = document.createElement('style')
    style.dataset.agentBrowserFleet = ''
    style.textContent = AGENT_BROWSER_FLEET_CSS
    document.head.append(style)
    return () => style.remove()
  }, 'agent-browser-fleet: styles')

  ctx.effect(() => ctx.betterSidebar.registerTab({
    id: 'agent-browser-fleet',
    title: 'Browser Fleet',
    icon: <span className="abf-tab-icon" aria-hidden="true">◉</span>,
    order: 45,
    single: true,
    component: ({ scope, visible }) => <FleetSidebarTab sessionId={scope.sessionId} visible={visible} />,
  }))
}
