# Agent Browser Fleet v0.1 architecture and scope

Agent Browser Fleet is a DSH Web bundle for reusable authenticated Chromium identities on hosts without a desktop environment. Chromium runs with Xvfb, while users see the active browser through the session-scoped Better Sidebar tab.

## Completion contract

The v0.1 vertical slice provides:

1. user-driven Identity login setup and immutable clean snapshots;
2. isolated persistent profiles with bounded per-Identity capacity;
3. at most one Shared-Control Session Browser per DSH session;
4. Agent-selected Identity Binding through a session-derived tool call;
5. official Playwright MCP browser tools routed to the calling session;
6. authenticated same-origin noVNC access in Better Sidebar;
7. atomic state persistence, restart reconciliation, and session-disposal cleanup;
8. repeatable unit, integration, build, package, and real-profile validation.

## Module boundaries

### Identity and profile lifecycle

Fleet creates an interactive template profile for each Identity. A Template Snapshot is produced only after Chromium exits cleanly through Browser.close and its CDP endpoint becomes unreachable. Every allocated profile is a complete independent copy including Chromium's root Local State; reflink is preferred and ordinary copy is the safe fallback. Runtime profiles never merge into the snapshot or one another.

### Session Browser policy

A DSH session has zero or one Identity Binding and zero or one corresponding Session Browser. Selecting the same Identity is idempotent. Selecting another Identity stops the previous runtime before allocating the replacement. Capacity exhaustion is explicit; there is no public lease or waiting queue.

Browser capacity records are internal persistence details. Their identifiers, instance names, runtime ports, and allocation state do not cross the Agent-tool, HTTP, or Sidebar interfaces.

### Playwright MCP Adapter

Fleet exposes two orchestration tools:

- agent_browser_identities
- agent_browser_use_identity

The Adapter also exposes the official @playwright/mcp core browser_* catalog. Every browser tool derives its session from exec.agent.id, resolves the hidden loopback CDP endpoint, and reuses a per-session in-memory MCP connection. The model cannot choose another session or connect to raw CDP.

Fleet's own CDP client is restricted to runtime readiness, clean close, and low-frequency screenshots. It contains no Agent interaction Interface.

### Web surface

The client registers one session-scoped Browser Fleet Better Sidebar tab. The default Browser-first view displays the current Session Browser and labels its Shared-Control semantics. The user may view and interact with the same noVNC browser while the Agent uses Playwright.

The management drawer creates Identities and runs user-driven login setup. It does not expose capacity records, leases, release controls, ownership, or exclusive-control modes. Identity selection belongs to the Agent tool so the DSH tool execution context remains the authority for session routing.

### Session lifecycle

On plugin initialization, bindings whose DSH sessions are not live are stopped and removed. A session/disposed event closes the session's MCP connection and stops its browser. Persisted Identity profiles remain available for later sessions.

## Security boundary

- Runtime commands use argv and never a shell or sudo.
- Fleet does not start whistle or change system proxy settings.
- CDP, VNC, and noVNC listeners must remain loopback-only.
- The noVNC gateway validates trusted authority, same-origin Origin, and the Fleet cookie before resolving a Session Browser or template browser.
- The gateway connects only to 127.0.0.1:<vnc-port> and performs VNC authentication server-side.
- Default dsh-session authentication inherits the DSH Web origin trust boundary. Optional token mode adds a Host-local capability token.
- A malicious same-UID process remains outside Fleet's isolation guarantee because it can enumerate loopback CDP. Stronger isolation requires a separate OS identity, network namespace, or remote-debugging pipe.

## Validation gates

- pnpm check for TypeScript, tests, and Host/client builds.
- pnpm experiment:profiles for real Chromium profile persistence and isolation.
- PDM isolated development DSH verification for tool registration, Better Sidebar, state API, and noVNC.
- PDM clean package validation before promotion.
- Stable DSH updates only through the PDM stable-update queue after an explicit rollout request.

## Deferred scope

- Website-specific authentication health probes.
- Fair capacity waiting and cancellation.
- Configurable screenshot retention and event streaming.
- Attachment ingestion for Playwright MCP image blocks.
- Strong same-UID process isolation.
- Multi-Host scheduling, quotas, encrypted-at-rest profiles, and backup/export.
