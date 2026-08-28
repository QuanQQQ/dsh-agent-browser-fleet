# Validation record

## 2026-08-27 — Shared-Control Session Browser and Playwright MCP migration

### Environment

- Node.js 22.23.2
- pnpm 11.22.0
- @playwright/mcp 0.0.79
- @modelcontextprotocol/sdk 1.30.0
- playwright-core 1.63.0-alpha-2026-08-05
- DSH isolated development URL: http://127.0.0.1:3087
- PDM project: dsh-agent-browser-fleet-sidebar-mvp

### Local verification gate

Command:

    pnpm check

Result: PASS.

- TypeScript no-emit check passed.
- 32 Node tests passed.
- Host ESM bundle built successfully.
- Browser client bundle built successfully.
- Host bundle: 88.41 kB, approximately 22.4 kB gzip.
- Client bundle: 32.03 kB, gzip 7.39 kB.
- The tsdown dependency configuration uses deps.neverBundle; no deprecated external warning remains in Fleet builds.

The tests cover v1-to-v2 state migration, single Session Browser invariants, Identity switching and capacity, profile preservation, clean shutdown, loopback runtime checks, authentication, VNC protocol handling, Better Sidebar registration, public HTTP redaction, exact Playwright MCP catalog shape, per-session hidden-CDP routing, and Fleet tool composition.

The pinned @playwright/mcp core catalog contains exactly 24 tools. The contract test compares the complete sorted name list rather than accepting a minimum count.

### Real profile isolation experiment

Command:

    pnpm experiment:profiles

Result: PASS. Machine-readable report:

    .experiment/latest/experiment-report.json

Observed evidence:

- Template login state persisted cookie and localStorage identity values.
- Clean Template Snapshot contained a 2703-byte Chromium Local State file.
- Snapshot copy mode was ordinary copy on this filesystem; copy is the required safe fallback when reflink is unavailable.
- Two independent profiles initially inherited the same authenticated state.
- Concurrent Playwright mutations produced distinct A and B localStorage values.
- Both distinct values survived clean shutdown and restart.
- All CDP/VNC/noVNC listeners were loopback-only.
- Runtime ports were distinct for the two concurrent browsers.
- Snapshot allocated size was 6,807,552 bytes; active profile allocated sizes were 11,112,448 and 11,100,160 bytes.
- Aggregate process RSS measurements were 903,072 KiB and 899,064 KiB for the two profile process trees.

The experiment verifies browser-profile persistence and isolation. It does not claim that a website permits simultaneous use of the same server-side account session.

### Isolated composed DSH verification

PDM restarted only dsh-agent-browser-fleet-sidebar-mvp. Stable DSH was not modified or restarted.

Result: PASS for runtime composition and browser workflow.

1. DSH created session session-87250dcf-4c04-4d8b-a776-e0daa1928f64.
2. Better Sidebar opened the registered Browser Fleet tab.
3. The Browser-first view displayed only the Session Browser or Identity login setup. No Slot, lease, release, takeover, private-mode, ownership, or control-mode UI was present.
4. The noVNC WebSocket completed server-side VNC authentication and reached ServerInit.
5. User login setup saved Identity a as a READY Template Snapshot.
6. The isolated DSH Agent called, in order:
   - agent_browser_identities
   - agent_browser_use_identity
   - browser_navigate with https://example.com
   - browser_snapshot
7. Playwright MCP returned the Example Domain accessibility snapshot.
8. Better Sidebar simultaneously displayed the same live page and labeled it a · Shared control.
9. After Host restart, startup reconciliation removed the binding whose DSH session was no longer live and reported activeSessions: 0.
10. The Agent then rebound the Identity on the final Host bundle and browser_snapshot succeeded again.

Screenshot evidence:

    .experiment/session-browser-tool-e2e.png
    .experiment/session-browser-tool-e2e-final.png

The live state endpoint returned only allowlisted Identity, Session Browser, and audit-summary fields. It contained no internal allocation ID, instance name, runtime port, audit details, legacy control event type, or raw CDP endpoint.

### Clean package validation

PDM project dsh-agent-browser-fleet-mvp validated the primary tarball in a new DSH_HOME.

Result: PASS.

- Artifact: $HOME/.dsh/dev-manager/artifacts/dsh-agent-browser-fleet-mvp/dsh-agent-browser-fleet-0.1.0.tgz
- Validation home: $HOME/.dsh/dev-manager/artifacts/dsh-agent-browser-fleet-mvp/validation/20260827132357692
- Temporary validation port: 3091
- Health: healthy

### Composed clean-package blocker

The first composed PDM validation attempt exposed a real dsh-better-sidebar ETag defect: rapid same-length chunk rewrites could preserve size and nanosecond mtime, causing an incorrect 304. The original public-route test reproduced 4 failures in 10 runs; an independent filesystem probe observed unchanged mtimeNs in 990 of 1000 same-length rewrites.

A minimal local Better Sidebar fix computes the strong ETag from the exact bytes served and reuses those bytes for a 200 response. Evidence:

- Branch: fix/bundle-etag-same-stat
- Local commit: 1efddc5
- ETag stress: 20/20 passes
- Better Sidebar suite: 1046 passed, 9 skipped
- Better Sidebar typecheck and build: PASS

The fix could not be pushed for mandatory PR review: HTTPS had no GitHub credential; SSH authenticated as QuanQQQ but had no write permission to omdsh-dev/DSH-better-sidebar; no writable fork existed. PDM correctly refused a composed release because that local commit is not merged into main. No bypass or direct stable installation was attempted.

### Remaining boundaries

- DSH model rendering still turns MCP image blocks into saved-file placeholders; accessibility snapshots are the supported observation path.
- Full browser-driven WebSocket/RFB interaction remains separate from the protocol and live gateway evidence above.
- Same-UID Host processes remain outside the loopback CDP isolation guarantee.
- Stable promotion is not part of this validation record and requires an explicit request plus the PDM stable-update queue.
