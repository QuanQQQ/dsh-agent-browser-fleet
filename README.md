# DSH Agent Browser Fleet

A DSH Web bundle that provides reusable authenticated Chromium identities and one Shared-Control Session Browser per DSH session on hosts without a desktop environment.

## Product model

- An **Identity** is a reusable authenticated browser profile lineage with bounded concurrent capacity.
- A **Template Snapshot** is an immutable clean copy produced after user-driven login setup and a clean Chromium shutdown.
- A **Session Browser** is the single live browser associated with one DSH session.
- An **Identity Binding** records which Identity the Session Browser uses.
- **Shared Control** means the user may operate noVNC while the Agent operates Playwright. Concurrent action ordering is not guaranteed.
- **Browser Allocation** assigns persistent profile capacity internally. It is not a public lease and its records are never exposed to the Agent or Sidebar.

Profile copies never merge into the Template Snapshot or into one another.

## Agent tools

Fleet adds two Identity tools:

- agent_browser_identities lists usable Identities and reports the calling session's current binding.
- agent_browser_use_identity selects an Identity for the calling session and ensures its Session Browser is ready.

The calling DSH Agent identity is the sole source of the session ID; the model cannot provide a session ID. After selection, browser automation uses the official @playwright/mcp core browser_* catalog for navigation, accessibility snapshots, interaction, tabs, files, console, network, storage, and screenshots.

A Fleet Adapter resolves each tool execution to a hidden loopback CDP endpoint and caches one in-memory MCP connection per Session Browser. Raw CDP endpoints are never returned to the model. @playwright/mcp is pinned to 0.0.79 because its public Interface is pre-1.0, and tests lock the catalog and routing contract.

The DSH tool renderer preserves MCP text output. Image blocks are represented as saved-file placeholders, so accessibility snapshots are the preferred Agent observation until DSH attachment ingestion is available.

## Browser-first Sidebar

The Web client registers one Browser Fleet tab through dsh-better-sidebar 0.16.1 or later. Better Sidebar scopes the tab to the active DSH session and can resize, split, or float it beside the conversation.

The default view shows the current Session Browser through authenticated noVNC and labels Shared Control. The management drawer creates Identities, opens user-driven login setup, saves Template Snapshots, and shows activity. It exposes no leases, release controls, runtime ports, capacity-record IDs, ownership, or exclusive-control modes. Identity selection belongs to the Agent tool.

Hidden tabs stop polling and detach the noVNC iframe. No global overlay is registered.

## Lifecycle

Selecting the same Identity is idempotent. Selecting another Identity cleanly stops the old Session Browser before allocating the replacement. A DSH session has at most one Session Browser even while the Identity changes.

When DSH emits session/disposed, Fleet closes the session's MCP connection and stops its browser. Plugin initialization removes bindings whose DSH sessions are no longer live. Identity profiles and snapshots remain reusable.

## Runtime and security invariants

The Host adapter invokes devbox-chrome-debug with argv rather than a shell. It does not run sudo, start whistle, modify system proxy settings, or accept external overrides for debugging addresses and VNC authentication.

CDP, x11vnc, and noVNC listeners must remain on loopback. CDP, VNC, and noVNC must all be present before a Session Browser is ready. Browser stack lifecycle commands are serialized because the shared devbox-chrome-debug cleanup path is not concurrency-safe; separate running Session Browsers remain concurrent.

The default dsh-session access mode requires no separate Fleet login. A browser-originated request from a trusted DSH authority exchanges the same-origin page context for an HttpOnly, SameSite=Strict Fleet cookie. Cross-site and non-browser requests cannot bootstrap it. DSH Web does not expose a user principal to plugins, so this mode inherits the DSH Web origin as its trust boundary. Administrators may set AGENT_BROWSER_FLEET_AUTH_MODE=token for a separate Host-local capability token.

The noVNC WebSocket route checks trusted authority, same-origin Origin, and the Fleet cookie before resolving a Session Browser or template browser. The gateway connects only to 127.0.0.1 on the resolved VNC port and performs VNC password authentication server-side.

A same-UID Host process can still enumerate and connect to loopback CDP. Strong protection against such a process requires Chromium remote-debugging pipe, a separate OS identity, or a network namespace. LAN clients have no direct VNC or CDP path.

## Prerequisites

Run the runtime doctor before creating an Identity:

    devbox-chrome-debug doctor

Required host components are Chromium, Xvfb, x11vnc, noVNC/websockify, and devbox-chrome-debug. The plugin does not install system packages.

## Development

    pnpm install
    pnpm check

pnpm check runs TypeScript checking, all Node tests, and Host/client builds.

The real Profile experiment creates authenticated template state, closes Chromium cleanly, clones two isolated persistent profiles, mutates them concurrently through Playwright, restarts them, and verifies storage persistence plus loopback listeners:

    pnpm experiment:profiles

The machine-readable report is written to .experiment/latest/experiment-report.json.

Use an isolated PDM-managed DSH development instance to load and validate the bundle. Do not install or restart stable DSH directly; stable rollout must use the PDM stable-update queue after an explicit user request.

## Known limits

- Website single-session policies and token rotation can invalidate an Identity externally.
- NEEDS_LOGIN is not inferred from website-specific probes.
- Capacity exhaustion returns an explicit error; no fair waiting queue is provided.
- Full browser-driven WebSocket/RFB validation remains separate from route and VNC protocol tests.
- Playwright MCP image blocks are not yet ingested as DSH model attachments.

## Design and validation

- Domain language: CONTEXT.md
- Accepted architecture decision: docs/adr/0001-session-browser-playwright-mcp.md
- Architecture and scope: docs/PLAN.md
- Reproducible validation record: docs/VALIDATION.md
