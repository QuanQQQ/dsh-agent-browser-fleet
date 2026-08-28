---
status: accepted
---

# Use one shared Session Browser backed by Playwright MCP

## Context

Fleet must preserve authenticated browser profiles, isolate concurrent DSH sessions, and let both a user and an Agent operate the same browser. A custom broker previously combined lifecycle policy, capacity allocation, interaction primitives, and exclusive-control modes. Maintaining browser navigation, selectors, snapshots, tabs, files, console, and network behavior inside Fleet duplicated a mature automation stack and made browser capability growth a Fleet responsibility.

DSH tool execution provides the calling Agent identity, while a static MCP server declaration does not receive that identity. Fleet therefore needs a routing boundary between DSH tool execution and browser automation.

## Decision

Each DSH session has at most one Session Browser. Its Agent selects the current Identity; Browser Allocation is automatic. User and Agent have Shared Control, so Fleet exposes no lease/release API and no TAKEOVER, PRIVATE, or other exclusive-control mode.

Fleet owns Identity discovery and selection, Template Snapshots, persistent profile capacity, runtime lifecycle, and DSH-session mapping. The official @playwright/mcp tool catalog owns browser automation. A Fleet Adapter registers those tools once, derives the session from the DSH tool execution context, resolves the bound loopback CDP endpoint, and opens an in-memory MCP connection for that Session Browser. The model cannot supply a session ID or receive the raw endpoint.

@playwright/mcp is pinned exactly while it is pre-1.0, and a catalog contract test detects upstream tool changes. Session disposal closes the session's MCP connection and stops its Session Browser.

## Consequences

- Concurrent user and Agent actions have no ordering guarantee.
- Agent-facing Fleet tools are limited to agent_browser_identities and agent_browser_use_identity; browser work uses official browser_* tools.
- Identity changes may replace the current Session Browser but never create a second browser for the same DSH session.
- Internal browser capacity remains an implementation detail and is not exposed through the HTTP API or Sidebar.
- CDP remains loopback-only and hidden from the model, but another process running under the same Host UID can still enumerate loopback endpoints.
- DSH tool rendering represents MCP image blocks as saved-file placeholders. Agents should use accessibility snapshots as their primary observation until attachment ingestion is available.
