# Agent Browser Fleet

Agent Browser Fleet supplies reusable authenticated browser identities and one shared live browser to each DSH session that needs browser access.

## Language

**Identity**:
A reusable authenticated browser profile lineage from which Session Browsers are created. An Identity has a maximum concurrent Session Browser capacity.
_Avoid_: Account, pool, running browser

**Template Snapshot**:
An immutable clean copy of an Identity after user-driven login setup is complete.
_Avoid_: Live profile, backup

**Session Browser**:
The single live browser associated with a DSH session. A session has at most one Session Browser at a time, shared by its user and Agent.
_Avoid_: Lease, Slot, Agent browser instance

**Identity Binding**:
The association between a DSH session and the Identity used by its current Session Browser. A session has one binding at a time, and its Agent may change it.
_Avoid_: Lease target, Slot owner

**Shared Control**:
The Session Browser control model in which the user and Agent may act concurrently. Action ordering is not guaranteed, and neither participant has exclusive control.
_Avoid_: Takeover, Private mode, exclusive control

**Browser Allocation**:
The internal assignment of reusable browser capacity to a DSH session. Allocation is automatic and is not a user-facing or Agent-facing lease.
_Avoid_: Lease request, reservation tool
