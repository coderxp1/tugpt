# Consolidation Inventory — RC Line (C1)

**Date:** 2026-11-25 · **Workstream:** C1 (implementation sequence, TuGPT MCP two-track programme)
**Authoritative line:** RC integration line; deployed staging build `f503169` (branch `a5/rc6-candidate`).
**Rule (D1):** the final RC build contains Dashboard, Connect, Control Center and Workspace, alongside both MCP tracks. No feature below may be lost without an explicit decision by paul.

## Lineage

`mainline (tugpt/, GitHub feat/product-control-center)` ⊂ `tugpt-connect/ (feat/connect-phase0)` ⊂ `RC line (a5/integration-rc1…rc4 → a5/rc6-candidate)`. The RC line is a superset of the other two except for the mainline-only Control Center (below). Agent 1's dashboard candidate (`agent1/dashboard-team-roles`, 653aab3) exists as a worktree/archive and is **not** part of any line above; its team-roles UI was verified against the real members API (Agent 6) which the RC line already carries.

## Feature inventory (verified 2026-11-25 against the deployed build and the checkouts)

| Capability | Mainline | Connect | RC (deployed f503169) | Action |
|---|---|---|---|---|
| Workspace chat (threads, NDJSON streaming, persistence, RAG citations) | ✗ | partial | ✓ live-proven | keep |
| AI inference — tugpt-scout (private GPU) | ✗ | ✗ | ✓ real inference proven | keep |
| AI inference — Langdock slots | worker drafts only | — | code-only, key presence unverified | keep code; no enablement change |
| Dashboard (org settings, features) | old build | — | ✓ | keep |
| Team roles UI + members API | ✗ | — | ✓ API; UI present | keep; evaluate a1cc roles UI polish opportunistically |
| Dashboard hub ("control center" feature-status overview, d130bf4) | ✗ | ✗ | ✓ | keep — **distinct from** the mainline Control Center below |
| **Product Control Center** (`app/control-center`, `components/control-center`, `lib/control-center`) | ✓ PR #19 lineage | ✗ | ✗ | **PORT (C2)** |
| Connect UI (Dashboard → Connect) | ✗ | ✓ | ✓ | keep |
| Customer MCP lifecycle (register/discover/approve/audit) | ✗ | ✓ | ✓ migrated, switched OFF | keep; auth path = Plan A |
| Customer MCP authentication | ✗ | ✗ | ✗ missing | **Agent 2 branch `agent2/mcp-authenticated-customer` implements it** (PostgresCredentialStore + static bearer + caller executor, migrations 20261120000012–14) — integrate onto this line (S0.2/A1), do not reimplement |
| Platform MCP (registry, broker namespace, admin) | ✗ | ✗ | ✗ | build (Plan B) |
| Media jobs (DB/API/UI) | ✓ no executor | — | ✓ | keep; HeyGen bridge = B7 |
| Knowledge / Workspace Library | ✗ | — | ✓ | keep |
| WhatsApp draft generation | ✓ | — | ✓ lineage | keep |
| Usage metering | — | — | ✓ with defects U1/U4/U5/U6 | fix (S0.4) |
| Egress proxy (production) | ✗ | docs + smoke | ✗ not deployed | deploy (S0.1) |
| Credential broker | ✗ | ✓ OAuth-only | ✓ persistent store unverified | verify/integrate Agent 2 store (S0.2) |

## Known collisions and notes

- **ADR numbering:** the repository's ADR-020 is the tool-registry ADR. The platform-owned MCP ADR approved 2026-11-25 is filed as **ADR-022**.
- **Migration numbering:** Agent 2's migrations `20261120000012–14` do not collide with this line (its Nov-20 sequence ends at `…00011`, resuming at `20261120100001`).
- The deployed build's branch is `a5/rc6-candidate`; implementation work for this programme lands on `dev2/mcp-two-track` (from f503169) in the `dev2-mcp` clone and is integrated back by PR.
